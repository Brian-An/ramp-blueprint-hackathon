import { getStore } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(getStore().snapshot(), { headers: { "Cache-Control": "no-store" } });
}
