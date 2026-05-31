// One-off: pull the Trademax invoice WANAKA-5653 ($475.51) into TradePilot
// as a draft bill, so it can be allocated to a job and matched against the
// 18 May $475.51 bank payment on the reconcile screen.
//
// Source: Gmail — Xero invoice email "Invoice WANAKA - 5653 from Trademax NZ
// Limited" (thread 19de099e37665d24) + the itemised Lightspeed receipt #5653
// (thread 19d8df6a95c6b6f0). Both confirm: subtotal $413.49, GST $62.02,
// total $475.51, issued 15 Apr 2026, due 20 May 2026.
//
// Why a script (not the webhook): the bill arrived as a Xero hosted-invoice
// link, which the email pipeline can't ingest yet. This inserts the same
// draft the webhook would have, via the admin client (service role, bypasses
// RLS — there's no auth.uid() in a script).
//
// Idempotent: skips if a bill with this invoice number or source already
// exists. Dry-run by default; pass --apply to write.
//
//   npx tsx scripts/add-trademax-5653-bill.ts            # dry-run
//   npx tsx scripts/add-trademax-5653-bill.ts --apply    # write

import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const businessId = process.env.TRADEPILOT_BUSINESS_ID;

if (!url || !serviceKey || !businessId) {
  console.error('Missing env: need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TRADEPILOT_BUSINESS_ID in .env.local');
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Stable id so re-runs dedup against the webhook's unique
// (business_id, source_message_id) index too.
const SOURCE_MESSAGE_ID = 'gmail:19de099e37665d24';
const INVOICE_NUMBER = 'WANAKA - 5653';

// Ex-GST line totals straight off receipt #5653. Sum = 413.49.
const lineItems = [
  { description: 'Light-Intex LED 60W Corded', quantity: 1, unitPrice: 165.00, total: 165.00 },
  { description: 'Light-Intex Lumo 2.5W LED Headlamp', quantity: 1, unitPrice: 60.00, total: 60.00 },
  { description: 'Plaster-Straitflex Medium Tape 30M', quantity: 1, unitPrice: 58.80, total: 58.80 },
  { description: 'Plaster-Gib Trade Finish Multi - YELLOW 15L', quantity: 1, unitPrice: 52.75, total: 52.75 },
  { description: 'Futureprotect 1800mm Masking Film Drop S', quantity: 1, unitPrice: 16.85, total: 16.85 },
  { description: 'Gib 75M Paper Tape Marco (12475)', quantity: 1, unitPrice: 8.40, total: 8.40 },
  { description: 'Roller Sleeve-Microfibre Semi Rough 270-9 3pk', quantity: 1, unitPrice: 16.80, total: 16.80 },
  { description: 'Roller Sleeve-Haydn Microfibre 9mm 10pk', quantity: 1, unitPrice: 16.75, total: 16.75 },
  { description: 'Futureprotect 2500mm Masking Film Drop S', quantity: 1, unitPrice: 18.14, total: 18.14 },
];

const parsed = {
  supplier: 'Trademax NZ Limited',
  invoiceNumber: INVOICE_NUMBER,
  totalInclGst: 475.51,
  gstComponent: 62.02,
  amountExGst: 413.49,
  invoiceDate: '2026-04-15',
  dueDate: '2026-05-20',
  lineItems,
  confidence: 'high' as const,
};

async function main() {
  const apply = process.argv.includes('--apply');

  // ── Idempotency: skip if already present (by source id or invoice #) ──
  const bySource = await admin
    .from('entries')
    .select('id, amount, is_draft, paid')
    .eq('business_id', businessId)
    .eq('source_message_id', SOURCE_MESSAGE_ID);
  const byRef = await admin
    .from('entries')
    .select('id, amount, is_draft, paid')
    .eq('business_id', businessId)
    .eq('type', 'bill')
    .eq('payment_ref', INVOICE_NUMBER);

  if (bySource.error || byRef.error) {
    console.error('Lookup failed:', bySource.error ?? byRef.error);
    process.exit(1);
  }
  const existing = [...(bySource.data ?? []), ...(byRef.data ?? [])];
  if (existing.length > 0) {
    console.log(`Already present (${existing.length} match) — nothing to do.`);
    console.log(existing);
    return;
  }

  const row = {
    business_id: businessId,
    job_id: null, // general consumables — Brad allocates on confirm
    type: 'bill',
    is_draft: true,
    paid: false,
    company: parsed.supplier,
    supplier: parsed.supplier,
    description: `${parsed.supplier} #${parsed.invoiceNumber}`,
    amount: parsed.totalInclGst,
    amount_ex_gst: parsed.amountExGst,
    gst_component: parsed.gstComponent,
    gst_applies: true,
    entry_date: parsed.invoiceDate,
    due_date: parsed.dueDate,
    payment_ref: parsed.invoiceNumber,
    parser_confidence: parsed.confidence,
    parser_raw: {
      ...parsed,
      dueDateSource: 'pdf',
      pulledFrom: 'gmail',
      sourceThreadId: '19de099e37665d24',
    },
    source_message_id: SOURCE_MESSAGE_ID,
    created_at: new Date().toISOString(),
  };

  if (!apply) {
    console.log('[dry-run] would insert this draft bill:');
    console.log(JSON.stringify(row, null, 2));
    console.log('\nRe-run with --apply to write it.');
    return;
  }

  const { data, error } = await admin.from('entries').insert(row).select('id').single();
  if (error || !data) {
    console.error('Insert failed:', error);
    process.exit(1);
  }
  console.log(`Inserted draft bill ${data.id} — Trademax ${INVOICE_NUMBER}, $${parsed.totalInclGst}.`);
  console.log('It will show on Home under "Bills to confirm".');
}

main().catch((e) => { console.error(e); process.exit(1); });
