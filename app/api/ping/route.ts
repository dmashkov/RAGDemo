export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
};

export async function GET() {
  return new NextResponse(
    JSON.stringify({ ok: true, ts: new Date().toISOString() }),
    { status: 200, headers }
  );
}

// на всякий — чтобы curl -I тоже показывал 200
export async function HEAD() {
  return new NextResponse(null, { status: 200, headers });
}

// и preflight/OPTIONS, если кто-то дергает в браузере
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...headers, "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS" },
  });
}
