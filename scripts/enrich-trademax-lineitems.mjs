// Add line items to backfilled Trademax draft bills, so they show their
// itemised lines on Home and can be SPLIT across jobs (sandpaper -> job A,
// masking tape -> job B). Line items come from the matching Lightspeed POS
// receipt (the till receipt for the same purchase as the Xero invoice).
//
// This seed contains invoice WANAKA-5653 (the $475.51 bill) in full. More
// invoices can be added to LINE_ITEMS below, but the durable answer is the
// vision pass: parse each receipt/PDF once and fill line items for every
// bill automatically.
//
// It MERGES lineItems into the bill's existing parser_raw (leaves all other
// fields untouched) and only touches bills that are still drafts.
//
//   node scripts/enrich-trademax-lineitems.mjs            # dry-run
//   node scripts/enrich-trademax-lineitems.mjs --apply    # write

import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const businessId = process.env.TRADEPILOT_BUSINESS_ID;
if (!url || !serviceKey || !businessId) {
  console.error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TRADEPILOT_BUSINESS_ID');
  process.exit(1);
}
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// invoiceNumber (payment_ref) -> line items. `total` is the EX-GST line
// amount as printed on the Lightspeed receipt (lines sum to the subtotal).
const LINE_ITEMS = {
  'WANAKA - 5653': [
    { description: 'Light-Intex LED 60W Corded', quantity: 1, unitPrice: 165.00, total: 165.00 },
    { description: 'Light-Intex Lumo 2.5W LED Headlamp', quantity: 1, unitPrice: 60.00, total: 60.00 },
    { description: 'Plaster-Straitflex Medium Tape 30M', quantity: 1, unitPrice: 58.80, total: 58.80 },
    { description: 'Plaster-Gib Trade Finish Multi - YELLOW 15L', quantity: 1, unitPrice: 52.75, total: 52.75 },
    { description: 'Futureprotect 1800mm Masking Film Drop S', quantity: 1, unitPrice: 16.85, total: 16.85 },
    { description: 'Gib 75M Paper Tape Marco (12475)', quantity: 1, unitPrice: 8.40, total: 8.40 },
    { description: 'Roller Sleeve-Microfibre Semi Rough 270-9 3pk', quantity: 1, unitPrice: 16.80, total: 16.80 },
    { description: 'Roller Sleeve-Haydn Microfibre 9mm 10pk', quantity: 1, unitPrice: 16.75, total: 16.75 },
    { description: 'Futureprotect 2500mm Masking Film Drop S', quantity: 1, unitPrice: 18.14, total: 18.14 },
  ],
};

async function main() {
  const apply = process.argv.includes('--apply');
  let patched = 0, missing = 0;

  for (const [invoiceNumber, lineItems] of Object.entries(LINE_ITEMS)) {
    const { data, error } = await admin
      .from('entries')
      .select('id, parser_raw, is_draft')
      .eq('business_id', businessId)
      .eq('type', 'bill')
      .eq('payment_ref', invoiceNumber);
    if (error) { console.error('Lookup failed:', error); process.exit(1); }
    const bill = (data ?? [])[0];
    if (!bill) { console.log(`  ${invoiceNumber}: not found in TradePilot — skip`); missing++; continue; }
    if (!bill.is_draft) { console.log(`  ${invoiceNumber}: already confirmed — skip (won't touch a confirmed bill)`); continue; }

    const sum = lineItems.reduce((s, li) => s + li.total, 0);
    console.log(`  ${invoiceNumber}: ${lineItems.length} line items, $${sum.toFixed(2)} ex-GST  -> entry ${bill.id}`);

    if (!apply) continue;

    const mergedRaw = { ...(bill.parser_raw ?? {}), lineItems };
    const { error: updErr } = await admin.from('entries').update({ parser_raw: mergedRaw }).eq('id', bill.id);
    if (updErr) { console.error(`  update failed for ${invoiceNumber}:`, updErr); process.exit(1); }
    patched++;
  }

  console.log(apply
    ? `\nPatched ${patched} bill(s) with line items${missing ? `, ${missing} not found` : ''}. Open Home -> Bills to confirm to split them.\n`
    : `\n[dry-run] Nothing written. Re-run with --apply to add the line items.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
