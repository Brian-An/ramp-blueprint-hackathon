import { dateOnlySchema, type Invoice, type Payment } from "./contracts";

export function remainingCents(invoice: Invoice, payments: Payment[]): number {
  const paid = payments.filter(payment => payment.invoiceId === invoice.id)
    .reduce((total, payment) => total + payment.amountCents, 0);
  return Math.max(0, invoice.amountCents - paid);
}

export function overdueDays(dueDate: string, demoDate: string): number {
  // Calendar dates represent Toronto business days; UTC midnight avoids DST offsets.
  const due = Date.parse(`${dateOnlySchema.parse(dueDate)}T00:00:00Z`);
  const today = Date.parse(`${dateOnlySchema.parse(demoDate)}T00:00:00Z`);
  return Math.max(0, (today - due) / 86_400_000);
}
