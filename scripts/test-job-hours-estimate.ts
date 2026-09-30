import assert from 'node:assert/strict';
import type { Entry, Job } from '../lib/types';
import { actualHoursByRole, hoursEstimateDraft, parseHoursEstimate, readHoursEstimate } from '../lib/job-hours-estimate';
import { jobToRow, rowToJob } from '../lib/supabase/mappers';
import { buildProgressSnapshot } from '../lib/job-progress';

const draft = hoursEstimateDraft();
draft.split = true;
draft.roles.experienced = ' 12 hours ';
draft.roles.helper = '12';
const estimate = parseHoursEstimate(draft).value!;
assert.deepEqual(estimate, { total: 24, byRole: { experienced: 12, helper: 12 } });
assert.deepEqual(readHoursEstimate(estimate), estimate);
assert.deepEqual(parseHoursEstimate(hoursEstimateDraft(estimate)).value, estimate);
assert.equal(parseHoursEstimate({ ...hoursEstimateDraft({ total: 24 }), split: true }).value?.total, 24, 'Opening the optional split must not erase a total');
for (const bad of ['-12', 'Infinity', '12oops', '2.123', '100001', '.']) {
  assert.ok(parseHoursEstimate({ ...hoursEstimateDraft(), total: bad }).error, bad);
}
assert.equal(parseHoursEstimate({ ...hoursEstimateDraft(), total: ' 1,200.25 hrs ' }).value?.total, 1200.25);
assert.equal(parseHoursEstimate(hoursEstimateDraft()).value, null);
assert.equal(readHoursEstimate({ total: 24, byRole: { helper: 12 } }), null);
assert.equal(readHoursEstimate({ total: 24, byRole: { owner: 24 } }), null);

const job: Job = { id: 'job', businessId: 'biz', name: 'Hours test', clientName: 'Test', status: 'in-progress', quoteAmount: 2400, hoursEstimate: estimate, createdAt: '', updatedAt: '' };
const entry = (overrides: Partial<Entry>): Entry => ({
  id: 'entry', businessId: 'biz', jobId: job.id, type: 'hours', hours: 6,
  gstApplies: false, description: 'Work', entryDate: '2026-09-01', createdAt: '', ...overrides,
});
const entries = [
  entry({ workerKind: 'owner', helperHours: 2 }),
  entry({ workerKind: 'experienced', hours: 8 }),
  entry({ workerKind: 'helper', hours: 10, loggedByUserId: 'employee' }),
  entry({ workerKind: 'apprentice', hours: 3 }),
  entry({ workerKind: 'subcontractor', hours: 4 }),
  entry({ jobId: 'another-job', hours: 100 }),
  entry({ type: 'expense', hours: 100 }),
  entry({ isDraft: true, hours: 100 }),
];
assert.deepEqual(actualHoursByRole(entries, job.id), {
  total: 33, byRole: { experienced: 14, helper: 12, apprentice: 3, subcontractor: 4 }, legacyHelper: 2,
});
assert.equal(actualHoursByRole([entry({ workerKind: undefined })], job.id).byRole.experienced, 6);
const row = jobToRow(job);
assert.deepEqual(rowToJob({ ...row, id: job.id }).hoursEstimate, estimate);
assert.deepEqual(jobToRow({ hoursEstimate: null }), { hours_estimate: null });
assert.ok(!('hours_estimate' in jobToRow({ name: 'Renamed' })), 'Unrelated edits preserve the budget');
assert.equal(rowToJob({ ...row, hours_estimate: null }).hoursEstimate, null);
const snapshot = buildProgressSnapshot({ job, entries: entries.slice(0, 3), asOfDate: '2026-09-06', state: 'forecast', people: [{ remainingHours: 50 }] });
assert.equal(snapshot.remainingPersonHours, 50);
assert.equal(job.hoursEstimate?.total, 24, 'Work-left updates must not move the original estimate');
console.log('Job hours estimate: parsing, persistence, role totals, legacy hours and forecast separation passed.');
