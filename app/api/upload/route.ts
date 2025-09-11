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
  // Без \p{…} — SWC не спотыкается
  return base.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").slice(0, 140);
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const files = (form.getAll("files") as unknown[]).filter(Boolean) as File[];
    if (!files.length) {
      return NextResponse.json({ ok: false, error: "No files provided" }, { status: 400 });
    }

    const results: any[] = [];
    // Абсолютный origin для межфункционального вызова на Netlify
    const origin = process.env.URL || process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;

    for (const f of files) {
      const docId = randomUUID();
      const safe = sanitizeFilename(f.name);
      const storagePath = `${docId}__${safe}`;

      // 1) Upload в Supabase Storage
      const ab = await f.arrayBuffer();
      const up = await supabase.storage.from(BUCKET).upload(storagePath, Buffer.from(ab), {
        contentType: f.type || "application/octet-stream",
        upsert: false,
      });

      if (up.error) {
        results.push({
          name: f.name,
          size: f.size,
          type: f.type,
          error: `storage upload: ${up.error.message}`,
        });
        continue;
      }

      // 2) Запись в documents (id задаём сами)
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

      // 3) Синхронно триггерим индексацию (или см. fire-and-forget ниже)
      let ingestOk = false;
      let ingestStatus = 0;
      let ingestBody = "";

      try {
        const r = await fetch(`${origin}/api/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          redirect: "follow",
          body: JSON.stringify({ docId }),
        });
        ingestStatus = r.status;
        ingestBody = await r.text();
        ingestOk = r.ok;
      } catch (e: any) {
        ingestStatus = 0;
        ingestBody = `fetch-error: ${e?.message || String(e)}`;
      }

      results.push({
        name: f.name,
        size: f.size,
        type: f.type,
        docId,
        storagePath,
        ingest: { ok: ingestOk, status: ingestStatus, data: ingestBody },
      });

      /* --- Альтернатива: fire-and-forget (не ждать индексацию) ---
      fetch(`${origin}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId }),
      }).catch((e) => console.error("ingest kick failed:", e));
      results.push({ name: f.name, size: f.size, type: f.type, docId, storagePath, ingest: { ok: true, status: 0, data: "queued" } });
      ------------------------------------------------------------ */
    }

    const allOk = results.every((r) => r.ingest?.ok);
    return NextResponse.json({ ok: allOk, results });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
