// app/api/diag/route.ts
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { embedTexts } from "@/lib/embed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();

    const supabase = getSupabaseAdmin();

    // 1) Реальные count'ы
    const docsSel = await supabase.from("documents").select("id", { count: "exact", head: true });
    const chunksSel = await supabase.from("chunks").select("id", { count: "exact", head: true });
    const documents = docsSel.count ?? 0;
    const chunks = chunksSel.count ?? 0;

    // 2) Один произвольный чанк (чтобы проверить RPC на нём)
    const { data: sample, error: sErr } = await supabase
      .from("chunks")
      .select("embedding, content")
      .limit(1)
      .single();

    // 3) Проверка RPC с sample.embedding
    let rpcFromSample = { ok: 0, err: null as string | null };
    if (!sErr && sample?.embedding) {
      const { data, error } = await supabase.rpc("match_chunks", {
        query_embedding: sample.embedding,
        match_count: 3,
      });
      rpcFromSample.ok = (data || []).length;
      rpcFromSample.err = error ? String(error.message || error) : null;
    }

    // 4) Если передан текст запроса q — проверим настоящий путь: embed → hybrid/match
    let query = null as null | {
      text: string;
      provider: string | undefined;
      chatModel: string | undefined;
      embedDim: number | undefined;
      top: Array<{ similarity?: number; rank?: number; preview: string }>;
      err?: string | null;
    };

    if (q) {
      query = {
        text: q,
        provider: process.env.LLM_PROVIDER,
        chatModel: process.env.CHAT_MODEL,
        embedDim: Number(process.env.EMBEDDING_DIM || "0"),
        top: [],
        err: null,
      };

      try {
        const [queryEmbedding] = await embedTexts([q]);

        // Пробуем гибрид, потом обычный RPC
        let hybridOk = false;
        let top: any[] = [];
        try {
          const r = await supabase.rpc("hybrid_match_chunks", {
            query_text: q,
            query_embedding: queryEmbedding,
            match_count: 6,
          });
          if (!r.error && Array.isArray(r.data)) {
            hybridOk = true;
            top = r.data;
          }
        } catch (_) {
          /* fallback ниже */
        }

        if (!hybridOk) {
          const r = await supabase.rpc("match_chunks", {
            query_embedding: queryEmbedding,
            match_count: 6,
          });
          if (r.error) throw r.error;
          top = r.data || [];
        }

        query.top = (top || []).map((r: any) => ({
          similarity: typeof r.similarity === "number" ? r.similarity : undefined,
          rank: typeof r.rank === "number" ? r.rank : undefined,
          preview: String(r.content || "").slice(0, 220),
        }));
      } catch (e: any) {
        query.err = String(e?.message || e);
      }
    }

    return NextResponse.json({
      ok: true,
      stats: { documents, chunks },
      sampleChunkExists: !!sample,
      rpcFromSample,
      query,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
