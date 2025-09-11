// app/api/upload/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const BUCKET = process.env.DOCS_BUCKET || "documents";

function must(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`ENV ${name} is missing`);
  return v;
}

const supabase = createClient(
  must("NEXT_PUBLIC_SUPABASE_URL"),
  must("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } }
);

// Без \p{L} — чтобы не падать на SWC/webpack
function sanitizeFilename(name: string) {
  return (name || "file")
    .replace(/[^a-zA-Z0-9._\- ]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 140);
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const files = form.getAll("files") as File[];
    if (!files?.length) {
      return NextResponse.json({ ok: false, error: "No files" }, { status: 400 });
    }

    // куда стучать за индексацией
    const origin = process.env.URL || process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
    const ingestUrl = new URL("/.netlify/functions/ingest-background", origin).toString();

    const results: any[] = [];

    for (const f of files) {
      // 1) ключ в storage
      const id = uuidv4();
      const key = `${id}__${sanitizeFilename(f.name)}`;

      // 2) загрузка в Supabase Storage
      const ab = await f.arrayBuffer();
      const u8 = new Uint8Array(ab);
      const put = await supabase.storage.from(BUCKET).upload(key, u8, {
        contentType: f.type || "application/octet-stream",
        upsert: false,
      });

      if (put.error) {
        results.push({
          name: f.name,
          size: f.size,
          type: f.type,
          error: `storage upload failed: ${put.error.message}`,
        });
        continue;
      }

      // 3) запись в documents
      const ins = await supabase
        .from("documents")
        .insert({
          id, // фиксируем наш uuid
          filename: f.name,
          mime_type: f.type || "application/octet-stream",
          size_bytes: f.size ?? null,
          storage_path: key,
          status: "new",
          original_text_len: null,
          error: null,
        })
        .select("id")
        .single();

      if (ins.error || !ins.data) {
        results.push({
          name: f.name,
          size: f.size,
          type: f.type,
          storagePath: key,
          error: `documents insert failed: ${ins.error?.message || "no data"}`,
        });
        continue;
      }

      const docId = ins.data.id; // ← ЭТОТ id и нужно передать в воркер

      // 4) триггерим background-функцию
      let ingestRes: any;
      try {
        const resp = await fetch(ingestUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docId }), // <-- раньше тут был несуществующий docIdFromInsert
        });
        const ok = resp.status >= 200 && resp.status < 300;
        const bodyText = await resp.text().catch(() => "");
        ingestRes = { ok, status: resp.status, data: bodyText || null };
      } catch (e: any) {
        ingestRes = { ok: false, status: 0, data: String(e?.message || e) };
      }

      results.push({
        name: f.name,
        size: f.size,
        type: f.type,
        docId,
        storagePath: key,
        ingest: ingestRes,
      });
    }

    const allOk = results.every((r) => r.ingest?.ok !== false);
    return NextResponse.json({ ok: allOk, results });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
