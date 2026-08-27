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

import type { Job, Entry, Material } from './types';
import { unbilledLabourForJob } from './labour-accrual';
import { PAYROLL_DEFAULTS } from './payroll';

const NZ_GST_RATE = 0.15;

// ── Whose hours are these? ────────────────────────────────────────────────
// Shared by the money math here and the per-person breakdown in
// lib/job-people.ts, so the two can never disagree about who did what.

/**
 * Brad's own time. Prefers the auth uid when we know it; falls back to the
 * worker tier, which is what historic entries (logged before the Who pills
 * existed) actually carry.
 */
export function isOwnerHours(e: Entry, ownerUserId?: string): boolean {
  if (ownerUserId && e.loggedByUserId) return e.loggedByUserId === ownerUserId;
  if ((e.workerName ?? '').trim()) return false;
  return (e.workerKind ?? 'owner') === 'owner';
}

/**
 * Hours worked by someone on PAYROLL — an employee who logged their own
 * time. They're paid through a pay run, so nothing about them ever reaches
 * the job's entries; the only way this job can know what they cost is
 * hours x the payroll wage rate.
 */
export function isPayrollHours(e: Entry, ownerUserId?: string): boolean {
  if (e.type !== 'hours') return false;
  if (!e.loggedByUserId) return false;
  if (isOwnerHours(e, ownerUserId)) return false;
  return (e.workerKind ?? 'owner') !== 'owner';
}

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

  /**
   * Everything this job cost, ex-GST: `materialsCost` + `contractorLabourCost`
   * + `payrollLabourCost`. Equivalently — expense and bill entries, overhead
   * materials consumed here, sub / helper labour (invoiced or accrued), and
   * employee wages for hours logged against this job.
   * The overhead rows are pure attribution (no cash outflow today — the
   * original overhead bill already counted in business-wide expenses) but
   * they SHOULD reduce per-job profit because that material *was* consumed
   * on this job and would otherwise be invisible in the job's economics.
   */
  totalExpenses: number;

  /** Materials, sundries, and every other non-labour cost. Ex-GST. */
  materialsCost: number;

  /**
   * Sub / helper labour: the bills they've sent PLUS the hours they've
   * worked that nobody has invoiced yet. `unbilledLabourCost` is the
   * second half of this on its own.
   */
  contractorLabourCost: number;

  /**
   * Wages for employee hours logged against this job — their hours x the
   * payroll wage rate.
   *
   * ## Read this before moving the number anywhere
   *
   * This is a MANAGEMENT figure and nothing else. The wage itself is paid
   * through a pay run and is already a business-wide expense on Money; this
   * line exists so per-job profit stops pretending a two-hander cost the
   * same as a solo day. Putting it anywhere that rolls jobs up into a
   * business total would count every wage twice, and putting it anywhere
   * near `estimateTax` / `expensesInWindow` would claim a deduction that
   * the pay run already claimed. Same fence as `unbilledLabourCost` — see
   * `lib/labour-accrual.ts`.
   */
  payrollLabourCost: number;

  /**
   * The slice of `totalExpenses` that is sub / helper hours priced at their
   * cost rate and not yet invoiced by the worker. Same logic as bills
   * counting before they're paid: the money is owed the moment the hours
   * are logged. Surfaced separately so the UI can say so — a job whose
   * costs are mostly an accrual is a different story from one whose costs
   * are all real invoices. Retires to 0 as those hours get marked billed.
   */
  unbilledLabourCost: number;

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

  /**
   * Ex-GST income per hour of EVERYONE's time. Useful for pricing
   * comparisons ("what does an hour on site have to bill?") and nothing
   * else — it is not anybody's take-home rate. `ownerRate` is the number
   * that answers "did my time on this pay?".
   */
  expectedHourlyRate: number | null;

  /** Hours of the owner's own time. */
  ownerHours: number;

  /** Hours worked by anyone else — employees, subs, helpers. */
  crewHours: number;

  /**
   * What an hour of the OWNER's time earned: `expectedProfit / ownerHours`.
   * Everyone else has already been paid out of the numerator, so this is
   * the honest answer to "was this job worth my day?". Null with no owner
   * hours logged.
   */
  ownerRate: number | null;
}

export interface JobStatsOptions {
  /**
   * Payroll gross $/hr for employee hours — `payrollConfig(settings).wageRate`.
   * Defaults to the payroll default so a caller that doesn't have settings
   * to hand still costs labour rather than silently costing it at zero.
   */
  wageRate?: number;
  /**
   * The owner's auth uid (`teamMembers.find(m => m.role === 'owner')`), so
   * hours Brad logged for himself aren't mistaken for an employee's.
   */
  ownerUserId?: string;
}

export function jobStats(
  job: Job,
  entries: Entry[],
  materials: Material[] = [],
  opts: JobStatsOptions = {},
): JobStats {
  const wageRate = opts.wageRate && opts.wageRate > 0 ? opts.wageRate : PAYROLL_DEFAULTS.wageRate;
  const own = entries.filter((e) => e.jobId === job.id);
  const hoursRows = own.filter((e) => e.type === 'hours');

  const totalHours = hoursRows.reduce((s, e) => s + (e.hours ?? 0), 0);
  const ownerHours = hoursRows
    .filter((e) => isOwnerHours(e, opts.ownerUserId))
    .reduce((s, e) => s + (e.hours ?? 0), 0);
  const crewHours = totalHours - ownerHours;

  // Bills count as expenses too: they're committed money even if not paid yet.
  // All amounts ex-GST so they're directly comparable to income.
  // Drafts (unconfirmed bills awaiting Brad's review on Home) DO NOT count
  // until confirmed — otherwise an LLM-parsed bill with the wrong amount
  // would silently move the per-job profit numbers.
  const entryExpenses = own
    .filter((e) => (e.type === 'expense' || e.type === 'bill') && !e.isDraft)
    .reduce((s, e) => s + entryExGst(e), 0);

  // Overhead-sourced materials add to this job's expenses for profit
  // calc purposes, even though they don't correspond to a new cash
  // outflow (the original overhead bill already counted in business-
  // wide expenses). Without this, "I used $300 of paint from the van
  // on Chirnside" wouldn't show up in Chirnside's profit at all,
  // which would over-state the job's margin and pollute the quoting
  // assistant's training data.
  //
  // Bill-sourced materials are NOT added here — they're already
  // captured via the linked bill entry above.
  const overheadMaterialCost = materials
    .filter((m) => m.jobId === job.id && m.source === 'overhead')
    .reduce((s, m) => s + (m.cost ?? 0), 0);

  // Labour already worked by a sub / one-off helper that hasn't been
  // invoiced yet. Same principle as the unpaid bills above: committed
  // money. Zero until a cost rate is put on those hours, so it can never
  // silently invent a cost. See lib/labour-accrual.ts.
  const unbilledLabourCost = unbilledLabourForJob(own, job.id);

  // Employee wages. The pay run is the real payment; this is that same
  // money attributed to the job that consumed it. See the field doc on
  // `payrollLabourCost` for where this number is and isn't allowed to go.
  const payrollLabourCost = hoursRows
    .filter((e) => isPayrollHours(e, opts.ownerUserId))
    .reduce((s, e) => s + (e.hours ?? 0) * wageRate, 0);

  // Sub / helper hours that HAVE been invoiced arrive as an ordinary bill,
  // so they're already inside `entryExpenses` and indistinguishable from
  // materials — except that the hours entry they settled points back at
  // them. Follow that pointer so the money-split can tell "paint" from
  // "Kenneth". Anything we can't trace stays in materials, which is the
  // safe direction to be wrong in: it never inflates labour.
  const labourBillIds = new Set(
    hoursRows.map((e) => e.labourBillEntryId).filter((id): id is string => !!id),
  );
  const billedLabourCost = own
    .filter((e) => labourBillIds.has(e.id) && !e.isDraft)
    .reduce((s, e) => s + entryExGst(e), 0);

  const materialsCost = entryExpenses - billedLabourCost + overheadMaterialCost;
  const contractorLabourCost = billedLabourCost + unbilledLabourCost;

  const totalExpenses = materialsCost + contractorLabourCost + payrollLabourCost;

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

  // Everyone else is paid inside `totalExpenses` now, so what's left IS the
  // owner's share — which is what makes `ownerRate` below mean something.
  const expectedProfit = expectedIncome - totalExpenses;
  const expectedHourlyRate = totalHours > 0 ? expectedIncome / totalHours : null;
  const ownerRate = ownerHours > 0 ? expectedProfit / ownerHours : null;

  return {
    totalHours,
    totalExpenses,
    materialsCost,
    contractorLabourCost,
    payrollLabourCost,
    unbilledLabourCost,
    totalIncome,
    expectedIncome,
    expectedProfit,
    expectedIsConfident,
    expectedHourlyRate,
    ownerHours,
    crewHours,
    ownerRate,
  };
}
