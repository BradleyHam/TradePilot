// Single source of truth for "what's the financial picture of this job".
// Used by both the JobCard list view and the JobDetailSheet so they can't
// drift apart. Money page does business-wide monthly rollups and uses its
// own logic (different shape).
//
// EVERYTHING IN THIS MODULE IS EX-GST. GST is pass-through to the IRD; it's
// not money you keep. Mixing gross income with ex-GST expenses produces
// wildly wrong "profit" and "$ per hour" numbers, so we normalise everything
// to ex-GST up front. Each entry has an `amountExGst` populated by the
// importer; if a hand-entered row only has a gross `amount`, we derive the
// ex-GST value using the GST rate (default 15%).

import type { Job, Entry } from './types';

const NZ_GST_RATE = 0.15;

/**
 * Pull the ex-GST value out of an entry. Prefers the explicit ex-GST column
 * if populated; otherwise derives from gross amount + gstApplies flag.
 *
 * Exported so other components (e.g. the activity-list header on the job
 * detail sheet) can reuse the same conversion rather than duplicating GST
 * arithmetic that might drift.
 */
export function entryExGst(e: Entry): number {
  if (e.amountExGst != null) return e.amountExGst;
  if (e.amount == null) return 0;
  if (!e.gstApplies) return e.amount;
  return e.amount / (1 + NZ_GST_RATE);
}

export interface JobStats {
  /** Sum of hours-type entries on this job. */
  totalHours: number;

  /** Ex-GST sum of expense entries + ALL bill entries (paid or not) tied to this job. */
  totalExpenses: number;

  /** Ex-GST sum of income entries on this job — money actually received, take-home. */
  totalIncome: number;

  /**
   * What we think the job will earn, ex-GST. Falls back through:
   *   actual income > invoice amount > quote amount > estimated value > 0.
   * Note: invoice/quote/estimated values come straight from the Job row and
   * may have been entered as gross. We can't reliably tell, so we treat them
   * as already ex-GST. (TODO: store quote amounts ex-GST consistently in the
   * jobs table.)
   */
  expectedIncome: number;

  /** expectedIncome - totalExpenses, ex-GST. The take-home profit. */
  expectedProfit: number;

  /** True when expectedIncome is based on something more concrete than a guess (i.e. not estimatedValue). */
  expectedIsConfident: boolean;

  /** Ex-GST income per hour assuming the job pays out at expectedIncome. Null if no hours yet. */
  expectedHourlyRate: number | null;
}

export function jobStats(job: Job, entries: Entry[]): JobStats {
  const own = entries.filter((e) => e.jobId === job.id);

  const totalHours = own
    .filter((e) => e.type === 'hours')
    .reduce((s, e) => s + (e.hours ?? 0), 0);

  // Bills count as expenses too: they're committed money even if not paid yet.
  // All amounts ex-GST so they're directly comparable to income.
  // Drafts (unconfirmed bills awaiting Brad's review on Home) DO NOT count
  // until confirmed — otherwise an LLM-parsed bill with the wrong amount
  // would silently move the per-job profit numbers.
  const totalExpenses = own
    .filter((e) => (e.type === 'expense' || e.type === 'bill') && !e.isDraft)
    .reduce((s, e) => s + entryExGst(e), 0);

  const totalIncome = own
    .filter((e) => e.type === 'income')
    .reduce((s, e) => s + entryExGst(e), 0);

  // Expected income: prefer the most authoritative number for the job's
  // current stage. The fallback ladder differs between "still in progress"
  // and "invoiced/done":
  //
  //   in-progress and friends: actual income > quote > estimate
  //     → on a live job, only what's been received is real; the quote is
  //       a forecast.
  //   invoiced / completed / paid: invoice > actual income > quote
  //     → once you've sent the final invoice, THAT is what you've earned.
  //       Partial received income (e.g. deposit only) under-counts because
  //       the rest is just sitting in your customer's bank, not yours, but
  //       you've still earned it for hourly-rate / profitability purposes.
  const isFinalised = job.status === 'invoiced'
    || job.status === 'completed'
    || job.status === 'paid';

  let expectedIncome = 0;
  let expectedIsConfident = true;
  if (isFinalised && job.invoiceAmount && job.invoiceAmount > 0) {
    expectedIncome = job.invoiceAmount;
  } else if (totalIncome > 0) {
    expectedIncome = totalIncome;
  } else if (job.invoiceAmount && job.invoiceAmount > 0) {
    expectedIncome = job.invoiceAmount;
  } else if (job.quoteAmount && job.quoteAmount > 0) {
    expectedIncome = job.quoteAmount;
  } else if (job.estimatedValue && job.estimatedValue > 0) {
    expectedIncome = job.estimatedValue;
    expectedIsConfident = false;
  } else {
    expectedIsConfident = false;
  }

  const expectedProfit = expectedIncome - totalExpenses;
  const expectedHourlyRate = totalHours > 0 ? expectedIncome / totalHours : null;

  return {
    totalHours,
    totalExpenses,
    totalIncome,
    expectedIncome,
    expectedProfit,
    expectedIsConfident,
    expectedHourlyRate,
  };
}
