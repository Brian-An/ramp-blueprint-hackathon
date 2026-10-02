import { z } from "zod";
import { getStore } from "../../../lib/db";
import { RunError } from "../../../lib/agent/errors";
import { createLiveTransport, createFixtureTransport, type ModelTransport } from "../../../lib/agent/model";
import { investigateInvoice } from "../../../lib/agent/run";
import { assertSameOriginJson, errorResponse } from "../../../lib/http";

export const runtime = "nodejs";
const inputSchema = z.strictObject({ invoiceId: z.string().min(1).max(200), generationId: z.string().min(1).max(200), contextVersion: z.number().int().positive() });
// ponytail: one local process, use a database lease for multiple server instances.
const inFlight = new Set<string>();

export async function POST(request: Request) {
  let assignedId: string | undefined;
  try {
    assertSameOriginJson(request);
    const input = inputSchema.parse(await request.json() as unknown);
    const store = getStore();
    const invoice = store.getInvoice(input.invoiceId);
    if (!invoice) throw new RunError("INVOICE_NOT_FOUND");
    const { generationId } = store.getSettings();
    const contextVersion = invoice.contextVersion;
    if (generationId !== input.generationId || contextVersion !== input.contextVersion) throw new RunError("STALE_CONTEXT");
    if (inFlight.has(invoice.id)) throw new RunError("IN_FLIGHT");
    const existing = store.getInvestigation(invoice.id, generationId, contextVersion);
    if (existing) return Response.json(existing, { headers: { "Cache-Control": "no-store" } });
    inFlight.add(invoice.id);
    assignedId = invoice.id;
    let liveTransport: ModelTransport | undefined;
    const transport: ModelTransport = process.env.AGENT_MODE === "fixture"
      ? createFixtureTransport(store, invoice.id)
      : (modelRequest, signal) => (liveTransport ??= createLiveTransport())(modelRequest, signal);
    const proposal = await investigateInvoice(store, invoice.id, transport, request.signal);
    const action = store.saveInvestigation(invoice.id, generationId, contextVersion, proposal);
    return Response.json({ proposal, action }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
  finally { if (assignedId) inFlight.delete(assignedId); }
}
