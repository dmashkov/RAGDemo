// app/api/reindex/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// Куда пуляем инжест: локально — /api/ingest, на Netlify — background-функция
const FN_BG =
  process.env.NETLIFY === "true"
    ? "/.netlify/functions/ingest-background"
    : "/api/ingest";

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseAdmin();
    const body = await req.json().catch(() => ({} as any));
    const all: boolean = !!body?.all;
    const docIdsInput: string[] | undefined = Array.isArray(body?.docIds)
      ? body.docIds
      : undefined;

    let docIds: string[] = [];

    if (all) {
      const { data, error } = await supabase.from("documents").select("id");
      if (error) {
        return NextResponse.json(
          { ok: false, error: error.message },
          { status: 500 }
        );
      }
      docIds = (data ?? []).map((d: any) => d.id as string);
    } else if (docIdsInput?.length) {
      docIds = docIdsInput;
    } else {
      return NextResponse.json(
        { ok: false, error: "Provide { all: true } or { docIds: [...] }" },
        { status: 400 }
      );
    }

    // Помечаем «queued» — приводим клиент к any, чтобы подавить TS-спор о типах
    const { error: updErr } = await (supabase as any)
      .from("documents")
      .update({ status: "queued", error: null })
      .in("id", docIds);

    // Если апдейт статуса не прошел — не фейлим весь процесс
    if (updErr) {
      // можно залогировать при желании
    }

    // Дергаем фоновые инжесты по каждому документу
    const origin = new URL(req.url).origin;
    const kicked: string[] = [];
    const failed: Array<{ id: string; err: string }> = [];

    for (const id of docIds) {
      try {
        const url = new URL(FN_BG, origin);
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docId: id }),
        });
        if (r.ok || r.status === 202) {
          kicked.push(id);
        } else {
          failed.push({ id, err: await r.text() });
        }
      } catch (e: any) {
        failed.push({ id, err: e?.message || String(e) });
      }
    }

    return NextResponse.json(
      {
        ok: failed.length === 0,
        queued: docIds.length,
        kicked,
        failed,
      },
      { status: failed.length ? 207 : 200 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
