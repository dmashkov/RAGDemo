// src/app/api/upload/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

const BUCKET = 'documents';

function assertEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`ENV ${name} is missing`);
  return v;
}

const supabaseAdmin = createClient(
  assertEnv('NEXT_PUBLIC_SUPABASE_URL'),
  assertEnv('SUPABASE_SERVICE_ROLE_KEY')
);

// Без \p{L}/\p{N} — совместимо со SWC
function sanitizeFilename(name: string) {
  const base = (name || 'file').normalize('NFKD');
  // оставляем только ASCII-безопасные символы
  const ascii = base.replace(/[^A-Za-z0-9.\- _]+/g, '_');
  return ascii.replace(/\s+/g, '_').slice(0, 140);
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const files = form.getAll('files') as File[];
    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'no files' }, { status: 400 });
    }

    const results: Array<{
      docId?: string;
      name: string;
      size: number;
      type: string;
      storagePath?: string;
      ingest?: any;
      error?: string;
    }> = [];

    for (const f of files) {
      const resItem: any = { name: f.name, size: f.size ?? 0, type: f.type || 'application/octet-stream' };
      try {
        const docId = uuidv4();
        const key = `${docId}__${sanitizeFilename(f.name)}`;
        const ab = await f.arrayBuffer();

        const up = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(key, ab, { contentType: f.type || 'application/octet-stream', upsert: false });
        if (up.error) throw new Error(`storage upload failed: ${up.error.message}`);

        const ins = await supabaseAdmin
          .from('documents')
          .insert({
            id: docId,
            storage_path: key,
            filename: f.name || null,
            mime_type: f.type || null,
            size_bytes: f.size ?? null,
            status: 'pending'
          })
          .select('id')
          .single();
        if (ins.error) throw new Error(`insert document failed: ${ins.error.message}`);

        resItem.docId = docId;
        resItem.storagePath = key;

        const ingestResp = await fetch(new URL('/api/ingest', req.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ docId })
        });

        const ct = ingestResp.headers.get('content-type') || '';
        const payload = ct.includes('application/json')
          ? await ingestResp.json().catch(() => ({}))
          : await ingestResp.text();

        resItem.ingest = { ok: ingestResp.ok, status: ingestResp.status, data: payload };
        if (!ingestResp.ok) throw new Error(`ingest failed: ${ingestResp.status} ${JSON.stringify(payload)}`);
      } catch (e: any) {
        resItem.error = e?.message || String(e);
      } finally {
        results.push(resItem);
      }
    }

    const ok = results.every(r => !r.error && r?.ingest?.ok);
    return NextResponse.json({ ok, results }, { status: ok ? 200 : 207 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
