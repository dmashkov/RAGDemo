// app/api/chat/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// ====== ENV / CONFIG ======
function env(name: string, optional = false) {
  const v = process.env[name];
  if (!v && !optional) throw new Error(`ENV ${name} is missing`);
  return v || "";
}

const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-4o-mini";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || "1536");

const MAX_CONTEXT_CHUNKS = Number(process.env.MAX_CONTEXT_CHUNKS || "10");
const MAX_CHARS_CONTEXT = Number(process.env.MAX_CHARS_CONTEXT || "12000"); // «срезаем» контекст по символам для экономии токенов

const supabase = createClient(
  env("NEXT_PUBLIC_SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY")
);

// Сейчас поддерживаем OpenAI; при необходимости можно расширить под других провайдеров
const openai =
  LLM_PROVIDER === "openai"
    ? new OpenAI({ apiKey: env("OPENAI_API_KEY") })
    : null;

// ====== HELPERS ======
type Message = { role: "system" | "user" | "assistant"; content: string };

function pickLastUser(messages: Message[] | undefined): string {
  if (!messages?.length) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return String(messages[i].content ?? "").trim();
  }
  return "";
}

function buildSystemPrompt() {
  return [
    "Ты — ассистент, отвечающий строго на основе предоставленного контекста.",
    "Если в контексте нет ответа, так и скажи: «Не нашёл ответа в загруженных документах».",
    "Отвечай кратко и по-русски. При необходимости перечисляй номера фрагментов [#1], [#2] и т.п.",
  ].join(" ");
}

function buildUserPrompt(question: string, context: string) {
  return [
    "Вопрос пользователя:",
    question,
    "",
    "Контекст из документов (фрагменты):",
    context,
    "",
    "Сформируй ответ, опираясь исключительно на контекст выше.",
  ].join("\n");
}

function formatContextFromChunks(chunks: Array<{ content: string }>) {
  // собираем и ограничиваем общий размер контекста
  let total = 0;
  const parts: string[] = [];
  chunks.forEach((c, i) => {
    const piece = `[#${i + 1}] ${c.content.trim()}`;
    if (total + piece.length <= MAX_CHARS_CONTEXT) {
      parts.push(piece);
      total += piece.length;
    }
  });
  return parts.join("\n---\n");
}

// ====== VECTORS ======
async function embedText(text: string): Promise<number[]> {
  if (!openai) throw new Error("Only OpenAI is supported right now.");
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  const vec = (res.data?.[0]?.embedding || []) as number[];
  if (!Array.isArray(vec) || !vec.length) {
    throw new Error("Failed to get embedding for query");
  }
  // На всякий: проверим совпадение размерности
  if (EMBEDDING_DIM && vec.length !== EMBEDDING_DIM) {
    // не падаем, но предупреждаем — на рантайме Postgres всё равно проверит
    console.warn(
      `Embedding dim mismatch: got ${vec.length}, expected ${EMBEDDING_DIM}`
    );
  }
  return vec;
}

// ====== RETRIEVAL ======
// Пытаемся: 1) hybrid_match_chunks (если есть), 2) semantic_match_chunks (embeddings-only),
// 3) простой бэкап – последние чанки (не релевантно, но лучше, чем упасть).
async function retrieveTopChunks(question: string, qVec: number[]) {
  // 1) гибридная
  try {
    const r = await (supabase as any).rpc("hybrid_match_chunks", {
      query_text: question,
      query_embedding: qVec,
      match_count: MAX_CONTEXT_CHUNKS,
    } as any);
    if (!r.error && Array.isArray(r.data) && r.data.length > 0) {
      return r.data as Array<{ content: string; document_id: string; similarity?: number }>;
    }
  } catch (e) {
    // глотаем — идём дальше
  }

  // 2) только векторы
  try {
    const r2 = await (supabase as any).rpc("semantic_match_chunks", {
      query_embedding: qVec,
      match_count: MAX_CONTEXT_CHUNKS,
    } as any);
    if (!r2.error && Array.isArray(r2.data) && r2.data.length > 0) {
      return r2.data as Array<{ content: string; document_id: string; similarity?: number }>;
    }
  } catch (e) {
    // глотаем — идём дальше
  }

  // 3) fallback: тупо последние чанки (на случай, если RPC не заведены)
  try {
    const fb = await supabase
      .from("chunks")
      .select("content, document_id")
      .order("created_at", { ascending: false })
      .limit(MAX_CONTEXT_CHUNKS);
    if (!fb.error && Array.isArray(fb.data)) {
      return fb.data as Array<{ content: string; document_id: string }>;
    }
  } catch {
    // ignore
  }

  return [] as Array<{ content: string; document_id: string }>;
}

// ====== LLM CALL ======
async function generateAnswer(question: string, contextText: string) {
  if (!openai) throw new Error("Only OpenAI is supported right now.");

  const messages: Message[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt(question, contextText) },
  ];

  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.2,
    messages,
  });

  const text =
    resp.choices?.[0]?.message?.content?.trim() ||
    "Не удалось получить ответ от модели.";
  return text;
}

// ====== HANDLER ======
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      messages?: Message[];
      question?: string; // допускаем упрощённый формат
    };

    const lastUser = (body.question || pickLastUser(body.messages)).trim();
    if (!lastUser) {
      return NextResponse.json(
        { error: "В запросе нет вопроса пользователя." },
        { status: 400 }
      );
    }

    // 1) эмбеддинг запроса
    const qVec = await embedText(lastUser);

    // 2) поиск релевантных чанков
    const top = await retrieveTopChunks(lastUser, qVec);

    // 3) сборка контекста
    const contextText = formatContextFromChunks(
      (top || []).map((x) => ({ content: String((x as any).content || "") }))
    );

    // 4) генерация ответа
    const answer = await generateAnswer(lastUser, contextText);

    return NextResponse.json({
      ok: true,
      question: lastUser,
      answer,
      usedChunks: (top || []).map((t, i) => ({
        n: i + 1,
        preview: String((t as any).content || "").slice(0, 140),
        document_id: (t as any).document_id || null,
        similarity: (t as any).similarity ?? null,
      })),
    });
  } catch (e: any) {
    console.error("/api/chat error:", e);
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
