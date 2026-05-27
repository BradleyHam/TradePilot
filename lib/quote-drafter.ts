// =============================================================
// Quote drafter — Claude-backed first-pass quote generation
// =============================================================
//
// Takes everything captured on a Job during the site-visit wrap-up
// (work type, paint area, prep level, coats, product, windows, add-
// ons, logistics, days estimate, commercial signals, scope notes)
// PLUS the business's quote template and any comparable past jobs,
// and produces a structured Quote draft Claude has filled in.
//
// The output is NOT the final word — it's a starting point Brad
// reviews. v1 ships without an in-app editor; if a draft's off, the
// user provides a one-line "hint" and regenerates. Multiple
// iterations until it's close enough, then download PDF.
//
// The model has TWO bodies of knowledge feeding the price suggestion:
//
//   1. Brad's past paid jobs (the strongest signal — calibrated to
//      his actual margin, location, and customer base). Passed in as
//      `comparableJobs`. When 0 are passed (Catherine's first cedar
//      restain), Claude leans entirely on (2).
//
//   2. The Resene Professional Development Programme rate sheet
//      (lib/pricing/resene-rates.ts). NZ-standard $/m² rates with
//      CPI adjustment from 2022 to current year. This is the
//      industry-anchor for "what's a reasonable price for X."
//
// The model is instructed to be explicit about which signal it
// leaned on per line item ("Past job J16 was $44/m² for similar
// cedar → using $42/m² here"). This gives Brad something to push
// back on if it picked the wrong anchor.

import Anthropic from '@anthropic-ai/sdk';
import type { Job, QuoteTemplate } from '@/lib/types';
import {
  RESENE_RATES, inflateRate, ACCESS_UPLIFT, PD_BASE_YEAR,
} from '@/lib/pricing/resene-rates';

// ── Public types ─────────────────────────────────────────────────────

/**
 * Single line on the drafted quote. Maps to the eventual PDF row.
 */
export interface DraftedLineItem {
  /** Customer-facing label, e.g. "Cedar restain — north & east elevations (1 coat)". */
  description: string;
  /** Numeric quantity — could be m², hours, days, units. */
  quantity: number;
  /** Free-form unit string. m², LM, hours, days, each. */
  unit: string;
  /** Ex-GST per-unit price. */
  unitPriceExGst: number;
  /** Computed total = quantity × unitPriceExGst. */
  totalExGst: number;
  /** Why Claude picked this rate. Surfaced in the UI as a tooltip
   *  so Brad can see the reasoning when scanning the draft. */
  reasoning: string;
}

/**
 * Timeline block — when the work starts + how long it takes.
 * All fields optional because some jobs are quoted before Brad
 * has committed to a start date.
 */
export interface DraftedTimeline {
  /** Free-form start date, e.g. "Mid June 2026" or "14/06/2026". */
  estimatedStart?: string;
  /** Free-form duration, e.g. "3 working days" or "1 week". */
  duration?: string;
  /** Optional caveat — weather, access, supplier lead times etc. */
  notes?: string;
}

/**
 * The whole drafted quote returned by the model. Matches the
 * Lakeside Painting PDF structure (header → pricing → inclusions/
 * exclusions → timeline → terms → CTA).
 */
export interface DraftedQuote {
  /** Customer-facing paragraph summarising the scope. Goes in the
   *  PDF body above the line-item table. */
  scopeParagraph: string;
  /** Line-item breakdown. The PDF table iterates over these. */
  lineItems: DraftedLineItem[];
  /** "What's included" — short bullets shown in a tinted box. Each
   *  bullet is one promise to the customer. Drives expectations
   *  before they accept. */
  inclusions: string[];
  /** "Not included" — same shape, drives the EXCLUSION conversation
   *  so Brad doesn't get a "but I thought…" call later. */
  exclusions: string[];
  /** When Brad expects to start + how long it'll take. */
  timeline: DraftedTimeline;
  /** Sum of line totals, ex-GST. */
  subtotalExGst: number;
  /** GST component (typically subtotal × 0.15 for NZ). */
  gstAmount: number;
  /** Total payable, inc-GST. */
  totalInclGst: number;
  /** Reasoning block surfaced under the totals: which signals drove
   *  the price, what Brad should sanity-check, edge cases noted. */
  reasoning: string;
  /** Optional: things Claude wasn't sure about and wants Brad to
   *  confirm. Surface as a yellow "double-check" panel in the UI. */
  warnings?: string[];
}

/**
 * A past job + its final paid price, used as a price anchor for
 * comparable work. Passed in shape rather than a full Job to keep
 * the AI prompt focused.
 */
export interface ComparableJob {
  name: string;
  workType?: string;
  prepLevel?: string;
  paintAreaM2?: number;
  /** What the customer actually paid (inc-GST). */
  totalPaid: number;
  /** Year completed, so the AI can disclose age in reasoning. */
  yearCompleted: number;
}

export interface DraftQuoteInput {
  job: Job;
  template: QuoteTemplate;
  comparableJobs: ComparableJob[];
  /** Optional one-liner Brad adds when regenerating ("upper section
   *  is more weathered than I described — charge more"). Empty on
   *  the first attempt. */
  hint?: string;
}

// ── Errors ────────────────────────────────────────────────────────────

export class QuoteDrafterError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'QuoteDrafterError';
  }
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Generate a draft quote for the given job. Throws QuoteDrafterError
 * with a specific code on misconfig or upstream LLM failure — the
 * route handler maps these to HTTP statuses.
 */
export async function draftQuote(input: DraftQuoteInput): Promise<DraftedQuote> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new QuoteDrafterError(
      'Server misconfigured: ANTHROPIC_API_KEY missing.',
      'no_api_key',
    );
  }

  const client = new Anthropic({ apiKey });

  // Build the system prompt — this is where the model gets context
  // about how Brad's business prices work + the rate library it can
  // reference. Kept inline rather than a separate file because it's
  // tightly coupled to the input shape above.
  const systemPrompt = buildSystemPrompt();

  // Build the user message — the job specifics + comparables.
  const userMessage = buildUserMessage(input);

  // Call Claude with a JSON-mode hint. We use the response_format-equivalent
  // pattern of asking for JSON inside <quote_json> tags rather than the
  // SDK's native tool calling because the prompt is simpler and the
  // output is a single structured object (not a tool-use scenario).
  let response: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    response = await client.messages.create({
      // Sonnet for quality — quote drafting is reasoning-heavy and
      // gets called maybe 5-10 times a week, not a high-volume path
      // where Haiku's price advantage would matter. The trade-off is
      // ~5s longer latency vs Haiku; acceptable for a 1-tap-then-wait
      // user flow.
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
  } catch (err) {
    throw new QuoteDrafterError(
      `Claude API call failed: ${(err as Error).message ?? 'unknown'}`,
      'upstream_failure',
    );
  }

  // Pull the text out of the first content block. Claude returns an
  // array of content blocks; for our prompt it's always a single text
  // block, but be defensive.
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new QuoteDrafterError(
      'Claude returned no text content.',
      'empty_response',
    );
  }

  return parseClaudeResponse(textBlock.text);
}

// ── Prompt construction ──────────────────────────────────────────────

function buildSystemPrompt(): string {
  // Inflated rates — bake in the current year's adjustment so Claude
  // sees current $/m² figures rather than 2022 numbers. We pre-compute
  // a compact rates table so the prompt stays under context.
  const currentYear = new Date().getFullYear();
  const ratesTable = RESENE_RATES.map((r) => {
    const inflated = inflateRate(r.rawRate, currentYear);
    return `  ${r.key}  ${r.label}  →  $${inflated.toFixed(2)}/${r.measure} ex-GST  [${r.pdRef}]${r.notes ? ' — ' + r.notes : ''}`;
  }).join('\n');

  const accessTable = Object.entries(ACCESS_UPLIFT)
    .map(([level, factor]) => `  ${level}: ×${factor}`)
    .join('\n');

  return `You are a quoting assistant for a NZ painting business. Your job is to
produce a fair, defensible draft quote for a residential or small
commercial painting job. You DRAFT — the painter (Brad) reviews
before sending to the customer.

## Pricing principles

1. **Past paid jobs are the strongest signal.** When the user provides
   comparable past jobs, anchor your pricing on those (calibrated to
   Brad's actual margin, his Wanaka NZ market, and his client base).
   Reference comparables by name in your reasoning.

2. **Resene PD rates are the fallback anchor** when no comparables
   exist. These are NZ industry-standard rates that bundle materials,
   labour, ACC, overhead, and ~10% profit, ex-GST. They are inflated
   to ${currentYear} using NZ construction-cost CPI. Pick rates that
   match the surface + prep level being quoted.

3. **Apply access uplifts** where the site is harder than normal —
   two-storey, scaffolding, awkward setup. Multiplier table:
${accessTable}

4. **Commercial signals adjust the final number ±15%** without
   changing the cost basis. Brad's "high trust / referral / quality-
   focused" customer doesn't get the same number as a price-shopping
   urgent one. Note any adjustment in your reasoning.

5. **Be honest about uncertainty.** If you're guessing because there's
   no comparable + the wrap-up data is thin, say so in \`reasoning\`
   and add a \`warnings\` entry asking Brad to sanity-check before
   sending.

## Resene PD rates (inflated to ${currentYear}, ex-GST)

${ratesTable}

## Output format

Reply with ONLY a JSON object inside <quote_json>...</quote_json> tags.
The JSON must match this exact shape:

\`\`\`json
{
  "scopeParagraph": "Customer-facing paragraph (2-4 sentences). Describes WHAT will be done in plain English, not internal jargon. Mentions surfaces, coats, finish. NO pricing here.",
  "lineItems": [
    {
      "description": "Customer-facing label, e.g. 'Cedar restain — north & east elevations (1 coat Wood-X mid)'",
      "quantity": 120,
      "unit": "m²",
      "unitPriceExGst": 42.00,
      "totalExGst": 5040.00,
      "reasoning": "One-sentence why: 'Anchored on Resene PD cedar restain rate \$42/m² (p40, ${currentYear} inflated). No comparable past cedar jobs.'"
    }
  ],
  "inclusions": [
    "Short customer-friendly bullet of what they get",
    "All preparation, sanding, masking, and clean-up",
    "Premium Wood-X stain — 2 coats throughout"
  ],
  "exclusions": [
    "Things this quote does NOT cover, to manage expectations",
    "Repair of any rotten timber discovered during prep",
    "Painting of soffits or fascia (not in scope)"
  ],
  "timeline": {
    "estimatedStart": "Free-form, e.g. 'Mid June 2026' or '14/06/2026'",
    "duration": "Free-form, e.g. '3 working days' or '1 week'",
    "notes": "Optional caveat — weather, access, supplier lead-times"
  },
  "subtotalExGst": 5040.00,
  "gstAmount": 756.00,
  "totalInclGst": 5796.00,
  "reasoning": "2-4 sentence summary of how you arrived at the total — which rates / comparables you used, any access uplift, any commercial-signal adjustment.",
  "warnings": ["Optional list of things Brad should double-check before sending."]
}
\`\`\`

## Style guide for the customer-facing fields

- **scopeParagraph**: warm-but-professional NZ tradie voice. "We'll prep
  and restain the cedar cladding…", not "Painting works will be carried
  out…". Avoid jargon. 2-4 sentences max.
- **inclusions**: 4-6 bullets. Plain-English promises. Lead with the
  big-ticket items (the work itself), end with the "no surprises"
  items (clean-up, furniture protection, full site tidy).
- **exclusions**: 2-4 bullets. Pre-empt the conversation Brad would
  otherwise have when the customer says "but I thought you'd do X".
  Common ones: structural repairs, areas not mentioned at the visit,
  weather/seasonal extras.
- **timeline.estimatedStart**: Brad's quoteReadyBy date is when the
  QUOTE is due, NOT when work starts. Don't conflate. Use a sensible
  start window (2-4 weeks from today) and prefix with "Approx" or
  "Tentative" since customer hasn't accepted yet.

## Critical math rules

- All money is NUMBERS not strings.
- subtotalExGst MUST equal the sum of lineItems[].totalExGst.
- gstAmount MUST equal subtotalExGst × 0.15 (NZ GST rate).
- totalInclGst MUST equal subtotalExGst + gstAmount.
- Round to 2 decimal places.
- Do NOT include any prose outside the <quote_json> tags.`;
}

function buildUserMessage(input: DraftQuoteInput): string {
  const { job, template, comparableJobs, hint } = input;

  const sections: string[] = [];

  // ── Job context ─────────────────────────────────────────────────────
  sections.push('## Job to quote');
  sections.push(`Job: ${job.name}`);
  sections.push(`Customer: ${job.clientName}`);
  if (job.location) sections.push(`Location: ${job.location}`);

  // Wrap-up data
  const wrapUp: string[] = [];
  if (job.workType) wrapUp.push(`Work type: ${job.workType}`);
  if (job.surfaceAreaM2) wrapUp.push(`Paint area (walls/cladding, not floor): ${job.surfaceAreaM2} m²`);
  if (job.prepLevel) wrapUp.push(`Prep level: ${job.prepLevel}`);
  if (job.coatsCount) wrapUp.push(`Coats: ${job.coatsCount}`);
  if (job.stainProduct) wrapUp.push(`Product: ${job.stainProduct}`);
  if (job.windowDoorCount != null) wrapUp.push(`Windows + doors in painted area: ${job.windowDoorCount}`);
  if (job.daysEstimate) wrapUp.push(`Painter's gut estimate: ${job.daysEstimate} days`);
  if (job.addonItems && job.addonItems.length > 0) {
    wrapUp.push(`Add-ons in scope: ${job.addonItems.join(', ')}`);
  }
  if (job.accessNotes && job.accessNotes.length > 0) {
    wrapUp.push(`Access notes: ${job.accessNotes.join(', ')}`);
  }
  if (job.siteLogistics && job.siteLogistics.length > 0) {
    wrapUp.push(`Site logistics: ${job.siteLogistics.join(', ')}`);
  }
  if (job.commercialSignals && job.commercialSignals.length > 0) {
    wrapUp.push(`Customer signals: ${job.commercialSignals.join(', ')}`);
  }
  if (job.scopeNotes) wrapUp.push(`Scope notes (painter's words): ${job.scopeNotes}`);
  sections.push(wrapUp.join('\n'));

  // ── Comparables ─────────────────────────────────────────────────────
  if (comparableJobs.length > 0) {
    sections.push('## Comparable past jobs (use these as price anchors)');
    sections.push(comparableJobs.map((c) =>
      `- ${c.name} (${c.yearCompleted})`
      + (c.workType ? ` · ${c.workType}` : '')
      + (c.prepLevel ? ` · ${c.prepLevel} prep` : '')
      + (c.paintAreaM2 ? ` · ${c.paintAreaM2} m²` : '')
      + ` → paid $${c.totalPaid.toFixed(2)} inc-GST`,
    ).join('\n'));
  } else {
    sections.push('## Comparable past jobs');
    sections.push('NONE provided. Lean on the Resene PD rates from the system prompt, and add a warning that this is a first-pass without a calibrated comparable.');
  }

  // ── Template / commercial frame ─────────────────────────────────────
  sections.push('## Business template');
  if (template.header.businessName) sections.push(`Business: ${template.header.businessName}`);
  sections.push(`GST treatment in quote: ${template.gstTreatment === 'incl' ? 'totals shown INC-GST per NZ retail convention' : 'totals shown EX-GST + GST line'}`);
  sections.push(`Validity: ${template.validityDays} days`);
  sections.push(`Deposit: ${template.paymentTerms.depositPercent}%, balance ${template.paymentTerms.balanceDue === 'on_completion' ? 'on completion' : 'progress-billed'}.`);

  // ── Hint (regeneration) ─────────────────────────────────────────────
  if (hint && hint.trim()) {
    sections.push('## Painter\'s note for this draft');
    sections.push(`The painter is regenerating with this guidance: "${hint.trim()}"`);
    sections.push('Take this into account when adjusting the previous draft.');
  }

  sections.push('## Task');
  sections.push('Draft the quote. Output ONLY the JSON object inside <quote_json> tags as specified in the system prompt.');

  return sections.join('\n\n');
}

// ── Response parsing ─────────────────────────────────────────────────

/**
 * Extract and validate the JSON Claude returned. Throws
 * QuoteDrafterError with code 'parse_failed' if anything's off — the
 * route handler turns that into a 502 so the client can retry.
 */
function parseClaudeResponse(raw: string): DraftedQuote {
  // Pull JSON out of <quote_json> tags. Lenient on whitespace.
  const match = raw.match(/<quote_json>([\s\S]*?)<\/quote_json>/);
  const jsonText = match ? match[1].trim() : raw.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new QuoteDrafterError(
      `Claude returned non-JSON: ${(e as Error).message}`,
      'parse_failed',
    );
  }

  // Type-narrow + validate. We're defensive here because the LLM can
  // and will occasionally drift — a missing field shouldn't crash the
  // route, it should return a parse_failed with a clear message.
  if (!parsed || typeof parsed !== 'object') {
    throw new QuoteDrafterError('Claude response was not an object.', 'parse_failed');
  }
  const obj = parsed as Record<string, unknown>;

  const scopeParagraph = typeof obj.scopeParagraph === 'string' ? obj.scopeParagraph : '';
  if (!scopeParagraph) {
    throw new QuoteDrafterError('Missing scopeParagraph in response.', 'parse_failed');
  }

  const lineItemsRaw = Array.isArray(obj.lineItems) ? obj.lineItems : [];
  if (lineItemsRaw.length === 0) {
    throw new QuoteDrafterError('Quote has no line items.', 'parse_failed');
  }
  const lineItems: DraftedLineItem[] = lineItemsRaw.map((li, i) => {
    if (!li || typeof li !== 'object') {
      throw new QuoteDrafterError(`Line item ${i} is not an object.`, 'parse_failed');
    }
    const item = li as Record<string, unknown>;
    const desc = typeof item.description === 'string' ? item.description : '';
    const qty = typeof item.quantity === 'number' ? item.quantity : NaN;
    const unit = typeof item.unit === 'string' ? item.unit : '';
    const unitPrice = typeof item.unitPriceExGst === 'number' ? item.unitPriceExGst : NaN;
    const total = typeof item.totalExGst === 'number' ? item.totalExGst : NaN;
    const reasoning = typeof item.reasoning === 'string' ? item.reasoning : '';
    if (!desc || !Number.isFinite(qty) || !unit || !Number.isFinite(unitPrice) || !Number.isFinite(total)) {
      throw new QuoteDrafterError(
        `Line item ${i} is missing required fields (description, quantity, unit, unitPriceExGst, totalExGst).`,
        'parse_failed',
      );
    }
    return { description: desc, quantity: qty, unit, unitPriceExGst: unitPrice, totalExGst: total, reasoning };
  });

  const subtotal = typeof obj.subtotalExGst === 'number' ? obj.subtotalExGst : NaN;
  const gst = typeof obj.gstAmount === 'number' ? obj.gstAmount : NaN;
  const totalInc = typeof obj.totalInclGst === 'number' ? obj.totalInclGst : NaN;
  if (!Number.isFinite(subtotal) || !Number.isFinite(gst) || !Number.isFinite(totalInc)) {
    throw new QuoteDrafterError('Missing total fields.', 'parse_failed');
  }

  // Don't enforce the math constraint server-side — Claude sometimes
  // rounds slightly differently than our naive sum. The route returns
  // exactly what Claude said; the UI can flag big discrepancies.

  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
  const warnings = Array.isArray(obj.warnings)
    ? obj.warnings.filter((w): w is string => typeof w === 'string')
    : undefined;

  // Lakeside-template fields. Lenient on missing — older drafts and
  // any case where Claude skipped a block should still parse, just
  // with empty lists / undefined timeline. Defensive defaults match
  // the customer-facing-quote convention.
  const inclusions = Array.isArray(obj.inclusions)
    ? obj.inclusions.filter((s): s is string => typeof s === 'string')
    : [];
  const exclusions = Array.isArray(obj.exclusions)
    ? obj.exclusions.filter((s): s is string => typeof s === 'string')
    : [];
  const timelineRaw = (obj.timeline && typeof obj.timeline === 'object')
    ? (obj.timeline as Record<string, unknown>)
    : {};
  const timeline = {
    estimatedStart: typeof timelineRaw.estimatedStart === 'string' ? timelineRaw.estimatedStart : undefined,
    duration: typeof timelineRaw.duration === 'string' ? timelineRaw.duration : undefined,
    notes: typeof timelineRaw.notes === 'string' ? timelineRaw.notes : undefined,
  };

  return {
    scopeParagraph,
    lineItems,
    inclusions,
    exclusions,
    timeline,
    subtotalExGst: subtotal,
    gstAmount: gst,
    totalInclGst: totalInc,
    reasoning,
    warnings: warnings && warnings.length > 0 ? warnings : undefined,
  };
}

// Re-export PD_BASE_YEAR so callers can include it in audit trails if
// they want to (e.g. saving "drafted with rates inflated from 2022 to
// 2026" alongside the quote in case the rate library changes later).
export { PD_BASE_YEAR };
