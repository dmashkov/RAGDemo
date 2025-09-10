// app/api/diag/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// @ts-nocheck  // Диагностический роут: отключаем TS-проверки, чтобы не ломать билд

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

function env(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`ENV ${n} is missing`);
  return v;
}

const supabase = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const MAX_CONTEXT_CHUNKS = Number(process.env.MAX_CONTEXT_CHUNKS || "10");

// удобная обёртка для count(*) без тащения данных
async function countRows(table: string) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
  if (error) throw new Error(`${table} count error: ${error.message}`);
  return count ?? 0;
}

export async function GET(req: NextRequest) {
  try {
    // 1) Статистика документов/чанков
    let documents = null, chunks = null;
    try {
      documents = await countRows("documents");
    } catch {}
    try {
      chunks = await countRows("chunks");
    } catch {}

    // 2) Берём любой сэмпл-чанк (если есть)
    const { data: sData, error: sErr } = await supabase
      .from("chunks")
      .select("id, content, embedding")
      .limit(1);

    const sample = sData?.[0] ?? null;
    const sampleChunkExists = !!sample;

    // 3) Тест RPC match_chunks по сэмплу (если есть embedding)
    let rpcFromSample = { ok: 0, err: null as string | null };
    if (sample && sample.embedding) {
      try {
        // если функция называется иначе у тебя (semantic_match_chunks/…),
        // просто переименуй здесь
        const r = await (supabase as any).rpc("match_chunks", {
          query_embedding: sample.embedding,
          match_count: 3,
        } as any);
        if (!r.error) {
          rpcFromSample.ok = Array.isArray(r.data) ? r.data.length : 1;
        } else {
          rpcFromSample.err = r.error.message;
        }
      } catch (e: any) {
        rpcFromSample.err = e?.message || String(e);
      }
    }

    // 4) Тест эмбеддингов
    let emb = { ok: false, err: null as string | null };
    try {
      const r = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: "ping" });
      emb.ok = Array.isArray(r.data?.[0]?.embedding);
    } catch (e: any) {
      emb.err = e?.message || String(e);
    }

    // 5) Опциональный быстрый запрос (q=? в URL) — вернём top[] превью (если есть RPC)
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    let top: Array<{ similarity?: number; preview: string }> = [];
    let queryErr: string | null = null;

    if (q) {
      try {
        const embQ = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: q });
        const vec = embQ.data?.[0]?.embedding || [];
        // пробуем сначала гибрид, потом семантику, затем match_chunks
        let r = await (supabase as any).rpc("hybrid_match_chunks", {
          query_text: q,
          query_embedding: vec,
          match_count: MAX_CONTEXT_CHUNKS,
        } as any);
        if (r.error || !Array.isArray(r.data) || r.data.length === 0) {
          r = await (supabase as any).rpc("semantic_match_chunks", {
            query_embedding: vec,
            match_count: MAX_CONTEXT_CHUNKS,
          } as any);
        }
        if (r.error || !Array.isArray(r.data) || r.data.length === 0) {
          r = await (supabase as any).rpc("match_chunks", {
            query_embedding: vec,
            match_count: MAX_CONTEXT_CHUNKS,
          } as any);
        }
        if (!r.error && Array.isArray(r.data)) {
          top = r.data.map((row: any) => ({
            similarity: row.similarity ?? null,
            preview: String(row.content || "").slice(0, 160),
          }));
        } else if (r.error) {
          queryErr = r.error.message;
        }
      } catch (e: any) {
        queryErr = e?.message || String(e);
      }
    }

    return NextResponse.json({
      ok: true,
      stats: { documents, chunks },
      sampleChunkExists,
      rpcFromSample,
      embeddings: emb,
      query: q
        ? { text: q, provider: "openai", embedModel: EMBEDDING_MODEL, top, err: queryErr }
        : undefined,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
