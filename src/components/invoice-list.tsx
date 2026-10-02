import type { InvoiceSummary } from "@/lib/contracts";

export const money = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
const statusLabels = { unpaid: "Unpaid", partial: "Partially paid", paid: "Paid" };
export default function InvoiceList({ invoices, selectedId, onSelect }: { invoices: InvoiceSummary[]; selectedId: string; onSelect: (id: string) => void }) {
  return <section className="invoice-surface" aria-labelledby="invoice-list-title">
    <div className="list-header"><div><p className="eyebrow">Accounts receivable</p><h2 id="invoice-list-title">Invoices</h2><p className="muted">Select an invoice to inspect its evidence and next step.</p></div></div>
    <table className="review-list"><caption className="sr-only">Invoices and remaining balances in CAD</caption>
      <thead><tr><th scope="col">Invoice</th><th scope="col" className="numeric">Remaining CAD</th><th scope="col">Status</th></tr></thead>
      <tbody>{invoices.map(invoice => <tr key={invoice.id} aria-selected={selectedId === invoice.id}>
        <th scope="row"><button className="invoice-link" aria-label={`Open invoice ${invoice.number}`} aria-pressed={selectedId === invoice.id} onClick={() => onSelect(invoice.id)}>{invoice.number}</button><span className="list-customer">{invoice.customerName}</span></th>
        <td className="numeric">{money.format(invoice.remainingCents / 100)}</td><td><span className="payment-status">{statusLabels[invoice.paymentStatus]}</span></td>
      </tr>)}</tbody>
    </table>
  </section>;
}
