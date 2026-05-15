// Bill due-date inference.
//
// NZ trade convention: "on the 20th" — invoices issued in month M are due
// on the 20th of month M+1. Most painting suppliers (Trade Max, Dulux,
// Resene etc) operate this way, though some print an explicit due date
// on the PDF in which case we use that instead.
//
// This helper is ONLY called when the PDF didn't have a printed due date.
// We never overwrite a value we extracted from the source document.
//
// Per-supplier override is on the queued list (Phase 2). For now, a
// single global rule; if you have a supplier on different terms (e.g.
// "net 7" or "20th of THIS month if invoiced before the 7th"), edit the
// due date manually on the confirm row.

/**
 * Given an invoice date in ISO YYYY-MM-DD format, return the inferred due
 * date as ISO YYYY-MM-DD using the "20th of the following month" rule.
 *
 * Examples:
 *   "2026-05-13" → "2026-06-20"   (mid-month)
 *   "2026-05-25" → "2026-06-20"   (after the 20th of own month — still next month's 20th)
 *   "2026-06-01" → "2026-07-20"   (start of month)
 *   "2026-12-31" → "2027-01-20"   (year rollover)
 *
 * Returns null if the input isn't a parseable YYYY-MM-DD.
 */
export function inferDueDate(invoiceISO: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(invoiceISO);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]); // 1–12
  // Following month, with year rollover when invoiced in December.
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-20`;
}

/**
 * Marker we stash inside `entries.parserRaw.dueDateSource` so the UI can
 * differentiate "we read this off the PDF" from "we computed it" from
 * "Brad typed it manually". Keeps the audit trail honest without needing
 * a dedicated column.
 */
export type DueDateSource = 'pdf' | 'computed' | 'manual';
