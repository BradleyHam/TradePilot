// Live tax estimator for Lakeside Painting Ltd.
//
// Goal: produce a glanceable "where am I sitting for tax this year" number
// that updates as Brad logs entries. Not a substitute for an accountant —
// it's for the 5:30pm "am I going to be OK in April" gut check.
//
// All maths is ex-GST. NZ tax year = 1 Apr → 31 Mar.
//
// The deduction assumptions are constants here for now. Once Layer 2 (a
// settings UI) ships, we'll move them to a user-editable table and read them
// from the store instead.

import type { Entry, Setting } from './types';

// ── Tax-year helpers ─────────────────────────────────────────────────────────
export interface TaxYear {
  /** ISO YYYY-MM-DD inclusive. e.g. '2025-04-01'. */
  start: string;
  /** ISO YYYY-MM-DD inclusive. e.g. '2026-03-31'. */
  end: string;
  /** Display label, e.g. '2025/26'. */
  label: string;
}

/** Returns the NZ tax year that contains the given date. */
export function taxYearOf(date: Date = new Date()): TaxYear {
  const y = date.getFullYear();
  // April 1 → March 31. If we're in Jan/Feb/Mar, the tax year started the prior April.
  const startYear = date.getMonth() < 3 ? y - 1 : y;
  return taxYearStartingIn(startYear);
}

/** Build a TaxYear given the calendar year it STARTS in (April). */
export function taxYearStartingIn(startYear: number): TaxYear {
  return {
    start: `${startYear}-04-01`,
    end:   `${startYear + 1}-03-31`,
    label: `${String(startYear).slice(-2)}/${String(startYear + 1).slice(-2)}`,
  };
}

/** Returns the NZ tax year that finished immediately before `date`. */
export function previousTaxYearOf(date: Date = new Date()): TaxYear {
  const cur = taxYearOf(date);
  return taxYearStartingIn(parseInt(cur.start.slice(0, 4), 10) - 1);
}

/** How many days into the tax year `now` is. Clamped to [0, daysInYear]. */
export function daysIntoTaxYear(ty: TaxYear, now: Date = new Date()): { elapsed: number; total: number } {
  const startMs = new Date(ty.start + 'T00:00:00').getTime();
  const endMs   = new Date(ty.end   + 'T23:59:59').getTime();
  const total = Math.round((endMs - startMs) / 86_400_000);
  const elapsed = Math.max(0, Math.min(total, Math.round((now.getTime() - startMs) / 86_400_000)));
  return { elapsed, total };
}

// ── Deduction assumptions ────────────────────────────────────────────────────
// These are Brad-specific defaults derived from our tax conversation. The
// actual income/expenses come from entries; these add the under-claimed bits
// that don't appear as line items.

export interface DeductionAssumptions {
  /** Annual claim — pro-rated by elapsed days in the tax year. */
  vehicleKmAnnual: number;       // $5,350 (capped per actual cost incl dep)
  homeAndShedAnnual: number;     // 7% of $26k household = $1,820
  phoneInternetUpliftAnnual: number; // ~$1,253
  laptopDepreciationAnnual: number;  // $1,600
}

export const DEFAULT_DEDUCTIONS: DeductionAssumptions = {
  vehicleKmAnnual:           5_350,
  homeAndShedAnnual:         1_820,
  phoneInternetUpliftAnnual: 1_253,
  laptopDepreciationAnnual:  1_600,
};

export function totalAnnualExtraDeductions(d: DeductionAssumptions): number {
  return d.vehicleKmAnnual + d.homeAndShedAnnual + d.phoneInternetUpliftAnnual + d.laptopDepreciationAnnual;
}

// ── Income tax bands (NZ personal, 2025/26) ──────────────────────────────────
// Used because Brad will reclassify drawings as shareholder salary at year-end.
// Company tax (28%) doesn't apply when all profit becomes salary.

interface Band { upTo: number; rate: number; }
const PERSONAL_TAX_BANDS: Band[] = [
  { upTo: 14_000,  rate: 0.105 },
  { upTo: 48_000,  rate: 0.175 },
  { upTo: 70_000,  rate: 0.30  },
  { upTo: 180_000, rate: 0.33  },
  { upTo: Infinity, rate: 0.39 },
];

export function personalTax(taxableIncome: number): number {
  let remaining = Math.max(0, taxableIncome);
  let last = 0;
  let total = 0;
  for (const b of PERSONAL_TAX_BANDS) {
    const portion = Math.min(remaining, b.upTo - last);
    if (portion <= 0) break;
    total += portion * b.rate;
    remaining -= portion;
    last = b.upTo;
  }
  return total;
}

// ── Per-entry GST/ex-GST extraction ──────────────────────────────────────────
// Same approach as lib/job-stats.ts — prefer the explicit ex-GST column,
// derive from gross + gstApplies otherwise.
const NZ_GST_RATE = 0.15;

function entryExGst(e: Entry): number {
  if (e.amountExGst != null) return e.amountExGst;
  if (e.amount == null) return 0;
  return e.gstApplies ? e.amount / (1 + NZ_GST_RATE) : e.amount;
}

function entryGst(e: Entry): number {
  if (e.gstComponent != null) return e.gstComponent;
  if (e.amount == null || !e.gstApplies) return 0;
  return e.amount - e.amount / (1 + NZ_GST_RATE);
}

function inRange(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}

// ── Main estimate ────────────────────────────────────────────────────────────
export interface TaxEstimate {
  taxYear: TaxYear;
  /** Days elapsed in the tax year (for pro-rating annual deductions). */
  elapsedDays: number;
  totalDays: number;

  // GST
  gstOutput: number;        // GST collected from clients
  gstInput: number;         // GST claimable on expenses + paid bills
  gstNet: number;           // Output - input (positive = owe IRD; negative = refund)

  // Income side (all ex-GST)
  income: number;           // Money received this tax year
  expensesLogged: number;   // Expense entries + paid bills, ex-GST
  extraDeductions: number;  // Pro-rated deductions for elapsed period
  taxableProfit: number;    // income - expensesLogged - extraDeductions

  // Tax bill
  incomeTax: number;        // Personal tax on taxable profit (assumes salary reclassification)

  // Useful breakdown for the expanded card
  deductionBreakdown: {
    vehicle: number;
    homeAndShed: number;
    phoneInternet: number;
    laptopDep: number;
  };
}

export function estimateTax(
  entries: Entry[],
  now: Date = new Date(),
  ty: TaxYear = taxYearOf(now),
  deductions: DeductionAssumptions = DEFAULT_DEDUCTIONS,
): TaxEstimate {
  const yearEntries = entries.filter((e) =>
    e.entryDate && inRange(e.entryDate, ty.start, ty.end),
  );

  // Income (incl GST and ex-GST)
  let gstOutput = 0;
  let income = 0;
  for (const e of yearEntries) {
    if (e.type !== 'income') continue;
    income    += entryExGst(e);
    gstOutput += entryGst(e);
  }

  // Expenses + paid bills only (unpaid bills aren't a real cash outflow yet
  // for tax purposes on a payments-basis GST registration, which is the
  // default for small NZ businesses).
  // Drafts (unconfirmed bills from the PDF parser) are skipped — they're
  // not real cash outflows or real GST claims until Brad confirms them on
  // Home. Letting them count here would mis-estimate income tax AND mis-
  // estimate GST owed, both of which would mislead Brad's provisional-tax
  // planning.
  let gstInput = 0;
  let expensesLogged = 0;
  for (const e of yearEntries) {
    if (e.isDraft) continue;
    if (e.type === 'expense') {
      expensesLogged += entryExGst(e);
      gstInput       += entryGst(e);
    } else if (e.type === 'bill' && e.paid) {
      expensesLogged += entryExGst(e);
      gstInput       += entryGst(e);
    }
  }

  const { elapsed, total } = daysIntoTaxYear(ty, now);
  const proRate = total > 0 ? elapsed / total : 0;

  const dedBreakdown = {
    vehicle:       deductions.vehicleKmAnnual           * proRate,
    homeAndShed:   deductions.homeAndShedAnnual         * proRate,
    phoneInternet: deductions.phoneInternetUpliftAnnual * proRate,
    laptopDep:     deductions.laptopDepreciationAnnual  * proRate,
  };
  const extraDeductions = dedBreakdown.vehicle + dedBreakdown.homeAndShed
    + dedBreakdown.phoneInternet + dedBreakdown.laptopDep;

  const taxableProfit = Math.max(0, income - expensesLogged - extraDeductions);
  const incomeTax = personalTax(taxableProfit);

  return {
    taxYear: ty,
    elapsedDays: elapsed,
    totalDays: total,
    gstOutput,
    gstInput,
    gstNet: gstOutput - gstInput,
    income,
    expensesLogged,
    extraDeductions,
    taxableProfit,
    incomeTax,
    deductionBreakdown: dedBreakdown,
  };
}

// Settings is reserved for future use — once the deduction assumptions move
// into the settings table, this is where we'll read them from.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _settingsHook(_settings: Setting[]): DeductionAssumptions {
  return DEFAULT_DEDUCTIONS;
}
