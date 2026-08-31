// Smoke test for lib/notification-rules.ts — fixture worlds in,
// expected candidates out. Pure functions, so no env/db needed:
//
//   npx tsx scripts/test-notification-rules.ts

import { evaluateNotificationRules } from '../lib/notification-rules';
import { gstPeriodOf, mostRecentlyClosedGstPeriod } from '../lib/gst-calendar';
import type { Entry, Job, PayRun, ScheduleItem } from '../lib/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const job = (over: Partial<Job>): Job => ({
  id: over.id ?? 'J1',
  businessId: 'B',
  name: 'Exterior repaint — 12 Test St',
  clientName: 'Sam Customer',
  status: 'lead',
  createdAt: '2026-08-01T00:00:00Z',
  ...over,
} as Job);

const empty = {
  jobs: [] as Job[],
  scheduleToday: [] as ScheduleItem[],
  bills: [] as Entry[],
  payRuns: [] as PayRun[],
};
const TODAY = '2026-08-12';

const keys = (inp: Partial<typeof empty> & { todayISO?: string }) =>
  evaluateNotificationRules({ ...empty, todayISO: TODAY, ...inp })
    .map((c) => `${c.ruleKey}:${c.dedupeKey}`);

// ── Quote promises ─────────────────────────────────────────────────────────
check('promise due tomorrow → t1',
  keys({ jobs: [job({ quoteReadyBy: '2026-08-13' })] }).includes('quote-promise:J1:2026-08-13:t1'));
check('promise due today → t0',
  keys({ jobs: [job({ quoteReadyBy: '2026-08-12' })] }).includes('quote-promise:J1:2026-08-12:t0'));
check('promise overdue → late',
  keys({ jobs: [job({ quoteReadyBy: '2026-08-01' })] }).includes('quote-promise:J1:2026-08-01:late'));
check('promise on a quoted job is silent',
  keys({ jobs: [job({ status: 'quoted', quoteReadyBy: '2026-08-01' })] }).every((k) => !k.startsWith('quote-promise')));
check('snoozed job is silent',
  keys({ jobs: [job({ quoteReadyBy: '2026-08-01', snoozeUntil: '2026-09-01' })] }).every((k) => !k.startsWith('quote-promise')));

// ── Uncontacted leads ──────────────────────────────────────────────────────
check('2-day-old lead → 24h nudge',
  keys({ jobs: [job({ leadDate: '2026-08-10', source: 'email' })] }).includes('lead-uncontacted:J1:24h'));
check('5-day-old lead → 3d escalation',
  keys({ jobs: [job({ leadDate: '2026-08-07' })] }).includes('lead-uncontacted:J1:3d'));
check('contacted lead is silent',
  keys({ jobs: [job({ leadDate: '2026-08-10', lastContactedDate: '2026-08-11T00:00:00Z' })] }).every((k) => !k.startsWith('lead-uncontacted')));
check('promised-quote lead not double-nagged as uncontacted',
  keys({ jobs: [job({ leadDate: '2026-08-10', quoteReadyBy: '2026-08-20' })] }).every((k) => !k.startsWith('lead-uncontacted')));

// ── Follow-ups ─────────────────────────────────────────────────────────────
check('quoted job past followUpDate → chase',
  keys({ jobs: [job({ status: 'quoted', followUpDate: '2026-08-11' })] }).includes('quote-follow-up:J1:2026-08-11'));
check('future followUpDate is silent',
  keys({ jobs: [job({ status: 'quoted', followUpDate: '2026-08-20' })] }).every((k) => !k.startsWith('quote-follow-up')));

// ── EI filing (2 working days after payday) ────────────────────────────────
const run = (over: Partial<PayRun>): PayRun => ({
  id: 'P1', businessId: 'B', employeeName: 'Suzie', periodStart: '2026-07-27',
  periodEnd: '2026-08-09', gross: 875, paid: true, paidDate: '2026-08-10',
  eiFiled: false, payePaid: false, createdAt: '2026-08-10T00:00:00Z',
  ...over,
} as PayRun);
// Paid Mon 10 Aug → EI due Wed 12 Aug (= TODAY).
check('EI due today fires', keys({ payRuns: [run({})] }).includes('ei-filing:P1:due'));
check('EI overdue fires late', keys({ payRuns: [run({ paidDate: '2026-08-05' })] }).includes('ei-filing:P1:late'));
check('filed EI is silent', keys({ payRuns: [run({ eiFiled: true })] }).every((k) => !k.startsWith('ei-filing')));

// ── PAYE (due 20th of following month) ─────────────────────────────────────
check('PAYE 8 days out is quiet',
  keys({ payRuns: [run({ paidDate: '2026-07-24', eiFiled: true })] }).every((k) => !k.startsWith('paye')));
check('PAYE 3 days out → soon',
  keys({ todayISO: '2026-08-17', payRuns: [run({ paidDate: '2026-07-24', eiFiled: true })] }).includes('paye:2026-07:soon'));
check('PAYE overdue → late',
  keys({ todayISO: '2026-08-25', payRuns: [run({ paidDate: '2026-07-24', eiFiled: true })] }).includes('paye:2026-07:late'));
check('paid PAYE is silent',
  keys({ todayISO: '2026-08-20', payRuns: [run({ paidDate: '2026-07-24', eiFiled: true, payePaid: true })] }).every((k) => !k.startsWith('paye')));

// ── GST (verified six-monthly Jan/Jul cycle) ──────────────────────────────
check('GST period in June is Feb–Jul', gstPeriodOf(new Date('2026-06-15T12:00:00')).end === '2026-07-31');
check('GST period in October is Aug–Jan', gstPeriodOf(new Date('2026-10-15T12:00:00')).end === '2027-01-31');
check('Jul period is due 28 Aug', gstPeriodOf(new Date('2026-06-15T12:00:00')).dueDate === '2026-08-28');
check('Jan 2027 period rolls Sunday deadline to Monday', gstPeriodOf(new Date('2027-01-15T12:00:00')).dueDate === '2027-03-01');
check('latest closed period on 31 Jul is still Jan', mostRecentlyClosedGstPeriod(new Date('2026-07-31T12:00:00')).end === '2026-01-31');
check('latest closed period on 1 Aug is Jul', mostRecentlyClosedGstPeriod(new Date('2026-08-01T12:00:00')).end === '2026-07-31');
check('GST 16 days out is quiet', keys({}).every((k) => !k.startsWith('gst')));
check('GST inside 7 days → soon', keys({ todayISO: '2026-08-22' }).includes('gst:2026-07-31:soon'));
check('GST due day → due', keys({ todayISO: '2026-08-28' }).includes('gst:2026-07-31:due'));
check('GST just past → late', keys({ todayISO: '2026-09-02' }).includes('gst:2026-07-31:late'));
check('No false two-monthly GST reminder in mid-Jan', keys({ todayISO: '2027-01-10' }).every((k) => !k.startsWith('gst')));
check('Jan period reminder starts inside 7 days', keys({ todayISO: '2027-02-22' }).includes('gst:2027-01-31:soon'));
check('Jan period is due on rolled working day', keys({ todayISO: '2027-03-01' }).includes('gst:2027-01-31:due'));

// ── Morning digest ─────────────────────────────────────────────────────────
const digest = evaluateNotificationRules({
  ...empty,
  todayISO: TODAY,
  scheduleToday: [
    { id: 'S1', businessId: 'B', type: 'job_booking', title: 'McLeod Ave', date: TODAY, startTime: '08:00', completed: false } as ScheduleItem,
  ],
  bills: [
    { id: 'E1', businessId: 'B', type: 'bill', amount: 100, isDraft: true, entryDate: TODAY } as Entry,
    { id: 'E2', businessId: 'B', type: 'bill', amount: 50, paid: false, dueDate: '2026-08-14', entryDate: TODAY } as Entry,
  ],
}).find((c) => c.ruleKey === 'morning-digest');
check('digest fires with content', !!digest && digest.dedupeKey === TODAY);
check('digest lists the booking with time', !!digest?.body?.includes('McLeod Ave 08:00'), digest?.body);
check('digest counts draft + due bills',
  !!digest?.body?.includes('1 bill to confirm') && !!digest.body.includes('1 bill due this week'), digest?.body);
check('empty day → NO digest',
  keys({}).every((k) => !k.startsWith('morning-digest')));

// ── Priority ordering ──────────────────────────────────────────────────────
const ordered = evaluateNotificationRules({
  ...empty,
  todayISO: TODAY,
  jobs: [job({ quoteReadyBy: TODAY })],
  payRuns: [run({})],
});
check('IRD deadline outranks quote promise (cap safety)',
  ordered.findIndex((c) => c.ruleKey === 'ei-filing') < ordered.findIndex((c) => c.ruleKey === 'quote-promise'));

console.log(failures === 0 ? '\nAll notification-rule checks passed.' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
