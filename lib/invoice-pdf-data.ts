// Shared invoice → PDF data helpers.
//
// Single source of truth for (a) the standard deposit defaults a job
// implies, and (b) turning a set of invoice figures into the
// `InvoicePdfData` the branded PDF renders. Used by BOTH the invoice
// form (`InvoiceAction`) and the accept→review→send flow
// (`InvoiceReviewSheet`) so the two always produce an identical document.

import type { Job, Quote, QuoteTemplate, InvoiceKind } from '@/lib/types';

const NZ_GST_RATE = 0.15;

export function fmtMoney2(n: number): string {
  return `$${n.toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** ISO yyyy-mm-dd → dd/mm/yyyy for display. Returns undefined for empty. */
export function fmtDateNZ(iso?: string): string | undefined {
  if (!iso) return undefined;
  const [y, m, d] = iso.split('-');
  return (y && m && d) ? `${d}/${m}/${y}` : iso;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The fields shown in the branded invoice PDF. Owned here (not in the
 *  'use client' PDF component) so plain server/lib code can build it. */
export interface InvoicePdfData {
  invoiceNumber: string;
  /** Display string, e.g. "26/05/2026". */
  invoiceDateDisplay: string;
  /** e.g. "On receipt". */
  dueText: string;
  /** Bold line in the description cell, e.g. "Deposit (30%) — to secure booking". */
  lineTitle: string;
  /** Paragraph under the line title. */
  description: string;
  /** NOTES box body. Omit to hide the box. */
  notes?: string;
  subtotalExGst: number;
  gstAmount: number;
  totalInclGst: number;
  /** Amount shown in the line item's right column (GST-inclusive). */
  lineAmountInclGst: number;
  quoteRef?: string;
  projectName?: string;
}

export interface DepositDefaults {
  invoiceNumber: string;
  /** ISO yyyy-mm-dd (today). */
  invoiceDateISO: string;
  amountExGst: number;
  gst: number;
  inclGst: number;
  /** Ex-GST total work value the deposit is a slice of. */
  jobTotalExGst: number;
  /** Remaining balance (incl. GST) after this deposit. */
  balanceInclGst: number;
  depositPercent: number;
}

/**
 * The standard deposit a job implies: depositPercent (from the template,
 * default 30%) of the quote, today's date, and the conventional
 * `INV-{legacyId|id}` number. Matches the smart default in InvoiceAction.
 */
export function depositDefaultsFor(job: Job, template: QuoteTemplate | null): DepositDefaults {
  const quote = job.quoteAmount ?? 0;
  const depositPercent = template?.paymentTerms?.depositPercent ?? 30;
  const amountExGst = round2(quote * (depositPercent / 100));
  const gst = round2(amountExGst * NZ_GST_RATE);
  const inclGst = round2(amountExGst + gst);
  const jobTotalExGst = job.invoiceAmount && job.invoiceAmount > 0 ? job.invoiceAmount : quote;
  const jobTotalInclGst = jobTotalExGst * (1 + NZ_GST_RATE);
  const balanceInclGst = Math.max(0, round2(jobTotalInclGst - inclGst));
  const invoiceNumber = `INV-${job.legacyId ?? job.id.slice(0, 6).toUpperCase()}`;
  const invoiceDateISO = new Date().toISOString().slice(0, 10);
  return { invoiceNumber, invoiceDateISO, amountExGst, gst, inclGst, jobTotalExGst, balanceInclGst, depositPercent };
}

/**
 * Turn a set of invoice figures into the PDF's data block — line title,
 * auto-written description + notes, totals. Pure; no React, no I/O.
 */
export function buildInvoicePdfData(opts: {
  kind: InvoiceKind;
  invoiceNumber: string;
  /** ISO yyyy-mm-dd. */
  invoiceDateISO: string;
  /** ISO yyyy-mm-dd. Same as invoice date means "On receipt". */
  dueDateISO?: string;
  amountExGst: number;
  gst: number;
  inclGst: number;
  job: Job;
  quote?: Quote;
  /** Remaining balance incl. GST after this invoice (for the deposit blurb). */
  balanceInclGst: number;
  depositPercent: number;
}): InvoicePdfData {
  const { kind, invoiceNumber, invoiceDateISO, dueDateISO, amountExGst, gst, inclGst, job, quote, balanceInclGst, depositPercent } = opts;

  const quoteRef = quote?.legacyId ?? undefined;
  const quoteDateDisplay = fmtDateNZ(quote?.dateSent);
  const projectName = job.location || job.name;

  const lineTitle =
    kind === 'deposit' ? `Deposit (${depositPercent}%) — to secure booking`
    : kind === 'progress' ? 'Progress payment'
    : 'Final invoice — balance on completion';

  let description: string;
  if (kind === 'deposit') {
    description =
      `Deposit invoice for painting works at ${projectName}`
      + (quoteRef ? `, as per quote ${quoteRef}${quoteDateDisplay ? ` dated ${quoteDateDisplay}` : ''}` : '')
      + '.'
      + (balanceInclGst > 0 ? ` Balance of ${fmtMoney2(balanceInclGst)} (incl. GST) due on completion.` : '');
  } else if (kind === 'final') {
    description = `Final invoice for painting works at ${projectName}${quoteRef ? `, as per quote ${quoteRef}` : ''}.`;
  } else {
    description = `Progress payment for painting works at ${projectName}${quoteRef ? `, as per quote ${quoteRef}` : ''}.`;
  }

  const notes = kind === 'deposit'
    ? `This deposit secures your booking${quoteRef ? ` as per ${quoteRef}` : ''}.`
      + (job.startDate ? ` Work scheduled to commence ${fmtDateNZ(job.startDate)}.` : '')
      + (balanceInclGst > 0 ? ` Balance of ${fmtMoney2(balanceInclGst)} (incl. GST) will be invoiced on completion.` : '')
    : undefined;

  return {
    invoiceNumber,
    invoiceDateDisplay: fmtDateNZ(invoiceDateISO) ?? invoiceDateISO,
    dueText: !dueDateISO || dueDateISO === invoiceDateISO
      ? 'On receipt'
      : (fmtDateNZ(dueDateISO) ?? dueDateISO),
    lineTitle,
    description,
    notes,
    subtotalExGst: amountExGst,
    gstAmount: gst,
    totalInclGst: inclGst,
    lineAmountInclGst: inclGst,
    quoteRef,
    projectName,
  };
}
