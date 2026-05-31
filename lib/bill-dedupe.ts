// Helpers for matching a freshly-parsed bill against ones already in the
// system, so forwarding/uploading a bill that's already there enriches it
// instead of creating a duplicate.
//
// The tricky case: a backfilled bill stored its invoice number straight off
// the email body ("0909019353"), but the parsed PDF reports "909019353" —
// same invoice, different string. Normalising both (drop leading zeros and
// non-alphanumerics) makes them compare equal. Amount + supplier is the
// fallback when invoice numbers are absent or still don't line up.

/**
 * Normalise a supplier invoice number for matching: strip non-alphanumeric
 * characters and leading zeros, lowercase. So '0909019353', '909019353' and
 * 'WANAKA - 5653' / 'wanaka5653' compare consistently across formats.
 * Returns '' for empty/missing input (callers should treat '' as "no match").
 */
export function normalizeInvoiceNumber(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/[^a-z0-9]/gi, '').replace(/^0+/, '').toLowerCase();
}

/** First word of a supplier name, lowercased — a cheap supplier-identity
 *  check (e.g. 'Dulux New Zealand' and 'Dulux' both → 'dulux'). */
export function supplierKey(s: string | null | undefined): string {
  if (!s) return '';
  return s.trim().toLowerCase().split(/\s+/)[0] ?? '';
}

/** A bill already in the system, reduced to the fields needed for matching. */
export interface BillMatchCandidate {
  invoiceNumber?: string | null;
  amount?: number | null;
  supplier?: string | null;
  company?: string | null;
}

/** The freshly-parsed bill we're trying to place. */
export interface BillMatchTarget {
  invoiceNumber?: string | null;
  totalInclGst?: number | null;
  supplier?: string | null;
}

/**
 * Find the index of the first candidate that looks like the same bill as
 * `target`, or -1. Order of preference:
 *   1. same normalized invoice number
 *   2. identical gross amount (±1c) AND same supplier keyword
 * Errs toward NOT matching (returns -1) rather than risk a wrong merge.
 */
export function findMatchingBillIndex(
  candidates: BillMatchCandidate[],
  target: BillMatchTarget,
): number {
  const want = normalizeInvoiceNumber(target.invoiceNumber);
  if (want) {
    const byInv = candidates.findIndex((c) => normalizeInvoiceNumber(c.invoiceNumber) === want);
    if (byInv !== -1) return byInv;
  }
  if (target.totalInclGst != null) {
    const wantKey = supplierKey(target.supplier);
    const byAmt = candidates.findIndex((c) =>
      c.amount != null
      && Math.abs(c.amount - target.totalInclGst!) <= 0.02
      && wantKey.length > 0
      && supplierKey(c.supplier ?? c.company) === wantKey,
    );
    if (byAmt !== -1) return byAmt;
  }
  return -1;
}
