// app/api/upload/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const BUCKET = "documents";

function env(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`ENV ${n} is missing`);
  return v;
}

const supabase = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

function sanitizeFilename(name: string) {
  const base = (name || "file").normalize("NFKC");
  // ASCII-безопасно, без юникод-классов \p{L} — SWC/Next не спотыкается
  return base.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").slice(0, 140);
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const files = form.getAll("files") as File[];
    if (!files?.length) {
      return NextResponse.json({ ok: false, error: "No files provided" }, { status: 400 });
    }

    const results: any[] = [];

    for (const f of files) {
      const docId = randomUUID();
      const safe = sanitizeFilename(f.name);
      const storagePath = `${docId}__${safe}`;

      // 1) кладём файл в Supabase Storage
      const ab = await f.arrayBuffer();
      const upload = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, Buffer.from(ab), {
          contentType: f.type || "application/octet-stream",
          upsert: false,
        });

      if (upload.error) {
        results.push({
          name: f.name,
          size: f.size,
          type: f.type,
          error: `storage upload: ${upload.error.message}`,
        });
        continue;
      }

      // 2) создаём запись документа (id задаём сами = docId)
      const ins = await supabase
        .from("documents")
        .insert({
          id: docId,
          filename: f.name,
          mime_type: f.type || "application/octet-stream",
          size_bytes: f.size ?? null,
          storage_path: storagePath,
          status: "uploaded",
        })
        .select("id")
        .single();

      if (ins.error) {
        results.push({
          name: f.name,
          size: f.size,
          type: f.type,
          storagePath,
          error: `insert document: ${ins.error.message}`,
        });
        continue;
      }

      // 3) сразу триггерим индексацию (ingest) для этого docId
      const resp = await fetch(new URL("/api/ingest", req.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId }),
      });

      const data = await resp.text();
      results.push({
        name: f.name,
        size: f.size,
        type: f.type,
        docId,
        storagePath,
        ingest: { ok: resp.ok, status: resp.status, data },
      });
    }

    const allOk = results.every((r) => r.ingest?.ok);
    return NextResponse.json({ ok: allOk, results });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
