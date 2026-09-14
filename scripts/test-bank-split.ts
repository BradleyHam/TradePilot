import assert from 'node:assert/strict';
import { asPersonalBankSplit } from '../lib/bank-split';
import { expensesInWindow } from '../lib/income-allocator';
import { estimateInvoiceBasisGst } from '../lib/tax-estimator';
import { entryToRow, rowToEntry } from '../lib/supabase/mappers';
import type { Entry } from '../lib/types';

const job: Entry = {
  id: 'job-part', businessId: 'business', createdAt: '2026-09-14',
  type: 'expense', jobId: 'rodd-and-gun', category: 'materials',
  amount: 44, amountExGst: 38.26, gstComponent: 5.74, gstApplies: true,
  description: 'Mitre 10', entryDate: '2026-09-07', bankTransactionId: 'bank-transaction',
};
const personal: Entry = { ...job, ...asPersonalBankSplit({ ...job, amount: 18.83 }), id: 'personal-part' };
assert.equal(personal.jobId, undefined);
assert.equal(personal.category, undefined);
assert.equal(personal.type, 'note');
assert.equal(personal.gstApplies, false);
assert.equal(personal.gstComponent, 0);
assert.equal(Math.round((job.amount! + personal.amount!) * 100), 6283);
const restored = rowToEntry({ ...entryToRow(personal), id: personal.id });
assert.equal(restored.type, 'note');
assert.equal(restored.amount, 18.83);
assert.equal(restored.bankTransactionId, 'bank-transaction');
assert.equal(expensesInWindow([job, personal], '2026-09-01', '2026-09-30'), 38.26);
assert.deepEqual(estimateInvoiceBasisGst([job, personal], [], new Date('2026-09-14T12:00:00Z')),
  estimateInvoiceBasisGst([job], [], new Date('2026-09-14T12:00:00Z')));
console.log('PASS: mixed bank split preserves $62.83; only $44 contributes to business costs and GST.');
