"use client";

import { useEffect, useState } from "react";
import { workspaceSnapshotSchema, type WorkspaceSnapshot } from "@/lib/contracts";

const money = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
const statusLabels = { unpaid: "Unpaid", partial: "Partially paid", paid: "Paid" };
type LoadState = { status: "loading" } | { status: "error" } | { status: "ready"; snapshot: WorkspaceSnapshot };

export default function Workspace() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/workspace", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Workspace request failed");
        const payload: unknown = await response.json();
        const snapshot = workspaceSnapshotSchema.parse(payload);
        if (!controller.signal.aborted) setState({ status: "ready", snapshot });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  if (state.status === "loading") return <p className="workspace-message" role="status">Loading invoice workspace...</p>;
  if (state.status === "error") return (
    <div className="workspace-message">
      <p role="alert">The invoice workspace could not be loaded.</p>
      <button className="primary-button" onClick={() => window.location.reload()}>Try again</button>
    </div>
  );
  const { snapshot } = state;
  const outstanding = snapshot.invoices.reduce((total, invoice) => total + invoice.remainingCents, 0);
  const openCount = snapshot.invoices.filter(invoice => invoice.paymentStatus !== "paid").length;
  return (
    <>
      <div className="workspace-meta">
        <span className="tag">Demo data</span>
        <span className="tag">{snapshot.mode === "fixture" ? "Fixture AI" : "Live AI"}</span>
        <span>Demo date <time dateTime={snapshot.demoDate}>{snapshot.demoDate}</time></span>
        <span>{snapshot.agentReady ? "Agent configured" : "API key required"}</span>
      </div>
      <section className="invoice-surface" aria-labelledby="invoice-list-title">
        <div className="list-header">
          <div>
            <p className="eyebrow">Accounts receivable</p>
            <h2 id="invoice-list-title">{money.format(outstanding / 100)} <span className="currency-label">CAD outstanding</span></h2>
            <p className="muted">{openCount} open invoices across six customers</p>
          </div>
          <button className="primary-button" onClick={() => window.location.reload()}>Refresh workspace</button>
        </div>
        <div className="table-scroll" tabIndex={0} aria-label="Invoice list, scroll horizontally on small screens">
          <table>
            <caption className="sr-only">Invoices and balances as of {snapshot.demoDate}</caption>
            <thead><tr><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">Due date</th><th scope="col">Overdue</th><th scope="col" className="numeric">Remaining CAD</th><th scope="col">Payment status</th></tr></thead>
            <tbody>{snapshot.invoices.map(invoice => (
              <tr key={invoice.id}>
                <th scope="row">{invoice.number}<span className="mobile-customer">{invoice.customerName}</span></th>
                <td>{invoice.customerName}</td>
                <td><time dateTime={invoice.dueDate}>{invoice.dueDate}</time></td>
                <td>{invoice.paymentStatus === "paid" ? "-" : `${invoice.overdueDays} days`}</td>
                <td className="numeric">{money.format(invoice.remainingCents / 100)}</td>
                <td><span className="payment-status">{statusLabels[invoice.paymentStatus]}</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <p className="workspace-note">Fictional invoices, emails, and recorded payments. All amounts are in Canadian dollars.</p>
    </>
  );
}
