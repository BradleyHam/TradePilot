// =============================================================
// Notification rules — pure functions, no I/O
// =============================================================
//
// Decides WHAT the app should nudge Brad about, given a snapshot of
// the world and today's date (NZ time — the caller resolves that).
// The cron route feeds it data and sends whatever comes back;
// `lib/push-notify.ts` guarantees each candidate fires at most once
// per dedupe key, so rules here can emit the same candidate every run
// without spamming — that's the design: rules DESCRIBE states, the
// log dedupes them.
//
// Design rules (the anti-nag contract):
//   - A rule never re-fires the same key. Escalation = a NEW key at a
//     later state ('t1' → 't0' → 'late'), each once. Nothing fires
//     daily forever — repeat nags train the user to ignore push, and
//     then the important ones die with the noise.
//   - Everything self-clears: do the thing (send the quote, log a
//     contact, tick eiFiled) and the rule's condition goes false.
//   - Every candidate deep-links to the screen where the fix happens.
//   - The digest is ONE notification (tagged, so an unread yesterday
//     digest is replaced, never stacked).
//
// Money-order priority (matches the build discussion): quote promises
// → waiting leads → quote follow-ups → IRD deadlines → daily digest.

import type { Entry, Job, PayRun, ScheduleItem } from './types';
import { eiFilingDueDate, payeMonthsDue } from './payroll';
import type { BusinessNotification } from './push-notify';

export interface RuleInputs {
  /** ISO date in NZ local time — the caller resolves Pacific/Auckland. */
  todayISO: string;
  /** Jobs in status 'lead' or 'quoted' (others are irrelevant to v1 rules). */
  jobs: Job[];
  /** Schedule items for today only. */
  scheduleToday: ScheduleItem[];
  /** Bill entries (type === 'bill'), drafts included. */
  bills: Entry[];
  payRuns: PayRun[];
}

// ── Date helpers (string-safe, mirror lib/payroll.ts) ──────────────────────

function parseISO(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00`);
}

function addDaysISO(iso: string, n: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((parseISO(toISO).getTime() - parseISO(fromISO).getTime()) / 86_400_000);
}

/** "Thu 14 Aug" — short enough for a lock screen. */
export function friendlyDate(iso: string): string {
  return parseISO(iso).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
}

function snoozed(j: Job, todayISO: string): boolean {
  return !!j.snoozeUntil && j.snoozeUntil > todayISO;
}

// ── Individual rules ───────────────────────────────────────────────────────

/**
 * Quote promises — the quoteReadyBy date Brad set in the site-visit
 * wrap-up ("I'll send the quote by …"). The single most
 * money-attached date in the app and, until now, nothing watched it.
 * Applies to jobs still at 'lead' (visited, not yet quoted).
 */
function quotePromiseRules(jobs: Job[], todayISO: string): BusinessNotification[] {
  const out: BusinessNotification[] = [];
  const tomorrow = addDaysISO(todayISO, 1);
  for (const j of jobs) {
    if (j.status !== 'lead' || !j.quoteReadyBy || snoozed(j, todayISO)) continue;
    const who = j.clientName ? ` for ${j.clientName}` : '';
    if (j.quoteReadyBy === tomorrow) {
      out.push({
        ruleKey: 'quote-promise',
        dedupeKey: `${j.id}:${j.quoteReadyBy}:t1`,
        title: 'Quote due tomorrow',
        body: `${j.name}${who} — you promised it by ${friendlyDate(j.quoteReadyBy)}.`,
        url: '/home',
      });
    } else if (j.quoteReadyBy === todayISO) {
      out.push({
        ruleKey: 'quote-promise',
        dedupeKey: `${j.id}:${j.quoteReadyBy}:t0`,
        title: 'Quote due today',
        body: `${j.name}${who} — today's the day you promised.`,
        url: '/home',
      });
    } else if (j.quoteReadyBy < todayISO) {
      // Fires once whenever first seen overdue (no exact-day match —
      // a missed cron run must not swallow it forever).
      out.push({
        ruleKey: 'quote-promise',
        dedupeKey: `${j.id}:${j.quoteReadyBy}:late`,
        title: 'Quote overdue',
        body: `${j.name}${who} was promised by ${friendlyDate(j.quoteReadyBy)}. Send it or re-set the date.`,
        url: '/home',
      });
    }
  }
  return out;
}

/**
 * Leads nobody has talked to. Speed-to-lead is the biggest win-rate
 * lever there is, and Tapi/email leads arrive silently via webhook.
 * A quoteReadyBy on the job implies contact happened (the wrap-up is
 * filled in standing in the customer's driveway), so those are out.
 */
function leadUncontactedRules(jobs: Job[], todayISO: string): BusinessNotification[] {
  const out: BusinessNotification[] = [];
  for (const j of jobs) {
    if (j.status !== 'lead' || j.lastContactedDate || j.quoteReadyBy || snoozed(j, todayISO)) continue;
    const arrived = (j.leadDate ?? j.createdAt ?? '').slice(0, 10);
    if (!arrived) continue;
    const age = daysBetween(arrived, todayISO);
    const from = j.source ? ` (${j.source})` : '';
    if (age >= 3 && age <= 21) {
      out.push({
        ruleKey: 'lead-uncontacted',
        dedupeKey: `${j.id}:3d`,
        title: 'Lead going cold',
        body: `${j.name}${from} came in ${age} days ago — still no contact logged.`,
        url: '/leads',
      });
    } else if (age >= 1 && age <= 14) {
      out.push({
        ruleKey: 'lead-uncontacted',
        dedupeKey: `${j.id}:24h`,
        title: 'Lead waiting',
        body: `${j.name}${from} — no contact logged yet. A quick call today beats a great call next week.`,
        url: '/leads',
      });
    }
  }
  return out;
}

/**
 * Quote follow-ups — the +5-day ladder already sets followUpDate on
 * quoted jobs; this surfaces it the morning it falls due. Keyed on
 * the date, so bumping the follow-up re-arms the rule.
 */
function followUpRules(jobs: Job[], todayISO: string): BusinessNotification[] {
  const out: BusinessNotification[] = [];
  for (const j of jobs) {
    if (j.status !== 'quoted' || !j.followUpDate || snoozed(j, todayISO)) continue;
    if (j.followUpDate > todayISO) continue;
    const who = j.clientName ? ` ${j.clientName}` : '';
    out.push({
      ruleKey: 'quote-follow-up',
      dedupeKey: `${j.id}:${j.followUpDate}`,
      title: 'Chase that quote',
      body: `${j.name} —${who ? `${who} has` : "they've"} had the quote a while. Follow-up was due ${friendlyDate(j.followUpDate)}.`,
      url: '/leads',
    });
  }
  return out;
}

/**
 * Payday filing (EI) — due 2 working days after each pay day, $250
 * default penalty per missed filing. Same math the Home payroll flags
 * use (lib/payroll.ts), so app and push can never disagree.
 */
function eiFilingRules(payRuns: PayRun[], todayISO: string): BusinessNotification[] {
  const out: BusinessNotification[] = [];
  for (const p of payRuns) {
    if (!p.paid || !p.paidDate || p.eiFiled) continue;
    const due = eiFilingDueDate(p.paidDate);
    if (todayISO === due) {
      out.push({
        ruleKey: 'ei-filing',
        dedupeKey: `${p.id}:due`,
        title: 'File payday info today',
        body: `${p.employeeName}'s pay (${friendlyDate(p.paidDate)}) needs its EI return in myIR by end of day.`,
        url: '/home',
      });
    } else if (todayISO > due) {
      out.push({
        ruleKey: 'ei-filing',
        dedupeKey: `${p.id}:late`,
        title: 'Payday filing overdue',
        body: `EI return for ${p.employeeName}'s ${friendlyDate(p.paidDate)} pay is past due — file it in myIR now ($250 penalty risk).`,
        url: '/home',
      });
    }
  }
  return out;
}

/**
 * PAYE remittance — everything for pay days in month M due the 20th
 * of M+1. payeMonthsDue() already filters to months with unpaid PAYE
 * and self-clears when Brad ticks payePaid.
 */
function payeRules(payRuns: PayRun[], todayISO: string): BusinessNotification[] {
  const out: BusinessNotification[] = [];
  for (const m of payeMonthsDue(payRuns)) {
    const amount = m.payeTotal != null ? `$${m.payeTotal.toFixed(2)}` : 'check myIR for the amount';
    if (todayISO > m.dueDate) {
      out.push({
        ruleKey: 'paye',
        dedupeKey: `${m.monthKey}:late`,
        title: 'PAYE overdue',
        body: `PAYE for ${m.monthKey} was due ${friendlyDate(m.dueDate)} — pay it in myIR now (${amount}).`,
        url: '/home',
      });
    } else if (todayISO === m.dueDate) {
      out.push({
        ruleKey: 'paye',
        dedupeKey: `${m.monthKey}:due`,
        title: 'PAYE due today',
        body: `Pay ${amount} to IRD by end of day.`,
        url: '/home',
      });
    } else if (daysBetween(todayISO, m.dueDate) <= 5) {
      out.push({
        ruleKey: 'paye',
        dedupeKey: `${m.monthKey}:soon`,
        title: `PAYE due ${friendlyDate(m.dueDate)}`,
        body: `${amount} for ${m.monthKey} pays.`,
        url: '/home',
      });
    }
  }
  return out;
}

/**
 * Wage payday — the latest real pay date anchors the next fortnight. This
 * complements the Home payroll row so Brad gets one lock-screen nudge the
 * day before, one on the day, and one escalation if it is missed.
 */
function paydayRules(payRuns: PayRun[], todayISO: string): BusinessNotification[] {
  const latestByEmployee = new Map<string, PayRun>();
  for (const run of payRuns) {
    if (!run.paid || !run.paidDate) continue;
    const key = run.memberId ?? run.employeeName.trim().toLowerCase();
    const current = latestByEmployee.get(key);
    if (!current?.paidDate || run.paidDate > current.paidDate) latestByEmployee.set(key, run);
  }

  const out: BusinessNotification[] = [];
  for (const [employeeKey, run] of latestByEmployee) {
    const due = addDaysISO(run.paidDate!, 14);
    const dayBefore = addDaysISO(due, -1);
    const base = `${employeeKey}:${due}`;
    if (todayISO === dayBefore) {
      out.push({
        ruleKey: 'payday',
        dedupeKey: `${base}:t1`,
        title: `${run.employeeName}'s payday is tomorrow`,
        body: 'TradePilot has the finished fortnight ready to check and pay.',
        url: '/home',
      });
    } else if (todayISO === due) {
      out.push({
        ruleKey: 'payday',
        dedupeKey: `${base}:t0`,
        title: `Pay ${run.employeeName} today`,
        body: 'Check the hours, transfer the net wage, then mark the pay run paid.',
        url: '/home',
      });
    } else if (todayISO > due) {
      out.push({
        ruleKey: 'payday',
        dedupeKey: `${base}:late`,
        title: `${run.employeeName}'s pay is overdue`,
        body: `The fortnightly pay was due ${friendlyDate(due)}. Open TradePilot to finish it.`,
        url: '/home',
      });
    }
  }
  return out;
}

/**
 * GST returns — pure date math, no data needed. Two-monthly cycle
 * ending ODD months (Brad's assumed standard cycle — see AGENTS.md
 * "Brad's tax structure"; fix here if myIR says otherwise). Return +
 * payment due the 28th of the following month, with IRD's two
 * exceptions: period ending 31 Mar → due 7 May, ending 30 Nov → due
 * 15 Jan.
 */
export function gstDueDateForPeriodEnd(periodEndISO: string): string {
  const end = parseISO(periodEndISO);
  const m = end.getMonth() + 1; // 1-12
  const y = end.getFullYear();
  if (m === 3) return `${y}-05-07`;
  if (m === 11) return `${y + 1}-01-15`;
  const dueMonth = m === 12 ? 1 : m + 1;
  const dueYear = m === 12 ? y + 1 : y;
  return `${dueYear}-${String(dueMonth).padStart(2, '0')}-28`;
}

function lastDayOfMonthISO(y: number, m1to12: number): string {
  const d = new Date(y, m1to12, 0); // day 0 of next month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function gstRules(todayISO: string): BusinessNotification[] {
  // Most recent odd-month period end strictly before today.
  const t = parseISO(todayISO);
  let y = t.getFullYear();
  let m = t.getMonth() + 1;
  for (let i = 0; i < 13; i++) {
    if (m % 2 === 1 && lastDayOfMonthISO(y, m) < todayISO) break;
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  const periodEnd = lastDayOfMonthISO(y, m);
  const periodLabel = `${parseISO(lastDayOfMonthISO(y, m === 1 ? 12 : m - 1)).toLocaleDateString('en-NZ', { month: 'short' })}–${parseISO(periodEnd).toLocaleDateString('en-NZ', { month: 'short' })}`;
  const due = gstDueDateForPeriodEnd(periodEnd);

  const out: BusinessNotification[] = [];
  if (todayISO > due && daysBetween(due, todayISO) <= 14) {
    out.push({
      ruleKey: 'gst',
      dedupeKey: `${periodEnd}:late`,
      title: 'GST return overdue',
      body: `The ${periodLabel} GST return was due ${friendlyDate(due)} — file + pay in myIR.`,
      url: '/money',
    });
  } else if (todayISO === due) {
    out.push({
      ruleKey: 'gst',
      dedupeKey: `${periodEnd}:due`,
      title: 'GST due today',
      body: `File + pay the ${periodLabel} GST return in myIR by end of day.`,
      url: '/money',
    });
  } else if (todayISO < due && daysBetween(todayISO, due) <= 7) {
    out.push({
      ruleKey: 'gst',
      dedupeKey: `${periodEnd}:soon`,
      title: `GST due ${friendlyDate(due)}`,
      body: `${periodLabel} return — the Money tab's tax card has the running estimate.`,
      url: '/money',
    });
  }
  return out;
}

/**
 * The morning digest — ONE notification summarising the day. Tagged
 * so yesterday's unread digest is replaced, never stacked. Skipped
 * entirely on a nothing-day (no empty visualisations — golden rule).
 */
function morningDigest(inp: RuleInputs): BusinessNotification[] {
  const lines: string[] = [];

  const todaysWork = inp.scheduleToday
    .filter((s) => !s.completed)
    .sort((a, b) => (a.startTime ?? '99').localeCompare(b.startTime ?? '99'));
  for (const s of todaysWork.slice(0, 3)) {
    const time = s.startTime ? ` ${s.startTime.slice(0, 5)}` : '';
    lines.push(`${s.title}${time}`);
  }
  if (todaysWork.length > 3) lines.push(`+${todaysWork.length - 3} more on the schedule`);

  const owed = inp.jobs.filter(
    (j) => j.status === 'lead' && j.quoteReadyBy && j.quoteReadyBy <= inp.todayISO && !snoozed(j, inp.todayISO),
  ).length;
  if (owed > 0) lines.push(`${owed} quote${owed === 1 ? '' : 's'} owed`);

  const followUps = inp.jobs.filter(
    (j) => j.status === 'quoted' && j.followUpDate && j.followUpDate <= inp.todayISO && !snoozed(j, inp.todayISO),
  ).length;
  if (followUps > 0) lines.push(`${followUps} quote follow-up${followUps === 1 ? '' : 's'} due`);

  const drafts = inp.bills.filter((b) => b.isDraft).length;
  if (drafts > 0) lines.push(`${drafts} bill${drafts === 1 ? '' : 's'} to confirm`);

  const soon = addDaysISO(inp.todayISO, 3);
  const billsDue = inp.bills.filter(
    (b) => !b.isDraft && !b.paid && b.dueDate && b.dueDate <= soon,
  ).length;
  if (billsDue > 0) lines.push(`${billsDue} bill${billsDue === 1 ? '' : 's'} due this week`);

  if (lines.length === 0) return [];
  return [{
    ruleKey: 'morning-digest',
    dedupeKey: inp.todayISO,
    title: `Today — ${friendlyDate(inp.todayISO)}`,
    body: lines.join('\n'),
    url: '/home',
    tag: 'morning-digest',
  }];
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * All candidates for today, most-urgent first. The caller sends them
 * through `sendBusinessNotification`, which drops already-sent keys —
 * and should CAP how many go out in one run (first morning after
 * enabling, a backlog of overdue states all fire at once; six pushes
 * is a wake-up, sixteen is an uninstall).
 */
export function evaluateNotificationRules(inp: RuleInputs): BusinessNotification[] {
  return [
    ...paydayRules(inp.payRuns, inp.todayISO),
    ...eiFilingRules(inp.payRuns, inp.todayISO),
    ...payeRules(inp.payRuns, inp.todayISO),
    ...gstRules(inp.todayISO),
    ...quotePromiseRules(inp.jobs, inp.todayISO),
    ...leadUncontactedRules(inp.jobs, inp.todayISO),
    ...followUpRules(inp.jobs, inp.todayISO),
    ...morningDigest(inp),
  ];
}
