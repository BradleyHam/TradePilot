/**
 * Unbilled labour — what Brad owes for work already done.
 *
 * The gap this closes: when a subcontractor or one-off helper works a
 * day, the money is owed the moment the hours are logged, but nothing
 * enters the books until their invoice arrives — often weeks later, in a
 * different month. So the Earned view of a month showed that month's
 * revenue with none of the labour that produced it.
 *
 * An hours entry accrues when ALL of these hold:
 *   - it's an hours row with hours and a cost rate on it
 *   - nobody on payroll did it (`loggedByUserId` unset) — payroll wages
 *     come through pay runs, and accruing them here would double-count
 *   - the tier isn't 'owner' — Brad's own time is drawings, not a cost
 *   - the worker hasn't invoiced it yet (`labourBilled` false)
 *
 * A missing rate accrues NOTHING. "I don't know what this cost" is an
 * honest answer; a guessed number would quietly move the job's profit.
 *
 * ## Where this number is allowed to go
 *
 * Management figures only: the Earned basis on Money, and per-job cost /
 * profit (which already counts unpaid bills as committed money). It must
 * NEVER reach `estimateTax` or `expensesInWindow` — GST and income tax
 * run on a payments basis, where an accrual with no invoice behind it
 * isn't claimable and isn't evidenced. See `lib/tax-estimator.ts`.
 */
import type { Entry } from '@/lib/types';
import { SHORT_WORKER_KIND_LABELS } from '@/lib/hours-attribution';

/** Does this entry represent labour Brad owes someone but hasn't been billed for? */
export function isUnbilledLabour(e: Entry): boolean {
  return e.type === 'hours'
    && !e.labourBilled
    && !e.loggedByUserId
    && !!e.workerKind
    && e.workerKind !== 'owner'
    && (e.hours ?? 0) > 0
    && (e.workerCostRate ?? 0) > 0;
}

/** Ex-GST cost of one labour entry. 0 when it isn't priced. */
export function labourCost(e: Entry): number {
  return (e.hours ?? 0) * (e.workerCostRate ?? 0);
}

/** Who the hours belong to, for display. These rows never have a login. */
export function unbilledLabourName(e: Entry): string {
  const typed = (e.workerName ?? '').trim();
  if (typed) return typed;
  return e.workerKind ? SHORT_WORKER_KIND_LABELS[e.workerKind] : 'Someone';
}

/** Every unbilled labour entry, optionally narrowed to one job. */
export function unbilledLabourEntries(entries: Entry[], jobId?: string): Entry[] {
  return entries.filter((e) => isUnbilledLabour(e) && (jobId === undefined || e.jobId === jobId));
}

/**
 * Cost of unbilled labour worked inside a date window, by the day it was
 * worked — that's the whole point: the cost lands in the month the work
 * happened, alongside the revenue it earned.
 */
export function unbilledLabourInWindow(entries: Entry[], startISO: string, endISO: string): number {
  let total = 0;
  for (const e of entries) {
    if (!isUnbilledLabour(e)) continue;
    if (e.entryDate < startISO || e.entryDate > endISO) continue;
    total += labourCost(e);
  }
  return total;
}

/** Cost of unbilled labour on one job, whenever it was worked. */
export function unbilledLabourForJob(entries: Entry[], jobId: string): number {
  return unbilledLabourEntries(entries, jobId).reduce((s, e) => s + labourCost(e), 0);
}

/**
 * Per-person summary of a job's unbilled labour — "Kenneth · 12h · $540".
 * Ordered by cost, biggest first, so the prompt at bill-confirm time leads
 * with the person most likely to be the one invoicing.
 */
export function unbilledLabourByWorker(
  entries: Entry[],
  jobId?: string,
): { name: string; hours: number; cost: number; entryIds: string[] }[] {
  const byName = new Map<string, { name: string; hours: number; cost: number; entryIds: string[] }>();
  for (const e of unbilledLabourEntries(entries, jobId)) {
    const name = unbilledLabourName(e);
    const row = byName.get(name.toLowerCase()) ?? { name, hours: 0, cost: 0, entryIds: [] };
    row.hours += e.hours ?? 0;
    row.cost += labourCost(e);
    row.entryIds.push(e.id);
    byName.set(name.toLowerCase(), row);
  }
  return [...byName.values()].sort((a, b) => b.cost - a.cost);
}

/**
 * The rate last paid to this person, for pre-filling the next shift. Looks
 * at the most recent priced entry carrying the same name (case-insensitive),
 * falling back to the most recent rate for the same worker tier. Undefined
 * when there's nothing to go on — the field then starts empty rather than
 * seeded with someone else's rate.
 */
export function lastCostRateFor(
  entries: Entry[],
  name: string,
  kind?: Entry['workerKind'],
): number | undefined {
  const wanted = name.trim().toLowerCase();
  const priced = entries
    .filter((e) => e.type === 'hours' && (e.workerCostRate ?? 0) > 0)
    .sort((a, b) => (a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : 0));
  if (wanted) {
    const byName = priced.find((e) => (e.workerName ?? '').trim().toLowerCase() === wanted);
    if (byName) return byName.workerCostRate;
  }
  if (kind) {
    const byKind = priced.find((e) => e.workerKind === kind && !(e.workerName ?? '').trim());
    if (byKind) return byKind.workerCostRate;
  }
  return undefined;
}
