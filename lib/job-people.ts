/**
 * Who was on this job, for how long, and what they took off it.
 *
 * The job sheet already answers "how many hours" (one number) and "doing
 * what" (hours by activity). Neither answers the question Brad actually
 * asks after a two- or three-hander: *whose* hours were they, and what did
 * that crew cost me. On a job like Tank Wanaka — 64h across an owner, an
 * employee and a subbie — "64h" hides the whole story.
 *
 * ## Where each person's money comes from
 *
 * The three money paths are genuinely different and the UI must not blur
 * them:
 *
 *   - `wages`   — an employee who logged their own hours (`loggedByUserId`).
 *                 Paid through a pay run at the payroll wage rate, and
 *                 attributed to the job as `jobStats.payrollLabourCost`.
 *   - `invoice` — a subbie or one-off helper priced at `workerCostRate`.
 *                 Already inside `jobStats.totalExpenses`, either as a
 *                 confirmed bill or as the unbilled-labour accrual.
 *   - `owner`   — Brad. He isn't paid an hourly wage; what his hours earned
 *                 IS the job's leftover profit. Everyone else is already
 *                 paid inside `jobStats.totalExpenses`, so his row is
 *                 `expectedProfit` straight, plus the $/h it works out to.
 *   - `unknown` — non-owner hours with no cost rate on them. We show the
 *                 hours and say the rate is missing. A guessed number here
 *                 would quietly move the job's profit, same reasoning as
 *                 `lib/labour-accrual.ts`.
 *
 * ## Reconciliation
 *
 * Row hours sum to `jobStats.totalHours` exactly — both count `entry.hours`
 * and nothing else. Legacy `helperHours` (the retired "+ helper hrs" field)
 * ride on someone else's entry and are NOT in that total, so they come back
 * separately as `legacyHelperHours` for a footnote rather than being folded
 * into a row and breaking the tie-out with the Hours tile.
 */

import type { BusinessMember, Entry, WorkerKind } from '@/lib/types';
import { hoursWorkerLabel } from '@/lib/hours-attribution';
import { isOwnerHours } from '@/lib/job-stats';

/** Which of the three money paths this person's pay came down. */
export type PayBasis = 'wages' | 'invoice' | 'owner' | 'unknown';

export interface JobPersonRow {
  /** Stable grouping key — uid, typed name, or worker tier. */
  key: string;
  /** Display name: "Me", "Suzie", "Kenneth", or a tier like "Helper". */
  label: string;
  hours: number;
  /**
   * Ex-GST money this person took off the job. Null when it isn't
   * knowable — no cost rate on their hours, or (for the owner) the job
   * has no income figure to leave a residual from.
   */
  earned: number | null;
  basis: PayBasis;
  /** Their tier, for a chip. Undefined for employees on payroll. */
  kind?: WorkerKind;
  /**
   * Hours inside `hours` that carry no cost rate. `earned` under-counts
   * by exactly this much labour, so the UI can say so.
   */
  unpricedHours: number;
  /** `earned / hours`. Owner rows only — everyone else has a flat rate. */
  effectiveRate: number | null;
  isOwner: boolean;
}

export interface JobPeopleBreakdown {
  /** Owner first, then everyone else by hours descending. */
  rows: JobPersonRow[];
  /** Sums to jobStats.totalHours. */
  totalHours: number;
  /** Wages + priced sub/helper labour. Everything but the owner's residual. */
  crewCost: number;
  /** Retired `helperHours` riding on other people's entries. Not in `rows`. */
  legacyHelperHours: number;
}

/** One bucket per person: uid > typed name > worker tier. */
function personKey(e: Entry, isOwner: boolean): string {
  if (isOwner) return 'owner';
  if (e.loggedByUserId) return `user:${e.loggedByUserId}`;
  const typed = (e.workerName ?? '').trim();
  if (typed) return `name:${typed.toLowerCase()}`;
  return `kind:${e.workerKind ?? 'helper'}`;
}

export interface JobPeopleInput {
  /** The job's `type === 'hours'` entries. Caller filters. */
  hoursEntries: Entry[];
  teamMembers: BusinessMember[];
  /** Signed-in user, so their own hours read as "Me". */
  viewerUserId?: string | null;
  /** Payroll gross $/hr, from `payrollConfig(settings).wageRate`. */
  wageRate: number;
  /**
   * `jobStats.expectedProfit`, or null when the job has no income figure
   * yet. Wages and sub labour are already netted off inside it, so this
   * IS the owner's share — no further arithmetic here.
   */
  expectedProfit: number | null;
}

export function jobPeopleBreakdown(input: JobPeopleInput): JobPeopleBreakdown {
  const { hoursEntries, teamMembers, viewerUserId, wageRate, expectedProfit } = input;
  const ownerUserId = teamMembers.find((m) => m.role === 'owner')?.userId;

  interface Bucket {
    key: string;
    label: string;
    hours: number;
    /** Money from priced entries only. */
    priced: number;
    unpricedHours: number;
    isOwner: boolean;
    onPayroll: boolean;
    kind?: WorkerKind;
  }

  const buckets = new Map<string, Bucket>();
  let legacyHelperHours = 0;

  for (const e of hoursEntries) {
    const hours = e.hours ?? 0;
    // Legacy field: never a row of its own, just a footnote.
    if (e.helperHours && e.helperHours > 0) legacyHelperHours += e.helperHours;
    if (hours <= 0) continue;

    const isOwner = isOwnerHours(e, ownerUserId);
    const key = personKey(e, isOwner);
    const onPayroll = !isOwner && !!e.loggedByUserId;

    const bucket = buckets.get(key) ?? {
      key,
      // hoursWorkerLabel already resolves 'Me' vs a first name from the
      // viewer, owner rows included — don't hard-code 'Me' here or an
      // employee looking at the job sees two rows both called Me.
      label: hoursWorkerLabel(e, teamMembers, viewerUserId),
      hours: 0,
      priced: 0,
      unpricedHours: 0,
      isOwner,
      onPayroll,
      kind: isOwner || onPayroll ? undefined : (e.workerKind ?? undefined),
    };

    bucket.hours += hours;
    if (isOwner) {
      // Handled after the loop — the owner is paid out of what's left.
    } else if (onPayroll) {
      bucket.priced += hours * wageRate;
    } else if ((e.workerCostRate ?? 0) > 0) {
      bucket.priced += hours * (e.workerCostRate as number);
    } else {
      bucket.unpricedHours += hours;
    }
    buckets.set(key, bucket);
  }

  const all = [...buckets.values()];
  const crewCost = all
    .filter((b) => !b.isOwner)
    .reduce((s, b) => s + b.priced, 0);

  const rows: JobPersonRow[] = all.map((b) => {
    if (b.isOwner) {
      // Everyone else has been paid inside expectedProfit already, so
      // what's left is exactly what the owner's hours earned.
      const residual = expectedProfit;
      return {
        key: b.key,
        label: b.label,
        hours: b.hours,
        earned: residual,
        basis: 'owner',
        unpricedHours: 0,
        effectiveRate: residual != null && b.hours > 0 ? residual / b.hours : null,
        isOwner: true,
      };
    }
    const priced = b.hours - b.unpricedHours > 0;
    return {
      key: b.key,
      label: b.label,
      hours: b.hours,
      earned: priced ? b.priced : null,
      basis: b.onPayroll ? 'wages' : priced ? 'invoice' : 'unknown',
      kind: b.kind,
      unpricedHours: b.unpricedHours,
      effectiveRate: null,
      isOwner: false,
    };
  });

  // Owner, then staff, then everyone he hired in — the order he'd read them
  // out in, and it keeps same-basis rows together so the colour coding
  // reads as groups rather than noise.
  const BASIS_ORDER: Record<PayBasis, number> = { owner: 0, wages: 1, invoice: 2, unknown: 3 };
  rows.sort((a, b) => {
    const byBasis = BASIS_ORDER[a.basis] - BASIS_ORDER[b.basis];
    return byBasis !== 0 ? byBasis : b.hours - a.hours;
  });

  return {
    rows,
    totalHours: rows.reduce((s, r) => s + r.hours, 0),
    crewCost,
    legacyHelperHours,
  };
}
