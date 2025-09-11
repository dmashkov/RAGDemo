// app/api/reindex/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

type Body = {
  scope?: "all" | "pending";   // pending — по умолчанию: всё, что не ready
  ids?: string[];              // можно явно список id
  limit?: number;              // на всякий случай ограничитель
};

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseAdmin();
    const { scope = "pending", ids = [], limit } = (await req.json().catch(() => ({}))) as Body;

    // 1) соберём список docIds
    let docIds: string[] = [];

    if (ids.length > 0) {
      docIds = uniq(ids).filter(Boolean);
    } else {
      const q = supabase
        .from("documents")
        .select("id,status")
        .order("created_at", { ascending: false });

      const { data, error } = await q;
      if (error) throw new Error(`select documents failed: ${error.message}`);

      const filtered =
        scope === "all"
          ? data
          : (data || []).filter((d: any) => (d?.status || "") !== "ready");

      docIds = filtered.map((d: any) => d.id);
      if (typeof limit === "number" && limit > 0) {
        docIds = docIds.slice(0, limit);
      }
    }

    if (docIds.length === 0) {
      return NextResponse.json({ ok: true, enqueued: 0, accepted: 0, failed: 0, details: [] });
    }

    // 2) пометим queued (одним апдейтом)
    const { error: updErr } = await supabase
      .from("documents")
      .update({ status: "queued", error: null })
      .in("id", docIds);
    if (updErr) {
      // не фейлим весь запуск — просто зафиксируем
      console.warn("reindex: mark queued failed:", updErr.message);
    }

    // 3) триггерим background-функцию для каждого docId
    const origin = new URL(req.url).origin; // https://your-site…
    const bgUrl = `${origin}/.netlify/functions/ingest-background`;

    // ограничим параллелизм (быстрый и простой семафор)
    const CONCURRENCY = Number(process.env.REINDEX_CONCURRENCY || 6);
    let idx = 0;
    let accepted = 0;
    let failed = 0;
    const details: Array<{ id: string; ok: boolean; status?: number; error?: string }> = [];

    async function worker() {
      while (idx < docIds.length) {
        const i = idx++;
        const id = docIds[i];
        try {
          const r = await fetch(bgUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ docId: id }),
          });
          if (r.status === 202 || r.ok) {
            accepted++;
            details.push({ id, ok: true, status: r.status });
          } else {
            failed++;
            details.push({ id, ok: false, status: r.status, error: await r.text().catch(() => "") });
          }
        } catch (e: any) {
          failed++;
          details.push({ id, ok: false, error: e?.message || String(e) });
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, docIds.length) }, () => worker());
    await Promise.all(workers);

    return NextResponse.json({
      ok: failed === 0,
      enqueued: docIds.length,
      accepted,
      failed,
      details,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
