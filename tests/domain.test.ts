import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { remainingCents, overdueDays } from "../src/lib/accounting";
import { dateOnlySchema, demoSeedSchema, proposalSchema, workspaceSnapshotSchema } from "../src/lib/contracts";
import { demoSeed } from "../src/lib/demo-data";
import { createStore } from "../src/lib/store";
import { createTestStore } from "./helpers";

// These cases catch payment filtering, balance classification, and calendar validation errors.
describe("accounting", () => {
  it("keeps a partially paid invoice open", () => {
    const store = createTestStore();
    try {
      const invoice = store.getInvoice("INV-111")!;
      expect(invoice.amountCents).toBe(600_000);
      expect(remainingCents(invoice, store.getPayments(invoice.id))).toBe(400_000);
      expect(store.snapshot().invoices.find(x => x.id === invoice.id)?.paymentStatus).toBe("partial");
      expect(store.snapshot().invoices.find(x => x.id === "INV-112")?.paymentStatus).toBe("paid");
    } finally { store.close(); }
  });

  it("ignores payments for other invoices and clamps a covered balance to zero", () => {
    const invoice = demoSeed.invoices.find(x => x.id === "INV-111")!;
    expect(remainingCents(invoice, demoSeed.payments)).toBe(400_000);
    expect(remainingCents(invoice, [{ id: "P", eventId: "E", invoiceId: invoice.id, amountCents: 700_000, receivedDate: "2026-10-01" }])).toBe(0);
  });

  it.each([
    ["2026-10-01", "2026-10-01", 0],
    ["2026-09-30", "2026-10-01", 1],
    ["2026-10-05", "2026-10-01", 0],
    ["2026-03-07", "2026-03-09", 2],
    ["2026-10-31", "2026-11-02", 2],
    ["2024-02-28", "2024-03-01", 2],
  ])("counts calendar days from %s to %s", (due, today, days) => {
    expect(overdueDays(due, today)).toBe(days);
  });

  it.each(["2026-02-29", "2026-04-31", "2026-13-01", "2026-01-00", "2026-9-1", "2026-10-01T00:00:00Z"])("rejects invalid date %s", date => {
    expect(dateOnlySchema.safeParse(date).success).toBe(false);
    expect(() => overdueDays(date, "2026-10-01")).toThrow();
  });
});

// These cases catch lost seed records, mislabeled source data, and invalid relation handling.
describe("seed and persistence", () => {
  it("provides twelve invoices with unique record IDs and valid relations", () => {
    expect(demoSeedSchema.safeParse(demoSeed).success).toBe(true);
    expect(demoSeed.invoices).toHaveLength(12);
    const records = [...demoSeed.customers, ...demoSeed.invoices, ...demoSeed.emails, ...demoSeed.payments, ...demoSeed.events];
    expect(new Set(records.map(x => x.id)).size).toBe(records.length);
    const customers = new Set(demoSeed.customers.map(x => x.id));
    const invoices = new Set(demoSeed.invoices.map(x => x.id));
    for (const invoice of demoSeed.invoices) {
      expect(customers.has(invoice.customerId)).toBe(true);
      expect(invoice.issuedDate < invoice.dueDate).toBe(true);
      expect(invoice.contextVersion).toBe(1);
    }
    for (const email of demoSeed.emails) expect(customers.has(email.customerId)).toBe(true);
    for (const payment of demoSeed.payments) expect(invoices.has(payment.invoiceId)).toBe(true);
    expect(demoSeed.emails.some(x => x.threadId === "THREAD-OTHER-CUSTOMER" && x.customerId === "CUSTOMER-BIRCH")).toBe(true);
    expect(demoSeed.events.find(x => x.invoiceId === "INV-101")?.email.body).toContain("4821");
    const source = JSON.stringify({ invoices: demoSeed.invoices, emails: demoSeed.emails, payments: demoSeed.payments });
    expect(source).not.toMatch(/expectedBehavior|expectedBlocker|missing_po|rejected_submission|approval_delay|promised_payment/);
  });

  it("produces a validated snapshot without simulator events or hidden labels", () => {
    const store = createTestStore();
    try {
      const snapshot = store.snapshot();
      expect(workspaceSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot.demoDate).toBe("2026-10-01");
      expect(snapshot.invoices).toHaveLength(12);
      expect(snapshot).not.toHaveProperty("events");
      expect(store.getCustomer("CUSTOMER-ACME")?.email).toBe("ap@acme.example");
      expect(store.getInvoice("unknown")).toBeUndefined();
      expect(store.getCustomer("unknown")).toBeUndefined();
    } finally { store.close(); }
  });

  it("preserves the dataset and history across connection reopen and reseeding", () => {
    const directory = mkdtempSync(join(tmpdir(), "invoice-agent-"));
    const path = join(directory, "demo.sqlite");
    try {
      const firstDb = new Database(path);
      const first = createStore(firstDb);
      first.seed(demoSeed);
      const generationId = first.snapshot().generationId;
      firstDb.prepare("INSERT INTO activity (id, invoice_id, kind, description, created_at) VALUES (?, ?, ?, ?, ?)").run("ACT-TEST", "INV-111", "test", "Persisted history", "2026-10-01T10:00:00Z");
      first.close();
      const second = createStore(new Database(path));
      try {
        second.seed(demoSeed);
        const snapshot = second.snapshot();
        expect(snapshot.generationId).toBe(generationId);
        expect(snapshot.invoices).toHaveLength(12);
        expect(snapshot.payments).toHaveLength(2);
        expect(snapshot.activity).toContainEqual({ id: "ACT-TEST", invoiceId: "INV-111", kind: "test", description: "Persisted history", createdAt: "2026-10-01T10:00:00Z" });
      } finally { second.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rolls back an invalid seed and enforces foreign keys and event uniqueness", () => {
    const db = new Database(":memory:");
    const store = createStore(db);
    try {
      const invalid = structuredClone(demoSeed);
      invalid.invoices[0].customerId = "missing";
      expect(() => store.seed(invalid)).toThrow();
      expect(db.prepare("SELECT count(*) AS count FROM customers").get()).toEqual({ count: 0 });
      store.seed(demoSeed);
      const insert = db.prepare("INSERT INTO payments (id, event_id, invoice_id, amount_cents, received_date) VALUES (?, ?, ?, ?, ?)");
      expect(() => insert.run("P-BAD", "E-BAD", "missing", 100, "2026-10-01")).toThrow();
      expect(() => insert.run("P-DUP", demoSeed.payments[0].eventId, "INV-111", 100, "2026-10-01")).toThrow();
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally { store.close(); }
  });

  it("rejects fractional cents and requires nullable proposal fields", () => {
    const invalid = structuredClone(demoSeed);
    invalid.invoices[0].amountCents = 1.5;
    expect(demoSeedSchema.safeParse(invalid).success).toBe(false);
    expect(proposalSchema.safeParse({ blocker: "none", explanation: "Paid", evidence: [], action: { kind: "none" } }).success).toBe(false);
  });
});
