// netlify/functions/ingest-background.ts
import type { BackgroundHandler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const BUCKET = process.env.DOCS_BUCKET || "documents";
const EMB_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

// Диагностические флаги/лимиты
const USE_FAKE_EMB = process.env.USE_FAKE_EMB === "1";       // ← временно отключаем реальные эмбеддинги
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || "1536");
const BATCH = Number(process.env.INGEST_BATCH || "32");      // осторожный batch для serverless
const MAX_CHUNKS = Number(process.env.MAX_CHUNKS || "400");  // ограничение на число чанков за один прогон (для MVP)

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

// ---------- utils ----------
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
  if (USE_FAKE_EMB) {
    // заглушка — помогает проверить вставку в БД/батчинг/лимиты без внешних вызовов
    return texts.map(() => Array(EMBEDDING_DIM).fill(0));
  }
  const r = await openai.embeddings.create({ model: EMB_MODEL, input: texts });
  return r.data.map((d) => d.embedding as number[]);
}

// TXT + DOCX (PDF сознательно отключен для Netlify в MVP)
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

  // остальные форматы пока пропускаем
  return "";
}

export const handler: BackgroundHandler = async (event) => {
  let docId: string | undefined;

  const setStage = async (stage: string) => {
    if (!docId) return;
    try {
      console.log(`[ingest] ${docId} → ${stage}`);
      const u = await supabase.from("documents").update({ error: stage }).eq("id", docId);
      if (u.error) console.warn("setStage update warning:", u.error.message);
    } catch (e) {
      console.warn("setStage exception:", (e as any)?.message || String(e));
    }
  };

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    docId = body?.docId;
    const reindexAll = !!body?.all;

    if (!docId && !reindexAll) {
      console.warn("ingest-background: missing docId or { all: true }");
      return;
    }

    // ---- одиночный документ ----
    if (docId) {
      const { data: doc, error: docErr } = await supabase
        .from("documents")
        .select("*")
        .eq("id", docId)
        .single();
      if (docErr || !doc) {
        console.error("document not found:", docId, docErr?.message);
        return;
      }

      await supabase.from("documents").update({ status: "processing", error: null }).eq("id", docId);

      try {
        await setStage("downloading...");
        const text = await extractFromStorage(doc.storage_path, doc.mime_type);

        await setStage(`extracted: ${text.length} chars`);
        if (!text) throw new Error("empty text after extraction");

        let parts = chunkText(text);
        if (MAX_CHUNKS > 0 && parts.length > MAX_CHUNKS) {
          parts = parts.slice(0, MAX_CHUNKS);
          await setStage(`chunked: ${parts.length} parts (truncated)`);
        } else {
          await setStage(`chunked: ${parts.length} parts`);
        }
        if (parts.length === 0) throw new Error("no chunks");

        await setStage("clean old chunks");
        const del = await supabase.from("chunks").delete().eq("document_id", docId);
        if (del.error) throw new Error(`cleanup chunks failed: ${del.error.message}`);

        for (let i = 0; i < parts.length; i += BATCH) {
          const batch = parts.slice(i, i + BATCH);

          await setStage(`embedding batch ${i}-${i + batch.length - 1} ${USE_FAKE_EMB ? "(fake)" : ""}`);
          const embs = await embedBatch(batch);

          await setStage(`inserting batch ${i}-${i + batch.length - 1}`);
          // дополнительная защита от слишком больших вставок
          for (let j = 0; j < batch.length; j += 16) {
            const subBatch = batch.slice(j, j + 16);
            const subEmbs = embs.slice(j, j + 16);
            const rows = subBatch.map((content, idx) => ({
              document_id: docId!,
              chunk_index: i + j + idx,
              content,
              embedding: subEmbs[idx],
            }));
            const ins = await supabase.from("chunks").insert(rows);
            if (ins.error) throw new Error(ins.error.message);
          }
        }

        await setStage("finalizing");
        await supabase
          .from("documents")
          .update({ status: "ready", original_text_len: text.length, error: null })
          .eq("id", docId);

        console.log(`ingest-background: done for ${docId}`);
      } catch (e: any) {
        await supabase
          .from("documents")
          .update({ status: "error", error: e?.message || String(e) })
          .eq("id", docId);
        console.error("ingest-background error:", e);
      }

      return;
    }

    // ---- массовый прогон ----
    const { data: docs, error: selErr } = await supabase.from("documents").select("id");
    if (selErr) {
      console.error("select documents failed:", selErr.message);
      return;
    }

    const origin = (() => {
      try {
        return new URL(event.rawUrl).origin;
      } catch {
        return "";
      }
    })();

    for (const d of docs || []) {
      try {
        await fetch(`${origin}/.netlify/functions/ingest-background`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docId: d.id }),
        });
      } catch (e) {
        console.warn("spawn background failed for", d.id, (e as any)?.message || String(e));
      }
    }
  } catch (e) {
    console.error("ingest-background top-level error:", e);
  }
};
