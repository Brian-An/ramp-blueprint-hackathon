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
