// app/api/ingest/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';

const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export async function GET() {
  return NextResponse.json({
    ok: true,
    env: {
      supabaseUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      serviceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      netlify: process.env.NETLIFY === 'true',
    },
  }, { headers: H });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const docId: string | undefined = body?.docId;
    if (!docId) {
      return NextResponse.json({ error: 'docId is required' }, { status: 400, headers: H });
    }

    const origin = process.env.URL || process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
    const target = `${origin}/.netlify/functions/ingest-background`;

    const resp = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId }),
    });

    // Для background-функций Netlify обычно отвечает 202 с пустым телом,
    // но на некоторых планах/конфигурациях может быть 200. Считаем успехом любой 2xx.
    if (resp.status < 200 || resp.status >= 300) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`queue failed: ${resp.status} ${txt || ''}`.trim());
    }

    return NextResponse.json({ ok: true, queued: [docId], status: resp.status }, { status: 202, headers: H });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500, headers: H });
  }
}
