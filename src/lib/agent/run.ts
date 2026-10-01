import { z } from "zod";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { remainingCents } from "../accounting";
import { proposalSchema, type Proposal } from "../contracts";
import type { Store } from "../store";
import { RunError } from "./errors";
import type { ModelTransport } from "./model";
import { investigationPrompt } from "./prompt";
import { createTools, toToolError, ToolRequestError } from "./tools";

export async function investigateInvoice(store: Store, invoiceId: string, transport: ModelTransport, signal?: AbortSignal): Promise<Proposal> {
  const invoice = store.getInvoice(invoiceId);
  if (!invoice) throw new RunError("INVOICE_NOT_FOUND");
  const initial = store.getSettings();
  const tools = createTools(store, invoiceId);
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), 60_000);
  const runSignal = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
  let abortListener: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new RunError("TIMEOUT"));
    runSignal.addEventListener("abort", abortListener, { once: true });
  });
  function checkContext() {
    if (runSignal.aborted) throw new RunError("TIMEOUT");
    if (store.getSettings().generationId !== initial.generationId || store.getInvoice(invoiceId)?.contextVersion !== invoice?.contextVersion) throw new RunError("STALE_CONTEXT");
  }
  try {
    checkContext();
    if (remainingCents(invoice, store.getPayments(invoiceId)) === 0) return {
      blocker: "none", explanation: "Recorded payments cover this invoice in full.", evidence: [],
      action: { kind: "none", recipient: null, subject: null, body: null, task: null, followUpDate: null },
    };
    const conversationItems: ResponseInputItem[] = [{ role: "user", content: `Investigate assigned invoice ${invoice.number} (${invoiceId}).` }];
    const outputSchema = z.toJSONSchema(proposalSchema, { unrepresentable: "any" });
    let toolCount = 0;
    const callIds = new Set<string>();
    for (let responseCount = 0; responseCount < 8; responseCount++) {
      checkContext();
      const step = await Promise.race([transport({ prompt: investigationPrompt, conversationItems: structuredClone(conversationItems), toolSchemas: tools.definitions, outputSchema }, runSignal), cancelled]);
      checkContext();
      if (step.kind === "result") {
        const parsed = proposalSchema.safeParse(step.proposal);
        if (!parsed.success) throw new RunError("INVALID_PROPOSAL");
        const proposal = parsed.data;
        validateProposalAction(proposal, store.getCustomer(invoice.customerId)?.email, store.getDemoDate());
        if (proposal.blocker !== "unknown" && proposal.blocker !== "none" && !proposal.evidence.length) throw new RunError("INVALID_EVIDENCE");
        const delivered = tools.getRetrievedEmails();
        for (const citation of proposal.evidence) {
          if (!citation.quote.trim() || !delivered.some(email => email.id === citation.emailId && (email.subject.includes(citation.quote) || email.body.includes(citation.quote)))) throw new RunError("INVALID_EVIDENCE");
        }
        return proposal;
      }
      if (!step.calls.length || toolCount + step.calls.length > 24) throw new RunError("RUN_LIMIT");
      toolCount += step.calls.length;
      const outputs: ResponseInputItem[] = [];
      for (const call of step.calls) {
        if (!call.id || callIds.has(call.id)) throw new RunError("INVALID_TOOL_ARGUMENTS");
        callIds.add(call.id);
        let output: unknown;
        try { output = tools.dispatch(call.name, call.args); }
        catch (error) {
          if (error instanceof ToolRequestError && error.code === "INVALID_ARGUMENTS") throw new RunError("INVALID_TOOL_ARGUMENTS");
          output = toToolError(error);
        }
        outputs.push({ type: "function_call_output", call_id: call.id, output: JSON.stringify(output) });
      }
      conversationItems.push(...(step.conversationItems ?? step.calls.map(call => ({ type: "function_call" as const, call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }))), ...outputs);
    }
    throw new RunError("RUN_LIMIT");
  } catch (error) {
    if (error instanceof RunError) throw error;
    throw new RunError("MODEL_FAILED");
  } finally {
    clearTimeout(timeout);
    if (abortListener) runSignal.removeEventListener("abort", abortListener);
  }
}

export function validateProposalAction(proposal: Proposal, customerEmail: string | undefined, demoDate: string): void {
  const action = proposal.action;
  const nonempty = (value: string | null) => Boolean(value?.trim());
  const valid = action.kind === "send_email"
    ? action.recipient === customerEmail && nonempty(action.subject) && nonempty(action.body) && action.task === null && action.followUpDate === null
    : action.kind === "owner_task"
      ? nonempty(action.task) && action.recipient === null && action.subject === null && action.body === null && action.followUpDate === null
      : action.kind === "wait"
        ? action.followUpDate !== null && action.followUpDate > demoDate && action.recipient === null && action.subject === null && action.body === null && action.task === null
        : action.recipient === null && action.subject === null && action.body === null && action.task === null && action.followUpDate === null;
  if (!valid || !proposal.explanation.trim()) throw new RunError("INVALID_PROPOSAL");
}
