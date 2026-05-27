/**
 * Resene Professional Development Programme — Average rates for painting
 * (11th edition).
 *
 * Source: `Resene-dev-programme.pdf` in the repo root, uploaded by Brad
 * in May 2026. The rates are "$ rate labour/materials" — they ALREADY
 * bundle materials, labour, holiday/sick leave, ACC, brushware/consumables,
 * overheads (~$12/hr) and ~10% profit, **excluding GST**. So a rate of
 * $46/m² for a weatherboard repaint is the all-up ex-GST price the PD
 * recommends, not a labour-only number.
 *
 * Pages cited inline (e.g. `pdRef: 'p40'`) so anyone can verify the source.
 *
 * ## Inflation adjustment
 *
 * The PD was published with rates current as of its publication year. The
 * book itself says (p2): "Review and adjust rates allowing for movements
 * in labour and material costs and CPI index." We expose `inflateRate()`
 * to apply NZ construction-cost inflation from the PD's base year to
 * today. The factor comes from `CPI_FACTORS` below — quarterly snapshots
 * of Stats NZ's Construction Cost Index (CCI), the right index for
 * painting trade inputs (NOT the headline CPI, which under-tracks
 * construction inflation).
 *
 * ## How rates are used
 *
 *  - Most rates apply per square metre (m²) of finished surface.
 *  - Some apply per lineal metre (LM) — trims, skirtings, scotia.
 *  - A few are per item (each) — doors, windows.
 *  - For interior repaints with prep, the rate already includes the
 *    "Prepare, fill and sand" prep work (see p24 "Prepare, fill and sand
 *    walls and spot prime and 2 coats acrylic = $19.00/m²").
 *  - For exterior repaints, the prep rate scales with prep level — a
 *    "poor condition" weatherboard repaint is $85+/m² vs $46/m² for
 *    "good condition" (see p40 vs p42).
 *
 * ## Two-storey, access, scaffolding
 *
 * Per p4 of the PD: walls on a two-storey house measure FPA × 2.5 (vs
 * × 0.80 for single storey), and additional rates apply for awkward
 * access, scaffolding, edge protection (p31, p46). The PD leaves the
 * scaffolding/access uplift as a per-job allowance rather than a flat
 * multiplier — we expose `accessUplift()` so the cost engine can apply
 * Brad's calibrated values (which will start as PD defaults and tighten
 * with each completed job).
 */

import type { PrepLevel } from '@/lib/types';

// ──────────────────────────────────────────────────────────────────────────
// CPI / Construction Cost Index — inflation factors
// ──────────────────────────────────────────────────────────────────────────

/**
 * Stats NZ Capital Goods Price Index — residential building, indexed to
 * 2017 Q4 = 1000. Annual averages, used to inflate PD rates from their
 * publication year to the quoting year.
 *
 * Source: Stats NZ Infoshare > Producers Price Index > Capital Goods
 * Price Index > Residential buildings. Headline CPI under-tracks
 * construction inflation, so we use CGPI specifically.
 *
 * Values approximate where official annual averages aren't yet final
 * (e.g. 2026 is a projection from the latest available quarterly).
 * Update yearly when the new index is published.
 */
const CGPI_RESIDENTIAL_BY_YEAR: Record<number, number> = {
  2019: 1067,
  2020: 1098,
  2021: 1187,
  2022: 1336, // sharp post-COVID materials spike
  2023: 1392,
  2024: 1410, // softening
  2025: 1430,
  2026: 1455, // projection for May 2026
};

/**
 * The publication year of the Resene PD edition we're encoding. The 11th
 * edition was published in 2022 (per Resene's own catalogue listing for
 * the 11th edition, which used 2022 Q3 cost data). Update if a later
 * edition is loaded.
 */
export const PD_BASE_YEAR = 2022;

/**
 * Multiply a raw PD rate by this factor to get the today-equivalent rate
 * in the quoting year. Defaults to today (May 2026) using `PD_BASE_YEAR`.
 *
 * Example: a 2022 rate of $46/m² for weatherboard repaint becomes
 *   $46 × (1455/1336) ≈ $50.10/m² in 2026.
 */
export function inflationFactor(toYear: number = new Date().getFullYear()): number {
  const base = CGPI_RESIDENTIAL_BY_YEAR[PD_BASE_YEAR];
  const target = CGPI_RESIDENTIAL_BY_YEAR[toYear];
  if (!base || !target) {
    // Fall back to ~3%/yr compounded if the year isn't in the table.
    // Conservative — better to under-inflate than over-inflate a quote.
    const yearsDelta = toYear - PD_BASE_YEAR;
    return Math.pow(1.03, yearsDelta);
  }
  return target / base;
}

/**
 * Apply CPI inflation to a raw PD rate. Convenience over
 * `rate * inflationFactor(year)`.
 */
export function inflateRate(rawRate: number, toYear?: number): number {
  return rawRate * inflationFactor(toYear);
}

// ──────────────────────────────────────────────────────────────────────────
// Rate table — encoded directly from the PD pages.
// ──────────────────────────────────────────────────────────────────────────

/** A measurable unit a rate applies to. */
export type RateMeasure = 'm2' | 'LM' | 'each' | 'pair';

/**
 * A single rate from the PD. All rates are ex-GST and bundle materials +
 * labour + overhead + small profit per the PD's own structure.
 */
export interface ReseneRate {
  /** Stable key for lookups — `category.surface.prepOrCondition`. */
  key: string;
  /** Human-readable description (matches the PD row text). */
  label: string;
  /** Where the rate sits in the PD's organisation. */
  category:
    | 'interior-new'
    | 'interior-doors'
    | 'interior-repaint'
    | 'interior-wallcovering'
    | 'interior-prep'
    | 'exterior-new'
    | 'exterior-repaint'
    | 'exterior-prep'
    | 'roof-repaint';
  measure: RateMeasure;
  /** The raw $ rate as printed in the PD, ex-GST, pre-inflation. */
  rawRate: number;
  /** PD page reference for traceability ("p12", "p40", etc). */
  pdRef: string;
  /** Optional notes — qualifiers like "good condition", coats, etc. */
  notes?: string;
}

/**
 * The full rate library. Organised by category for browseability. NOT
 * exhaustive — captures the rates most relevant to Brad's mix (interior +
 * exterior repaints, exterior new, roof repaints, common doors/trims).
 * Specialist coatings (Sandtex, intumescent, etc) are out of scope for v1.
 */
export const RESENE_RATES: ReseneRate[] = [
  // ── Interior NEW work (p12) ──────────────────────────────────────────
  { key: 'interior-new.seal-flat',           category: 'interior-new', label: 'Apply 1 coat sealer to flat surfaces (ceilings/walls)', measure: 'm2', rawRate:  8.00, pdRef: 'p12' },
  { key: 'interior-new.ceiling.2coat',       category: 'interior-new', label: 'Ceilings — 1× sealer + 2× acrylic ceiling flat',       measure: 'm2', rawRate: 16.50, pdRef: 'p12' },
  { key: 'interior-new.walls.2coat',         category: 'interior-new', label: 'Walls — 1× sealer/undercoat + 2× low sheen acrylic',   measure: 'm2', rawRate: 18.00, pdRef: 'p12', notes: 'Colours below 40% LRV add 10%' },
  { key: 'interior-new.timber.2coat',        category: 'interior-new', label: 'Timber surfaces — 1× AP undercoat + 2× topcoats',      measure: 'm2', rawRate: 26.20, pdRef: 'p12' },
  { key: 'interior-new.trim.LM',             category: 'interior-new', label: 'Skirtings / window liners / small trims',              measure: 'LM', rawRate: 10.00, pdRef: 'p12' },

  // ── Interior doors + frames (p14) ────────────────────────────────────
  { key: 'interior-doors.flush.in-situ',     category: 'interior-doors', label: 'Flush door 1980×800 — prep + topcoats in-situ',      measure: 'each', rawRate: 150.00, pdRef: 'p14' },
  { key: 'interior-doors.flush.spray-off',   category: 'interior-doors', label: 'Flush door — spray off-site + return/rehang',         measure: 'each', rawRate: 115.00, pdRef: 'p14' },
  { key: 'interior-doors.flush.spray-in-situ', category: 'interior-doors', label: 'Flush door — spray in-situ (HVLP/airless 0920)',  measure: 'each', rawRate: 120.00, pdRef: 'p14' },
  { key: 'interior-doors.bifold.pair',       category: 'interior-doors', label: 'Bi-fold / cavity slider pair',                       measure: 'pair', rawRate: 150.00, pdRef: 'p14' },
  { key: 'interior-doors.overheight.2700',   category: 'interior-doors', label: 'Over-height door 2700mm',                            measure: 'each', rawRate: 170.00, pdRef: 'p14' },
  { key: 'interior-doors.overheight.3000',   category: 'interior-doors', label: 'Over-height door 3000mm',                            measure: 'each', rawRate: 190.00, pdRef: 'p14' },
  { key: 'interior-doors.fire',              category: 'interior-doors', label: 'Fire door 1980×800 each side + frame in-situ',      measure: 'each', rawRate: 265.00, pdRef: 'p14' },

  // ── Interior REPAINT (p24) ───────────────────────────────────────────
  { key: 'interior-repaint.walls.2coat',     category: 'interior-repaint', label: 'Walls — prep, fill, sand, spot prime + 2 coats acrylic', measure: 'm2', rawRate: 19.00, pdRef: 'p24' },
  { key: 'interior-repaint.ceiling.1coat',   category: 'interior-repaint', label: 'Ceiling repaint — 1 coat (good condition)',           measure: 'm2', rawRate: 15.50, pdRef: 'p24' },
  { key: 'interior-repaint.ceiling.2coat',   category: 'interior-repaint', label: 'Ceiling repaint — 2 coats',                            measure: 'm2', rawRate: 18.50, pdRef: 'p24' },
  { key: 'interior-repaint.ceiling.prep',    category: 'interior-repaint', label: 'Ceiling repaint — spot prime, seal, fill + 2 coats',   measure: 'm2', rawRate: 22.00, pdRef: 'p24' },
  { key: 'interior-repaint.doors.flush',     category: 'interior-repaint', label: 'Flush door 1980×800 — prep + recoat (good cond) both sides + frame', measure: 'each', rawRate: 140.00, pdRef: 'p24' },
  { key: 'interior-repaint.windows.flat',    category: 'interior-repaint', label: 'Average timber window frames + sashes — measured flat', measure: 'm2', rawRate: 48.00, pdRef: 'p24' },
  { key: 'interior-repaint.kitchen',         category: 'interior-repaint', label: 'Prep + paint average kitchen joinery — sand, UC + topcoat', measure: 'each', rawRate: 1250.00, pdRef: 'p24' },
  { key: 'interior-repaint.bathroom',        category: 'interior-repaint', label: 'Prep + sand + UC + topcoat — average small bathroom',  measure: 'each', rawRate: 980.00, pdRef: 'p24', notes: 'Use as floor — varies up' },
  { key: 'interior-repaint.varnish.refinish',category: 'interior-repaint', label: 'Clear varnish refinishing — wash, sand + 2 coats',     measure: 'm2', rawRate: 22.00, pdRef: 'p24' },
  { key: 'interior-repaint.cabinets',        category: 'interior-repaint', label: 'Prep + repaint cabinets/shelving — sand + 2 coats 2-pack', measure: 'm2', rawRate: 33.00, pdRef: 'p24' },
  { key: 'interior-repaint.pipework.LM',     category: 'interior-repaint', label: 'Exposed pipework up to 100mm diameter (per coat)',     measure: 'LM', rawRate: 10.00, pdRef: 'p24' },

  // ── Interior PREP / washing / sealing (p22) ──────────────────────────
  { key: 'interior-prep.wash',               category: 'interior-prep', label: 'Wash surfaces — Paint Prep & Housewash, scrub + rinse', measure: 'm2', rawRate: 10.00, pdRef: 'p22' },
  { key: 'interior-prep.degrease',           category: 'interior-prep', label: 'Emulsifiable solvent cleaner — flush + vacuum (grease/smoke)', measure: 'm2', rawRate: 12.00, pdRef: 'p22' },
  { key: 'interior-prep.varnish-seal',       category: 'interior-prep', label: 'Wash, sand + seal varnished surfaces with adhesion primer', measure: 'm2', rawRate: 14.00, pdRef: 'p22' },
  { key: 'interior-prep.strip-wallpaper',    category: 'interior-prep', label: 'Stripping wallpaper — try for approximate area rate',  measure: 'm2', rawRate: 22.00, pdRef: 'p22' },
  { key: 'interior-prep.skim-after-strip',   category: 'interior-prep', label: 'Skim coat plasterboard walls after paper removal',     measure: 'm2', rawRate: 19.00, pdRef: 'p22' },

  // ── Interior wallcoverings (p20) ─────────────────────────────────────
  { key: 'interior-wallcovering.lining',     category: 'interior-wallcovering', label: 'Supply + hang butt-jointed lining paper to plasterboard', measure: 'm2', rawRate: 19.00, pdRef: 'p20' },
  { key: 'interior-wallcovering.standard',   category: 'interior-wallcovering', label: 'Supply + hang selected wallpaper (PC $80/roll)',  measure: 'm2', rawRate: 33.00, pdRef: 'p20' },
  { key: 'interior-wallcovering.paste-wall', category: 'interior-wallcovering', label: 'Paste-the-wall — supply + hang selected paper',    measure: 'm2', rawRate: 23.00, pdRef: 'p20' },

  // ── Exterior NEW work (p26) ──────────────────────────────────────────
  { key: 'exterior-new.weatherboards.bevel', category: 'exterior-new', label: 'Weatherboards bevel-back — prep, reprime, stop + 2 coats acrylic', measure: 'm2', rawRate: 52.00, pdRef: 'p26' },
  { key: 'exterior-new.weatherboards.rusticated', category: 'exterior-new', label: 'Weatherboards rusticated — prep + 2 coats acrylic', measure: 'm2', rawRate: 56.00, pdRef: 'p26' },
  { key: 'exterior-new.fascia.m2',           category: 'exterior-new', label: 'Fascia/trims — prep, prime, stop + 2 coats acrylic',   measure: 'm2', rawRate: 33.00, pdRef: 'p26' },
  { key: 'exterior-new.fascia.LM.narrow',    category: 'exterior-new', label: 'Fascia 0–150mm — prep + 2 coats acrylic',              measure: 'LM', rawRate: 15.00, pdRef: 'p26' },
  { key: 'exterior-new.fascia.LM.wide',      category: 'exterior-new', label: 'Fascia 150–300mm — prep + 2 coats acrylic',            measure: 'LM', rawRate: 18.50, pdRef: 'p26' },
  { key: 'exterior-new.dressed-ply',         category: 'exterior-new', label: 'Dressed exterior grade ply — prime + 2 coats acrylic', measure: 'm2', rawRate: 23.00, pdRef: 'p26' },
  { key: 'exterior-new.shadowclad',          category: 'exterior-new', label: 'Rough sawn Shadowclad ply — QD prime + 2 coats',       measure: 'm2', rawRate: 37.50, pdRef: 'p26' },
  { key: 'exterior-new.windows',             category: 'exterior-new', label: 'Windows — prime + 2 coats waterborne enamel (flat)',   measure: 'm2', rawRate: 60.00, pdRef: 'p26', notes: '+10% for colonial sashes' },
  { key: 'exterior-new.soffit',              category: 'exterior-new', label: 'Soffit — prime + 2 coats',                              measure: 'm2', rawRate: 28.00, pdRef: 'p26' },
  { key: 'exterior-new.soffit.rafters',      category: 'exterior-new', label: 'Soffit with exposed rafters',                          measure: 'm2', rawRate: 70.00, pdRef: 'p26' },
  { key: 'exterior-new.linea',               category: 'exterior-new', label: 'LINEA ceramic weatherboards — 3 coats acrylic',         measure: 'm2', rawRate: 44.00, pdRef: 'p28' },
  { key: 'exterior-new.concrete.smooth',     category: 'exterior-new', label: 'Concrete/plaster — 1 coat sealer + 2 coats acrylic (smooth precast)', measure: 'm2', rawRate: 28.00, pdRef: 'p30' },
  { key: 'exterior-new.concrete.medium',     category: 'exterior-new', label: 'Concrete/plaster — sealer + 2 coats acrylic (medium plaster)', measure: 'm2', rawRate: 35.00, pdRef: 'p30' },
  { key: 'exterior-new.blockwork',           category: 'exterior-new', label: 'Concrete blockwork — sealer + 3 coats Resene X-200',   measure: 'm2', rawRate: 50.00, pdRef: 'p30' },
  { key: 'exterior-new.hardiflex',           category: 'exterior-new', label: 'Hardiflex — seal + 2 coats acrylic',                   measure: 'm2', rawRate: 19.00, pdRef: 'p32' },
  { key: 'exterior-new.hardiplank',          category: 'exterior-new', label: 'Hardiplank — prep, spot prime + 2 coats acrylic',      measure: 'm2', rawRate: 26.00, pdRef: 'p32' },
  { key: 'exterior-new.deck.acrylic',        category: 'exterior-new', label: 'Painting timber deck — 2× acrylic low sheen',         measure: 'm2', rawRate: 24.00, pdRef: 'p32' },
  { key: 'exterior-new.deck.oilstain',       category: 'exterior-new', label: 'Painting timber deck — 2× oil stain',                  measure: 'm2', rawRate: 22.00, pdRef: 'p32' },
  { key: 'exterior-new.oilstain.dressed.2coat', category: 'exterior-new', label: 'Exterior oil stain — 2 coats dressed timber',      measure: 'm2', rawRate: 22.00, pdRef: 'p32' },
  { key: 'exterior-new.oilstain.rough.2coat',   category: 'exterior-new', label: 'Exterior oil stain — 2 coats rough sawn',          measure: 'm2', rawRate: 28.00, pdRef: 'p32' },
  { key: 'exterior-new.fence',               category: 'exterior-new', label: 'Rough sawn post-rail boarded fence — 2 coats low sheen', measure: 'm2', rawRate: 20.00, pdRef: 'p32' },

  // ── Exterior PREP (p36) ──────────────────────────────────────────────
  { key: 'exterior-prep.housewash',          category: 'exterior-prep', label: 'Apply Resene Paint Prep & Housewash, rinse',           measure: 'm2', rawRate:  6.00, pdRef: 'p36' },
  { key: 'exterior-prep.moss',               category: 'exterior-prep', label: 'Moss & Mould killer + waterblast clean',               measure: 'm2', rawRate: 10.00, pdRef: 'p36' },
  { key: 'exterior-prep.waterblast.3000psi', category: 'exterior-prep', label: 'Water-blasting up to 3000 PSI',                        measure: 'm2', rawRate:  6.00, pdRef: 'p36' },
  { key: 'exterior-prep.high-pressure-wash', category: 'exterior-prep', label: 'High-pressure water washing',                         measure: 'm2', rawRate:  4.00, pdRef: 'p36' },
  { key: 'exterior-prep.machine-sand',       category: 'exterior-prep', label: 'Machine sanding old paintwork',                       measure: 'm2', rawRate: 23.00, pdRef: 'p36' },
  { key: 'exterior-prep.burn-off',           category: 'exterior-prep', label: 'Burning off weatherboards (gas / IR / heat gun)',     measure: 'm2', rawRate: 85.00, pdRef: 'p36' },
  { key: 'exterior-prep.liquid-strip',       category: 'exterior-prep', label: 'Liquid stripping incl. scraping + waterblast',         measure: 'm2', rawRate: 92.00, pdRef: 'p36' },
  { key: 'exterior-prep.linbide-scrape.LM',  category: 'exterior-prep', label: 'Linbide scraping small areas',                        measure: 'LM', rawRate: 14.00, pdRef: 'p36' },
  { key: 'exterior-prep.timberlock',         category: 'exterior-prep', label: 'Apply Resene TimberLock to prepared woodwork',         measure: 'm2', rawRate: 14.00, pdRef: 'p36' },

  // ── Exterior REPAINT (p40, p42) — the heart of Brad's mix ────────────
  // "Good condition" = light prep, "poor condition" = heavy prep+. We
  // map PD's wording → our PrepLevel enum (light/medium/heavy/full-strip).
  { key: 'exterior-repaint.weatherboards.good',  category: 'exterior-repaint', label: 'Repaint weatherboards (good cond) — spot prime + 2 coats acrylic', measure: 'm2', rawRate: 46.00, pdRef: 'p40', notes: 'Maps to prep=light' },
  { key: 'exterior-repaint.weatherboards.poor',  category: 'exterior-repaint', label: 'Repaint weatherboards (poor cond) — incl careful prep',           measure: 'm2', rawRate: 85.00, pdRef: 'p42', notes: 'Maps to prep=heavy/full-strip' },
  { key: 'exterior-repaint.windows.casement',    category: 'exterior-repaint', label: 'Repaint timber windows + sashes — casement type, spot prime + 2 coats', measure: 'm2', rawRate: 55.00, pdRef: 'p40' },
  { key: 'exterior-repaint.windows.colonial',    category: 'exterior-repaint', label: 'Repaint timber windows — colonial/double-hung (+10%)',           measure: 'm2', rawRate: 62.00, pdRef: 'p40' },
  { key: 'exterior-repaint.glaze.reputty.LM',    category: 'exterior-repaint', label: 'Remove old putty + reglaze (incl labour & materials)',           measure: 'LM', rawRate: 28.00, pdRef: 'p40' },
  { key: 'exterior-repaint.doors',               category: 'exterior-repaint', label: 'Repaint exterior doors + frames — typical TG/braced',            measure: 'each', rawRate: 110.00, pdRef: 'p40' },
  { key: 'exterior-repaint.doors.glazed-top',    category: 'exterior-repaint', label: 'Repaint exterior door — glazed top light',                       measure: 'each', rawRate: 90.00,  pdRef: 'p40' },
  { key: 'exterior-repaint.doors.glazed-3',      category: 'exterior-repaint', label: 'Repaint exterior door — glazed 3 light',                          measure: 'each', rawRate: 66.00,  pdRef: 'p40' },
  { key: 'exterior-repaint.glass.clean',         category: 'exterior-repaint', label: 'Clean glass / remove paint + polish',                             measure: 'm2', rawRate:  8.00, pdRef: 'p40' },
  // CEDAR / OIL-STAIN repaint — this is the J3 Cedar Restain rate.
  { key: 'exterior-repaint.cedar.oilstain.recoat', category: 'exterior-repaint', label: 'Prep + recoat oil stain — 2 coats to weatherboards (cedar)',  measure: 'm2', rawRate: 33.00, pdRef: 'p40', notes: 'CEDAR RESTAIN RATE — applies to Cedar Restain @ 3 Merivale Ave' },
  { key: 'exterior-repaint.cedar.oilstain.posts.LM', category: 'exterior-repaint', label: 'Prep + recoat oil stain — 2 coats to posts/beams',          measure: 'LM', rawRate: 12.00, pdRef: 'p40' },
  { key: 'exterior-repaint.hardiplank',          category: 'exterior-repaint', label: 'Prep + repaint Hardiplanks — spot prime + 2 coats acrylic',     measure: 'm2', rawRate: 26.00, pdRef: 'p40' },
  { key: 'exterior-repaint.spouting.LM',         category: 'exterior-repaint', label: 'Clean + paint 2 coats acrylic plastic spouting/downpipes',      measure: 'LM', rawRate: 12.00, pdRef: 'p40', notes: '+25% for colour contrast' },
  { key: 'exterior-repaint.deck.nonskid',        category: 'exterior-repaint', label: '2 coats Resene Non-Skid Deck & Path paving paint',              measure: 'm2', rawRate: 24.00, pdRef: 'p40' },
  { key: 'exterior-repaint.concrete.smooth',     category: 'exterior-repaint', label: 'Repaint smooth concrete/plaster — clean, spot prime + 2 coats acrylic', measure: 'm2', rawRate: 27.00, pdRef: 'p44' },
  { key: 'exterior-repaint.concrete.medium-rough', category: 'exterior-repaint', label: 'Repaint medium-roughcast — 2 coats acrylic',                  measure: 'm2', rawRate: 33.00, pdRef: 'p44' },
  { key: 'exterior-repaint.concrete.coarse-rough', category: 'exterior-repaint', label: 'Repaint coarse-roughcast — 2 coats acrylic',                  measure: 'm2', rawRate: 48.00, pdRef: 'p44' },
  { key: 'exterior-repaint.blockwork',           category: 'exterior-repaint', label: 'Repaint concrete blockwork — 2 coats acrylic brush + roll',     measure: 'm2', rawRate: 27.00, pdRef: 'p44' },
  { key: 'exterior-repaint.brickwork',           category: 'exterior-repaint', label: 'Repaint brickwork — 2 coats acrylic brush + roll',              measure: 'm2', rawRate: 34.00, pdRef: 'p44' },

  // ── Roof REPAINT (p46) ───────────────────────────────────────────────
  { key: 'roof-repaint.galv.corrugated',     category: 'roof-repaint', label: 'Repaint roof in good cond — spot prime + 2 coats acrylic (galv corrugated, airless spray)', measure: 'm2', rawRate: 24.00, pdRef: 'p46' },
  { key: 'roof-repaint.galv.tray',           category: 'roof-repaint', label: 'Repaint roof — galv tray profile, airless spray',     measure: 'm2', rawRate: 30.00, pdRef: 'p46' },
  { key: 'roof-repaint.decramastic',         category: 'roof-repaint', label: 'Repaint Decramastic tiles (low sheen)',               measure: 'm2', rawRate: 36.00, pdRef: 'p46' },
  { key: 'roof-repaint.clay-tiles',          category: 'roof-repaint', label: 'Repaint clay tiles (incl sealer coat)',               measure: 'm2', rawRate: 58.00, pdRef: 'p46' },
  { key: 'roof-repaint.epoxy.corrugated',    category: 'roof-repaint', label: 'Roof — remove rust, prime + epoxy hi-build (galv corrugated)', measure: 'm2', rawRate: 30.00, pdRef: 'p46' },
  { key: 'roof-repaint.epoxy.tray',          category: 'roof-repaint', label: 'Roof — remove rust, prime + epoxy hi-build (tray)',   measure: 'm2', rawRate: 40.00, pdRef: 'p46' },
  { key: 'roof-repaint.poor-cond.rust-prep', category: 'roof-repaint', label: 'Poor cond roof — remove rust, flaking paint, waterblast, scrape + prime (up to 100%)', measure: 'm2', rawRate: 22.00, pdRef: 'p48' },
  { key: 'roof-repaint.poor-cond.galv.2coat',category: 'roof-repaint', label: 'Poor cond roof — 2 coats Resene Summit Roof on corrugated', measure: 'm2', rawRate: 26.00, pdRef: 'p48' },
  { key: 'roof-repaint.poor-cond.tray.2coat',category: 'roof-repaint', label: 'Poor cond roof — 2 coats on tray profile',             measure: 'm2', rawRate: 34.00, pdRef: 'p48' },
];

// Build a Map for O(1) lookups.
const RATE_INDEX = new Map<string, ReseneRate>(RESENE_RATES.map((r) => [r.key, r]));

/** Look up a rate by its stable key. Throws if not found (caller bug). */
export function getRate(key: string): ReseneRate {
  const r = RATE_INDEX.get(key);
  if (!r) throw new Error(`Resene rate not found: ${key}`);
  return r;
}

/** Filter rates by category (e.g. all `exterior-repaint` rates). */
export function ratesByCategory(category: ReseneRate['category']): ReseneRate[] {
  return RESENE_RATES.filter((r) => r.category === category);
}

// ──────────────────────────────────────────────────────────────────────────
// FPA (Floor Plan Area) shortcuts — from PD p4
// ──────────────────────────────────────────────────────────────────────────
// "Rapid Measuring Guide for the average home" — given the floor area
// of a house (FPA in m²), derive the painted surfaces. Critical for
// quoting off council plans where the floor area is easy to read but
// individual elevation areas aren't.

/** Storey count — single (1 storey) or two (2+ storey). */
export type Storey = 1 | 2;

/**
 * Derive painted surfaces from Floor Plan Area. All return m².
 * Per PD p4:
 *   - Ceilings:  FPA × 1
 *   - Walls:     single = FPA × 2.5      two-storey = FPA × 3
 *   - Roof:      FPA × 1.40 (average slope)
 *   - Soffit:    FPA × 0.14 (500mm wide)
 *   - Exterior walls: single = FPA × 0.80   two-storey = FPA × 2.00 (× 2.5 if tray/2 storey, p4)
 *   - Base/foundation visible: FPA × 0.15
 */
export interface FpaDerivedSurfaces {
  ceilingsM2: number;
  /** Total interior wall surface area (excludes door/window openings — generous). */
  interiorWallsM2: number;
  /** Total exterior wall surface area. */
  exteriorWallsM2: number;
  roofM2: number;
  soffitM2: number;
  /** Base / foundation visible m² (small exposed strip). */
  baseM2: number;
}

export function deriveSurfacesFromFpa(fpa: number, storeys: Storey): FpaDerivedSurfaces {
  const interiorWallsMultiplier = storeys === 1 ? 2.5 : 3.0;
  const exteriorWallsMultiplier = storeys === 1 ? 0.80 : 2.00;
  return {
    ceilingsM2:       fpa * 1.0,
    interiorWallsM2:  fpa * interiorWallsMultiplier,
    exteriorWallsM2:  fpa * exteriorWallsMultiplier,
    roofM2:           fpa * 1.40,
    soffitM2:         fpa * 0.14,
    baseM2:           fpa * 0.15,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Productivity + labour constants (PD p6–7)
// ──────────────────────────────────────────────────────────────────────────
// These aren't used directly to PRICE a quote (the rate table already
// bundles labour). They're used to ESTIMATE HOURS so we can predict
// duration on the calendar AND so we can later compare estimated hours
// vs actual hours for calibration ("did this job take what we thought?").

/**
 * PD p6: "On flat wall surfaces painters mostly average 120m² per coat
 * per day — this is each day and includes all the mucking about
 * contingent with the process (masking, talking, texting, dit dit and
 * ditto)." 1 day = 8 productive hours per the PD's labour calc, so
 * 120 m²/day ÷ 8 hr/day = 15 m²/hour for flat walls.
 *
 * This is a useful AVERAGE — productivity varies wildly by surface and
 * prep. We expose it as a starting point; calibration will refine
 * per-surface multipliers from actuals.
 */
export const PD_FLAT_WALL_PRODUCTIVITY_M2_PER_HOUR = 15;

/** PD p7: labour cost breakdown for a self-employed painter, 2022. */
export const PD_LABOUR_CONSTANTS = {
  /** Ordinary hourly base wage assumed in the PD (2022). */
  baseHourlyWage: 29.00,
  /** Holiday + sick leave uplift on base wage. */
  holidaySickPct: 0.16,
  /** ACC + first-week liability uplift on base wage. */
  accPct: 0.06,
  /** Productive hours per 45-hour week after breaks etc. */
  productiveHoursPerWeek: 43.33,
  /** Brushware / rollers / consumables loaded into hourly rate. */
  consumablesPerHour: 10.00,
  /** Overhead loading (insurance, vehicle, phone, etc) per labour hour. */
  overheadsPerHour: 12.00,
  /** Built-in profit margin in the rates (PD uses 10%). */
  builtInProfitPct: 0.10,
} as const;

/**
 * The PD's all-in fully-loaded hourly cost: $58.72 (p7) before profit.
 * With 10% profit applied = $64.59. Used as a sanity check — if the
 * cost engine ever produces a $/hr implied rate well below this, the
 * quote is leaving money on the table.
 */
export const PD_LOADED_HOURLY_COST_2022 = 58.72;
export const PD_HOURLY_RATE_2022        = 64.59;

// ──────────────────────────────────────────────────────────────────────────
// Prep level → recoat rate selection
// ──────────────────────────────────────────────────────────────────────────
// PD's "good condition" vs "poor condition" maps to our 4-level prep enum.
// Used by the cost engine to pick the right exterior repaint rate.

/**
 * Given a PrepLevel + a base surface, return the key for the rate to use.
 * Falls back to the "good condition" rate if no specific poor-cond rate
 * exists for that surface.
 */
export function rateKeyForExteriorRepaint(
  surface: 'weatherboards' | 'cedar' | 'hardiplank' | 'concrete-smooth' | 'concrete-medium' | 'brickwork' | 'blockwork',
  prep: PrepLevel,
): string {
  // Cedar / oil stain restain is always the cedar rate (p40) regardless
  // of prep level — PD doesn't carry a "cedar in poor condition" tier.
  if (surface === 'cedar') return 'exterior-repaint.cedar.oilstain.recoat';

  if (surface === 'weatherboards') {
    if (prep === 'heavy' || prep === 'full-strip') {
      return 'exterior-repaint.weatherboards.poor';
    }
    return 'exterior-repaint.weatherboards.good';
  }
  if (surface === 'hardiplank') return 'exterior-repaint.hardiplank';
  if (surface === 'concrete-smooth') return 'exterior-repaint.concrete.smooth';
  if (surface === 'concrete-medium') return 'exterior-repaint.concrete.medium-rough';
  if (surface === 'brickwork') return 'exterior-repaint.brickwork';
  if (surface === 'blockwork') return 'exterior-repaint.blockwork';
  throw new Error(`No exterior repaint rate mapped for surface: ${surface}`);
}

// ──────────────────────────────────────────────────────────────────────────
// Access / scaffolding uplift (PD p4, p31, p46)
// ──────────────────────────────────────────────────────────────────────────
// PD makes scaffolding + edge protection a per-job allowance, not a flat
// multiplier. We expose sensible defaults that the cost engine can apply,
// with the expectation that calibration data will refine these per-painter.

export type AccessLevel = 'easy' | 'normal' | 'awkward' | 'two-storey' | 'three-storey-or-scaffold';

/**
 * Multiplier on labour-heavy rates for access difficulty. Values are
 * sensible starting points anchored on PD guidance; not gospel.
 * Two-storey alone is a 1.15× uplift in productivity terms (slower work
 * on ladders + edge protection setup time). Anything requiring real
 * scaffolding gets a larger uplift PLUS scaffolding hire as a separate
 * line item handled outside the rate table.
 */
export const ACCESS_UPLIFT: Record<AccessLevel, number> = {
  'easy':                       0.95,  // single storey, drive-up, no obstacles
  'normal':                     1.00,  // PD default
  'awkward':                    1.10,  // bushes, narrow side, limited setup
  'two-storey':                 1.15,
  'three-storey-or-scaffold':   1.30,  // separate scaffold hire line item still applies
};
