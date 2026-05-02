/**
 * Cash-basis vs earned-basis income allocation.
 *
 * Cash basis: income lands on the date the payment hit the bank.
 *   That's just `entries.where(type='income')` filtered by date.
 *
 * Earned basis: for each *completed* (or invoiced/paid) job, split the job's
 *   quote amount across the months you worked on it, proportional to hours
 *   logged each month. Jobs you haven't completed yet contribute nothing —
 *   you haven't earned that income yet, even if a deposit landed.
 *
 * Hours allocation is the most accurate per-month rule. It uses data you
 * already log (hours by date) and degrades gracefully:
 *   - Job has no hours logged → fall back to a single allocation on the
 *     completion date (or start date if never completed).
 *   - Job has hours but they're all in one month → all income lands that month.
 *   - Job spans multiple months → income split by hours-share per month.
 *
 * "Earned" jobs are those whose status is one of: completed, invoiced, paid.
 * A job in lead/quoted/accepted/booked/in-progress is unfinished; we don't
 * recognise revenue from it yet, even if deposits have been received.
 *
 * All amounts here are GROSS (what you'd see on Revenue stat cards). For
 * tax-side calcs use lib/tax-estimator.ts which handles ex-GST.
 */

import type { Job, Entry } from './types';

const EARNED_STATUSES: ReadonlyArray<Job['status']> = [
  'completed', 'invoiced', 'paid',
];

const ALLOCATABLE_AMOUNT = (job: Job): number => {
  // Prefer invoice amount if set (final billed value). Else quote amount. Else
  // estimated value. Else fall back to actual income received on the job.
  if (job.invoiceAmount && job.invoiceAmount > 0) return job.invoiceAmount;
  if (job.quoteAmount   && job.quoteAmount   > 0) return job.quoteAmount;
  if (job.estimatedValue && job.estimatedValue > 0) return job.estimatedValue;
  return 0;
};

/** YYYY-MM bucket key for an ISO date. */
const monthKey = (iso: string): string => iso.slice(0, 7);

/**
 * Compute earned-basis income allocations for a single job.
 * Returns a map of YYYY-MM → amount.
 */
function allocateJob(job: Job, jobEntries: Entry[]): Map<string, number> {
  const out = new Map<string, number>();
  const total = ALLOCATABLE_AMOUNT(job);
  if (total <= 0) return out;
  if (!EARNED_STATUSES.includes(job.status)) return out;

  // Hours by month for this job
  const hoursByMonth = new Map<string, number>();
  let totalHours = 0;
  for (const e of jobEntries) {
    if (e.jobId !== job.id) continue;
    if (e.type !== 'hours' || e.hours == null) continue;
    const k = monthKey(e.entryDate);
    hoursByMonth.set(k, (hoursByMonth.get(k) ?? 0) + e.hours);
    totalHours += e.hours;
  }

  if (totalHours > 0) {
    // Hours-weighted allocation
    for (const [k, h] of hoursByMonth) {
      out.set(k, total * (h / totalHours));
    }
    return out;
  }

  // No hours logged — fall back to the completion date, then start date,
  // then today as a last resort.
  const fallbackDate = job.endDate ?? job.startDate ?? new Date().toISOString().slice(0, 10);
  out.set(monthKey(fallbackDate), total);
  return out;
}

/**
 * Sum the earned-basis income for the entire business inside a date window.
 *
 * Iterates each "earned" job, allocates its income across months by hours,
 * then sums the months that fall inside [startISO, endISO].
 */
export function earnedIncomeInWindow(
  jobs: Job[],
  entries: Entry[],
  startISO: string,
  endISO: string,
): number {
  const startMonth = monthKey(startISO);
  const endMonth   = monthKey(endISO);

  let total = 0;
  for (const job of jobs) {
    if (!EARNED_STATUSES.includes(job.status)) continue;
    const alloc = allocateJob(job, entries);
    for (const [m, amt] of alloc) {
      if (m >= startMonth && m <= endMonth) total += amt;
    }
  }
  return total;
}

/**
 * Sum cash-basis income (money received) inside a date window. Convenience
 * wrapper so callers can swap between the two with a single function call.
 */
export function cashIncomeInWindow(
  entries: Entry[],
  startISO: string,
  endISO: string,
): number {
  let total = 0;
  for (const e of entries) {
    if (e.type !== 'income') continue;
    if (e.entryDate < startISO || e.entryDate > endISO) continue;
    total += e.amount ?? 0;
  }
  return total;
}

/**
 * Same as `earnedIncomeInWindow` but returns a per-month breakdown for the
 * window — used by the Revenue vs Expenses chart so its bars also reflect
 * the selected basis.
 */
export function earnedIncomeByMonth(
  jobs: Job[],
  entries: Entry[],
  monthsAsc: string[],   // ['2026-03', '2026-04', '2026-05']
): Map<string, number> {
  const result = new Map<string, number>(monthsAsc.map((m) => [m, 0]));
  for (const job of jobs) {
    if (!EARNED_STATUSES.includes(job.status)) continue;
    const alloc = allocateJob(job, entries);
    for (const [m, amt] of alloc) {
      if (result.has(m)) {
        result.set(m, (result.get(m) ?? 0) + amt);
      }
    }
  }
  return result;
}
