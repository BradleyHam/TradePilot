'use client';

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { Job, ScheduleItem, ScheduleItemType, Entry } from '@/lib/types';
import { rankJobs } from '@/lib/job-match';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { EntryForm } from '@/components/entry/entry-form';
import { EditScheduleItemSheet, ScheduleEditTarget } from '@/components/schedule/edit-schedule-item-sheet';
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
  Clock,
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

  function openEdit(items: ScheduleItem[]) {
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
  const [showAdd, setShowAdd] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

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
    // Mark every item in the run completed. Single-day items just flip one row.
    for (const it of run.items) {
      if (!it.completed) updateScheduleItem(it.id, { completed: true });
    }
  }

  function handleAdd(items: Omit<ScheduleItem, 'id' | 'businessId' | 'createdAt'>[]) {
    const baseTs = Date.now();
    items.forEach((data, i) => {
      addScheduleItem({
        id: `sch_${baseTs}_${i}`,
        businessId: businessId ?? '',
        createdAt: new Date().toISOString(),
        ...data,
      });
    });
    setShowAdd(false);
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
            onLogHours={handleAddEntry}
            onScheduleItems={handleScheduleFromDay}
          />
        )}
      </div>

      {/* Add schedule sheet */}
      <Sheet open={showAdd} onOpenChange={setShowAdd}>
        <SheetContent side="bottom" className="h-[85vh] overflow-y-auto rounded-t-2xl px-4 pb-10">
          <SheetHeader className="pb-4">
            <SheetTitle>Add schedule item</SheetTitle>
          </SheetHeader>
          <AddScheduleForm jobs={jobs} onSave={handleAdd} onCancel={() => setShowAdd(false)} />
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
}: {
  runs: ItemRun[];
  completedRuns: ItemRun[];
  jobs: Job[];
  onComplete: (run: ItemRun) => void;
  onEdit: (items: ScheduleItem[]) => void;
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
}: {
  run: ItemRun;
  job?: { name: string } | undefined;
  onComplete: () => void;
  onEdit?: () => void;
}) {
  const config = TYPE_CONFIG[run.head.type];
  const Icon = config.icon;
  const startDate = parseISO(run.startDate);
  const endDate = parseISO(run.endDate);
  const overdue = isPast(endDate) && !isToday(endDate) && !run.allCompleted;
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
      overdue && !run.allCompleted && 'border-red-200 bg-red-50/30',
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
        </div>
        {run.head.notes && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{run.head.notes}</p>
        )}
      </div>

      {!run.allCompleted && (
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
  const overdue = isPast(parseISO(item.date)) && !isToday(parseISO(item.date)) && !item.completed;
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
        </div>
      </div>
      {!item.completed && (
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
  onLogHours,
  onScheduleItems,
}: {
  items: ScheduleItem[];
  jobs: Job[];
  hoursByDate: Map<string, Entry[]>;
  onComplete: (run: ItemRun) => void;
  onEditHours: (entryId: string) => void;
  onEdit: (items: ScheduleItem[]) => void;
  /** Called when the user logs hours inline from the day-detail sheet
   *  (only offered for past/today dates). */
  onLogHours: (entry: Omit<Entry, 'id' | 'businessId' | 'createdAt'>) => void;
  /** Called when the user schedules work inline from the day-detail sheet
   *  (only offered for today/future dates). */
  onScheduleItems: (items: Omit<ScheduleItem, 'id' | 'businessId' | 'createdAt'>[]) => void;
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
                            onComplete={() => onComplete({
                              head: it, items: [it], startDate: it.date, endDate: it.date,
                              days: 1, allCompleted: it.completed,
                            })}
                            onEdit={() => {
                              // Close the day-detail sheet before opening the
                              // editor so we never have two sheets stacked.
                              const run = runByItemId.get(it.id);
                              setSelectedDay(null);
                              onEdit(run ? run.items : [it]);
                            }}
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
  return (
    <div
      className={cn(
        'h-4 sm:h-5 px-1 flex items-center gap-1 text-[9px] sm:text-[10px] font-medium text-white truncate',
        bar,
        run.allCompleted && 'opacity-50',
        isStart ? 'rounded-l-sm' : 'rounded-l-none -ml-1 pl-2',
        isEnd ? 'rounded-r-sm' : 'rounded-r-none -mr-1 pr-2',
      )}
      title={`${stripDayLabel(run.head.title)}${job ? ' · ' + job.name : ''}`}
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
  onSave,
  onCancel,
  defaultDate,
}: {
  jobs: Job[];
  onSave: (items: Omit<ScheduleItem, 'id' | 'businessId' | 'createdAt'>[]) => void;
  onCancel: () => void;
  /** Pre-fill the date field. Used when the form is opened from a tapped
   *  calendar day in the day-detail sheet. */
  defaultDate?: string;
}) {
  const [type, setType] = useState<ScheduleItemType>('job_booking');
  const [title, setTitle] = useState('');
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(defaultDate ?? today);
  const [endDate, setEndDate] = useState('');
  const [multiDay, setMultiDay] = useState(false);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [jobId, setJobId] = useState('');
  const [notes, setNotes] = useState('');

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
        <Select value={jobId} onValueChange={(v) => setJobId(v ?? '')}>
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
