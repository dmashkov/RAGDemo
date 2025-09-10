// app/api/ingest/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const BUCKET = 'documents';
const EMB_MODEL = 'text-embedding-3-small'; // 1536
const IS_NETLIFY = process.env.NETLIFY === 'true';
const PDF_MODE = (process.env.PDF_MODE || 'pdfjs').toLowerCase(); // 'pdfjs' | 'off' | 'pdfparse' | 'pdtt'
const BATCH = IS_NETLIFY ? 32 : 64;

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`ENV ${name} is missing`);
  return v;
}

const openai = new OpenAI({ apiKey: env('OPENAI_API_KEY') });
const supabaseAdmin = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

// ---------- utils ----------
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
  }
  return out.filter(Boolean);
}

async function embedBatch(texts: string[]) {
  const res = await openai.embeddings.create({ model: EMB_MODEL, input: texts });
  return res.data.map((d) => d.embedding as number[]);
}

// ---------- pdftotext (не для Netlify) ----------
const PDTT = (() => {
  const exe = process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext';
  const bin = process.env.POPPLER_BIN; // опционально: явный путь к bin
  return bin ? path.join(bin, exe) : exe;
})();
let _hasPdftotext: boolean | null = null;
async function hasPdftotext() {
  if (IS_NETLIFY) return false;
  if (_hasPdftotext !== null) return _hasPdftotext;
  try { await execFileAsync(PDTT, ['-v']); _hasPdftotext = true; }
  catch { _hasPdftotext = false; }
  return _hasPdftotext;
}
async function extractPDF_via_pdftotext(u8: Uint8Array) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-'));
  const inPath = path.join(tmpDir, 'in.pdf');
  const outPath = path.join(tmpDir, 'out.txt');
  try {
    await fs.writeFile(inPath, Buffer.from(u8));
    await execFileAsync(PDTT, ['-enc', 'UTF-8', '-nopgbrk', inPath, outPath]);
    const txt = await fs.readFile(outPath, 'utf-8');
    return normalize(txt || '');
  } finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------- pdfjs-dist (Netlify-friendly) ----------
async function extractPDF_via_pdfjs(u8: Uint8Array) {
  const mod: any = await import('pdfjs-dist/build/pdf.js');
  const pdfjs: any = mod?.getDocument ? mod : mod.default;
  if (pdfjs.GlobalWorkerOptions) {
    // без воркера в serverless
    pdfjs.GlobalWorkerOptions.workerSrc = undefined;
  }
  const task = pdfjs.getDocument({
    data: u8,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  });
  const pdf = await task.promise;

  let out = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map((it: any) => (typeof it?.str === 'string' ? it.str : '')).join(' ');
    if (text.trim()) out += text + '\n';
  }
  return normalize(out);
}

// ---------- pdf-parse (опционально для локалки) ----------
async function extractPDF_via_pdfparse(buf: Buffer) {
  const pdfParse = (await import('pdf-parse')).default as any;
  const parsed = await pdfParse(buf);
  return normalize(parsed.text || '');
}

// ---------- извлечение текста из Storage ----------
async function extractFromStorage(key: string, mime: string | null) {
  const d = await supabaseAdmin.storage.from(BUCKET).download(key);
  if (d.error || !d.data) throw new Error(`download failed: ${key} (${d.error?.message ?? 'no data'})`);
  const ab = await d.data.arrayBuffer();
  const u8 = new Uint8Array(ab);
  const buf = Buffer.from(u8);
  const lower = key.toLowerCase();

  // PDF
  if ((mime?.includes('pdf')) || lower.endsWith('.pdf')) {
    if (PDF_MODE === 'off') {
      throw new Error('PDF indexing disabled via PDF_MODE=off');
    }
    if (PDF_MODE === 'pdfjs') {
      return await extractPDF_via_pdfjs(u8);
    }
    if (PDF_MODE === 'pdtt') {
      if (await hasPdftotext()) {
        const t = await extractPDF_via_pdftotext(u8);
        if (t) return t;
        throw new Error('pdftotext returned empty text');
      }
      throw new Error('pdftotext not available');
    }
    if (PDF_MODE === 'pdfparse') {
      return await extractPDF_via_pdfparse(buf);
    }
    // дефолт
    return await extractPDF_via_pdfjs(u8);
  }

  // DOCX
  if ((mime?.includes('word')) || lower.endsWith('.docx')) {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return normalize(value || '');
  }

  // TXT
  if ((mime?.startsWith('text/')) || lower.endsWith('.txt')) {
    return normalize(buf.toString('utf8'));
  }

  return '';
}

// ---------- handler ----------
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const docId: string | undefined = body?.docId;
    const reindexAll: boolean = !!body?.all;

    if (!docId && !reindexAll) {
      return NextResponse.json({ error: 'Provide either docId or { all: true }' }, { status: 400 });
    }

    // один документ
    if (docId) {
      const { data: doc, error } = await supabaseAdmin.from('documents').select('*').eq('id', docId).single();
      if (error || !doc) throw new Error(`document not found: ${docId}`);

      await supabaseAdmin.from('documents').update({ status: 'processing', error: null }).eq('id', docId);

      try {
        const text = await extractFromStorage(doc.storage_path, doc.mime_type);
        if (!text) throw new Error('empty text after extraction');

        const parts = chunkText(text);
        if (parts.length === 0) throw new Error('no chunks');

        await supabaseAdmin.from('chunks').delete().eq('document_id', docId);

        for (let i = 0; i < parts.length; i += BATCH) {
          const batch = parts.slice(i, i + BATCH);
          const embs = await embedBatch(batch);
          const rows = batch.map((content, idx) => ({
            document_id: docId,
            chunk_index: i + idx,
            content,
            embedding: embs[idx],
          }));
          const ins = await supabaseAdmin.from('chunks').insert(rows);
          if (ins.error) throw new Error(ins.error.message);
        }

        await supabaseAdmin
          .from('documents')
          .update({ status: 'ready', original_text_len: text.length, error: null })
          .eq('id', docId);

        return NextResponse.json({ ok: true, docId });
      } catch (e: any) {
        await supabaseAdmin
          .from('documents')
          .update({ status: 'error', error: e?.message || String(e) })
          .eq('id', docId);
        return NextResponse.json({ ok: false, docId, error: e?.message || String(e) }, { status: 500 });
      }
    }

    // все документы (осторожно с таймаутами)
    const { data: docs, error } = await supabaseAdmin.from('documents').select('id').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    const processed: string[] = [];
    const failed: Array<{ docId: string; error: string }> = [];

    for (const d of docs || []) {
      const resp = await fetch(new URL('/api/ingest', req.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId: d.id }),
      });
      if (resp.ok) processed.push(d.id);
      else failed.push({ docId: d.id, error: await resp.text() });
    }

    return NextResponse.json({ ok: failed.length === 0, processed, failed }, { status: failed.length ? 207 : 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
