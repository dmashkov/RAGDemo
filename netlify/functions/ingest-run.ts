// netlify/functions/ingest-run.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const BUCKET = process.env.DOCS_BUCKET || "documents";
const EMB_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

const USE_FAKE_EMB = process.env.USE_FAKE_EMB === "1";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || "1536");
const BATCH = Number(process.env.INGEST_BATCH || "32");
const MAX_CHUNKS = Number(process.env.MAX_CHUNKS || "400");
// в диагностике индексируем только первые N чанков (по-умолчанию 64)
const CHUNKS_TO_TRY = Number(process.env.CHUNKS_TO_TRY || "64");

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
  if (USE_FAKE_EMB) return texts.map(() => Array(EMBEDDING_DIM).fill(0));
  const r = await openai.embeddings.create({ model: EMB_MODEL, input: texts });
  return r.data.map((d) => d.embedding as number[]);
}

async function extractFromStorage(path: string, mime: string | null) {
  const d = await supabase.storage.from(BUCKET).download(path);
  if (d.error || !d.data) throw new Error(`download failed: ${d.error?.message ?? "no data"}`);

  const buf = Buffer.from(await d.data.arrayBuffer());
  const lower = (path || "").toLowerCase();

  if (mime?.startsWith("text/") || lower.endsWith(".txt")) {
    return normalize(buf.toString("utf8"));
  }
  if (mime?.includes("word") || lower.endsWith(".docx")) {
    const mammoth: any = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return normalize(value || "");
  }
  // PDF и прочее — пропускаем в диагностике
  return "";
}

export const handler: Handler = async (evt) => {
  const steps: Array<{ t: string; data?: any; level?: "info" | "warn" | "error" }> = [];
  const mark = (t: string, data?: any, level: "info" | "warn" | "error" = "info") => {
    steps.push({ t, data, level });
  };

  let docId: string | undefined;

  const setStage = async (stage: string) => {
    if (!docId) return;
    try {
      await supabase.from("documents").update({ error: stage }).eq("id", docId);
    } catch (e: any) {
      steps.push({ t: `setStage failed: ${e?.message || String(e)}`, level: "warn" });
    }
  };

  try {
    if (!evt.body) return { statusCode: 400, body: JSON.stringify({ ok: false, error: "no body" }) };
    const body = JSON.parse(evt.body);
    docId = body?.docId as string;
    if (!docId) return { statusCode: 400, body: JSON.stringify({ ok: false, error: "docId required" }) };

    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();
    if (docErr || !doc) throw new Error(`document not found: ${docId}`);

    // статус processing для чистоты
    await supabase.from("documents").update({ status: "processing", error: null }).eq("id", docId);

    // 1) download + extract
    mark("downloading");
    await setStage("downloading...");
    const text = await extractFromStorage(doc.storage_path, doc.mime_type);
    mark("extracted", { len: text.length });
    await setStage(`extracted: ${text.length} chars`);
    if (!text) throw new Error("empty text after extraction");

    // 2) chunk
    const allParts = chunkText(text);
    let parts = allParts;
    if (MAX_CHUNKS > 0 && parts.length > MAX_CHUNKS) parts = parts.slice(0, MAX_CHUNKS);
    const tryCount = Math.min(parts.length, CHUNKS_TO_TRY);
    const tryParts = parts.slice(0, tryCount);
    mark("chunked", { total: allParts.length, limited: parts.length, willTry: tryParts.length });
    await setStage(`chunked: ${parts.length} parts (try ${tryParts.length})`);
    if (tryParts.length === 0) throw new Error("no chunks");

    // 3) clean old
    mark("deleting old chunks");
    await setStage("clean old chunks");
    {
      const del = await supabase.from("chunks").delete().eq("document_id", docId);
      if (del.error) throw new Error(`cleanup chunks failed: ${del.error.message}`);
    }

    // 4) embed + insert (пробуем только tryParts)
    let inserted = 0;
    for (let i = 0; i < tryParts.length; i += BATCH) {
      const batch = tryParts.slice(i, i + BATCH);

      mark("embedding", { range: [i, i + batch.length - 1], fake: USE_FAKE_EMB });
      await setStage(`embedding ${i}-${i + batch.length - 1} ${USE_FAKE_EMB ? "(fake)" : ""}`);
      const embs = await embedBatch(batch);

      mark("inserting", { range: [i, i + batch.length - 1] });
      await setStage(`inserting ${i}-${i + batch.length - 1}`);
      // для устойчивости — мелкие подпорции
      for (let j = 0; j < batch.length; j += 16) {
        const sub = batch.slice(j, j + 16);
        const subEmb = embs.slice(j, j + 16);
        const rows = sub.map((content, idx) => ({
          document_id: docId!,
          chunk_index: i + j + idx,
          content,
          embedding: subEmb[idx],
        }));
        const ins = await supabase.from("chunks").insert(rows);
        if (ins.error) throw new Error(`insert failed: ${ins.error.message}`);
        inserted += rows.length;
      }
    }

    // 5) finalize
    await supabase
      .from("documents")
      .update({ status: "ready", original_text_len: text.length, error: null })
      .eq("id", docId);

    mark("done", { inserted });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        doc: { id: docId, filename: doc.filename, mime: doc.mime_type },
        summary: { textLen: text.length, partsTried: tryCount, inserted },
        steps,
      }),
    };
  } catch (e: any) {
    const msg = e?.message || String(e);
    await setStage(`ERROR: ${msg}`);
    await supabase.from("documents").update({ status: "error", error: msg }).eq("id", docId || "");
    steps.push({ t: `THREW: ${msg}`, level: "error" });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg, steps }) };
  }
};
