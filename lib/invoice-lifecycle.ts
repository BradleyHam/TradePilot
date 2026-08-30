import type { Invoice, InvoiceKind, InvoiceStatus } from './types';

export type InvoiceDisplayStatus = InvoiceStatus | 'due' | 'overdue';

/** Legacy rows loaded before migration 049 still behave sensibly. */
export function invoiceStatus(invoice: Pick<Invoice, 'status' | 'paid'>): InvoiceStatus {
  return invoice.status ?? (invoice.paid ? 'paid' : 'sent');
}

export function invoiceDisplayStatus(
  invoice: Pick<Invoice, 'status' | 'paid' | 'dueDate'>,
  today = new Date().toISOString().slice(0, 10),
): InvoiceDisplayStatus {
  const status = invoiceStatus(invoice);
  if (status !== 'sent' || !invoice.dueDate) return status;
  if (invoice.dueDate < today) return 'overdue';
  if (invoice.dueDate === today) return 'due';
  return 'sent';
}

export function invoiceCountsAsIssued(invoice: Pick<Invoice, 'status' | 'paid'>): boolean {
  const status = invoiceStatus(invoice);
  return status === 'sent' || status === 'paid';
}

export function invoiceIsOutstanding(invoice: Pick<Invoice, 'status' | 'paid'>): boolean {
  return invoiceStatus(invoice) === 'sent';
}

export function addCalendarDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + Math.max(0, days));
  return date.toISOString().slice(0, 10);
}

export function defaultInvoiceDueDate(
  invoiceDate: string,
  kind: InvoiceKind,
  depositDueDays = 0,
): string {
  return addCalendarDays(invoiceDate, kind === 'deposit' ? depositDueDays : 0);
}
