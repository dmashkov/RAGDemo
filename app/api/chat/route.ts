// app/api/chat/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const MAX_CONTEXT_CHUNKS = Number(process.env.MAX_CONTEXT_CHUNKS || 10);
const CHUNK_CLIP_LEN = Number(process.env.CHUNK_CLIP_LEN || 1200);
const CITATION_TTL = Number(process.env.CITATION_TTL || 3600);

const EMB_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-4o-mini";
const DOCS_BUCKET = process.env.DOCS_BUCKET || "documents";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

type MatchRow = {
  id?: string;
  document_id: string;
  chunk_index?: number;
  content: string;
  similarity?: number;
  rank?: number;
};

type DocMeta = {
  id: string;
  filename: string;
  storage_path?: string | null;
};

type Citation = {
  n: number;
  docId: string;
  filename: string;
  url: string | null;
  preview?: string;
};

function clip(s: string, n = CHUNK_CLIP_LEN) {
  if (!s) return s;
  return s.length <= n ? s : s.slice(0, n) + " …";
}

function linkRefs(answer: string, citations: Citation[]) {
  // Заменяем [#1] на кликабельную ссылку
  return answer.replace(/\[#(\d+)\]/g, (_, g1) => {
    const n = Number(g1);
    const c = citations.find((x) => x.n === n);
    if (!c || !c.url) return `[#${n}]`;
    return `[[#${n}]](${c.url})`;
  });
}

async function embedQuery(q: string) {
  const r = await openai.embeddings.create({ model: EMB_MODEL, input: q });
  return r.data[0].embedding as number[];
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      messages?: ChatMessage[];
    };

    const messages = body?.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
      ?.content;
    if (!lastUser || !lastUser.trim()) {
      return NextResponse.json(
        { error: "Empty prompt" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdmin();

    // 1) Эмбеддинг запроса
    const qVec = await embedQuery(lastUser);

    // 2) Поиск релевантных чанков: сначала гибридный, иначе — через векторный RPC
    let top: MatchRow[] = [];
    try {
      const r = await (supabase as any).rpc("hybrid_match_chunks", {
        query_text: lastUser,
        query_embedding: qVec,
        match_count: MAX_CONTEXT_CHUNKS,
      });
      if (!r.error && Array.isArray(r.data)) {
        top = r.data as MatchRow[];
      }
    } catch {
      /* no-op */
    }

    if (top.length === 0) {
      const r2 = await (supabase as any).rpc("match_chunks", {
        query_embedding: qVec,
        match_count: MAX_CONTEXT_CHUNKS,
      });
      if (r2.error) {
        return NextResponse.json(
          { error: `match_chunks failed: ${r2.error.message}` },
          { status: 500 }
        );
      }
      top = (r2.data || []) as MatchRow[];
    }

    if (top.length === 0) {
      // На крайний случай — мягкий ответ без контекста, чтобы UX не «падал»
      const fallback = await openai.chat.completions.create({
        model: CHAT_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "Ты ассистент. Если нет контекста из документов, вежливо скажи, что не нашёл нужных материалов.",
          },
          { role: "user", content: lastUser },
        ],
      });
      const text =
        fallback.choices?.[0]?.message?.content ||
        "Не удалось найти подходящих фрагментов в базе документов.";
      return NextResponse.json({
        answer: text,
        answer_linked: text,
        citations: [],
      });
    }

    // 3) Группируем по документам / собираем порядок документов
    const byDoc = new Map<string, MatchRow[]>();
    for (const row of top) {
      if (!row?.document_id || !row?.content) continue;
      if (!byDoc.has(row.document_id)) byDoc.set(row.document_id, []);
      byDoc.get(row.document_id)!.push(row);
    }

    const docOrder = Array.from(byDoc.keys());
    const allDocIds = docOrder;

    // 4) Подтянем метаданные документов (id, filename, storage_path)
    const { data: docsRes, error: docsErr } = await supabase
      .from("documents")
      .select("id, filename, storage_path")
      .in("id", allDocIds);

    if (docsErr) {
      return NextResponse.json(
        { error: `documents select failed: ${docsErr.message}` },
        { status: 500 }
      );
    }

    const docsMeta: DocMeta[] = (docsRes ?? []) as unknown as DocMeta[];

    // Для удобства — мапа id -> meta
    const docsMap = new Map(docsMeta.map((d) => [d.id, d]));

    // 5) Сгенерируем signed URL для каждого документа (если есть storage_path)
    const citations: Citation[] = [];
    let counter = 1;

    for (const id of docOrder) {
      const meta = docsMap.get(id);
      if (!meta) continue;

      let url: string | null = null;
      if (meta.storage_path) {
        const signed = await supabase.storage
          .from(DOCS_BUCKET)
          .createSignedUrl(meta.storage_path, CITATION_TTL)
          .then((r) => (r.error ? null : r.data?.signedUrl || null))
          .catch(() => null);
        url = signed;
      }

      // Превью — первые 120 символов первого чанка
      const firstChunk = byDoc.get(id)?.[0]?.content ?? "";
      const preview =
        firstChunk ? clip(firstChunk, 120).replace(/\s+/g, " ") : undefined;

      citations.push({
        n: counter++,
        docId: id,
        filename: meta.filename,
        url,
        preview,
      });
    }

    // 6) Собираем контекст для LLM
    // Формат: блоки с метками [#n], чтобы можно было сослаться на них в ответе.
    let ctx = "";
    for (const c of citations) {
      const rows = (byDoc.get(c.docId) || []).slice(0, 3); // не больше 3 чанков с документа
      const merged = rows.map((r) => r.content).join("\n");
      if (!merged.trim()) continue;
      ctx += `\n[ #${c.n} — ${c.filename} ]\n${clip(merged)}\n`;
    }
    ctx = ctx.trim();

    // 7) Генерация ответа
    const system =
      "Ты — ассистент RAG. Отвечай только на основе контекста ниже. Если нет ответа в контексте, прямо скажи об этом. Вставляй ссылки на источники в виде [#N]. Не придумывай факты.";
    const userPrompt = `Вопрос:\n${lastUser}\n\nКонтекст из документов:\n${ctx || "(нет контекста)"}\n\nИнструкции:\n- Используй только факты из контекста.\n- После фактов ставь ссылки вида [#1], [#2] и т.д., соответствующие блокам выше.\n`;

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
    });

    let answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Не удалось сгенерировать ответ.";
    const answer_linked = linkRefs(answer, citations);

    return NextResponse.json({
      answer,
      answer_linked,
      citations,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
