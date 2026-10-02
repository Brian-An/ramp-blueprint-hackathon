"use client";

import { useEffect, useRef, useState } from "react";
import { workspaceSnapshotSchema, type ReviewCommand, type WorkspaceSnapshot } from "@/lib/contracts";
import InvoiceList, { money } from "./invoice-list";
import InvoiceDetail from "./invoice-detail";

type LoadState = { status: "loading" } | { status: "error" } | { status: "ready"; snapshot: WorkspaceSnapshot };
export async function sendCommand(url: string, command: unknown, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command), signal });
  if (!response.ok) {
    const payload: unknown = await response.json();
    const error = payload as { error?: { message?: string } };
    throw new Error(error.error?.message ?? "The request failed. Try again.");
  }
}
export default function Workspace() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState("INV-101");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  async function refresh(signal?: AbortSignal) {
    const response = await fetch("/api/workspace", { signal, cache: "no-store" });
    if (!response.ok) throw new Error("The workspace could not be loaded.");
    const snapshot = workspaceSnapshotSchema.parse(await response.json() as unknown);
    if (!signal?.aborted) setState({ status: "ready", snapshot });
    return snapshot;
  }
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/workspace", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Workspace failed");
        const snapshot = workspaceSnapshotSchema.parse(await response.json() as unknown);
        if (!controller.signal.aborted) setState({ status: "ready", snapshot });
      } catch { if (!controller.signal.aborted) setState({ status: "error" }); }
    }
    void load();
    return () => controller.abort();
  }, []);
  async function investigate() {
    if (state.status !== "ready") return;
    const invoice = state.snapshot.invoices.find(item => item.id === selectedId)!;
    setBusy(true); setError("");
    try { await sendCommand("/api/investigations", { invoiceId: invoice.id, generationId: state.snapshot.generationId, contextVersion: invoice.contextVersion }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Investigation failed. Try again."); }
    finally { setBusy(false); }
  }
  async function review(id: string, command: ReviewCommand) { await sendCommand(`/api/actions/${id}`, command); await refresh(); }
  if (state.status === "loading") return <p className="workspace-message" role="status">Loading invoice workspace...</p>;
  if (state.status === "error") return <div className="workspace-message"><p role="alert">The invoice workspace could not be loaded.</p><button className="primary-button" onClick={() => window.location.reload()}>Try again</button></div>;
  const { snapshot } = state;
  const invoice = snapshot.invoices.find(item => item.id === selectedId)!;
  const outstanding = snapshot.invoices.reduce((total, item) => total + item.remainingCents, 0);
  return <>
    <div className="workspace-meta"><span className="tag">Demo data</span><span className="tag">{snapshot.mode === "fixture" ? "Fixture AI" : "Live AI"}</span><span>Demo date <time dateTime={snapshot.demoDate}>{snapshot.demoDate}</time></span><span>{snapshot.agentReady ? "Agent configured" : "API key required"}</span></div>
    {!snapshot.agentReady && <p className="workspace-message">Add OPENAI_API_KEY to the server .env.local file and restart to enable Live AI. Invoice browsing and demo controls remain available.</p>}
    <div className="workspace-summary"><div><p className="eyebrow">Outstanding balance</p><h2>{money.format(outstanding / 100)} <span className="currency-label">CAD</span></h2><p className="muted">{snapshot.invoices.filter(item => item.remainingCents > 0).length} open invoices across six customers</p></div><button className="secondary-button" onClick={() => { void refresh().catch(() => setError("Refresh failed. Try again.")); }}>Refresh workspace</button></div>
    <div className="workspace-columns"><InvoiceList invoices={snapshot.invoices} selectedId={selectedId} onSelect={id => { setSelectedId(id); setError(""); headingRef.current?.focus({ preventScroll: true }); if (window.innerWidth < 1024) headingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }} /><InvoiceDetail invoice={invoice} snapshot={snapshot} busy={busy} error={error} onInvestigate={() => void investigate()} onReview={review} headingRef={headingRef} /></div>
    <p className="workspace-note">Fictional invoices, emails, and recorded payments. All amounts are in Canadian dollars.</p>
  </>;
}
