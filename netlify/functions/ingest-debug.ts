// netlify/functions/ingest-debug.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const BUCKET = process.env.DOCS_BUCKET || "documents";

function must(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`ENV ${n} is missing`);
  return v;
}

const supabase = createClient(
  must("NEXT_PUBLIC_SUPABASE_URL"),
  must("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } }
);

function normalize(t: string) {
  return (t || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export const handler: Handler = async (event) => {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const docId: string | undefined = body?.docId;
    if (!docId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "docId required" }),
      };
    }

    // 1) забираем документ
    const { data: doc, error: dErr } = await supabase
      .from("documents")
      .select("id, filename, mime_type, storage_path")
      .eq("id", docId)
      .single();

    if (dErr || !doc) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: `document not found: ${docId}`, details: dErr?.message }),
      };
    }

    // 2) скачиваем файл из Storage
    const dl = await supabase.storage.from(BUCKET).download(doc.storage_path);
    if (dl.error || !dl.data) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "download failed", details: dl.error?.message }),
      };
    }

    const buf = Buffer.from(await dl.data.arrayBuffer());
    const lower = (doc.storage_path || "").toLowerCase();

    // 3) извлекаем только для TXT/DOCX (PDF пропускаем в MVP)
    let text = "";
    if ((doc.mime_type?.startsWith("text/")) || lower.endsWith(".txt")) {
      text = normalize(buf.toString("utf8"));
    } else if ((doc.mime_type?.includes("word")) || lower.endsWith(".docx")) {
      const mammoth: any = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer: buf });
      text = normalize(value || "");
    } else {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, note: "skipped format", doc, length: 0, preview: "" }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        doc,
        length: text.length,
        preview: text.slice(0, 200),
      }),
    };
  } catch (e: any) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: e?.message || String(e) }),
    };
  }
};
