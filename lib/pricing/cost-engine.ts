/**
 * Cost engine — turns a structured quote scope into estimated hours,
 * estimated cost, and a recommended price.
 *
 * Inputs: a list of `ScopeZone` rows (surface + prep + measurement). Plus
 * job-level context (access level, storey count if FPA-derived, customer
 * segment for the price recommendation layer).
 *
 * Outputs: `CostEstimate` — fully audit-trailed. Every dollar comes from
 * a Resene PD rate × measure × inflation factor × access uplift, and the
 * trail returned in `lineItems` lets us show the user EXACTLY why the
 * suggested price is what it is. No black-box numbers.
 *
 * ## Why the cost engine is separate from the rate library
 *
 * The rate library (`resene-rates.ts`) is reference data — pure values
 * lifted from the PD, plus FPA shortcuts. The cost engine is the logic
 * that combines those rates with a specific job's scope. Keeping them
 * separate means:
 *   - The rate library can be updated when a new PD edition comes out
 *     without touching the engine.
 *   - The engine can be unit-tested in isolation against fixed inputs.
 *   - When we eventually have per-painter calibrated rates (Brad's
 *     productivity overrides), the engine consumes them via the same
 *     interface — no rewrite needed.
 *
 * ## Price recommendation (vs cost estimation)
 *
 * The cost engine returns the COST-UP price — what the job will cost
 * Brad to deliver, plus the PD's built-in margin. That's the FLOOR.
 *
 * The RECOMMENDED price (revenue-maximising under win-probability)
 * lives in a separate layer (`recommendation.ts`, future). It takes
 * the cost-up price + customer segment + historical win/loss data and
 * suggests floor / recommended / stretch numbers. v1 of the
 * recommendation layer is heuristic; v2 fits a logistic on outcomes.
 */

import type { PrepLevel } from '@/lib/types';
import {
  RESENE_RATES,
  getRate,
  inflationFactor,
  rateKeyForExteriorRepaint,
  ACCESS_UPLIFT,
  PD_HOURLY_RATE_2022,
  type ReseneRate,
  type AccessLevel,
} from './resene-rates';

// ──────────────────────────────────────────────────────────────────────────
// Scope shape
// ──────────────────────────────────────────────────────────────────────────

/**
 * Surfaces the engine can price. Free-form enough to cover Brad's mix
 * without forcing the world into one of 6 buckets. Extend as needed.
 */
export type ScopeSurface =
  | 'interior-walls'
  | 'interior-ceilings'
  | 'interior-timber'
  | 'interior-trim'
  | 'interior-door'
  | 'cabinets'
  | 'weatherboards'
  | 'cedar'                  // oil-stain restain
  | 'linea'
  | 'hardiplank'
  | 'hardiflex'
  | 'concrete-smooth'
  | 'concrete-medium'
  | 'brickwork'
  | 'blockwork'
  | 'fascia'
  | 'soffit'
  | 'soffit-rafters'
  | 'exterior-windows'
  | 'exterior-doors'
  | 'roof-galv-corrugated'
  | 'roof-galv-tray'
  | 'roof-decramastic'
  | 'roof-clay-tiles'
  | 'deck-acrylic'
  | 'deck-oilstain'
  | 'fence';

/** Whether the work is a fresh paint (new) or a recoat (repaint). */
export type WorkKind = 'new' | 'repaint';

/**
 * One zone of work on a job. A typical exterior repaint might have:
 *   - { surface: 'weatherboards', kind: 'repaint', prep: 'medium', m2: 187 }
 *   - { surface: 'fascia', kind: 'repaint', prep: 'light', LM: 42 }
 *   - { surface: 'exterior-doors', kind: 'repaint', prep: 'medium', count: 2 }
 */
export interface ScopeZone {
  /** Display label — "North elevation cedar", "Lounge ceiling", etc. */
  name: string;
  surface: ScopeSurface;
  kind: WorkKind;
  /** Required for most zones; ignored for `each`-measured surfaces. */
  prep?: PrepLevel;
  /** m² measurement. Use this for flat surfaces (walls, roof, soffit). */
  m2?: number;
  /** Lineal metres. Use for trims, skirtings, fascia by length. */
  LM?: number;
  /** Count. Use for doors, windows-as-units. */
  count?: number;
  /** Free-form per-zone notes — surfaced in the cost-estimate breakdown. */
  notes?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Output shapes
// ──────────────────────────────────────────────────────────────────────────

export interface CostLineItem {
  zoneName: string;
  rate: ReseneRate;
  /** Quantity in the rate's measure unit (m² / LM / each). */
  quantity: number;
  /** PD raw rate × measure (no inflation, no uplift). */
  rawSubtotalExGst: number;
  /** After inflation factor + access uplift. */
  adjustedSubtotalExGst: number;
  /** Inflation factor applied to this line. */
  inflationFactorUsed: number;
  /** Access uplift applied to this line. */
  accessUpliftUsed: number;
  /** Brief explanation of how this line was priced (for the UI trail). */
  explanation: string;
}

export interface CostEstimate {
  /** Per-zone line items, in input order. */
  lineItems: CostLineItem[];
  /** Sum of raw PD rates × measures, ex-GST, pre-inflation, pre-uplift. */
  rawSubtotalExGst: number;
  /** After inflation + access uplift. This is the COST-UP recommended price. */
  totalExGst: number;
  /** + NZ 15% GST. The number you'd put on the invoice. */
  totalInclGst: number;
  /** Estimated total labour hours to deliver — useful for the calendar. */
  estimatedHours: number;
  /** Implied $/hr at the suggested price — sanity check vs PD's $64.59 floor. */
  impliedHourlyRate: number;
  /** Audit fields. */
  meta: {
    inflationFactor: number;
    accessLevel: AccessLevel;
    accessUplift: number;
    quotingYear: number;
    pdEdition: '11th';
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Surface → rate-key resolution
// ──────────────────────────────────────────────────────────────────────────

/**
 * Map a (surface, kind, prep) tuple to a Resene rate key. This is the
 * core mapping table — extend when adding new surfaces.
 *
 * For exterior repaints with prep variation we defer to
 * `rateKeyForExteriorRepaint()` which encodes the good/poor-condition
 * branching.
 */
function resolveRateKey(zone: ScopeZone): string {
  const { surface, kind, prep } = zone;

  // Cedar oil-stain restain is its own thing — PD has one rate.
  if (surface === 'cedar') return 'exterior-repaint.cedar.oilstain.recoat';

  // Exterior repaint branches by surface + prep.
  if (kind === 'repaint') {
    switch (surface) {
      case 'weatherboards':
      case 'hardiplank':
      case 'concrete-smooth':
      case 'concrete-medium':
      case 'brickwork':
      case 'blockwork':
        return rateKeyForExteriorRepaint(surface, prep ?? 'medium');

      case 'interior-walls':       return 'interior-repaint.walls.2coat';
      case 'interior-ceilings':    return prep === 'heavy' ? 'interior-repaint.ceiling.prep' : 'interior-repaint.ceiling.2coat';
      case 'interior-door':        return 'interior-repaint.doors.flush';
      case 'cabinets':             return 'interior-repaint.cabinets';
      case 'exterior-windows':     return 'exterior-repaint.windows.casement';
      case 'exterior-doors':       return 'exterior-repaint.doors';
      case 'roof-galv-corrugated': return prep === 'heavy' || prep === 'full-strip' ? 'roof-repaint.poor-cond.galv.2coat' : 'roof-repaint.galv.corrugated';
      case 'roof-galv-tray':       return prep === 'heavy' || prep === 'full-strip' ? 'roof-repaint.poor-cond.tray.2coat' : 'roof-repaint.galv.tray';
      case 'roof-decramastic':     return 'roof-repaint.decramastic';
      case 'roof-clay-tiles':      return 'roof-repaint.clay-tiles';
      case 'fascia':               return zone.LM != null ? 'exterior-new.fascia.LM.wide' : 'exterior-new.fascia.m2';
      // For surfaces with no repaint-specific rate, the new-work rate is
      // a reasonable approximation; the prep work is "in the rate" per PD.
      case 'soffit':               return 'exterior-new.soffit';
      case 'linea':                return 'exterior-new.linea';
      case 'hardiflex':            return 'exterior-new.hardiflex';
      case 'deck-acrylic':         return 'exterior-new.deck.acrylic';
      case 'deck-oilstain':        return 'exterior-new.deck.oilstain';
      case 'fence':                return 'exterior-new.fence';
    }
  }

  // kind === 'new' — pull from the new-work tables.
  if (kind === 'new') {
    switch (surface) {
      case 'interior-walls':       return 'interior-new.walls.2coat';
      case 'interior-ceilings':    return 'interior-new.ceiling.2coat';
      case 'interior-timber':      return 'interior-new.timber.2coat';
      case 'interior-trim':        return 'interior-new.trim.LM';
      case 'interior-door':        return 'interior-doors.flush.in-situ';
      case 'weatherboards':        return 'exterior-new.weatherboards.bevel';
      case 'linea':                return 'exterior-new.linea';
      case 'hardiplank':           return 'exterior-new.hardiplank';
      case 'hardiflex':            return 'exterior-new.hardiflex';
      case 'concrete-smooth':      return 'exterior-new.concrete.smooth';
      case 'concrete-medium':      return 'exterior-new.concrete.medium';
      case 'blockwork':            return 'exterior-new.blockwork';
      case 'fascia':               return zone.LM != null ? 'exterior-new.fascia.LM.wide' : 'exterior-new.fascia.m2';
      case 'soffit':               return 'exterior-new.soffit';
      case 'soffit-rafters':       return 'exterior-new.soffit.rafters';
      case 'exterior-windows':     return 'exterior-new.windows';
      case 'deck-acrylic':         return 'exterior-new.deck.acrylic';
      case 'deck-oilstain':        return 'exterior-new.deck.oilstain';
      case 'fence':                return 'exterior-new.fence';
    }
  }

  throw new Error(`No rate mapped for surface=${surface}, kind=${kind}, prep=${prep ?? 'n/a'}`);
}

/**
 * Get the quantity for a zone in the units its rate uses. Throws if the
 * required measurement isn't provided.
 */
function quantityForZone(zone: ScopeZone, rate: ReseneRate): number {
  switch (rate.measure) {
    case 'm2':   if (zone.m2    == null) throw new Error(`Zone "${zone.name}" needs m² for rate "${rate.key}"`);   return zone.m2;
    case 'LM':   if (zone.LM    == null) throw new Error(`Zone "${zone.name}" needs LM for rate "${rate.key}"`);   return zone.LM;
    case 'each': if (zone.count == null) throw new Error(`Zone "${zone.name}" needs count for rate "${rate.key}"`); return zone.count;
    case 'pair': if (zone.count == null) throw new Error(`Zone "${zone.name}" needs count for rate "${rate.key}"`); return zone.count;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// The engine
// ──────────────────────────────────────────────────────────────────────────

export interface EstimateOptions {
  /** Defaults to current year — set when re-estimating a historical quote. */
  quotingYear?: number;
  /** Defaults to 'normal'. */
  access?: AccessLevel;
}

const NZ_GST = 0.15;

/**
 * Primary entry point. Returns a fully-trailed cost estimate.
 *
 *   const est = estimateCost([
 *     { name: 'North elevation cedar', surface: 'cedar', kind: 'repaint', m2: 60 },
 *     { name: 'South elevation cedar', surface: 'cedar', kind: 'repaint', m2: 55 },
 *     { name: 'Eaves',                  surface: 'soffit', kind: 'new',    m2: 18 },
 *   ], { access: 'normal' });
 */
export function estimateCost(
  zones: ScopeZone[],
  opts: EstimateOptions = {},
): CostEstimate {
  const quotingYear = opts.quotingYear ?? new Date().getFullYear();
  const access = opts.access ?? 'normal';
  const inflFactor = inflationFactor(quotingYear);
  const uplift = ACCESS_UPLIFT[access];

  const lineItems: CostLineItem[] = zones.map((zone) => {
    const rateKey = resolveRateKey(zone);
    const rate = getRate(rateKey);
    const qty = quantityForZone(zone, rate);

    const rawSubtotal = rate.rawRate * qty;
    const adjusted = rawSubtotal * inflFactor * uplift;

    const explanation = [
      `${qty} ${rate.measure} × $${rate.rawRate.toFixed(2)} (${rate.pdRef})`,
      inflFactor !== 1 ? `× ${inflFactor.toFixed(3)} inflation` : null,
      uplift !== 1 ? `× ${uplift.toFixed(2)} access (${access})` : null,
      `= $${adjusted.toFixed(2)} ex-GST`,
    ].filter(Boolean).join(' ');

    return {
      zoneName: zone.name,
      rate,
      quantity: qty,
      rawSubtotalExGst: rawSubtotal,
      adjustedSubtotalExGst: adjusted,
      inflationFactorUsed: inflFactor,
      accessUpliftUsed: uplift,
      explanation,
    };
  });

  const rawSubtotalExGst = lineItems.reduce((s, l) => s + l.rawSubtotalExGst, 0);
  const totalExGst = lineItems.reduce((s, l) => s + l.adjustedSubtotalExGst, 0);
  const totalInclGst = totalExGst * (1 + NZ_GST);

  // Estimated hours = total labour-included rate $ ÷ today's loaded hourly
  // rate. PD's 2022 loaded rate ($64.59) × inflation gives today's
  // equivalent.
  const todaysHourlyRate = PD_HOURLY_RATE_2022 * inflFactor;
  const estimatedHours = totalExGst / todaysHourlyRate;
  const impliedHourlyRate = totalExGst / Math.max(estimatedHours, 0.0001);

  return {
    lineItems,
    rawSubtotalExGst:  round2(rawSubtotalExGst),
    totalExGst:        round2(totalExGst),
    totalInclGst:      round2(totalInclGst),
    estimatedHours:    round1(estimatedHours),
    impliedHourlyRate: round2(impliedHourlyRate),
    meta: {
      inflationFactor: inflFactor,
      accessLevel: access,
      accessUplift: uplift,
      quotingYear,
      pdEdition: '11th',
    },
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round1(n: number): number { return Math.round(n * 10) / 10; }

// ──────────────────────────────────────────────────────────────────────────
// Calibration comparison — used after a job is completed
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compare a cost estimate to actuals. Used to:
 *   - tell Brad whether his quote was on, under, or over the PD-anchored
 *     estimate;
 *   - feed the calibration loop (eventually: per-painter productivity
 *     multipliers per surface/prep).
 */
export interface ActualOutcome {
  /** Ex-GST price actually paid (what landed). */
  paidExGst: number;
  /** Actual hours logged on the job. */
  actualHours: number;
  /** What Brad initially quoted (ex-GST). */
  quotedExGst: number;
}

export interface CalibrationDelta {
  /** Engine's suggested ex-GST price vs what Brad quoted. */
  estimateVsQuotePct: number;
  /** Brad's quoted ex-GST price vs what was actually paid. */
  quoteVsPaidPct: number;
  /** Engine's estimated hours vs actual hours. */
  hoursDeltaPct: number;
  /** Implied $/hr at actual outcome vs PD floor. */
  actualHourlyRate: number;
  /** Plain-English summary for the UI. */
  takeaway: string;
}

export function compareEstimateToActual(
  estimate: CostEstimate,
  actual: ActualOutcome,
): CalibrationDelta {
  const estimateVsQuotePct = (estimate.totalExGst - actual.quotedExGst) / actual.quotedExGst;
  const quoteVsPaidPct = (actual.paidExGst - actual.quotedExGst) / actual.quotedExGst;
  const hoursDeltaPct = (actual.actualHours - estimate.estimatedHours) / estimate.estimatedHours;
  const actualHourlyRate = actual.paidExGst / Math.max(actual.actualHours, 0.0001);

  let takeaway: string;
  if (estimateVsQuotePct > 0.10) {
    takeaway = `PD says ${pct(estimateVsQuotePct, true)} MORE than you quoted — you may have left money on the table.`;
  } else if (estimateVsQuotePct < -0.10) {
    takeaway = `Your quote was ${pct(-estimateVsQuotePct, true)} above PD — you priced confidently, good margin.`;
  } else {
    takeaway = `Your quote was within ±10% of PD-anchored cost — well calibrated.`;
  }

  return {
    estimateVsQuotePct: round2(estimateVsQuotePct),
    quoteVsPaidPct:     round2(quoteVsPaidPct),
    hoursDeltaPct:      round2(hoursDeltaPct),
    actualHourlyRate:   round2(actualHourlyRate),
    takeaway,
  };
}

function pct(n: number, abs = false): string {
  const v = abs ? Math.abs(n) : n;
  return `${(v * 100).toFixed(0)}%`;
}

// Make the unused export `RESENE_RATES` visible to tree-shaking analyzers
// that scan the engine's imports (no behavioural effect).
export const _RATE_COUNT = RESENE_RATES.length;
