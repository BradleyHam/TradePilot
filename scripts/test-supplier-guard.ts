// Offline regression test for the "supplier must not be the buyer" guard in
// normaliseParsedBill (lib/bill-parser.ts). Pure function, no network / no API
// key needed — safe to run anywhere.
//
// Background: Trademax sends invoices generated through Xero, which print the
// buyer's name ("Lakeside Painting") prominently. The LLM parser occasionally
// returned that as the supplier, so bills showed our OWN business as the
// vendor instead of Trademax. normaliseParsedBill now drops a supplier that
// matches our own business name and downgrades confidence.
//
// Run with:  npx tsx scripts/test-supplier-guard.ts

import { normaliseParsedBill } from '../lib/bill-parser';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// 1. A real supplier passes through untouched.
{
  const r = normaliseParsedBill({ supplier: 'Trademax NZ Limited', confidence: 'high' });
  check('keeps a genuine supplier (Trademax NZ Limited)', r.supplier === 'Trademax NZ Limited', `got ${JSON.stringify(r.supplier)}`);
  check('keeps confidence when supplier is fine', r.confidence === 'high', `got ${r.confidence}`);
}

// 2. Our own business name as supplier is the buyer, not the seller — drop it.
for (const name of ['Lakeside Painting', 'Lakeside Painting Ltd', 'Lakeside Painting Limited', 'LAKESIDE PAINTING', 'Lakeside  Painting']) {
  const r = normaliseParsedBill({ supplier: name, confidence: 'high' });
  check(`drops buyer name as supplier: "${name}"`, r.supplier === undefined, `got ${JSON.stringify(r.supplier)}`);
  check(`downgrades confidence when buyer returned as supplier: "${name}"`, r.confidence === 'low', `got ${r.confidence}`);
}

// 3. A supplier that merely CONTAINS unrelated words is unaffected.
{
  const r = normaliseParsedBill({ supplier: 'Resene Paints Ltd', confidence: 'medium' });
  check('keeps Resene Paints Ltd', r.supplier === 'Resene Paints Ltd', `got ${JSON.stringify(r.supplier)}`);
}

console.log(`\n▶ Result: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
