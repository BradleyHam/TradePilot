'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useStore } from '@/lib/store';
import { Job, ScheduleItem, ScheduleItemType, Entry, ScheduleSkipReasonKind } from '@/lib/types';
import { rankJobs } from '@/lib/job-match';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { EntryForm } from '@/components/entry/entry-form';
import { EditScheduleItemSheet, ScheduleEditTarget } from '@/components/schedule/edit-schedule-item-sheet';
import { SiteVisitWrapUpSheet, type WrapUpTarget } from '@/components/jobs/site-visit-wrap-up-sheet';
import { MarkAsQuotedSheet } from '@/components/jobs/mark-as-quoted-sheet';
import { VisitActionChooser } from '@/components/schedule/visit-action-chooser';
import { downloadIcs } from '@/lib/ics';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  CalendarDays, Plus, Briefcase, FileText, Bell, AlertCircle, Receipt, CheckCircle2,
  ChevronLeft, ChevronRight, List as ListIcon, Calendar as CalendarIcon, LayoutGrid,
  Clock, CloudRain, Stethoscope, UserX, MoreHorizontal,
} from 'lucide-react';
import {
  format, parseISO, isToday, isTomorrow, isPast, isThisWeek,
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, addMonths, addWeeks,
  isSameMonth, eachDayOfInterval,
} from 'date-fns';
import { cn } from '@/lib/utils';

// ── Local helpers ────────────────────────────────────────────────────────────
// ISO date helpers that stay in local time so a 1 May–3 May range doesn't drift
// because of UTC. Same shape as schedule's existing helpers.
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
function datesBetween(startISO: string, endISO: string): string[] {
  const start = parseISODate(startISO);
  const end = parseISODate(endISO);
  if (end < start) return [startISO];
  const out: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    out.push(formatISODate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

function FormInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    />
  );
}

const TYPE_CONFIG: Record<ScheduleItemType, { label: string; icon: React.ElementType; color: string; bg: string; ring: string; bar: string }> = {
  job_booking:  { label: 'Job',       icon: Briefcase,   color: 'text-orange-600', bg: 'bg-orange-50', ring: 'ring-orange-200', bar: 'bg-orange-500' },
  quote_visit:  { label: 'Quote',     icon: FileText,    color: 'text-blue-600',   bg: 'bg-blue-50',   ring: 'ring-blue-200',   bar: 'bg-blue-500' },
  follow_up:    { label: 'Follow up', icon: Bell,        color: 'text-violet-600', bg: 'bg-violet-50', ring: 'ring-violet-200', bar: 'bg-violet-500' },
  bill_due:     { label: 'Bill due',  icon: AlertCircle, color: 'text-red-500',    bg: 'bg-red-50',    ring: 'ring-red-200',    bar: 'bg-red-500' },
  invoice_due:  { label: 'Invoice',   icon: Receipt,     color: 'text-amber-600',  bg: 'bg-amber-50',  ring: 'ring-amber-200',  bar: 'bg-amber-500' },
  reminder:     { label: 'Reminder',  icon: Bell,        color: 'text-slate-600',  bg: 'bg-slate-50',  ring: 'ring-slate-200',  bar: 'bg-slate-400' },
};

// ── Skip-reason metadata (migration 020) ────────────────────────────────────
// User-facing labels for the "Didn't work" picker chips and the chip rendered
// on the day's RunCard afterwards. Source-of-truth list is the union type
// ScheduleSkipReasonKind in lib/types.ts.
const SKIP_REASON_LABELS: Record<ScheduleSkipReasonKind, string> = {
  rained_off:       'Rained off',
  sick:             'Sick',
  client_postponed: 'Client postponed',
  other:            'Other',
};
const SKIP_REASON_ICONS: Record<ScheduleSkipReasonKind, React.ElementType> = {
  rained_off:       CloudRain,
  sick:             Stethoscope,
  client_postponed: UserX,
  other:            MoreHorizontal,
};
// Render order for the picker — most-common first so the eye lands on
// the most likely choice without scanning.
const SKIP_REASON_ORDER: ScheduleSkipReasonKind[] = [
  'rained_off', 'sick', 'client_postponed', 'other',
];

/**
 * Narrow a string from a query param to a valid ScheduleItemType. Used
 * to validate the ?quickAdd= deep link before pre-selecting it in the
 * add sheet — protects against junk values in URLs.
 */
function isScheduleItemType(s: string): s is ScheduleItemType {
  return s in TYPE_CONFIG;
}

// ── Per-job colour palette ───────────────────────────────────────────────────
// In Month/Week view we want each *job* to be visually distinguishable, not
// just each schedule-item type — otherwise every job_booking is orange and
// you can't tell two concurrent jobs apart at a glance. We map jobId → one
// of these saturated Tailwind shades using a stable hash so the same job
// always gets the same colour across renders.
//
// All classes are written as full literals so Tailwind's JIT can pick them up.
// Each entry has a `bar` (solid, white text reads on it) and a matching `text`
// (used for the small DayChip border-left + icon when a job is associated).
// Each palette entry has three faces:
//   bar      — saturated fill used by *plan* bars (schedule_items).
//   text     — coloured text used on light backgrounds.
//   bgLight  — lighter tinted fill, used by *actuals* bars (hours entries
//              with no matching schedule item) so plan vs actuals reads
//              differently at a glance.
//
// All classes are written as literals so Tailwind's JIT picks them up.
const JOB_PALETTE: { bar: string; text: string; bgLight: string }[] = [
  { bar: 'bg-orange-500',  text: 'text-orange-700',  bgLight: 'bg-orange-100'  },
  { bar: 'bg-blue-500',    text: 'text-blue-700',    bgLight: 'bg-blue-100'    },
  { bar: 'bg-emerald-500', text: 'text-emerald-700', bgLight: 'bg-emerald-100' },
  { bar: 'bg-violet-500',  text: 'text-violet-700',  bgLight: 'bg-violet-100'  },
  { bar: 'bg-pink-500',    text: 'text-pink-700',    bgLight: 'bg-pink-100'    },
  { bar: 'bg-amber-500',   text: 'text-amber-700',   bgLight: 'bg-amber-100'   },
  { bar: 'bg-cyan-500',    text: 'text-cyan-700',    bgLight: 'bg-cyan-100'    },
  { bar: 'bg-rose-500',    text: 'text-rose-700',    bgLight: 'bg-rose-100'    },
  { bar: 'bg-lime-600',    text: 'text-lime-700',    bgLight: 'bg-lime-100'    },
  { bar: 'bg-indigo-500',  text: 'text-indigo-700',  bgLight: 'bg-indigo-100'  },
  { bar: 'bg-teal-500',    text: 'text-teal-700',    bgLight: 'bg-teal-100'    },
  { bar: 'bg-fuchsia-500', text: 'text-fuchsia-700', bgLight: 'bg-fuchsia-100' },
];

/**
 * Stable string hash → palette index. Same jobId always returns the same
 * colour. djb2-ish; we don't need cryptographic strength, just a good spread.
 */
function paletteIndexFor(key: string): number {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash) + key.charCodeAt(i);
    hash |= 0; // keep 32-bit
  }
  return Math.abs(hash) % JOB_PALETTE.length;
}

/**
 * Returns the bar/text colour set for a schedule item.
 * - If the item is tied to a job, picks a per-job colour from JOB_PALETTE.
 * - Otherwise falls back to the type-based colour (so bills stay red,
 *   reminders stay slate, etc). Type-based items don't have a bgLight
 *   variant — they only show up as plan bars, so we just stub it.
 */
function colorFor(item: ScheduleItem): { bar: string; text: string; bgLight: string } {
  if (item.jobId) {
    const p = JOB_PALETTE[paletteIndexFor(item.jobId)];
    return p;
  }
  const cfg = TYPE_CONFIG[item.type];
  return { bar: cfg.bar, text: cfg.color, bgLight: cfg.bg };
}

/** Same per-job palette resolution but for an arbitrary jobId (used by hours bars). */
function colorForJobId(jobId: string): { bar: string; text: string; bgLight: string } {
  return JOB_PALETTE[paletteIndexFor(jobId)];
}

// ── Filter chips ─────────────────────────────────────────────────────────────
type TypeFilter = 'all' | ScheduleItemType;
const TYPE_FILTERS: { label: string; value: TypeFilter }[] = [
  { label: 'All',         value: 'all' },
  { label: 'Jobs',        value: 'job_booking' },
  { label: 'Quotes',      value: 'quote_visit' },
  { label: 'Bills',       value: 'bill_due' },
  { label: 'Invoices',    value: 'invoice_due' },
  { label: 'Follow-ups',  value: 'follow_up' },
  { label: 'Reminders',   value: 'reminder' },
];

// ── View toggle ──────────────────────────────────────────────────────────────
type ViewMode = 'list' | 'week' | 'month';
const VIEW_OPTIONS: { value: ViewMode; label: string; icon: React.ElementType }[] = [
  { value: 'list',  label: 'List',  icon: ListIcon },
  { value: 'week',  label: 'Week',  icon: CalendarIcon },
  { value: 'month', label: 'Month', icon: LayoutGrid },
];

const VIEW_STORAGE_KEY = 'schedule.view';

// Lazy initializer for the view mode. SSR-safe — returns 'list' if window
// isn't available, which is fine because this is a 'use client' component
// and the first client render will use the real value.
function readInitialView(): ViewMode {
  if (typeof window === 'undefined') return 'list';
  try {
    const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (saved === 'list' || saved === 'week' || saved === 'month') return saved;
    if (window.matchMedia('(min-width: 768px)').matches) return 'month';
  } catch {
    // localStorage / matchMedia can throw in privacy modes — keep default.
  }
  return 'list';
}

// ── Multi-day grouping ───────────────────────────────────────────────────────
// A "run" is a sequence of schedule items that:
//   - share the same jobId (or both have no jobId)
//   - share the same type
//   - cover consecutive calendar days (no gaps)
// The first detected run is rendered as a single card showing the date range.
// Bills/invoices are excluded — those are point-in-time, not multi-day work.
interface ItemRun {
  /** First item in the run, used as the "representative" for icon/title/etc. */
  head: ScheduleItem;
  /** All items in the run, in date order. */
  items: ScheduleItem[];
  /** ISO start/end dates. */
  startDate: string;
  endDate: string;
  /** Total span in days. 1 = single-day. */
  days: number;
  /** True if every item in the run is marked completed. */
  allCompleted: boolean;
}

function groupRuns(items: ScheduleItem[]): ItemRun[] {
  // Items must already be sorted by date asc. We group by (jobId, type) into
  // candidate buckets, then within each bucket walk forward and split whenever
  // there's a calendar gap.
  const RUN_TYPES: ScheduleItemType[] = ['job_booking', 'quote_visit', 'reminder'];
  const buckets = new Map<string, ScheduleItem[]>();
  const passthrough: ScheduleItem[] = [];

  for (const item of items) {
    if (!RUN_TYPES.includes(item.type)) {
      passthrough.push(item);
      continue;
    }
    const key = `${item.type}::${item.jobId ?? '_'}::${stripDayLabel(item.title)}`;
    const arr = buckets.get(key) ?? [];
    arr.push(item);
    buckets.set(key, arr);
  }

  const runs: ItemRun[] = [];

  for (const arr of buckets.values()) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
    let current: ScheduleItem[] = [];
    for (const item of arr) {
      if (current.length === 0) {
        current.push(item);
        continue;
      }
      const prev = current[current.length - 1];
      const prevDate = parseISODate(prev.date);
      const nextDay = new Date(prevDate);
      nextDay.setDate(prevDate.getDate() + 1);
      if (formatISODate(nextDay) === item.date) {
        current.push(item);
      } else {
        runs.push(makeRun(current));
        current = [item];
      }
    }
    if (current.length > 0) runs.push(makeRun(current));
  }

  for (const item of passthrough) {
    runs.push({
      head: item,
      items: [item],
      startDate: item.date,
      endDate: item.date,
      days: 1,
      allCompleted: item.completed,
    });
  }

  // Sort: by start date asc, with single-day items respecting their own date.
  runs.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return runs;
}

/** Strips a trailing " (Day N/M)" suffix so all days of a job booking group together. */
function stripDayLabel(title: string): string {
  return title.replace(/\s*\(Day\s+\d+\s*\/\s*\d+\s*\)\s*$/i, '').trim();
}

function makeRun(items: ScheduleItem[]): ItemRun {
  return {
    head: items[0],
    items,
    startDate: items[0].date,
    endDate: items[items.length - 1].date,
    days: items.length,
    allCompleted: items.every((i) => i.completed),
  };
}

// ── Date group label for List view ───────────────────────────────────────────
function dateGroup(dateStr: string): string {
  const date = parseISO(dateStr);
  if (isToday(date)) return 'Today';
  if (isTomorrow(date)) return 'Tomorrow';
  if (isThisWeek(date, { weekStartsOn: 1 })) return format(date, 'EEEE');
  return format(date, 'd MMM yyyy');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function SchedulePage() {
  const {
    scheduleItems, jobs, entries,
    addScheduleItem, updateScheduleItem, addEntry, updateEntry, deleteEntry,
    businessId,
  } = useStore();

  // Single edit-sheet target shared by all views. Holds the id of the hours
  // entry currently being edited, or null when the sheet is closed.
  const [editingHoursId, setEditingHoursId] = useState<string | null>(null);
  const editingHours = editingHoursId ? entries.find((e) => e.id === editingHoursId) : null;

  // Edit-schedule sheet: opened when the user taps any schedule item (list
  // card, week chip, or month bar). The target carries the run so the sheet
  // can do range editing in one shot. Storing item IDs (not the items
  // themselves) lets us re-resolve to the live store rows on each render —
  // avoids the stale-prop trap (see CLAUDE.md "Gotchas").
  const [editingItemIds, setEditingItemIds] = useState<string[] | null>(null);
  const editingTarget: ScheduleEditTarget | null = useMemo(() => {
    if (!editingItemIds || editingItemIds.length === 0) return null;
    const items = editingItemIds
      .map((id) => scheduleItems.find((s) => s.id === id))
      .filter((s): s is NonNullable<typeof s> => !!s);
    return items.length > 0 ? { items } : null;
  }, [editingItemIds, scheduleItems]);

  // Chooser state — when set, the user tapped the body of a quote_visit
  // RunCard and we're showing the Wrap up / Edit chooser. The items
  // are remembered so whichever branch the user picks can open with
  // the same row context.
  const [chooserItems, setChooserItems] = useState<ScheduleItem[] | null>(null);

  // Skip picker state — set to the schedule_item id when the user taps
  // "Didn't work" on any RunCard. Storing the id (not the row) so we
  // always re-read the latest version from the store on render.
  const [skippingItemId, setSkippingItemId] = useState<string | null>(null);
  const skippingItem = useMemo(
    () => skippingItemId ? scheduleItems.find((s) => s.id === skippingItemId) : null,
    [skippingItemId, scheduleItems],
  );

  function handleSkip(item: ScheduleItem) {
    setSkippingItemId(item.id);
  }

  function handleUnskip(item: ScheduleItem) {
    // Pass undefined (not null) on both columns so the mapper clears them
    // via the `|| null` branch. Bumps the row back to a plain scheduled
    // state — the user can then tick it complete or leave it for later.
    updateScheduleItem(item.id, {
      skipReasonKind: undefined,
      skipReason: undefined,
    });
  }

  function commitSkip(kind: ScheduleSkipReasonKind, note: string) {
    if (!skippingItemId) return;
    updateScheduleItem(skippingItemId, {
      skipReasonKind: kind,
      // Persist note only when there's something there. For 'other' the
      // form requires a note; for other kinds it's optional context.
      skipReason: note.trim() || undefined,
    });
    setSkippingItemId(null);
  }

  function openEdit(items: ScheduleItem[]) {
    // Quote visits get a fork: tapping the row is ambiguous between
    // "I want to wrap up the visit" and "I want to fix the schedule
    // details", so we show a chooser. Other types skip straight to
    // the edit sheet — their row tap has no ambiguity.
    if (items.length > 0 && items[0].type === 'quote_visit') {
      setChooserItems(items);
      return;
    }
    setEditingItemIds(items.map((i) => i.id));
  }

  // Hours entries are surfaced inside the schedule (not as schedule_items) so
  // that backdated work shows up on the day it was actually done. Keep just
  // the type='hours' entries — they're the ones a tired painter would scrub
  // back through the calendar to find ("what did I do last Tuesday?").
  const hoursEntries = useMemo(
    () => entries.filter((e) => e.type === 'hours' && e.entryDate),
    [entries],
  );

  const hoursByDate = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of hoursEntries) {
      const arr = map.get(e.entryDate) ?? [];
      arr.push(e);
      map.set(e.entryDate, arr);
    }
    return map;
  }, [hoursEntries]);
  // Deep-link support: ?quickAdd=quote_visit auto-opens the add sheet
  // with the type pre-selected. Used by the Entry-page "Schedule a site
  // visit" tile so the user lands here with the form already open.
  // Lazy initializer (runs once on mount) — we don't want the sheet
  // to keep reopening on every query-param-touching render.
  const searchParams = useSearchParams();
  const [showAdd, setShowAdd] = useState<boolean>(() => searchParams.get('quickAdd') != null);
  const [initialAddType, setInitialAddType] = useState<ScheduleItemType | undefined>(() => {
    const q = searchParams.get('quickAdd');
    return (q && isScheduleItemType(q)) ? q : undefined;
  });
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  // After saving a quote_visit, surface an "Add to calendar" prompt so the
  // user can hand off reminders to their phone's native calendar app.
  // Holds enough info to build the .ics — we don't keep the schedule_item
  // id because the freshly-added items aren't in the store yet at the
  // moment we render the prompt.
  const [savedQuoteVisit, setSavedQuoteVisit] = useState<null | {
    /**
     * The schedule_item ID we just created. Held so we can flip
     * icsDownloaded=true on it if the user accepts the download prompt
     * — without it we'd have no way to identify the right row.
     */
    scheduleItemId: string;
    title: string;
    date: string;       // YYYY-MM-DD
    startTime?: string; // HH:mm
    endTime?: string;
    location?: string;
    notes?: string;
  }>(null);

  // Wrap-up sheet state. Holds a list of schedule_item ids (usually
  // one, occasionally a multi-day run) so we can mark them all done
  // on save. The WrapUpTarget for the sheet is computed from the
  // "head" item — existing-job mode if it has a jobId, otherwise
  // create-from-visit so the sheet can mint a new lead.
  const [wrapUpScheduleItemIds, setWrapUpScheduleItemIds] = useState<string[] | null>(null);

  // After a successful wrap-up we immediately offer to mark the quote
  // as sent — that's the natural "what happens next" for a site visit.
  // Storing the jobId (not the Job row) so we re-read it from the store
  // on each render and don't trap a stale snapshot.
  const [pendingQuoteJobId, setPendingQuoteJobId] = useState<string | null>(null);
  const pendingQuoteJob = useMemo(
    () => pendingQuoteJobId ? jobs.find((j) => j.id === pendingQuoteJobId) ?? null : null,
    [pendingQuoteJobId, jobs],
  );
  const wrapUpHead = wrapUpScheduleItemIds && wrapUpScheduleItemIds.length > 0
    ? scheduleItems.find((s) => s.id === wrapUpScheduleItemIds[0]) ?? null
    : null;
  // Memoised so the WrapUpTarget identity is stable across unrelated
  // re-renders. Without this the wrap-up sheet's hydration effect
  // re-fires on every store update and clears any staged photos/plans
  // the user is in the middle of queueing. See lib/store.tsx — store
  // updates are chatty enough that this would happen on every change.
  const wrapUpTarget = useMemo<WrapUpTarget | null>(() => {
    if (!wrapUpHead) return null;
    if (wrapUpHead.jobId) {
      const linkedJob = jobs.find((j) => j.id === wrapUpHead.jobId);
      if (linkedJob) return { mode: 'existing-job', job: linkedJob };
    }
    return {
      mode: 'create-from-visit',
      visitTitle: wrapUpHead.title,
      visitNotes: wrapUpHead.notes,
    };
  }, [wrapUpHead, jobs]);

  // View mode: phone-first default (list on narrow viewports, month on desktop).
  // Lazy initializer runs once on mount in this `use client` page. It reads the
  // saved choice from localStorage, otherwise picks by viewport width.
  const [view, setView] = useState<ViewMode>(() => readInitialView());
  function changeView(next: ViewMode) {
    setView(next);
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, next); } catch {}
  }

  const filteredAll = useMemo(() => {
    return scheduleItems.filter((s) => typeFilter === 'all' ? true : s.type === typeFilter);
  }, [scheduleItems, typeFilter]);

  const upcomingItems = useMemo(() => {
    return [...filteredAll]
      .filter((s) => !s.completed)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredAll]);

  const upcomingRuns = useMemo(() => groupRuns(upcomingItems), [upcomingItems]);

  const completedRuns = useMemo(() => {
    const completed = [...filteredAll]
      .filter((s) => s.completed)
      .sort((a, b) => a.date.localeCompare(b.date));
    const runs = groupRuns(completed);
    // Most-recent first, top 5.
    return runs.sort((a, b) => b.endDate.localeCompare(a.endDate)).slice(0, 5);
  }, [filteredAll]);

  function handleComplete(run: ItemRun) {
    // Quote visits open the wrap-up sheet instead of ticking
    // immediately — the wrap-up's onSaved completes the items for us.
    // Works whether or not the visit has a linked job (no-job visits
    // create one on save). Cancelled wrap-up leaves the row
    // uncompleted so Brad knows he still owes a write-up.
    if (run.head.type === 'quote_visit') {
      setWrapUpScheduleItemIds(run.items.map((it) => it.id));
      return;
    }
    // Default behaviour for everything else: mark every item in the
    // run completed. Single-day items just flip one row.
    for (const it of run.items) {
      if (!it.completed) updateScheduleItem(it.id, { completed: true });
    }
  }

  function handleAdd(items: Omit<ScheduleItem, 'id' | 'businessId' | 'createdAt'>[]) {
    // Use real UUIDs from the start. schedule_items.id is a `uuid` column
    // in Supabase — if we generate a "sch_<timestamp>" string here and let
    // the store insert it, Supabase rejects updates that race ahead of
    // the insert's id-swap because the temp id isn't valid uuid syntax
    // (Postgres 22P02). Generating a uuid client-side means the id is
    // the same locally and remotely, no swap needed, no race window.
    // Track the ids as we go so we can hand the quote_visit's id to the
    // post-save prompt for later icsDownloaded flagging.
    const idsByIndex: string[] = [];
    items.forEach((data, i) => {
      const id = crypto.randomUUID();
      idsByIndex[i] = id;
      addScheduleItem({
        id,
        businessId: businessId ?? '',
        createdAt: new Date().toISOString(),
        ...data,
      });
    });
    setShowAdd(false);

    // Surface the calendar-invite prompt for quote_visit items. We only
    // offer it for the first matching item — multi-day quote visits are
    // rare in practice (a site visit is typically a one-hour drop-in),
    // and bombarding the user with N download prompts would be worse
    // than slightly under-serving the edge case.
    const firstVisitIndex = items.findIndex((it) => it.type === 'quote_visit');
    if (firstVisitIndex >= 0) {
      const firstVisit = items[firstVisitIndex];
      // Try to fill location from the linked job if the user didn't type one.
      // Most site visits ARE the job's location, so this is a sensible default.
      const linkedJob = firstVisit.jobId
        ? jobs.find((j) => j.id === firstVisit.jobId)
        : undefined;
      setSavedQuoteVisit({
        scheduleItemId: idsByIndex[firstVisitIndex],
        title: firstVisit.title || 'Site visit',
        date: firstVisit.date,
        startTime: firstVisit.startTime,
        endTime: firstVisit.endTime,
        location: linkedJob?.location ?? undefined,
        notes: firstVisit.notes,
      });
    }
  }

  /**
   * Build the .ics for the just-saved quote_visit and trigger a download.
   * Falls back to a sensible default start time (9am) if the user didn't
   * enter one — better than refusing to generate the file at all.
   */
  function handleDownloadVisitIcs() {
    if (!savedQuoteVisit) return;
    const [hh, mm] = (savedQuoteVisit.startTime ?? '09:00').split(':').map(Number);
    const [eh, em] = (savedQuoteVisit.endTime ?? '').split(':').map(Number);
    const [y, m, d] = savedQuoteVisit.date.split('-').map(Number);
    const start = new Date(y, m - 1, d, hh, mm);
    const end = Number.isFinite(eh) && Number.isFinite(em)
      ? new Date(y, m - 1, d, eh, em)
      : undefined;
    downloadIcs({
      // Pass the schedule_item id as the .ics UID so re-downloading later
      // updates the existing calendar event rather than spawning a copy —
      // matters if the user re-imports after a time change.
      uid: `${savedQuoteVisit.scheduleItemId}@tradepilot`,
      title: savedQuoteVisit.title,
      start,
      end,
      location: savedQuoteVisit.location,
      description: savedQuoteVisit.notes,
    });
    // Flag the row so the schedule list can render the "Reminders set"
    // badge. Optimistic — the store mutator rolls back on Supabase failure,
    // so on the rare network error the badge would just snap back to
    // "Add to calendar" on next render. That's the right behaviour.
    updateScheduleItem(savedQuoteVisit.scheduleItemId, { icsDownloaded: true });
    setSavedQuoteVisit(null);
  }

  /**
   * Re-download the .ics for an *existing* quote_visit row. Hooked up to
   * the "Add to calendar" badge on schedule rows whose icsDownloaded
   * flag is false (or who lost their downloaded file). Sets the flag
   * after a successful download so the badge flips to "Reminders set".
   *
   * Pulled out into a callback so it can be passed cleanly down through
   * ListView / WeekView / MonthView without each of them needing to
   * know about the .ics shape.
   */
  function handleAddItemToCalendar(item: ScheduleItem) {
    const [y, m, d] = item.date.split('-').map(Number);
    const [hh, mm] = (item.startTime ?? '09:00').split(':').map(Number);
    const start = new Date(y, m - 1, d, hh, mm);
    let end: Date | undefined;
    if (item.endTime) {
      const [eh, em] = item.endTime.split(':').map(Number);
      end = new Date(y, m - 1, d, eh, em);
    }
    // Prefer the linked job's location if the schedule item didn't
    // capture one of its own — same fallback as the post-save flow.
    const linkedJob = item.jobId ? jobs.find((j) => j.id === item.jobId) : undefined;
    downloadIcs({
      uid: `${item.id}@tradepilot`,
      title: item.title || 'Site visit',
      start,
      end,
      location: linkedJob?.location,
      description: item.notes,
    });
    updateScheduleItem(item.id, { icsDownloaded: true });
  }

  // Used by the month view's day-detail sheet when the user logs hours
  // directly against a tapped past/today date. Mirrors the entry page's
  // handleFormSave so the entry shape stays consistent across the app.
  function handleAddEntry(data: Omit<Entry, 'id' | 'businessId' | 'createdAt'>) {
    addEntry({
      id: `ent_${Date.now()}`,
      businessId: businessId ?? '',
      createdAt: new Date().toISOString(),
      ...data,
    });
  }

  // Used by the month view's day-detail sheet when the user schedules work
  // directly from a tapped future/today date. Wraps the same handleAdd
  // logic but doesn't close the parent's "Add" sheet (it was never opened).
  function handleScheduleFromDay(items: Omit<ScheduleItem, 'id' | 'businessId' | 'createdAt'>[]) {
    const baseTs = Date.now();
    items.forEach((data, i) => {
      addScheduleItem({
        id: `sch_${baseTs}_${i}`,
        businessId: businessId ?? '',
        createdAt: new Date().toISOString(),
        ...data,
      });
    });
  }

  const totalUpcoming = upcomingItems.length;

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Schedule"
        subtitle={`${totalUpcoming} upcoming`}
        action={
          <Button size="sm" className="bg-primary h-9" onClick={() => setShowAdd(true)}>
            <Plus size={16} className="mr-1" /> Add
          </Button>
        }
      />

      {/* Width cap on desktop matches JobDetailSheet polish. */}
      <div className="px-4 md:px-6 pb-6 w-full max-w-5xl mx-auto">
        {/* View toggle */}
        <div className="flex items-center justify-between mb-3">
          <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
            {VIEW_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => changeView(value)}
                className={cn(
                  'h-8 px-3 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors',
                  view === value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                aria-pressed={view === value}
              >
                <Icon size={14} strokeWidth={2} />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Type filter chips — visible on every view */}
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide -mx-1 px-1">
          {TYPE_FILTERS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setTypeFilter(value)}
              className={cn(
                'shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                typeFilter === value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/30'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Empty state — only when literally nothing is scheduled */}
        {scheduleItems.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              icon={CalendarDays}
              title="Nothing scheduled"
              description="Add job bookings, quote visits, follow-ups, and bill due dates to stay organised."
              action={
                <Button className="bg-primary" onClick={() => setShowAdd(true)}>
                  <Plus size={16} className="mr-1.5" /> Add first item
                </Button>
              }
            />
          </div>
        ) : view === 'list' ? (
          <ListView
            runs={upcomingRuns}
            completedRuns={completedRuns}
            jobs={jobs}
            onComplete={handleComplete}
            onEdit={openEdit}
            onAddToCalendar={handleAddItemToCalendar}
            onWrapUp={(item) => {
              setWrapUpScheduleItemIds([item.id]);
            }}
          />
        ) : view === 'week' ? (
          <WeekView
            items={filteredAll}
            jobs={jobs}
            hoursByDate={hoursByDate}
            onComplete={handleComplete}
            onEditHours={(id) => setEditingHoursId(id)}
            onEdit={openEdit}
          />
        ) : (
          <MonthView
            items={filteredAll}
            jobs={jobs}
            hoursByDate={hoursByDate}
            onComplete={handleComplete}
            onEditHours={(id) => setEditingHoursId(id)}
            onEdit={openEdit}
            onWrapUp={(item) => {
              setWrapUpScheduleItemIds([item.id]);
            }}
            onAddToCalendar={handleAddItemToCalendar}
            onLogHours={handleAddEntry}
            onScheduleItems={handleScheduleFromDay}
            onSkip={handleSkip}
            onUnskip={handleUnskip}
          />
        )}
      </div>

      {/* Add schedule sheet */}
      <Sheet open={showAdd} onOpenChange={setShowAdd}>
        <SheetContent side="bottom" className="h-[85vh] overflow-y-auto rounded-t-2xl px-4 pb-10">
          <SheetHeader className="pb-4">
            <SheetTitle>Add schedule item</SheetTitle>
          </SheetHeader>
          <AddScheduleForm
            jobs={jobs}
            initialType={initialAddType}
            onSave={(items) => {
              // Clear the deep-link state after first use so closing+reopening
              // the sheet doesn't keep re-applying the same pre-selection.
              setInitialAddType(undefined);
              handleAdd(items);
            }}
            onCancel={() => {
              setInitialAddType(undefined);
              setShowAdd(false);
            }}
          />
        </SheetContent>
      </Sheet>

      {/* Post-save calendar-invite prompt. Only shows for quote_visit items
          so we don't pester the user about every reminder/booking they add.
          The two-button row (Skip / Add to calendar) is deliberate — the
          calendar invite is the better default but not the only option,
          and we want Skip to be one tap away if the user's already on top
          of their reminders some other way. */}
      <Sheet
        open={savedQuoteVisit !== null}
        onOpenChange={(open) => { if (!open) setSavedQuoteVisit(null); }}
      >
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader className="pb-2">
            <SheetTitle>Site visit added</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 pb-4">
            <p className="text-sm text-muted-foreground">
              Add this to your phone's calendar to get a reminder
              <span className="font-medium text-foreground"> the night before </span>
              and
              <span className="font-medium text-foreground"> 1 hour before</span>.
            </p>
            {savedQuoteVisit && (
              <div className="rounded-xl bg-muted/40 border border-border px-3 py-2.5 text-sm space-y-0.5">
                <p className="font-medium text-foreground">{savedQuoteVisit.title}</p>
                <p className="text-muted-foreground text-xs">
                  {savedQuoteVisit.date}
                  {savedQuoteVisit.startTime && ` · ${savedQuoteVisit.startTime}`}
                  {savedQuoteVisit.endTime && `–${savedQuoteVisit.endTime}`}
                </p>
                {savedQuoteVisit.location && (
                  <p className="text-muted-foreground text-xs">{savedQuoteVisit.location}</p>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setSavedQuoteVisit(null)}
              >
                Skip
              </Button>
              <Button
                className="flex-1 bg-primary"
                onClick={handleDownloadVisitIcs}
              >
                <CalendarDays size={16} className="mr-1.5" /> Add to calendar
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Edit-schedule sheet — opened by tapping any RunCard / DayChip /
          RunBar across all three views. Supports range editing with a
          day-of-week filter (Mon–Sat / Mon–Fri / Every day / Custom). */}
      <EditScheduleItemSheet
        open={!!editingTarget}
        onOpenChange={(open) => !open && setEditingItemIds(null)}
        target={editingTarget}
        jobs={jobs}
      />

      {/* Site-visit wrap-up — opens when a quote_visit row with a
          linked job is ticked. Captures scope/photos/access while
          the visit is fresh. On save, completes the underlying
          schedule_item(s). */}
      {/* Wrap-up / edit chooser — only shown after a quote_visit row
          is tapped. Picks branch the user actually wants. */}
      <VisitActionChooser
        open={chooserItems !== null}
        itemTitle={chooserItems?.[0]?.title}
        itemDate={chooserItems?.[0]?.date
          ? format(parseISODate(chooserItems[0].date), 'EEE, d MMM yyyy')
          : undefined}
        onWrapUp={() => {
          if (chooserItems) {
            setWrapUpScheduleItemIds(chooserItems.map((it) => it.id));
          }
          setChooserItems(null);
        }}
        onEdit={() => {
          if (chooserItems) {
            setEditingItemIds(chooserItems.map((it) => it.id));
          }
          setChooserItems(null);
        }}
        onCancel={() => setChooserItems(null)}
      />

      {/* "Didn't work" picker — opens from the RunCard pill or the
          day-detail popover. Captures a reason chip + optional note
          (required for 'other'). Setting these clears the Overdue
          state while keeping the day visible on the calendar. */}
      <SkipPickerSheet
        open={!!skippingItem}
        item={skippingItem ?? null}
        onCancel={() => setSkippingItemId(null)}
        onConfirm={commitSkip}
      />

      <SiteVisitWrapUpSheet
        open={wrapUpTarget !== null}
        target={wrapUpTarget}
        onSaved={(resolvedJobId) => {
          if (wrapUpScheduleItemIds) {
            // Complete every item in the run AND attach the resolved
            // jobId. If the wrap-up created a new job, this is the
            // moment the schedule_item gets its link. Existing-job
            // case writes the same id back, which is a harmless no-op.
            for (const id of wrapUpScheduleItemIds) {
              updateScheduleItem(id, { completed: true, jobId: resolvedJobId });
            }
          }
          setWrapUpScheduleItemIds(null);
          // Natural next step: mark the quote as sent. Open the existing
          // Mark-as-quoted sheet for this job. The user can Cancel out
          // of it if they haven't actually sent the quote yet (still
          // drafting, no price, etc.) — wrap-up data is already saved.
          setPendingQuoteJobId(resolvedJobId);
        }}
        onCancel={() => setWrapUpScheduleItemIds(null)}
      />

      {/* Quote-sent prompt — auto-opens after wrap-up so the user can
          mark the quote sent in one continuous flow. Cancel just
          closes; wrap-up data stays saved either way. */}
      <MarkAsQuotedSheet
        open={pendingQuoteJob !== null}
        job={pendingQuoteJob}
        onSaved={() => setPendingQuoteJobId(null)}
        onCancel={() => setPendingQuoteJobId(null)}
      />

      {/* Edit-hours sheet — shared by week + month view. Tap a logged-hours
          card on either view to open this; uses the same EntryForm as the
          dedicated /entries page so the experience is consistent. */}
      <Sheet open={!!editingHoursId} onOpenChange={(open) => !open && setEditingHoursId(null)}>
        <SheetContent side="bottom" className="h-[90vh] overflow-y-auto rounded-t-2xl px-4 pb-10">
          <SheetHeader className="pb-4">
            <SheetTitle>Edit hours entry</SheetTitle>
          </SheetHeader>
          {editingHours && (
            <EntryForm
              defaultValues={editingHours}
              onSave={(data) => {
                updateEntry(editingHours.id, data);
                setEditingHoursId(null);
              }}
              onCancel={() => setEditingHoursId(null)}
              onDelete={() => {
                if (!confirm('Delete this hours entry? This can\'t be undone.')) return;
                deleteEntry(editingHours.id);
                setEditingHoursId(null);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST VIEW — runs collapsed, grouped by date label
// ─────────────────────────────────────────────────────────────────────────────

function ListView({
  runs,
  completedRuns,
  jobs,
  onComplete,
  onEdit,
  onAddToCalendar,
  onWrapUp,
}: {
  runs: ItemRun[];
  completedRuns: ItemRun[];
  jobs: Job[];
  onComplete: (run: ItemRun) => void;
  onEdit: (items: ScheduleItem[]) => void;
  /** Re-trigger the .ics download for a single schedule item. Optional;
   * when omitted the badge on quote_visit rows still renders but is inert. */
  onAddToCalendar?: (item: ScheduleItem) => void;
  /** Open retroactive wrap-up for a completed quote_visit row. */
  onWrapUp?: (item: ScheduleItem) => void;
}) {
  // Group runs by their start-date label (Today / Tomorrow / weekday / date).
  const grouped: Record<string, ItemRun[]> = {};
  for (const run of runs) {
    const g = dateGroup(run.startDate);
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(run);
  }

  const hasUpcoming = runs.length > 0;
  const hasCompleted = completedRuns.length > 0;

  if (!hasUpcoming && !hasCompleted) {
    return (
      <div className="mt-8 text-center text-sm text-muted-foreground">
        Nothing matches this filter.
      </div>
    );
  }

  return (
    <div className="space-y-6 mt-1">
      {Object.entries(grouped).map(([group, groupRunsArr]) => (
        <div key={group}>
          <h3 className={cn(
            'text-sm font-semibold mb-2',
            group === 'Today' ? 'text-primary' : 'text-muted-foreground'
          )}>
            {group}
          </h3>
          <div className="space-y-2">
            {groupRunsArr.map((run) => (
              <RunCard
                key={run.head.id}
                run={run}
                job={run.head.jobId ? jobs.find((j) => j.id === run.head.jobId) : undefined}
                onComplete={() => onComplete(run)}
                onEdit={() => onEdit(run.items)}
                onAddToCalendar={onAddToCalendar ? () => onAddToCalendar(run.head) : undefined}
              />
            ))}
          </div>
        </div>
      ))}

      {hasCompleted && (
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground mb-2">Done</h3>
          <div className="space-y-2 opacity-60">
            {completedRuns.map((run) => (
              <RunCard
                key={run.head.id}
                run={run}
                job={run.head.jobId ? jobs.find((j) => j.id === run.head.jobId) : undefined}
                onComplete={() => {}}
                onEdit={() => onEdit(run.items)}
                // Pass onWrapUp so completed quote_visit cards can offer
                // a retroactive write-up. onAddToCalendar deliberately
                // omitted — no point setting reminders on past events.
                onWrapUp={onWrapUp ? () => onWrapUp(run.head) : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RunCard({
  run,
  job,
  onComplete,
  onEdit,
  onAddToCalendar,
  onWrapUp,
  onSkip,
  onUnskip,
}: {
  run: ItemRun;
  job?: { name: string } | undefined;
  onComplete: () => void;
  onEdit?: () => void;
  /**
   * Triggered when the user taps "Add to calendar" on a quote_visit row
   * that hasn't had its .ics downloaded yet. Optional — the badge only
   * renders for quote_visit items, and only as a tappable chip when this
   * prop is provided AND the row's icsDownloaded is false. Otherwise
   * (or when icsDownloaded is true) the badge is read-only.
   */
  onAddToCalendar?: () => void;
  /**
   * Retroactive site-visit wrap-up. Only meaningful for quote_visit
   * rows with a linked job that have already been ticked complete (the
   * incomplete case is handled by onComplete itself, which opens the
   * wrap-up via the page-level fork). Renders a small pill on the
   * card so Brad can write up a visit he'd already marked done.
   */
  onWrapUp?: () => void;
  /**
   * Opens the "Didn't work today" picker (rained off, sick, etc.). Only
   * surfaced for past-or-today job_booking days that aren't already
   * completed or skipped. The card stays on the calendar after skipping
   * but renders faded with the reason chip.
   */
  onSkip?: () => void;
  /** Reverts a skipped day back to scheduled-but-not-completed. */
  onUnskip?: () => void;
}) {
  const config = TYPE_CONFIG[run.head.type];
  const Icon = config.icon;
  const startDate = parseISO(run.startDate);
  const endDate = parseISO(run.endDate);
  // A run is "skipped" if its representative item has a skip reason. We
  // only ever group same-jobId same-type items into a run (groupRuns()
  // keys on jobId+type+title), so per-day skip is preserved when the
  // run is one day — and most skip use-cases are one day at a time
  // (rained off TODAY, not the whole booking).
  const isSkipped = !!run.head.skipReasonKind;
  const overdue = isPast(endDate) && !isToday(endDate) && !run.allCompleted && !isSkipped;
  const completedCount = run.items.filter((i) => i.completed).length;
  const isMultiDay = run.days > 1;
  const title = isMultiDay ? stripDayLabel(run.head.title) : run.head.title;

  // Compact range label when multi-day.
  const rangeLabel = isMultiDay
    ? `${format(startDate, 'd MMM')} – ${format(endDate, 'd MMM')}`
    : null;

  // Whole card is tappable to edit. The "mark done" circle uses
  // stopPropagation below so it doesn't also open the editor.
  return (
    <div
      onClick={onEdit}
      role={onEdit ? 'button' : undefined}
      tabIndex={onEdit ? 0 : undefined}
      onKeyDown={(e) => {
        if (!onEdit) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
      className={cn(
      'flex items-start gap-3 p-3.5 rounded-2xl border transition-colors',
      run.allCompleted ? 'bg-muted/30 border-border' : 'bg-card border-border',
      overdue && !run.allCompleted && !isSkipped && 'border-red-200 bg-red-50/30',
      // Skipped days render faded — opacity on the whole card so the
      // icon, title and meta all wash out together. Distinct from
      // "completed" which uses muted bg + strikethrough on the title.
      isSkipped && 'opacity-60',
      onEdit && 'cursor-pointer hover:border-primary/40'
    )}>
      <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5', config.bg)}>
        <Icon size={17} className={config.color} strokeWidth={1.8} />
      </div>

      <div className="flex-1 min-w-0">
        <p className={cn('text-sm font-medium leading-snug', run.allCompleted && 'line-through text-muted-foreground')}>
          {title}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
          <span className={cn('text-xs', config.color, 'font-medium')}>{config.label}</span>
          {isMultiDay && (
            <span className="text-xs text-muted-foreground">
              {rangeLabel} · {run.days} days
              {completedCount > 0 && completedCount < run.days && ` · ${completedCount}/${run.days} done`}
            </span>
          )}
          {!isMultiDay && run.head.startTime && (
            <span className="text-xs text-muted-foreground">
              {run.head.startTime}{run.head.endTime ? `–${run.head.endTime}` : ''}
            </span>
          )}
          {job && <span className="text-xs text-muted-foreground truncate">{job.name}</span>}
          {overdue && <span className="text-xs font-medium text-red-500">Overdue</span>}
          {isSkipped && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 text-[10px] font-semibold uppercase tracking-wide">
              {SKIP_REASON_LABELS[run.head.skipReasonKind!] ?? 'Skipped'}
            </span>
          )}
        </div>

        {/* Free-form note for skipped days (always shown for 'other',
            optional for the other kinds). Sits below the meta row so
            the structured "Rained off" chip lands first. */}
        {isSkipped && run.head.skipReason && (
          <p className="text-xs text-muted-foreground mt-1 italic">
            {run.head.skipReason}
          </p>
        )}

        {/* Reminders badge — only for quote_visit rows. Two states:
            (a) icsDownloaded=true → muted "Reminders set" badge, read-only.
            (b) icsDownloaded=false → primary-tinted chip, tappable to
                re-trigger download. Stop propagation so the tap doesn't
                also open the edit sheet (whole card is clickable). */}
        {run.head.type === 'quote_visit' && (
          run.head.icsDownloaded ? (
            <div className="mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-50 text-[10px] font-medium text-emerald-700">
              <Bell size={10} strokeWidth={2.2} />
              Reminders: night before · 1hr before
            </div>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAddToCalendar?.();
              }}
              disabled={!onAddToCalendar}
              className={cn(
                'mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium',
                onAddToCalendar
                  ? 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                  : 'bg-muted text-muted-foreground',
              )}
              title="Download a calendar invite so your phone reminds you the night before and 1 hour before"
            >
              <CalendarDays size={10} strokeWidth={2.2} />
              Add to calendar
            </button>
          )
        )}

        {/* Retroactive wrap-up pill — on any already-completed quote_visit
            row. (Incomplete visits use the tick to open the wrap-up
            directly.) Works whether or not the visit has a linked job —
            wrap-up creates one if needed. Discoverable on the muted
            "done" card so Brad can write up a visit he ticked-through
            earlier without re-opening it. */}
        {run.head.type === 'quote_visit'
          && run.allCompleted
          && onWrapUp && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onWrapUp();
            }}
            className="mt-1.5 ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-primary/10 text-primary hover:bg-primary/15"
            title="Capture scope, photos and access notes for this site visit"
          >
            <FileText size={10} strokeWidth={2.2} />
            Wrap up visit
          </button>
        )}

        {/* "Didn't work" pill — only on past-or-today job_booking days
            that aren't completed, aren't already skipped, and where the
            parent provided onSkip. Lets the user mark "rained off / sick
            / etc." instead of either ticking complete or leaving the
            day flagged as Overdue. date-fns isPast() excludes today,
            so OR with isToday() to cover "rained off this morning" too. */}
        {!run.allCompleted
          && !isSkipped
          && run.head.type === 'job_booking'
          && (isPast(endDate) || isToday(endDate))
          && onSkip && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSkip();
            }}
            className="mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-amber-50 text-amber-800 hover:bg-amber-100"
            title="Mark this day as not worked — rained off, sick, client postponed, etc."
          >
            <CloudRain size={10} strokeWidth={2.2} />
            Didn't work
          </button>
        )}

        {/* Unskip pill — only on already-skipped days, lets the user
            revert. Discoverability matters here because the faded
            treatment makes the card feel inert. */}
        {isSkipped && onUnskip && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onUnskip();
            }}
            className="mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            title="Undo skipped — put this day back on the schedule"
          >
            Undo skip
          </button>
        )}

        {run.head.notes && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{run.head.notes}</p>
        )}
      </div>

      {!run.allCompleted && !isSkipped && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onComplete();
          }}
          className="shrink-0 w-7 h-7 rounded-full border-2 border-border hover:border-green-400 hover:bg-green-50 flex items-center justify-center transition-colors mt-0.5"
          title={isMultiDay ? `Mark all ${run.days} days done` : 'Mark done'}
        >
          <CheckCircle2 size={14} className="text-muted-foreground hover:text-green-500" />
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WEEK VIEW — 7-day strip (Mon–Sun), prev/next nav, items per day
// ─────────────────────────────────────────────────────────────────────────────

function WeekView({
  items,
  jobs,
  hoursByDate,
  onComplete,
  onEditHours,
  onEdit,
}: {
  items: ScheduleItem[];
  jobs: Job[];
  hoursByDate: Map<string, Entry[]>;
  onComplete: (run: ItemRun) => void;
  onEditHours: (entryId: string) => void;
  onEdit: (items: ScheduleItem[]) => void;
  // Note: WeekView intentionally doesn't surface the wrap-up / add-to-
  // calendar actions — its chips are too compact to host pills, and
  // the user can switch to Month or List to perform those actions.
}) {
  // For the week view we want tapping any chip in a multi-day run to open
  // the *whole* run, not just the day under the cursor — so the user can
  // re-edit the date range as a unit. We pre-compute the runs that span
  // the visible window, then for any item we render we look up its parent
  // run to pass into onEdit. The hashmap below is keyed by item id.
  const allRuns = useMemo(() => groupRuns(items), [items]);
  const runByItemId = useMemo(() => {
    const map = new Map<string, ItemRun>();
    for (const r of allRuns) for (const it of r.items) map.set(it.id, r);
    return map;
  }, [allRuns]);
  const [anchor, setAnchor] = useState(() => new Date());
  const weekStart = startOfWeek(anchor, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(anchor, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: weekStart, end: weekEnd });

  const itemsInWeek = items.filter((s) => {
    const d = parseISODate(s.date);
    return d >= weekStart && d <= weekEnd;
  });

  // Group items by day for the per-column lists.
  const byDay = (() => {
    const map = new Map<string, ScheduleItem[]>();
    for (const it of itemsInWeek) {
      const arr = map.get(it.date) ?? [];
      arr.push(it);
      map.set(it.date, arr);
    }
    return map;
  })();

  return (
    <div className="mt-1">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setAnchor(addWeeks(anchor, -1))}
          className="h-8 w-8 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground"
          aria-label="Previous week"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="text-sm font-medium text-center">
          {format(weekStart, 'd MMM')} – {format(weekEnd, 'd MMM yyyy')}
          {!isThisWeek(anchor, { weekStartsOn: 1 }) && (
            <button
              onClick={() => setAnchor(new Date())}
              className="ml-2 text-xs text-primary font-normal underline-offset-2 hover:underline"
            >
              This week
            </button>
          )}
        </div>
        <button
          onClick={() => setAnchor(addWeeks(anchor, 1))}
          className="h-8 w-8 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground"
          aria-label="Next week"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Phone: stacked day rows. Desktop (md+): 7-col grid. */}
      <div className="md:grid md:grid-cols-7 md:gap-2 space-y-2 md:space-y-0">
        {days.map((d) => {
          const iso = formatISODate(d);
          const dayItems = (byDay.get(iso) ?? []).sort(
            (a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? '')
          );
          const dayHours = hoursByDate.get(iso) ?? [];
          const totalHours = dayHours.reduce((sum, e) => sum + (e.hours ?? 0), 0);
          const today = isToday(d);
          return (
            <div
              key={iso}
              className={cn(
                'rounded-xl border p-2 min-h-[6rem] md:min-h-[12rem]',
                today ? 'border-primary/40 bg-primary/5' : 'border-border bg-card'
              )}
            >
              <div className="flex items-baseline gap-1.5 mb-1.5">
                <span className={cn(
                  'text-xs font-semibold uppercase tracking-wide',
                  today ? 'text-primary' : 'text-muted-foreground'
                )}>
                  {format(d, 'EEE')}
                </span>
                <span className={cn(
                  'text-sm font-bold',
                  today ? 'text-primary' : 'text-foreground'
                )}>
                  {format(d, 'd')}
                </span>
                {totalHours > 0 && (
                  <span
                    className="ml-auto inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded-full"
                    title={`${totalHours}h logged`}
                  >
                    <Clock size={9} strokeWidth={2.5} />
                    {totalHours}h
                  </span>
                )}
              </div>
              {dayItems.length === 0 && dayHours.length === 0 ? (
                <div className="text-xs text-muted-foreground/60 italic mt-1">—</div>
              ) : (
                <div className="space-y-1">
                  {dayItems.map((it) => (
                    <DayChip
                      key={it.id}
                      item={it}
                      job={it.jobId ? jobs.find((j) => j.id === it.jobId) : undefined}
                      onComplete={() => onComplete({
                        head: it, items: [it], startDate: it.date, endDate: it.date,
                        days: 1, allCompleted: it.completed,
                      })}
                      onEdit={() => {
                        const run = runByItemId.get(it.id);
                        onEdit(run ? run.items : [it]);
                      }}
                    />
                  ))}
                  {dayHours.map((e) => (
                    <HoursChip
                      key={e.id}
                      entry={e}
                      job={e.jobId ? jobs.find((j) => j.id === e.jobId) : undefined}
                      onClick={() => onEditHours(e.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {itemsInWeek.length === 0 && days.every((d) => (hoursByDate.get(formatISODate(d)) ?? []).length === 0) && (
        <div className="mt-6 text-center text-sm text-muted-foreground">
          Nothing scheduled this week.
        </div>
      )}
    </div>
  );
}

function DayChip({
  item,
  job,
  onComplete,
  onEdit,
}: {
  item: ScheduleItem;
  job?: { name: string } | undefined;
  onComplete: () => void;
  onEdit?: () => void;
}) {
  const config = TYPE_CONFIG[item.type];
  // Per-job colour for the icon + left border, so two jobs in the same week
  // read as different things at a glance. Jobless items keep type colour.
  const { text: chipText } = colorFor(item);
  const Icon = config.icon;
  const isSkipped = !!item.skipReasonKind;
  // Skipped days suppress the Overdue treatment — they're not overdue,
  // they're accounted for (we know why they didn't happen).
  const overdue = isPast(parseISO(item.date)) && !isToday(parseISO(item.date)) && !item.completed && !isSkipped;
  return (
    <div
      onClick={onEdit}
      role={onEdit ? 'button' : undefined}
      tabIndex={onEdit ? 0 : undefined}
      onKeyDown={(e) => {
        if (!onEdit) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
      className={cn(
        'flex items-start gap-1.5 p-1.5 rounded-md text-xs border-l-2',
        chipText,
        item.completed ? 'opacity-50 line-through' : '',
        // Skipped: fade but don't strikethrough (the title is still
        // factually accurate — we just couldn't do it).
        isSkipped && !item.completed && 'opacity-60',
        'bg-card hover:bg-muted/50 transition-colors',
        onEdit && 'cursor-pointer',
    )} style={{ borderLeftColor: 'currentColor' }}>
      <Icon size={12} className={cn('mt-0.5 shrink-0', chipText)} strokeWidth={2} />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate leading-snug">{stripDayLabel(item.title)}</div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          {item.startTime && <span>{item.startTime}</span>}
          {job && <span className="truncate">{job.name}</span>}
          {overdue && !item.completed && <span className="text-red-500 font-medium">Overdue</span>}
          {isSkipped && (
            <span className="text-amber-700 font-medium">
              {SKIP_REASON_LABELS[item.skipReasonKind!] ?? 'Skipped'}
            </span>
          )}
        </div>
      </div>
      {!item.completed && !isSkipped && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onComplete();
          }}
          className="shrink-0 w-5 h-5 rounded-full border border-border hover:border-green-400 hover:bg-green-50 flex items-center justify-center transition-colors"
          title="Mark done"
        >
          <CheckCircle2 size={10} className="text-muted-foreground" />
        </button>
      )}
    </div>
  );
}

// Larger card variant of HoursChip for the day-detail sheet. Shape matches
// RunCard so the two sections feel like siblings: same height, same icon
// well, same content layout. Tappable — opens the entry edit sheet so the
// user can fix a mis-dated hours entry without bouncing to the Entry tab.
function HoursLogCard({
  entry,
  job,
  onClick,
}: {
  entry: Entry;
  job?: { name: string } | undefined;
  onClick: () => void;
}) {
  // Strip the [OH] tag from display so the description reads cleanly. The
  // edit sheet handles the prefix separately via the Overhead toggle.
  const description = entry.description.startsWith('[OH] ')
    ? entry.description.slice('[OH] '.length)
    : entry.description;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-start gap-3 p-3.5 rounded-2xl border border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50 hover:border-emerald-300 transition-colors"
    >
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 bg-emerald-100">
        <Clock size={17} className="text-emerald-700" strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-snug">
          {entry.hours ?? 0}h{entry.activity ? ` · ${entry.activity}` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
          <span className="text-xs text-emerald-700 font-medium">Hours</span>
          {job ? (
            <span className="text-xs text-muted-foreground truncate">{job.name}</span>
          ) : (
            <span className="text-xs text-muted-foreground italic">No job</span>
          )}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{description}</p>
        )}
      </div>
    </button>
  );
}

// Compact chip for an hours entry surfaced inside the week view. Different
// shape from DayChip on purpose so a backdated hours log reads as "this is
// what already happened" rather than "this is something to do". Tappable —
// opens the same edit sheet used by the month view's day-detail.
function HoursChip({
  entry,
  job,
  onClick,
}: {
  entry: Entry;
  job?: { name: string } | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-start gap-1.5 p-1.5 rounded-md text-xs border-l-2 border-emerald-300 bg-emerald-50/60 hover:bg-emerald-50 text-emerald-900 transition-colors"
      title={entry.description}
    >
      <Clock size={12} className="mt-0.5 shrink-0 text-emerald-600" strokeWidth={2} />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate leading-snug">
          {entry.hours ?? 0}h{entry.activity ? ` · ${entry.activity}` : ''}
        </div>
        <div className="flex items-center gap-1 text-[10px] text-emerald-700/80">
          {job ? (
            <span className="truncate">{job.name}</span>
          ) : (
            <span className="truncate italic text-emerald-700/60">No job</span>
          )}
        </div>
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MONTH VIEW — full grid, multi-day jobs as continuous bars per row
// ─────────────────────────────────────────────────────────────────────────────

function MonthView({
  items,
  jobs,
  hoursByDate,
  onComplete,
  onEditHours,
  onEdit,
  onWrapUp,
  onAddToCalendar,
  onLogHours,
  onScheduleItems,
  onSkip,
  onUnskip,
}: {
  items: ScheduleItem[];
  jobs: Job[];
  hoursByDate: Map<string, Entry[]>;
  onComplete: (run: ItemRun) => void;
  onEditHours: (entryId: string) => void;
  onEdit: (items: ScheduleItem[]) => void;
  /** Retroactive site-visit wrap-up — surfaces the pill on completed
   * quote_visit cards rendered in the day-detail popover. */
  onWrapUp?: (item: ScheduleItem) => void;
  /** .ics re-download for quote_visit cards in the day-detail popover. */
  onAddToCalendar?: (item: ScheduleItem) => void;
  /** Called when the user logs hours inline from the day-detail sheet
   *  (only offered for past/today dates). */
  onLogHours: (entry: Omit<Entry, 'id' | 'businessId' | 'createdAt'>) => void;
  /** Called when the user schedules work inline from the day-detail sheet
   *  (only offered for today/future dates). */
  onScheduleItems: (items: Omit<ScheduleItem, 'id' | 'businessId' | 'createdAt'>[]) => void;
  /** Open the "Didn't work" picker for the given schedule item. */
  onSkip?: (item: ScheduleItem) => void;
  /** Revert a previously-skipped day back to scheduled. */
  onUnskip?: (item: ScheduleItem) => void;
}) {
  // Same item→run lookup as WeekView: when the user taps an item in the
  // day-detail sheet we open the *whole run* in the editor, not just the
  // single day they tapped.
  const allRuns = useMemo(() => groupRuns(items), [items]);
  const runByItemId = useMemo(() => {
    const map = new Map<string, ItemRun>();
    for (const r of allRuns) for (const it of r.items) map.set(it.id, r);
    return map;
  }, [allRuns]);
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  // Which inline action panel is open in the day-detail sheet. Reset whenever
  // the sheet opens on a different day so each day starts collapsed.
  const [inlineAction, setInlineAction] = useState<'log' | 'schedule' | null>(null);
  useEffect(() => { setInlineAction(null); }, [selectedDay]);

  const monthStart = startOfMonth(anchor);
  const monthEnd = endOfMonth(anchor);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  // Items in this grid window (could be a few days into prev/next month for the
  // partial weeks at the edges).
  const itemsInGrid = items.filter((s) => {
    const d = parseISODate(s.date);
    return d >= gridStart && d <= gridEnd;
  });

  // Group consecutive same-job same-type items into runs so we can draw bars.
  const runs = groupRuns(itemsInGrid);

  // Index every day to its set of "passing through" runs, so each cell knows
  // what bars to render. A run on 5–9 May appears in cells 5,6,7,8,9.
  const dayToRuns = (() => {
    const map = new Map<string, ItemRun[]>();
    for (const run of runs) {
      for (const iso of datesBetween(run.startDate, run.endDate)) {
        const arr = map.get(iso) ?? [];
        arr.push(run);
        map.set(iso, arr);
      }
    }
    return map;
  })();

  const dayItems = selectedDay
    ? items.filter((i) => i.date === selectedDay).sort(
        (a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? '')
      )
    : [];

  // Hours entries for the day the user has tapped open. Sorted newest-first
  // since we don't have a timestamp on the entry — created order is good
  // enough for showing a list of "what I did that day".
  const dayHours = selectedDay ? (hoursByDate.get(selectedDay) ?? []) : [];
  const dayHoursTotal = dayHours.reduce((sum, e) => sum + (e.hours ?? 0), 0);

  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="mt-1">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setAnchor(addMonths(anchor, -1))}
          className="h-8 w-8 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground"
          aria-label="Previous month"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="text-sm font-medium text-center">
          {format(anchor, 'MMMM yyyy')}
          {!isSameMonth(anchor, new Date()) && (
            <button
              onClick={() => setAnchor(new Date())}
              className="ml-2 text-xs text-primary font-normal underline-offset-2 hover:underline"
            >
              Today
            </button>
          )}
        </div>
        <button
          onClick={() => setAnchor(addMonths(anchor, 1))}
          className="h-8 w-8 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground"
          aria-label="Next month"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {weekdayLabels.map((d) => (
          <div key={d} className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground text-center py-1">
            {d}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const iso = formatISODate(d);
          const inMonth = isSameMonth(d, anchor);
          const today = isToday(d);
          const cellRuns = dayToRuns.get(iso) ?? [];
          const cellHours = hoursByDate.get(iso) ?? [];
          const cellHoursTotal = cellHours.reduce((sum, e) => sum + (e.hours ?? 0), 0);

          // "Extra hours" = hours entries whose job isn't already represented
          // by a schedule item run on this day. Without this, a backdated
          // hours entry on a day with no plan shows only the "Xh" pill in the
          // corner — easy to miss on a busy calendar. We render those as
          // light-tinted bars so the user sees the job they worked on.
          const runJobIds = new Set(
            cellRuns.map((r) => r.head.jobId).filter((x): x is string => !!x),
          );
          // Group hours entries by jobId so multiple hours rows on the same
          // job/day collapse into one bar with the summed hours.
          const hoursByJobId = new Map<string | null, { hours: number; entries: typeof cellHours }>();
          for (const e of cellHours) {
            if (e.jobId && runJobIds.has(e.jobId)) continue; // already shown as a plan bar
            const key = e.jobId ?? null;
            const cur = hoursByJobId.get(key) ?? { hours: 0, entries: [] };
            cur.hours += e.hours ?? 0;
            cur.entries.push(e);
            hoursByJobId.set(key, cur);
          }
          const extraHoursBars = Array.from(hoursByJobId.entries()).map(([jobId, agg]) => ({
            jobId,
            hours: agg.hours,
            jobName: jobId ? (jobs.find((j) => j.id === jobId)?.name ?? 'Job') : undefined,
          }));

          // Limit to 3 visible items total (plan bars + hours bars combined),
          // showing "+N more" overflow. Plan bars take priority.
          const planVisible = cellRuns.slice(0, 3);
          const remainingSlots = Math.max(0, 3 - planVisible.length);
          const hoursVisible = extraHoursBars.slice(0, remainingSlots);
          const overflow = (cellRuns.length - planVisible.length)
            + (extraHoursBars.length - hoursVisible.length);

          return (
            <button
              key={iso}
              onClick={() => setSelectedDay(iso)}
              className={cn(
                'relative aspect-square sm:aspect-[4/5] md:aspect-[5/6] rounded-md border p-1 text-left flex flex-col gap-0.5 transition-colors',
                inMonth ? 'bg-card' : 'bg-muted/30',
                today ? 'border-primary ring-1 ring-primary/30' : 'border-border',
                'hover:border-primary/40'
              )}
            >
              <div className="flex items-center justify-between leading-none">
                <span className={cn(
                  'text-[11px] font-semibold',
                  today ? 'text-primary' : inMonth ? 'text-foreground' : 'text-muted-foreground/60'
                )}>
                  {format(d, 'd')}
                </span>
                {cellHoursTotal > 0 && (
                  // Tiny pill on past/current days where hours were logged.
                  // Reads as "this day had work done", distinct from the
                  // schedule bars which mean "this day was planned".
                  <span
                    className="text-[9px] font-semibold text-emerald-700 bg-emerald-50 px-1 rounded-sm leading-none py-0.5"
                    title={`${cellHoursTotal}h logged`}
                  >
                    {cellHoursTotal}h
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-0.5 flex-1 overflow-hidden">
                {planVisible.map((run) => (
                  <RunBar
                    key={run.head.id}
                    run={run}
                    cellDate={iso}
                    job={run.head.jobId ? jobs.find((j) => j.id === run.head.jobId) : undefined}
                  />
                ))}
                {hoursVisible.map((b) => {
                  if (!b.jobId || !b.jobName) {
                    return <HoursBarNoJob key={`hrs-no-job-${iso}`} hours={b.hours} />;
                  }
                  const palette = colorForJobId(b.jobId);
                  return (
                    <HoursBarForJob
                      key={`hrs-${b.jobId}`}
                      hours={b.hours}
                      jobName={b.jobName}
                      bgLight={palette.bgLight}
                      text={palette.text}
                      bar={palette.bar}
                    />
                  );
                })}
                {overflow > 0 && (
                  <div className="text-[9px] text-muted-foreground font-medium leading-none">
                    +{overflow} more
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-3 text-[11px] text-muted-foreground text-center">
        Tap a day to see details.
      </div>

      {/* Day detail sheet — opens when a day is tapped. */}
      <Sheet open={!!selectedDay} onOpenChange={(open) => !open && setSelectedDay(null)}>
        <SheetContent side="bottom" className="h-[80vh] overflow-y-auto rounded-t-2xl px-4 pb-10">
          <SheetHeader className="pb-4">
            <SheetTitle>
              {selectedDay && format(parseISODate(selectedDay), 'EEEE, d MMMM yyyy')}
            </SheetTitle>
          </SheetHeader>
          {(() => {
            if (!selectedDay) return null;
            // Past = log hours; future = schedule; today = both. We compare
            // ISO strings (YYYY-MM-DD) so timezone never enters the picture.
            const todayISO = formatISODate(new Date());
            const isPastOrToday = selectedDay <= todayISO;
            const isTodayOrFuture = selectedDay >= todayISO;
            const isEmpty = dayItems.length === 0 && dayHours.length === 0;

            return (
              <div className="space-y-4">
                {/* ── Inline actions ─────────────────────────────────────── */}
                {/* Past/today → Log hours. Today/future → Schedule a job.
                    On 'today' both render so the user can flip between
                    planning the afternoon and logging the morning. */}
                {inlineAction === null && (
                  <div className="flex flex-wrap gap-2">
                    {isPastOrToday && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setInlineAction('log')}
                        className="h-9"
                      >
                        <Clock size={14} className="mr-1.5" />
                        Log hours
                      </Button>
                    )}
                    {isTodayOrFuture && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setInlineAction('schedule')}
                        className="h-9"
                      >
                        <Plus size={14} className="mr-1.5" />
                        Schedule a job
                      </Button>
                    )}
                  </div>
                )}

                {inlineAction === 'log' && (
                  <div className="bg-muted/30 border border-border rounded-2xl p-3">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Log hours
                    </div>
                    <EntryForm
                      defaultType="hours"
                      defaultValues={{ entryDate: selectedDay }}
                      onSave={(data) => {
                        onLogHours(data);
                        setInlineAction(null);
                      }}
                      onCancel={() => setInlineAction(null)}
                    />
                  </div>
                )}

                {inlineAction === 'schedule' && (
                  <div className="bg-muted/30 border border-border rounded-2xl p-3">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Schedule
                    </div>
                    <AddScheduleForm
                      jobs={jobs}
                      defaultDate={selectedDay}
                      onSave={(scheduleItems) => {
                        onScheduleItems(scheduleItems);
                        setInlineAction(null);
                      }}
                      onCancel={() => setInlineAction(null)}
                    />
                  </div>
                )}

                {/* ── Existing day contents ──────────────────────────────── */}
                {isEmpty && inlineAction === null && (
                  <div className="text-sm text-muted-foreground text-center py-6">
                    Nothing scheduled on this day.
                  </div>
                )}
                {dayItems.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Scheduled
                    </h4>
                    <div className="space-y-2">
                      {dayItems.map((it) => {
                        const job = it.jobId ? jobs.find((j) => j.id === it.jobId) : undefined;
                        // Render as a single-day RunCard for consistency.
                        return (
                          <RunCard
                            key={it.id}
                            run={{
                              head: it, items: [it], startDate: it.date, endDate: it.date,
                              days: 1, allCompleted: it.completed,
                            }}
                            job={job}
                            onComplete={() => {
                              // Tick from day-detail: close the popover BEFORE
                              // calling onComplete so the wrap-up sheet (for
                              // quote_visit+job items) doesn't stack underneath.
                              setSelectedDay(null);
                              onComplete({
                                head: it, items: [it], startDate: it.date, endDate: it.date,
                                days: 1, allCompleted: it.completed,
                              });
                            }}
                            onEdit={() => {
                              // Close the day-detail sheet before opening the
                              // editor so we never have two sheets stacked.
                              const run = runByItemId.get(it.id);
                              setSelectedDay(null);
                              onEdit(run ? run.items : [it]);
                            }}
                            onWrapUp={onWrapUp ? () => {
                              // Same closing dance as onComplete — the wrap-up
                              // sheet is a separate modal and we don't want
                              // two stacked.
                              setSelectedDay(null);
                              onWrapUp(it);
                            } : undefined}
                            onAddToCalendar={onAddToCalendar ? () => onAddToCalendar(it) : undefined}
                            onSkip={onSkip ? () => {
                              // Close the day-detail BEFORE opening the picker
                              // so the two sheets don't stack.
                              setSelectedDay(null);
                              onSkip(it);
                            } : undefined}
                            onUnskip={onUnskip ? () => onUnskip(it) : undefined}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
                {dayHours.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
                      <Clock size={12} className="text-emerald-600" strokeWidth={2.5} />
                      Hours logged · {dayHoursTotal}h total
                    </h4>
                    <div className="space-y-2">
                      {dayHours.map((e) => {
                        const job = e.jobId ? jobs.find((j) => j.id === e.jobId) : undefined;
                        // Close the day-detail sheet before opening the edit
                        // sheet so we never have two modal sheets stacked.
                        return (
                          <HoursLogCard
                            key={e.id}
                            entry={e}
                            job={job}
                            onClick={() => {
                              setSelectedDay(null);
                              onEditHours(e.id);
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// "DIDN'T WORK" picker sheet — pick a reason chip + optional note
// ─────────────────────────────────────────────────────────────────────────────
function SkipPickerSheet({
  open,
  item,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  item: ScheduleItem | null;
  onCancel: () => void;
  onConfirm: (kind: ScheduleSkipReasonKind, note: string) => void;
}) {
  const [kind, setKind] = useState<ScheduleSkipReasonKind | null>(null);
  const [note, setNote] = useState('');

  // Reset whenever the sheet re-opens on a different item, so the next
  // skip starts from a clean slate (no stale chip from last time).
  useEffect(() => {
    if (open) {
      setKind(null);
      setNote('');
    }
  }, [open, item?.id]);

  // 'other' requires a note (otherwise we'd persist a meaningless "Other"
  // chip with no context). Other kinds: note is optional.
  const valid = kind !== null && (kind !== 'other' || note.trim().length > 0);

  const dayLabel = item
    ? format(parseISO(item.date), 'EEEE d MMMM')
    : '';

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onCancel()}>
      <SheetContent
        side="bottom"
        className="h-auto max-h-[85vh] overflow-y-auto rounded-t-2xl px-4 pb-10"
      >
        <SheetHeader className="pb-4">
          <SheetTitle>Didn't work — why?</SheetTitle>
        </SheetHeader>

        {item && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              <span className="text-foreground font-medium">{stripDayLabel(item.title)}</span>
              <br />
              {dayLabel}
            </p>

            {/* Reason chips — 2x2 grid on phone so each is big enough to tap.
                Selected chip uses the amber palette (matches the
                "didn't work" pill on the card). */}
            <div className="grid grid-cols-2 gap-2">
              {SKIP_REASON_ORDER.map((k) => {
                const Icon = SKIP_REASON_ICONS[k];
                const selected = kind === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={cn(
                      'flex items-center gap-2 h-12 px-3 rounded-xl border text-sm font-medium transition-colors',
                      selected
                        ? 'bg-amber-100 border-amber-300 text-amber-900'
                        : 'bg-card border-border text-foreground hover:border-amber-200 hover:bg-amber-50/50',
                    )}
                  >
                    <Icon size={16} strokeWidth={1.8} className={selected ? 'text-amber-700' : 'text-muted-foreground'} />
                    {SKIP_REASON_LABELS[k]}
                  </button>
                );
              })}
            </div>

            {/* Optional note. Visible always so the user can add context to
                any reason ("ran into asbestos", "kids' birthday party").
                Only REQUIRED for 'other' — the label changes to make that
                clear. */}
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                {kind === 'other' ? 'Note *' : 'Note (optional)'}
              </label>
              <Textarea
                placeholder={kind === 'other'
                  ? 'What happened?'
                  : 'Any extra context (optional)'
                }
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="resize-none text-sm"
              />
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1 h-11" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                className="flex-1 h-11 bg-amber-600 hover:bg-amber-700 text-white"
                disabled={!valid}
                onClick={() => kind && onConfirm(kind, note)}
              >
                Mark as didn't work
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function RunBar({
  run,
  cellDate,
  job,
}: {
  run: ItemRun;
  cellDate: string;
  job?: { name: string } | undefined;
}) {
  const config = TYPE_CONFIG[run.head.type];
  // Per-job colour wins over the type colour, so two concurrent jobs are
  // visually distinguishable. Jobless items (bills/reminders) keep their
  // type-based colour via colorFor's fallback.
  const { bar } = colorFor(run.head);
  const isStart = run.startDate === cellDate;
  const isEnd = run.endDate === cellDate;
  const Icon = config.icon;
  // Bar squares off on the side where the run continues, rounds where it ends.
  // Skipped days fade just like completed ones so the calendar reads
  // "this scheduled day is no longer pending action" at a glance.
  const isSkipped = !!run.head.skipReasonKind;
  return (
    <div
      className={cn(
        'h-4 sm:h-5 px-1 flex items-center gap-1 text-[9px] sm:text-[10px] font-medium text-white truncate',
        bar,
        (run.allCompleted || isSkipped) && 'opacity-50',
        isStart ? 'rounded-l-sm' : 'rounded-l-none -ml-1 pl-2',
        isEnd ? 'rounded-r-sm' : 'rounded-r-none -mr-1 pr-2',
      )}
      title={
        isSkipped
          ? `${stripDayLabel(run.head.title)} · ${SKIP_REASON_LABELS[run.head.skipReasonKind!] ?? 'Skipped'}${run.head.skipReason ? ' — ' + run.head.skipReason : ''}`
          : `${stripDayLabel(run.head.title)}${job ? ' · ' + job.name : ''}`
      }
    >
      {isStart && (
        <>
          <Icon size={9} strokeWidth={2.5} className="shrink-0" />
          <span className="truncate">{stripDayLabel(run.head.title)}</span>
        </>
      )}
    </div>
  );
}

/**
 * Calendar bar for an hours entry that has no matching schedule item on that
 * day. Visually quieter than RunBar — uses the per-job colour as a light
 * background + dark text (vs RunBar's saturated fill + white text) so plan
 * vs actuals is legible at a glance.
 */
function HoursBarForJob({
  hours,
  jobName,
  bgLight,
  text,
  bar,
}: {
  hours: number;
  jobName: string;
  bgLight: string;
  text: string;
  bar: string;
}) {
  return (
    <div
      className={cn(
        'h-4 sm:h-5 px-1 rounded-sm flex items-center gap-1 text-[9px] sm:text-[10px] font-medium truncate border-l-2',
        bgLight,
        text,
      )}
      style={{ borderLeftColor: 'currentColor' }}
      title={`${hours}h logged · ${jobName}`}
    >
      <Clock size={9} strokeWidth={2.5} className="shrink-0" />
      <span className="truncate">
        {hours}h · {jobName}
      </span>
      {/* Mark the bar end with the saturated colour as a tiny tag, so the
          per-job hue is unmistakable even when the light tint reads as grey
          on some screens. */}
      <span className={cn('w-1 h-1 rounded-full ml-auto shrink-0', bar)} aria-hidden />
    </div>
  );
}

/** Same shape but for hours entries with no jobId — a neutral grey treatment. */
function HoursBarNoJob({ hours }: { hours: number }) {
  return (
    <div
      className="h-4 sm:h-5 px-1 rounded-sm flex items-center gap-1 text-[9px] sm:text-[10px] font-medium truncate border-l-2 border-slate-400 bg-slate-100 text-slate-700"
      title={`${hours}h logged`}
    >
      <Clock size={9} strokeWidth={2.5} className="shrink-0" />
      <span className="truncate">{hours}h logged</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADD FORM — unchanged from previous version
// ─────────────────────────────────────────────────────────────────────────────

const SCHEDULE_TYPES: { value: ScheduleItemType; label: string }[] = [
  { value: 'job_booking', label: 'Job booking' },
  { value: 'quote_visit', label: 'Quote visit' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'bill_due', label: 'Bill due' },
  { value: 'invoice_due', label: 'Invoice due' },
  { value: 'reminder', label: 'Reminder' },
];

function AddScheduleForm({
  jobs,
  initialType,
  onSave,
  onCancel,
  defaultDate,
}: {
  jobs: Job[];
  /**
   * Optional pre-selected schedule type. When set, the form opens with
   * this type already selected. Used by the ?quickAdd= deep link from
   * the Entry page's "Schedule a site visit" tile.
   */
  initialType?: ScheduleItemType;
  onSave: (items: Omit<ScheduleItem, 'id' | 'businessId' | 'createdAt'>[]) => void;
  onCancel: () => void;
  /** Pre-fill the date field. Used when the form is opened from a tapped
   *  calendar day in the day-detail sheet. */
  defaultDate?: string;
}) {
  // Pulled in so the inline "Create job" mini-form can mint a new Job
  // row from this sheet without bouncing the user out to the Jobs page.
  // 5:30pm-tired-painter rule: don't make Brad navigate away from the
  // schedule entry he's halfway through to set up the job he just
  // remembered needs to exist.
  const { addJob, businessId } = useStore();

  const [type, setType] = useState<ScheduleItemType>(initialType ?? 'job_booking');
  const [title, setTitle] = useState('');
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(defaultDate ?? today);
  const [endDate, setEndDate] = useState('');
  const [multiDay, setMultiDay] = useState(false);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [jobId, setJobId] = useState('');
  const [notes, setNotes] = useState('');

  // Inline "Create job" mini-form state. `creating` flips on when the
  // user picks the synthetic "__create__" sentinel from the Job select;
  // it stays on until they either save the new job (we auto-select its
  // persisted id) or hit Cancel. Single name field by design — keeping
  // this to one tap-target avoids a wizard-inside-a-sheet.
  const [creating, setCreating] = useState(false);
  const [creatingName, setCreatingName] = useState('');
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [creatingError, setCreatingError] = useState<string | null>(null);

  /**
   * Mint a new Job and auto-select it in the Job picker. Status follows
   * the schedule item's type: a job_booking implies the work is already
   * confirmed, so we default to 'booked'; everything else (quote visit,
   * reminder, follow-up, …) defaults to the lower-commitment 'lead'.
   * Brad can re-stage the status from the Jobs page later if needed.
   */
  async function handleCreateJob() {
    const name = creatingName.trim();
    if (!name) return;
    setCreatingBusy(true);
    setCreatingError(null);
    const defaultStatus = type === 'job_booking' ? 'booked' : 'lead';
    const tempId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const persisted = await addJob({
      id: tempId,
      businessId: businessId ?? '',
      name,
      // clientName is required on the Job interface but we don't have
      // it here — empty string is fine for a freshly-minted lead/booking
      // and the Jobs page treats it as "unknown client". Brad can fill
      // it in when he writes up the job.
      clientName: '',
      status: defaultStatus,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    setCreatingBusy(false);
    if (!persisted) {
      // addJob already surfaces the error onto the store; mirror it on
      // the inline form so the user gets feedback right where they
      // tapped — the global toast/error indicator isn't visible inside
      // an open Sheet.
      setCreatingError('Could not save job. Try again.');
      return;
    }
    setJobId(persisted.id);
    setCreating(false);
    setCreatingName('');
  }

  const supportsRange = type === 'job_booking' || type === 'quote_visit' || type === 'reminder';

  const ranked = useMemo(() => rankJobs(jobs), [jobs]);

  const jobNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const j of jobs) map[j.id] = j.name;
    return map;
  }, [jobs]);

  const effectiveEnd = multiDay && endDate ? endDate : date;
  const dayCount = multiDay ? datesBetween(date, effectiveEnd).length : 1;

  const typeLabels: Record<string, string> = Object.fromEntries(
    SCHEDULE_TYPES.map((t) => [t.value, t.label])
  );

  const TIER_LABELS: Record<string, string> = {
    'active-match':      'Best matches',
    'active':            'Active',
    'recent':            'Recently completed',
    'older':             'Older',
  };

  function handleSubmit() {
    const days = multiDay && endDate
      ? datesBetween(date, endDate)
      : [date];

    const items = days.map((d, i) => ({
      type,
      title:
        days.length > 1 && type === 'job_booking'
          ? `${title.trim()} (Day ${i + 1}/${days.length})`
          : title.trim(),
      date: d,
      startTime: startTime || undefined,
      endTime: endTime || undefined,
      jobId: jobId || undefined,
      notes: notes || undefined,
      completed: false,
    }));
    onSave(items);
  }

  return (
    <div className="space-y-3">
      <FormField label="Type">
        <Select value={type} onValueChange={(v) => setType(v as ScheduleItemType)}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue>
              {(value) => typeLabels[value as string] ?? 'Type'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <FormField label="Title *">
        <FormInput placeholder="e.g. Smith Exterior - Day 1" value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormField>

      {multiDay ? (
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Start date *">
            <FormInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <FormField label="End date *">
            <FormInput
              type="date"
              value={endDate}
              min={date}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </FormField>
        </div>
      ) : (
        <FormField label="Date *">
          <FormInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </FormField>
      )}

      {supportsRange && (
        <button
          type="button"
          onClick={() => {
            const next = !multiDay;
            setMultiDay(next);
            if (next && !endDate) setEndDate(date);
          }}
          className="flex items-center gap-2 text-xs text-primary py-1"
        >
          <span
            className={cn(
              'w-4 h-4 rounded border flex items-center justify-center',
              multiDay ? 'bg-primary border-primary text-white' : 'border-input'
            )}
          >
            {multiDay ? <CheckCircle2 size={12} /> : null}
          </span>
          Book over multiple days
          {multiDay && dayCount > 1 && (
            <span className="text-muted-foreground">
              · {dayCount} day{dayCount === 1 ? '' : 's'}
            </span>
          )}
        </button>
      )}

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Start time">
          <FormInput type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </FormField>
        <FormField label="End time">
          <FormInput type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </FormField>
      </div>

      <FormField label="Job (optional)">
        <Select
          value={jobId}
          onValueChange={(v) => {
            // "__create__" is a sentinel value — when chosen, open the
            // inline mini-form instead of writing it into jobId. Anything
            // else (real job id, '' for "No job") flows through normally.
            if (v === '__create__') {
              setCreating(true);
              setCreatingError(null);
              return;
            }
            setJobId(v ?? '');
          }}
        >
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="No job">
              {(value) => {
                if (!value) return 'No job';
                return jobNameById[value as string] ?? 'No job';
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">No job</SelectItem>
            {/* Synthetic "Create new job…" row. Sits at the top of the
                list so it's the first non-"No job" option Brad sees. The
                "__create__" value is intercepted in onValueChange above —
                it never lands in jobId state. */}
            <SelectItem value="__create__">
              <span className="flex items-center gap-1.5 text-primary font-medium">
                <Plus size={12} strokeWidth={2.4} />
                Create new job…
              </span>
            </SelectItem>
            {(() => {
              const tiers: Array<'active-match' | 'active' | 'recent' | 'older'> = [
                'active-match', 'active', 'recent', 'older',
              ];
              const hasActive = ranked.some((r) => r.tier === 'active' || r.tier === 'active-match');
              const selectedIsOlder = !!jobId && ranked.find((r) => r.job.id === jobId)?.tier === 'older';

              return tiers.flatMap((tier) => {
                const items = ranked.filter((r) => r.tier === tier);
                if (items.length === 0) return [];
                if (tier === 'older' && hasActive && !selectedIsOlder) return [];
                return [
                  <div
                    key={`${tier}-label`}
                    className="px-2 pt-2 pb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide"
                  >
                    {TIER_LABELS[tier]}
                  </div>,
                  ...items.map((r) => (
                    <SelectItem key={r.job.id} value={r.job.id}>
                      {r.job.name}
                    </SelectItem>
                  )),
                ];
              });
            })()}
          </SelectContent>
        </Select>

        {/* Inline "Create job" mini-form. Single name field + Create /
            Cancel buttons. On Create we mint the job, then auto-select
            its persisted UUID into the picker above so the schedule
            item gets tied to it on Save. Status defaults follow the
            schedule type (job_booking → booked, otherwise lead). */}
        {creating && (
          <div className="mt-2 rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide block">
              New job name
            </label>
            <FormInput
              autoFocus
              placeholder="e.g. Cromwell Races Admin Building"
              value={creatingName}
              onChange={(e) => setCreatingName(e.target.value)}
              onKeyDown={(e) => {
                // Enter = Create when the name has content, so the user
                // can do the whole thing keyboard-only on desktop.
                if (e.key === 'Enter' && creatingName.trim() && !creatingBusy) {
                  e.preventDefault();
                  handleCreateJob();
                }
              }}
            />
            {creatingError && (
              <p className="text-xs text-red-600">{creatingError}</p>
            )}
            <p className="text-[11px] text-muted-foreground">
              Status will default to{' '}
              <span className="font-medium text-foreground">
                {type === 'job_booking' ? 'Booked' : 'Lead'}
              </span>
              . Add client, location and quote details on the Jobs page later.
            </p>
            <div className="flex gap-2 pt-0.5">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 h-9"
                onClick={() => {
                  setCreating(false);
                  setCreatingName('');
                  setCreatingError(null);
                }}
                disabled={creatingBusy}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="flex-1 h-9 bg-primary"
                onClick={handleCreateJob}
                disabled={!creatingName.trim() || creatingBusy}
              >
                {creatingBusy ? 'Creating…' : 'Create job'}
              </Button>
            </div>
          </div>
        )}
      </FormField>

      <FormField label="Notes">
        <Textarea
          placeholder="Any details..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="resize-none text-sm"
          rows={2}
        />
      </FormField>

      <div className="flex gap-2 pt-1">
        <Button variant="outline" className="flex-1" onClick={onCancel}>Cancel</Button>
        <Button
          className="flex-1 bg-primary"
          disabled={
            !title.trim() ||
            !date ||
            (multiDay && (!endDate || parseISODate(endDate) < parseISODate(date)))
          }
          onClick={handleSubmit}
        >
          {multiDay && dayCount > 1 ? `Save ${dayCount} days` : 'Save'}
        </Button>
      </div>
    </div>
  );
}
