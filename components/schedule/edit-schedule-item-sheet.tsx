'use client';

import { useMemo, useState } from 'react';
import { Job, ScheduleItem, ScheduleItemType } from '@/lib/types';
import { useStore } from '@/lib/store';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Trash2, CheckCircle2, Scissors } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';

// ── Date helpers (kept local so this component is self-contained, mirroring
// the helpers already used by app/(app)/schedule/page.tsx). Stays in local
// time so a range straddling DST doesn't drift. ─────────────────────────
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
function addDaysISO(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return formatISODate(d);
}
/**
 * All ISO dates between start and end inclusive, filtered to the supplied
 * day-of-week set. `daysOfWeek` is a Set of JS day numbers (0=Sun..6=Sat).
 *
 * The fallback when end < start mirrors the existing schedule helper: we
 * keep just the start date so we never produce an empty range and silently
 * drop the user's intent.
 */
function datesBetweenForDays(
  startISO: string,
  endISO: string,
  daysOfWeek: Set<number>,
): string[] {
  const start = parseISODate(startISO);
  const end = parseISODate(endISO);
  if (end < start) {
    return daysOfWeek.has(start.getDay()) ? [startISO] : [];
  }
  const out: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    if (daysOfWeek.has(cur.getDay())) {
      out.push(formatISODate(cur));
    }
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// ── Form atoms (44px-height inputs — 5:30pm-painter rule) ─────────────────
function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
        {label}
      </label>
      {children}
    </div>
  );
}

function FormInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    />
  );
}

// ── Day-of-week presets ──────────────────────────────────────────────────
// JS Date.getDay() returns 0=Sun, 1=Mon, … 6=Sat. We use the same convention
// throughout so the saved dates round-trip cleanly.
const DOW_MON_SAT = new Set([1, 2, 3, 4, 5, 6]);
const DOW_MON_FRI = new Set([1, 2, 3, 4, 5]);
const DOW_EVERY = new Set([0, 1, 2, 3, 4, 5, 6]);

type Preset = 'mon-sat' | 'mon-fri' | 'every' | 'custom';
const PRESETS: { value: Preset; label: string; set: Set<number> | null }[] = [
  { value: 'mon-sat', label: 'Mon–Sat', set: DOW_MON_SAT },
  { value: 'mon-fri', label: 'Mon–Fri', set: DOW_MON_FRI },
  { value: 'every', label: 'Every day', set: DOW_EVERY },
  { value: 'custom', label: 'Custom', set: null },
];

// Day toggles use Mon-first ordering (NZ trade convention) so they read
// naturally when paired with the Mon–Sat/Mon–Fri presets.
const WEEKDAYS: { label: string; full: string; jsDay: number }[] = [
  { label: 'M', full: 'Monday',    jsDay: 1 },
  { label: 'T', full: 'Tuesday',   jsDay: 2 },
  { label: 'W', full: 'Wednesday', jsDay: 3 },
  { label: 'T', full: 'Thursday',  jsDay: 4 },
  { label: 'F', full: 'Friday',    jsDay: 5 },
  { label: 'S', full: 'Saturday',  jsDay: 6 },
  { label: 'S', full: 'Sunday',    jsDay: 0 },
];

/**
 * Which preset does this day-set match, if any? Lets us auto-select the
 * correct chip when opening the sheet on an existing booking.
 */
function presetFor(days: Set<number>): Preset {
  if (setsEqual(days, DOW_MON_SAT)) return 'mon-sat';
  if (setsEqual(days, DOW_MON_FRI)) return 'mon-fri';
  if (setsEqual(days, DOW_EVERY)) return 'every';
  return 'custom';
}
function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// ── Schedule-type labels (mirrors page.tsx) ──────────────────────────────
const TYPE_LABELS: Record<ScheduleItemType, string> = {
  job_booking: 'Job booking',
  quote_visit: 'Quote visit',
  follow_up: 'Follow-up',
  bill_due: 'Bill due',
  invoice_due: 'Invoice due',
  reminder: 'Reminder',
};

/** Schedule types where a date range + day-of-week pattern makes sense. */
const RANGE_TYPES: ScheduleItemType[] = ['job_booking', 'quote_visit', 'reminder'];

/** Strips a trailing "(Day N/M)" so titles round-trip cleanly when re-saved. */
function stripDayLabel(title: string): string {
  return title.replace(/\s*\(Day\s+\d+\s*\/\s*\d+\s*\)\s*$/i, '').trim();
}

// ── Props ────────────────────────────────────────────────────────────────
/**
 * A "run" passed in by the schedule page: the original group of consecutive
 * schedule items the user tapped on. We use the list (not just the head)
 * because:
 *   - the run determines the existing day-of-week pattern
 *   - the run determines the start/end of the range to pre-fill
 *   - we delete every item in the run on save (replace-not-merge semantics
 *     confirmed with Brad).
 */
export interface ScheduleEditTarget {
  items: ScheduleItem[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ScheduleEditTarget | null;
  jobs: Job[];
}

// ─────────────────────────────────────────────────────────────────────────
// Main sheet
// ─────────────────────────────────────────────────────────────────────────
export function EditScheduleItemSheet({ open, onOpenChange, target, jobs }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[90vh] overflow-y-auto rounded-t-2xl px-4 pb-10"
      >
        <SheetHeader className="pb-4">
          <SheetTitle>Edit schedule</SheetTitle>
        </SheetHeader>
        {target && (
          <EditForm
            target={target}
            jobs={jobs}
            onClose={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Form
// ─────────────────────────────────────────────────────────────────────────
function EditForm({
  target,
  jobs,
  onClose,
}: {
  target: ScheduleEditTarget;
  jobs: Job[];
  onClose: () => void;
}) {
  const { addScheduleItem, deleteScheduleItem, updateScheduleItem, businessId } =
    useStore();

  // Sort once so the first item is the run's start and the last is its end.
  // The schedule page passes already-sorted items, but we don't rely on it.
  const sorted = useMemo(
    () => [...target.items].sort((a, b) => a.date.localeCompare(b.date)),
    [target.items],
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const supportsRange = RANGE_TYPES.includes(first.type);

  // Form state — initialised from the run's representative item.
  const [title, setTitle] = useState(stripDayLabel(first.title));
  const [startDate, setStartDate] = useState(first.date);
  const [endDate, setEndDate] = useState(last.date);
  const [startTime, setStartTime] = useState(first.startTime ?? '');
  const [endTime, setEndTime] = useState(first.endTime ?? '');
  const [jobId, setJobId] = useState(first.jobId ?? '');
  const [notes, setNotes] = useState(first.notes ?? '');
  const [completed, setCompleted] = useState(
    sorted.every((i) => i.completed),
  );

  // Day-of-week pattern: infer from the actual dates the existing run hit.
  // If the user tapped a single-day item the inferred set is just that one
  // day, so we default to Mon–Sat instead — the sensible "tradie default"
  // confirmed with Brad.
  const initialDays = useMemo(() => {
    if (sorted.length <= 1) return new Set(DOW_MON_SAT);
    const s = new Set<number>();
    for (const it of sorted) s.add(parseISODate(it.date).getDay());
    return s;
  }, [sorted]);

  const [days, setDays] = useState<Set<number>>(initialDays);
  const [preset, setPreset] = useState<Preset>(() => presetFor(initialDays));

  // Split mode — when true, the form swaps for a cutoff-date picker. Only
  // offered for multi-day job_booking runs (a single-day or non-job run
  // has nothing meaningful to split).
  const [splitMode, setSplitMode] = useState(false);
  const canSplit = first.type === 'job_booking' && sorted.length > 1;

  function applyPreset(next: Preset) {
    setPreset(next);
    const found = PRESETS.find((p) => p.value === next);
    if (found?.set) setDays(new Set(found.set));
    // 'custom' keeps the current set — the user edits it below.
  }

  function toggleDay(jsDay: number) {
    const next = new Set(days);
    if (next.has(jsDay)) next.delete(jsDay);
    else next.add(jsDay);
    setDays(next);
    setPreset(presetFor(next));
  }

  // Live preview: which dates will be created when the user hits Save?
  const previewDates = useMemo(() => {
    if (!supportsRange) return [startDate];
    return datesBetweenForDays(startDate, endDate || startDate, days);
  }, [startDate, endDate, days, supportsRange]);

  const jobNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const j of jobs) map[j.id] = j.name;
    return map;
  }, [jobs]);

  const dayCount = previewDates.length;

  // Validation: range must be coherent, day set non-empty when ranging.
  const valid =
    !!title.trim() &&
    !!startDate &&
    (!supportsRange ||
      (!!endDate &&
        parseISODate(endDate) >= parseISODate(startDate) &&
        days.size > 0));

  function handleSave() {
    if (!businessId || !valid) return;

    // Single-day, non-range type — just update the existing row in place so
    // we keep its id, history, and any linked records. No need to delete +
    // recreate when nothing about the day-of-week pattern matters.
    if (!supportsRange && sorted.length === 1) {
      updateScheduleItem(first.id, {
        title: title.trim(),
        date: startDate,
        startTime: startTime || undefined,
        endTime: endTime || undefined,
        jobId: jobId || undefined,
        notes: notes || undefined,
        completed,
      });
      onClose();
      return;
    }

    // Range case — delete + recreate. Matches the existing BookedDates
    // pattern and what we confirmed with Brad. We lose per-day completed
    // state on purpose; if everything in the run was complete the new
    // items inherit that, otherwise they all start as not-done.
    for (const it of sorted) deleteScheduleItem(it.id);

    const dates = supportsRange ? previewDates : [startDate];
    dates.forEach((d, i) => {
      addScheduleItem({
        // Real uuid client-side — schedule_items.id is a uuid column in
        // Supabase. Using "sch_<ts>" string ids would race against the
        // post-insert id-swap if any code tries to update the row before
        // the insert response lands. See schedule/page.tsx handleAdd.
        id: crypto.randomUUID(),
        businessId,
        createdAt: new Date().toISOString(),
        type: first.type,
        // Title gets "(Day N/M)" suffix only for job_booking multi-day runs
        // — that's the convention the rest of the app uses (see schedule
        // page's groupRuns + stripDayLabel).
        title:
          dates.length > 1 && first.type === 'job_booking'
            ? `${title.trim()} (Day ${i + 1}/${dates.length})`
            : title.trim(),
        date: d,
        startTime: startTime || undefined,
        endTime: endTime || undefined,
        jobId: jobId || undefined,
        notes: notes || undefined,
        completed,
      });
    });

    onClose();
  }

  function handleDelete() {
    const msg =
      sorted.length === 1
        ? 'Delete this schedule item?'
        : `Delete all ${sorted.length} days of this booking?`;
    if (!confirm(msg)) return;
    for (const it of sorted) deleteScheduleItem(it.id);
    onClose();
  }

  /**
   * Split this run in two at the chosen cutoff date. The keeper block is
   * everything on or before cutoff; everything after is deleted. After
   * splitting, the user can add a second range from the calendar's Add
   * button (typically picking the resumption date for postponed work).
   *
   * We renumber the keeper's "(Day X/N)" titles so the calendar's
   * groupRuns + stripDayLabel pipeline keeps treating them as one run.
   */
  function handleSplit(cutoffISO: string) {
    const keep = sorted.filter((it) => it.date <= cutoffISO);
    const drop = sorted.filter((it) => it.date > cutoffISO);
    if (keep.length === 0) return;

    for (const it of drop) deleteScheduleItem(it.id);

    // Renumber the keeper block so titles read "Day 1/3" etc. — matches
    // what booked-dates.tsx and BookedDatesForm produce so groupRuns +
    // stripDayLabel keep treating them as one run.
    const baseTitle = stripDayLabel(first.title);
    keep.forEach((it, i) => {
      const newTitle = keep.length > 1
        ? `${baseTitle} (Day ${i + 1}/${keep.length})`
        : baseTitle;
      if (it.title !== newTitle) updateScheduleItem(it.id, { title: newTitle });
    });

    onClose();
  }

  // Split-mode UI takes over the whole sheet so the user isn't confused
  // about which buttons apply. Cancel returns to the normal edit view.
  if (splitMode) {
    return (
      <SplitForm
        items={sorted}
        onCancel={() => setSplitMode(false)}
        onConfirm={handleSplit}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Type — read-only label. Changing type would mean a different edit
          flow entirely (e.g. bills go through a different module). */}
      <div className="text-xs text-muted-foreground">
        Type: <span className="font-medium text-foreground">{TYPE_LABELS[first.type]}</span>
      </div>

      <FormField label="Title *">
        <FormInput
          placeholder="e.g. Smith Exterior"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </FormField>

      {/* Date(s) */}
      {supportsRange ? (
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Start date *">
            <FormInput
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (
                  endDate &&
                  parseISODate(endDate) < parseISODate(e.target.value)
                ) {
                  setEndDate(e.target.value);
                }
                if (!endDate) setEndDate(e.target.value);
              }}
            />
          </FormField>
          <FormField label="End date *">
            <FormInput
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </FormField>
        </div>
      ) : (
        <FormField label="Date *">
          <FormInput
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </FormField>
      )}

      {/* Day-of-week pattern — only shown for range-capable types */}
      {supportsRange && (
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Working days
          </label>

          {/* Preset chips */}
          <div className="flex flex-wrap gap-2 mb-2">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => applyPreset(p.value)}
                className={cn(
                  'h-9 px-3 rounded-lg text-sm font-medium border transition-colors',
                  preset === p.value
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/30',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Day toggles — always visible so the user can see the current
              pattern at a glance, but tappable mainly when in "Custom"
              mode. Tapping a toggle in any mode switches to Custom and
              updates the set. */}
          <div className="flex gap-1.5">
            {WEEKDAYS.map((w) => {
              const selected = days.has(w.jsDay);
              return (
                <button
                  key={`${w.jsDay}-${w.full}`}
                  type="button"
                  onClick={() => toggleDay(w.jsDay)}
                  aria-pressed={selected}
                  title={w.full}
                  className={cn(
                    'flex-1 h-11 rounded-lg text-sm font-semibold border transition-colors',
                    selected
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/30',
                  )}
                >
                  {w.label}
                </button>
              );
            })}
          </div>

          <p className="text-xs text-muted-foreground mt-2">
            {dayCount === 0
              ? 'No working days selected — nothing will be scheduled.'
              : dayCount === 1
              ? '1 day in range'
              : `${dayCount} days in range`}
          </p>
        </div>
      )}

      {/* Times */}
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Start time">
          <FormInput
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
        </FormField>
        <FormField label="End time">
          <FormInput
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
          />
        </FormField>
      </div>

      {/* Linked job */}
      <FormField label="Job (optional)">
        <Select value={jobId} onValueChange={(v) => setJobId(v ?? '')}>
          <SelectTrigger className="h-11 text-sm">
            <SelectValue placeholder="No job">
              {(value) => {
                if (!value) return 'No job';
                return jobNameById[value as string] ?? 'No job';
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">No job</SelectItem>
            {jobs.map((j) => (
              <SelectItem key={j.id} value={j.id}>
                {j.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <FormField label="Notes">
        <Textarea
          placeholder="Access, parking, paint colour, etc."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="resize-none text-sm"
          rows={2}
        />
      </FormField>

      {/* Completed toggle — only when editing a single item. For multi-day
          runs the schedule page's "Mark done" button handles bulk-complete
          (and per-day done state is preserved separately). */}
      {sorted.length === 1 && (
        <button
          type="button"
          onClick={() => setCompleted((c) => !c)}
          className="flex items-center gap-2 text-sm py-1"
        >
          <span
            className={cn(
              'w-5 h-5 rounded border flex items-center justify-center',
              completed
                ? 'bg-primary border-primary text-white'
                : 'border-input',
            )}
          >
            {completed && <CheckCircle2 size={14} />}
          </span>
          Mark as done
        </button>
      )}

      <div className="flex flex-col gap-2 pt-2">
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 h-11" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="flex-1 h-11 bg-primary"
            disabled={!valid}
            onClick={handleSave}
          >
            {supportsRange && dayCount > 1 ? `Save ${dayCount} days` : 'Save'}
          </Button>
        </div>
        {/* Split — only for multi-day job_booking runs. Lets the user
            postpone the back half of a job (weather, materials, customer
            request) without losing the front half they already worked. */}
        {canSplit && (
          <Button
            variant="ghost"
            className="h-11 text-orange-700 hover:text-orange-800 hover:bg-orange-50"
            onClick={() => setSplitMode(true)}
          >
            <Scissors size={16} className="mr-2" />
            Split into two blocks
          </Button>
        )}
        <Button
          variant="ghost"
          className="h-11 text-red-600 hover:text-red-700 hover:bg-red-50"
          onClick={handleDelete}
        >
          <Trash2 size={16} className="mr-2" />
          {sorted.length === 1 ? 'Delete' : `Delete all ${sorted.length} days`}
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Split form
// ─────────────────────────────────────────────────────────────────────────
/**
 * Choose the last day of the FIRST block. Everything after that date is
 * removed from this booking. The user can then add a second range later
 * (typically with the "spring" / resumption dates) from the calendar's
 * Add button, OR from the BookedDates panel on the job detail sheet.
 *
 * This mirrors the SplitForm in components/jobs/booked-dates.tsx so the
 * two surfaces behave the same way.
 */
function SplitForm({
  items,
  onCancel,
  onConfirm,
}: {
  items: ScheduleItem[];
  onCancel: () => void;
  onConfirm: (cutoffISO: string) => void;
}) {
  const first = items[0];
  const last = items[items.length - 1];

  // Default the cutoff to the day BEFORE the last day — the natural
  // majority of the original block stays as the keeper.
  const defaultCutoff = items.length > 1 ? items[items.length - 2].date : first.date;
  const [cutoff, setCutoff] = useState(defaultCutoff);

  // Cutoff must be inside the range AND leave at least one day on each
  // side (cutoff cannot equal the very last day).
  const valid = cutoff >= first.date && cutoff < last.date;

  const keepDays = items.filter((it) => it.date <= cutoff).length;
  const dropDays = items.filter((it) => it.date > cutoff).length;
  const resumeFromHint = addDaysISO(cutoff, 1);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Cut this block on the last day you worked. Everything scheduled
        after that day will be removed. You can add a second block later
        (e.g. when the work resumes in spring) by tapping <strong>+ Add</strong>
        on the calendar, or from the Booked dates section on the job page.
      </p>

      <FormField label="Last day of first block">
        <FormInput
          type="date"
          value={cutoff}
          min={first.date}
          max={last.date}
          onChange={(e) => setCutoff(e.target.value)}
        />
      </FormField>

      <div className="rounded-lg bg-muted/50 border border-border p-3 text-xs space-y-1">
        <p>
          <span className="text-muted-foreground">Block 1 keeps</span>{' '}
          <span className="font-medium text-foreground">{keepDays} day{keepDays === 1 ? '' : 's'}</span>
          {' '}({format(parseISO(first.date), 'EEE d MMM')} – {format(parseISO(cutoff), 'EEE d MMM')})
        </p>
        <p>
          <span className="text-muted-foreground">Removed:</span>{' '}
          <span className="text-muted-foreground">{dropDays} day{dropDays === 1 ? '' : 's'} from {format(parseISO(resumeFromHint), 'EEE d MMM')} onward</span>
        </p>
      </div>

      <div className="flex gap-2 pt-1">
        <Button variant="outline" className="flex-1 h-11" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          className="flex-1 h-11 bg-primary"
          disabled={!valid}
          onClick={() => onConfirm(cutoff)}
        >
          Split
        </Button>
      </div>
    </div>
  );
}
