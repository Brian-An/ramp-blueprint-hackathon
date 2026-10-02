import { getStore } from "../../../../lib/db";
import { reviewCommandSchema } from "../../../../lib/contracts";
import { assertSameOriginJson, errorResponse } from "../../../../lib/http";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginJson(request);
    const command = reviewCommandSchema.parse(await request.json() as unknown);
    const { id } = await context.params;
    return Response.json({ action: getStore().reviewAction(id, command) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
