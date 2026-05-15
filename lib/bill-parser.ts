// Bill PDF parser — shared between the auth-gated /api/parse-bill route
// (called from the browser upload card) and the /api/webhooks/inbound-bill
// route (called by CloudMailin when a supplier email arrives).
//
// Inputs: plain text extracted from a supplier invoice PDF.
// Outputs: a ParsedBill with money math validated against NZ GST rules.
//
// Money-math invariants this module guarantees:
//   - amountExGst is ALWAYS recomputed server-side from totalInclGst -
//     gstComponent. We never trust the model's subtraction.
//   - gstComponent is checked against the NZ canonical formula
//     (total ÷ 23 × 3). If it differs by more than $0.10, confidence is
//     downgraded to 'low' so the UI nudges the user to double-check.
//
// Why a shared library: the webhook route does the same parse but starts
// from an attachment Buffer rather than pre-extracted text. Keeping the
// LLM call + validation logic in one place means we can't accidentally
// have two slightly-different parsers behaving differently between flows.

import Anthropic from '@anthropic-ai/sdk';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ParsedBill } from './types';

const NZ_GST_RATE = 0.15;
const GST_TOLERANCE_DOLLARS = 0.10;

const PARSE_TOOL: Tool = {
  name: 'emit_bill',
  description:
    'Emit the structured fields extracted from a New Zealand supplier ' +
    'invoice. Currency is NZD. Dates in ISO YYYY-MM-DD. NZ dates on ' +
    'invoices are typically DD/MM/YY — interpret them that way.',
  input_schema: {
    type: 'object',
    properties: {
      supplier: { type: 'string', description: 'Trading name of the supplier (e.g. "Resene Paints Ltd").' },
      invoiceNumber: { type: 'string', description: 'The invoice/document number as printed.' },
      totalInclGst: { type: 'number', description: 'Gross total to pay, GST-inclusive.' },
      gstComponent: { type: 'number', description: 'GST portion of the total.' },
      invoiceDate: { type: 'string', description: 'Date the invoice was issued (ISO YYYY-MM-DD).' },
      dueDate: { type: 'string', description: 'Date payment is due (ISO YYYY-MM-DD).' },
      lineItems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: 'number' },
            unitPrice: { type: 'number' },
            total: { type: 'number' },
          },
          required: ['description'],
        },
      },
      jobHint: {
        type: 'string',
        description:
          'Any text that suggests which job this bill belongs to: ' +
          'customer PO number, site address, reference, project name.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          "How confident you are in this parse. 'high' = clean tax " +
          "invoice with all fields obvious. 'medium' = some fields " +
          "inferred. 'low' = significant guesswork or missing data.",
      },
    },
    required: ['confidence'],
  },
};

const SYSTEM_PROMPT = [
  'You extract structured fields from New Zealand supplier invoices.',
  'Currency is NZD. GST is 15% domestic — for a GST-registered NZ supplier,',
  'gstComponent should equal totalInclGst ÷ 23 × 3.',
  'Return all dates as ISO YYYY-MM-DD. NZ invoices are dated DD/MM/YY.',
  'If a field is not present on the invoice, omit it from the tool call.',
  "If unsure about a field, omit it — don't guess. Wrong data is worse",
  'than missing data; missing is recoverable when the user confirms.',
  '',
  'INVOICE NUMBER vs CUSTOMER NUMBER. These often appear side-by-side in',
  'PDFs and the extracted text may show them as adjacent values like',
  '"424640171 D69359". The INVOICE NUMBER is the long all-digit value',
  'issued by the supplier for THIS document; the CUSTOMER NUMBER',
  'identifies the buyer\'s account and is reused on every invoice (often',
  'shorter, may have letters like "D69359" or "ACC-1234"). When in doubt,',
  'prefer the longer all-digit value that appears under the "Invoice',
  'Number" header. Never return a customer-account code as invoiceNumber.',
  '',
  'JOB HINT. We use this to fuzzy-match the bill to a job in the system.',
  'Prefer in order:',
  '  1. Customer PO Number — usually a site address or project ref the',
  '     buyer entered when ordering. Often contains words/numbers like',
  '     "10 MCCLOUD AVE", "PO-12345", or a project name. Find the VALUE',
  '     under the "Customer PO Number" header — do NOT pick up unrelated',
  '     short numbers like page numbers, line numbers, or quantities.',
  '  2. A reference field with a meaningful project name or address.',
  '  3. Site/delivery address printed separately from the billing address.',
  '  4. Project or job name in a description block.',
  'Return the raw value as printed. If you cannot find a meaningful hint',
  '(e.g. only a 1-2 character number is available), omit jobHint entirely',
  'rather than returning a fragment.',
].join('\n');

export const MAX_BILL_TEXT_CHARS = 40_000;

/**
 * Run the LLM bill parser on text extracted from a supplier PDF.
 *
 * Throws on:
 *   - ANTHROPIC_API_KEY missing (programmer error)
 *   - text too large (caller should check MAX_BILL_TEXT_CHARS first)
 *   - empty text
 *   - upstream API failure
 *   - parser returning no tool_use block (extremely rare with tool_choice)
 *
 * Caller (the route) is responsible for translating these into HTTP error
 * responses. Keeping them as throws here means the parser can be reused
 * in a non-HTTP context (e.g. a future batch reprocessing script) without
 * mocking up a fake Request.
 */
export async function parseBillText(text: string): Promise<ParsedBill> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (text.length === 0) throw new Error('Cannot parse empty text');
  if (text.length > MAX_BILL_TEXT_CHARS) {
    throw new Error(`Text too large (${text.length} chars, max ${MAX_BILL_TEXT_CHARS})`);
  }

  const client = new Anthropic({ apiKey });

  const response = await callAnthropicWithRetry(client, text);

  // Locate the tool_use block. Forcing tool_choice means it MUST be present,
  // but defensive lookups are cheap.
  let toolInput: Record<string, unknown> | null = null;
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'emit_bill') {
      if (typeof block.input === 'object' && block.input !== null) {
        toolInput = block.input as Record<string, unknown>;
      }
      break;
    }
  }
  if (!toolInput) {
    throw new Error('Parser returned no structured output');
  }

  return normaliseParsedBill(toolInput);
}

/**
 * Call Anthropic with exponential backoff on transient failures. We retry on:
 *   - 529 Overloaded — capacity blip, almost always clears in 1–3s
 *   - 503 Service Unavailable — same shape
 *   - 502 Bad Gateway — usually a brief proxy hiccup
 *   - 429 Rate Limit — back off and try once
 *
 * We do NOT retry on 4xx auth/validation errors — they won't get better.
 *
 * Three attempts total with delays of 1s, 3s, 9s. Worst case the webhook
 * blocks for ~13s before giving up; better than failing a real bill the
 * user expected to see.
 */
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
        tool_choice: { type: 'tool', name: 'emit_bill' },
        messages: [
          {
            role: 'user',
            content:
              'Extract the structured invoice fields from the following ' +
              'supplier bill text and call the emit_bill tool with them.\n\n' +
              '---\n' +
              text +
              '\n---',
          },
        ],
      });
    } catch (err) {
      lastErr = err;
      // The Anthropic SDK throws APIError subclasses; status is on .status.
      const status = (err as { status?: number })?.status;
      const isRetryable = status === 529 || status === 503
        || status === 502 || status === 429;
      const attemptsLeft = attempt < delays.length;
      if (!isRetryable || !attemptsLeft) {
        throw err;
      }
      const delayMs = delays[attempt];
      console.warn(
        `[bill-parser] Anthropic ${status} on attempt ${attempt + 1}; retrying in ${delayMs}ms`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  // Unreachable — the loop either returns or throws — but TS doesn't know.
  throw lastErr ?? new Error('Retry loop exhausted unexpectedly');
}

/**
 * Validate and normalise raw tool output into a ParsedBill. Exported so
 * tests and future re-processing scripts can verify a stored parserRaw
 * blob without making a new API call.
 *
 * Money invariants enforced:
 *   - If totalInclGst is present, gstComponent is checked against the NZ
 *     formula (±$0.10). Mismatch → confidence downgraded to 'low'.
 *   - amountExGst is ALWAYS recomputed as totalInclGst - gstComponent.
 *     Never trust the model's subtraction.
 */
export function normaliseParsedBill(raw: Record<string, unknown>): ParsedBill {
  const parsed: ParsedBill = {
    confidence: (raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low')
      ? raw.confidence
      : 'low',
  };

  if (typeof raw.supplier === 'string') parsed.supplier = raw.supplier;
  if (typeof raw.invoiceNumber === 'string') parsed.invoiceNumber = raw.invoiceNumber;
  if (typeof raw.invoiceDate === 'string') parsed.invoiceDate = raw.invoiceDate;
  if (typeof raw.dueDate === 'string') parsed.dueDate = raw.dueDate;
  if (typeof raw.jobHint === 'string') parsed.jobHint = raw.jobHint;
  if (Array.isArray(raw.lineItems)) {
    parsed.lineItems = raw.lineItems
      .filter((li): li is Record<string, unknown> => typeof li === 'object' && li !== null)
      .map((li) => ({
        description: typeof li.description === 'string' ? li.description : '',
        quantity: typeof li.quantity === 'number' ? li.quantity : undefined,
        unitPrice: typeof li.unitPrice === 'number' ? li.unitPrice : undefined,
        total: typeof li.total === 'number' ? li.total : undefined,
      }))
      .filter((li) => li.description.length > 0);
  }

  const totalInclGst = typeof raw.totalInclGst === 'number' && Number.isFinite(raw.totalInclGst)
    ? raw.totalInclGst
    : undefined;
  const gstClaimed = typeof raw.gstComponent === 'number' && Number.isFinite(raw.gstComponent)
    ? raw.gstComponent
    : undefined;

  if (totalInclGst !== undefined) {
    parsed.totalInclGst = round2(totalInclGst);
    // Derive the canonical GST from the total. Treat this as truth.
    const expectedGst = round2(totalInclGst * NZ_GST_RATE / (1 + NZ_GST_RATE));
    if (gstClaimed !== undefined) {
      const diff = Math.abs(expectedGst - gstClaimed);
      if (diff > GST_TOLERANCE_DOLLARS) {
        console.warn('[bill-parser] GST mismatch — expected', expectedGst,
          'got', gstClaimed, '; downgrading confidence.');
        parsed.confidence = 'low';
      }
      parsed.gstComponent = round2(gstClaimed);
    } else {
      // Model didn't return a GST figure. Use the derived one.
      parsed.gstComponent = expectedGst;
    }
    parsed.amountExGst = round2(totalInclGst - parsed.gstComponent);
  }

  return parsed;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
