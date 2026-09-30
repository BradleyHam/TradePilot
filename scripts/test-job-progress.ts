import assert from 'node:assert/strict';
import type { Entry, Job, JobProgressSnapshot } from '../lib/types';
import {
  buildProgressSnapshot,
  earnedDeltaInWindow,
  earnedIncomeByMonthFromProgress,
  earnedToDateAt,
  jobPersonHours,
  jobValueSnapshot,
  latestProgressAt,
  type ProgressSnapshotCalculation,
} from '../lib/job-progress';

const businessId = 'business-1';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    businessId,
    name: 'Test job',
    clientName: 'Test client',
    status: 'in-progress',
    quoteAmount: 10_000,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

let entrySequence = 0;
function hoursEntry(entryDate: string, hours: number, overrides: Partial<Entry> = {}): Entry {
  entrySequence += 1;
  return {
    id: `hours-${entrySequence}`,
    businessId,
    jobId: 'job-1',
    type: 'hours',
    hours,
    workerKind: 'owner',
    gstApplies: false,
    description: 'Work',
    entryDate,
    createdAt: `${entryDate}T18:00:00.000Z`,
    ...overrides,
  };
}

function snapshot(
  calculation: ProgressSnapshotCalculation,
  id: string,
  createdAt: string,
  overrides: Partial<JobProgressSnapshot> = {},
): JobProgressSnapshot {
  return {
    id,
    businessId,
    ...calculation,
    createdAt,
    ...overrides,
  };
}

// 40 person-hours done + 40 left on a $10k job = 50% / $5k earned.
const augustHours = [
  hoursEntry('2026-08-10', 20),
  hoursEntry('2026-08-20', 20),
];
const halfDone = buildProgressSnapshot({
  job: makeJob(),
  entries: augustHours,
  asOfDate: '2026-08-31',
  state: 'forecast',
  people: [{ remainingHours: 40 }],
});
assert.equal(halfDone.actualPersonHours, 40);
assert.equal(halfDone.remainingPersonHours, 40);
assert.equal(halfDone.forecastPersonHours, 80);
assert.equal(halfDone.progressFraction, 0.5);
assert.equal(halfDone.earnedToDateExGst, 5_000);

// Crew duration is person-hours: two people with 8h left each means 16h.
const twoPersonForecast = buildProgressSnapshot({
  job: makeJob(),
  entries: augustHours,
  asOfDate: '2026-08-31',
  state: 'forecast',
  people: [{ remainingHours: 8 }, { remainingHours: 8 }],
});
assert.equal(twoPersonForecast.remainingPersonHours, 16);
assert.equal(twoPersonForecast.forecastPersonHours, 56);

// Historical helperHours are real second-person hours and stay visible.
const legacyHours = [hoursEntry('2026-08-15', 8, { helperHours: 8 })];
assert.deepEqual(jobPersonHours(legacyHours, 'job-1', '2026-08-31'), {
  direct: 8,
  legacyHelper: 8,
  total: 16,
});
const legacyForecast = buildProgressSnapshot({
  job: makeJob(),
  entries: legacyHours,
  asOfDate: '2026-08-31',
  state: 'forecast',
  people: [{ remainingHours: 16 }],
});
assert.equal(legacyForecast.progressFraction, 0.5);
assert.equal(legacyForecast.legacyHelperHours, 8);

const augSnapshot = snapshot(halfDone, 'snapshot-aug', '2026-09-03T09:00:00.000Z');

// Hours after a snapshot consume its remaining forecast linearly, capped at value.
const tenSeptemberHours = [...augustHours, hoursEntry('2026-09-05', 10)];
assert.equal(earnedToDateAt({
  job: makeJob(), entries: tenSeptemberHours, snapshots: [augSnapshot], asOfDate: '2026-09-30',
}).amountExGst, 6_250);
const overrunHours = [...augustHours, hoursEntry('2026-09-05', 80)];
assert.equal(earnedToDateAt({
  job: makeJob(), entries: overrunHours, snapshots: [augSnapshot], asOfDate: '2026-09-30',
}).amountExGst, 10_000);

// Hours added after saving on the same calendar date still consume the
// frozen remaining forecast. Date-only entries cannot otherwise distinguish
// "before save" from "after save", so the snapshot's actual-hours total is
// the durable cutoff.
const laterSameDayHours = [...augustHours, hoursEntry('2026-08-31', 8)];
assert.equal(earnedToDateAt({
  job: makeJob(), entries: laterSameDayHours, snapshots: [augSnapshot], asOfDate: '2026-08-31',
}).amountExGst, 6_000);

// A later month cannot rewrite an earlier month.
const augustBefore = earnedDeltaInWindow({
  job: makeJob(), entries: augustHours, snapshots: [augSnapshot],
  startISO: '2026-08-01', endISO: '2026-08-31',
});
const septemberReforecast = snapshot(halfDone, 'snapshot-sep', '2026-09-10T09:00:00.000Z', {
  asOfDate: '2026-09-10',
  actualPersonHours: 50,
  remainingPersonHours: 50,
  forecastPersonHours: 100,
  progressFraction: 0.5,
  earnedToDateExGst: 5_000,
});
const augustAfter = earnedDeltaInWindow({
  job: makeJob(), entries: tenSeptemberHours, snapshots: [augSnapshot, septemberReforecast],
  startISO: '2026-08-01', endISO: '2026-08-31',
});
assert.equal(augustBefore, 5_000);
assert.equal(augustAfter, augustBefore);

// A deliberately backdated, later-created correction DOES update that month.
const augCorrectionCalc = buildProgressSnapshot({
  job: makeJob(),
  entries: augustHours,
  asOfDate: '2026-08-31',
  state: 'forecast',
  people: [{ remainingHours: 20 }],
});
const augCorrection = snapshot(
  augCorrectionCalc,
  'snapshot-aug-correction',
  '2026-09-04T09:00:00.000Z',
);
assert.equal(latestProgressAt([augSnapshot, augCorrection], 'job-1', '2026-08-31')?.id, augCorrection.id);
assert.equal(earnedDeltaInWindow({
  job: makeJob(), entries: augustHours, snapshots: [augSnapshot, augCorrection],
  startISO: '2026-08-01', endISO: '2026-08-31',
}), 6_666.67);

// Reforecasting more work can create a negative adjustment; never hide it.
const lowerProgress = snapshot(halfDone, 'snapshot-lower', '2026-09-10T12:00:00.000Z', {
  asOfDate: '2026-09-10',
  actualPersonHours: 50,
  remainingPersonHours: 75,
  forecastPersonHours: 125,
  progressFraction: 0.4,
  earnedToDateExGst: 4_000,
});
assert.equal(earnedDeltaInWindow({
  job: makeJob(), entries: tenSeptemberHours, snapshots: [augSnapshot, lowerProgress],
  startISO: '2026-09-01', endISO: '2026-09-30',
}), -1_000);

// Completion forces 100%; the unearned residual lands in the completion month.
const completeCalc = buildProgressSnapshot({
  job: makeJob({ status: 'completed' }),
  entries: tenSeptemberHours,
  asOfDate: '2026-09-15',
  state: 'complete',
  people: [],
});
const completeSnapshot = snapshot(completeCalc, 'snapshot-complete', '2026-09-15T18:00:00.000Z');
assert.equal(completeCalc.progressFraction, 1);
assert.equal(completeCalc.remainingPersonHours, 0);
assert.equal(completeCalc.earnedToDateExGst, 10_000);
assert.equal(earnedDeltaInWindow({
  job: makeJob({ status: 'completed' }), entries: tenSeptemberHours,
  snapshots: [augSnapshot, completeSnapshot],
  startISO: '2026-09-01', endISO: '2026-09-30',
}), 5_000);

// A later final-value increase is recognised in its own month, not rewritten back.
const twelveThousandJob = makeJob({ status: 'completed', invoiceAmount: 12_000 });
const finalValueCalc = buildProgressSnapshot({
  job: twelveThousandJob,
  entries: tenSeptemberHours,
  asOfDate: '2026-09-20',
  state: 'complete',
  people: [],
});
const finalValueSnapshot = snapshot(finalValueCalc, 'snapshot-final-value', '2026-09-20T18:00:00.000Z');
assert.equal(earnedDeltaInWindow({
  job: twelveThousandJob, entries: tenSeptemberHours,
  snapshots: [snapshot(completeCalc, 'snapshot-complete-aug', '2026-08-31T18:00:00.000Z', { asOfDate: '2026-08-31' }), finalValueSnapshot],
  startISO: '2026-09-01', endISO: '2026-09-30',
}), 2_000);

// The job row already includes approved variations; no separate add-on exists here.
assert.deepEqual(jobValueSnapshot(makeJob({ quoteAmount: 11_000 })), {
  amountExGst: 11_000,
  source: 'quote',
  confident: true,
});

// Deposits/cash receipts do not determine percentage-of-work earned.
const deposit: Entry = {
  id: 'deposit', businessId, jobId: 'job-1', type: 'income', amount: 3_000,
  amountExGst: 3_000, gstApplies: false, description: 'Deposit',
  entryDate: '2026-08-01', createdAt: '2026-08-01T10:00:00.000Z',
};
assert.equal(buildProgressSnapshot({
  job: makeJob(), entries: [...augustHours, deposit], asOfDate: '2026-08-31',
  state: 'forecast', people: [{ remainingHours: 40 }],
}).earnedToDateExGst, 5_000);

// An active job without a snapshot is visibly missing, never silently earned.
const missing = earnedToDateAt({
  job: makeJob(), entries: augustHours, snapshots: [], asOfDate: '2026-08-31',
});
assert.equal(missing.amountExGst, 0);
assert.equal(missing.missingForecast, true);
assert.equal(missing.isProvisional, true);

// Terminal jobs with no snapshots retain the former hours-by-month allocation.
const legacyTerminal = makeJob({ status: 'completed', quoteAmount: 8_000, invoiceAmount: undefined });
const legacyTerminalHours = [
  hoursEntry('2026-07-20', 10),
  hoursEntry('2026-08-03', 30),
];
assert.equal(earnedDeltaInWindow({
  job: legacyTerminal, entries: legacyTerminalHours, snapshots: [],
  startISO: '2026-07-01', endISO: '2026-07-31',
}), 2_000);
assert.equal(earnedDeltaInWindow({
  job: legacyTerminal, entries: legacyTerminalHours, snapshots: [],
  startISO: '2026-08-01', endISO: '2026-08-31',
}), 6_000);

// If a forecasted job is marked complete/invoiced/paid, the remaining value
// lands on its finish date even when the optional completion prompt was
// skipped. The earlier month's saved progress is left untouched.
const terminalAfterForecast = makeJob({
  status: 'completed',
  endDate: '2026-09-02',
  updatedAt: '2026-09-02T09:00:00.000Z',
});
assert.equal(earnedDeltaInWindow({
  job: terminalAfterForecast, entries: augustHours, snapshots: [augSnapshot],
  startISO: '2026-08-01', endISO: '2026-08-31',
}), 5_000);
assert.equal(earnedDeltaInWindow({
  job: terminalAfterForecast, entries: augustHours, snapshots: [augSnapshot],
  startISO: '2026-09-01', endISO: '2026-09-30',
}), 5_000);

const terminalWithoutFinishDate = makeJob({
  status: 'invoiced',
  endDate: undefined,
  updatedAt: '2026-09-03T09:00:00.000Z',
});
assert.equal(earnedToDateAt({
  job: terminalWithoutFinishDate,
  entries: augustHours,
  snapshots: [augSnapshot],
  asOfDate: '2026-09-03',
}).amountExGst, 10_000);

// Exact legacy fallback: a terminal job with no hours or dates lands today,
// not in the month its row happened to be edited.
const undatedTerminal = makeJob({
  status: 'completed',
  startDate: undefined,
  endDate: undefined,
  updatedAt: '2026-07-12T12:00:00.000Z',
});
assert.equal(earnedDeltaInWindow({
  job: undatedTerminal, entries: [], snapshots: [],
  startISO: '2026-07-01', endISO: '2026-07-31', todayISO: '2026-09-03',
}), 0);
assert.equal(earnedDeltaInWindow({
  job: undatedTerminal, entries: [], snapshots: [],
  startISO: '2026-09-01', endISO: '2026-09-30', todayISO: '2026-09-03',
}), 10_000);

// Business monthly aggregation keeps exact month keys and cents.
const byMonth = earnedIncomeByMonthFromProgress(
  [makeJob()],
  tenSeptemberHours,
  [augSnapshot],
  ['2026-08', '2026-09'],
);
assert.deepEqual([...byMonth.entries()], [
  ['2026-08', 5_000],
  ['2026-09', 1_250],
]);

assert.throws(() => buildProgressSnapshot({
  job: makeJob(), entries: [], asOfDate: '2026-08-31', state: 'forecast',
  people: [{ remainingHours: -1 }],
}), /Remaining person-hours/);

console.log('job progress checks passed');
