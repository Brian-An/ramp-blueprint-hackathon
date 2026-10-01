import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { overdueDays, remainingCents } from "./accounting";
import { RunError } from "./agent/errors";
import { validateProposalAction } from "./agent/run";
import { INITIAL_DEMO_DATE } from "./demo-data";
import {
  actionSchema, activitySchema, customerSchema, demoSeedSchema, emailSchema,
  invoiceSchema, investigationSummarySchema, outboxEntrySchema, paymentSchema,
  proposalSchema, settingsSchema, workspaceSnapshotSchema,
  type Action, type Customer, type DemoSeed, type Email, type Invoice, type Payment, type Proposal, type WorkspaceSnapshot,
} from "./contracts";

const invoiceColumns = `id, customer_id AS customerId, number, amount_cents AS amountCents,
  currency, issued_date AS issuedDate, due_date AS dueDate, context_version AS contextVersion`;
const emailColumns = `id, customer_id AS customerId, thread_id AS threadId, sender AS "from",
  recipient AS "to", subject, body, sent_at AS sentAt`;
const paymentColumns = `id, event_id AS eventId, invoice_id AS invoiceId, amount_cents AS amountCents,
  received_date AS receivedDate`;
const persistedProposalSchema = z.string().transform(value => proposalSchema.parse(JSON.parse(value) as unknown));

export function createStore(db: Database.Database) {
  db.function("normalized_email_text", { deterministic: true }, (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim());
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), number TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0), currency TEXT NOT NULL CHECK(currency = 'CAD'),
      issued_date TEXT NOT NULL, due_date TEXT NOT NULL, context_version INTEGER NOT NULL CHECK(context_version > 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), thread_id TEXT NOT NULL,
      sender TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, sent_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, invoice_id TEXT NOT NULL REFERENCES invoices(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), received_date TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS investigations (
      id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), generation_id TEXT NOT NULL,
      context_version INTEGER NOT NULL CHECK(context_version > 0), proposal TEXT NOT NULL CHECK(json_valid(proposal)),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), generation_id TEXT NOT NULL,
      context_version INTEGER NOT NULL CHECK(context_version > 0), version INTEGER NOT NULL CHECK(version > 0),
      proposal TEXT NOT NULL CHECK(json_valid(proposal)),
      status TEXT NOT NULL CHECK(status IN ('pending','accepted','executed','completed','dismissed','superseded'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), recipient TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, recorded_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY, invoice_id TEXT REFERENCES invoices(id), kind TEXT NOT NULL,
      description TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK(id = 1), generation_id TEXT NOT NULL, demo_date TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS invoices_by_customer ON invoices(customer_id);
    CREATE INDEX IF NOT EXISTS emails_by_customer_thread ON emails(customer_id, thread_id, sent_at);
    CREATE INDEX IF NOT EXISTS payments_by_invoice ON payments(invoice_id);
    CREATE INDEX IF NOT EXISTS actions_by_invoice_status ON actions(invoice_id, status, version);
    CREATE INDEX IF NOT EXISTS activity_by_invoice ON activity(invoice_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS one_investigation_per_context ON investigations(invoice_id, context_version);
    CREATE UNIQUE INDEX IF NOT EXISTS one_outbox_entry_per_action ON outbox(action_id);
    CREATE UNIQUE INDEX IF NOT EXISTS one_payment_per_event ON payments(event_id);
  `);

  function seed(input: DemoSeed): void {
    const seedData = demoSeedSchema.parse(input);
    // The singleton settings record is committed atomically with the initial dataset.
    db.transaction(() => {
      if (db.prepare("SELECT id FROM settings WHERE id = 1").get()) return;
      const customerInsert = db.prepare("INSERT INTO customers (id, name, email) VALUES (?, ?, ?)");
      for (const customer of seedData.customers) customerInsert.run(customer.id, customer.name, customer.email);
      const invoiceInsert = db.prepare("INSERT INTO invoices (id, customer_id, number, amount_cents, currency, issued_date, due_date, context_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const invoice of seedData.invoices) invoiceInsert.run(invoice.id, invoice.customerId, invoice.number, invoice.amountCents, invoice.currency, invoice.issuedDate, invoice.dueDate, invoice.contextVersion);
      const emailInsert = db.prepare("INSERT INTO emails (id, customer_id, thread_id, sender, recipient, subject, body, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const email of seedData.emails) emailInsert.run(email.id, email.customerId, email.threadId, email.from, email.to, email.subject, email.body, email.sentAt);
      const paymentInsert = db.prepare("INSERT INTO payments (id, event_id, invoice_id, amount_cents, received_date) VALUES (?, ?, ?, ?, ?)");
      for (const payment of seedData.payments) paymentInsert.run(payment.id, payment.eventId, payment.invoiceId, payment.amountCents, payment.receivedDate);
      db.prepare("INSERT INTO settings (id, generation_id, demo_date) VALUES (1, ?, ?)").run(randomUUID(), INITIAL_DEMO_DATE);
    }).immediate();
  }

  function getInvoice(id: string): Invoice | undefined {
    const row = db.prepare(`SELECT ${invoiceColumns} FROM invoices WHERE id = ?`).get(id);
    return row === undefined ? undefined : invoiceSchema.parse(row);
  }

  function getCustomer(id: string): Customer | undefined {
    const row = db.prepare("SELECT id, name, email FROM customers WHERE id = ?").get(id);
    return row === undefined ? undefined : customerSchema.parse(row);
  }

  function getPayments(invoiceId: string): Payment[] {
    return z.array(paymentSchema).parse(db.prepare(`SELECT ${paymentColumns} FROM payments WHERE invoice_id = ? ORDER BY received_date, id`).all(invoiceId));
  }

  function searchEmails(customerId: string, query: string): Email[] {
    const normalized = query.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    const literal = `%${normalized.replace(/[\\%_]/g, "\\$&")}%`;
    return z.array(emailSchema).parse(db.prepare(`SELECT ${emailColumns} FROM emails
      WHERE customer_id = ? AND (normalized_email_text(subject) LIKE ? ESCAPE '\\'
        OR normalized_email_text(body) LIKE ? ESCAPE '\\')
      ORDER BY sent_at DESC, id`).all(customerId, literal, literal));
  }

  function getThread(customerId: string, threadId: string): Email[] {
    return z.array(emailSchema).parse(db.prepare(`SELECT ${emailColumns} FROM emails
      WHERE customer_id = ? AND thread_id = ? ORDER BY julianday(sent_at) DESC, id`).all(customerId, threadId));
  }

  function getActionHistory(invoiceId: string): Action[] {
    return z.array(actionSchema.extend({ proposal: persistedProposalSchema })).parse(db.prepare(`SELECT
      id, invoice_id AS invoiceId, generation_id AS generationId, context_version AS contextVersion,
      version, proposal, status FROM actions WHERE invoice_id = ? ORDER BY rowid`).all(invoiceId));
  }

  function getSettings() {
    return settingsSchema.parse(db.prepare("SELECT generation_id AS generationId, demo_date AS demoDate FROM settings WHERE id = 1").get());
  }

  function getInvestigation(invoiceId: string, generationId: string, contextVersion: number): { proposal: Proposal; action: Action | null } | undefined {
    const row = db.prepare("SELECT proposal FROM investigations WHERE invoice_id = ? AND generation_id = ? AND context_version = ?").get(invoiceId, generationId, contextVersion);
    if (!row) return undefined;
    const { proposal } = z.object({ proposal: persistedProposalSchema }).parse(row);
    const action = getActionHistory(invoiceId).find(action => action.generationId === generationId && action.contextVersion === contextVersion) ?? null;
    return { proposal, action };
  }

  function saveInvestigation(invoiceId: string, generationId: string, contextVersion: number, input: Proposal): Action | null {
    const proposal = proposalSchema.parse(input);
    return db.transaction(() => {
      const settings = getSettings();
      const invoice = getInvoice(invoiceId);
      if (!invoice) throw new RunError("INVOICE_NOT_FOUND");
      if (settings.generationId !== generationId || invoice.contextVersion !== contextVersion) throw new RunError("STALE_CONTEXT");
      const existing = getInvestigation(invoiceId, generationId, contextVersion);
      if (existing) return existing.action;
      validateProposalAction(proposal, getCustomer(invoice.customerId)?.email, settings.demoDate);
      const createdAt = new Date().toISOString();
      const json = JSON.stringify(proposal);
      db.prepare("UPDATE actions SET status = 'superseded', version = version + 1 WHERE invoice_id = ? AND status IN ('pending', 'accepted')").run(invoiceId);
      db.prepare("INSERT INTO investigations (id, invoice_id, generation_id, context_version, proposal, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), invoiceId, generationId, contextVersion, json, createdAt);
      let action: Action | null = null;
      if (proposal.action.kind !== "none") {
        action = { id: randomUUID(), invoiceId, generationId, contextVersion, version: 1, proposal, status: "pending" };
        db.prepare("INSERT INTO actions (id, invoice_id, generation_id, context_version, version, proposal, status) VALUES (?, ?, ?, ?, 1, ?, 'pending')").run(action.id, invoiceId, generationId, contextVersion, json);
      }
      db.prepare("INSERT INTO activity (id, invoice_id, kind, description, created_at) VALUES (?, ?, 'investigation', ?, ?)").run(randomUUID(), invoiceId, proposal.explanation, createdAt);
      return action;
    }).immediate();
  }

  function getDemoDate(): string {
    return settingsSchema.pick({ demoDate: true }).parse(db.prepare("SELECT demo_date AS demoDate FROM settings WHERE id = 1").get()).demoDate;
  }

  function snapshot(): WorkspaceSnapshot {
    const settings = settingsSchema.parse(db.prepare("SELECT generation_id AS generationId, demo_date AS demoDate FROM settings WHERE id = 1").get());
    const invoices = z.array(invoiceSchema).parse(db.prepare(`SELECT ${invoiceColumns} FROM invoices ORDER BY number`).all());
    const customers = z.array(customerSchema).parse(db.prepare("SELECT id, name, email FROM customers").all());
    const customerNames = new Map(customers.map(customer => [customer.id, customer.name]));
    const emails = z.array(emailSchema).parse(db.prepare(`SELECT ${emailColumns} FROM emails ORDER BY sent_at, id`).all());
    const payments = z.array(paymentSchema).parse(db.prepare(`SELECT ${paymentColumns} FROM payments ORDER BY received_date, id`).all());
    const investigations = z.array(investigationSummarySchema.extend({ proposal: persistedProposalSchema })).parse(db.prepare("SELECT invoice_id AS invoiceId, proposal, created_at AS createdAt FROM investigations ORDER BY created_at, id").all());
    const actions = z.array(actionSchema.extend({ proposal: persistedProposalSchema })).parse(db.prepare("SELECT id, invoice_id AS invoiceId, generation_id AS generationId, context_version AS contextVersion, version, proposal, status FROM actions ORDER BY id").all());
    const outbox = z.array(outboxEntrySchema).parse(db.prepare("SELECT id, action_id AS actionId, recipient, subject, body, recorded_at AS recordedAt FROM outbox ORDER BY recorded_at, id").all());
    const activity = z.array(activitySchema).parse(db.prepare("SELECT id, invoice_id AS invoiceId, kind, description, created_at AS createdAt FROM activity ORDER BY created_at, id").all());
    const mode = process.env.AGENT_MODE === "fixture" ? "fixture" : "live";
    return workspaceSnapshotSchema.parse({
      ...settings, mode, agentReady: mode === "fixture" || Boolean(process.env.OPENAI_API_KEY?.trim()),
      invoices: invoices.map(invoice => {
        const balance = remainingCents(invoice, payments);
        return { ...invoice, customerName: customerNames.get(invoice.customerId), remainingCents: balance,
          paymentStatus: balance === 0 ? "paid" : balance === invoice.amountCents ? "unpaid" : "partial",
          overdueDays: overdueDays(invoice.dueDate, settings.demoDate) };
      }),
      emails, payments, investigations, actions, outbox, activity,
    });
  }

  return { seed, snapshot, getInvoice, getCustomer, getPayments, searchEmails, getThread, getActionHistory, getDemoDate, getSettings, getInvestigation, saveInvestigation, close: () => db.close() };
}

export type Store = ReturnType<typeof createStore>;
