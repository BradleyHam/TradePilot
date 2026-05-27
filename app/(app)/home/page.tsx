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
import type { ScheduleItem, Invoice, Entry, Job, ActivityType, Material, JobImport, LostReason } from '@/lib/types';
import { SiteVisitWrapUpSheet, type WrapUpTarget } from '@/components/jobs/site-visit-wrap-up-sheet';

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
} from 'lucide-react';
import { cn } from '@/lib/utils';

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

// ── Money formatting ────────────────────────────────────────────────────────
function fmtMoney(n: number): string {
  // Round to whole dollars on dashboard tiles — cents are noise at a glance.
  const r = Math.round(n);
  return `$${r.toLocaleString('en-NZ')}`;
}

// ── Constants ───────────────────────────────────────────────────────────────
const HOURS_TARGET_PER_WEEK = 30; // flat target per Brad's call
const OVERDUE_INVOICE_DAYS = 14;  // unpaid > 14 days = overdue (no dueDate column)
const BILLS_DUE_LOOKAHEAD_DAYS = 7;
const COMING_UP_LOOKAHEAD_DAYS = 7;
const COMING_UP_MAX_ROWS = 6;

// ── Page ────────────────────────────────────────────────────────────────────
export default function HomePage() {
  const {
    entries, scheduleItems, invoices, jobs, jobImports, businessId,
    updateScheduleItem, updateEntry, markInvoicePaid, addEntry, deleteEntry,
    confirmBillDraftWithMaterials,
    commitImportAsLink, commitImportAsCreate, commitImportAsSkip,
  } = useStore();

  // Wrap-up sheet state. We hold the schedule_item id (not just a
  // jobId) because a quote_visit can be wrapped up even when it has
  // no linked job — in which case the wrap-up creates one. Computed
  // WrapUpTarget below decides which mode the sheet opens in.
  const [wrapUpScheduleItemId, setWrapUpScheduleItemId] = useState<string | null>(null);
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

  const showMoneyFlags = overdueInvoices.length > 0
    || billsDueSoon.length > 0
    || billDrafts.length > 0
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
      .filter((j) => {
        if (j.status !== 'lead') return false;
        return Boolean(
          j.scopeNotes
          || j.surfaceAreaM2
          || j.prepLevel
          || j.quoteReadyBy
          || (j.accessNotes && j.accessNotes.length > 0),
        );
      })
      .sort((a, b) => {
        const aDue = a.quoteReadyBy ?? '';
        const bDue = b.quoteReadyBy ?? '';
        if (aDue && bDue) return aDue.localeCompare(bDue);
        if (aDue) return -1;
        if (bDue) return 1;
        return 0;
      });
  }, [jobs]);

  // ── Render ──────────────────────────────────────────────────────────────
  const subtitle = parseISODate(todayISO).toLocaleDateString('en-NZ', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader title="This week" subtitle={subtitle} />

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
              description: fields.description.trim() || item.title,
              entryDate: todayISO,
              gstApplies: false,
              createdAt: new Date().toISOString(),
            });
          }}
        />

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

        {showMoneyFlags && (
          <MoneyFlagsCard
            overdueInvoices={overdueInvoices}
            billsDueSoon={billsDueSoon}
            billDrafts={billDrafts}
            jobImports={jobImports}
            jobs={jobs}
            todayISO={todayISO}
            onMarkInvoicePaid={(id, paidDate) => markInvoicePaid(id, paidDate)}
            onMarkBillPaid={(id, paidDate) => updateEntry(id, { paid: true, paidDate })}
            onConfirmDraft={(id, { jobId, materials }) =>
              void confirmBillDraftWithMaterials(id, { jobId, materials })
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
    </div>
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
  items, todayISO, onMarkDone, onLogHours, onOpenWrapUp,
}: {
  items: ScheduleItem[];
  todayISO: string;
  onMarkDone: (id: string) => void;
  onLogHours: (item: ScheduleItem, fields: LoggedHoursFields) => void;
  /** Tick handler for quote_visit rows with a linked job — opens the wrap-up. */
  onOpenWrapUp: (item: ScheduleItem) => void;
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
  quote_visit: { color: 'text-blue-600',   bg: 'bg-blue-50',   icon: FileText,    label: 'Quote visit' },
  follow_up:   { color: 'text-violet-600', bg: 'bg-violet-50', icon: Bell,        label: 'Follow-up' },
  bill_due:    { color: 'text-red-600',    bg: 'bg-red-50',    icon: AlertCircle, label: 'Bill due' },
  invoice_due: { color: 'text-amber-600',  bg: 'bg-amber-50',  icon: Receipt,     label: 'Invoice due' },
  reminder:    { color: 'text-slate-600',  bg: 'bg-slate-50',  icon: Bell,        label: 'Reminder' },
};

function TodayRow({
  item, todayISO, onMarkDone, onLogHours, onOpenWrapUp,
}: {
  item: ScheduleItem;
  todayISO: string;
  onMarkDone: (id: string) => void;
  onLogHours: (item: ScheduleItem, fields: LoggedHoursFields) => void;
  /** Tick handler for quote_visit rows. Falls back to onMarkDone if not provided. */
  onOpenWrapUp?: (item: ScheduleItem) => void;
}) {
  const meta = SCHEDULE_TYPE_META[item.type] ?? SCHEDULE_TYPE_META.reminder;
  const Icon = meta.icon;
  const overdue = item.date < todayISO;

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
  const isWrapUpVisit =
    item.type === 'quote_visit' && item.jobId != null && onOpenWrapUp != null;
  const tickOpensHoursForm = !isWrapUpVisit && item.jobId != null;

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
        <div className="flex items-center gap-3 flex-1 px-4 py-3 min-w-0">
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
              {/* Type chip — leads the meta row so "what is this?" lands
                  before time/overdue context. Colour matches the icon so
                  the row reads as a single coherent unit. */}
              <span className={cn(
                'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide',
                meta.bg, meta.color,
              )}>
                {meta.label}
              </span>
              {overdue && <span className="text-red-600 font-medium">Overdue</span>}
              {item.startTime && <span className="truncate">{item.startTime}{item.endTime ? `–${item.endTime}` : ''}</span>}
              {!item.startTime && !overdue && <span>Today</span>}
            </p>
          </div>
        </div>
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
  overdueInvoices, billsDueSoon, billDrafts, jobImports, jobs, todayISO,
  onMarkInvoicePaid, onMarkBillPaid, onConfirmDraft, onDeleteDraft,
  onCommitImportAsLink, onCommitImportAsCreate, onCommitImportAsSkip,
}: {
  overdueInvoices: Invoice[];
  billsDueSoon: Entry[];
  billDrafts: Entry[];
  jobImports: JobImport[];
  jobs: Job[];
  todayISO: string;
  onMarkInvoicePaid: (invoiceId: string, paidDate: string) => void;
  onMarkBillPaid: (entryId: string, paidDate: string) => void;
  onConfirmDraft: (entryId: string, payload: { jobId: string | null; materials: MaterialInit[] }) => void;
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
            todayISO={todayISO}
            onMarkPaid={onMarkBillPaid}
          />
        )}
      </div>
    </section>
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
function BillsDueFlag({
  bills, todayISO, onMarkPaid,
}: {
  bills: Entry[];
  todayISO: string;
  onMarkPaid: (id: string, paidDate: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const total = bills.reduce((s, b) => s + billExGst(b), 0);

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
      return `${bills.length} bill${bills.length === 1 ? '' : 's'} due ${labelFor(bills[0].dueDate!)}`;
    }
    return `${bills.length} bill${bills.length === 1 ? '' : 's'} due in ${BILLS_DUE_LOOKAHEAD_DAYS} days`;
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
          {bills.map((b) => (
            <li
              key={b.id}
              className="bg-card border border-border rounded-xl flex items-center gap-3 px-3 py-2 min-h-[56px]"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">
                    {b.company ?? b.supplier ?? b.description ?? 'Bill'}
                  </p>
                  <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">
                    {fmtMoney(billExGst(b))}
                  </span>
                </div>
                {b.description && b.company && (
                  <p className="text-xs text-muted-foreground truncate">{b.description}</p>
                )}
                <p className="text-xs text-amber-700 font-medium mt-0.5">
                  Due {b.dueDate ? fmtDueDate(b.dueDate) : '—'}
                </p>
              </div>
              <MarkPaidControl
                todayISO={todayISO}
                onConfirm={(paidDate) => onMarkPaid(b.id, paidDate)}
              />
            </li>
          ))}
        </ul>
      )}
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

function BillsToConfirmFlag({
  drafts, jobs, onConfirm, onDelete,
}: {
  drafts: Entry[];
  jobs: Job[];
  onConfirm: (entryId: string, payload: { jobId: string | null; materials: MaterialInit[] }) => void;
  onDelete: (entryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Total ex-GST across all drafts. Useful as the "if I confirm all of
  // these, my books grow by X" preview at a glance.
  const total = drafts.reduce((s, d) => s + billExGst(d), 0);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-accent transition-colors text-left"
      >
        <div className="w-8 h-8 rounded-xl bg-orange-50 flex items-center justify-center shrink-0">
          <FilePlus size={16} className="text-orange-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {drafts.length} bill{drafts.length === 1 ? '' : 's'} to confirm
          </p>
          <p className="text-xs text-muted-foreground">
            From PDF · {fmtMoney(total)} ex-GST
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
          {drafts.map((d) => (
            <DraftBillRow
              key={d.id}
              draft={d}
              jobs={jobs}
              onConfirm={onConfirm}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// Per-line allocation value. '' = use bill's job (or overhead if the bill
// picker itself is on overhead — we resolve at submit time). 'skip' = don't
// create a material row for this line. Any other string = a job UUID for
// per-line override.
type LineAlloc = '' | 'skip' | string;

// Shape of a parsed line item we accept from parserRaw. The LLM may emit
// loose JSON; we narrow defensively before reading fields.
interface ParsedLineItem {
  description?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  total?: unknown;
}

function DraftBillRow({
  draft, jobs, onConfirm, onDelete,
}: {
  draft: Entry;
  jobs: Job[];
  onConfirm: (entryId: string, payload: { jobId: string | null; materials: MaterialInit[] }) => void;
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
  const parserRaw = draft.parserRaw as
    { jobHint?: string; dueDateSource?: 'pdf' | 'computed' | 'manual'; lineItems?: unknown } | null;
  const hint = parserRaw?.jobHint;
  const dueDateSource = parserRaw?.dueDateSource;
  const ranked = useMemo(() => rankJobs(jobs, hint), [jobs, hint]);

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
        alloc === '' ? (billJobId ?? undefined) : alloc;
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

    onConfirm(draft.id, { jobId: billJobId, materials });
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
            {draft.dueDate && (
              <>
                <span>{draft.paymentRef ? ' · ' : ''}Due {fmtDueDate(draft.dueDate)}</span>
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

      {/* Job picker — best matches float to the top via rankJobs */}
      <div>
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
          Allocate to job
        </label>
        <select
          value={pickedJobId}
          onChange={(e) => setPickedJobId(e.target.value)}
          className="w-full h-10 px-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">Overhead (no job)</option>
          {ranked.map(({ job, tier }) => (
            <option key={job.id} value={job.id}>
              {tier === 'active-match' ? '★ ' : ''}
              {job.name}
              {job.clientName ? ` — ${job.clientName}` : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Per-line allocation — only shown when the parser found line items.
          Each line gets its own select so a single bill can split across
          jobs (e.g. 3 cans for McLeod + 1 for Aubrey + a levy to skip).
          Default for cost-bearing lines is '' (follow the bill picker);
          default for cost-less lines is 'skip' (don't pollute materials). */}
      {lineItems.length > 0 && (
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
                  <select
                    value={alloc}
                    onChange={(e) => setLineAlloc(i, e.target.value as LineAlloc)}
                    className="w-full h-9 px-2 rounded-md border border-input bg-card text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                    aria-label={`Allocate line item ${i + 1}`}
                  >
                    <option value="">Use bill's job</option>
                    <option value="skip">Skip — don't track</option>
                    <optgroup label="Or pick a different job">
                      {ranked.map(({ job, tier }) => (
                        <option key={job.id} value={job.id}>
                          {tier === 'active-match' ? '★ ' : ''}
                          {job.name}
                          {job.clientName ? ` — ${job.clientName}` : ''}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </li>
              );
            })}
          </ul>
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
  const dateLabel = friendlyDayLabel(item.date, todayISO);

  return (
    <li className="bg-card border border-border rounded-2xl flex items-center gap-3 px-4 py-3 min-h-[48px]">
      <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', meta.bg)}>
        <Icon size={14} className={meta.color} strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
          {/* Same type chip as TodayRow — keeps the two sections visually
              consistent so the eye learns the labels once, then reads
              the rest of the row faster. */}
          <span className={cn(
            'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide',
            meta.bg, meta.color,
          )}>
            {meta.label}
          </span>
          <span>{dateLabel}</span>
          {item.startTime && <span>· {item.startTime}{item.endTime ? `–${item.endTime}` : ''}</span>}
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

// ── Section: Quick add ──────────────────────────────────────────────────────
const QUICK_ADD: { type: 'hours' | 'expense' | 'income'; label: string; icon: React.ElementType; accent: string }[] = [
  { type: 'hours',   label: 'Log hours',   icon: Clock,      accent: 'bg-blue-50 text-blue-600' },
  { type: 'expense', label: 'Log expense', icon: Receipt,    accent: 'bg-red-50 text-red-600' },
  { type: 'income',  label: 'Log income',  icon: DollarSign, accent: 'bg-green-50 text-green-600' },
];

function QuickAddSection() {
  return (
    <section>
      <SectionLabel>Quick add</SectionLabel>
      <div className="grid grid-cols-3 gap-2">
        {QUICK_ADD.map(({ type, label, icon: Icon, accent }) => (
          <Link
            key={type}
            href={`/entry?type=${type}`}
            className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-2xl bg-card border border-border hover:border-primary/40 hover:bg-accent transition-colors min-h-[80px] active:scale-95"
          >
            <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center', accent)}>
              <Icon size={18} strokeWidth={1.8} />
            </div>
            <span className="text-xs font-medium text-foreground">{label}</span>
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
