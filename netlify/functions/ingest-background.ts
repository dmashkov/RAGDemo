// netlify/functions/ingest-background.ts
// Background Function — Netlify отдаёт 202 сразу, код работает в фоне.
// НИЧЕГО не возвращаем из handler.

import type { HandlerEvent, HandlerContext } from "@netlify/functions";
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

const supabase = createClient(must("NEXT_PUBLIC_SUPABASE_URL"), must("SUPABASE_SERVICE_ROLE_KEY"));
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

export async function handler(event: HandlerEvent, _ctx: HandlerContext): Promise<void> {
  let docId: string | undefined;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    docId = body?.docId;
    if (!docId) throw new Error("docId is required");

    // 1) документ
    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();
    if (docErr || !doc) throw new Error(`document not found: ${docId}`);

    await supabase.from("documents").update({ status: "processing", error: null }).eq("id", docId);

    // 2) скачиваем файл
    const dl = await supabase.storage.from(BUCKET).download(doc.storage_path);
    if (dl.error || !dl.data) throw new Error(`download failed: ${dl.error?.message ?? "no data"}`);
    const buf = Buffer.from(await dl.data.arrayBuffer());
    const lower = String(doc.storage_path).toLowerCase();
    const mime = String(doc.mime_type || "");

    // 3) извлекаем ТОЛЬКО TXT/DOCX (PDF — пока выключен)
    let text = "";
    if (mime.includes("pdf") || lower.endsWith(".pdf")) {
      throw new Error("PDF extraction is disabled on Netlify (temporary)");
    } else if (mime.includes("word") || lower.endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer: buf });
      text = normalize(value || "");
    } else if (mime.startsWith("text/") || lower.endsWith(".txt")) {
      text = normalize(buf.toString("utf8"));
    } else {
      throw new Error(`Unsupported mime: ${mime}`);
    }
    if (!text) throw new Error("empty text after extraction");

    // 4) чанки + эмбеддинги
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

    console.log(`[ingest-background] done doc=${docId}, len=${text.length}, chunks=${parts.length}`);
  } catch (e: any) {
    console.error("[ingest-background] FAILED:", e?.message || e);
    if (docId) {
      try {
        await supabase.from("documents").update({ status: "error", error: e?.message || String(e) }).eq("id", docId);
      } catch {}
    }
    // Ничего не возвращаем — Netlify сам вернёт 202 при старте, а ошибку увидим в логах.
  }
}
