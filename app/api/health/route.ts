export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return new Response("OK\n", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
