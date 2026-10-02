import type { RefObject } from "react";
import type { InvoiceSummary, ReviewCommand, WorkspaceSnapshot } from "@/lib/contracts";
import ActionReview from "./action-review";
import { money } from "./invoice-list";

export default function InvoiceDetail({ invoice, snapshot, busy, error, onInvestigate, onReview, headingRef }: { invoice: InvoiceSummary; snapshot: WorkspaceSnapshot; busy: boolean; error: string; onInvestigate: () => void; onReview: (id: string, command: ReviewCommand) => Promise<void>; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const investigation = snapshot.investigations.filter(item => item.invoiceId === invoice.id).at(-1);
  const actions = snapshot.actions.filter(action => action.invoiceId === invoice.id);
  const action = actions.find(item => item.contextVersion === invoice.contextVersion);
  const proposal = investigation?.proposal;
  const outbox = snapshot.outbox.filter(entry => actions.some(item => item.id === entry.actionId));
  return <section className="invoice-surface detail-surface" aria-labelledby="invoice-detail-title">
    <div className="detail-header"><p className="eyebrow">{invoice.customerName} / invoice detail</p><h2 id="invoice-detail-title" tabIndex={-1} ref={headingRef}>{invoice.number}</h2><p className="detail-balance">{money.format(invoice.remainingCents / 100)} <span className="currency-label">CAD remaining</span></p>
      <dl className="invoice-facts"><div><dt>Original amount</dt><dd>{money.format(invoice.amountCents / 100)} CAD</dd></div><div><dt>Due date</dt><dd>{invoice.dueDate}</dd></div><div><dt>Payment status</dt><dd>{invoice.paymentStatus === "paid" ? "Paid" : invoice.paymentStatus === "partial" ? "Partially paid" : "Unpaid"}</dd></div><div><dt>Overdue</dt><dd>{invoice.paymentStatus === "paid" ? "-" : `${invoice.overdueDays} days`}</dd></div></dl>
      <button className="primary-button" disabled={busy || !snapshot.agentReady || invoice.remainingCents === 0} onClick={onInvestigate}>{busy ? "Investigating..." : "Investigate invoice"}</button>
      {busy && <p role="status" className="muted">Reading invoice records and source conversations...</p>}{error && <p role="alert" className="error-message">{error}</p>}
      {invoice.remainingCents === 0 && <p className="muted">Recorded payments cover this invoice. Investigation is unnecessary.</p>}
    </div>
    {proposal ? <div className="detail-section"><p className="eyebrow">Investigation finding</p><h3>{proposal.blocker.replaceAll("_", " ")}</h3><p className="break-words">{proposal.explanation}</p>
      {action?.status === "superseded" && <p className="muted">Business data changed. Investigate again to review a current next step.</p>}
      <div className="grid gap-3">{proposal.evidence.map((citation, index) => {
        const email = snapshot.emails.find(item => item.id === citation.emailId);
        return email && <details className="evidence" key={`${citation.emailId}-${index}`}><summary>Source email: {email.subject}</summary><p className="muted break-words">From {email.from} to {email.to}<br /><time dateTime={email.sentAt}>{new Date(email.sentAt).toLocaleString("en-CA", { timeZone: "America/Toronto" })} (Toronto)</time></p><blockquote className="citation">{citation.quote}</blockquote><p className="eyebrow">Full source text</p><p className="whitespace-pre-wrap break-words">{email.body}</p></details>;
      })}</div>
      {action && <ActionReview key={action.id} action={action} onReview={onReview} />}
    </div> : <div className="detail-section"><h3>Find the next step</h3><p className="muted">Investigate this invoice to explain its blocker, inspect the source evidence, and prepare an action for your review.</p></div>}
    <section className="detail-section" aria-label="Simulated outbox"><h3>Simulated outbox</h3><p className="muted">Approved messages recorded locally. No external sending.</p>{outbox.length === 0 ? <p className="muted">No approved emails for this invoice.</p> : outbox.map(entry => <article className="outbox-entry" key={entry.id}><p className="break-words">To {entry.recipient}</p><h4>{entry.subject}</h4><p className="whitespace-pre-wrap break-words">{entry.body}</p><p className="muted">Approved {new Date(entry.recordedAt).toLocaleString("en-CA", { timeZone: "America/Toronto" })}</p></article>)}</section>
    <section className="detail-section" aria-label="Invoice history"><h3>Activity & action history</h3>{actions.map(item => <p className="muted" key={item.id}>{item.proposal.action.kind.replaceAll("_", " ")} / {item.status} / version {item.version}</p>)}<ol className="activity-list">{snapshot.activity.filter(item => item.invoiceId === invoice.id).map(item => <li key={item.id}><p>{item.description}</p><time className="muted" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("en-CA", { timeZone: "America/Toronto" })}</time></li>)}</ol></section>
  </section>;
}
