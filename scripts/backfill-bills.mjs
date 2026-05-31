// Backfill supplier bills found in Gmail (operations restarted Jan 2026)
// into TradePilot as draft bills, so they can be allocated to jobs and
// matched against bank payments on the reconcile screen.
//
// SCOPE — only bills whose amount is reliable straight from the email
// (Trademax Xero invoices, single-amount Dulux invoices, Print It, Pukka,
// Taskhound). Everything else (amounts locked in PDF attachments) is left
// for the vision pass — see the FLAGGED list at the bottom of this file.
//
// SAFETY:
//  - Everything lands as a DRAFT (is_draft=true, paid=false). Nothing hits
//    GST / tax / job profit until Brad confirms it on Home, and nothing is
//    "paid" until matched to a bank payment. So these are proposals, not
//    facts — Brad is the safety check.
//  - Idempotent: skips any bill already present (by source id or invoice #),
//    so re-running is safe and it won't clash with the Resene invoices
//    already in the app or the single Trademax-5653 script.
//  - Amounts are treated as GST-INCLUSIVE totals (NZ convention); GST is
//    derived as total x 3/23. parser_confidence is set to 'medium' so the
//    confirm UI nudges Brad to eyeball each one.
//
//   node scripts/backfill-bills.mjs            # dry-run (prints the plan)
//   node scripts/backfill-bills.mjs --apply    # write the drafts

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

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// total = GST-inclusive amount as printed on the invoice/email.
// entryDate = invoice/issue date (ISO). dueDate optional.
// jobHint = the PO / note text that suggests which job (used by the
//   confirm UI's job ranker; we never auto-assign the job).
// threadId = Gmail thread, used for an idempotency key + provenance.
const BILLS = [
  // ── Trademax NZ (Xero invoices — statement-validated) ──────────────────
  { supplier: 'Trademax NZ Limited', invoiceNumber: 'WANAKA - 2905', total: 638.25, entryDate: '2026-02-01', dueDate: '2026-02-20', threadId: '19c1afa456baff08' },
  { supplier: 'Trademax NZ Limited', invoiceNumber: 'WANAKA - 3013', total: 424.88, entryDate: '2026-02-01', dueDate: '2026-02-20', threadId: '19c1afa4445e44b4' },
  { supplier: 'Trademax NZ Limited', invoiceNumber: 'WANAKA - 3023', total: 22.40,  entryDate: '2026-02-01', dueDate: '2026-02-20', threadId: '19c1afa456ca4068' },
  { supplier: 'Trademax NZ Limited', invoiceNumber: 'WANAKA - 3118', total: 110.69, entryDate: '2026-02-01', dueDate: '2026-02-20', threadId: '19c1afa48e131d6c' },
  { supplier: 'Trademax NZ Limited', invoiceNumber: 'WANAKA - 3119', total: 5.64,   entryDate: '2026-02-01', dueDate: '2026-02-20', threadId: '19c1afa4568a678a' },
  { supplier: 'Trademax NZ Limited', invoiceNumber: 'WANAKA - 3333', total: 54.60,  entryDate: '2026-03-01', dueDate: '2026-03-20', threadId: '19cab9146072f1a4' },
  { supplier: 'Trademax NZ Limited', invoiceNumber: 'WANAKA - 3397', total: 47.50,  entryDate: '2026-03-01', dueDate: '2026-03-20', threadId: '19cab9140fa40068' },
  { supplier: 'Trademax NZ Limited', invoiceNumber: 'WANAKA - 3909', total: 172.50, entryDate: '2026-03-01', dueDate: '2026-03-20', threadId: '19cab9142c9ed84f', note: 'Lightspeed receipt #3909 was a refund — confirm direction.' },
  { supplier: 'Trademax NZ Limited', invoiceNumber: 'WANAKA - 3910', total: 308.57, entryDate: '2026-03-01', dueDate: '2026-03-20', threadId: '19cab914bbd4f823' },
  { supplier: 'Trademax NZ Limited', invoiceNumber: 'WANAKA - 4224', total: 39.73,  entryDate: '2026-03-31', dueDate: '2026-04-20', threadId: '19d45f6a1a7412b9' },
  { supplier: 'Trademax NZ Limited', invoiceNumber: 'WANAKA - 4262', total: 179.61, entryDate: '2026-03-31', dueDate: '2026-04-20', threadId: '19d45f699086c976' },
  { supplier: 'Trademax NZ Limited', invoiceNumber: 'WANAKA - 5653', total: 475.51, entryDate: '2026-04-15', dueDate: '2026-05-20', threadId: '19de099e37665d24' },

  // ── Dulux (single-amount invoice emails — PO ref = job hint) ───────────
  { supplier: 'Dulux', invoiceNumber: '0907837114', total: 38.82,   entryDate: '2026-03-04', jobHint: '56 Dale Street', threadId: '19cb9980245c0de7' },
  { supplier: 'Dulux', invoiceNumber: '0908015736', total: 1453.57, entryDate: '2026-03-13', jobHint: '113 R3', threadId: '19ce8214edf30017', note: 'Same $1453.57 as inv 0908369599 (113 R3) — confirm both are real.' },
  { supplier: 'Dulux', invoiceNumber: '0908369599', total: 1453.57, entryDate: '2026-04-02', jobHint: '113 R3', threadId: '19d4f235804b8283', note: 'Same $1453.57 as inv 0908015736 (113 R3) — confirm both are real.' },
  { supplier: 'Dulux', invoiceNumber: '0908671574', total: 32.80,   entryDate: '2026-04-21', jobHint: 'pizza hut', threadId: '19db0ff1f7dc5517' },
  { supplier: 'Dulux', invoiceNumber: '0908695469', total: 308.95,  entryDate: '2026-04-22', jobHint: 'nicoles job', threadId: '19db6248135734f0' },
  { supplier: 'Dulux', invoiceNumber: '0908727761', total: 23.51,   entryDate: '2026-04-24', jobHint: 'nicoles job', threadId: '19dc0d7362367a76' },
  { supplier: 'Dulux', invoiceNumber: '0908872288', total: 32.11,   entryDate: '2026-05-04', jobHint: '32 Melvin Road', threadId: '19df3f039d26f41d' },
  { supplier: 'Dulux', invoiceNumber: '0909019353', total: 109.64,  entryDate: '2026-05-12', jobHint: 'stock', threadId: '19e1d241f48c65d2' },
  // First invoice of multi-invoice Dulux emails (the sibling is FLAGGED below)
  { supplier: 'Dulux', invoiceNumber: '0908038921', total: 96.76,   entryDate: '2026-03-16', threadId: '19cf76043a4a9c56' },
  { supplier: 'Dulux', invoiceNumber: '0909118279', total: 62.04,   entryDate: '2026-05-18', threadId: '19e3c0bb2f521a4d' },
  { supplier: 'Dulux', invoiceNumber: '0909209638', total: 602.99,  entryDate: '2026-05-22', threadId: '19e50f0fd6302159' },

  // ── Other suppliers (single clear amount) ──────────────────────────────
  { supplier: 'Print It Wanaka', invoiceNumber: 'INV/2026/00501', total: 115.00, entryDate: '2026-05-25', threadId: '19e5cf063546a79f' },
  { supplier: 'Pukka Ltd',       invoiceNumber: 'INV/2026/00811', total: 500.25, entryDate: '2026-05-20', threadId: '19e438a52f4b86c6' },
  { supplier: 'Taskhound',       invoiceNumber: 'INV-0020',       total: 391.00, entryDate: '2026-02-27', dueDate: '2026-03-06', threadId: '19c9d7fead466921', note: 'Software/subscription? Confirm GST (may be overseas / no NZ GST).' },
];

const round2 = (n) => Math.round(n * 100) / 100;

// First word of the supplier, lowercased — a cheap keyword to confirm an
// amount-match is really the same supplier (e.g. 'trademax', 'dulux').
function supplierKey(supplier) {
  return supplier.toLowerCase().split(/\s+/)[0];
}

// "Definitely already imported" — same Gmail source, or an existing BILL
// with the same invoice number.
async function exactMatch(b) {
  const source = `gmail:${b.threadId}`;
  const [bySource, byRef] = await Promise.all([
    admin.from('entries').select('id').eq('business_id', businessId).eq('source_message_id', source),
    admin.from('entries').select('id').eq('business_id', businessId).eq('type', 'bill').eq('payment_ref', b.invoiceNumber),
  ]);
  if (bySource.error || byRef.error) throw (bySource.error ?? byRef.error);
  return (bySource.data?.length ?? 0) + (byRef.data?.length ?? 0) > 0;
}

// Find existing entries (expense OR bill, draft or not) that look like the
// same purchase: supplier name appears in the entry text AND the gross
// amount is close. We split the result into:
//   exact — within 1c (almost certainly the same bill → skip silently)
//   fuzzy — within a small band (e.g. paid in-shop with a card surcharge,
//           like Pukka $500.25 invoice vs $510.26 paid → skip but FLAG for
//           review, because the amount isn't identical).
// Band = max($3, 4% of the bill) so tiny bills aren't over-matched but
// typical surcharges/fees are caught. Better to under-import (you can
// force-add a wrongly-skipped one) than to double up your books.
async function findMatches(b) {
  const gross = round2(b.total);
  const band = Math.max(3, gross * 0.04);
  const key = supplierKey(b.supplier);
  const { data, error } = await admin
    .from('entries')
    .select('id, type, amount, supplier, company, description, entry_date, is_draft, paid')
    .eq('business_id', businessId)
    .gte('amount', gross - band)
    .lte('amount', gross + band);
  if (error) throw error;
  const supplierHits = (data ?? []).filter((e) => {
    const hay = `${e.supplier ?? ''} ${e.company ?? ''} ${e.description ?? ''}`.toLowerCase();
    return hay.includes(key);
  });
  const exact = supplierHits.filter((e) => Math.abs(Number(e.amount) - gross) <= 0.02);
  const fuzzy = supplierHits.filter((e) => !exact.includes(e));
  return { exact, fuzzy };
}

function buildRow(b) {
  const gross = round2(b.total);
  const gst = round2((gross * 3) / 23);      // GST-inclusive total -> GST component
  const ex = round2(gross - gst);
  return {
    business_id: businessId,
    job_id: null,
    type: 'bill',
    is_draft: true,
    paid: false,
    company: b.supplier,
    supplier: b.supplier,
    description: `${b.supplier} #${b.invoiceNumber}`,
    amount: gross,
    amount_ex_gst: ex,
    gst_component: gst,
    gst_applies: true,
    entry_date: b.entryDate,
    due_date: b.dueDate ?? null,
    payment_ref: b.invoiceNumber,
    parser_confidence: 'medium',
    parser_raw: {
      supplier: b.supplier,
      invoiceNumber: b.invoiceNumber,
      totalInclGst: gross,
      gstComponent: gst,
      amountExGst: ex,
      invoiceDate: b.entryDate,
      dueDate: b.dueDate ?? undefined,
      jobHint: b.jobHint ?? undefined,
      confidence: 'medium',
      pulledFrom: 'gmail-backfill',
      sourceThreadId: b.threadId,
      note: b.note ?? undefined,
    },
    source_message_id: `gmail:${b.threadId}`,
    created_at: new Date().toISOString(),
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const toAdd = [];
  const alreadyImported = [];
  const looksPresent = [];   // exact amount + supplier → skip
  const possibleDup = [];    // close amount + supplier → skip, but flag

  for (const b of BILLS) {
    if (await exactMatch(b)) { alreadyImported.push(b); continue; }
    const { exact, fuzzy } = await findMatches(b);
    if (exact.length > 0) { looksPresent.push({ b, m: exact[0] }); continue; }
    if (fuzzy.length > 0) { possibleDup.push({ b, m: fuzzy[0] }); continue; }
    toAdd.push(b);
  }

  const addTotal = round2(toAdd.reduce((s, b) => s + b.total, 0));
  const fmtMatch = (b, m) => `${b.supplier} ${b.invoiceNumber} $${b.total.toFixed(2)}  <->  existing ${m.type} "${(m.description ?? '').slice(0, 38)}" $${Number(m.amount ?? 0).toFixed(2)} (${m.entry_date}${m.is_draft ? ', draft' : ''}${m.paid ? ', paid' : ''})`;

  console.log(`\n=== Backfill plan ===`);
  console.log(`${BILLS.length} bills found in Gmail`);
  console.log(`  ${alreadyImported.length} already imported (same invoice / source) — skip`);
  console.log(`  ${looksPresent.length} already in TradePilot, exact amount match — skip`);
  console.log(`  ${possibleDup.length} POSSIBLE duplicate (amount differs a little) — skip, please review`);
  console.log(`  ${toAdd.length} new → will add  ($${addTotal.toFixed(2)} incl GST)\n`);

  if (possibleDup.length > 0) {
    console.log(`-- Possible duplicates — SKIPPED, amounts differ (e.g. in-shop surcharge). Tell me to force-add any that are genuinely new: --`);
    for (const { b, m } of possibleDup) console.log(`  ${fmtMatch(b, m)}`);
    console.log('');
  }

  if (looksPresent.length > 0) {
    console.log(`-- Already present (exact match) — skipped: --`);
    for (const { b, m } of looksPresent) console.log(`  ${fmtMatch(b, m)}`);
    console.log('');
  }

  if (toAdd.length > 0) {
    console.log(`-- Will add as drafts: --`);
    for (const b of toAdd) {
      console.log(`  ${b.supplier.padEnd(22)} ${String(b.invoiceNumber).padEnd(16)} $${b.total.toFixed(2)}${b.jobHint ? `  (${b.jobHint})` : ''}`);
    }
    console.log('');
  }

  if (!apply) {
    console.log('[dry-run] Nothing written. Re-run with --apply to add ONLY the "will add" bills.\n');
    return;
  }
  if (toAdd.length === 0) { console.log('Nothing new to add.\n'); return; }

  const rows = toAdd.map(buildRow);
  const { data, error } = await admin.from('entries').insert(rows).select('id');
  if (error) { console.error('Insert failed:', error); process.exit(1); }
  console.log(`Inserted ${data.length} draft bills. They're on Home under "Bills to confirm".\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

// ─────────────────────────────────────────────────────────────────────────
// FLAGGED — found in Gmail but NOT imported here (amount is inside a PDF
// attachment or a link-style email). These need the vision/scanner pass:
//
//   Dulux (multi-invoice siblings):   0909215128 (22 May), 0909118555 (18 May),
//                                     0908040110 (16 Mar)
//   Dulux (link-style, no amount):    0909327913 (29 May), 0909307380 (28 May)
//   RS Trade Centre (accounts@rstradecentre.co.nz): orders 56035, 55664,
//                                     55570, 55377  (4 invoices, amounts in PDF)
//   Tool Junction:                    invoice 25118 / order 5126
//   Hireworx (hirepos):               invoice 241515  (~$170.08 paid via Pin)
//   Google Workspace:                 1 Apr + 1 May monthly invoices (PDF)
//
// Already in TradePilot (so skipped): Resene 424640171 ($208.96), 424640175 ($59.80)
// ─────────────────────────────────────────────────────────────────────────
