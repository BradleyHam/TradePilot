/**
 * Payroll period + IRD deadline math. Pure functions, no I/O.
 *
 * Suzie is paid FORTNIGHTLY at an hourly rate (confirmed July 2026:
 * ~25 hrs/week @ $35/hr target). Gross for a period = her logged hours
 * in that period × rate — pay matches timesheets, which is exactly the
 * evidence trail IRD wants for the income-splitting arrangement.
 *
 * Nothing here is stored: pending periods are derived from the cycle
 * anchor every render, and become `pay_runs` rows only when Brad marks
 * them paid. Settings overrides (all optional, stored in `settings`):
 *
 *   payroll_anchor     — ISO date of the FIRST period start.
 *                        Default 2026-06-15 (Suzie's confirmed employee
 *                        start date).
 *   payroll_cycle_days — period length. Default 14.
 *   payroll_wage_rate  — $/hr gross. Default 35.
 *   payroll_payday_anchor — one real payday in the fortnightly cycle.
 *                        Default 2026-08-19 (Suzie's latest confirmed pay).
 *
 * IRD obligations encoded here (small employer, < $500k PAYE/yr):
 *   - Employment information (payday filing): due within 2 WORKING DAYS
 *     of each pay day when filing electronically via myIR.
 *   - PAYE remittance: all PAYE for pay days in month M due by the
 *     20th of month M+1.
 * If IRD changes these rules, this file is the single place to fix.
 */

import type { Entry, PayRun, Setting } from './types';

export const PAYROLL_DEFAULTS = {
  anchorISO: '2026-06-15',
  cycleDays: 14,
  wageRate: 35,
  paydayAnchorISO: '2026-08-19',
} as const;

export interface PayrollConfig {
  anchorISO: string;
  cycleDays: number;
  wageRate: number;
  paydayAnchorISO: string;
}

export interface PayPeriod {
  /** ISO date, inclusive. */
  start: string;
  /** ISO date, inclusive (start + cycleDays - 1). */
  end: string;
}

export interface PeriodHours {
  /** Hours entries the employee logged herself (logged_by_user_id). */
  own: number;
  /**
   * LEGACY ONLY: helperHours riding on someone else's entries — the old
   * "+ helper hrs" convenience field, removed from the entry form July
   * 2026. Employees log their own hours from /my/hours and payroll pays
   * from `own` exclusively. Legacy hours are still counted here so a
   * pay period spanning the switchover doesn't silently drop time; the
   * flag UI calls them out when present.
   */
  legacyHelper: number;
  total: number;
}

// ── Date helpers (string-safe, local-midnight — matches lib/format-date) ───

function parseISO(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00`);
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(iso: string, n: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

// ── Config ─────────────────────────────────────────────────────────────────

export function payrollConfig(settings: Setting[]): PayrollConfig {
  const get = (key: string) => settings.find((s) => s.key === key)?.value;
  const num = (v: string | undefined, fallback: number) => {
    const n = v != null ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const anchor = get('payroll_anchor');
  const paydayAnchor = get('payroll_payday_anchor');
  return {
    anchorISO: anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : PAYROLL_DEFAULTS.anchorISO,
    cycleDays: num(get('payroll_cycle_days'), PAYROLL_DEFAULTS.cycleDays),
    wageRate: num(get('payroll_wage_rate'), PAYROLL_DEFAULTS.wageRate),
    paydayAnchorISO: paydayAnchor && /^\d{4}-\d{2}-\d{2}$/.test(paydayAnchor)
      ? paydayAnchor
      : PAYROLL_DEFAULTS.paydayAnchorISO,
  };
}

// ── Periods ────────────────────────────────────────────────────────────────

/**
 * Periods that have fully ENDED as of `todayISO` (end < today), oldest
 * first. Capped to the most recent `cap` so a long-untouched app doesn't
 * render a wall of missed periods.
 */
export function completedPeriods(cfg: PayrollConfig, todayISO: string, cap = 6): PayPeriod[] {
  const out: PayPeriod[] = [];
  let start = cfg.anchorISO;
  // Hard stop keeps a bad anchor (e.g. year 1970) from spinning forever.
  for (let i = 0; i < 500; i++) {
    const end = addDays(start, cfg.cycleDays - 1);
    if (end >= todayISO) break;
    out.push({ start, end });
    start = addDays(start, cfg.cycleDays);
  }
  return out.slice(-cap);
}

/** The period containing `todayISO` (for the "next pay day" hint). */
export function currentPeriod(cfg: PayrollConfig, todayISO: string): PayPeriod | null {
  let start = cfg.anchorISO;
  if (todayISO < start) return null;
  for (let i = 0; i < 500; i++) {
    const end = addDays(start, cfg.cycleDays - 1);
    if (todayISO >= start && todayISO <= end) return { start, end };
    if (start > todayISO) return null;
    start = addDays(start, cfg.cycleDays);
  }
  return null;
}

/**
 * The first scheduled fortnightly payday after a period ends. The anchor is
 * one payday Brad actually used; stepping in whole cycles keeps the reminder
 * stable even when a previous transfer happened a day early or late.
 */
export function scheduledPaydayForPeriod(cfg: PayrollConfig, period: PayPeriod): string {
  let payday = cfg.paydayAnchorISO;
  for (let i = 0; i < 500; i++) {
    const previous = addDays(payday, -cfg.cycleDays);
    if (previous <= period.end) break;
    payday = previous;
  }
  for (let i = 0; i < 500 && payday <= period.end; i++) {
    payday = addDays(payday, cfg.cycleDays);
  }
  return payday;
}

/** Has this period already been covered by a pay run for this member? */
export function periodIsPaid(payRuns: PayRun[], memberId: string | undefined, period: PayPeriod): boolean {
  return payRuns.some((p) =>
    p.periodStart === period.start
    && (p.memberId == null || memberId == null || p.memberId === memberId),
  );
}

// ── Hours ──────────────────────────────────────────────────────────────────

/**
 * The employee's hours inside a period. Payroll's source of truth is the
 * hours SHE logged herself (`logged_by_user_id`) — the "+ helper hrs"
 * convenience field was retired from the entry form in July 2026.
 * `legacyHelper` only picks up leftover helperHours on old entries so a
 * period spanning the switchover doesn't drop time; the flag UI surfaces
 * it separately so Brad can check for a double-up before paying.
 */
export function employeeHoursInPeriod(
  entries: Entry[],
  employeeUserId: string | undefined,
  period: PayPeriod,
): PeriodHours {
  let own = 0;
  let legacyHelper = 0;
  for (const e of entries) {
    if (e.type !== 'hours') continue;
    if (e.entryDate < period.start || e.entryDate > period.end) continue;
    if (employeeUserId && e.loggedByUserId === employeeUserId) {
      own += e.hours ?? 0;
    } else if ((e.helperHours ?? 0) > 0) {
      legacyHelper += e.helperHours ?? 0;
    }
  }
  return { own, legacyHelper, total: own + legacyHelper };
}

// ── IRD deadlines ──────────────────────────────────────────────────────────

/** PAYE for a pay day in month M is due the 20th of month M+1. */
export function payeDueDate(paidDateISO: string): string {
  const d = parseISO(paidDateISO);
  let due = toISO(new Date(d.getFullYear(), d.getMonth() + 1, 20));
  // IRD rolls a weekend due date to the next working day. This is why the
  // August 2026 PAYE assessment is due Monday 21 September, not Sunday 20th.
  while ([0, 6].includes(parseISO(due).getDay())) due = addDays(due, 1);
  return due;
}

/** Payday employment information is due 2 working days after the pay day. */
export function eiFilingDueDate(paidDateISO: string): string {
  let iso = paidDateISO;
  let added = 0;
  while (added < 2) {
    iso = addDays(iso, 1);
    const dow = parseISO(iso).getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return iso;
}

/**
 * Group PAID pay runs by the PAYE month they belong to → one reminder per
 * month. Returns months with at least one run not yet marked payePaid,
 * oldest first.
 */
export interface PayeMonthDue {
  /** "2026-07" */
  monthKey: string;
  dueDate: string;
  runs: PayRun[];
  /** Sum of recorded `paye` values; null when any run is missing one. */
  payeTotal: number | null;
  grossTotal: number;
}

export function payeMonthsDue(payRuns: PayRun[]): PayeMonthDue[] {
  const byMonth = new Map<string, PayRun[]>();
  for (const p of payRuns) {
    if (!p.paid || !p.paidDate || p.payePaid) continue;
    const key = p.paidDate.slice(0, 7);
    const list = byMonth.get(key);
    if (list) list.push(p); else byMonth.set(key, [p]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monthKey, runs]) => {
      const allHavePaye = runs.every((r) => r.paye != null);
      return {
        monthKey,
        dueDate: payeDueDate(`${monthKey}-01`),
        runs,
        payeTotal: allHavePaye ? runs.reduce((s, r) => s + (r.paye ?? 0), 0) : null,
        grossTotal: runs.reduce((s, r) => s + r.gross, 0),
      };
    });
}
