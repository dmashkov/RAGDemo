// app/api/chat/route.ts
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { embedTexts } from "@/lib/embed";
import { chatWithModel } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Msg = { role: "user" | "assistant"; content: string };

const SYSTEM_PROMPT = `Вы — ассистент по документам. Отвечайте строго на основе предоставленного контекста.
Если ответа нет в контексте, честно скажите об этом и укажите, какой документ/раздел нужен.
Цитируйте 1–3 коротких выдержки.`;

const MIN_SIM = Number(process.env.RAG_MIN_SIM || 0.5);
const FALLBACK_SCAN_LIMIT = Number(process.env.RAG_FALLBACK_SCAN_LIMIT || 500);
const MAX_CONTEXT_CHUNKS = Number(process.env.RAG_MAX_CONTEXT || 6);

// простая косинусная близость
function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ключевые слова для грубого фильтра
function keywordsFrom(q: string) {
  const base = q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length >= 3);
  const extra = ["llm", "ollama", "локал", "offline", "lm", "studio"];
  return Array.from(new Set([...base, ...extra]));
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messages = (body?.messages ?? []) as Msg[];
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content?.trim() ?? "";
    if (!lastUser) return NextResponse.json({ error: "Пустой вопрос" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const [qVec] = await embedTexts([lastUser]);

    let candidates: Array<{ content: string; similarity?: number; rank?: number }> = [];
    let used = "hybrid_match_chunks";

    // 1) гибрид, если есть
    try {
      const r = await supabase.rpc("hybrid_match_chunks", {
        query_text: lastUser,
        query_embedding: qVec,
        match_count: MAX_CONTEXT_CHUNKS,
      });
      if (!r.error && Array.isArray(r.data) && r.data.length > 0) {
        candidates = r.data as any[];
      } else {
        used = "match_chunks";
      }
    } catch {
      used = "match_chunks";
    }

    // 2) чистый векторный RPC
    if (used === "match_chunks" && candidates.length === 0) {
      const r = await supabase.rpc("match_chunks", {
        query_embedding: qVec,
        match_count: MAX_CONTEXT_CHUNKS,
      });
      if (!r.error && Array.isArray(r.data)) {
        candidates = (r.data as any[]) ?? [];
      }
    }

    // 3) локальный косинус (без RPC) + грубая фильтрация ключ. словами
    if (candidates.length === 0) {
      const kw = keywordsFrom(lastUser);
      // supabase-js не умеет массив параметров в .or — поэтому два запроса
      const likeAny = kw.map(k => `%${k}%`);
      let pool: any[] = [];

      // сначала пытаемся вытянуть по ILIKE
      for (const pat of likeAny) {
        const r = await supabase.from("chunks").select("content, embedding").ilike("content", pat).limit(100);
        if (!r.error && r.data) pool.push(...r.data);
      }

      // если пусто — просто берём верхние N
      if (pool.length === 0) {
        const r = await supabase.from("chunks").select("content, embedding").limit(FALLBACK_SCAN_LIMIT);
        pool = r.data || [];
      }

      // локальный пересчёт косинуса
      const ranked = pool
        .filter(r => Array.isArray(r.embedding))
        .map(r => ({ content: String(r.content || ""), similarity: cosine(qVec, r.embedding as number[]) }))
        .sort((a, b) => (b.similarity! - a.similarity!))
        .slice(0, MAX_CONTEXT_CHUNKS);

      candidates = ranked;
      used = "local_cosine";
    }

    const top = candidates.filter(r => (r?.content || "").trim()).slice(0, MAX_CONTEXT_CHUNKS);
    const bestSim = Math.max(0, ...top.map(r => typeof r.similarity === "number" ? r.similarity : 0));

    const context = top.map((r, i) => `# Фрагмент ${i + 1}\n${(r.content || "").slice(0, 2000)}`).join("\n\n").slice(0, 12000);

    if (!context) {
      return NextResponse.json({
        ok: true,
        answer:
          "Не нашёл релевантных фрагментов в загруженных документах. " +
          "Переформулируйте вопрос или загрузите документ, где явно есть формулировки «локальная LLM», «Ollama», «LM Studio».",
        debug: { used, bestSim },
      });
    }

    const userPrompt =
      `Вопрос: ${lastUser}\n\n` +
      `Контекст (используйте только его):\n${context}\n\n` +
      `Если в контексте нет ответа, скажите об этом прямо.`;

    const answer = await chatWithModel(SYSTEM_PROMPT, userPrompt);
    return NextResponse.json({ ok: true, answer, debug: { used, bestSim } });
  } catch (e: any) {
    console.error("/api/chat error:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
