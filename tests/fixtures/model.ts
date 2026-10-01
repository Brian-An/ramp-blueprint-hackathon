import type { Proposal } from "../../src/lib/contracts";
import type { ModelStep } from "../../src/lib/agent/model";

export const poProposal: Proposal = {
  blocker: "missing_po", explanation: "Acme requires the PO number before processing the invoice.",
  evidence: [{ emailId: "EMAIL-101-1", quote: "We need your PO number before we can process INV-101." }],
  action: { kind: "owner_task", task: "Obtain the PO number and correct the invoice.", recipient: null, subject: null, body: null, followUpDate: null },
};
export function poSteps(proposal: unknown = poProposal): ModelStep[] {
  return [
    { kind: "tools", calls: [{ id: "invoice-call", name: "get_invoice", args: {} }, { id: "search-call", name: "search_emails", args: { query: "INV-101" } }] },
    { kind: "tools", calls: [{ id: "thread-call", name: "get_email_thread", args: { threadId: "THREAD-101" } }, { id: "payments-call", name: "get_payments", args: {} }, { id: "history-call", name: "get_action_history", args: {} }] },
    { kind: "result", proposal },
  ];
}
