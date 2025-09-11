// app/api/chat/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// ---- ENV / константы ------------------------------------------------------

const LLM_PROVIDER = process.env.LLM_PROVIDER || "openai";
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-4o-mini";

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 1536);

const DOCS_BUCKET = process.env.DOCS_BUCKET || "documents";

// сколько чанков подмешиваем в контекст
const MAX_CONTEXT_CHUNKS = Number(process.env.MAX_CONTEXT_CHUNKS || 12);

// срок жизни подписанных ссылок на источники (сек)
const CITATION_TTL_SEC = Number(process.env.CITATION_TTL || 3600);

// мягкий лимит длины одного чанка (для подсказки LLM)
const CHUNK_CLIP_LEN = Number(process.env.CHUNK_CLIP_LEN || 1200);

// ---- типы лёгкие (минимум строгости, чтобы не падать на сборке) ----------

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

type RpcChunkRow = {
  document_id: string;
  chunk_index: number;
  content: string;
  similarity?: number;
  rank?: number;
};

type Citation = {
  n: number;            // номер источника для [#n]
  docId: string;
  filename: string;
  url: string | null;
  preview?: string;
};

// ---- утилиты ---------------------------------------------------------------

function assertEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`ENV ${name} is missing`);
  return v;
}

function clip(s: string, n: number) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) + " ..." : s;
}

/** Заменяем [#n] на markdown-ссылку, если есть URL в citations */
function linkifyHashes(markdown: string, citations: Citation[]) {
  return markdown.replace(/\[#(\d+)\]/g, (_, numStr) => {
    const n = Number(numStr);
    const c = citations.find((x) => x.n === n);
    // экранируем # в ссылке, чтобы не спутать с заголовком
    return c?.url ? `[\\#${n}](${c.url} "${c.filename}")` : `[#${n}]`;
  });
}

// ---- ядро ------------------------------------------------------------------

const openai = new OpenAI({
  apiKey: LLM_PROVIDER === "openai" ? assertEnv("OPENAI_API_KEY") : undefined,
});

async function embedQuery(q: string) {
  // Можно добавить USE_FAKE_EMB=1 для отладки
  if (process.env.USE_FAKE_EMB === "1") {
    return new Array(EMBEDDING_DIM).fill(0);
  }
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: q,
  });
  return res.data[0].embedding as number[];
}

async function fetchTopChunks(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  queryText: string,
  queryVec: number[],
  limit: number
): Promise<RpcChunkRow[]> {
  // 1) Пытаемся гибрид (если создана RPC функция hybrid_match_chunks)
  try {
    const r = await (supabase as any).rpc("hybrid_match_chunks", {
      query_text: queryText,
      query_embedding: queryVec,
      match_count: limit,
    });
    if (!r.error && Array.isArray(r.data) && r.data.length) {
      return r.data as RpcChunkRow[];
    }
  } catch {
    // молча падаем на fallback
  }

  // 2) Fallback: только векторный матч
  const r2 = await (supabase as any).rpc("match_chunks", {
    query_embedding: queryVec,
    match_count: limit,
  });
  if (r2.error) {
    throw new Error(`match_chunks failed: ${r2.error.message}`);
  }
  return (r2.data || []) as RpcChunkRow[];
}

function buildSystemPrompt() {
  // Короткий system prompt: жёстко приземляем ответ на данные из контекста
  return [
    "Ты — ассистент, отвечающий строго на основе предоставленного контекста (фрагменты из документов).",
    "Если ответ напрямую не следует из контекста — скажи, чего не хватает, и предложи уточнить/загрузить нужный документ.",
    "В ответе ставь ссылки-цитаты там, где используешь факт: формат [#N], где N — номер источника из списка ниже.",
  ].join("\n");
}

function buildContextBlock(
  top: RpcChunkRow[],
  docNumbers: Record<string, number>
) {
  // Строим единый текстовый блок контекста, с пометкой, к какому источнику относится чанк
  const parts: string[] = [];
  top.forEach((row) => {
    const n = docNumbers[row.document_id] ?? 0;
    const chunk = clip(row.content || "", CHUNK_CLIP_LEN);
    parts.push(`[#${n}] ${chunk}`);
  });
  return parts.join("\n\n");
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseAdmin();

    // ---- читаем вход ----
    const body = await req.json().catch(() => ({} as any));
    const messages: ChatMessage[] = Array.isArray(body?.messages)
      ? body.messages
      : [];

    let lastUser = body?.text?.toString?.() || "";
    if (!lastUser) {
      const rev = [...messages].reverse();
      const u = rev.find((m) => m.role === "user");
      lastUser = u?.content || "";
    }
    if (!lastUser.trim()) {
      return NextResponse.json(
        { error: "Пустой запрос" },
        { status: 400 }
      );
    }

    // ---- вектор запроса ----
    const qVec = await embedQuery(lastUser);

    // ---- top-чанки ----
    const top = await fetchTopChunks(supabase, lastUser, qVec, MAX_CONTEXT_CHUNKS);

    // Если вдруг пусто — аккуратно отвечаем
    if (!top.length) {
      return NextResponse.json({
        answer:
          "Я не нашёл подходящих фрагментов в ваших документах для ответа. Попробуйте переформулировать вопрос или загрузите релевантный файл.",
        citations: [],
        top: [],
      });
    }

    // ---- собираем список документов по порядку появления ----
    const docOrder: string[] = [];
    for (const r of top) {
      if (!docOrder.includes(r.document_id)) docOrder.push(r.document_id);
    }

    // ---- метаданные документов ----
    const { data: docsMeta, error: docsErr } = await supabase
      .from("documents")
      .select("id, filename, storage_path")
      .in("id", docOrder);
    if (docsErr) {
      // не фейлим — просто не сможем подписать ссылки
      console.warn("chat/docs meta error:", docsErr.message);
    }

    // ---- выдаём номера документам (для [#N]) ----
    const docNumbers: Record<string, number> = {};
    docOrder.forEach((id, i) => (docNumbers[id] = i + 1));

    // ---- подписанные ссылки ----
    const citations: Citation[] = [];
    for (const id of docOrder) {
      const meta = docsMeta?.find((d) => d.id === id);
      if (!meta) continue;

      let url: string | null = null;

      // Если бакет публичный — можно так:
      // const pub = supabase.storage.from(DOCS_BUCKET).getPublicUrl(meta.storage_path);
      // url = pub.data?.publicUrl || null;

      // По умолчанию используем приватный бакет с подписанными ссылками
      const signed = await supabase.storage
        .from(DOCS_BUCKET)
        .createSignedUrl(meta.storage_path, CITATION_TTL_SEC);

      if (!signed.error) {
        url = signed.data?.signedUrl || null;
      } else {
        console.warn("chat/signed url error:", signed.error.message);
      }

      citations.push({
        n: docNumbers[id],
        docId: id,
        filename: meta.filename,
        url,
        preview: clip(top.find((t) => t.document_id === id)?.content || "", 180),
      });
    }

    // ---- контекст для LLM ----
    const contextBlock = buildContextBlock(top, docNumbers);

    // ---- подсказка для модели ----
    const systemPrompt = buildSystemPrompt();
    const userPrompt = [
      "Вопрос:",
      lastUser,
      "",
      "Контекст (фрагменты из документов):",
      contextBlock,
      "",
      "Инструкции:",
      "- Отвечай по сути и кратко.",
      "- По месту факта ставь цитаты [#N].",
      "- В конце при необходимости добавь краткие шаги/советы.",
    ].join("\n");

    // ---- вызов LLM ----
    let answer = "";
    if (LLM_PROVIDER === "openai") {
      const comp = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
      });
      answer = comp.choices?.[0]?.message?.content?.trim() || "";
    } else {
      throw new Error(`Unsupported LLM_PROVIDER: ${LLM_PROVIDER}`);
    }

    if (!answer) {
      answer =
        "Не смог сформировать ответ на основе найденных фрагментов. Попробуйте уточнить вопрос.";
    }

    // ---- делаем кликабельные [#N] внутри текста ----
    const answer_linked = linkifyHashes(answer, citations);

    // ---- отдаём результат ----
    return NextResponse.json({
      answer,
      answer_linked,
      citations,
      top, // можно убрать в проде; полезно для отладки
    });
  } catch (e: any) {
    console.error("/api/chat error:", e);
    return NextResponse.json(
      { error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
