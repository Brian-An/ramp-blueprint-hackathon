import "server-only";
import OpenAI from "openai";
import type { FunctionTool, ResponseInputItem } from "openai/resources/responses/responses";
import type { Store } from "../store";
import type { Proposal } from "../contracts";
import { RunError } from "./errors";

export type ModelRequest = {
  prompt: string;
  conversationItems: ResponseInputItem[];
  toolSchemas: FunctionTool[];
  outputSchema: Record<string, unknown>;
};
export type ModelStep =
  | { kind: "tools"; calls: { id: string; name: string; args: unknown }[]; conversationItems?: ResponseInputItem[] }
  | { kind: "result"; proposal: unknown };
export type ModelTransport = (request: ModelRequest, signal?: AbortSignal) => Promise<ModelStep>;

export function createScriptedTransport(steps: ModelStep[]): ModelTransport {
  const script = structuredClone(steps);
  let index = 0;
  return async (_request, signal) => {
    if (signal?.aborted) throw new RunError("TIMEOUT");
    const step = script[index++];
    if (!step) throw new RunError("MODEL_INCOMPLETE");
    return structuredClone(step);
  };
}

export function createLiveTransport(): ModelTransport {
  if (!process.env.OPENAI_API_KEY?.trim()) throw new RunError("MODEL_NOT_CONFIGURED");
  const client = new OpenAI({ maxRetries: 0 });
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-6-astra";
  return async (request, signal) => {
    try {
      const response = await client.responses.create({
        model, instructions: request.prompt, input: request.conversationItems,
        tools: request.toolSchemas, max_output_tokens: 4_000, store: false,
        include: ["reasoning.encrypted_content"],
        text: { format: { type: "json_schema", name: "invoice_proposal", strict: true, schema: request.outputSchema } },
      }, { signal });
      if (response.output.some(item => item.type === "message" && item.content.some(content => content.type === "refusal"))) throw new RunError("MODEL_REFUSED");
      if (response.status !== "completed") throw new RunError("MODEL_INCOMPLETE");
      const calls = response.output.filter(item => item.type === "function_call").map(item => {
        let args: unknown;
        try { args = JSON.parse(item.arguments) as unknown; }
        catch { throw new RunError("INVALID_TOOL_ARGUMENTS"); }
        return { id: item.call_id, name: item.name, args };
      });
      if (calls.length) {
        // Responses reasoning items and function calls must accompany their call-ID outputs.
        const conversationItems: ResponseInputItem[] = response.output.filter(item => item.type === "reasoning" || item.type === "function_call" || item.type === "message");
        return { kind: "tools", calls, conversationItems };
      }
      try { return { kind: "result", proposal: JSON.parse(response.output_text) as unknown }; }
      catch { throw new RunError("INVALID_PROPOSAL"); }
    } catch (error) {
      if (signal?.aborted) throw new RunError("TIMEOUT");
      if (error instanceof RunError) throw error;
      throw new RunError("MODEL_FAILED");
    }
  };
}


// Fixture conclusions are explicit offline scripts and are never used by live transport.
export function createFixtureTransport(store: Store, invoiceId: string): ModelTransport {
  const invoice = store.getInvoice(invoiceId);
  if (!invoice) throw new RunError("INVOICE_NOT_FOUND");
  const customer = store.getCustomer(invoice.customerId);
  const email = store.searchEmails(invoice.customerId, invoice.number).find(email => email.id === "EMAIL-101-PO");
  let proposal: Proposal = {
    blocker: "unknown", explanation: "Fixture AI demonstrates a draft follow-up for review.", evidence: [],
    action: { kind: "send_email", recipient: customer?.email ?? null, subject: `Payment status for ${invoice.number}`, body: `Could you confirm the payment status of ${invoice.number} and let us know if anything is needed from us?`, task: null, followUpDate: null },
  };
  if (invoiceId === "INV-101") {
    proposal = email ? {
      blocker: "rejected_submission", explanation: "The customer supplied PO 4821 and requested a corrected invoice.",
      evidence: [{ emailId: email.id, quote: "The purchase order number is PO 4821. Please add it to INV-101 and send the corrected invoice." }],
      action: { kind: "owner_task", recipient: null, subject: null, body: null, task: "Add PO 4821 to INV-101 and submit the corrected invoice.", followUpDate: null },
    } : {
      ...proposal, blocker: "missing_po", explanation: "The customer requires a PO number to process INV-101.",
      evidence: [{ emailId: "EMAIL-101-1", quote: "We need your PO number before we can process INV-101." }],
      action: { ...proposal.action, subject: "PO number for INV-101", body: "Could you confirm the PO number needed for INV-101 so we can correct the invoice?" },
    };
  } else if (invoiceId === "INV-105") {
    proposal = { ...proposal, blocker: "promised_payment", explanation: "The October 5 payment run is a promise, not a recorded payment.",
      evidence: [{ emailId: "EMAIL-105-1", quote: "INV-105 will be included in the October 5 payment run." }],
      action: store.getDemoDate() < "2026-10-05"
        ? { kind: "wait", recipient: null, subject: null, body: null, task: null, followUpDate: "2026-10-05" }
        : { ...proposal.action, body: "Could you confirm the status of the promised October 5 payment for INV-105?" },
    };
  }
  const threadId = invoiceId === "INV-101" ? "THREAD-101" : invoiceId === "INV-105" ? "THREAD-105" : null;
  return createScriptedTransport([
    { kind: "tools", calls: [{ id: "invoice", name: "get_invoice", args: {} }, { id: "search", name: "search_emails", args: { query: invoice.number } }, { id: "payments", name: "get_payments", args: {} }, { id: "history", name: "get_action_history", args: {} }] },
    ...(threadId ? [{ kind: "tools" as const, calls: [{ id: "thread", name: "get_email_thread", args: { threadId } }] }] : []),
    { kind: "result", proposal },
  ]);
}
