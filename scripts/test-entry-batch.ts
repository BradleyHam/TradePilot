import assert from 'node:assert/strict';
import type { Entry } from '../lib/types';
import { persistEntryBatch } from '../lib/entry-batch';
import { compareJobHours } from '../lib/job-hours-estimate';
import { localTodayISO } from '../lib/format-date';

async function main() {
  const base: Entry = { id: 'ent_1234', businessId: 'business', jobId: 'job', type: 'hours', hours: 3, activity: 'prep', description: 'Prep', entryDate: '2026-09-27', gstApplies: false, workerKind: 'owner', createdAt: '' };
  const batch = [base, { ...base, id: 'ent_5678', activity: 'painting' as const }];
  const ids = new Map<string, string>();
  let calls = 0;
  const saved = await persistEntryBatch(batch, 'business', ids, async (rows) => {
    calls++; assert.equal(rows.length, 2); assert.equal(rows[0].business_id, 'business');
    return { data: rows, error: null };
  });
  assert.equal(calls, 1, 'All activities are sent in one write');
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0].id, saved[1].id);
  await persistEntryBatch(batch, 'business', ids, async (rows) => {
    assert.deepEqual(rows.map((row) => row.id), saved.map((entry) => entry.id), 'An uncertain retry reuses persisted row IDs');
    return { data: rows, error: null };
  });
  await assert.rejects(persistEntryBatch(batch, 'business', ids, async () => ({ data: null, error: { message: 'Network unavailable' } })), /Network unavailable/);
  await assert.rejects(persistEntryBatch(batch, 'business', ids, async (rows) => ({ data: rows.slice(0, 1), error: null })), /not confirmed/);
  await assert.rejects(persistEntryBatch([base, base], 'business', ids, async () => { throw new Error('Must not write duplicate IDs'); }), /own ID/);
  assert.deepEqual(compareJobHours(24, 18, 10), { delta: -6, budgetLeft: 6, usedPercent: 75, forecast: 28, forecastDelta: 4 });
  assert.equal(compareJobHours(24, 18).forecast, null, 'Unused budget must not masquerade as remaining work');
  assert.equal(compareJobHours(24, 30, undefined, true).forecastDelta, 6, 'A finished job compares actuals against the budget');
  assert.equal(compareJobHours(24, 20, undefined, true).forecastDelta, -4);
  assert.equal(compareJobHours(24, 24, undefined, true).forecastDelta, 0);
  assert.equal(localTodayISO(new Date('2026-09-26T20:00:00Z')), '2026-09-27', 'NZ morning must not use the UTC day');
  console.log('Entry batch, retries, failure rejection, hours comparisons and NZ morning date passed.');
}
void main();
