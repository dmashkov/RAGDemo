// netlify/functions/ingest-background.ts
import type { BackgroundHandler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET       = process.env.DOCS_BUCKET || 'documents';
const EMB_MODEL    = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const EMB_DIM      = Number(process.env.EMBEDDING_DIM || 1536);
const INGEST_BATCH = Number(process.env.INGEST_BATCH || 48);     // чанков за один заход
const SUBBATCH     = Number(process.env.INGEST_SUBBATCH || 24);  // эмбеддингов за один запрос
const PDF_MODE     = process.env.PDF_MODE || 'pdfjs';            // pdfjs | off

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

function normalize(text: string) {
  return text
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function chunkText(t: string, size = 900, overlap = 150) {
  const out: string[] = [];
  let i = 0;
  while (i < t.length) {
    const end = Math.min(i + size, t.length);
    let cut = end;
    const soft = t.lastIndexOf(' ', end - 20);
    if (soft > i + 200) cut = soft;
    out.push(t.slice(i, cut).trim());
    i = Math.max(0, cut - overlap);
    if (i >= t.length) break;
  }
  return out.filter(Boolean);
}

async function embedBatch(texts: string[]) {
  const res = await openai.embeddings.create({ model: EMB_MODEL, input: texts });
  return res.data.map((d) => d.embedding as number[]);
}

// ---- PDF via pdfjs-dist (серверлес-дружелюбно)
async function extractPDF_via_pdfjs(u8: Uint8Array, limitPages = 400, maxChars = 1_200_000) {
  // пробуем legacy сначала (чаще не тянет canvas)
  let mod: any;
  try {
    mod = await import('pdfjs-dist/legacy/build/pdf.js');
  } catch {
    mod = await import('pdfjs-dist/build/pdf.js');
  }
  const pdfjs: any = mod?.getDocument ? mod : mod.default;
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = undefined;
  }
  const task = pdfjs.getDocument({
    data: u8,
    disableWorker: true,
    isEvalSupported: false,
    verbosity: 0
  });
  const pdf = await task.promise;

  let out = '';
  const pages = Math.min(pdf.numPages, limitPages);
  for (let p = 1; p <= pages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let pageText = '';
    for (const it of content.items) {
      if (typeof it?.str === 'string') pageText += it.str + ' ';
    }
    pageText = pageText.replace(/\s+/g, ' ').trim();
    if (pageText) out += pageText + '\n';
    if (out.length >= maxChars) break;
  }
  return out.trim();
}

async function extractFromStorage(key: string, mime: string | null) {
  const d = await supabase.storage.from(BUCKET).download(key);
  if (d.error || !d.data) throw new Error(`download failed: ${key} (${d.error?.message ?? 'no data'})`);
  const ab = await d.data.arrayBuffer();
  const u8 = new Uint8Array(ab);
  const buf = Buffer.from(u8);
  const lower = key.toLowerCase();

  if ((mime?.includes('pdf')) || lower.endsWith('.pdf')) {
    if (PDF_MODE === 'off') return '';
    const text = await extractPDF_via_pdfjs(u8).catch((e) => {
      throw new Error(`pdfjs failed: ${e?.message || e}`);
    });
    return normalize(text || '');
  }

  if ((mime?.includes('word')) || lower.endsWith('.docx')) {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return normalize(value || '');
  }

  if ((mime?.startsWith('text/')) || lower.endsWith('.txt')) {
    return normalize(buf.toString('utf8'));
  }

  // неподдерживаемые
  return '';
}

export const handler: BackgroundHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const docId: string | undefined = body?.docId;
    if (!docId) return { statusCode: 400, body: 'docId is required' };

    // 1) статус → processing
    await supabase.from('documents')
      .update({ status: 'processing', error: null } as any)
      .eq('id', docId);

    // 2) читаем метаданные
    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .select('*')
      .eq('id', docId)
      .single();
    if (docErr || !doc) throw new Error(`document not found: ${docId}`);

    // 3) извлечение текста
    const text = await extractFromStorage(doc.storage_path, doc.mime_type);
    if (!text || text.length < 10) {
      throw new Error('empty or too short text (maybe image-only PDF, needs OCR)');
    }

    // 4) чанкинг
    const parts = chunkText(text);
    if (parts.length === 0) throw new Error('no chunks after split');

    // 5) подчистим прежние чанки этого документа
    await supabase.from('chunks').delete().eq('document_id', docId);

    // 6) эмбеддинг + вставка батчами
    let inserted = 0;
    for (let i = 0; i < parts.length; i += INGEST_BATCH) {
      const slice = parts.slice(i, i + INGEST_BATCH);

      // рубим на саббатчи для OpenAI
      const embs: number[][] = [];
      for (let j = 0; j < slice.length; j += SUBBATCH) {
        const sub = slice.slice(j, j + SUBBATCH);
        const e = await embedBatch(sub);
        embs.push(...e);
      }

      const rows = slice.map((content, k) => ({
        document_id: docId,
        chunk_index: i + k,
        content,
        embedding: embs[k],
      }));

      const ins = await supabase.from('chunks').insert(rows as any);
      if (ins.error) throw new Error(`insert failed: ${ins.error.message}`);
      inserted += rows.length;
    }

    // 7) финальный статус
    await supabase.from('documents')
      .update({ status: 'ready', original_text_len: text.length, error: null } as any)
      .eq('id', docId);

    return { statusCode: 202, body: JSON.stringify({ ok: true, docId, inserted }) };
  } catch (e: any) {
    // зафиксируем ошибку в документе
    const msg = e?.message || String(e);
    if ((e?.response?.data && typeof e.response.data === 'string') || typeof e?.response === 'string') {
      // no-op
    }
    // попытка вытащить docId из тела для отметки ошибки
    try {
      const b = JSON.parse((event.body || '{}'));
      if (b?.docId) {
        await supabase.from('documents').update({ status: 'error', error: msg } as any).eq('id', b.docId);
      }
    } catch {}
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
