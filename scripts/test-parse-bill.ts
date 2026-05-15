// Smoke test for the bill parser. Calls Claude Haiku directly with the
// same prompt + tool schema as /api/parse-bill, then prints the parsed
// result + verifies the GST math against the Resene fixture.
//
// Run with:  npx tsx scripts/test-parse-bill.ts
// Needs ANTHROPIC_API_KEY in .env.local — Next.js loads .env.local
// automatically for `npm run dev`, but standalone tsx scripts don't, so
// we point dotenv at it explicitly.

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';

// Real text from the Resene invoice 424640171 — pasted from the PDF.
// Same content that comes out of pdfjs extractPdfText() in the browser.
const RESENE_TEXT = `
For Direct Bank Payment
Resene Paints Ltd - BNZ Lower Hutt
Account: 02-0528-0278270-07
Please quote your customer number as a reference.
Please email your Payment Remittance Advice to accounts@resene.co.nz.
Manage your account easier with myResene, simply visit www.myresene.co.nz to register!
Resene Paints Ltd, PO Box 38242, Wellington Mail Centre, Lower Hutt 5045, Vogel Street, Naenae, Lower Hutt 5011.
Ph: +64 4 577 8112, Fax: +64 4 577 0610. For account enquiries email accounts@resene.co.nz.
Visit us online at www.resene.co.nz.
Invoice Number
Invoice Date
Shop
Packing Slip Number
Due Date Page
Customer PO Number
Customer Number
Line Item Code Description Discount Qty Unit Price Subtotal
087 - Wanaka ColorShop
GST NO: 11-251-293
87,2,2027486
(exc GST) (exc GST)
Lakeside Painting
Rank Higher Ltd
35 Old Racecourse Road
Albert Town
Wanaka 9305
1 of 1
TAX INVOICE
424640171 D69359
13/05/26 10 MCCLOUD AVE
20/06/26
1 2250010 Woodsman Natural WO 10L 25% 1 179.35 179.35
SMOKEY ASH
900 PWLEXC Paintwise - GST Exc 23.48c/Ltr 2.35
Subtotal $
GST Amount $
Total (inc GST) $
27.26
208.96
 181.70
`.trim();

// Expected values — what the parser should return, against which we'll
// score the actual output. Sourced from the PDF.
const EXPECTED = {
  supplier: /resene/i,
  invoiceNumber: '424640171',
  invoiceDate: '2026-05-13',
  dueDate: '2026-06-20',
  totalInclGst: 208.96,
  gstComponent: 27.26,
  amountExGst: 181.70,
  jobHint: /mccloud|10 mc/i,
};

const PARSE_TOOL: Tool = {
  name: 'emit_bill',
  description:
    'Emit the structured fields extracted from a New Zealand supplier ' +
    'invoice. Currency is NZD. Dates in ISO YYYY-MM-DD. NZ dates on ' +
    'invoices are typically DD/MM/YY — interpret them that way.',
  input_schema: {
    type: 'object',
    properties: {
      supplier: { type: 'string' },
      invoiceNumber: { type: 'string' },
      totalInclGst: { type: 'number' },
      gstComponent: { type: 'number' },
      invoiceDate: { type: 'string' },
      dueDate: { type: 'string' },
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
      jobHint: { type: 'string' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
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

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set in .env.local. Aborting.');
    process.exit(1);
  }

  console.log('▶ Calling Claude Haiku with Resene invoice text...');
  const t0 = Date.now();
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
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
          '---\n' + RESENE_TEXT + '\n---',
      },
    ],
  });
  const elapsed = Date.now() - t0;
  console.log(`  ↳ Took ${elapsed}ms; usage:`,
    response.usage?.input_tokens, 'in /', response.usage?.output_tokens, 'out');

  let toolInput: Record<string, unknown> | null = null;
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'emit_bill') {
      toolInput = block.input as Record<string, unknown>;
      break;
    }
  }
  if (!toolInput) {
    console.error('✗ Parser returned no tool_use block. Full response:');
    console.dir(response.content, { depth: null });
    process.exit(1);
  }

  console.log('\n▶ Raw tool input:');
  console.dir(toolInput, { depth: null });

  // ── GST math validation ────────────────────────────────────────────────
  const total = toolInput.totalInclGst as number | undefined;
  const gstClaimed = toolInput.gstComponent as number | undefined;
  if (total !== undefined && gstClaimed !== undefined) {
    const expectedGst = Math.round((total * 0.15) / 1.15 * 100) / 100;
    const diff = Math.abs(expectedGst - gstClaimed);
    const pass = diff <= 0.10;
    console.log(`\n▶ GST check: total=${total}, claimed gst=${gstClaimed}, ` +
      `expected gst=${expectedGst}, diff=$${diff.toFixed(2)} → ${pass ? 'PASS' : 'FAIL'}`);
  }

  // ── Score against expected fixture ─────────────────────────────────────
  console.log('\n▶ Fixture comparison:');
  let passed = 0;
  let failed = 0;
  function check(name: string, got: unknown, expected: unknown) {
    let ok = false;
    if (expected instanceof RegExp) {
      ok = typeof got === 'string' && expected.test(got);
    } else if (typeof expected === 'number' && typeof got === 'number') {
      ok = Math.abs(got - expected) < 0.01;
    } else {
      ok = got === expected;
    }
    if (ok) {
      console.log(`  ✓ ${name}: ${JSON.stringify(got)}`);
      passed++;
    } else {
      console.log(`  ✗ ${name}: got ${JSON.stringify(got)}, expected ${expected}`);
      failed++;
    }
  }
  check('supplier', toolInput.supplier, EXPECTED.supplier);
  check('invoiceNumber', toolInput.invoiceNumber, EXPECTED.invoiceNumber);
  check('invoiceDate', toolInput.invoiceDate, EXPECTED.invoiceDate);
  check('dueDate', toolInput.dueDate, EXPECTED.dueDate);
  check('totalInclGst', toolInput.totalInclGst, EXPECTED.totalInclGst);
  check('gstComponent', toolInput.gstComponent, EXPECTED.gstComponent);
  check('jobHint', toolInput.jobHint, EXPECTED.jobHint);

  console.log(`\n▶ Result: ${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
