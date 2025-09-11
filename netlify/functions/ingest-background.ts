// netlify/functions/ingest-background.ts
import type { BackgroundHandler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// ── настройки
const BUCKET = process.env.DOCS_BUCKET || "documents";
const EMB_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const USE_FAKE_EMB = process.env.USE_FAKE_EMB === "1"; // можно временно отключить реальные эмбеддинги
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || "1536");

// важное: маленькие батчи, чтобы укладываться в время
const BATCH = Number(process.env.INGEST_BATCH || "24");        // сколько чанков реиндексируем за 1 вызов
const SUBBATCH = Number(process.env.INGEST_SUBBATCH || "8");    // сколько строк вставляем за 1 insert
const MAX_CHUNKS = Number(process.env.MAX_CHUNKS || "0");       // 0 = без лимита

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

// ── utils
function normalize(t: string) {
  return (t || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// безопасный чанкер (всегда двигается вперёд)
function chunkText(t: string, size = 900, overlap = 150) {
  const out: string[] = [];
  let i = 0;
  const L = t.length;
  while (i < L) {
    const end = Math.min(i + size, L);
    let cut = end;
    const soft = t.lastIndexOf(" ", Math.max(i, end - 20));
    if (soft > i + 200) cut = soft;
    const piece = t.slice(i, cut).trim();
    if (piece) out.push(piece);
    // гарантируем прогресс хотя бы на 1 символ
    const next = Math.max(i + 1, cut - overlap);
    if (next <= i) break;
    i = next;
  }
  return out;
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
  // PDF отключаем в MVP на Netlify
  return "";
}

function getOrigin(rawUrl?: string) {
  try {
    if (rawUrl) return new URL(rawUrl).origin;
  } catch {}
  // запасной способ: домены Netlify доступны в process.env.URL / DEPLOY_URL
  return process.env.URL || process.env.DEPLOY_PRIME_URL || "";
}

async function setStage(docId: string, stage: string) {
  try {
    console.log(`[ingest] ${docId} → ${stage}`);
    await supabase.from("documents").update({ error: stage }).eq("id", docId);
  } catch (e: any) {
    console.warn("setStage exception:", e?.message || String(e));
  }
}

export const handler: BackgroundHandler = async (event) => {
  let docId: string | undefined;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    docId = body?.docId as string | undefined;
    const start = Number(body?.start || 0); // ← смещение текущего окна
    if (!docId) {
      console.warn("ingest-background: missing docId");
      return;
    }

    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();
    if (docErr || !doc) {
      console.error("document not found:", docId, docErr?.message);
      return;
    }

    if (start === 0) {
      // только на первом шаге
      await supabase.from("documents").update({ status: "processing", error: null }).eq("id", docId);
    }

    // 1) download + extract (каждый шаг переизвлекает — дешево, зато надёжно)
    await setStage(docId, `downloading... (start=${start})`);
    const text = await extractFromStorage(doc.storage_path, doc.mime_type);
    if (!text) throw new Error("empty text after extraction");

    // 2) chunk (тоже каждый раз)
    let parts = chunkText(text);
    if (MAX_CHUNKS > 0 && parts.length > MAX_CHUNKS) parts = parts.slice(0, MAX_CHUNKS);
    await setStage(docId, `chunked: ${parts.length} parts`);

    if (parts.length === 0) throw new Error("no chunks");

    // 3) только на первом шаге очищаем старые чанки
    if (start === 0) {
      await setStage(docId, "clean old chunks");
      const del = await supabase.from("chunks").delete().eq("document_id", docId);
      if (del.error) throw new Error(`cleanup chunks failed: ${del.error.message}`);
    }

    // 4) текущее окно
    const slice = parts.slice(start, start + BATCH);
    if (slice.length === 0) {
      // окон больше нет — финализируем
      await setStage(docId, "finalizing");
      await supabase
        .from("documents")
        .update({ status: "ready", original_text_len: text.length, error: null })
        .eq("id", docId);
      console.log(`ingest-background: done for ${docId}`);
      return;
    }

    await setStage(docId, `embedding ${start}-${start + slice.length - 1} ${USE_FAKE_EMB ? "(fake)" : ""}`);
    const embs = await embedBatch(slice);

    await setStage(docId, `inserting ${start}-${start + slice.length - 1}`);
    // маленькими подпорциями
    for (let j = 0; j < slice.length; j += SUBBATCH) {
      const sub = slice.slice(j, j + SUBBATCH);
      const subEmb = embs.slice(j, j + SUBBATCH);
      const rows = sub.map((content, idx) => ({
        document_id: docId!,
        chunk_index: start + j + idx,
        content,
        embedding: subEmb[idx],
      }));
      const ins = await supabase.from("chunks").insert(rows);
      if (ins.error) throw new Error(`insert failed: ${ins.error.message}`);
    }

    // 5) планируем следующий шаг
    const origin = getOrigin(event.rawUrl);
    if (start + BATCH < parts.length) {
      await setStage(docId, `queued ${start + BATCH}/${parts.length}`);
      // запускаем следующую инвокацию background-функции
      await fetch(`${origin}/.netlify/functions/ingest-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // предаём следующий offset
        body: JSON.stringify({ docId, start: start + BATCH }),
      });
    } else {
      // это был последний шаг → финализация
      await setStage(docId, "finalizing");
      await supabase
        .from("documents")
        .update({ status: "ready", original_text_len: text.length, error: null })
        .eq("id", docId);
      console.log(`ingest-background: done for ${docId}`);
    }
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (docId) {
      try {
        await supabase.from("documents").update({ status: "error", error: `ERROR: ${msg}` }).eq("id", docId);
      } catch {}
    }
    console.error("ingest-background error:", msg);
  }
};
