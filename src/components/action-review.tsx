import { useState } from "react";
import type { Action, ReviewCommand } from "@/lib/contracts";

export default function ActionReview({ action, onReview }: { action: Action; onReview: (id: string, command: ReviewCommand) => Promise<void> }) {
  const draft = action.proposal.action;
  const [recipient, setRecipient] = useState(draft.recipient ?? "");
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [body, setBody] = useState(draft.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function review(operation: ReviewCommand["operation"]) {
    setBusy(true); setError("");
    try { await onReview(action.id, { operation, generationId: action.generationId, expectedVersion: action.version, ...(operation === "approve" && draft.kind === "send_email" ? { recipient, subject, body } : {}) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The action could not be saved. Try again."); }
    finally { setBusy(false); }
  }
  if (action.status !== "pending" && action.status !== "accepted") return <p className="muted">Action {action.status}. Its record remains in history.</p>;
  return <section className="review-section" aria-labelledby="action-review-title" aria-busy={busy}>
    <p className="eyebrow">Owner review required</p><h3 id="action-review-title">{draft.kind === "send_email" ? "Review draft email" : draft.kind === "owner_task" ? "Owner task" : "Waiting for payment"}</h3>
    {draft.kind === "send_email" ? <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void review("approve"); }}>
      <p className="muted">Approve only after reviewing every field. This records a simulated email; nothing is sent externally.</p>
      <label className="field">Recipient<input type="email" required value={recipient} onChange={event => setRecipient(event.target.value)} disabled={busy} autoComplete="off" /></label>
      <label className="field">Email subject<input required maxLength={200} value={subject} onChange={event => setSubject(event.target.value)} disabled={busy} /></label>
      <label className="field">Email body<textarea required maxLength={8000} rows={7} value={body} onChange={event => setBody(event.target.value)} disabled={busy} /></label>
      <div className="flex flex-wrap gap-3"><button className="primary-button" disabled={busy}>{busy ? "Recording approval..." : "Approve simulated email"}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void review("dismiss")}>Dismiss proposal</button></div>
    </form> : <div className="grid gap-4">
      {draft.kind === "owner_task" ? <><p className="whitespace-pre-wrap break-words">{draft.task}</p><p className="muted">Perform this task yourself outside the app. Completion does not edit an invoice or submit it through a portal.</p><div className="flex flex-wrap gap-3"><button className="primary-button" disabled={busy} onClick={() => void review(action.status === "accepted" ? "complete" : "approve")}>{busy ? "Saving..." : action.status === "accepted" ? "Mark task complete" : "Accept owner task"}</button><button className="secondary-button" disabled={busy} onClick={() => void review("dismiss")}>Dismiss proposal</button></div></> : <><p>Follow up on <time dateTime={draft.followUpDate ?? undefined}>{draft.followUpDate}</time>. A date alone never records a payment or sends a message.</p><button className="secondary-button" disabled={busy} onClick={() => void review("dismiss")}>Dismiss proposal</button></>}
    </div>}
    {error && <p role="alert" className="error-message">{error}</p>}
  </section>;
}
