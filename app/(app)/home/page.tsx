'use client';

// "This week" home screen — landing page for the app.
//
// Read-only dashboard answering the two questions Brad opens the app to ask:
//   - 7am: "What am I doing today?" → Today list (with overdue items folded in).
//   - 5:30pm: "How did I track this week?" → Hours / Income / Profit cards.
//
// Plus two scanner-style strips: Money flags (overdue invoices + bills due
// soon) and Coming up (next 7 days of schedule).
//
// All money math is EX-GST. Income comes via `cashIncomeExGstInWindow`,
// expenses via `expensesInWindow` (both in lib/income-allocator.ts).
//
// Every section handles its own empty state — see the golden rule in
// AGENTS.md: "no empty visualisations" on a fresh week.

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/money/stat-card';
import { cashIncomeExGstInWindow, expensesInWindow } from '@/lib/income-allocator';
import { rankJobs } from '@/lib/job-match';
import { JobPicker } from '@/components/shared/job-picker';
import type { ScheduleItem, ScheduleItemType, Invoice, Entry, Job, ActivityType, Material, JobImport, LostReason, DepositNotYetReason } from '@/lib/types';
import { SiteVisitWrapUpSheet, type WrapUpTarget } from '@/components/jobs/site-visit-wrap-up-sheet';
import { QuoteCatchUpSheet } from '@/components/jobs/quote-catch-up-sheet';
import { MarkAsQuotedSheet } from '@/components/jobs/mark-as-quoted-sheet';
import { BillItemsAttacher } from '@/components/bills/bill-items-attacher';
import { BillDetailSheet } from '@/components/bills/bill-detail-sheet';
import { PayrollFlags } from '@/components/payroll/payroll-flags';
import { BookVisitSheet } from '@/components/schedule/book-visit-sheet';
import { InvoiceAction } from '@/components/jobs/invoice-action';
import { EditScheduleItemSheet, type ScheduleEditTarget } from '@/components/schedule/edit-schedule-item-sheet';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';

/**
 * Outcome of a quote being committed via the imports flow. Captured
 * inline on each ImportRow so the future quoting-AI sees won-vs-lost
 * signal directly tied to the parsed quote inputs.
 */
type ImportOutcome = {
  result: 'won' | 'lost' | 'unknown';
  lostReason?: LostReason;
  notes?: string;
};

/**
 * Shape we hand to the store mutator for each material — store stamps
 * id/businessId/createdAt itself, and entryId is filled in by the
 * confirmBillDraftWithMaterials wrapper.
 */
type MaterialInit = Omit<Material, 'id' | 'businessId' | 'createdAt' | 'entryId'>;
import {
  Clock, DollarSign, TrendingUp, AlertCircle, Receipt, ChevronRight, ChevronDown,
  Check, Briefcase, FileText, Bell, FilePlus, ExternalLink, X,
  Phone, Mail, MessageCircle, UserPlus, CalendarPlus, CalendarCheck, Split, Send,
  Paintbrush, History, Settings,
} from 'lucide-react';
import { cn, gmailComposeUrl } from '@/lib/utils';
import { computeQuoteFollowUps, type QuoteFollowUp } from '@/lib/quote-follow-up';

// ── ISO date helpers (local time — UTC drift bites week boundaries) ─────────
function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}
function formatISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(d: Date, n: number): Date {
  const c = new Date(d); c.setDate(c.getDate() + n); return c;
}
/**
 * Monday-start week. Returns ISO YYYY-MM-DD for the Monday of `d`'s week.
 * NZ convention matches the rest of the app (see schedule's week view).
 */
function startOfWeekMonISO(d: Date): string {
  const day = d.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const offsetToMon = day === 0 ? -6 : 1 - day;
  return formatISODate(addDays(d, offsetToMon));
}

// ── Reschedule: find the run a tapped Today row belongs to ─────────────────
// Mirrors the grouping rule in app/(app)/schedule/page.tsx's groupRuns() —
// same-type, same-jobId, same base title, consecutive calendar days — but
// scoped to just the tapped item's bucket instead of grouping the whole
// list. This is what lets tapping ANY day of a multi-day run (e.g. "Clear
// coat two ceilings (Day 2/3)") open the reschedule sheet pre-loaded with
// all three days, matching the Schedule tab's behaviour.
const RESCHEDULE_RUN_TYPES: ScheduleItemType[] = ['job_booking', 'quote_visit', 'reminder'];

function stripDayLabel(title: string): string {
  return title.replace(/\s*\(Day\s+\d+\s*\/\s*\d+\s*\)\s*$/i, '').trim();
}

function isNextCalendarDay(prevISO: string, nextISO: string): boolean {
  const d = parseISODate(prevISO);
  d.setDate(d.getDate() + 1);
  return formatISODate(d) === nextISO;
}

function findScheduleRun(item: ScheduleItem, all: ScheduleItem[]): ScheduleItem[] {
  if (!RESCHEDULE_RUN_TYPES.includes(item.type)) return [item];

  const runKey = (s: ScheduleItem) => `${s.type}::${s.jobId ?? '_'}::${stripDayLabel(s.title)}`;
  const key = runKey(item);
  const bucket = all
    .filter((s) => runKey(s) === key)
    .sort((a, b) => a.date.localeCompare(b.date));

  const idx = bucket.findIndex((s) => s.id === item.id);
  if (idx === -1) return [item];

  let start = idx;
  let end = idx;
  while (start > 0 && isNextCalendarDay(bucket[start - 1].date, bucket[start].date)) start--;
  while (end < bucket.length - 1 && isNextCalendarDay(bucket[end].date, bucket[end + 1].date)) end++;

  return bucket.slice(start, end + 1);
}

// ── Money formatting ────────────────────────────────────────────────────────
function fmtMoney(n: number): string {
  // Round to whole dollars on dashboard tiles — cents are noise at a glance.
  const r = Math.round(n);
  return `$${r.toLocaleString('en-NZ')}`;
}

/**
 * Whether a lead has any site-visit / wrap-up data captured yet. A lead
 * WITH this data is ready to quote (→ "Quotes to prep"); a lead WITHOUT
 * it is a raw enquiry that still needs a first contact (→ "Leads to
 * contact"). Shared by both Home sections so a lead never shows in both.
 * Mirrors the same predicate on the Leads page.
 */
function hasWrapUpData(j: Job): boolean {
  return Boolean(
    j.scopeNotes
    || j.surfaceAreaM2
    || j.prepLevel
    || j.quoteReadyBy
    || (j.accessNotes && j.accessNotes.length > 0),
  );
}

/**
 * Whole days between a created-at timestamp and today. Used for the
 * "waiting N days" chip on uncontacted leads. Clamped at 0 so a lead
 * logged later today never reads as negative.
 */
function daysWaiting(createdAtISO: string, todayISO: string): number {
  const created = new Date(createdAtISO);
  const createdDayISO = formatISODate(created);
  const ms = parseISODate(todayISO).getTime() - parseISODate(createdDayISO).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

// ── Constants ───────────────────────────────────────────────────────────────
const HOURS_TARGET_PER_WEEK = 30; // flat target per Brad's call
const OVERDUE_INVOICE_DAYS = 14;  // unpaid > 14 days = overdue (no dueDate column)
const BILLS_DUE_LOOKAHEAD_DAYS = 7;
const COMING_UP_LOOKAHEAD_DAYS = 7;
const COMING_UP_MAX_ROWS = 6;
const LEADS_TO_CONTACT_MAX_ROWS = 6;

// ── Page ────────────────────────────────────────────────────────────────────
export default function HomePage() {
  const {
    entries, scheduleItems, invoices, jobs, jobImports, quotes, businessId,
    updateScheduleItem, addScheduleItem, updateEntry, markInvoicePaid, addEntry, deleteEntry, updateJob,
    logContact,
    confirmBillDraftWithMaterials, confirmBillDraftAsSplit,
    commitImportAsLink, commitImportAsCreate, commitImportAsSkip,
  } = useStore();

  // Wrap-up sheet state. We hold the schedule_item id (not just a
  // jobId) because a quote_visit can be wrapped up even when it has
  // no linked job — in which case the wrap-up creates one. Computed
  // WrapUpTarget below decides which mode the sheet opens in.
  const [wrapUpScheduleItemId, setWrapUpScheduleItemId] = useState<string | null>(null);

  // "Leads to contact" → Mark contacted flow. Tapping Mark contacted no
  // longer stamps-and-clears immediately; it first asks "site visit
  // arranged?" via a small prompt sheet. Answering Yes opens the shared
  // BookVisitSheet (schedule item + calendar invite); No just stamps
  // lastContactedDate and clears the row (the old behaviour).
  //   visitPromptJob — lead awaiting the Yes/No answer.
  //   bookVisitJob   — lead whose booking form is open (after "Yes").
  //
  // Third branch — "Already visited". Brad does the visit, gets busy, and
  // only opens the app days later; the lead is still sitting in the
  // to-contact list with no visit ever booked. Rather than making him
  // fake a future booking or hand-build a schedule item, this branch
  // catches the app up on what already happened:
  //   catchUpJob    — lead whose backdated wrap-up is open. On save we
  //                   write a COMPLETED quote_visit on the date he gives
  //                   us, so the schedule history reads correctly.
  //   quoteCatchUpJob — same lead, now being asked whether the quote has
  //                   already gone out too. Slack begets slack: if the
  //                   visit never got logged, odds are the quote didn't
  //                   either.
  const [visitPromptJob, setVisitPromptJob] = useState<Job | null>(null);
  const [bookVisitJob, setBookVisitJob] = useState<Job | null>(null);
  const [catchUpJobId, setCatchUpJobId] = useState<string | null>(null);
  const [quoteCatchUpJobId, setQuoteCatchUpJobId] = useState<string | null>(null);
  // "Sent the quote" quick action on a leads-to-contact row. Commercial
  // leads (builders, PMs) often get quoted straight off plans with no
  // site visit — the app previously had no way to say so from Home, so
  // an already-quoted lead kept nagging as "to contact" (the Switchroom
  // pair). Opens the same MarkAsQuotedSheet the Leads page uses. Held
  // as an id so the sheet reads the live job (stale-prop rule).
  const [markQuotedJobId, setMarkQuotedJobId] = useState<string | null>(null);
  // When set, the InvoiceAction sheet opens in create mode for this job —
  // pre-filled as a deposit. Driven by the "Deposits to send" Home flag.
  const [depositForJob, setDepositForJob] = useState<Job | null>(null);

  // Reschedule sheet — opened by tapping any Today row. Stores item ids
  // (not the items themselves) so we re-resolve from the live store on
  // every render, same pattern as the Schedule tab's editingItemIds
  // (dodges the stale-prop trap in AGENTS.md). Holds every id in the
  // tapped item's run so multi-day job bookings reschedule as one block.
  const [reschedulingItemIds, setReschedulingItemIds] = useState<string[] | null>(null);
  const reschedulingTarget: ScheduleEditTarget | null = useMemo(() => {
    if (!reschedulingItemIds || reschedulingItemIds.length === 0) return null;
    const items = reschedulingItemIds
      .map((id) => scheduleItems.find((s) => s.id === id))
      .filter((s): s is ScheduleItem => !!s);
    return items.length > 0 ? { items } : null;
  }, [reschedulingItemIds, scheduleItems]);
  const wrapUpItem = wrapUpScheduleItemId
    ? scheduleItems.find((s) => s.id === wrapUpScheduleItemId) ?? null
    : null;
  // Memoised so the WrapUpTarget object identity is stable across
  // unrelated re-renders. Without this, every store update on the
  // parent (which is chatty) would create a brand-new target object,
  // tripping the wrap-up sheet's hydration effect and resetting any
  // staged photos/plans the user had queued. Bit me in production.
  const wrapUpTarget = useMemo<WrapUpTarget | null>(() => {
    if (!wrapUpItem) return null;
    if (wrapUpItem.jobId) {
      const linkedJob = jobs.find((j) => j.id === wrapUpItem.jobId);
      // Linked job missing — shouldn't happen but fall through to
      // create-from-visit rather than render a broken sheet.
      if (linkedJob) return { mode: 'existing-job', job: linkedJob };
    }
    return {
      mode: 'create-from-visit',
      visitTitle: wrapUpItem.title,
      visitNotes: wrapUpItem.notes,
    };
  }, [wrapUpItem, jobs]);

  // Catch-up flow targets. Held as ids, not Job objects, so they
  // re-resolve from the live store every render — the same stale-prop
  // rule the reschedule sheet follows. Memoised for the wrap-up sheet's
  // sake: it resets staged photos whenever its target's identity
  // changes, and this page re-renders on every store tick.
  const catchUpJob = catchUpJobId ? jobs.find((j) => j.id === catchUpJobId) ?? null : null;
  const catchUpTarget = useMemo<WrapUpTarget | null>(
    () => (catchUpJob ? { mode: 'existing-job', job: catchUpJob } : null),
    [catchUpJob],
  );
  const quoteCatchUpJob = quoteCatchUpJobId
    ? jobs.find((j) => j.id === quoteCatchUpJobId) ?? null
    : null;
  const markQuotedJob = markQuotedJobId
    ? jobs.find((j) => j.id === markQuotedJobId) ?? null
    : null;

  // Compute "today" once per render and pin the ISO strings in stable values
  // so the memo dependency arrays compare by value, not by Date identity.
  // The page re-renders every time the store changes (which is fine), but we
  // don't want every render to re-run every filter because `today` is a new
  // object reference.
  const todayISO = useMemo(() => formatISODate(new Date()), []);
  const weekStartISO = useMemo(() => startOfWeekMonISO(parseISODate(todayISO)), [todayISO]);
  const weekEndISO = todayISO; // "this week so far" — through today, not the future

  // ── Today + overdue ─────────────────────────────────────────────────────
  // Today's items, plus any uncompleted items earlier in this week (so they
  // don't disappear if Brad forgot to tick them). Items from before this week
  // aren't surfaced here — they'd belong to a separate "Loose ends" section
  // we haven't built yet.
  const todayItems = useMemo(() => {
    return scheduleItems
      .filter((s) => {
        if (s.completed) return false;
        if (s.date === todayISO) return true;
        if (s.date < todayISO && s.date >= weekStartISO) return true;
        return false;
      })
      .sort((a, b) => {
        // Today first, then by start time; older overdue items at the top.
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.startTime ?? '99:99').localeCompare(b.startTime ?? '99:99');
      });
  }, [scheduleItems, todayISO, weekStartISO]);

  // ── This week so far ────────────────────────────────────────────────────
  const hoursThisWeek = useMemo(() => {
    let h = 0;
    for (const e of entries) {
      if (e.type !== 'hours') continue;
      if (e.entryDate < weekStartISO || e.entryDate > weekEndISO) continue;
      h += e.hours ?? 0;
    }
    return h;
  }, [entries, weekStartISO, weekEndISO]);

  const incomeExGst = useMemo(
    () => cashIncomeExGstInWindow(entries, weekStartISO, weekEndISO),
    [entries, weekStartISO, weekEndISO],
  );
  const expensesExGst = useMemo(
    () => expensesInWindow(entries, weekStartISO, weekEndISO),
    [entries, weekStartISO, weekEndISO],
  );
  const profitExGst = incomeExGst - expensesExGst;

  // Fresh-week guard: when all three of the weekly KPIs are zero, render a
  // single muted line instead of three $0 cards (golden rule: no empty
  // visualisations).
  const freshWeek = hoursThisWeek === 0 && incomeExGst === 0 && expensesExGst === 0;

  // ── Money flags ─────────────────────────────────────────────────────────
  // Overdue invoices (unpaid, invoiced > N days ago — no dueDate column).
  //
  // Extra guard for `final` invoices: only treat as overdue if the parent job
  // is in 'invoiced' or 'paid' status. Reason — the backfill in migration
  // 001_invoices.sql created a "final" stub row for every job with a non-null
  // invoice_amount, including jobs that hadn't been completed yet. Those
  // stubs sit unpaid against booked/in-progress jobs and would otherwise be
  // flagged here forever (until the job actually finishes), even though the
  // final invoice hasn't been sent. Deposits/progress invoices keep the
  // simpler rule because they can legitimately be issued at any job stage.
  const overdueInvoices = useMemo(() => {
    const cutoffISO = formatISODate(addDays(parseISODate(todayISO), -OVERDUE_INVOICE_DAYS));
    return invoices.filter((i) => {
      if (i.paid) return false;
      if (i.invoiceDate > cutoffISO) return false;
      if (i.kind === 'final') {
        const job = jobs.find((j) => j.id === i.jobId);
        if (!job) return false;
        if (job.status !== 'invoiced' && job.status !== 'paid') return false;
      }
      return true;
    });
  }, [invoices, jobs, todayISO]);

  // Bills coming due in the next 7 days, unpaid only.
  // Drafts (unconfirmed parsed bills) are surfaced separately in the
  // "Bills to confirm" flag — excluding them here avoids the same row
  // appearing twice on Home.
  const billsDueSoon = useMemo(() => {
    const horizonISO = formatISODate(addDays(parseISODate(todayISO), BILLS_DUE_LOOKAHEAD_DAYS));
    return entries.filter((e) =>
      e.type === 'bill'
      && !e.isDraft
      && !e.paid
      && e.dueDate != null
      && e.dueDate >= todayISO
      && e.dueDate <= horizonISO,
    );
  }, [entries, todayISO]);

  // Draft bills awaiting Brad's review — populated by the PDF upload flow on
  // /entry. Surfaced as the first flag on Home so they're the most obvious
  // pending action.
  const billDrafts = useMemo(() => {
    return entries
      .filter((e) => e.type === 'bill' && e.isDraft)
      // Newest first — the freshly-uploaded bill is the one Brad most wants
      // to act on right now.
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [entries]);

  // Accepted jobs that still have no deposit invoice — the quote's been won
  // but the deposit that secures the booking hasn't gone out. Issuing any
  // invoice flips a job to 'invoiced', so scoping to 'accepted' makes this
  // list self-clearing the moment the deposit is sent (or the job moves on).
  // Oldest-accepted first: the one most likely to have been forgotten floats
  // to the top.
  // "Not yet" (migration 045) quiets a row without issuing anything:
  // 'no_deposit' means no deposit is coming at all (hidden until the
  // reason is cleared from the job sheet); any other reason pairs with
  // depositSnoozeUntil and the row flows back when the date passes.
  const depositsToSend = useMemo(() => {
    return jobs
      .filter((j) =>
        j.status === 'accepted'
        && !invoices.some((i) => i.jobId === j.id && i.kind === 'deposit')
        && j.depositNotYetReason !== 'no_deposit'
        && !(j.depositSnoozeUntil && j.depositSnoozeUntil > todayISO),
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }, [jobs, invoices, todayISO]);

  // Quoted jobs gone quiet — the follow-up ladder (7d nudge → 3wk
  // "either way" message → a week later, prompt to mark lost). All the
  // rules live in lib/quote-follow-up.ts, shared with the Leads tab.
  const quoteFollowUps = useMemo(
    () => computeQuoteFollowUps(jobs, quotes, todayISO),
    [jobs, quotes, todayISO],
  );

  const showMoneyFlags = overdueInvoices.length > 0
    || billsDueSoon.length > 0
    || billDrafts.length > 0
    || depositsToSend.length > 0
    || quoteFollowUps.length > 0
    || jobImports.length > 0;

  // ── Coming up (next 7 days, not including today) ───────────────────────
  const comingUp = useMemo(() => {
    const horizonISO = formatISODate(addDays(parseISODate(todayISO), COMING_UP_LOOKAHEAD_DAYS));
    return scheduleItems
      .filter((s) => !s.completed && s.date > todayISO && s.date <= horizonISO)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.startTime ?? '99:99').localeCompare(b.startTime ?? '99:99');
      });
  }, [scheduleItems, todayISO]);

  // Jobs that need a quote written. Mirrors the rule used by the
  // Leads page's "To quote" section: status=lead AND has wrap-up
  // data (scopeNotes, paint area, prep level, quoteReadyBy, or
  // access notes). Sorted by quoteReadyBy ascending so the most
  // urgent promise to the customer shows up first.
  const toQuoteJobs = useMemo(() => {
    return jobs
      .filter((j) => j.status === 'lead' && hasWrapUpData(j))
      .sort((a, b) => {
        const aDue = a.quoteReadyBy ?? '';
        const bDue = b.quoteReadyBy ?? '';
        if (aDue && bDue) return aDue.localeCompare(bDue);
        if (aDue) return -1;
        if (bDue) return 1;
        return 0;
      });
  }, [jobs]);

  // Job ids with an upcoming quote_visit on the calendar (not completed,
  // not skipped, today or later). A lead with a visit booked has plainly
  // been contacted already — the next action is turning up on the day,
  // not another reply — so these are excluded from "Leads to contact".
  // Mirrors the Leads page's nextVisitByJob carve-out ("Visit booked"
  // section) so Home and Leads never disagree about who still needs a
  // reply. This was the 20 Waimana bug: visit booked for Monday, Home
  // still nagging "Mark contacted".
  const visitBookedJobIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of scheduleItems) {
      if (s.type !== 'quote_visit' || !s.jobId) continue;
      if (s.completed || s.skipReasonKind) continue;
      if (s.date < todayISO) continue;
      set.add(s.jobId);
    }
    return set;
  }, [scheduleItems, todayISO]);

  // Raw enquiries that still need a first contact: status=lead, no
  // site-visit data yet (those go to "Quotes to prep"), no upcoming
  // visit on the calendar (those are handled — see visitBookedJobIds),
  // not snoozed on the Leads page, and never marked contacted. Once Brad
  // taps "Mark contacted" on a row, lastContactedDate is stamped and the
  // row drops out of this list — so the section doubles as a "leads I
  // still owe a reply" inbox that empties as he works through it.
  //
  // Sorted oldest-waiting first: the enquiry sitting longest without a
  // reply is the most at risk of going cold, so it belongs at the top.
  const leadsToContact = useMemo(() => {
    return jobs
      .filter((j) =>
        j.status === 'lead'
        && !hasWrapUpData(j)
        && !j.lastContactedDate
        && !visitBookedJobIds.has(j.id)
        // Snoozed on the Leads page = deliberately parked; Home must
        // respect that or the snooze button looks broken.
        && !(j.snoozeUntil && j.snoozeUntil > todayISO),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [jobs, visitBookedJobIds, todayISO]);

  // ── Render ──────────────────────────────────────────────────────────────
  const subtitle = parseISODate(todayISO).toLocaleDateString('en-NZ', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="This week"
        subtitle={subtitle}
        // Settings has no home on the phone — the bottom nav is full at
        // seven tabs and the sidebar link is desktop-only, which left
        // /settings (notifications toggle, Team, GST, quote template)
        // unreachable on mobile. A gear on the Home header is the
        // standard phone pattern; hidden on md+ where the sidebar link
        // already covers it. 44px tap target per the golden rule.
        action={
          <Link
            href="/settings"
            aria-label="Settings"
            className="md:hidden flex items-center justify-center w-11 h-11 -mr-2 rounded-xl text-muted-foreground hover:bg-muted active:bg-muted transition-colors"
          >
            <Settings size={20} strokeWidth={1.8} />
          </Link>
        }
      />

      <div className="px-4 md:px-6 pb-6 space-y-4 w-full max-w-2xl mx-auto">
        {/* Quick add lives at the top: opening the app at 7am or 5:30pm,
            the first thing Brad does is log something. Dashboard sections
            below answer "how am I tracking" — important but never the
            reason for opening the app. */}
        <QuickAddSection />

        <TodaySection
          items={todayItems}
          todayISO={todayISO}
          onMarkDone={(id) => updateScheduleItem(id, { completed: true })}
          onReschedule={(item) => {
            // Tap any day of a run and the whole run comes along — matches
            // the Schedule tab so rescheduling one overdue day of a 3-day
            // job doesn't leave the other two days orphaned with a stale
            // "(Day 2/3)" label.
            setReschedulingItemIds(findScheduleRun(item, scheduleItems).map((s) => s.id));
          }}
          onOpenWrapUp={(item) => {
            // Ticking a quote_visit opens the wrap-up regardless of
            // whether it has a linked job — the sheet will create one
            // on save if needed. We DON'T complete the schedule item
            // yet — the wrap-up's onSaved callback does that, so a
            // cancelled wrap-up leaves the row in Today (still owed
            // a write-up).
            setWrapUpScheduleItemId(item.id);
          }}
          onLogHours={(item, fields) => {
            // Build a hours-type Entry attached to the schedule item's job.
            // Mirrors the shape used in app/(app)/entry/page.tsx — hours
            // entries don't have GST (gstApplies=false) and the description
            // falls back to the schedule item's title so a bare "" doesn't
            // turn into a useless row in the entries list later.
            addEntry({
              id: `ent_${Date.now()}`,
              businessId: businessId ?? '',
              jobId: item.jobId,
              type: 'hours',
              hours: fields.hours,
              activity: fields.activity,
              // Brad's own login ticking his own row — same 'owner'
              // default as the full EntryForm. Without this, Home-logged
              // hours landed with workerKind undefined: a third unlabelled
              // bucket in every by-worker rollup, and job costing couldn't
              // rate them. (Suzie's hours come via /my/hours, not here.)
              workerKind: 'owner',
              description: fields.description.trim() || item.title,
              // Ticking an overdue row usually means the work happened on
              // the day the row was scheduled — put the hours on THAT day
              // so the hours-by-day allocation is right. Future-dated rows
              // (ticked early) still log as today: work can't happen on a
              // date that hasn't arrived. String compare is safe on
              // YYYY-MM-DD.
              entryDate: item.date && item.date < todayISO ? item.date : todayISO,
              gstApplies: false,
              createdAt: new Date().toISOString(),
            });
          }}
        />

        {/* Leads to contact — raw enquiries Brad hasn't replied to yet.
            One-tap "Mark contacted" stamps lastContactedDate and the
            row disappears, so the list empties as he works through it.
            Hides when empty per the "no empty visualisations" rule. */}
        {leadsToContact.length > 0 && (
          <LeadsToContactSection
            items={leadsToContact}
            todayISO={todayISO}
            // Fired by the Email shortcut in this section, so the channel is
            // known rather than guessed.
            onMarkContacted={(jobId) =>
              logContact({ jobId, direction: 'out', channel: 'email' })
            }
            onArrangeVisit={(job) => setVisitPromptJob(job)}
            onSentQuote={(job) => setMarkQuotedJobId(job.id)}
          />
        )}

        {/* Quotes-to-prep — surfaces jobs where the site visit's
            done but the quote hasn't been sent yet. Hides when
            empty per the "no empty visualisations" rule. */}
        {toQuoteJobs.length > 0 && (
          <QuotesToPrepSection items={toQuoteJobs} />
        )}

        <WeekStatsSection
          hours={hoursThisWeek}
          income={incomeExGst}
          expenses={expensesExGst}
          profit={profitExGst}
          fresh={freshWeek}
        />

        {/* Payroll — pay Suzie + the IRD follow-ups. Self-contained:
            reads the store itself and renders nothing when no employees
            exist or nothing is due. */}
        <PayrollFlags />

        {showMoneyFlags && (
          <MoneyFlagsCard
            overdueInvoices={overdueInvoices}
            billsDueSoon={billsDueSoon}
            billDrafts={billDrafts}
            depositsToSend={depositsToSend}
            quoteFollowUps={quoteFollowUps}
            jobImports={jobImports}
            jobs={jobs}
            todayISO={todayISO}
            onIssueDeposit={(job) => setDepositForJob(job)}
            // "Not yet" on a deposit card. 'no_deposit' is a decision (no
            // wake date — the row is gone until the reason is cleared);
            // "will sort in person" gets a week (you'll see them soon);
            // the other delays get a fortnight.
            onDepositNotYet={(job, reason) =>
              updateJob(job.id, {
                depositNotYetReason: reason,
                depositSnoozeUntil: reason === 'no_deposit'
                  ? ''
                  : formatISODate(addDays(parseISODate(todayISO), reason === 'in_person' ? 7 : 14)),
              })
            }
            // "Followed up" on a quote flag — Brad chased, but this button
            // doesn't know how, so 'other' rather than a guess.
            onFollowedUp={(jobId) =>
              logContact({ jobId, direction: 'out', channel: 'other' })
            }
            onMarkLost={(jobId) =>
              updateJob(jobId, { status: 'lost', lostReason: 'no-reply' })
            }
            // "Give it a week" on a follow-up card. snoozeUntil hides the
            // job from the ladder (lib/quote-follow-up.ts), the Leads
            // lists AND the push notifications until the date passes,
            // then everything resumes by itself — one field, all
            // surfaces agree.
            onSnoozeFollowUp={(jobId, untilISO) =>
              updateJob(jobId, { snoozeUntil: untilISO })
            }
            onMarkInvoicePaid={(id, paidDate) => markInvoicePaid(id, paidDate)}
            onMarkBillPaid={(id, paidDate) => updateEntry(id, { paid: true, paidDate })}
            onConfirmDraft={(id, { jobId, materials }) =>
              void confirmBillDraftWithMaterials(id, { jobId, materials })
            }
            onConfirmDraftSplit={(id, slices, materials) =>
              void confirmBillDraftAsSplit(id, slices, materials)
            }
            onDeleteDraft={(id) => deleteEntry(id)}
            onCommitImportAsLink={(id, jobId, outcome) => void commitImportAsLink(id, jobId, outcome)}
            onCommitImportAsCreate={(id) => void commitImportAsCreate(id)}
            onCommitImportAsSkip={(id) => void commitImportAsSkip(id)}
          />
        )}

        {comingUp.length > 0 && (
          <ComingUpSection items={comingUp} todayISO={todayISO} />
        )}
      </div>

      {/* Site-visit wrap-up — appears when Brad ticks a quote_visit
          with a linked job. Captures photos + scope + structured fields
          and patches the job. On save, completes the schedule_item so
          the row leaves the Today list. On cancel, the row stays so
          Brad knows he still owes a write-up. */}
      <SiteVisitWrapUpSheet
        open={wrapUpTarget !== null}
        target={wrapUpTarget}
        onSaved={(resolvedJobId) => {
          if (wrapUpItem) {
            // Complete the schedule item AND link it to the resolved job.
            // If the wrap-up created a new job, this is the moment the
            // schedule_item gets its jobId. Existing-job wrap-ups patch
            // the same id back, which is a harmless no-op.
            updateScheduleItem(wrapUpItem.id, {
              completed: true,
              jobId: resolvedJobId,
            });
          }
          setWrapUpScheduleItemId(null);
        }}
        onCancel={() => setWrapUpScheduleItemId(null)}
      />

      {/* "Site visit arranged?" prompt — the branch after Mark contacted.
          Yes opens the booking form; No just stamps lastContactedDate
          (the old one-tap behaviour) and clears the row. */}
      <SiteVisitPromptSheet
        job={visitPromptJob}
        onYes={(job) => {
          setVisitPromptJob(null);
          setBookVisitJob(job);
        }}
        onNo={(job) => {
          // Contact happened, no visit came of it. Channel unknown at this
          // point in the flow — the prompt is reached from several routes.
          logContact({ jobId: job.id, direction: 'out', channel: 'other' });
          setVisitPromptJob(null);
        }}
        onAlreadyVisited={(job) => {
          setVisitPromptJob(null);
          setCatchUpJobId(job.id);
        }}
        onCancel={() => setVisitPromptJob(null)}
      />

      {/* "Already visited" branch — the backdated wrap-up. Same sheet as
          the normal post-visit wrap-up, with the visit date asked for
          (there's no schedule_item to read it off). On save we write the
          completed quote_visit ourselves, then hand off to the quote
          catch-up question. */}
      <SiteVisitWrapUpSheet
        open={catchUpTarget !== null}
        target={catchUpTarget}
        askVisitDate
        title="Catch up — site visit"
        onSaved={(resolvedJobId, { visitDate }) => {
          const job = jobs.find((j) => j.id === resolvedJobId);
          if (visitDate) {
            // Backfill the visit as already-completed history. No .ics —
            // a calendar reminder for something that already happened is
            // just noise. Real uuid because schedule_items.id is a uuid
            // column (see BookVisitSheet for the 22P02 story).
            addScheduleItem({
              id: crypto.randomUUID(),
              businessId: businessId ?? '',
              jobId: resolvedJobId,
              type: 'quote_visit',
              title: `Site visit — ${job?.name ?? 'lead'}`,
              date: visitDate,
              startTime: '09:00',
              notes: 'Logged after the fact.',
              completed: true,
              icsDownloaded: false,
              createdAt: new Date().toISOString(),
            });
          }
          setCatchUpJobId(null);
          // Straight into "…and did you quote it?" — the wrap-up only
          // captured scope, and a lead that's been visited but not
          // quoted needs a different nudge than one that's been quoted
          // and ignored.
          setQuoteCatchUpJobId(resolvedJobId);
        }}
        onCancel={() => setCatchUpJobId(null)}
      />

      {/* Step 2 of the catch-up: has the quote already gone out? Yes
          moves the job to 'quoted' with the amount + send date, which
          hands it to the quote follow-up surface. No leaves it as a
          lead with the quoteReadyBy promise the wrap-up just set. */}
      <QuoteCatchUpSheet
        job={quoteCatchUpJob}
        onQuoted={(job, { amount, sentDate }) => {
          updateJob(job.id, {
            status: 'quoted',
            // Only overwrite the stored amount when we actually got one —
            // a blank field shouldn't wipe a figure already on the job.
            ...(amount != null ? { quoteAmount: amount } : {}),
            // Promise kept — stop counting it as a quote owed.
            quoteReadyBy: undefined,
          });
          // Contact is dated from when the customer heard from Brad, not from
          // now — otherwise a quote sent last week looks fresh and the
          // follow-up nudge is a week late. This is the one backdating caller;
          // logContact won't drag the cache backwards if a more recent contact
          // already exists.
          logContact({
            jobId: job.id,
            direction: 'out',
            channel: 'quote-sent',
            contactedAt: new Date(`${sentDate}T12:00:00`).toISOString(),
            note: 'Logged retrospectively via quote catch-up.',
          });
          setQuoteCatchUpJobId(null);
        }}
        onNotQuoted={(job) => {
          // Still a lead, but Brad has now actively touched it — log contact
          // so it drops out of the to-contact list. quoteReadyBy (set in the
          // wrap-up) keeps it visible as a quote owed.
          logContact({ jobId: job.id, direction: 'out', channel: 'other' });
          setQuoteCatchUpJobId(null);
        }}
        onCancel={() => setQuoteCatchUpJobId(null)}
      />

      {/* "Sent the quote" quick action from a leads-to-contact row —
          same sheet the Leads page's To-quote section uses. Saving flips
          the job to 'quoted' + logs the quote-sent contact, so the row
          clears from Leads to contact and the follow-up ladder takes
          over the chasing. */}
      <MarkAsQuotedSheet
        open={markQuotedJob !== null}
        job={markQuotedJob}
        onSaved={() => setMarkQuotedJobId(null)}
        onCancel={() => setMarkQuotedJobId(null)}
      />

      {/* Shared booking sheet — adds a quote_visit schedule item, bumps
          lastContactedDate, and downloads the .ics calendar invite. Same
          component the Leads page uses. */}
      <BookVisitSheet
        job={bookVisitJob}
        open={bookVisitJob !== null}
        onSaved={() => setBookVisitJob(null)}
        onCancel={() => setBookVisitJob(null)}
      />

      {/* Deposit invoice sheet — opened from the "Deposits to send" flag.
          Create mode pre-fills a deposit from the job's quote + template;
          InvoiceAction calls onClose after a successful save, at which point
          the job is 'invoiced' and the flag clears itself. */}
      {depositForJob && (
        <InvoiceAction
          job={depositForJob}
          open
          onClose={() => setDepositForJob(null)}
        />
      )}

      {/* Reschedule sheet — opened by tapping any Today row (including
          overdue ones). Same component the Schedule tab uses, so a
          multi-day job booking, a quote visit, or a bare reminder all get
          the right edit UI (date range + working-days pattern where it
          makes sense, single date otherwise). */}
      <EditScheduleItemSheet
        open={reschedulingTarget !== null}
        onOpenChange={(open) => { if (!open) setReschedulingItemIds(null); }}
        target={reschedulingTarget}
        jobs={jobs}
      />
    </div>
  );
}

// ── Section: Site-visit prompt ───────────────────────────────────────────────
//
// The branch Brad asked for: after tapping "Mark contacted" on a lead,
// ask whether a site visit was arranged before clearing the row. Yes →
// book it (schedule + calendar). No → just mark contacted. A compact
// bottom sheet with two big tap targets — the 5:30pm-on-a-phone rule.
function SiteVisitPromptSheet({
  job, onYes, onNo, onAlreadyVisited, onCancel,
}: {
  job: Job | null;
  onYes: (job: Job) => void;
  onNo: (job: Job) => void;
  /** Third branch: the visit already happened, the app just doesn't know. */
  onAlreadyVisited: (job: Job) => void;
  onCancel: () => void;
}) {
  return (
    <Sheet open={job !== null} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>Site visit arranged?</SheetTitle>
        </SheetHeader>
        {job && (
          <div className="mt-4 space-y-4 pb-4">
            <div className="rounded-xl bg-muted/40 border border-border px-3 py-2.5">
              <p className="text-sm font-medium text-foreground">{job.name}</p>
              {job.clientName && (
                <p className="text-xs text-muted-foreground">{job.clientName}</p>
              )}
            </div>

            <p className="text-sm text-muted-foreground leading-snug">
              Did you book a site visit with this lead? You can add it to your
              schedule and download a calendar reminder.
            </p>

            <div className="space-y-2">
              <Button
                className="w-full h-12 bg-primary text-base"
                onClick={() => onYes(job)}
              >
                <CalendarPlus size={18} className="mr-2" strokeWidth={2} />
                Yes — book the visit
              </Button>
              <Button
                variant="outline"
                className="w-full h-12 text-base"
                onClick={() => onNo(job)}
              >
                <CalendarCheck size={18} className="mr-2" strokeWidth={2} />
                No — just mark contacted
              </Button>
              {/* Tertiary on purpose: the common case is a visit being
                  arranged now, and this branch opens a much longer form.
                  Ghost styling keeps it available without competing with
                  the two one-tap answers above. */}
              <Button
                variant="ghost"
                className="w-full h-11 text-sm text-muted-foreground"
                onClick={() => onAlreadyVisited(job)}
              >
                <History size={16} className="mr-2" strokeWidth={2} />
                Already visited — catch the app up
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Section: Today ──────────────────────────────────────────────────────────
// Fields collected by the inline hours form that appears after a job_booking
// is ticked. Description is optional — the section's handler falls back to
// the schedule item's title if it's empty.
export interface LoggedHoursFields {
  hours: number;
  activity: ActivityType;
  description: string;
}

function TodaySection({
  items, todayISO, onMarkDone, onLogHours, onOpenWrapUp, onReschedule,
}: {
  items: ScheduleItem[];
  todayISO: string;
  onMarkDone: (id: string) => void;
  onLogHours: (item: ScheduleItem, fields: LoggedHoursFields) => void;
  /** Tick handler for quote_visit rows with a linked job — opens the wrap-up. */
  onOpenWrapUp: (item: ScheduleItem) => void;
  /** Tapping the row body — opens the reschedule sheet for the item's run. */
  onReschedule: (item: ScheduleItem) => void;
}) {
  return (
    <section>
      <SectionLabel>Today</SectionLabel>
      {items.length === 0 ? (
        <div className="bg-card border border-border rounded-2xl px-4 py-5 text-sm text-muted-foreground flex items-center justify-between gap-3">
          <span>Nothing on today — enjoy it.</span>
          <Link
            href="/schedule"
            className="text-xs font-medium text-primary hover:underline shrink-0"
          >
            Add to schedule
          </Link>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((s) => (
            <TodayRow
              key={s.id}
              item={s}
              todayISO={todayISO}
              onMarkDone={onMarkDone}
              onLogHours={onLogHours}
              onOpenWrapUp={onOpenWrapUp}
              onReschedule={onReschedule}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const SCHEDULE_TYPE_META: Record<string, { color: string; bg: string; icon: React.ElementType; label: string }> = {
  // `label` is the short human-readable name surfaced as a chip on Home
  // rows. The icon alone isn't enough on a phone — "what kind of thing
  // is this?" should be readable at a glance without squinting. Keep
  // each label ≤14 chars so a chip never wraps on narrow viewports.
  job_booking: { color: 'text-orange-600', bg: 'bg-orange-50', icon: Briefcase,   label: 'Job day' },
  quote_visit: { color: 'text-blue-600',   bg: 'bg-blue-50',   icon: FileText,    label: 'Site visit' },
  follow_up:   { color: 'text-violet-600', bg: 'bg-violet-50', icon: Bell,        label: 'Follow-up' },
  bill_due:    { color: 'text-red-600',    bg: 'bg-red-50',    icon: AlertCircle, label: 'Bill due' },
  invoice_due: { color: 'text-amber-600',  bg: 'bg-amber-50',  icon: Receipt,     label: 'Invoice due' },
  reminder:    { color: 'text-slate-600',  bg: 'bg-slate-50',  icon: Bell,        label: 'Reminder' },
};

function TodayRow({
  item, todayISO, onMarkDone, onLogHours, onOpenWrapUp, onReschedule,
}: {
  item: ScheduleItem;
  todayISO: string;
  onMarkDone: (id: string) => void;
  onLogHours: (item: ScheduleItem, fields: LoggedHoursFields) => void;
  /** Tick handler for quote_visit rows. Falls back to onMarkDone if not provided. */
  onOpenWrapUp?: (item: ScheduleItem) => void;
  /** Tapping the row body — opens the reschedule sheet. */
  onReschedule: (item: ScheduleItem) => void;
}) {
  const meta = SCHEDULE_TYPE_META[item.type] ?? SCHEDULE_TYPE_META.reminder;
  const Icon = meta.icon;
  const overdue = item.date < todayISO;

  // Has the scheduled time of a site visit already gone by? A visit on a
  // past date is always "passed"; a visit today is passed once the clock
  // is at/after its start time (or immediately, if no time was set). Drives
  // whether we show the prominent "Wrap up" button — you can only write up
  // a visit that's actually happened. Compared as zero-padded "HH:MM".
  const nowHHMM = new Date().toTimeString().slice(0, 5);
  const visitTimePassed =
    overdue
    || (item.date === todayISO
      && (!item.startTime || item.startTime.slice(0, 5) <= nowHHMM));

  // When the user ticks a row that has a linked job, we keep the row mounted
  // and reveal an inline hours form. We deliberately DO NOT call onMarkDone
  // yet — the schedule item stays `completed=false` in the store until the
  // form is dismissed (Save or Cancel). This avoids the row disappearing
  // out from under the form (the parent's Today filter excludes completed
  // items). On dismiss, the form unmounts the row by flipping completed.
  const [formOpen, setFormOpen] = useState(false);

  // Tick semantics fork by type:
  //
  //   quote_visit + linked job → opens the site-visit wrap-up sheet
  //     (parent handles state + completes the item on save).
  //   any other type + linked job → opens the inline hours form to
  //     log work done against the job (existing behaviour for
  //     job_booking, follow_up).
  //   no linked job (reminder / bill_due / invoice_due) → one-tap mark
  //     done, no extra UI.
  //
  // The wrap-up fork only triggers when the parent provided
  // onOpenWrapUp — falling back to the hours form preserves the old
  // behaviour for any future caller that hasn't wired it up yet.
  // Any quote_visit can be wrapped up — the wrap-up sheet creates a job
  // from the visit when none is linked yet, so we no longer require a
  // jobId here (it used to, which meant un-linked visits silently fell
  // back to a bare "mark done" with no way to capture details).
  const isWrapUpVisit =
    item.type === 'quote_visit' && onOpenWrapUp != null;
  const tickOpensHoursForm = !isWrapUpVisit && item.jobId != null;

  // Once a visit's time has passed, surface an explicit "Wrap up" button
  // in place of the bare tick — the tick read as "mark done" and hid the
  // fact that this is where you add the visit details from Home.
  const showWrapUpButton = isWrapUpVisit && visitTimePassed;

  function handleTickClick() {
    if (isWrapUpVisit) {
      onOpenWrapUp!(item);
    } else if (tickOpensHoursForm) {
      setFormOpen(true);
    } else {
      onMarkDone(item.id);
    }
  }

  function handleFormSave(fields: LoggedHoursFields) {
    onLogHours(item, fields);
    onMarkDone(item.id);
    // No need to flip formOpen — the row is about to unmount as the parent
    // filter excludes completed items.
  }

  function handleFormCancel() {
    // Treat cancel as "yes I'm done, no I'm not logging hours right now".
    // Schedule item still gets marked complete (the user clicked tick) so
    // they don't have to tick again later just to clear it from Today.
    onMarkDone(item.id);
  }

  return (
    <li className="bg-card border border-border rounded-2xl flex flex-col overflow-hidden">
      <div className="flex items-stretch min-h-[56px]">
        <button
          type="button"
          onClick={() => onReschedule(item)}
          disabled={formOpen}
          aria-label={`Reschedule "${item.title}"`}
          className={cn(
            'flex items-center gap-3 flex-1 px-4 py-3 min-w-0 text-left transition-colors',
            formOpen ? 'cursor-default' : 'hover:bg-accent/60 active:bg-accent',
          )}
        >
          <div className={cn('w-8 h-8 rounded-xl flex items-center justify-center shrink-0', meta.bg)}>
            <Icon size={16} className={meta.color} strokeWidth={1.8} />
          </div>
          <div className="flex-1 min-w-0">
            <p className={cn(
              'text-sm font-medium text-foreground truncate',
              formOpen && 'line-through text-muted-foreground',
            )}>
              {item.title}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
              {/* Date chip — leads the meta row so "when?" lands first.
                  Chip colour still encodes the item type (job/quote/etc.)
                  so the visual grammar from before is preserved. */}
              <span className={cn(
                'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide',
                meta.bg, meta.color,
              )}>
                {chipDateLabel(item.date, todayISO)}
              </span>
              {overdue && <span className="text-red-600 font-medium">Overdue</span>}
              {item.startTime && <span className="truncate">{item.startTime}{item.endTime ? `–${item.endTime}` : ''}</span>}
            </p>
          </div>
          {!formOpen && (
            <ChevronRight size={16} className="text-muted-foreground shrink-0" strokeWidth={1.8} />
          )}
        </button>
        {showWrapUpButton ? (
          // Site visit whose time has passed → explicit "Wrap up" CTA so
          // adding the details is reachable straight from Home (no need to
          // detour through the Schedule tab). Opens the same wrap-up sheet
          // the tick used to open, just with an obvious label.
          <button
            type="button"
            onClick={() => onOpenWrapUp!(item)}
            aria-label={`Wrap up "${item.title}" — add visit details`}
            className="flex items-center justify-center gap-1.5 px-4 border-l border-border text-xs font-semibold text-primary bg-primary/10 hover:bg-primary/15 active:bg-primary/20 transition-colors"
          >
            <FilePlus size={15} strokeWidth={2} />
            Wrap up
          </button>
        ) : (
          <button
            type="button"
            onClick={handleTickClick}
            disabled={formOpen}
            aria-label={`Mark "${item.title}" done`}
            aria-pressed={formOpen}
            className={cn(
              'flex items-center justify-center w-14 border-l border-border transition-colors',
              formOpen
                ? 'bg-green-50 cursor-default'
                : 'hover:bg-accent active:bg-accent/70',
            )}
          >
            <Check
              size={18}
              className={formOpen ? 'text-green-600' : 'text-muted-foreground'}
              strokeWidth={2}
            />
          </button>
        )}
      </div>
      {formOpen && (
        <TickedHoursForm
          itemTitle={item.title}
          onSave={handleFormSave}
          onCancel={handleFormCancel}
        />
      )}
    </li>
  );
}

// ── Inline hours form (shown when a job-linked Today row is ticked) ────────
//
// Three fields: hours, activity, description. Date and job are implicit
// (today + the schedule item's jobId). Save and Cancel both dismiss the form
// and let the parent collapse the row by marking the schedule item complete.
//
// Enter in the hours input saves. Save disabled until hours > 0.

const ACTIVITY_OPTIONS: { value: ActivityType; label: string }[] = [
  { value: 'painting',     label: 'Painting' },
  { value: 'prep',         label: 'Prep' },
  { value: 'staining',     label: 'Staining' },
  { value: 'wallpapering', label: 'Wallpapering' },
  { value: 'stopping',     label: 'Stopping' },
  { value: 'primer',       label: 'Primer' },
  { value: 'repair',       label: 'Repair' },
  { value: 'cleanup',      label: 'Cleanup' },
  { value: 'travel',       label: 'Travel' },
  { value: 'quoting',      label: 'Quoting' },
  { value: 'admin',        label: 'Admin' },
];

function TickedHoursForm({
  itemTitle, onSave, onCancel,
}: {
  itemTitle: string;
  onSave: (fields: LoggedHoursFields) => void;
  onCancel: () => void;
}) {
  const [hoursStr, setHoursStr] = useState('');
  const [activity, setActivity] = useState<ActivityType>('painting');
  const [description, setDescription] = useState('');

  const hoursNum = parseFloat(hoursStr);
  const canSave = !Number.isNaN(hoursNum) && hoursNum > 0;

  function submit() {
    if (!canSave) return;
    onSave({ hours: hoursNum, activity, description });
  }

  return (
    <div className="border-t border-border bg-muted/30 px-4 py-3 space-y-3">
      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
          Hours
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            step="0.25"
            min={0}
            autoFocus
            value={hoursStr}
            onChange={(e) => setHoursStr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="0"
            aria-label={`Hours worked on ${itemTitle}`}
            className="w-28 h-11 px-3 rounded-lg border border-input bg-background text-base font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <span className="text-sm text-muted-foreground">h</span>
        </div>
      </div>

      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
          Activity
        </label>
        <select
          value={activity}
          onChange={(e) => setActivity(e.target.value as ActivityType)}
          className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {ACTIVITY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
          Notes (optional)
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={`e.g. second coat front elevation`}
          className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-11 px-4 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSave}
          className={cn(
            'h-11 px-5 rounded-xl text-sm font-semibold transition-colors',
            canSave
              ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95'
              : 'bg-muted text-muted-foreground cursor-not-allowed',
          )}
        >
          Save hours
        </button>
      </div>
    </div>
  );
}

// ── Section: This week so far ───────────────────────────────────────────────
function WeekStatsSection({
  hours, income, expenses, profit, fresh,
}: {
  hours: number;
  income: number;
  expenses: number;
  profit: number;
  fresh: boolean;
}) {
  if (fresh) {
    return (
      <section>
        <SectionLabel>This week so far</SectionLabel>
        <div className="bg-card border border-border rounded-2xl px-4 py-5 text-sm text-muted-foreground">
          Fresh week — log some hours to get started.
        </div>
      </section>
    );
  }

  // Hours subvalue: "of 30h" — flat target per spec. Don't bold-shame
  // a low number; let the value itself do the talking.
  const hoursSub = `of ${HOURS_TARGET_PER_WEEK}h target`;
  // Profit accent: green when in the black, red when in the red. Avoid the
  // common dashboard sin of showing $0 in green.
  const profitAccent: 'green' | 'red' | 'default' = profit > 0
    ? 'green' : profit < 0 ? 'red' : 'default';

  return (
    <section>
      <SectionLabel>This week so far</SectionLabel>
      <div className="grid grid-cols-3 gap-2">
        <StatCard
          label="Hours"
          value={hours % 1 === 0 ? `${hours}h` : `${hours.toFixed(1)}h`}
          subvalue={hoursSub}
          icon={Clock}
          accent="blue"
        />
        <StatCard
          label="Income"
          value={fmtMoney(income)}
          subvalue="ex-GST · cash"
          icon={DollarSign}
          accent="green"
        />
        <StatCard
          label="Profit"
          value={fmtMoney(profit)}
          subvalue={`after ${fmtMoney(expenses)} costs`}
          icon={TrendingUp}
          accent={profitAccent}
        />
      </div>
    </section>
  );
}

// ── Section: Money flags ────────────────────────────────────────────────────
//
// Both flag rows are expandable in place: tap the summary and the card grows
// downward to list the individual invoices/bills with a Mark paid pill on each.
// This keeps the action loop on Home — no navigation, no sheet — which matches
// how the rest of the dashboard behaves.
//
// Each child owns its own open/closed state. They're independent — opening
// invoices doesn't close bills. When Brad marks the last item in a section
// paid, the parent recomputes `showMoneyFlags` and the whole card unmounts,
// which collapses any open state automatically (correct behaviour).

function MoneyFlagsCard({
  overdueInvoices, billsDueSoon, billDrafts, depositsToSend, quoteFollowUps, jobImports, jobs, todayISO,
  onMarkInvoicePaid, onMarkBillPaid, onConfirmDraft, onConfirmDraftSplit, onDeleteDraft,
  onCommitImportAsLink, onCommitImportAsCreate, onCommitImportAsSkip, onIssueDeposit, onDepositNotYet,
  onFollowedUp, onMarkLost, onSnoozeFollowUp,
}: {
  overdueInvoices: Invoice[];
  billsDueSoon: Entry[];
  billDrafts: Entry[];
  depositsToSend: Job[];
  quoteFollowUps: QuoteFollowUp[];
  jobImports: JobImport[];
  jobs: Job[];
  todayISO: string;
  onIssueDeposit: (job: Job) => void;
  onDepositNotYet: (job: Job, reason: DepositNotYetReason) => void;
  onFollowedUp: (jobId: string) => void;
  onMarkLost: (jobId: string) => void;
  onSnoozeFollowUp: (jobId: string, untilISO: string) => void;
  onMarkInvoicePaid: (invoiceId: string, paidDate: string) => void;
  onMarkBillPaid: (entryId: string, paidDate: string) => void;
  onConfirmDraft: (entryId: string, payload: { jobId: string | null; materials: MaterialInit[] }) => void;
  onConfirmDraftSplit: (entryId: string, slices: { jobId: string | null; exGst: number }[], materials: MaterialInit[]) => void;
  onDeleteDraft: (entryId: string) => void;
  onCommitImportAsLink: (importId: string, jobId: string, outcome: ImportOutcome) => void;
  onCommitImportAsCreate: (importId: string) => void;
  onCommitImportAsSkip: (importId: string) => void;
}) {
  return (
    <section>
      <SectionLabel>Flags</SectionLabel>
      <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
        {/* Drafts first — the freshest pending action; Brad just uploaded
            a PDF and the next tap should be to confirm it. */}
        {billDrafts.length > 0 && (
          <BillsToConfirmFlag
            drafts={billDrafts}
            jobs={jobs}
            onConfirm={onConfirmDraft}
            onConfirmSplit={onConfirmDraftSplit}
            onDelete={onDeleteDraft}
          />
        )}
        {/* Project archive imports — staged by scripts/import-projects.ts.
            Sits below bill drafts because these are historical data being
            backfilled, not "right now" actions. */}
        {jobImports.length > 0 && (
          <ImportsToReviewFlag
            imports={jobImports}
            jobs={jobs}
            onLink={onCommitImportAsLink}
            onCreate={onCommitImportAsCreate}
            onSkip={onCommitImportAsSkip}
          />
        )}
        {depositsToSend.length > 0 && (
          <DepositToSendFlag
            jobs={depositsToSend}
            onIssueDeposit={onIssueDeposit}
            onNotYet={onDepositNotYet}
          />
        )}
        {quoteFollowUps.length > 0 && (
          <QuoteFollowUpsFlag
            followUps={quoteFollowUps}
            todayISO={todayISO}
            onFollowedUp={onFollowedUp}
            onMarkLost={onMarkLost}
            onSnooze={onSnoozeFollowUp}
          />
        )}
        {overdueInvoices.length > 0 && (
          <OverdueInvoicesFlag
            invoices={overdueInvoices}
            jobs={jobs}
            todayISO={todayISO}
            onMarkPaid={onMarkInvoicePaid}
          />
        )}
        {billsDueSoon.length > 0 && (
          <BillsDueFlag
            bills={billsDueSoon}
            jobs={jobs}
            todayISO={todayISO}
            onMarkPaid={onMarkBillPaid}
          />
        )}
      </div>
    </section>
  );
}

// ── Flag: Deposits to send ─────────────────────────────────────────────────
// Accepted jobs with no deposit invoice yet. Tapping "Issue deposit" opens the
// invoice sheet pre-filled as a deposit (amount/number/date derived from the
// job's quote + the quote template), so the booking-securing invoice is one
// review-and-save away — matching the rest of the dashboard's keep-it-on-Home
// action loop.
function DepositToSendFlag({
  jobs, onIssueDeposit,
}: {
  jobs: Job[];
  onIssueDeposit: (job: Job) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-accent transition-colors text-left"
      >
        <div className="w-8 h-8 rounded-xl bg-violet-50 flex items-center justify-center shrink-0">
          <FilePlus size={16} className="text-violet-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {jobs.length} deposit{jobs.length === 1 ? '' : 's'} to send
          </p>
          <p className="text-xs text-muted-foreground">
            Accepted — send the deposit to secure the booking
          </p>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            'text-muted-foreground shrink-0 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <ul className="px-2 pb-2 space-y-2 bg-muted/30">
          {jobs.map((job) => (
            <li
              key={job.id}
              className="bg-card border border-border rounded-xl flex items-center gap-3 px-3 py-2 min-h-[56px]"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">
                  {job.name}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {job.clientName}
                  {job.quoteAmount ? ` · quote ${fmtMoney(job.quoteAmount)}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onIssueDeposit(job); }}
                className="shrink-0 h-11 px-4 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition-colors active:scale-95"
              >
                Issue deposit
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Flag: Quote follow-ups ──────────────────────────────────────────────────
// Quoted jobs gone quiet, on Brad's chase cadence (lib/quote-follow-up.ts):
// day 7 → first nudge, day 21 → the short "either way" message, and a week
// of silence after that → prompt to mark the job lost. One row per job,
// showing only the most urgent stage. "Followed up" stamps lastContactedDate
// (same as the Leads page's Mark contacted) so the row self-clears.
//
// Every card also gets the two "I'm not doing this today" outs (added
// August 2026 — before that, a first-stage card offered ONLY chasing,
// and an unactionable nag is a nag that gets ignored):
//   - "Give it a week" → snoozeUntil +7d. Hides the job from the
//     ladder, the Leads lists and push notifications, then resumes on
//     its own. For the "they said they're deciding next week" case.
//   - "Stop chasing" → two-tap Mark lost (no-reply), same as the old
//     close-stage control but available at every stage — Brad decides
//     when a lead is dead, not the ladder.
function QuoteFollowUpsFlag({
  followUps, todayISO, onFollowedUp, onMarkLost, onSnooze,
}: {
  followUps: QuoteFollowUp[];
  todayISO: string;
  onFollowedUp: (jobId: string) => void;
  onMarkLost: (jobId: string) => void;
  onSnooze: (jobId: string, untilISO: string) => void;
}) {
  const [open, setOpen] = useState(false);

  // Header line: lead with the most urgent stage present.
  const hasClose = followUps.some((f) => f.stage === 'close');
  const subtitle = hasClose
    ? 'No reply after your final follow-up — time to close some out'
    : 'Quote sent, gone quiet — a quick chase wins these';

  const STAGE_COPY: Record<QuoteFollowUp['stage'], {
    pill: string;
    pillClass: string;
    line: (f: QuoteFollowUp) => string;
  }> = {
    first: {
      pill: '1st follow-up',
      pillClass: 'bg-amber-50 text-amber-700 border-amber-200',
      line: (f) => `Quoted ${f.daysSinceSent}d ago, no reply — send a friendly nudge`,
    },
    second: {
      pill: '2nd follow-up',
      pillClass: 'bg-orange-50 text-orange-700 border-orange-200',
      line: (f) => `Quoted ${f.daysSinceSent}d ago — send the short "either way" message`,
    },
    close: {
      pill: 'Close it out',
      pillClass: 'bg-red-50 text-red-700 border-red-200',
      line: (f) => `Still quiet ${f.daysSinceContact}d after your follow-up — likely gone`,
    },
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-accent transition-colors text-left"
      >
        <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
          <Send size={16} className="text-blue-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {followUps.length} quote follow-up{followUps.length === 1 ? '' : 's'} due
          </p>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            'text-muted-foreground shrink-0 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <ul className="px-2 pb-2 space-y-2 bg-muted/30">
          {followUps.map((f) => {
            const copy = STAGE_COPY[f.stage];
            return (
              <li
                key={f.job.id}
                className="bg-card border border-border rounded-xl px-3 py-2.5 space-y-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">
                      {f.job.name}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {f.job.clientName}
                      {f.job.quoteAmount ? ` · quote ${fmtMoney(f.job.quoteAmount)}` : ''}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {copy.line(f)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 inline-flex items-center px-2 py-1 rounded-lg border text-[11px] font-semibold whitespace-nowrap',
                      copy.pillClass,
                    )}
                  >
                    {copy.pill}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {f.job.clientPhone && (
                    <a
                      href={`tel:${f.job.clientPhone}`}
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 w-11 h-11 inline-flex items-center justify-center rounded-xl border border-border text-foreground hover:bg-accent transition-colors"
                      title={`Call ${f.job.clientName ?? 'the client'}`}
                    >
                      <Phone size={15} strokeWidth={1.8} />
                    </a>
                  )}
                  {f.job.clientEmail && (
                    <a
                      href={gmailComposeUrl(f.job.clientEmail)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 w-11 h-11 inline-flex items-center justify-center rounded-xl border border-border text-foreground hover:bg-accent transition-colors"
                      title={`Email ${f.job.clientName ?? 'the client'} in Gmail`}
                    >
                      <Mail size={15} strokeWidth={1.8} />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onFollowedUp(f.job.id); }}
                    className="flex-1 h-11 px-3 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition-colors active:scale-95"
                    title="Stamps today as the last contact — the flag clears until the next stage"
                  >
                    Followed up
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSnooze(f.job.id, formatISODate(addDays(parseISODate(todayISO), 7)));
                    }}
                    className="flex-1 h-11 px-3 rounded-full border border-border bg-background text-foreground text-xs font-semibold hover:bg-accent transition-colors active:scale-95"
                    title="Snooze this one for a week — it drops off Home, Leads and notifications, then comes back by itself"
                  >
                    Give it a week
                  </button>
                  <MarkLostControl onConfirm={() => onMarkLost(f.job.id)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Two-tap "Stop chasing" → Mark lost. First tap arms it ("Mark
 * lost?"), second confirms. Status changes are recoverable from the
 * job sheet, but a fat-finger at 5:30pm shouldn't silently kill a
 * live lead — hence the confirm. Disarms itself after a few seconds
 * if the second tap never comes. The armed label says exactly what
 * the second tap does — "Stop chasing" alone could read as "just
 * mute the reminders", and that's the OTHER button.
 */
function MarkLostControl({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 4000);
        } else {
          onConfirm();
        }
      }}
      className={cn(
        'flex-1 h-11 px-3 rounded-full border text-xs font-semibold transition-colors active:scale-95',
        armed
          ? 'bg-red-600 border-red-600 text-white'
          : 'border-red-200 text-red-700 bg-red-50 hover:bg-red-100',
      )}
      title="Not following this one up — marks the job as lost (no reply)"
    >
      {armed ? 'Mark lost?' : 'Stop chasing'}
    </button>
  );
}

/**
 * Two-step Mark paid control. Collapsed = green pill button. Expanded
 * = date input (default today) + Confirm + cancel X. Used by both
 * BillsDueFlag rows and OverdueInvoicesFlag rows so the UX is identical
 * across the two flag types.
 *
 * Why two-step instead of one-tap: the paid_date matters for cashflow
 * reporting AND for the bank reconcile match window (±2 days). Letting
 * the user backdate by a day or two before confirming prevents a
 * confirmed-today bill from looking unmatched when the bank txn lands
 * a day earlier.
 */
function MarkPaidControl({
  todayISO, onConfirm,
}: {
  todayISO: string;
  onConfirm: (paidDate: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayISO);

  if (!open) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="shrink-0 h-11 px-4 rounded-full bg-green-600 hover:bg-green-700 text-white text-xs font-semibold transition-colors active:scale-95"
      >
        Mark paid
      </button>
    );
  }

  return (
    <div
      className="shrink-0 flex items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="date"
        value={date}
        autoFocus
        onChange={(e) => setDate(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onConfirm(date); }
          if (e.key === 'Escape') setOpen(false);
        }}
        className="h-11 px-2 rounded-lg border border-input bg-background text-xs focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <button
        type="button"
        onClick={() => onConfirm(date)}
        className="h-11 px-3 rounded-full bg-green-600 hover:bg-green-700 text-white text-xs font-semibold transition-colors active:scale-95"
      >
        Confirm
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Cancel"
        className="h-11 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

// ── Flag: Overdue invoices ─────────────────────────────────────────────────
function OverdueInvoicesFlag({
  invoices, jobs, todayISO, onMarkPaid,
}: {
  invoices: Invoice[];
  jobs: Job[];
  todayISO: string;
  onMarkPaid: (id: string, paidDate: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const total = invoices.reduce((s, i) => s + i.amountExGst, 0);
  const todayDate = parseISODate(todayISO);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-accent transition-colors text-left"
      >
        <div className="w-8 h-8 rounded-xl bg-red-50 flex items-center justify-center shrink-0">
          <AlertCircle size={16} className="text-red-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {invoices.length} overdue invoice{invoices.length === 1 ? '' : 's'}
          </p>
          <p className="text-xs text-muted-foreground">
            Unpaid &gt; {OVERDUE_INVOICE_DAYS} days · {fmtMoney(total)} ex-GST
          </p>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            'text-muted-foreground shrink-0 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <ul className="px-2 pb-2 space-y-2 bg-muted/30">
          {invoices.map((inv) => {
            const job = jobs.find((j) => j.id === inv.jobId);
            const daysOverdue = Math.max(
              0,
              Math.floor((todayDate.getTime() - parseISODate(inv.invoiceDate).getTime()) / 86400000),
            );
            return (
              <li
                key={inv.id}
                className="bg-card border border-border rounded-xl flex items-center gap-3 px-3 py-2 min-h-[56px]"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">
                      {inv.invoiceNumber}
                    </p>
                    <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">
                      {fmtMoney(inv.amountExGst)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {job?.clientName ?? 'Unknown client'}
                    {job?.name ? ` · ${job.name}` : ''}
                  </p>
                  <p className="text-xs text-red-600 font-medium mt-0.5">
                    {daysOverdue} day{daysOverdue === 1 ? '' : 's'} overdue
                  </p>
                </div>
                <MarkPaidControl
                  todayISO={todayISO}
                  onConfirm={(paidDate) => onMarkPaid(inv.id, paidDate)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Flag: Bills due in next 7 days ─────────────────────────────────────────
/** One row in the bills-due list. Split bills (sibling entries sharing a
 *  bill_group_id) collapse into a single row so the list shows invoices,
 *  not allocation slices — the slice detail lives in the tap-through sheet. */
interface BillDueRowVM {
  key: string;
  /** Every entry in this row's group (1 for a normal bill, N for a split). */
  entryIds: string[];
  /** The entry to open the detail sheet on. */
  primaryId: string;
  company: string;
  ref?: string;
  exGst: number;
  issuedDate?: string;
  dueDate?: string;
  /** Distinct jobIds across the group (undefined = overhead / no job). */
  jobIds: (string | undefined)[];
  itemsPending: boolean;
}

function BillsDueFlag({
  bills, jobs, todayISO, onMarkPaid,
}: {
  bills: Entry[];
  jobs: Job[];
  todayISO: string;
  onMarkPaid: (id: string, paidDate: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const total = bills.reduce((s, b) => s + billExGst(b), 0);

  // Collapse split siblings into one row per invoice. Group key is the
  // bill_group_id when present, else the entry's own id.
  const rows = useMemo<BillDueRowVM[]>(() => {
    const byKey = new Map<string, Entry[]>();
    for (const b of bills) {
      const key = b.billGroupId ?? b.id;
      const list = byKey.get(key);
      if (list) list.push(b); else byKey.set(key, [b]);
    }
    return [...byKey.entries()].map(([key, group]) => {
      const primary = group.find((g) => g.sourceMessageId) ?? group[0];
      const raw = (primary.parserRaw && typeof primary.parserRaw === 'object')
        ? primary.parserRaw as { lineItems?: unknown; lineItemsPending?: boolean } : null;
      const hasItems = Array.isArray(raw?.lineItems) && (raw.lineItems as unknown[]).length > 0;
      return {
        key,
        entryIds: group.map((g) => g.id),
        primaryId: primary.id,
        company: primary.company ?? primary.supplier ?? primary.description ?? 'Bill',
        ref: primary.paymentRef,
        exGst: group.reduce((s, g) => s + billExGst(g), 0),
        issuedDate: primary.entryDate,
        dueDate: primary.dueDate,
        jobIds: [...new Set(group.map((g) => g.jobId))],
        itemsPending: raw?.lineItemsPending === true && !hasItems,
      };
    });
  }, [bills]);

  // "McLeod Ave" / "Overhead" / "McLeod Ave + Overhead" — keeps the job
  // story visible without opening the sheet.
  const jobLabel = (jobIds: (string | undefined)[]): string => jobIds
    .map((id) => (id ? (jobs.find((j) => j.id === id)?.name ?? 'Job') : 'Overhead'))
    .join(' + ');

  // Build a more honest heading: if every bill shares the same dueDate
  // (very common with on-the-20th suppliers — every April invoice from
  // Trademax/Dulux/Resene shares 20 May), say so directly instead of the
  // generic "in 7 days" window. Falls back to the window phrasing when
  // dates are actually spread.
  const heading = (() => {
    const uniqueDates = new Set(bills.map((b) => b.dueDate).filter(Boolean));
    if (uniqueDates.size === 1 && bills[0].dueDate) {
      const labelFor = (iso: string) => {
        if (iso === todayISO) return 'today';
        const tomorrowISO = formatISODate(addDays(parseISODate(todayISO), 1));
        if (iso === tomorrowISO) return 'tomorrow';
        return `on ${fmtDueDate(iso)}`;
      };
      return `${rows.length} bill${rows.length === 1 ? '' : 's'} due ${labelFor(bills[0].dueDate!)}`;
    }
    return `${rows.length} bill${rows.length === 1 ? '' : 's'} due in ${BILLS_DUE_LOOKAHEAD_DAYS} days`;
  })();

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-accent transition-colors text-left"
      >
        <div className="w-8 h-8 rounded-xl bg-amber-50 flex items-center justify-center shrink-0">
          <Receipt size={16} className="text-amber-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {heading}
          </p>
          <p className="text-xs text-muted-foreground">
            {fmtMoney(total)} ex-GST
          </p>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            'text-muted-foreground shrink-0 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <ul className="px-2 pb-2 space-y-2 bg-muted/30">
          {rows.map((r) => (
            <li
              key={r.key}
              role="button"
              tabIndex={0}
              onClick={() => setDetailId(r.primaryId)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailId(r.primaryId); } }}
              className="bg-card border border-border rounded-xl flex items-center gap-3 px-3 py-2 min-h-[56px] cursor-pointer hover:border-primary/40 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">
                    {r.company}
                  </p>
                  <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">
                    {fmtMoney(r.exGst)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {r.ref && <span>#{r.ref}</span>}
                  {r.issuedDate && <span>{r.ref ? ' · ' : ''}Issued {fmtDueDate(r.issuedDate)}</span>}
                </p>
                <p className="text-xs truncate mt-0.5">
                  <span className="text-amber-700 font-medium">
                    Due {r.dueDate ? fmtDueDate(r.dueDate) : '—'}
                  </span>
                  <span className={cn(
                    'ml-2',
                    r.jobIds.length === 1 && !r.jobIds[0]
                      ? 'text-muted-foreground'
                      : 'text-foreground/80 font-medium',
                  )}>
                    {r.jobIds.length > 1 && <Split size={11} className="inline -mt-0.5 mr-0.5 rotate-90" aria-hidden="true" />}
                    {jobLabel(r.jobIds)}
                  </span>
                  {r.itemsPending && (
                    <span className="ml-2 text-blue-700">Items pending</span>
                  )}
                </p>
              </div>
              <MarkPaidControl
                todayISO={todayISO}
                onConfirm={(paidDate) => r.entryIds.forEach((id) => onMarkPaid(id, paidDate))}
              />
            </li>
          ))}
        </ul>
      )}
      {/* Tap-through detail: everything we know about the bill + change its
          job allocation (incl. splitting to overhead) after confirmation. */}
      <BillDetailSheet
        entryId={detailId}
        open={detailId !== null}
        onClose={() => setDetailId(null)}
      />
    </div>
  );
}

// ── Flag: Bills to confirm (parsed from uploaded PDFs) ──────────────────────
//
// Drafts created by the bill-upload card on /entry land here. Each row shows
// what the parser extracted plus a job picker so Brad can correct/set the
// allocation before tapping Confirm. Tap "View PDF" to open the original in
// a new tab (signed URL, 5-min expiry, regenerated on click). Tap Confirm to
// flip isDraft=false and start counting the bill in money math.
//
// Confidence dot colours: green=high, amber=medium, red=low. Low is the
// signal "really double-check this one before confirming" — typically a
// failed GST validation, an unusual layout, or missing key fields.

/** Type-narrow on the parserRaw.failure marker so the header summary
 *  can split parseable drafts from "needs attention" drafts. Kept
 *  defensive because parser_raw is `unknown` jsonb. */
function isFailureDraft(d: Entry): boolean {
  const raw = d.parserRaw as { failure?: unknown } | null;
  return Boolean(raw && typeof raw === 'object' && raw.failure);
}

function BillsToConfirmFlag({
  drafts, jobs, onConfirm, onConfirmSplit, onDelete,
}: {
  drafts: Entry[];
  jobs: Job[];
  onConfirm: (entryId: string, payload: { jobId: string | null; materials: MaterialInit[] }) => void;
  onConfirmSplit: (entryId: string, slices: { jobId: string | null; exGst: number }[], materials: MaterialInit[]) => void;
  onDelete: (entryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Split into parseable drafts (ready to confirm with full data) and
  // failure drafts (email arrived but no parseable bill — surfaced so
  // they don't disappear silently). Sort failure drafts to the top of
  // the list because they're action-blocking: until Brad handles them,
  // those bills aren't in his books.
  const failureDrafts = drafts.filter(isFailureDraft);
  const parseable = drafts.filter((d) => !isFailureDraft(d));
  const orderedDrafts = [...failureDrafts, ...parseable];
  // Total only counts parseable drafts — failure drafts have no amount.
  const total = parseable.reduce((s, d) => s + billExGst(d), 0);

  // Header text: lead with whichever count is higher-priority. Failure
  // drafts always win because they're broken; parseable drafts are
  // routine.
  const headerPrimary = failureDrafts.length > 0
    ? `${failureDrafts.length} email${failureDrafts.length === 1 ? '' : 's'} need${failureDrafts.length === 1 ? 's' : ''} attention`
    : `${parseable.length} bill${parseable.length === 1 ? '' : 's'} to confirm`;
  const headerSecondary = failureDrafts.length > 0 && parseable.length > 0
    ? `+ ${parseable.length} parsed · ${fmtMoney(total)} ex-GST`
    : failureDrafts.length > 0
      ? 'Open the originals and log manually'
      : `From PDF · ${fmtMoney(total)} ex-GST`;

  // Icon also swaps to AlertCircle when failures are present, so the
  // dashboard scan picks up the distinction without expanding the card.
  const Icon = failureDrafts.length > 0 ? AlertCircle : FilePlus;
  const iconColor = failureDrafts.length > 0 ? 'text-amber-600' : 'text-orange-600';
  const iconBg = failureDrafts.length > 0 ? 'bg-amber-50' : 'bg-orange-50';

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-accent transition-colors text-left"
      >
        <div className={cn('w-8 h-8 rounded-xl flex items-center justify-center shrink-0', iconBg)}>
          <Icon size={16} className={iconColor} strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {headerPrimary}
          </p>
          <p className="text-xs text-muted-foreground">
            {headerSecondary}
          </p>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            'text-muted-foreground shrink-0 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <ul className="px-2 pb-2 space-y-2 bg-muted/30">
          {orderedDrafts.map((d) => (
            <DraftBillRow
              key={d.id}
              draft={d}
              jobs={jobs}
              onConfirm={onConfirm}
              onConfirmSplit={onConfirmSplit}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// Per-line allocation value:
//   ''       = use the bill's job (the top picker)
//   '__OH__' = force this line to overhead (no job), even when the bill has a job
//   'skip'   = don't track this line (no material row)
//   <uuid>   = a specific job for this line
// splitSlices already buckets '__OH__' to overhead; resolveJobId maps it to undefined.
type LineAlloc = '' | 'skip' | string;

// The non-job outcomes a line item can take, fed to JobPicker as fixed
// rows above the job list. '' (use the bill's job) isn't here — that's
// the picker's built-in "no job" row, relabelled via noJobLabel.
const LINE_ALLOC_OPTIONS = [
  { value: '__OH__', label: 'Overhead (no job)', description: 'Force this line to overhead even if the bill has a job' },
  { value: 'skip', label: "Skip — don't track", description: 'No material row (levies, freight, rounding)' },
];

// Shape of a parsed line item we accept from parserRaw. The LLM may emit
// loose JSON; we narrow defensively before reading fields.
interface ParsedLineItem {
  description?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  total?: unknown;
}

function DraftBillRow({
  draft, jobs, onConfirm, onConfirmSplit, onDelete,
}: {
  draft: Entry;
  jobs: Job[];
  onConfirm: (entryId: string, payload: { jobId: string | null; materials: MaterialInit[] }) => void;
  onConfirmSplit: (entryId: string, slices: { jobId: string | null; exGst: number }[], materials: MaterialInit[]) => void;
  onDelete: (entryId: string) => void;
}) {
  // Picker state: starts at whatever the parser pre-filled (jobId from
  // rankJobs match, or undefined for unallocated). Brad can change before
  // confirming — '' represents "Overhead / no job".
  const [pickedJobId, setPickedJobId] = useState<string>(draft.jobId ?? '');
  const [opening, setOpening] = useState(false);

  // Pre-rank the jobs against the parser's jobHint so the best matches
  // float to the top of the dropdown. The hint may be undefined; rankJobs
  // handles that gracefully (returns all jobs sorted by tier/recency).
  // Read both jobHint (for the dropdown ranking) and dueDateSource (for
  // the small provenance label next to the due date) from parserRaw.
  //
  // `failure` is populated by the webhook when an email arrived but we
  // couldn't extract a usable bill (no PDF, image-only scan, parser
  // error). Such drafts have no amount/supplier — they exist purely to
  // surface the email on Home so Brad can handle it manually. See the
  // FailureDraftRow render path below.
  const parserRaw = draft.parserRaw as
    {
      jobHint?: string;
      dueDateSource?: 'pdf' | 'computed' | 'manual';
      lineItems?: unknown;
      // Set when the bill was parsed from the email body (Dulux secure-link
      // emails). The figures are right, but line items only live in the
      // gated PDF — duluxSecureLink is where Brad fetches it.
      lineItemsPending?: boolean;
      duluxSecureLink?: string;
      failure?: {
        reason?: string;
        detail?: string;
        subject?: string;
        fromAddress?: string;
        pdfSource?: 'attachment' | 'link' | 'email-body';
      };
    } | null;
  const failure = parserRaw?.failure;
  const hint = parserRaw?.jobHint;
  const dueDateSource = parserRaw?.dueDateSource;
  const duluxSecureLink = parserRaw?.duluxSecureLink;
  // (No local rankJobs call any more — JobPicker does its own ranking off
  // the `context` we hand it, so pre-ranking here would just be duplicate
  // work that can drift out of step with the picker's ordering.)

  // ── Line items ──────────────────────────────────────────────────────────
  // Defensive narrowing — parserRaw is `unknown` jsonb, can be anything.
  // We accept only objects with at least a string `description`.
  const lineItems: ParsedLineItem[] = useMemo(() => {
    const raw = parserRaw?.lineItems;
    if (!Array.isArray(raw)) return [];
    return raw.filter((li): li is ParsedLineItem =>
      typeof li === 'object' && li !== null && typeof (li as ParsedLineItem).description === 'string'
    );
  }, [parserRaw?.lineItems]);

  // Cost helper — same fallback as the parser route: prefer `total`, else
  // quantity*unitPrice, else undefined (counts as cost-less for default-skip).
  const lineCost = useCallback((li: ParsedLineItem): number | undefined => {
    if (typeof li.total === 'number' && Number.isFinite(li.total)) return li.total;
    if (typeof li.quantity === 'number' && typeof li.unitPrice === 'number') {
      return li.quantity * li.unitPrice;
    }
    return undefined;
  }, []);

  // Per-line allocation state, indexed by line position. '' means "use
  // the bill-level picker" (resolved at submit time). 'skip' means "don't
  // create a material row". Anything else is a job UUID.
  //
  // Default rule: lines WITH a cost default to '' (follow the bill's job).
  // Cost-less lines (e.g. Resene's Paintwise levy when parser doesn't emit
  // a total) default to 'skip' so they don't pollute the materials log.
  const [allocations, setAllocations] = useState<Record<number, LineAlloc>>(() => {
    const init: Record<number, LineAlloc> = {};
    lineItems.forEach((li, i) => {
      init[i] = lineCost(li) === undefined ? 'skip' : '';
    });
    return init;
  });

  // Track which line indices Brad has manually touched. When he changes
  // the bill-level job picker we DON'T want to overwrite his explicit
  // per-line choices — only the untouched defaults should follow.
  const [touched, setTouched] = useState<Set<number>>(() => new Set());

  function setLineAlloc(i: number, value: LineAlloc) {
    setAllocations((prev) => ({ ...prev, [i]: value }));
    setTouched((prev) => {
      const next = new Set(prev);
      next.add(i);
      return next;
    });
  }

  // When the bill-level picker changes, propagate to untouched lines.
  // We can't do this from setPickedJobId directly without a useEffect,
  // but the rule is simple: the line's *displayed* value is whatever's
  // in `allocations[i]`, and '' means "follow the bill". So in practice
  // we don't need to re-write state at all — '' rows naturally follow
  // pickedJobId when we resolve allocations at submit time. (We DO need
  // to refresh defaults if lineItems were to change, but they don't on
  // a confirmed row.)

  const confidence = draft.parserConfidence ?? 'medium';
  const confidenceColor = confidence === 'high' ? 'bg-green-500'
    : confidence === 'medium' ? 'bg-amber-500'
    : 'bg-red-500';

  async function handleViewPdf() {
    if (!draft.billPdfUrl) return;
    setOpening(true);
    try {
      // Fresh signed URL on every click — 5 min is plenty for "open and
      // glance", and storing URLs would mean stale links over time.
      const { data, error } = await supabase.storage
        .from('bill-pdfs')
        .createSignedUrl(draft.billPdfUrl, 300);
      if (error || !data) {
        console.error('[bill-draft] Failed to sign PDF URL:', error);
        alert('Couldn\'t open the PDF — please try again.');
        return;
      }
      window.open(data.signedUrl, '_blank', 'noopener');
    } finally {
      setOpening(false);
    }
  }

  function handleDelete() {
    // window.confirm rather than a bespoke modal — keeps this small and
    // there's no harm in a native prompt; deletion is rare. Phrase the
    // prompt around recovery so Brad knows the consequence.
    const label = draft.company ?? draft.supplier ?? 'this draft';
    if (typeof window !== 'undefined'
      && !window.confirm(`Delete ${label}? This can't be undone.`)) {
      return;
    }
    onDelete(draft.id);
  }

  // When line items are allocated across 2+ jobs, this is the per-job
  // ex-GST split: each job's share of the bill's ex-GST total, proportional
  // to its line-cost share (so skipped / cost-less lines and parser rounding
  // never throw the total off). null = not a multi-job split → single path.
  const splitSlices = useMemo<{ jobId: string | null; exGst: number }[] | null>(() => {
    if (lineItems.length === 0) return null;
    const exTotal = billExGst(draft);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    // The top picker is the DEFAULT bucket ('__OH__' = overhead / no job).
    const defaultKey = pickedJobId === '' ? '__OH__' : pickedJobId;

    // Sum each line into its destination: '' → default bucket, an override
    // → that job, 'skip' → untracked (its cost falls into the remainder
    // below). Line costs are ex-GST.
    const sums = new Map<string, number>();
    let tracked = 0;
    lineItems.forEach((li, i) => {
      const a = allocations[i] ?? '';
      if (a === 'skip') return;
      const key = a === '' ? defaultKey : a;
      const c = lineCost(li) ?? 0;
      sums.set(key, (sums.get(key) ?? 0) + c);
      tracked += c;
    });

    // Anything not pinned to an override line (skipped lines, levies,
    // line-vs-total rounding) stays on the DEFAULT bucket, so the slices
    // always sum to the bill total and a skipped line never inflates
    // another job.
    const remainder = r2(exTotal - tracked);
    sums.set(defaultKey, r2((sums.get(defaultKey) ?? 0) + remainder));

    const present = [...sums.entries()].filter(([, v]) => Math.abs(v) > 0.005);
    if (present.length < 2) return null; // single job → not a split
    const slices = present.map(([key, v]) => ({ jobId: key === '__OH__' ? null : key, exGst: r2(v) }));
    // Pin residual rounding to the last slice so they sum to the cent.
    const exSum = slices.reduce((s, x) => s + x.exGst, 0);
    const last = slices.length - 1;
    slices[last] = { ...slices[last], exGst: r2(slices[last].exGst + (exTotal - exSum)) };
    return slices;
  }, [lineItems, allocations, pickedJobId, draft, lineCost]);

  function handleConfirm() {
    const billJobId: string | null = pickedJobId === '' ? null : pickedJobId;

    // Build the materials array from per-line allocations. Resolution rule:
    //   '' (default) → follow the bill's jobId (null = overhead)
    //   'skip'       → don't create a material row
    //   <uuid>       → use that specific job
    const materials: MaterialInit[] = [];
    lineItems.forEach((li, i) => {
      const alloc = allocations[i] ?? '';
      if (alloc === 'skip') return;
      const resolvedJobId: string | undefined =
        alloc === '' ? (billJobId ?? undefined)
          : alloc === '__OH__' ? undefined
          : alloc;
      materials.push({
        jobId: resolvedJobId,
        usedOn: draft.entryDate,
        productName: typeof li.description === 'string' ? li.description : undefined,
        quantity: typeof li.quantity === 'number' ? li.quantity : undefined,
        cost: lineCost(li),
        supplier: draft.supplier ?? draft.company,
        // The parser doesn't currently structure these — leave them for
        // a future "edit materials" flow rather than guessing.
        brand: undefined,
        color: undefined,
        finish: undefined,
        unit: undefined,
        productType: undefined,
        area: undefined,
        notes: undefined,
      });
    });

    if (splitSlices) {
      onConfirmSplit(draft.id, splitSlices, materials);
    } else {
      onConfirm(draft.id, { jobId: billJobId, materials });
    }
  }

  // ── Failure draft branch ─────────────────────────────────────────────
  // An email arrived but couldn't be turned into a parsed bill (no PDF
  // attachment + no allowlisted download link, image-only scan, etc.).
  // Surface it distinctly so Brad can either delete it or open the
  // original email and log the bill manually. No "Confirm" CTA — there's
  // nothing useful to confirm.
  if (failure) {
    const reasonText = describeFailureReason(failure.reason);
    return (
      <li className="bg-amber-50 dark:bg-amber-950/20 border border-amber-300 dark:border-amber-800 rounded-xl p-3 space-y-2">
        <div className="flex items-start gap-2 min-w-0">
          <AlertCircle
            size={16}
            strokeWidth={2}
            className="shrink-0 mt-0.5 text-amber-700 dark:text-amber-400"
            aria-hidden="true"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">
              {failure.fromAddress ?? draft.company ?? draft.supplier ?? 'Unknown sender'}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {failure.subject ?? '(no subject)'}
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-300 mt-1">
              {reasonText}
            </p>
            {failure.detail && (
              <p className="text-[11px] text-muted-foreground mt-0.5 break-words">
                {failure.detail}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleDelete}
            aria-label="Dismiss this email"
            className="shrink-0 -mt-1 -mr-1 w-7 h-7 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 flex items-center justify-center transition-colors"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
        <div className="flex gap-2 pt-1">
          <Link
            href="/entry"
            className="flex-1 h-10 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold flex items-center justify-center transition-colors"
          >
            Log bill manually
          </Link>
        </div>
      </li>
    );
  }

  return (
    <li className="bg-card border border-border rounded-xl p-3 space-y-2">
      {/* Top row: supplier + amount + confidence dot */}
      <div className="flex items-start gap-2 min-w-0">
        <span
          className={cn('w-2 h-2 rounded-full shrink-0 mt-1.5', confidenceColor)}
          title={`Parser confidence: ${confidence}`}
          aria-label={`Parser confidence: ${confidence}`}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">
            {draft.company ?? draft.supplier ?? 'Unknown supplier'}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {draft.paymentRef && <span>#{draft.paymentRef}</span>}
            {draft.entryDate && (
              <span>{draft.paymentRef ? ' · ' : ''}Received {fmtDueDate(draft.entryDate)}</span>
            )}
            {draft.dueDate && (
              <>
                <span>{(draft.paymentRef || draft.entryDate) ? ' · ' : ''}Due {fmtDueDate(draft.dueDate)}</span>
                {/* Provenance: computed = NZ "20th of next month" rule,
                    not from the PDF. Worth flagging so Brad spots wrong
                    inferences (e.g. a supplier on net-7 terms). pdf is
                    implicit — no badge needed. */}
                {dueDateSource === 'computed' && (
                  <span className="text-amber-700"> (computed)</span>
                )}
              </>
            )}
          </p>
        </div>
        <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">
          {fmtMoney(billExGst(draft))}
        </span>
        {/* Delete: small × icon, permanent delete after window.confirm.
            Also cleans up the linked PDF in Storage via deleteEntry. */}
        <button
          type="button"
          onClick={handleDelete}
          aria-label={`Delete draft from ${draft.company ?? draft.supplier ?? 'unknown supplier'}`}
          className="shrink-0 -mt-1 -mr-1 w-7 h-7 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-50 flex items-center justify-center transition-colors"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Job picker. Was a native <select> listing every job in rankJobs
          order — fine at a dozen jobs, unusable past that: no typing, no
          filtering, just a long scroll where the only way to find "32 Ash
          Ave" is to read past everything else. JobPicker searches name,
          client, address and legacy id, keeps the same relevance ordering
          when the box is empty, and surfaces recently-used jobs. Same
          component the entry form and reconcile screen use. */}
      <div>
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
          Allocate to job
        </label>
        <JobPicker
          jobs={jobs}
          value={pickedJobId}
          onChange={setPickedJobId}
          // Same jobHint the old dropdown ranked by — the PO reference the
          // parser pulled off the bill — so the likely job still floats to
          // the top before Brad types anything.
          context={hint}
          placeholder="Overhead (no job)"
          noJobLabel="Overhead (no job)"
          hideOlderWhenActive
        />
      </div>

      {/* Dulux secure-link bills: the figures came from the email, but the
          line-item PDF is gated behind Dulux's account-number check. Point
          Brad straight at the secure link so he can fetch the PDF, then the
          drop-zone below reads its items in. */}
      {lineItems.length === 0 && duluxSecureLink && (
        <a
          href={duluxSecureLink}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 h-9 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-300 text-xs font-medium hover:bg-blue-100 dark:hover:bg-blue-950/50 transition-colors"
        >
          <ExternalLink size={13} strokeWidth={1.8} className="shrink-0" />
          Get the PDF from Dulux&apos;s secure link, then drop it below for line items
        </a>
      )}

      {/* No line items yet (e.g. a backfilled bill) — let Brad drop the
          document to read them in, which unlocks the per-line split. */}
      {lineItems.length === 0 && <BillItemsAttacher draft={draft} />}

      {/* Per-line allocation — only shown when the parser found 2+ line
          items, since a single line can't split and its picker would just
          duplicate the bill-level "Allocate to job" dropdown above. With one
          line the default still applies at submit: cost-bearing → '' (follows
          the bill picker), cost-less → 'skip' (don't pollute materials).
          Each line gets its own select so a single bill can split across
          jobs (e.g. 3 cans for McLeod + 1 for Aubrey + a levy to skip). */}
      {lineItems.length > 1 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
            Line items · {lineItems.filter((_, i) => allocations[i] !== 'skip').length} of {lineItems.length} tracked
          </p>
          <ul className="space-y-1.5">
            {lineItems.map((li, i) => {
              const alloc = allocations[i] ?? '';
              const cost = lineCost(li);
              return (
                <li key={i} className="rounded-lg border border-border bg-background p-2 space-y-1.5">
                  <div className="flex items-start justify-between gap-2 min-w-0">
                    <p className="text-xs text-foreground flex-1 min-w-0 truncate" title={String(li.description ?? '')}>
                      {String(li.description ?? '—')}
                    </p>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                      {cost !== undefined ? fmtMoney(cost) : '—'}
                    </span>
                  </div>
                  {/* Same searchable picker as the bill-level one. The
                      three non-job outcomes ride along as extraOptions so
                      this stays one control rather than a select plus a
                      picker. '' is the default — inherit the bill's job. */}
                  <JobPicker
                    jobs={jobs}
                    value={alloc}
                    onChange={(v) => setLineAlloc(i, v as LineAlloc)}
                    context={String(li.description ?? '')}
                    placeholder="Use bill's job"
                    noJobLabel="Use bill's job"
                    extraOptions={LINE_ALLOC_OPTIONS}
                    hideOlderWhenActive
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Split preview — when line items point at 2+ jobs, show how the
          cost will divide before Brad confirms. Each slice becomes its own
          bill entry on that job (linked by bill_group_id). */}
      {splitSlices && (
        <div className="rounded-lg bg-primary/5 border border-primary/20 p-2 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-primary">
            Splits across {splitSlices.length} jobs
          </p>
          {splitSlices.map((s, i) => (
            <div key={i} className="flex items-center justify-between text-xs gap-2">
              <span className="text-foreground truncate">
                {s.jobId ? (jobs.find((j) => j.id === s.jobId)?.name ?? 'Job') : 'Overhead'}
              </span>
              <span className="text-muted-foreground tabular-nums shrink-0">{fmtMoney(s.exGst)} ex-GST</span>
            </div>
          ))}
        </div>
      )}

      {/* Actions: View PDF + Confirm */}
      <div className="flex items-center justify-between gap-2 pt-1">
        {draft.billPdfUrl ? (
          <button
            type="button"
            onClick={handleViewPdf}
            disabled={opening}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-50"
          >
            <ExternalLink size={12} />
            {opening ? 'Opening…' : 'View PDF'}
          </button>
        ) : (
          <span className="text-xs text-amber-700">PDF not attached</span>
        )}
        <button
          type="button"
          onClick={handleConfirm}
          className="h-11 px-4 rounded-full bg-green-600 hover:bg-green-700 text-white text-xs font-semibold transition-colors active:scale-95"
        >
          Confirm
        </button>
      </div>
    </li>
  );
}

// ── Flag: Project archive imports awaiting review ──────────────────────────
//
// Populated by running `npx tsx scripts/import-projects.ts --apply` against
// Brad's /projects folder. Each pending row represents a folder that hasn't
// yet been linked to a job (or created one). Brad expands the flag, eyeballs
// each row, and taps Link / Create / Skip to commit.
//
// The commit handlers live in the store (commitImportAsLink etc.) — they
// move staged Storage files, create the real quotes row, and conservatively
// merge parsed scope fields into the existing job. This component is pure
// UI; all state mutation goes through the parent's callbacks.

function ImportsToReviewFlag({
  imports, jobs, onLink, onCreate, onSkip,
}: {
  imports: JobImport[];
  jobs: Job[];
  onLink: (importId: string, jobId: string, outcome: ImportOutcome) => void;
  onCreate: (importId: string) => void;
  onSkip: (importId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  // Order rows by confidence so the easy wins come first — Brad can rip
  // through the J-ID matches in seconds before settling in on the
  // ambiguous ones.
  const sorted = useMemo(() => {
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };
    return [...imports].sort((a, b) => (rank[a.matchConfidence] ?? 9) - (rank[b.matchConfidence] ?? 9));
  }, [imports]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-accent transition-colors text-left"
      >
        <div className="w-8 h-8 rounded-xl bg-violet-50 flex items-center justify-center shrink-0">
          <FilePlus size={16} className="text-violet-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {imports.length} import{imports.length === 1 ? '' : 's'} to review
          </p>
          <p className="text-xs text-muted-foreground">
            From project archive · link to a job, create new, or skip
          </p>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            'text-muted-foreground shrink-0 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <ul className="px-2 pb-2 space-y-2 bg-muted/30">
          {sorted.map((imp) => (
            <ImportRow
              key={imp.id}
              importRow={imp}
              jobs={jobs}
              onLink={onLink}
              onCreate={onCreate}
              onSkip={onSkip}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ImportRow({
  importRow, jobs, onLink, onCreate, onSkip,
}: {
  importRow: JobImport;
  jobs: Job[];
  onLink: (importId: string, jobId: string, outcome: ImportOutcome) => void;
  onCreate: (importId: string) => void;
  onSkip: (importId: string) => void;
}) {
  // The picker defaults to whatever the importer suggested. Brad can
  // override before tapping Link. Empty string ('') means "no specific
  // job picked yet" — Link is disabled in that state.
  const [pickedJobId, setPickedJobId] = useState<string>(importRow.suggestedJobId ?? '');
  const [busy, setBusy] = useState(false);

  // Outcome: did Brad win or lose this quote? Required before Link
  // enables — capturing this at the moment of decision is gold for
  // the future quoting-AI's training signal. 'unknown' is allowed for
  // historical jobs Brad genuinely can't remember; we just don't touch
  // the job's status/lostReason in that case.
  const [outcome, setOutcome] = useState<'won' | 'lost' | 'unknown' | null>(null);
  const [lostReason, setLostReason] = useState<LostReason | null>(null);

  // Confidence dot — green/amber/red/grey, matches the bill-draft
  // confidence dot's vocabulary.
  const confidenceColor =
    importRow.matchConfidence === 'high'   ? 'bg-green-500' :
    importRow.matchConfidence === 'medium' ? 'bg-amber-500' :
    importRow.matchConfidence === 'low'    ? 'bg-red-500'   :
                                              'bg-slate-400';

  // Pre-rank jobs against the folder name + parsed jobAddress so the
  // dropdown's best matches float to the top. Reuses the same logic
  // bill drafts use; "active-match" jobs get a ★.
  const matchHint = importRow.parsedData?.jobAddress ?? importRow.folderName;
  const ranked = useMemo(() => rankJobs(jobs, matchHint), [jobs, matchHint]);

  function filesLabel(): string {
    const fc = importRow.filesSummary;
    const parts: string[] = [];
    if (fc.plan) parts.push(`${fc.plan} plan${fc.plan === 1 ? '' : 's'}`);
    if (fc.quote_pdf) parts.push(`${fc.quote_pdf} quote`);
    if (fc.invoice_pdf) parts.push(`${fc.invoice_pdf} invoice`);
    const photos = (fc.before_photo ?? 0) + (fc.after_photo ?? 0) + (fc.scope_photo ?? 0);
    if (photos) parts.push(`${photos} photo${photos === 1 ? '' : 's'}`);
    return parts.join(' · ') || 'no key files';
  }

  // Link is enabled when: a job is picked AND an outcome is chosen AND
  // (if lost) a lostReason is picked.
  const linkReady = pickedJobId && outcome
    && (outcome !== 'lost' || lostReason !== null);

  // ── Action handlers (with busy guard so a double-tap can't double-commit) ──
  async function handleLink() {
    if (!linkReady || busy || !outcome) return;
    setBusy(true);
    try {
      onLink(importRow.id, pickedJobId, {
        result: outcome,
        lostReason: outcome === 'lost' && lostReason ? lostReason : undefined,
      });
    } finally { setBusy(false); }
  }
  async function handleCreate() {
    if (busy) return;
    if (typeof window !== 'undefined'
      && !window.confirm(
        `Create a new job from "${importRow.folderName}"?\n\n` +
        `This adds a new row to the Jobs tab. You can edit details there afterwards.`,
      )) return;
    setBusy(true);
    try { onCreate(importRow.id); } finally { setBusy(false); }
  }
  async function handleSkip() {
    if (busy) return;
    if (typeof window !== 'undefined'
      && !window.confirm(
        `Skip "${importRow.folderName}"?\n\nThe folder's files stay on your Mac; nothing is imported.`,
      )) return;
    setBusy(true);
    try { onSkip(importRow.id); } finally { setBusy(false); }
  }

  return (
    <li className="bg-card border border-border rounded-xl p-3 space-y-2">
      {/* Top row: confidence dot + folder name + suggested label */}
      <div className="flex items-start gap-2 min-w-0">
        <span
          className={cn('w-2 h-2 rounded-full shrink-0 mt-1.5', confidenceColor)}
          title={`Match confidence: ${importRow.matchConfidence}`}
          aria-label={`Match confidence: ${importRow.matchConfidence}`}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">
            {importRow.folderName}
          </p>
          {importRow.suggestedLabel && (
            <p className="text-xs text-muted-foreground truncate">
              Suggests: {importRow.suggestedLabel}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {filesLabel()}
            {importRow.matchSource && <span> · {importRow.matchSource}</span>}
          </p>
        </div>
      </div>

      {/* Parsed quote summary if available — shown so Brad has context
          before tapping Link. */}
      {importRow.parsedData && (
        <div className="text-xs bg-muted/40 rounded-lg px-3 py-2 space-y-0.5">
          {importRow.parsedData.clientName && (
            <p><span className="text-muted-foreground">Client:</span> {importRow.parsedData.clientName}</p>
          )}
          {importRow.parsedData.jobType && (
            <p><span className="text-muted-foreground">Type:</span> {importRow.parsedData.jobType}</p>
          )}
          {importRow.parsedData.totalAmountInclGst != null && (
            <p>
              <span className="text-muted-foreground">Total:</span>{' '}
              {fmtMoney(importRow.parsedData.totalAmountInclGst)} incl GST
            </p>
          )}
          {importRow.parsedData.scopeSummary && (
            <p className="text-[11px] text-muted-foreground italic line-clamp-2">
              &ldquo;{importRow.parsedData.scopeSummary}&rdquo;
            </p>
          )}
        </div>
      )}

      {/* Job picker — best matches float via rankJobs */}
      <div>
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
          Link to job
        </label>
        <select
          value={pickedJobId}
          onChange={(e) => setPickedJobId(e.target.value)}
          disabled={busy}
          className="w-full h-10 px-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        >
          <option value="">— pick a job to link, or use Create new —</option>
          {ranked.map(({ job, tier }) => (
            <option key={job.id} value={job.id}>
              {tier === 'active-match' ? '★ ' : ''}
              {job.name}
              {job.clientName ? ` — ${job.clientName}` : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Outcome chips — captured inline, gates the Link button. This is
          the highest-leverage data for the future quoting-AI: a quote +
          its inputs without a won/lost label is signal-free. We make it
          a soft gate by allowing "Don't know" so historical quotes
          where the outcome's genuinely forgotten can still be linked. */}
      <div>
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
          Outcome
        </label>
        <div className="flex gap-1.5">
          {(['won', 'lost', 'unknown'] as const).map((opt) => {
            const active = outcome === opt;
            const label = opt === 'won' ? 'Won' : opt === 'lost' ? 'Lost' : "Don't know";
            const activeClasses = opt === 'won' ? 'bg-green-600 text-white border-green-600'
              : opt === 'lost' ? 'bg-red-600 text-white border-red-600'
              : 'bg-slate-600 text-white border-slate-600';
            return (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  setOutcome(opt);
                  if (opt !== 'lost') setLostReason(null);
                }}
                disabled={busy}
                className={cn(
                  'flex-1 h-9 px-2 rounded-lg text-xs font-medium border transition-colors',
                  active
                    ? activeClasses
                    : 'bg-background hover:bg-accent border-input text-foreground',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Lost-reason chips — appear only when Lost is selected. Captures
          the WHY which is the single most valuable training signal for
          better-pricing AI later. */}
      {outcome === 'lost' && (
        <div>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
            Why lost?
          </label>
          <div className="flex flex-wrap gap-1.5">
            {(['price', 'no-reply', 'went-elsewhere', 'scope-changed', 'project-cancelled', 'timing', 'other'] as const).map((opt) => {
              const active = lostReason === opt;
              const label = opt === 'no-reply' ? 'No reply'
                : opt === 'went-elsewhere' ? 'Went elsewhere'
                : opt === 'scope-changed' ? 'Scope changed'
                : opt === 'project-cancelled' ? 'Project cancelled'
                : opt.charAt(0).toUpperCase() + opt.slice(1);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setLostReason(opt)}
                  disabled={busy}
                  className={cn(
                    'h-8 px-3 rounded-full text-xs font-medium border transition-colors',
                    active
                      ? 'bg-red-100 text-red-800 border-red-300'
                      : 'bg-background hover:bg-accent border-input text-foreground',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Actions: Link · Create · Skip */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleLink}
          disabled={!linkReady || busy}
          title={
            !pickedJobId ? 'Pick a job from the dropdown'
            : !outcome ? 'Pick an outcome (Won / Lost / Don\'t know)'
            : outcome === 'lost' && !lostReason ? 'Pick why this quote was lost'
            : undefined
          }
          className={cn(
            'flex-1 h-11 px-4 rounded-full text-xs font-semibold transition-colors',
            (!linkReady || busy)
              ? 'bg-muted text-muted-foreground cursor-not-allowed'
              : 'bg-green-600 hover:bg-green-700 text-white active:scale-95',
          )}
        >
          Link
        </button>
        <button
          type="button"
          onClick={handleCreate}
          disabled={busy}
          className="flex-1 h-11 px-4 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition-colors active:scale-95 disabled:opacity-50"
        >
          Create new
        </button>
        <button
          type="button"
          onClick={handleSkip}
          disabled={busy}
          aria-label={`Skip ${importRow.folderName}`}
          className="shrink-0 w-11 h-11 rounded-full text-muted-foreground hover:text-red-600 hover:bg-red-50 flex items-center justify-center transition-colors disabled:opacity-50"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>
    </li>
  );
}

/**
 * Ex-GST amount for a bill entry. Mirrors `entryExGst` from job-stats.ts —
 * inlined locally so this section doesn't reach across the codebase for one
 * small primitive.
 */
function billExGst(b: Entry): number {
  if (b.amountExGst != null) return b.amountExGst;
  if (b.amount == null) return 0;
  if (!b.gstApplies) return b.amount;
  return b.amount / 1.15;
}

/**
 * Format a YYYY-MM-DD due date as "Fri 16 May" (or "Today" / "Tomorrow" for
 * the next two days). Keeps the row scannable.
 */
function fmtDueDate(iso: string): string {
  const today = formatISODate(new Date());
  const tomorrow = formatISODate(addDays(parseISODate(today), 1));
  if (iso === today) return 'today';
  if (iso === tomorrow) return 'tomorrow';
  return parseISODate(iso).toLocaleDateString('en-NZ', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

/**
 * Human-readable label for a webhook parser-failure reason. The webhook
 * stores machine-readable codes in `parserRaw.failure.reason`; this maps
 * them to a sentence that explains what to do next.
 *
 * Keep these short and action-oriented — Brad's reading them at 5:30pm
 * on a phone and needs to know whether to bother investigating.
 */
function describeFailureReason(reason: string | undefined): string {
  switch (reason) {
    case 'no-pdf-attachment':
      return 'No PDF attached. Some suppliers now send a download link instead — open the email and grab it.';
    case 'no-allowlisted-url':
      return 'No PDF attached and no recognised download link. Open the original email to add this bill.';
    case 'wrong-content-type':
      return 'Download link returned a non-PDF response. Supplier may need a login — open the email and grab it.';
    case 'fetch-failed':
      return 'Couldn\'t fetch the bill download link. Open the email and try downloading the PDF yourself.';
    case 'timeout':
      return 'Bill download timed out. Try opening the email and downloading the PDF manually.';
    case 'too-large':
      return 'The linked PDF was suspiciously large and was rejected. Open the email and check it yourself.';
    case 'empty-response':
      return 'The download link returned an empty response. Open the email and try manually.';
    case 'image-only-pdf':
      return 'PDF is image-only (no text layer). OCR isn\'t built yet — log this bill manually.';
    case 'pdf-extract-failed':
      return 'Couldn\'t read the PDF\'s text layer. Open the email and log this manually.';
    case 'parser-error':
      return 'Parser hit an error on this bill. Open the email and log this manually.';
    default:
      return 'Email arrived but couldn\'t be auto-parsed. Open the original and log manually.';
  }
}

// ── Section: Coming up ──────────────────────────────────────────────────────
/**
 * Quotes-to-prep — the "you owe these customers a quote" rail. Shows
 * up to 4 jobs whose site visit's been wrapped up but no quote sent
 * yet, sorted by quote-ready-by date (sooner = more urgent).
 *
 * Each row: job name + customer + a small "due by" pill on the right.
 * Tapping a row goes to /leads (which has the full To-quote section)
 * rather than directly to the job, because Brad's "I owe quotes"
 * mental loop usually involves looking at the full list before
 * picking which to start with. Cheaper than opening one and bailing.
 */
const QUOTES_TO_PREP_MAX_ROWS = 4;

// ── Section: Leads to contact ───────────────────────────────────────────────
//
// Uncontacted raw enquiries. Each row carries its own one-tap actions —
// Mark contacted (the primary), plus Call / Email shortcuts when we have
// the client's details. Tapping Mark contacted bumps lastContactedDate,
// which removes the row from the parent's `leadsToContact` filter, so it
// animates out and the user gets immediate, visible feedback (the fix for
// "I tapped Mark contacted and nothing happened").

function LeadsToContactSection({
  items, todayISO, onMarkContacted, onArrangeVisit, onSentQuote,
}: {
  items: Job[];
  todayISO: string;
  onMarkContacted: (jobId: string) => void;
  /** Primary action: opens the "site visit arranged?" prompt for this lead. */
  onArrangeVisit: (job: Job) => void;
  /** "Sent the quote" — opens MarkAsQuotedSheet for leads quoted directly
   *  (no site visit), e.g. commercial work priced off plans. */
  onSentQuote: (job: Job) => void;
}) {
  const shown = items.slice(0, LEADS_TO_CONTACT_MAX_ROWS);
  const overflow = items.length - shown.length;

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <SectionLabel className="mb-0">Leads to contact</SectionLabel>
        <Link href="/leads" className="text-xs font-medium text-primary hover:underline">
          See all
        </Link>
      </div>
      <ul className="space-y-2">
        {shown.map((job) => (
          <LeadToContactRow
            key={job.id}
            job={job}
            todayISO={todayISO}
            onMarkContacted={() => onMarkContacted(job.id)}
            onArrangeVisit={() => onArrangeVisit(job)}
            onSentQuote={() => onSentQuote(job)}
          />
        ))}
      </ul>
      {overflow > 0 && (
        <Link
          href="/leads"
          className="mt-2 flex items-center justify-center gap-1 h-10 rounded-xl border border-dashed border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
        >
          {overflow} more to contact — open leads
          <ChevronRight size={12} />
        </Link>
      )}
    </section>
  );
}

function LeadToContactRow({
  job, todayISO, onMarkContacted, onArrangeVisit, onSentQuote,
}: {
  job: Job;
  todayISO: string;
  onMarkContacted: () => void;
  /** Opens the "site visit arranged?" prompt — the primary action. */
  onArrangeVisit: () => void;
  /** Quote already went out (no visit needed) — opens MarkAsQuotedSheet. */
  onSentQuote: () => void;
}) {
  const waiting = daysWaiting(job.createdAt, todayISO);
  // Only show the waiting chip once a lead has aged at least a day — a
  // brand-new enquiry logged today doesn't need a nag badge.
  const waitingLabel = waiting >= 1
    ? `${waiting}d waiting`
    : null;
  // Tint the chip red once a lead has sat uncontacted for 2+ days — by
  // then a reply is genuinely overdue.
  const waitingUrgent = waiting >= 2;

  return (
    <li className="bg-card border border-border rounded-2xl overflow-hidden">
      <Link
        href="/leads"
        className="flex items-center gap-3 px-4 pt-3 pb-2 hover:bg-accent/40 transition-colors"
      >
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-blue-50">
          <UserPlus size={14} className="text-blue-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{job.name}</p>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {job.clientName}
          </p>
        </div>
        {waitingLabel && (
          <span
            className={cn(
              'shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide',
              waitingUrgent ? 'bg-red-50 text-red-700' : 'bg-muted text-muted-foreground',
            )}
          >
            {waitingLabel}
          </span>
        )}
        <ChevronRight size={14} className="text-muted-foreground shrink-0" />
      </Link>

      {/* Action row — Mark contacted is the primary, sized to the
          44px tap-target rule. Call / Email appear only when we have
          the detail. stopPropagation so tapping an action never also
          triggers the row's navigate-to-leads link. */}
      <div className="border-t border-border/60 px-2 py-1.5 flex items-center gap-1">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onArrangeVisit(); }}
          className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-xs font-semibold text-primary bg-primary/10 hover:bg-primary/15 active:scale-[0.98] transition-all"
          title="Mark contacted — asks if you arranged a site visit"
        >
          <MessageCircle size={14} strokeWidth={2} /> Mark contacted
        </button>
        {job.clientPhone && (
          <a
            href={`tel:${job.clientPhone}`}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-xs font-medium text-foreground hover:bg-accent transition-colors"
            title={`Call ${job.clientName}`}
          >
            <Phone size={13} strokeWidth={1.8} /> Call
          </a>
        )}
        {job.clientEmail && (
          <a
            href={gmailComposeUrl(job.clientEmail)}
            target="_blank"
            rel="noopener noreferrer"
            // Emailing IS contact — stamp it so the lead clears from this
            // list, same as the Mark contacted button. Opens Gmail compose
            // in a new tab; the row unmounts behind it.
            onClick={(e) => { e.stopPropagation(); onMarkContacted(); }}
            className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-xs font-medium text-foreground hover:bg-accent transition-colors"
            title={`Email ${job.clientName} in Gmail`}
          >
            <Mail size={13} strokeWidth={1.8} /> Email
          </a>
        )}
      </div>

      {/* "Sent the quote" — its own subtle row rather than a fourth
          button above (four labels don't fit a 380px viewport). For
          leads quoted directly with no site visit (commercial work
          priced off plans): one tap opens MarkAsQuotedSheet, saving
          flips the job to 'quoted' and this row clears for good. */}
      <div className="border-t border-border/60 px-2 py-1">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onSentQuote(); }}
          className="w-full min-h-[36px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Already sent this one a quote? Record it — moves the lead to 'Quoted, awaiting reply'"
        >
          <Send size={12} strokeWidth={1.8} /> Sent the quote already
        </button>
      </div>
    </li>
  );
}

function QuotesToPrepSection({ items }: { items: Job[] }) {
  const shown = items.slice(0, QUOTES_TO_PREP_MAX_ROWS);
  const overflow = items.length - shown.length;

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <SectionLabel className="mb-0">Quotes to prep</SectionLabel>
        <Link href="/leads" className="text-xs font-medium text-primary hover:underline">
          See all
        </Link>
      </div>
      <ul className="space-y-2">
        {shown.map((job) => (
          <QuotesToPrepRow key={job.id} job={job} />
        ))}
      </ul>
      {overflow > 0 && (
        <Link
          href="/leads"
          className="mt-2 flex items-center justify-center gap-1 h-10 rounded-xl border border-dashed border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
        >
          {overflow} more to quote — open leads
          <ChevronRight size={12} />
        </Link>
      )}
    </section>
  );
}

function QuotesToPrepRow({ job }: { job: Job }) {
  // Due-date label uses the same logic as the Leads page's chip so
  // the two surfaces feel consistent. Overdue / Today / Tomorrow /
  // weekday / date — short, scan-friendly.
  const dueLabel = job.quoteReadyBy ? friendlyQuoteDueLabel(job.quoteReadyBy) : null;
  const overdue = dueLabel?.startsWith('Overdue');

  return (
    <li>
      <Link
        href="/leads"
        className="bg-card border border-border rounded-2xl flex items-center gap-3 px-4 py-3 min-h-[48px] hover:border-primary/30 transition-colors"
      >
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-amber-50">
          <FileText size={14} className="text-amber-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{job.name}</p>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {job.clientName}
          </p>
        </div>
        {dueLabel && (
          <span
            className={cn(
              'shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide',
              overdue
                ? 'bg-red-50 text-red-700'
                : 'bg-amber-50 text-amber-700',
            )}
            title={`Quote-ready-by: ${job.quoteReadyBy}`}
          >
            {dueLabel}
          </span>
        )}
        <ChevronRight size={14} className="text-muted-foreground shrink-0" />
      </Link>
    </li>
  );
}

/**
 * Same date-formatting logic as the Leads page's formatDueDate. Kept
 * inline here so we don't have to thread a shared helper through —
 * the duplication is tiny (~10 lines) and the two formatters can
 * diverge later if Home wants a different style.
 */
function friendlyQuoteDueLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return `Overdue ${Math.abs(diffDays)}d`;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays < 7) return date.toLocaleDateString('en-NZ', { weekday: 'short' });
  return date.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
}

function ComingUpSection({
  items, todayISO,
}: {
  items: ScheduleItem[];
  todayISO: string;
}) {
  const shown = items.slice(0, COMING_UP_MAX_ROWS);
  const overflow = items.length - shown.length;

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <SectionLabel className="mb-0">Coming up</SectionLabel>
        <Link href="/schedule" className="text-xs font-medium text-primary hover:underline">
          See all
        </Link>
      </div>
      <ul className="space-y-2">
        {shown.map((s) => (
          <ComingUpRow key={s.id} item={s} todayISO={todayISO} />
        ))}
      </ul>
      {overflow > 0 && (
        <Link
          href="/schedule"
          className="mt-2 flex items-center justify-center gap-1 h-10 rounded-xl border border-dashed border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
        >
          {overflow} more this week — open schedule
          <ChevronRight size={12} />
        </Link>
      )}
    </section>
  );
}

function ComingUpRow({ item, todayISO }: { item: ScheduleItem; todayISO: string }) {
  const meta = SCHEDULE_TYPE_META[item.type] ?? SCHEDULE_TYPE_META.reminder;
  const Icon = meta.icon;

  return (
    <li className="bg-card border border-border rounded-2xl flex items-center gap-3 px-4 py-3 min-h-[48px]">
      <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', meta.bg)}>
        <Icon size={14} className={meta.color} strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
          {/* Date chip — same shape as TodayRow so the two sections share
              one visual grammar. Chip colour encodes type; text is the
              date (or 'TOMORROW' for the next-day case). */}
          <span className={cn(
            'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide',
            meta.bg, meta.color,
          )}>
            {chipDateLabel(item.date, todayISO)}
          </span>
          {item.startTime && <span>{item.startTime}{item.endTime ? `–${item.endTime}` : ''}</span>}
        </p>
      </div>
    </li>
  );
}

/**
 * Friendly relative day label. "Tomorrow" / "Wed" / "Fri 16" for items inside
 * the lookahead window. Keeps the row compact without losing context.
 */
function friendlyDayLabel(iso: string, todayISO: string): string {
  const tomorrowISO = formatISODate(addDays(parseISODate(todayISO), 1));
  if (iso === tomorrowISO) return 'Tomorrow';
  const d = parseISODate(iso);
  // Within ~7 days the weekday name is enough; add day-of-month past that
  // to avoid ambiguity (we never look further than 7 here but be defensive).
  return d.toLocaleDateString('en-NZ', { weekday: 'short' });
}

/**
 * Date label rendered inside the type-coloured chip on TodayRow / ComingUpRow.
 * Replaces the old static "JOB DAY" / "QUOTE VISIT" labels with the actual
 * date — chip colour still encodes type, the text now carries the when.
 *
 *   today    → "TODAY"
 *   tomorrow → "TOMORROW"
 *   else     → "MON 8 MAY"   (day-of-week + day-of-month + month, en-NZ)
 *
 * Returned upper-case because the chip uses `uppercase tracking-wide`; we
 * pre-uppercase the date so toLocaleDateString doesn't end up mixing
 * "Mon" with CSS-uppercased "MON" at different times.
 */
function chipDateLabel(iso: string, todayISO: string): string {
  if (iso === todayISO) return 'TODAY';
  const tomorrowISO = formatISODate(addDays(parseISODate(todayISO), 1));
  if (iso === tomorrowISO) return 'TOMORROW';
  const d = parseISODate(iso);
  return d.toLocaleDateString('en-NZ', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).toUpperCase();
}

// ── Section: Quick add ──────────────────────────────────────────────────────
// href-based (was entry-type-based) so non-entry destinations can live
// here too. Paint stock rides in this grid because it's NOT in the mobile
// bottom nav (that's at its 7-item limit per the note in bottom-nav.tsx)
// — this card is the phone's path to /stock.
const QUICK_ADD: { href: string; label: string; icon: React.ElementType; accent: string }[] = [
  { href: '/entry?type=hours',   label: 'Log hours',   icon: Clock,      accent: 'bg-blue-50 text-blue-600' },
  { href: '/entry?type=expense', label: 'Log expense', icon: Receipt,    accent: 'bg-red-50 text-red-600' },
  { href: '/entry?type=income',  label: 'Log income',  icon: DollarSign, accent: 'bg-green-50 text-green-600' },
  { href: '/stock',              label: 'Paint stock', icon: Paintbrush, accent: 'bg-purple-50 text-purple-600' },
];

function QuickAddSection() {
  return (
    <section>
      <SectionLabel>Quick add</SectionLabel>
      <div className="grid grid-cols-4 gap-2">
        {QUICK_ADD.map(({ href, label, icon: Icon, accent }) => (
          <Link
            key={href}
            href={href}
            className="flex flex-col items-center justify-center gap-1.5 p-2 rounded-2xl bg-card border border-border hover:border-primary/40 hover:bg-accent transition-colors min-h-[80px] active:scale-95"
          >
            <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center', accent)}>
              <Icon size={18} strokeWidth={1.8} />
            </div>
            <span className="text-xs font-medium text-foreground text-center leading-tight">{label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ── Misc ────────────────────────────────────────────────────────────────────
function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h2 className={cn('text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2', className)}>
      {children}
    </h2>
  );
}
