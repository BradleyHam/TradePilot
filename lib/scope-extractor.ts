// Scope extractor — pulls "what's included" / "what's NOT included" out of
// a quote PDF's text so whoever is on site knows where the job stops.
//
// Same architecture as lib/quote-parser.ts (Anthropic + a single emit
// tool + retry on transient errors), but with one hard extra rule:
//
//   ⚠ NEVER EMIT PRICES.
//
// The output lands in `jobs.scope_included` / `scope_excluded`, which are
// exposed to EMPLOYEES through the money-free `jobs_public` view. A dollar
// figure slipping into an inclusion line would leak job pricing to staff
// and break money-blindness. The model is instructed to strip money,
// `stripMoney()` scrubs anything that survives, and the owner reviews
// every extraction before it saves. Three layers, because one leak is
// one too many.

import Anthropic from '@anthropic-ai/sdk';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';

export const MAX_SCOPE_TEXT_CHARS = 40_000;

/** What the extractor produces. Both lists may be empty. */
export interface ExtractedScope {
  included: string[];
  excluded: string[];
  confidence: 'high' | 'medium' | 'low';
}

const EXTRACT_TOOL: Tool = {
  name: 'emit_scope',
  description:
    'Emit the plain-language scope of a painting job — what the quote ' +
    'includes and what it explicitly excludes — for the painters who ' +
    'will be on site. Never include prices.',
  input_schema: {
    type: 'object',
    properties: {
      included: {
        type: 'array',
        description:
          'What the job COVERS. One short line per item, phrased for a ' +
          'painter on site. No prices, no quantities in dollars.',
        items: { type: 'string' },
      },
      excluded: {
        type: 'array',
        description:
          'What the job explicitly does NOT cover — exclusions, ' +
          'assumptions, "by others", "not included", optional extras the ' +
          'client did not accept. No prices.',
        items: { type: 'string' },
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          "'high' = the quote has explicit inclusions/exclusions sections. " +
          "'medium' = inferred from scope prose. 'low' = little to go on.",
      },
    },
    required: ['included', 'excluded', 'confidence'],
  },
};

const SYSTEM_PROMPT = [
  'You read outgoing painting quotes from a New Zealand painting company ' +
  'and extract the job scope for the PAINTERS WHO WILL DO THE WORK — not ' +
  'for the client, and not for accounting.',
  '',
  'ABSOLUTE RULE: never output prices, dollar amounts, rates, totals, ' +
  'deposits, or GST figures. Not in any field, not in any form, not even ' +
  'as context. The painters reading this are not permitted to see job ' +
  'pricing. If an inclusion is only meaningful with its price (e.g. ' +
  '"extra coat $450"), write the work without the money ("extra coat").',
  '',
  'included: the surfaces, areas and tasks the job covers. Prefer the ' +
  "quote's own words, shortened. One item per line, no numbering. Think " +
  '"what am I painting, and what prep does it involve".',
  '',
  'excluded: anything the quote says is NOT covered — explicit exclusion ' +
  'or assumption lists, "by others", "excludes", "not included", work ' +
  'deferred to a later stage, and optional add-ons that were quoted ' +
  'separately. This is the important half: it stops a painter doing ' +
  'unpaid work by accident.',
  '',
  'Omit an item rather than guess. An empty list is fine and is better ' +
  'than an invented one. The owner reviews everything before it is saved.',
  '',
  'Keep each line under about 100 characters. Plain language. No markdown.',
].join('\n');

/** Anything that looks like money — belt-and-braces after the model. */
const MONEY_RE = /(\$\s?\d[\d,]*(\.\d{1,2})?)|(\b\d[\d,]*(\.\d{1,2})?\s?(nzd|dollars?)\b)|(\bgst\b[^.]{0,20}\d)/i;

/**
 * Drop any line that still smells of money after the model's own filter.
 * Deliberately drops the WHOLE line rather than redacting the figure —
 * a half-scrubbed line ("extra coat — ") reads like a bug, and the owner
 * can always type the line back in during review.
 */
export function stripMoney(lines: string[]): string[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !MONEY_RE.test(l));
}

/** Normalise + de-dupe + cap. Exported for testing. */
export function normaliseScope(raw: Record<string, unknown>): ExtractedScope {
  const asLines = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    const out = stripMoney(v.filter((x): x is string => typeof x === 'string'));
    // De-dupe case-insensitively, keep first spelling, cap the list so a
    // runaway parse can't produce a 200-line wall on a phone.
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const line of out) {
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(line.slice(0, 200));
    }
    return deduped.slice(0, 25);
  };

  return {
    included: asLines(raw.included),
    excluded: asLines(raw.excluded),
    confidence:
      raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
        ? raw.confidence
        : 'low',
  };
}

/**
 * Run the extractor over plain text pulled from a quote PDF. Throws on
 * config/upstream failures — the caller surfaces those.
 */
export async function extractScopeFromText(text: string): Promise<ExtractedScope> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (text.length === 0) throw new Error('Cannot extract from empty text');
  if (text.length > MAX_SCOPE_TEXT_CHARS) {
    throw new Error(`Text too large (${text.length} chars, max ${MAX_SCOPE_TEXT_CHARS})`);
  }

  const client = new Anthropic({ apiKey });
  const response = await callWithRetry(client, text);

  let toolInput: Record<string, unknown> | null = null;
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'emit_scope') {
      if (typeof block.input === 'object' && block.input !== null) {
        toolInput = block.input as Record<string, unknown>;
      }
      break;
    }
  }
  if (!toolInput) throw new Error('Scope extractor returned no structured output');

  return normaliseScope(toolInput);
}

/** Retry on transient Anthropic errors. Mirrors quote-parser. */
async function callWithRetry(client: Anthropic, text: string): Promise<Anthropic.Message> {
  const delays = [1_000, 3_000, 9_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'emit_scope' },
        messages: [
          {
            role: 'user',
            content:
              'Extract the on-site scope from the following quote and call ' +
              'the emit_scope tool. Remember: no prices anywhere.\n\n---\n' +
              text + '\n---',
          },
        ],
      });
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const isRetryable = status === 529 || status === 503 || status === 502 || status === 429;
      if (!isRetryable || attempt >= delays.length) throw err;
      const delayMs = delays[attempt];
      console.warn(`[scope-extractor] Anthropic ${status} on attempt ${attempt + 1}; retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr ?? new Error('Retry loop exhausted unexpectedly');
}
