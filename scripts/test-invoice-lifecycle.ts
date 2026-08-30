import assert from 'node:assert/strict';
import {
  addCalendarDays,
  defaultInvoiceDueDate,
  invoiceCountsAsIssued,
  invoiceDisplayStatus,
  invoiceIsOutstanding,
} from '../lib/invoice-lifecycle';

const today = '2026-08-30';

assert.equal(invoiceDisplayStatus({ status: 'draft', paid: false }, today), 'draft');
assert.equal(invoiceCountsAsIssued({ status: 'draft', paid: false }), false);
assert.equal(invoiceCountsAsIssued({ status: 'sent', paid: false }), true);
assert.equal(invoiceIsOutstanding({ status: 'sent', paid: false }), true);
assert.equal(invoiceDisplayStatus({ status: 'sent', paid: false, dueDate: today }, today), 'due');
assert.equal(invoiceDisplayStatus({ status: 'sent', paid: false, dueDate: '2026-08-29' }, today), 'overdue');
assert.equal(invoiceDisplayStatus({ status: 'sent', paid: false, dueDate: '2026-08-31' }, today), 'sent');
assert.equal(invoiceDisplayStatus({ status: 'paid', paid: true, dueDate: '2026-08-01' }, today), 'paid');
assert.equal(invoiceIsOutstanding({ status: 'paid', paid: true }), false);
assert.equal(invoiceCountsAsIssued({ status: 'void', paid: false }), false);
assert.equal(defaultInvoiceDueDate('2026-08-30', 'deposit', 7), '2026-09-06');
assert.equal(defaultInvoiceDueDate('2026-08-30', 'final', 30), '2026-08-30');
assert.equal(addCalendarDays('2028-02-28', 1), '2028-02-29');

console.log('invoice lifecycle checks passed');
