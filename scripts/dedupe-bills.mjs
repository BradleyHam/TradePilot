// Clean up duplicate bills created before the create-or-merge fix — e.g. a
// forwarded Dulux PDF (with line items + PDF) that landed alongside the
// backfilled amount-only stub of the same invoice (0909019353 vs 909019353).
//
// For each group of bills that look like the SAME invoice (matched by
// normalized invoice number, or identical amount + supplier), if there's a
// "rich" twin (has line items or an attached PDF), any bare STUB in the
// group — no line items, no PDF, not paid, not reconciled to a bank txn —
// is deleted. The rich bill (and anything you've confirmed/reconciled) is
// always kept. Dry-run by default.
//
//   node scripts/dedupe-bills.mjs            # show what it would delete
//   node scripts/dedupe-bills.mjs --apply    # delete the stubs

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

const norm = (s) => (s ?? '').replace(/[^a-z0-9]/gi, '').replace(/^0+/, '').toLowerCase();
const supKey = (s) => (s ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
const hasLineItems = (raw) => {
  const li = raw && typeof raw === 'object' ? raw.lineItems : null;
  return Array.isArray(li) && li.length > 0;
};
const isRich = (b) => hasLineItems(b.parser_raw) || Boolean(b.bill_pdf_url);
const isDeletableStub = (b) =>
  !isRich(b) && !b.paid && !b.bank_transaction_id;

function groupKey(b) {
  const n = norm(b.payment_ref);
  if (n) return `inv:${n}`;
  if (b.amount != null) return `amt:${b.amount}|${supKey(b.supplier ?? b.company)}`;
  return `id:${b.id}`; // ungroupable — its own group, never deleted
}

async function main() {
  const apply = process.argv.includes('--apply');

  const { data, error } = await admin
    .from('entries')
    .select('id, payment_ref, amount, supplier, company, parser_raw, bill_pdf_url, is_draft, paid, bank_transaction_id, created_at')
    .eq('business_id', businessId)
    .eq('type', 'bill');
  if (error) { console.error('Lookup failed:', error); process.exit(1); }
  const bills = data ?? [];

  const groups = new Map();
  for (const b of bills) {
    const k = groupKey(b);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }

  const toDelete = [];
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const hasRich = group.some(isRich);
    if (!hasRich) continue; // nothing to supersede the stub with — leave alone
    for (const b of group) {
      if (isRich(b)) continue;        // keep the rich bill(s)
      if (!isDeletableStub(b)) continue; // keep paid/reconciled ones
      toDelete.push(b);
    }
  }

  const label = (b) => `${(b.supplier ?? b.company ?? '?')} #${b.payment_ref ?? '?'} $${Number(b.amount ?? 0).toFixed(2)}`;
  console.log(`\n${bills.length} bills · ${toDelete.length} duplicate stub(s) to remove\n`);
  for (const b of toDelete) {
    const twin = (groups.get(groupKey(b)) ?? []).find(isRich);
    console.log(`  DELETE stub ${label(b)}  (kept richer twin: ${twin ? label(twin) : '?'})`);
  }

  if (!apply) {
    console.log('\n[dry-run] Nothing deleted. Re-run with --apply to remove the stubs.\n');
    return;
  }
  if (toDelete.length === 0) { console.log('Nothing to remove.\n'); return; }

  const ids = toDelete.map((b) => b.id);
  const { error: delErr } = await admin.from('entries').delete().in('id', ids);
  if (delErr) { console.error('Delete failed:', delErr); process.exit(1); }
  console.log(`\nDeleted ${ids.length} duplicate stub(s).\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
