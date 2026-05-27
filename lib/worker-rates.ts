/**
 * Worker-tier target hourly rates.
 *
 * Each WorkerKind has its own target charge-out $/hr. The job's hourly-
 * rate gauge uses a BLENDED target — weighted average across the
 * actual hour-mix logged on the job — to honestly tell Brad whether
 * the job hit the right number given the labour he deployed.
 *
 * ## Why this matters
 *
 * Without tier-aware targets, the gauge uses a flat $85–100/hr "owner
 * target" and a two-person day always looks great ("we hit $197/hr!").
 * Reality: a helper costs less because they produce less, so the
 * target for a two-person day SHOULD be lower than for a solo day,
 * and the gauge should reflect that. Hitting $197/hr with one helper
 * is good but it's not 2× a solo day — it's the right outcome for
 * THIS labour mix.
 *
 * ## Where the numbers come from
 *
 * The owner rate is anchored on the Resene PD's fully-loaded hourly
 * cost: $58.72 (PD p7, 2022) + 10% profit = $64.59. Inflated to today
 * with the same CGPI factor the cost engine uses: ~$70/hr in 2026.
 * Brad's actual target sits above this (he wants $85-100/hr take-home
 * after overheads), so the OWNER default is $90.
 *
 * The HELPER rate (inexperienced, prep-only) anchors on NZ minimum
 * wage ($23.15 in 2026) × the same 1.22 loading the PD uses for
 * holiday/sick/ACC + $10 consumables + $12 overhead = $50.24. Target
 * charge-out at a modest margin: $55.
 *
 * Other tiers interpolate. All are OVERRIDABLE in Settings per
 * business — these defaults exist so a fresh install has sensible
 * numbers from day one.
 */

import type { Setting, WorkerKind } from './types';
import { WORKER_RATE_SETTING_KEYS } from './types';

// PD-anchored defaults, in $/hr ex-GST, 2026 dollars.
//   - owner:        PD loaded cost × inflation + Brad's profit target
//   - experienced:  ~85% of owner (trade-qualified subbie)
//   - apprentice:   ~70% of owner (2nd year+)
//   - helper:       NZ min wage × PD loading + small margin
//   - subcontractor:~60-70% of owner (typical sub charge-out)
export const DEFAULT_WORKER_RATES: Record<WorkerKind, number> = {
  owner:         90,
  experienced:   80,
  apprentice:    65,
  helper:        55,
  subcontractor: 70,
};

/**
 * Read a worker's target $/hr from settings, with PD-anchored
 * fallback. Accepts the full settings array (already in-memory in
 * the store) so this is a synchronous lookup per render.
 */
export function workerRate(
  kind: WorkerKind,
  settings: Setting[],
): number {
  const key = WORKER_RATE_SETTING_KEYS[kind];
  const setting = settings.find((s) => s.key === key);
  const raw = setting?.value;
  if (!raw) return DEFAULT_WORKER_RATES[kind];
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WORKER_RATES[kind];
}

/**
 * Return all 5 worker rates as a record, applying settings overrides
 * where present. Useful for the Settings UI and for the blended-target
 * calculation.
 */
export function allWorkerRates(settings: Setting[]): Record<WorkerKind, number> {
  return {
    owner:         workerRate('owner', settings),
    experienced:   workerRate('experienced', settings),
    apprentice:    workerRate('apprentice', settings),
    helper:        workerRate('helper', settings),
    subcontractor: workerRate('subcontractor', settings),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Blended-target math
// ──────────────────────────────────────────────────────────────────────────

/**
 * Hours-on-the-job broken down by who did them.
 *   - byWorker.owner       : sum of `hours` from entries where workerKind = 'owner'
 *   - byWorker.helper      : sum of `hours` from helper-kind entries
 *                             PLUS sum of `helperHours` from owner entries
 *   - (etc for other tiers)
 *
 * Total labour hours = sum across all tiers. This is what the PD's
 * rates were designed to predict, and what the gauge should reason
 * about — not the wall-clock hours one person was on site.
 */
export interface HoursByWorker {
  byWorker: Record<WorkerKind, number>;
  totalLabourHours: number;
}

/**
 * Given the hours-type entries for a job, split them by worker kind.
 * Honours the convenience `helperHours` field on owner entries
 * (those add to the helper bucket without needing a separate row).
 *
 * Note: this expects ALREADY-FILTERED hours entries (i.e. the caller
 * has done `entries.filter(e => e.type === 'hours')`). Keeps this
 * helper independent of the wider Entry shape.
 */
export function hoursByWorker(
  hoursEntries: Array<{
    hours?: number;
    workerKind?: WorkerKind;
    helperHours?: number;
  }>,
): HoursByWorker {
  const byWorker: Record<WorkerKind, number> = {
    owner: 0, experienced: 0, apprentice: 0, helper: 0, subcontractor: 0,
  };
  for (const e of hoursEntries) {
    const h = e.hours ?? 0;
    const kind: WorkerKind = e.workerKind ?? 'owner';
    byWorker[kind] += h;
    // Convenience: helperHours on an owner entry adds to the helper tier.
    if (e.helperHours && e.helperHours > 0) {
      byWorker.helper += e.helperHours;
    }
  }
  const totalLabourHours =
    byWorker.owner + byWorker.experienced + byWorker.apprentice + byWorker.helper + byWorker.subcontractor;
  return { byWorker, totalLabourHours };
}

/**
 * Weighted average target $/hr across the actual labour mix on this
 * job. Returns null when no hours have been logged (gauge target stays
 * at the owner-rate default in that case).
 *
 * Example: 8h owner + 6h helper, at default rates ($90, $55):
 *   blended = (8 × 90 + 6 × 55) / (8 + 6) = (720 + 330) / 14 = $75/hr
 *
 * So a 14-hour two-person day should land around $75/hr to be "on
 * target". $197/hr is well above — good outcome, deserved win.
 */
export function blendedTargetRate(
  mix: HoursByWorker,
  rates: Record<WorkerKind, number>,
): number | null {
  if (mix.totalLabourHours <= 0) return null;
  const weighted =
    mix.byWorker.owner         * rates.owner
  + mix.byWorker.experienced   * rates.experienced
  + mix.byWorker.apprentice    * rates.apprentice
  + mix.byWorker.helper        * rates.helper
  + mix.byWorker.subcontractor * rates.subcontractor;
  return weighted / mix.totalLabourHours;
}

/**
 * Plain-English description of the labour mix, suitable for the gauge
 * subtitle. Skips zero buckets. Examples:
 *   "11h you"
 *   "8h you + 6h helper"
 *   "4h you + 2h apprentice + 2h helper"
 */
export function describeMix(mix: HoursByWorker): string {
  const parts: string[] = [];
  const round = (n: number) => Math.round(n * 10) / 10;
  if (mix.byWorker.owner         > 0) parts.push(`${round(mix.byWorker.owner)}h you`);
  if (mix.byWorker.experienced   > 0) parts.push(`${round(mix.byWorker.experienced)}h experienced`);
  if (mix.byWorker.apprentice    > 0) parts.push(`${round(mix.byWorker.apprentice)}h apprentice`);
  if (mix.byWorker.helper        > 0) parts.push(`${round(mix.byWorker.helper)}h helper`);
  if (mix.byWorker.subcontractor > 0) parts.push(`${round(mix.byWorker.subcontractor)}h subbie`);
  return parts.join(' + ') || '0h';
}

/** Friendly display labels for the WorkerKind enum. */
export const WORKER_KIND_LABELS: Record<WorkerKind, string> = {
  owner:         'Me (owner)',
  experienced:   'Experienced painter',
  apprentice:    'Apprentice',
  helper:        'Helper / labourer',
  subcontractor: 'Subcontractor',
};
