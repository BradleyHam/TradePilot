// One-off repair: fix draft bills whose supplier was parsed as our OWN
// business ("Lakeside Painting") instead of the real seller.
//
// Why they're wrong: Trademax invoices are generated through Xero, which
// prints the buyer's name prominently. The LLM bill parser occasionally
// returned "Lakeside Painting" (the buyer) as the supplier, so the Home
// "Bills to confirm" card showed our own business as the vendor. The parser
// is now guarded (see lib/bill-parser.ts — OWN_BUSINESS_NAME_PATTERN), but
// bills already drafted before that fix still carry the wrong name. This
// script corrects them in place.
//
// Scope: only draft bills where supplier/company matches our own name AND the
// invoice reference matches Trademax's Xero pattern ("WANAKA - ...", "WAN1234").
// Anything else is listed and skipped, so a mislabelled non-Trademax bill (if
// one ever exists) is never silently rewritten to the wrong vendor.
//
// Idempotent: bills already showing "Trademax NZ Limited" are skipped.
// Dry-run by default; pass --apply to write.
//
//   npx tsx scripts/fix-trademax-supplier.ts            # dry-run (shows plan)
//   npx tsx scripts/fix-trademax-supplier.ts --apply    # write the fix

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

const OWN_BUSINESS_NAME_PATTERN = /lakeside\s*painting/i;
// Trademax invoices come through Xero as "WANAKA - 5653" / "WANAKA - WAN7942".
const TRADEMAX_REF_PATTERN = /wanaka|^wan[\s-]*\d/i;
const CORRECT_SUPPLIER = 'Trademax NZ Limited';

interface BillRow {
  id: string;
  supplier: string | null;
  company: string | null;
  payment_ref: string | null;
  amount: number | null;
  description: string | null;
  parser_raw: Record<string, unknown> | null;
}

function looksLikeOwnName(s: string | null): boolean {
  return typeof s === 'string' && OWN_BUSINESS_NAME_PATTERN.test(s);
}

async function main() {
  const apply = process.argv.includes('--apply');

  const { data, error } = await admin
    .from('entries')
    .select('id, supplier, company, payment_ref, amount, description, parser_raw')
    .eq('business_id', businessId)
    .eq('type', 'bill')
    .eq('is_draft', true);

  if (error) {
    console.error('Query failed:', error);
    process.exit(1);
  }

  const bills = (data ?? []) as BillRow[];
  const mislabelled = bills.filter((b) => looksLikeOwnName(b.supplier) || looksLikeOwnName(b.company));

  if (mislabelled.length === 0) {
    console.log('No draft bills are mislabelled with our own business name. Nothing to do.');
    return;
  }

  console.log(`Found ${mislabelled.length} draft bill(s) showing our own name as the supplier:\n`);

  const toFix: BillRow[] = [];
  for (const b of mislabelled) {
    const ref = b.payment_ref ?? '(no ref)';
    const isTrademax = typeof b.payment_ref === 'string' && TRADEMAX_REF_PATTERN.test(b.payment_ref);
    if (isTrademax) {
      toFix.push(b);
      console.log(`  FIX  #${ref}  $${b.amount}  "${b.company ?? b.supplier}"  ->  "${CORRECT_SUPPLIER}"`);
    } else {
      console.log(`  SKIP #${ref}  $${b.amount}  "${b.company ?? b.supplier}"  (ref doesn't match Trademax pattern — fix manually)`);
    }
  }

  if (toFix.length === 0) {
    console.log('\nNothing matched the Trademax pattern automatically. Review the SKIP rows above.');
    return;
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to update ${toFix.length} bill(s).`);
    return;
  }

  let updated = 0;
  for (const b of toFix) {
    const existingRaw = (b.parser_raw && typeof b.parser_raw === 'object') ? b.parser_raw : {};
    const patch = {
      supplier: CORRECT_SUPPLIER,
      company: CORRECT_SUPPLIER,
      description: b.payment_ref ? `${CORRECT_SUPPLIER} #${b.payment_ref}` : CORRECT_SUPPLIER,
      parser_raw: { ...existingRaw, supplier: CORRECT_SUPPLIER },
    };
    const { error: upErr } = await admin.from('entries').update(patch).eq('id', b.id);
    if (upErr) {
      console.error(`  ✗ Failed to update #${b.payment_ref}:`, upErr.message);
    } else {
      console.log(`  ✓ Updated #${b.payment_ref} -> ${CORRECT_SUPPLIER}`);
      updated++;
    }
  }
  console.log(`\nDone. ${updated}/${toFix.length} bill(s) corrected.`);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
