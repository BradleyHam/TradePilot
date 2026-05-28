// Customer-facing INVOICE PDF parser. Sibling of lib/bill-parser.ts.
//
// The bill parser handles supplier invoices (money-out) — uses the
// "supplier", "totalInclGst", "lineItems" vocabulary. This module
// handles invoices WE issued to customers (money-in) — different
// vocabulary, different inference rules.
//
// Why a separate parser:
//   - Different fields. Customer invoices carry an InvoiceKind
//     (deposit/progress/final) that supplier bills don't have. The model
//     needs an explicit instruction to look for that signal.
//   - Different match target. Supplier bills look for jobHint to match
//     against the user's job list. Invoices already know the job
//     (they're filled inside a job's invoice form) — we want a
//     projectRef + customerName for sanity-checking, not matching.
//   - Different field name on the form. The form has an "amount this
//     invoice (ex GST)" field, so we surface amountExGst as the primary
//     output rather than totalInclGst.
//
// Money invariants this module guarantees (same as bill-parser):
//   - amountExGst is ALWAYS recomputed as totalInclGst - gstComponent.
//   - gstComponent is validated against total ÷ 23 × 3 (±$0.10).
//     Mismatch → confidence downgraded to 'low'.

import Anthropic from '@anthropic-ai/sdk';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ParsedInvoice, InvoiceKind } from './types';

const NZ_GST_RATE = 0.15;
const GST_TOLERANCE_DOLLARS = 0.10;

const PARSE_TOOL: Tool = {
  name: 'emit_invoice',
  description:
    'Emit the structured fields extracted from a customer-facing invoice '
    + 'issued by a New Zealand trade business (painter, builder, plumber). '
    + 'Currency is NZD. Dates in ISO YYYY-MM-DD. NZ dates are typically '
    + 'DD/MM/YYYY — interpret them that way.',
  input_schema: {
    type: 'object',
    properties: {
      invoiceNumber: {
        type: 'string',
        description: 'The invoice number/document number as printed (e.g. "INV-034-DEP"). Usually appears near the top of the invoice header.',
      },
      invoiceDate: {
        type: 'string',
        description: 'Date the invoice was issued, in ISO YYYY-MM-DD format. NZ invoices print this as DD/MM/YYYY.',
      },
      dueDate: {
        type: 'string',
        description: 'Date payment is due. If the invoice says "On receipt" or similar, omit dueDate (the form defaults to today).',
      },
      totalInclGst: {
        type: 'number',
        description: 'Total amount due, GST-inclusive (the "Total Due" line).',
      },
      gstComponent: {
        type: 'number',
        description: 'GST portion of the total — usually 15% of the ex-GST subtotal, i.e. totalInclGst ÷ 23 × 3.',
      },
      kind: {
        type: 'string',
        enum: ['deposit', 'progress', 'final'],
        description:
          'Invoice classification. Infer from the description line and the invoice number suffix:\n'
          + '  - "deposit" — line says "Deposit (30%)", "Deposit invoice", "Booking deposit". Suffix often "-DEP".\n'
          + '  - "progress" — line says "Progress payment", "Stage X invoice", "Interim invoice". Suffix often "-P1", "-P2".\n'
          + '  - "final" — line says "Final invoice", "Balance due", "Final payment". Suffix often "-F" or no suffix when this is the only invoice.\n'
          + 'If ambiguous, omit the field rather than guessing.',
      },
      projectRef: {
        type: 'string',
        description: 'Project name or short site description as printed in the "Project:" or "Re:" field. Used for sanity-checking the job match.',
      },
      customerName: {
        type: 'string',
        description: 'Customer/client name from the "Billed To" or "To:" block (a person\'s name, typically).',
      },
      quoteRef: {
        type: 'string',
        description: 'Quote reference printed on the invoice (e.g. "QUO-034", "Quote Ref: QUO-034"). Useful when the invoice references the originating quote.',
      },
      description: {
        type: 'string',
        description: 'A short one-line summary of what this invoice is for, suitable for the form\'s notes/variation field. e.g. "Deposit (30%) — to secure booking" or "Balance after final completion of exterior repaint".',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          "How confident you are in this parse. 'high' = clean structured "
          + "invoice with all fields obvious. 'medium' = some fields inferred. "
          + "'low' = significant guesswork or critical fields missing.",
      },
    },
    required: ['confidence'],
  },
};

const SYSTEM_PROMPT = [
  'You extract structured fields from customer-facing invoices issued by',
  'a New Zealand trade business (painter, builder, plumber, etc.) to their',
  'clients.',
  '',
  'Currency is NZD. GST is 15% — for a GST-registered NZ trader, ',
  'gstComponent should equal totalInclGst ÷ 23 × 3.',
  'Return all dates as ISO YYYY-MM-DD. NZ invoices are dated DD/MM/YYYY.',
  '',
  'INVOICE NUMBER. The customer-facing invoice number printed on the document,',
  'typically in the header next to "INVOICE". For deposit invoices it usually',
  'has a "-DEP" suffix; finals often have "-F"; progress invoices "-P1", "-P2".',
  'Do NOT confuse the invoice number with a quote reference (QUO-…) or PO number.',
  '',
  'INVOICE KIND. Infer from the description heading and the invoice-number',
  'suffix. Painters and builders typically issue:',
  '  - deposit:   to secure the booking, usually 20-30% upfront',
  '  - progress:  interim payments during a long job',
  '  - final:     balance due on completion',
  'When the description or notes say "Deposit (30%)" → kind = deposit.',
  'When it says "Final invoice" or "Balance due on completion" → kind = final.',
  'When ambiguous (e.g. a single invoice for the full amount), omit kind.',
  '',
  'BILLED TO. The customer block usually contains a person\'s name first, then',
  'sometimes a company / organisation name, then an address. Return only the',
  'person\'s name as customerName (the first line of the block) — the address',
  'and company are not needed.',
  '',
  'PROJECT REF. Usually printed under "Project:", "Re:", or similar header.',
  'A short site description like "Administration Building" or',
  '"21 Smith St repaint". Used for sanity-checking which job the invoice',
  'belongs to.',
  '',
  'If a field is not present or you\'re unsure, OMIT it from the tool call.',
  'Wrong data is worse than missing data — missing is recoverable when the',
  'user reviews the populated form.',
].join('\n');

export const MAX_INVOICE_TEXT_CHARS = 40_000;

/**
 * Run the LLM invoice parser on text extracted from a customer-invoice PDF.
 *
 * Throws on: missing API key, oversized/empty text, upstream API failure,
 * missing tool_use block. The route translates these into HTTP responses.
 */
export async function parseInvoiceText(text: string): Promise<ParsedInvoice> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (text.length === 0) throw new Error('Cannot parse empty text');
  if (text.length > MAX_INVOICE_TEXT_CHARS) {
    throw new Error(`Text too large (${text.length} chars, max ${MAX_INVOICE_TEXT_CHARS})`);
  }

  const client = new Anthropic({ apiKey });

  const response = await callAnthropicWithRetry(client, text);

  let toolInput: Record<string, unknown> | null = null;
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'emit_invoice') {
      if (typeof block.input === 'object' && block.input !== null) {
        toolInput = block.input as Record<string, unknown>;
      }
      break;
    }
  }
  if (!toolInput) {
    throw new Error('Parser returned no structured output');
  }

  return normaliseParsedInvoice(toolInput);
}

/**
 * Call Anthropic with exponential backoff on transient failures. Same
 * retry policy as bill-parser — 1s, 3s, 9s on 502/503/529/429.
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
        tool_choice: { type: 'tool', name: 'emit_invoice' },
        messages: [
          {
            role: 'user',
            content:
              'Extract the structured fields from the following customer '
              + 'invoice text and call the emit_invoice tool with them.\n\n'
              + '---\n'
              + text
              + '\n---',
          },
        ],
      });
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const isRetryable = status === 529 || status === 503
        || status === 502 || status === 429;
      const attemptsLeft = attempt < delays.length;
      if (!isRetryable || !attemptsLeft) {
        throw err;
      }
      const delayMs = delays[attempt];
      console.warn(
        `[invoice-parser] Anthropic ${status} on attempt ${attempt + 1}; retrying in ${delayMs}ms`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr ?? new Error('Retry loop exhausted unexpectedly');
}

const VALID_KINDS: ReadonlySet<InvoiceKind> = new Set(['deposit', 'progress', 'final']);

/**
 * Validate and normalise raw tool output into a ParsedInvoice. Same money
 * invariants as bill-parser: amountExGst is always derived, GST is checked.
 */
export function normaliseParsedInvoice(raw: Record<string, unknown>): ParsedInvoice {
  const parsed: ParsedInvoice = {
    confidence: (raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low')
      ? raw.confidence
      : 'low',
  };

  if (typeof raw.invoiceNumber === 'string') parsed.invoiceNumber = raw.invoiceNumber;
  if (typeof raw.invoiceDate === 'string') parsed.invoiceDate = raw.invoiceDate;
  if (typeof raw.dueDate === 'string') parsed.dueDate = raw.dueDate;
  if (typeof raw.projectRef === 'string') parsed.projectRef = raw.projectRef;
  if (typeof raw.customerName === 'string') parsed.customerName = raw.customerName;
  if (typeof raw.quoteRef === 'string') parsed.quoteRef = raw.quoteRef;
  if (typeof raw.description === 'string') parsed.description = raw.description;

  if (typeof raw.kind === 'string' && VALID_KINDS.has(raw.kind as InvoiceKind)) {
    parsed.kind = raw.kind as InvoiceKind;
  }

  const totalInclGst = typeof raw.totalInclGst === 'number' && Number.isFinite(raw.totalInclGst)
    ? raw.totalInclGst
    : undefined;
  const gstClaimed = typeof raw.gstComponent === 'number' && Number.isFinite(raw.gstComponent)
    ? raw.gstComponent
    : undefined;

  if (totalInclGst !== undefined) {
    parsed.totalInclGst = round2(totalInclGst);
    const expectedGst = round2(totalInclGst * NZ_GST_RATE / (1 + NZ_GST_RATE));
    if (gstClaimed !== undefined) {
      const diff = Math.abs(expectedGst - gstClaimed);
      if (diff > GST_TOLERANCE_DOLLARS) {
        console.warn('[invoice-parser] GST mismatch — expected', expectedGst,
          'got', gstClaimed, '; downgrading confidence.');
        parsed.confidence = 'low';
      }
      parsed.gstComponent = round2(gstClaimed);
    } else {
      parsed.gstComponent = expectedGst;
    }
    parsed.amountExGst = round2(totalInclGst - parsed.gstComponent);
  }

  return parsed;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
