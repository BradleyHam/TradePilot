// Quote PDF parser — same architecture as lib/bill-parser.ts but tuned
// for outgoing quotes Brad has sent to clients, NOT incoming supplier
// invoices.
//
// Used by the project archive importer (scripts/import-projects.ts) to
// extract structured fields from the quote PDFs sitting in each job
// folder, so historical quotes can land in the `quotes` table with
// scope / total / line items rather than just a file blob.
//
// Same money-math invariants as the bill parser:
//   - GST math validated against the NZ 15% rule
//   - totalAmountInclGst is canonical; baseAmountExGst recomputed
//   - confidence downgraded to 'low' if validation fails

import Anthropic from '@anthropic-ai/sdk';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ParsedQuote } from './types';

const NZ_GST_RATE = 0.15;
const GST_TOLERANCE_DOLLARS = 0.10;

export const MAX_QUOTE_TEXT_CHARS = 40_000;

const PARSE_TOOL: Tool = {
  name: 'emit_quote',
  description:
    'Emit the structured fields extracted from an outgoing quote ' +
    'PDF that the painter sent to a client. Currency is NZD. Dates ' +
    'in ISO YYYY-MM-DD. NZ dates on quotes are typically DD/MM/YYYY.',
  input_schema: {
    type: 'object',
    properties: {
      clientName: { type: 'string', description: 'Person or company the quote was sent to.' },
      jobAddress: { type: 'string', description: 'Property address the work is at.' },
      jobType: { type: 'string', description: 'Short label for the work — e.g. "Exterior repaint", "Interior ceiling", "Cedar restain".' },
      scopeSummary: { type: 'string', description: 'A 1-3 sentence summary of the work scope as described in the quote.' },
      baseAmountExGst: { type: 'number', description: 'Ex-GST total before GST is added.' },
      totalAmountInclGst: { type: 'number', description: 'GST-inclusive grand total the client is being asked to pay.' },
      dateSent: { type: 'string', description: 'Date the quote was issued (ISO YYYY-MM-DD).' },
      lineItems: {
        type: 'array',
        description: 'Top-level line items in the quote.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            amount: { type: 'number' },
          },
          required: ['description'],
        },
      },
      surfaceAreaM2ByZone: {
        type: 'object',
        description:
          'Map of zone name → m² if the quote text mentions areas. ' +
          'Example: { "weatherboards": 120, "soffits": 30 }. ' +
          'Omit entirely if no numeric m² values are visible.',
      },
      surfaceType: {
        type: 'string',
        description: 'Surface description if mentioned ("weatherboard", "cedar", "linea", "stucco").',
      },
      prepLevel: {
        type: 'string',
        enum: ['light', 'medium', 'heavy', 'full-strip'],
        description: 'Categorisation of prep level if inferrable from the scope text.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          "How confident you are in this parse. 'high' = clean quote with " +
          "all key fields obvious. 'medium' = some fields inferred. 'low' = " +
          'significant guesswork or missing data.',
      },
    },
    required: ['confidence'],
  },
};

const SYSTEM_PROMPT = [
  'You extract structured fields from outgoing painting quotes that a ' +
  'New Zealand painter has sent to clients. Currency is NZD. GST is 15% ' +
  'domestic. Return all dates as ISO YYYY-MM-DD. NZ dates are typically ' +
  'DD/MM/YYYY.',
  '',
  'If a field is not present on the quote, omit it from the tool call. ' +
  "If unsure about a field, omit it — don't guess. Wrong data is worse " +
  'than missing data; the user is reviewing every parse before it commits.',
  '',
  'jobType should be a short categorical label (2-5 words), not a full ' +
  'sentence. Examples: "Exterior repaint", "Interior ceiling", "Cedar ' +
  'restain", "Roof repaint", "Bathroom prep + wallpaper".',
  '',
  'scopeSummary should be 1-3 sentences capturing what work is being ' +
  'quoted, NOT the line items verbatim. Think "describe to a contractor ' +
  "in three sentences what the job is\".",
  '',
  'For surfaceAreaM2ByZone: only emit if numeric m² values are explicitly ' +
  "present in the quote text. Do NOT estimate or invent areas. If you don't " +
  'see m² numbers, omit this field.',
  '',
  'For prepLevel:',
  '  light = mostly clean + repaint, minimal scraping',
  '  medium = sand back, fill cracks, prime areas, repaint',
  '  heavy = significant scraping, multiple primer coats, repairs',
  '  full-strip = strip to bare substrate before repainting',
  'Omit if the scope text is ambiguous.',
].join('\n');

/**
 * Run the LLM quote parser on plain text extracted from a quote PDF.
 * Throws on configuration / upstream failures; caller is responsible for
 * surfacing those.
 */
export async function parseQuoteText(text: string): Promise<ParsedQuote> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (text.length === 0) throw new Error('Cannot parse empty text');
  if (text.length > MAX_QUOTE_TEXT_CHARS) {
    throw new Error(`Text too large (${text.length} chars, max ${MAX_QUOTE_TEXT_CHARS})`);
  }

  const client = new Anthropic({ apiKey });
  const response = await callAnthropicWithRetry(client, text);

  let toolInput: Record<string, unknown> | null = null;
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'emit_quote') {
      if (typeof block.input === 'object' && block.input !== null) {
        toolInput = block.input as Record<string, unknown>;
      }
      break;
    }
  }
  if (!toolInput) {
    throw new Error('Quote parser returned no structured output');
  }

  return normaliseParsedQuote(toolInput);
}

/** Retry on transient Anthropic errors. Same shape as bill-parser. */
async function callAnthropicWithRetry(
  client: Anthropic,
  text: string,
): Promise<Anthropic.Message> {
  const delays = [1_000, 3_000, 9_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [PARSE_TOOL],
        tool_choice: { type: 'tool', name: 'emit_quote' },
        messages: [
          {
            role: 'user',
            content:
              'Extract the structured fields from the following outgoing ' +
              'quote and call the emit_quote tool with them.\n\n---\n' +
              text + '\n---',
          },
        ],
      });
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const isRetryable = status === 529 || status === 503
        || status === 502 || status === 429;
      const attemptsLeft = attempt < delays.length;
      if (!isRetryable || !attemptsLeft) throw err;
      const delayMs = delays[attempt];
      console.warn(
        `[quote-parser] Anthropic ${status} on attempt ${attempt + 1}; retrying in ${delayMs}ms`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr ?? new Error('Retry loop exhausted unexpectedly');
}

/** Validate + normalise. Recomputes baseAmountExGst from totalInclGst. */
export function normaliseParsedQuote(raw: Record<string, unknown>): ParsedQuote {
  const parsed: ParsedQuote = {
    confidence: (raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low')
      ? raw.confidence
      : 'low',
  };

  if (typeof raw.clientName === 'string') parsed.clientName = raw.clientName;
  if (typeof raw.jobAddress === 'string') parsed.jobAddress = raw.jobAddress;
  if (typeof raw.jobType === 'string') parsed.jobType = raw.jobType;
  if (typeof raw.scopeSummary === 'string') parsed.scopeSummary = raw.scopeSummary;
  if (typeof raw.dateSent === 'string') parsed.dateSent = raw.dateSent;
  if (typeof raw.surfaceType === 'string') parsed.surfaceType = raw.surfaceType;
  if (raw.prepLevel === 'light' || raw.prepLevel === 'medium'
      || raw.prepLevel === 'heavy' || raw.prepLevel === 'full-strip') {
    parsed.prepLevel = raw.prepLevel;
  }

  if (raw.surfaceAreaM2ByZone && typeof raw.surfaceAreaM2ByZone === 'object') {
    const zones: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.surfaceAreaM2ByZone as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        zones[k] = round2(v);
      }
    }
    if (Object.keys(zones).length > 0) parsed.surfaceAreaM2ByZone = zones;
  }

  if (Array.isArray(raw.lineItems)) {
    parsed.lineItems = raw.lineItems
      .filter((li): li is Record<string, unknown> => typeof li === 'object' && li !== null)
      .map((li) => ({
        description: typeof li.description === 'string' ? li.description : '',
        amount: typeof li.amount === 'number' ? round2(li.amount) : undefined,
      }))
      .filter((li) => li.description.length > 0);
  }

  // Money. totalInclGst is canonical; we derive baseAmountExGst from it
  // when both are present, otherwise we take baseAmountExGst at face value.
  const total = typeof raw.totalAmountInclGst === 'number' && Number.isFinite(raw.totalAmountInclGst)
    ? raw.totalAmountInclGst
    : undefined;
  const base = typeof raw.baseAmountExGst === 'number' && Number.isFinite(raw.baseAmountExGst)
    ? raw.baseAmountExGst
    : undefined;

  if (total !== undefined) {
    parsed.totalAmountInclGst = round2(total);
    const expectedBase = round2(total / (1 + NZ_GST_RATE));
    if (base !== undefined) {
      const diff = Math.abs(expectedBase - base);
      if (diff > GST_TOLERANCE_DOLLARS) {
        console.warn('[quote-parser] GST mismatch — total=', total, 'base=', base,
          'expected base=', expectedBase, '; downgrading confidence.');
        parsed.confidence = 'low';
      }
      parsed.baseAmountExGst = round2(base);
    } else {
      parsed.baseAmountExGst = expectedBase;
    }
  } else if (base !== undefined) {
    // Total wasn't extracted but base was — compute the total.
    parsed.baseAmountExGst = round2(base);
    parsed.totalAmountInclGst = round2(base * (1 + NZ_GST_RATE));
  }

  return parsed;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
