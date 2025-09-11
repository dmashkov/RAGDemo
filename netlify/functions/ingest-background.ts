// netlify/functions/ingest-background.ts
import type { BackgroundHandler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const BUCKET = process.env.DOCS_BUCKET || "documents";
const EMB_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const BATCH = 64;

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

const openai = new OpenAI({ apiKey: must("OPENAI_API_KEY") });

function normalize(t: string) {
  return (t || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function chunkText(t: string, size = 900, overlap = 150) {
  const out: string[] = [];
  let i = 0;
  while (i < t.length) {
    const end = Math.min(i + size, t.length);
    let cut = end;
    const soft = t.lastIndexOf(" ", end - 20);
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

async function extractFromStorage(path: string, mime: string | null) {
  const d = await supabase.storage.from(BUCKET).download(path);
  if (d.error || !d.data) throw new Error(`download failed: ${d.error?.message ?? "no data"}`);

  const buf = Buffer.from(await d.data.arrayBuffer());
  const lower = path.toLowerCase();

  // MVP: поддерживаем TXT и DOCX (PDF отключён для Netlify)
  if (mime?.startsWith("text/") || lower.endsWith(".txt")) {
    return normalize(buf.toString("utf8"));
  }
  if (mime?.includes("word") || lower.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return normalize(value || "");
  }

  // прочие форматы пока игнорим
  return "";
}

export const handler: BackgroundHandler = async (event) => {
  let docId: string | undefined;

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    docId = body?.docId;
    const reindexAll = !!body?.all;

    if (!docId && !reindexAll) {
      console.warn("ingest-background: missing docId or { all: true }");
      return;
    }

    if (docId) {
      const { data: doc, error: docErr } = await supabase
        .from("documents")
        .select("*")
        .eq("id", docId)
        .single();
      if (docErr || !doc) throw new Error(`document not found: ${docId}`);

      await supabase.from("documents").update({ status: "processing", error: null }).eq("id", docId);

      try {
        const text = await extractFromStorage(doc.storage_path, doc.mime_type);
        if (!text) throw new Error("empty text after extraction");

        const parts = chunkText(text);
        if (parts.length === 0) throw new Error("no chunks");

        await supabase.from("chunks").delete().eq("document_id", docId);

        for (let i = 0; i < parts.length; i += BATCH) {
          const batch = parts.slice(i, i + BATCH);
          const embs = await embedBatch(batch);
          const rows = batch.map((content, idx) => ({
            document_id: docId!,
            chunk_index: i + idx,
            content,
            embedding: embs[idx],
          }));
          const ins = await supabase.from("chunks").insert(rows);
          if (ins.error) throw new Error(ins.error.message);
        }

        await supabase
          .from("documents")
          .update({ status: "ready", original_text_len: text.length, error: null })
          .eq("id", docId);

        console.log(`ingest-background: done for ${docId}`);
      } catch (e: any) {
        await supabase.from("documents").update({ status: "error", error: e?.message || String(e) }).eq("id", docId);
        console.error("ingest-background error:", e);
      }

      return;
    }

    // reindex all (по одному документу, чтобы не упереться в лимиты)
    const { data: docs, error: selErr } = await supabase.from("documents").select("id");
    if (selErr) throw new Error(selErr.message);

    for (const d of docs || []) {
      await fetch(new URL("/.netlify/functions/ingest-background", event.rawUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId: d.id }),
      });
    }
  } catch (e) {
    console.error("ingest-background top-level error:", e);
  }
};
