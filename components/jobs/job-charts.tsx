'use client';

/**
 * Per-job visualisations for the JobDetailSheet.
 *
 * Three components, one file:
 *   - HourlyRateGauge:   are we hitting the target $/h?
 *   - IncomeVsExpenses:  how much of expected income is left as profit?
 *   - HoursByActivity:   where is the time going?
 *
 * All hide gracefully when there's no data. Pure SVG + Tailwind — no chart lib.
 */

import type { Entry } from '@/lib/types';
import type { JobStats } from '@/lib/job-stats';
import { cn } from '@/lib/utils';

// ─── Hourly rate gauge ───────────────────────────────────────────────────────
// Brad's target: $85–100/hr combined. Below $70 = red, $70–85 = amber,
// $85+ = green. We render a 180° arc with three coloured zones and a needle
// pointing at the actual rate.

const TARGET_LOW = 85;
const TARGET_HIGH = 100;
const ZONE_RED = 70;
const GAUGE_MIN = 0;
const GAUGE_MAX = 150;

interface HourlyRateGaugeProps {
  hourlyRate: number | null;
  /** When true, label says "Expected $/h" instead of "Hourly rate". */
  isExpected?: boolean;
}

export function HourlyRateGauge({ hourlyRate, isExpected = false }: HourlyRateGaugeProps) {
  if (hourlyRate == null) return null;

  // Gauge geometry: a 180° arc from (10,80) to (190,80) with radius 80, centred at (100,80).
  const W = 200;
  const H = 110;
  const CX = 100;
  const CY = 80;
  const R = 70;

  // Map a $/h value to an angle on the arc. 0° = left (180°), 180° = right (0°).
  // Math: angle = π * (1 - (value-min)/(max-min))
  const toRad = (value: number) => {
    const clamped = Math.max(GAUGE_MIN, Math.min(GAUGE_MAX, value));
    const t = (clamped - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN);
    return Math.PI * (1 - t);
  };

  const polar = (value: number, radius = R) => {
    const a = toRad(value);
    return { x: CX + radius * Math.cos(a), y: CY - radius * Math.sin(a) };
  };

  // Build a path for an arc segment between two values.
  function arcPath(from: number, to: number) {
    const start = polar(from);
    const end = polar(to);
    // 180° gauge so largeArc is always 0
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${R} ${R} 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  }

  // Needle endpoint
  const needle = polar(hourlyRate, R - 6);

  // Status text + colour
  let status: string;
  let statusColor: string;
  if (hourlyRate >= TARGET_LOW) {
    status = 'On target';
    statusColor = 'text-green-600';
  } else if (hourlyRate >= ZONE_RED) {
    status = 'Below target';
    statusColor = 'text-amber-600';
  } else {
    status = 'Off the pace';
    statusColor = 'text-red-500';
  }

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-semibold text-foreground">
          {isExpected ? 'Expected hourly rate' : 'Hourly rate'}
        </p>
        <p className={cn('text-xs font-medium', statusColor)}>{status}</p>
      </div>

      {/*
        Cap the gauge width on desktop. Without this, the SVG's `w-full h-auto`
        + 200×110 aspect ratio means a 1400px container yields a 770px-tall
        gauge — it ate the entire viewport on desktop. 360px fits a phone
        screen edge-to-edge while keeping the gauge a sensible size on a
        laptop or external display.
      */}
      <div className="relative mx-auto w-full max-w-[360px]">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" aria-hidden>
          {/* Zones */}
          <path d={arcPath(GAUGE_MIN, ZONE_RED)} stroke="#ef4444" strokeWidth="14" fill="none" strokeLinecap="butt" />
          <path d={arcPath(ZONE_RED, TARGET_LOW)} stroke="#f59e0b" strokeWidth="14" fill="none" strokeLinecap="butt" />
          <path d={arcPath(TARGET_LOW, GAUGE_MAX)} stroke="#22c55e" strokeWidth="14" fill="none" strokeLinecap="butt" />

          {/* Tick marks for the boundaries */}
          {[ZONE_RED, TARGET_LOW, TARGET_HIGH].map((v) => {
            const inner = polar(v, R - 14);
            const outer = polar(v, R + 2);
            return (
              <line
                key={v}
                x1={inner.x}
                y1={inner.y}
                x2={outer.x}
                y2={outer.y}
                stroke="currentColor"
                strokeWidth="1"
                className="text-card"
              />
            );
          })}

          {/* Needle */}
          <line
            x1={CX}
            y1={CY}
            x2={needle.x}
            y2={needle.y}
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="text-foreground"
          />
          <circle cx={CX} cy={CY} r={4} className="fill-foreground" />
        </svg>

        {/* Reading */}
        <div className="absolute inset-x-0 bottom-0 text-center">
          <p className="text-2xl font-bold text-foreground">${hourlyRate.toFixed(0)}<span className="text-sm font-medium text-muted-foreground">/h</span></p>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground text-center">
        Target $85–100/h · zones $0 – $70 – $85 – $150
      </p>
    </div>
  );
}

// ─── Income vs Expenses bar ──────────────────────────────────────────────────
// Horizontal bar showing expenses-so-far + projected profit, stacked, scaled
// to expected income. If expenses already exceed expected income we show the
// overrun in red.

interface IncomeVsExpensesProps {
  stats: JobStats;
}

export function IncomeVsExpenses({ stats }: IncomeVsExpensesProps) {
  const { totalExpenses, expectedIncome, expectedProfit } = stats;
  // Don't show on jobs with literally nothing yet
  if (totalExpenses === 0 && expectedIncome === 0) return null;

  const denominator = Math.max(expectedIncome, totalExpenses);
  if (denominator <= 0) return null;

  const expensePct = Math.min(100, (totalExpenses / denominator) * 100);
  const profitPct = expectedProfit > 0 ? (expectedProfit / denominator) * 100 : 0;
  const overruns = expectedProfit < 0;

  const fmt = (n: number) => `$${n.toLocaleString('en-NZ', { maximumFractionDigits: 0 })}`;

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-sm font-semibold text-foreground">Job budget</p>
        <p className="text-xs text-muted-foreground">
          {fmt(totalExpenses)} of {fmt(expectedIncome)}
        </p>
      </div>

      <div className="h-7 w-full rounded-full overflow-hidden flex bg-muted">
        <div
          className={cn('h-full transition-all', overruns ? 'bg-red-500' : 'bg-red-400')}
          style={{ width: `${expensePct}%` }}
          title={`Expenses: ${fmt(totalExpenses)}`}
        />
        {!overruns && (
          <div
            className="h-full bg-green-500 transition-all"
            style={{ width: `${profitPct}%` }}
            title={`Expected profit: ${fmt(expectedProfit)}`}
          />
        )}
      </div>

      <div className="flex items-center justify-between mt-2 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-400" />
          <span className="text-muted-foreground">Expenses</span>
          <span className="font-medium text-foreground">{fmt(totalExpenses)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {overruns ? (
            <>
              <span className="w-2 h-2 rounded-full bg-red-600" />
              <span className="font-medium text-red-600">Over by {fmt(Math.abs(expectedProfit))}</span>
            </>
          ) : (
            <>
              <span className="w-2 h-2 rounded-full bg-green-500" />
              <span className="text-muted-foreground">Profit</span>
              <span className="font-medium text-foreground">{fmt(expectedProfit)}</span>
            </>
          )}
        </div>
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
