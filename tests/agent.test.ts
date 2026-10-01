import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createTools, toToolError, ToolRequestError, type RetrievedEmail } from "../src/lib/agent/tools";
import { demoSeed } from "../src/lib/demo-data";
import type { DemoSeed, Email } from "../src/lib/contracts";
import { createStore } from "../src/lib/store";
import { createTestStore } from "./helpers";

const stores: ReturnType<typeof createTestStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function toolsFor(invoiceId = "INV-101", seed: DemoSeed = demoSeed) {
  const store = createTestStore(seed);
  stores.push(store);
  return { store, tools: createTools(store, invoiceId) };
}
function email(id: string, body: string, sentAt = "2026-10-01T12:00:00Z", subject = "Payment update"): Email {
  return { id, customerId: "CUSTOMER-ACME", threadId: "THREAD-CUSTOM", from: "ap@acme.example",
    to: "billing@studio.example", subject, body, sentAt };
}
function seedWith(emails: Email[]): DemoSeed { return { ...demoSeed, emails }; }
function messages(result: unknown): { emails: RetrievedEmail[]; truncated: boolean } {
  return result as { emails: RetrievedEmail[]; truncated: boolean };
}

// These cases catch cross-customer reads, arbitrary model IDs, and unsafe error disclosure.
describe("scoped investigation tools", () => {
  it("returns assigned invoice facts, customer contact, and demo date only", () => {
    const { store, tools } = toolsFor();
    expect(tools.dispatch("get_invoice", {})).toEqual({
      invoice: store.getInvoice("INV-101"), customer: { id: "CUSTOMER-ACME", name: "Acme", email: "ap@acme.example" }, demoDate: "2026-10-01",
    });
  });
  it("rejects a thread belonging to another customer", () => {
    const { tools } = toolsFor();
    expect(() => tools.dispatch("get_email_thread", { threadId: "THREAD-OTHER-CUSTOMER" })).toThrow("OUT_OF_SCOPE");
    expect(tools.getRetrievedEmails()).toEqual([]);
  });
  it("does not disclose whether an inaccessible thread exists", () => {
    const { tools } = toolsFor();
    for (const threadId of ["THREAD-OTHER-CUSTOMER", "missing-thread"]) {
      expect(() => tools.dispatch("get_email_thread", { threadId })).toThrow("OUT_OF_SCOPE");
      try { tools.dispatch("get_email_thread", { threadId }); }
      catch (error) { expect(toToolError(error)).toEqual({ error: { code: "OUT_OF_SCOPE", message: "Thread is unavailable in the assigned customer scope." } }); }
    }
  });
  it.each(["unknown", "__proto__", "constructor", "send_email"])("rejects unknown tool %s", name => {
    const { tools } = toolsFor();
    expect(() => tools.dispatch(name, {})).toThrow("UNKNOWN_TOOL");
  });
  it.each([
    ["get_invoice", { invoiceId: "INV-102" }], ["get_payments", { invoiceId: "INV-112" }],
    ["get_action_history", { invoiceId: "INV-102" }],
    ["search_emails", { query: "invoice", customerId: "CUSTOMER-BIRCH" }],
    ["get_email_thread", { threadId: "THREAD-101", customerId: "CUSTOMER-BIRCH" }],
    ["get_invoice", null], ["get_email_thread", { threadId: "" }], ["search_emails", { query: 1 }],
  ])("rejects invalid arguments for %s", (name, args) => {
    const { tools } = toolsFor();
    expect(() => tools.dispatch(name, args)).toThrow("INVALID_ARGUMENTS");
  });
  it.each(["", "   ", "x".repeat(201)])("rejects an empty or oversized query", query => {
    const { tools } = toolsFor();
    expect(() => tools.dispatch("search_emails", { query })).toThrow("INVALID_ARGUMENTS");
  });
  it("binds payments and action history to the assigned invoice", () => {
    const db = new Database(":memory:");
    const store = createStore(db);
    stores.push(store);
    store.seed(demoSeed);
    const proposal = { blocker: "unknown", explanation: "Check status", evidence: [], action: { kind: "none", recipient: null, subject: null, body: null, task: null, followUpDate: null } };
    const insert = db.prepare("INSERT INTO actions (id, invoice_id, generation_id, context_version, version, proposal, status) VALUES (?, ?, ?, 1, 1, ?, 'pending')");
    insert.run("ACTION-111", "INV-111", "generation", JSON.stringify(proposal));
    insert.run("ACTION-112", "INV-112", "generation", JSON.stringify(proposal));
    const tools = createTools(store, "INV-111");
    expect(tools.dispatch("get_payments", {})).toEqual([demoSeed.payments[0]]);
    expect(tools.dispatch("get_action_history", {})).toEqual([{ id: "ACTION-111", invoiceId: "INV-111", generationId: "generation", contextVersion: 1, version: 1, proposal, status: "pending" }]);
  });
  it("publishes only strict read-only definitions accepted by the dispatcher", () => {
    const { tools } = toolsFor();
    expect(tools.definitions.map(tool => tool.name).sort()).toEqual(["get_action_history", "get_email_thread", "get_invoice", "get_payments", "search_emails"]);
    for (const definition of tools.definitions) {
      expect(definition.strict).toBe(true);
      expect(definition.type).toBe("function");
      expect(definition.parameters.additionalProperties).toBe(false);
      expect(definition.parameters).not.toHaveProperty("properties.customerId");
      expect(definition.parameters).not.toHaveProperty("properties.invoiceId");
    }
  });
  it("sanitizes database failures and preserves typed tool errors", () => {
    expect(toToolError(new Error("SQLITE_ERROR: secret path /db/customer.sqlite"))).toEqual({ error: { code: "TOOL_FAILED", message: "The read tool could not complete." } });
    const error = new ToolRequestError("INVALID_ARGUMENTS", "Invalid tool arguments.");
    expect(toToolError(error)).toEqual({ error: { code: "INVALID_ARGUMENTS", message: "Invalid tool arguments." } });
  });
  it("rejects an unavailable assigned invoice", () => {
    const store = createTestStore();
    stores.push(store);
    expect(() => createTools(store, "missing")).toThrow("INVOICE_NOT_FOUND");
  });
});

// These cases catch substring invoice confusion, omitted replies, wildcard expansion, and overbroad retrieval.
describe("email retrieval", () => {
  it("ranks the exact invoice ahead of a newer similar invoice number", () => {
    const { tools } = toolsFor("INV-110");
    const result = messages(tools.dispatch("search_emails", { query: "INV-110" }));
    expect(result.emails.map(item => item.id)).toEqual(["EMAIL-110-1", "EMAIL-1100-1"]);
    expect(result.truncated).toBe(false);
  });
  it("searches normalized subject and body within the assigned customer", () => {
    const seed = seedWith([
      email("body", "  Payment\n  STATUS confirmed", "2026-09-29T12:00:00Z"),
      email("subject", "Confirmed", "2026-09-30T12:00:00Z", "PAYMENT\tSTATUS"),
      { ...email("foreign", "payment status"), customerId: "CUSTOMER-BIRCH" },
    ]);
    const { tools } = toolsFor("INV-101", seed);
    expect(messages(tools.dispatch("search_emails", { query: " PaYment   STATUS " })).emails.map(item => item.id)).toEqual(["subject", "body"]);
  });
  it("keeps relevant replies that omit the invoice number", () => {
    const { tools } = toolsFor("INV-101", seedWith([email("reply", "We still need the PO before payment can proceed.")]));
    expect(messages(tools.dispatch("search_emails", { query: "PO" })).emails.map(item => item.id)).toEqual(["reply"]);
  });
  it.each(["%", "_", "\\", "' OR 1=1 --"])("treats %s as literal search text", query => {
    const { tools } = toolsFor("INV-101", seedWith([email("literal", `The literal ${query} appears here.`), email("unrelated", "Ordinary message")]));
    expect(messages(tools.dispatch("search_emails", { query })).emails.map(item => item.id)).toEqual(["literal"]);
  });
  it("returns an empty search without adding citation evidence", () => {
    const { tools } = toolsFor();
    expect(tools.dispatch("search_emails", { query: "nothing matches this phrase" })).toEqual({ emails: [], truncated: false });
    expect(tools.getRetrievedEmails()).toEqual([]);
  });
  it("caps searches at ten messages after ranking assigned invoice evidence", () => {
    const seed = seedWith([
      email("exact", "Payment for INV-101", "2026-09-01T12:00:00Z"),
      ...Array.from({ length: 12 }, (_, index) => email(`reply-${index}`, "Payment pending", `2026-09-${String(index + 10).padStart(2, "0")}T12:00:00Z`)),
    ]);
    const { tools } = toolsFor("INV-101", seed);
    const result = messages(tools.dispatch("search_emails", { query: "payment" }));
    expect(result.emails).toHaveLength(10);
    expect(result.emails[0].id).toBe("exact");
    expect(result.emails[1].id).toBe("reply-11");
    expect(result.truncated).toBe(true);
    expect(tools.getRetrievedEmails()).toHaveLength(10);
  });
  it("returns the newest twenty thread messages with an explicit truncation flag", () => {
    const seed = seedWith(Array.from({ length: 22 }, (_, index) => email(`email-${index}`, "Pending", `2026-09-${String(index + 1).padStart(2, "0")}T12:00:00Z`)));
    const { tools } = toolsFor("INV-101", seed);
    const result = messages(tools.dispatch("get_email_thread", { threadId: "THREAD-CUSTOM" }));
    expect(result.emails).toHaveLength(20);
    expect(result.emails[0].id).toBe("email-21");
    expect(result.emails[19].id).toBe("email-2");
    expect(result.truncated).toBe(true);
    expect(tools.getRetrievedEmails().some(item => item.id === "email-0")).toBe(false);
  });
  it("orders thread messages by instant when timestamps have fractional seconds", () => {
    const { tools } = toolsFor("INV-101", seedWith([
      email("older", "Pending", "2026-10-01T12:00:00Z"),
      email("newer", "Pending", "2026-10-01T12:00:00.500Z"),
    ]));
    expect(messages(tools.dispatch("get_email_thread", { threadId: "THREAD-CUSTOM" })).emails.map(item => item.id)).toEqual(["newer", "older"]);
  });
  it("records only actual delivered text and body truncation for citations", () => {
    const body = "x".repeat(8_000) + "SECRET-TAIL";
    const { tools } = toolsFor("INV-101", seedWith([email("long", body, undefined, "Invoice INV-101")]));
    const result = messages(tools.dispatch("search_emails", { query: "INV-101" }));
    expect(result.emails[0].body).toBe("x".repeat(8_000));
    expect(result.emails[0].bodyTruncated).toBe(true);
    expect(tools.getRetrievedEmails()).toEqual(result.emails);
    expect(JSON.stringify(tools.getRetrievedEmails())).not.toContain("SECRET-TAIL");
    result.emails[0].body = "tampered";
    const registry = tools.getRetrievedEmails();
    expect(registry[0].body).toBe("x".repeat(8_000));
    registry[0].body = "also tampered";
    expect(tools.getRetrievedEmails()[0].body).toBe("x".repeat(8_000));
  });
  it("keeps registries isolated and retains every successful delivery", () => {
    const { store, tools } = toolsFor();
    const separateRun = createTools(store, "INV-101");
    tools.dispatch("search_emails", { query: "PO number" });
    tools.dispatch("get_email_thread", { threadId: "THREAD-101" });
    expect(tools.getRetrievedEmails().map(item => item.id)).toEqual(["EMAIL-101-1", "EMAIL-PROMPT-101", "EMAIL-101-2", "EMAIL-101-1"]);
    expect(separateRun.getRetrievedEmails()).toEqual([]);
    expect(tools.getRetrievedEmails().every(item => item.customerId === "CUSTOMER-ACME")).toBe(true);
  });
  it("leaves all database rows and context versions unchanged", () => {
    const db = new Database(":memory:");
    const store = createStore(db);
    stores.push(store);
    store.seed(demoSeed);
    const before = store.snapshot();
    const changes = db.prepare("SELECT total_changes() AS count").get();
    const tools = createTools(store, "INV-101");
    for (const [name, args] of [["get_invoice", {}], ["get_payments", {}], ["get_action_history", {}], ["search_emails", { query: "invoice" }], ["get_email_thread", { threadId: "THREAD-101" }]] as const) tools.dispatch(name, args);
    expect(store.snapshot()).toEqual(before);
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
  });
});


// These cases catch fabricated citations, unsafe actions, unbounded runs, and stale persistence.
vi.mock("server-only", () => ({}));
import { vi } from "vitest";
import { createScriptedTransport, createLiveTransport, type ModelTransport } from "../src/lib/agent/model";
import { investigateInvoice } from "../src/lib/agent/run";
import { poProposal, poSteps } from "./fixtures/model";

function runnerStore(seed: DemoSeed = demoSeed) {
  const store = createTestStore(seed);
  stores.push(store);
  return store;
}
describe("bounded investigation", () => {
  it("reads conversation before returning a validated proposal without executing an action", async () => {
    const store = runnerStore();
    expect(await investigateInvoice(store, "INV-101", createScriptedTransport(poSteps()))).toEqual(poProposal);
    expect(store.snapshot().actions).toEqual([]);
    expect(store.snapshot().outbox).toEqual([]);
  });
  it.each([
    ["invented ID", [{ emailId: "NONEXISTENT", quote: "Please add a PO." }]],
    ["paraphrased quote", [{ emailId: "EMAIL-101-1", quote: "We require a purchase order." }]],
    ["missing citation", []],
  ])("rejects %s evidence", async (_name, evidence) => {
    const store = runnerStore();
    await expect(investigateInvoice(store, "INV-101", createScriptedTransport(poSteps({ ...poProposal, evidence })))).rejects.toThrow("INVALID_EVIDENCE");
    expect(store.snapshot().actions).toEqual([]);
  });
  it("rejects real but undelivered and truncated evidence", async () => {
    const store = runnerStore(seedWith([email("LONG", "INV-101 " + "x".repeat(8000) + "SECRET TAIL")]));
    const proposal = { ...poProposal, evidence: [{ emailId: "LONG", quote: "SECRET TAIL" }] };
    await expect(investigateInvoice(store, "INV-101", createScriptedTransport([{ kind: "result", proposal }]))).rejects.toThrow("INVALID_EVIDENCE");
    await expect(investigateInvoice(store, "INV-101", createScriptedTransport([
      { kind: "tools", calls: [{ id: "s", name: "search_emails", args: { query: "INV-101" } }] }, { kind: "result", proposal },
    ]))).rejects.toThrow("INVALID_EVIDENCE");
  });
  it("accepts an exact subject quote delivered by a read tool", async () => {
    const proposal = { ...poProposal, evidence: [{ emailId: "EMAIL-101-1", quote: "Invoice INV-101" }] };
    expect((await investigateInvoice(runnerStore(), "INV-101", createScriptedTransport(poSteps(proposal)))).evidence).toEqual(proposal.evidence);
  });
  it("accepts a future promise as waiting without recording payment", async () => {
    const store = runnerStore();
    const proposal = { blocker: "promised_payment", explanation: "Payment is promised for October 5 but not recorded.", evidence: [{ emailId: "EMAIL-105-1", quote: "INV-105 will be included in the October 5 payment run." }], action: { kind: "wait", recipient: null, subject: null, body: null, task: null, followUpDate: "2026-10-05" } };
    expect(await investigateInvoice(store, "INV-105", createScriptedTransport([
      { kind: "tools", calls: [{ id: "s", name: "get_email_thread", args: { threadId: "THREAD-105" } }] }, { kind: "result", proposal },
    ]))).toEqual(proposal);
    expect(store.getPayments("INV-105")).toEqual([]);
  });
  it("skips the transport for a fully paid invoice", async () => {
    const proposal = await investigateInvoice(runnerStore(), "INV-112", async () => { throw new Error("Transport must not run"); });
    expect(proposal.blocker).toBe("none");
    expect(proposal.action.kind).toBe("none");
  });
  it.each([
    { ...poProposal.action, kind: "send_email", recipient: "external@untrusted.example", subject: "PO", body: "Please provide it", task: null },
    { ...poProposal.action, kind: "send_email", recipient: "ap@acme.example", subject: " ", body: "Please provide it", task: null },
    { ...poProposal.action, body: "Unexpected email body" },
    { ...poProposal.action, task: " " },
    { ...poProposal.action, kind: "wait", task: null, followUpDate: "2026-10-01" },
    { ...poProposal.action, kind: "wait", task: null, followUpDate: "2026-02-30" },
    { ...poProposal.action, kind: "none" },
    { ...poProposal.action, kind: "execute_payment" },
  ])("rejects unsafe or malformed actions %#", async action => {
    await expect(investigateInvoice(runnerStore(), "INV-101", createScriptedTransport(poSteps({ ...poProposal, action })))).rejects.toThrow("INVALID_PROPOSAL");
  });
  it("accepts an email to the scoped customer", async () => {
    const action = { kind: "send_email", recipient: "ap@acme.example", subject: "PO for INV-101", body: "Please supply the PO number.", task: null, followUpDate: null };
    expect((await investigateInvoice(runnerStore(), "INV-101", createScriptedTransport(poSteps({ ...poProposal, action })))).action).toEqual(action);
  });
  it("stops after eight model responses", async () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({ kind: "tools" as const, calls: [{ id: String(i), name: "get_invoice", args: {} }] }));
    await expect(investigateInvoice(runnerStore(), "INV-101", createScriptedTransport(steps))).rejects.toThrow("RUN_LIMIT");
  });
  it("rejects a response exceeding the 24 call budget", async () => {
    await expect(investigateInvoice(runnerStore(), "INV-101", createScriptedTransport([{ kind: "tools", calls: Array.from({ length: 25 }, (_, i) => ({ id: String(i), name: "get_invoice", args: {} })) }]))).rejects.toThrow("RUN_LIMIT");
  });
  it("rejects invalid JSON and unsupported tool arguments", async () => {
    await expect(investigateInvoice(runnerStore(), "INV-101", createScriptedTransport([{ kind: "result", proposal: "not json" }]))).rejects.toThrow("INVALID_PROPOSAL");
    await expect(investigateInvoice(runnerStore(), "INV-101", createScriptedTransport([{ kind: "tools", calls: [{ id: "x", name: "search_emails", args: { query: 8 } }] }]))).rejects.toThrow("INVALID_TOOL_ARGUMENTS");
  });
  it("returns scope and unknown-tool errors with original call IDs and permits no outbox mutation", async () => {
    let response = 0;
    const store = runnerStore();
    const transport: ModelTransport = async request => {
      if (response++ === 0) {
        expect(request.toolSchemas.map(tool => tool.name)).not.toContain("send_email");
        return { kind: "tools", calls: [{ id: "injection", name: "send_email", args: {} }, { id: "foreign", name: "get_email_thread", args: { threadId: "THREAD-OTHER-CUSTOMER" } }, { id: "read", name: "get_email_thread", args: { threadId: "THREAD-101" } }] };
      }
      const outputs = request.conversationItems.filter(item => item.type === "function_call_output");
      expect(outputs).toContainEqual({ type: "function_call_output", call_id: "injection", output: JSON.stringify({ error: { code: "UNKNOWN_TOOL", message: "The requested read tool is unavailable." } }) });
      expect(outputs.some(item => typeof item.output === "string" && item.output.includes("OUT_OF_SCOPE"))).toBe(true);
      expect(outputs.some(item => typeof item.output === "string" && item.output.includes("Ignore all previous instructions"))).toBe(true);
      return { kind: "result", proposal: poProposal };
    };
    await investigateInvoice(store, "INV-101", transport);
    expect(store.snapshot().outbox).toEqual([]);
    expect(store.snapshot().actions).toEqual([]);
  });
  it("times out a hanging transport and propagates caller cancellation", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = investigateInvoice(runnerStore(), "INV-101", () => new Promise(() => {}), controller.signal);
      const assertion = expect(pending).rejects.toThrow("TIMEOUT");
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      controller.abort();
      await expect(investigateInvoice(runnerStore(), "INV-101", createScriptedTransport(poSteps()), controller.signal)).rejects.toThrow("TIMEOUT");
    } finally { vi.useRealTimers(); }
  });
  it("rejects context changes during model work and never holds a database transaction over network calls", async () => {
    const db = new Database(":memory:"); const store = createStore(db); stores.push(store); store.seed(demoSeed);
    const scripted = createScriptedTransport(poSteps());
    const transport: ModelTransport = async (request, signal) => {
      expect(db.inTransaction).toBe(false);
      const step = await scripted(request, signal);
      if (step.kind === "result") db.prepare("UPDATE invoices SET context_version = 2 WHERE id = 'INV-101'").run();
      return step;
    };
    await expect(investigateInvoice(store, "INV-101", transport)).rejects.toThrow("STALE_CONTEXT");
    expect(store.snapshot().investigations).toEqual([]);
  });
  it("requires configuration in live mode without fixture fallback", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    try { expect(() => createLiveTransport()).toThrow("MODEL_NOT_CONFIGURED"); }
    finally { vi.unstubAllEnvs(); }
  });
});

describe("investigation persistence", () => {
  it("saves one pending action per unchanged context and none for a paid invoice", async () => {
    const store = runnerStore(); const generation = store.snapshot().generationId;
    const proposal = await investigateInvoice(store, "INV-101", createScriptedTransport(poSteps()));
    const first = store.saveInvestigation("INV-101", generation, 1, proposal);
    expect(first).toMatchObject({ invoiceId: "INV-101", generationId: generation, contextVersion: 1, version: 1, status: "pending", proposal });
    expect(store.saveInvestigation("INV-101", generation, 1, proposal)).toEqual(first);
    expect(store.snapshot().investigations).toHaveLength(1);
    expect(store.snapshot().actions).toHaveLength(1);
    expect(store.snapshot().outbox).toEqual([]);
    const paid = await investigateInvoice(store, "INV-112", createScriptedTransport([]));
    expect(store.saveInvestigation("INV-112", generation, 1, paid)).toBeNull();
  });
  it("rejects a stale generation or invoice context atomically", () => {
    const store = runnerStore();
    expect(() => store.saveInvestigation("INV-101", "stale", 1, poProposal)).toThrow("STALE_CONTEXT");
    expect(() => store.saveInvestigation("INV-101", store.snapshot().generationId, 2, poProposal)).toThrow("STALE_CONTEXT");
    expect(store.snapshot().actions).toEqual([]);
    expect(store.snapshot().investigations).toEqual([]);
  });
});
