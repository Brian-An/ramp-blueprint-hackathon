import { z } from "zod";

const idSchema = z.string().min(1);
const centsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, "Expected a valid calendar date");
export const customerSchema = z.strictObject({ id: idSchema, name: z.string().min(1), email: z.email() });
export const invoiceSchema = z.strictObject({
  id: idSchema, customerId: idSchema, number: z.string().min(1), amountCents: centsSchema,
  currency: z.literal("CAD"), issuedDate: dateOnlySchema, dueDate: dateOnlySchema,
  contextVersion: z.number().int().positive(),
});
export const emailSchema = z.strictObject({
  id: idSchema, customerId: idSchema, threadId: idSchema, from: z.email(), to: z.email(),
  subject: z.string(), body: z.string(), sentAt: z.iso.datetime(),
});
export const paymentSchema = z.strictObject({
  id: idSchema, eventId: idSchema, invoiceId: idSchema,
  amountCents: centsSchema.refine(value => value > 0), receivedDate: dateOnlySchema,
});
export const proposalSchema = z.strictObject({
  blocker: z.enum(["missing_po", "rejected_submission", "approval_delay", "dispute", "promised_payment", "unknown", "none"]),
  explanation: z.string().min(1),
  evidence: z.array(z.strictObject({ emailId: idSchema, quote: z.string().min(1) })),
  action: z.strictObject({
    kind: z.enum(["send_email", "owner_task", "wait", "none"]),
    recipient: z.email().nullable(), subject: z.string().nullable(), body: z.string().nullable(),
    task: z.string().nullable(), followUpDate: dateOnlySchema.nullable(),
  }),
});
export const actionStatusSchema = z.enum(["pending", "accepted", "executed", "completed", "dismissed", "superseded"]);
export const actionSchema = z.strictObject({
  id: idSchema, invoiceId: idSchema, generationId: idSchema,
  contextVersion: z.number().int().positive(), version: z.number().int().positive(),
  proposal: proposalSchema, status: actionStatusSchema,
});
export const invoiceSummarySchema = invoiceSchema.extend({
  customerName: z.string(), remainingCents: centsSchema,
  paymentStatus: z.enum(["unpaid", "partial", "paid"]), overdueDays: z.number().int().min(0),
});
export const investigationSummarySchema = z.strictObject({
  invoiceId: idSchema, proposal: proposalSchema, createdAt: z.iso.datetime(),
});
export const outboxEntrySchema = z.strictObject({
  id: idSchema, actionId: idSchema, recipient: z.email(), subject: z.string(), body: z.string(), recordedAt: z.iso.datetime(),
});
export const activitySchema = z.strictObject({
  id: idSchema, invoiceId: idSchema.nullable(), kind: z.string().min(1), description: z.string(), createdAt: z.iso.datetime(),
});
export const settingsSchema = z.strictObject({ generationId: idSchema, demoDate: dateOnlySchema });
export const workspaceSnapshotSchema = settingsSchema.extend({
  mode: z.enum(["live", "fixture"]), agentReady: z.boolean(),
  invoices: z.array(invoiceSummarySchema), emails: z.array(emailSchema), payments: z.array(paymentSchema),
  investigations: z.array(investigationSummarySchema), actions: z.array(actionSchema),
  outbox: z.array(outboxEntrySchema), activity: z.array(activitySchema),
});
export const scenarioEventSchema = z.strictObject({
  id: idSchema, invoiceId: idSchema, label: z.string().min(1), email: emailSchema,
});
export const demoSeedSchema = z.strictObject({
  customers: z.array(customerSchema), invoices: z.array(invoiceSchema), emails: z.array(emailSchema),
  payments: z.array(paymentSchema), events: z.array(scenarioEventSchema),
});

export type Customer = z.infer<typeof customerSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;
export type Email = z.infer<typeof emailSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type ActionStatus = z.infer<typeof actionStatusSchema>;
export type Action = z.infer<typeof actionSchema>;
export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type ScenarioEvent = z.infer<typeof scenarioEventSchema>;
export type DemoSeed = z.infer<typeof demoSeedSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type OutboxEntry = z.infer<typeof outboxEntrySchema>;
export type Activity = z.infer<typeof activitySchema>;
