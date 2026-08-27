'use client';

/**
 * Per-job visualisations for the JobDetailSheet.
 *
 * Four components, one file:
 *   - OwnerRateMeter:    did an hour of MY time on this pay?
 *   - MoneySplitBar:     where did the job's money actually go?
 *   - HoursByActivity:   where is the time going?
 *   - HoursByPerson:     whose hours were they, and what did they earn?
 *
 * ## The rate these charts talk about
 *
 * They used to lead with revenue ÷ everyone's hours — $4,000 over 64h of
 * owner + employee + subbie time = "$63/h". That number belongs to nobody:
 * it isn't Brad's rate, it isn't the crew's, and it moves the wrong way when
 * he puts more people on a job. A blended target had to be invented just to
 * judge it against something.
 *
 * Now that `jobStats` charges wages and sub labour to the job, the honest
 * question has a one-line answer: what's left over, divided by the owner's
 * own hours, judged against the owner's own target rate. No blend needed.
 *
 * All hide gracefully when there's no data. Pure SVG + Tailwind — no chart lib.
 *
 * ## Colour
 *
 * One money palette across both charts, so a colour means the same thing
 * wherever it appears: rose = materials, amber = subbies and helpers,
 * blue = wages, green = the owner's share. Validated for colour-blind
 * separation in both light and dark surfaces (adjacent-pair ΔE ≥ 8 OKLab),
 * which is why the segments and rows are ordered the way they are — rose
 * next to amber, or amber next to green, is the pairing that fails. Every
 * mark carries a text label as well, so identity never rests on hue.
 */

import type { BusinessMember, Entry } from '@/lib/types';
import type { JobStats } from '@/lib/job-stats';
import type { PayBasis } from '@/lib/job-people';
import { jobPeopleBreakdown } from '@/lib/job-people';
import { cn } from '@/lib/utils';

const money = (n: number) => `$${Math.round(n).toLocaleString('en-NZ')}`;
const hrs = (n: number) => `${Math.round(n * 10) / 10}h`;

/** Tailwind fills for the shared money palette, light + dark steps. */
const FILL: Record<'materials' | 'contractors' | 'wages' | 'owner', string> = {
  materials:   'bg-rose-500 dark:bg-rose-600',
  contractors: 'bg-amber-500 dark:bg-amber-600',
  wages:       'bg-blue-500',
  owner:       'bg-green-500 dark:bg-green-600',
};

// ─── Owner rate meter ────────────────────────────────────────────────────────
// A single ratio against a limit, which wants a meter rather than a dial:
// one bar, one target marker, and the number itself as the hero. Replaces
// the 200px gauge and the blended-target machinery behind it.

interface OwnerRateMeterProps {
  /** `stats.ownerRate` — profit ÷ the owner's own hours. */
  ownerRate: number | null;
  ownerHours: number;
  /** `stats.expectedProfit`. */
  profit: number;
  /** The owner's target $/hr — `workerRate('owner', settings)`. */
  target: number;
  /** True while the income is still expected rather than banked. */
  isExpected?: boolean;
  /** Someone else was on this job, so it's worth saying they're paid first. */
  hasCrew?: boolean;
}

export function OwnerRateMeter({
  ownerRate, ownerHours, profit, target, isExpected = false, hasCrew = false,
}: OwnerRateMeterProps) {
  // No owner hours = no owner rate. The profit tile already says what the
  // job made; inventing a rate from someone else's time would be a lie.
  if (ownerRate == null || ownerHours <= 0) return null;

  let status: string;
  let statusText: string;
  let fill: string;
  if (ownerRate >= target) {
    status = 'On target'; statusText = 'text-green-600'; fill = 'bg-green-500 dark:bg-green-600';
  } else if (ownerRate >= target * 0.8) {
    status = 'Below target'; statusText = 'text-amber-600'; fill = 'bg-amber-500 dark:bg-amber-600';
  } else if (ownerRate > 0) {
    status = 'Off the pace'; statusText = 'text-red-500'; fill = 'bg-red-500';
  } else {
    status = 'Lost money'; statusText = 'text-red-500'; fill = 'bg-red-500';
  }

  // Scale so the target marker always sits comfortably inside the track and
  // a big result still fits without pinning.
  const max = Math.max(target * 1.4, ownerRate * 1.15, 1);
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;

  // What would have closed the gap. Two levers, both true at once: charge
  // more, or spend less of your own time on it.
  const shortfall = target - ownerRate;
  const extraRevenue = target * ownerHours - profit;
  const hoursToSave = ownerHours - profit / target;

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-semibold text-foreground">
          {isExpected ? 'Your expected rate' : 'Your rate on this job'}
        </p>
        <p className={cn('text-xs font-medium', statusText)}>{status}</p>
      </div>

      <p className="text-3xl font-bold text-foreground leading-none">
        {money(ownerRate)}<span className="text-base font-medium text-muted-foreground">/h</span>
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {hrs(ownerHours)} of your time{hasCrew ? ', once everyone else is paid' : ''}
      </p>

      <div className="relative mt-3 h-3 w-full rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', fill)} style={{ width: pct(Math.max(0, ownerRate)) }} />
      </div>
      {/* Target marker rides outside the clipped track so its label can sit
          under the tick without being cut off. */}
      <div className="relative h-4">
        <div className="absolute -top-3 w-px h-3 bg-foreground/70" style={{ left: pct(target) }} />
        <span className="absolute top-0 text-[10px] text-muted-foreground -translate-x-1/2 whitespace-nowrap" style={{ left: pct(target) }}>
          target {money(target)}
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        {shortfall > 0 ? (
          <>
            <span className="font-medium text-foreground">{money(extraRevenue)} more on the price</span>
            {hoursToSave > 0.2 ? <> — or {hrs(hoursToSave)} less of your own time — </> : <> </>}
            would have made this a {money(target)}/h job.
          </>
        ) : (
          <>Clear of your {money(target)}/h target by {money(-shortfall)} an hour.</>
        )}
      </p>
    </div>
  );
}

// ─── Money split ─────────────────────────────────────────────────────────────
// Part-to-whole, four named parts: a horizontal stacked bar with a labelled
// legend. Answers "who got what" in one line — the old Job budget bar showed
// expenses vs profit, which hid every person inside the word "expenses".

interface MoneySplitBarProps {
  stats: JobStats;
}

export function MoneySplitBar({ stats }: MoneySplitBarProps) {
  const { expectedIncome, materialsCost, contractorLabourCost, payrollLabourCost, expectedProfit } = stats;
  if (expectedIncome <= 0 && stats.totalExpenses <= 0) return null;

  const overrun = expectedProfit < 0;
  // When the job lost money there's no owner slice to draw — scale the
  // costs to themselves and say by how much they overshot.
  const denominator = overrun ? stats.totalExpenses : Math.max(expectedIncome, 1);

  const segments = [
    { key: 'materials'   as const, label: 'Materials',  value: materialsCost },
    { key: 'contractors' as const, label: 'Subbies',    value: contractorLabourCost },
    { key: 'wages'       as const, label: 'Wages',      value: payrollLabourCost },
    { key: 'owner'       as const, label: 'You',        value: overrun ? 0 : expectedProfit },
  ].filter((seg) => seg.value > 0.5);

  if (segments.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-sm font-semibold text-foreground">
          {/* Naming the figure makes the bar self-explanatory — but only
              when there IS one. A job with costs and no price yet gets the
              generic title rather than "Where the $0 went". */}
          {expectedIncome > 0 ? <>Where the {money(expectedIncome)} went</> : 'Where the money went'}
        </p>
        {overrun && (
          <p className="text-xs font-medium text-red-500">Over by {money(-expectedProfit)}</p>
        )}
      </div>

      <div className="flex gap-[2px] h-7 w-full rounded-full overflow-hidden bg-muted">
        {segments.map((seg) => (
          <div
            key={seg.key}
            className={cn('h-full transition-all', FILL[seg.key])}
            style={{ width: `${(seg.value / denominator) * 100}%` }}
            title={`${seg.label}: ${money(seg.value)}`}
          />
        ))}
      </div>

      {/* Legend doubles as the value table — every segment is named and
          priced, which is what lets the lighter fills carry their weight. */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {segments.map((seg) => (
          <div key={seg.key} className="flex items-center gap-1.5 text-xs min-w-0">
            <span className={cn('w-2 h-2 rounded-full shrink-0', FILL[seg.key])} />
            <span className="text-muted-foreground truncate">{seg.label}</span>
            <span className="flex-1" />
            <span className="font-medium text-foreground tabular-nums shrink-0">{money(seg.value)}</span>
            <span className="text-muted-foreground tabular-nums shrink-0 w-8 text-right">
              {Math.round((seg.value / denominator) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Hours by activity ───────────────────────────────────────────────────────
// Horizontal bars sorted descending. One bar per activity that has at least
// one logged hour.

interface HoursByActivityProps {
  entries: Entry[];
}

const ACTIVITY_LABEL: Record<string, string> = {
  prep: 'Prep',
  painting: 'Painting',
  staining: 'Staining',
  wallpapering: 'Wallpapering',
  stopping: 'Stopping',
  primer: 'Primer',
  repair: 'Repair',
  cleanup: 'Cleanup',
  travel: 'Travel',
  quoting: 'Quoting',
  admin: 'Admin',
  website: 'Website',
  marketing: 'Marketing',
  training: 'Training',
};

export function HoursByActivity({ entries }: HoursByActivityProps) {
  // Only hours-type entries, group by activity
  const byActivity = new Map<string, number>();
  let total = 0;
  for (const e of entries) {
    if (e.type !== 'hours' || e.hours == null) continue;
    const key = e.activity ?? 'unspecified';
    byActivity.set(key, (byActivity.get(key) ?? 0) + e.hours);
    total += e.hours;
  }

  if (total === 0) return null;

  const rows = Array.from(byActivity.entries())
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-sm font-semibold text-foreground">Hours by activity</p>
        <p className="text-xs text-muted-foreground">{total}h total</p>
      </div>

      <div className="space-y-2">
        {rows.map(([activity, hours]) => {
          const pct = (hours / total) * 100;
          const label = ACTIVITY_LABEL[activity] ?? activity.charAt(0).toUpperCase() + activity.slice(1);
          return (
            <div key={activity} className="flex items-center gap-2.5">
              <span className="text-xs text-muted-foreground w-20 shrink-0 truncate">{label}</span>
              <div className="flex-1 h-5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all rounded-full"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs font-medium text-foreground w-12 text-right shrink-0 tabular-nums">
                {hours}h
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Hours by person ─────────────────────────────────────────────────────────
// Who was actually on this job, and what they took off it. Sits under
// "Hours by activity": that one says what the time went into, this one says
// whose time it was. Bars are hours (magnitude); the $ beside each is the
// money that person's hours turned into, which is a different number for
// each of the three ways someone gets paid — see lib/job-people.ts.
//
// Owner bar is amber, crew blue. Every row is directly labelled with a name,
// so identity never rests on colour alone.

interface HoursByPersonProps {
  /** All the job's entries — hours rows are filtered out here. */
  entries: Entry[];
  teamMembers: BusinessMember[];
  viewerUserId?: string | null;
  /** Payroll gross $/hr — `payrollConfig(settings).wageRate`. */
  wageRate: number;
  /** `stats.expectedProfit`, or null when the job has no income figure. */
  expectedProfit: number | null;
}

const BASIS_NOTE: Record<PayBasis, string> = {
  owner:   'your share',
  wages:   'wages',
  invoice: 'invoiced',
  unknown: 'rate not set',
};

/** Same hues as the money split, so "blue" means wages on both charts. */
const BASIS_FILL: Record<PayBasis, string> = {
  owner:   FILL.owner,
  wages:   FILL.wages,
  invoice: FILL.contractors,
  unknown: 'bg-muted-foreground/40',
};

export function HoursByPerson({
  entries, teamMembers, viewerUserId, wageRate, expectedProfit,
}: HoursByPersonProps) {
  const hoursEntries = entries.filter((e) => e.type === 'hours');
  const { rows, totalHours, crewCost, legacyHelperHours } = jobPeopleBreakdown({
    hoursEntries, teamMembers, viewerUserId, wageRate, expectedProfit,
  });

  // Nothing to show on a solo job — "Me 64h, 100%" is a bar chart of one
  // fact the Hours tile already states.
  if (totalHours <= 0 || rows.length < 2) return null;

  const ownerRow = rows.find((r) => r.isOwner);
  const unpriced = rows.reduce((s, r) => s + r.unpricedHours, 0);

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-sm font-semibold text-foreground">Hours by person</p>
        <p className="text-xs text-muted-foreground">
          {rows.length} on site · {hrs(totalHours)}
        </p>
      </div>

      <div className="space-y-3">
        {rows.map((r) => {
          const pct = (r.hours / totalHours) * 100;
          const negative = r.earned != null && r.earned < 0;
          return (
            <div key={r.key} className="space-y-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium text-foreground truncate">{r.label}</span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide shrink-0">
                  {BASIS_NOTE[r.basis]}
                </span>
                <span className="flex-1" />
                <span
                  className={cn(
                    'text-xs font-semibold tabular-nums shrink-0',
                    r.earned == null
                      ? 'text-muted-foreground'
                      : negative
                        ? 'text-red-500'
                        : r.isOwner
                          ? 'text-green-600'
                          : 'text-foreground',
                  )}
                >
                  {r.earned == null ? '—' : money(r.earned)}
                </span>
              </div>

              <div className="flex items-center gap-2.5">
                <div className="flex-1 h-5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={cn('h-full rounded-full transition-all', BASIS_FILL[r.basis])}
                    style={{ width: `${pct}%` }}
                    title={`${r.label}: ${hrs(r.hours)}${r.earned != null ? ` · ${money(r.earned)}` : ''}`}
                  />
                </div>
                <span className="text-xs font-medium text-foreground w-12 text-right shrink-0 tabular-nums">
                  {hrs(r.hours)}
                </span>
              </div>

              {/* Second line only where there's something honest to add. */}
              {r.isOwner && r.effectiveRate != null && (
                <p className="text-[11px] text-muted-foreground">
                  ${Math.round(r.effectiveRate)}/h for your time, after everyone else is paid
                </p>
              )}
              {r.unpricedHours > 0 && (
                <p className="text-[11px] text-amber-600">
                  {hrs(r.unpricedHours)} with no cost rate — add one on the entry to price it
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 pt-3 border-t border-border flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          Crew cost <span className="font-medium text-foreground">{money(crewCost)}</span>
        </span>
        {ownerRow?.earned != null && (
          <span className="text-muted-foreground">
            Left for you{' '}
            <span className={cn('font-medium', ownerRow.earned < 0 ? 'text-red-500' : 'text-green-600')}>
              {money(ownerRow.earned)}
            </span>
          </span>
        )}
      </div>

      {(unpriced > 0 || legacyHelperHours > 0) && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {legacyHelperHours > 0 && (
            <>Plus {hrs(legacyHelperHours)} of older helper hours logged on your own entries — not counted above. </>
          )}
          {unpriced > 0 && <>Crew cost excludes {hrs(unpriced)} of unpriced labour.</>}
        </p>
      )}
    </div>
  );
}
