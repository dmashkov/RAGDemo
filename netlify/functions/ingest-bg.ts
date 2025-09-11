// netlify/functions/ingest-bg.ts
import type { BackgroundFunctionHandler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// ВАЖНО: никаких PDF-библиотек здесь нет
// DOCX подключим динамически, чтобы бандлер не тянул лишнего

const BUCKET = 'documents';
const EMB_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const BATCH = 64;

function env(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`ENV ${n} is missing`);
  return v;
}

const supabase = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
const openai = new OpenAI({ apiKey: env('OPENAI_API_KEY') });

function normalize(text: string) {
  return (text || '')
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
  const r = await openai.embeddings.create({ model: EMB_MODEL, input: texts });
  return r.data.map((d) => d.embedding as number[]);
}

async function extractFromStorage(key: string, mime: string | null) {
  const d = await supabase.storage.from(BUCKET).download(key);
  if (d.error || !d.data) throw new Error(`download failed: ${key} (${d.error?.message ?? 'no data'})`);
  const ab = await d.data.arrayBuffer();
  const u8 = new Uint8Array(ab);
  const buf = Buffer.from(u8);
  const lower = key.toLowerCase();

  // PDF: временно игнорируем полностью
  if ((mime?.includes('pdf')) || lower.endsWith('.pdf')) {
    return '';
  }

  // DOCX: динамический импорт только при необходимости
  if ((mime?.includes('word')) || lower.endsWith('.docx')) {
    // небольшая «маскировка» импорта, чтобы бандлер не включал лишнего
    const mammoth = (await (0, eval)('import("mammoth")')) as any;
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return normalize(value || '');
  }

  // TXT: прямое чтение
  if ((mime?.startsWith('text/')) || lower.endsWith('.txt')) {
    return normalize(buf.toString('utf8'));
  }

  return '';
}

export const handler: BackgroundFunctionHandler = async (event) => {
  let docId: string | undefined;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    docId = body?.docId;
    if (!docId) {
      console.error('ingest-bg: missing docId');
      return;
    }

    const { data: doc, error } = await supabase.from('documents').select('*').eq('id', docId).single();
    if (error || !doc) throw new Error(`document not found: ${docId}`);

    await supabase.from('documents').update({ status: 'processing', error: null }).eq('id', docId);

    const text = await extractFromStorage(doc.storage_path, doc.mime_type);
    if (!text) throw new Error('empty text after extraction');

    const parts = chunkText(text);
    if (parts.length === 0) throw new Error('no chunks');

    await supabase.from('chunks').delete().eq('document_id', docId);

    for (let i = 0; i < parts.length; i += BATCH) {
      const batch = parts.slice(i, i + BATCH);
      const embs = await embedBatch(batch);
      const rows = batch.map((content, idx) => ({
        document_id: docId!,
        chunk_index: i + idx,
        content,
        embedding: embs[idx],
      }));
      const ins = await supabase.from('chunks').insert(rows);
      if (ins.error) throw new Error(ins.error.message);
    }

    await supabase
      .from('documents')
      .update({ status: 'ready', original_text_len: text.length, error: null })
      .eq('id', docId);

    console.log(`ingest-bg: done docId=${docId}, textLen=${text.length}`);
  } catch (e: any) {
    console.error('ingest-bg error:', e?.message || String(e));
    if (docId) {
      try {
        await supabase.from('documents').update({ status: 'error', error: e?.message || String(e) }).eq('id', docId);
      } catch {}
    }
  }
};
