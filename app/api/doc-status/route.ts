export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function must(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`ENV ${n} is missing`);
  return v;
}

const supabase = createClient(
  must("NEXT_PUBLIC_SUPABASE_URL"),
  must("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } }
);

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const docId = searchParams.get("docId");
    if (!docId) return NextResponse.json({ ok: false, error: "docId required" }, { status: 400 });

    const { data: doc, error: dErr } = await supabase
      .from("documents")
      .select("id, filename, status, error, original_text_len, created_at")
      .eq("id", docId)
      .single();

    if (dErr || !doc) return NextResponse.json({ ok: false, error: "document not found" }, { status: 404 });

    const { count, error: cErr } = await supabase
      .from("chunks")
      .select("*", { count: "exact", head: true })
      .eq("document_id", docId);

    if (cErr) throw cErr;

    return NextResponse.json({
      ok: true,
      doc,
      chunks: count ?? 0,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
