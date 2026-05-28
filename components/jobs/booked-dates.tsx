'use client';

import { useMemo, useState } from 'react';
import { Job, ScheduleItem } from '@/lib/types';
import { useStore } from '@/lib/store';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { CalendarDays, Pencil, Briefcase, Scissors, Trash2, Plus } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';

interface BookedDatesProps {
  job: Job;
}

// ── Local date helpers (mirror the schedule page so behaviour matches) ──
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
function addDaysISO(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return formatISODate(d);
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
      className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    />
  );
}

/**
 * Booked dates section for the JobDetailSheet.
 *
 * Jobs can have MULTIPLE non-contiguous schedule blocks — e.g. a job paused
 * for winter and resumed in spring. Each contiguous run of job_booking
 * schedule items renders as its own card with Edit / Split / Remove actions.
 *
 * Underlying storage stays unchanged: one schedule_items row per day, all
 * carrying the same jobId. Grouping into "blocks" is purely a render-time
 * concept derived from consecutive dates. The calendar already uses
 * groupRuns() in schedule/page.tsx so two non-contiguous blocks naturally
 * render as two separate bars.
 */
export function BookedDates({ job }: BookedDatesProps) {
  const { scheduleItems, businessId, addScheduleItem, deleteScheduleItem, updateScheduleItem } = useStore();

  // Sheet state. `mode` controls what form opens:
  //   - { kind: 'add' }                  → add a brand-new block
  //   - { kind: 'edit', items: [...] }   → edit one existing block
  //   - { kind: 'split', items: [...] }  → split-at-cutoff prompt
  //   - null                             → no sheet
  type Mode =
    | { kind: 'add' }
    | { kind: 'edit'; items: ScheduleItem[] }
    | { kind: 'split'; items: ScheduleItem[] };
  const [mode, setMode] = useState<Mode | null>(null);

  // All job_booking items linked to this job, sorted ascending by date.
  const bookings = useMemo(() => {
    return scheduleItems
      .filter((s) => s.jobId === job.id && s.type === 'job_booking')
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [scheduleItems, job.id]);

  // Group consecutive-date rows into "blocks". A gap of more than 1 day
  // starts a new block. Same grouping spirit as groupRuns() on the
  // schedule page — keep them visually consistent.
  const blocks = useMemo(() => groupBlocks(bookings), [bookings]);

  const hasBlocks = blocks.length > 0;

  // Renumber every block's "Day X/N" titles after any structural change.
  // Done as a helper so split / edit / remove all stay consistent.
  function renumberBlock(blockItems: ScheduleItem[]) {
    const total = blockItems.length;
    blockItems.forEach((it, i) => {
      const title = total > 1 ? `${job.name} (Day ${i + 1}/${total})` : job.name;
      if (it.title !== title) updateScheduleItem(it.id, { title });
    });
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  function handleAddBlock(form: BookingFormValues) {
    if (!businessId) return;
    createBlockRows({
      job,
      businessId,
      form,
      addScheduleItem,
    });
    setMode(null);
  }

  function handleEditBlock(originalItems: ScheduleItem[], form: BookingFormValues) {
    if (!businessId) return;
    // Replace this block's rows. We delete+recreate (not patch) because the
    // date range can grow/shrink arbitrarily and per-row diffing is fiddly
    // when titles include "Day X/N" running totals. Other blocks' rows are
    // untouched.
    for (const it of originalItems) deleteScheduleItem(it.id);
    createBlockRows({
      job,
      businessId,
      form,
      addScheduleItem,
    });
    setMode(null);
  }

  function handleRemoveBlock(items: ScheduleItem[]) {
    if (!confirm(`Remove this scheduled block (${items.length} day${items.length === 1 ? '' : 's'})? Logged hours and invoices on this job are kept.`)) return;
    for (const it of items) deleteScheduleItem(it.id);
  }

  function handleSplit(items: ScheduleItem[], cutoffISO: string) {
    // Cutoff is the LAST day of the first half. Anything after cutoff is
    // removed and the user gets an empty "add second block" form prefilled
    // with no dates so they can choose when to resume.
    const keep = items.filter((it) => it.date <= cutoffISO);
    const drop = items.filter((it) => it.date > cutoffISO);

    if (keep.length === 0) return; // bad cutoff, do nothing
    for (const it of drop) deleteScheduleItem(it.id);

    // Renumber the keeper block so titles read "Day 1/3" etc.
    renumberBlock(keep);

    setMode(null);
    // After a split, immediately offer to schedule the second block.
    // Defer to next tick so the previous Sheet has a chance to close.
    setTimeout(() => setMode({ kind: 'add' }), 50);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Booked dates</p>
        {hasBlocks && (
          <button
            onClick={() => setMode({ kind: 'add' })}
            className="text-xs text-primary font-medium flex items-center gap-1"
          >
            <Plus size={12} /> Add block
          </button>
        )}
      </div>

      {hasBlocks ? (
        <div className="space-y-2">
          {blocks.map((b, idx) => (
            <BlockCard
              key={b[0].id}
              items={b}
              isMultiBlock={blocks.length > 1}
              blockNumber={idx + 1}
              totalBlocks={blocks.length}
              onEdit={() => setMode({ kind: 'edit', items: b })}
              onSplit={() => setMode({ kind: 'split', items: b })}
              onRemove={() => handleRemoveBlock(b)}
            />
          ))}
        </div>
      ) : (
        <Button
          variant="outline"
          className="w-full h-11 border-orange-300 bg-orange-50/50 text-orange-900 hover:bg-orange-100/60"
          onClick={() => setMode({ kind: 'add' })}
        >
          <CalendarDays size={16} className="mr-2 text-orange-600" strokeWidth={1.8} />
          Add booked dates
        </Button>
      )}

      {/* Add / Edit form sheet */}
      <Sheet open={mode?.kind === 'add' || mode?.kind === 'edit'} onOpenChange={(open) => !open && setMode(null)}>
        <SheetContent side="bottom" className="h-[85vh] overflow-y-auto rounded-t-2xl px-4 pb-10">
          <SheetHeader className="pb-4">
            <SheetTitle>
              {mode?.kind === 'edit' ? 'Edit booked dates' : 'Add booked dates'}
            </SheetTitle>
          </SheetHeader>
          <BookedDatesForm
            existing={mode?.kind === 'edit' ? mode.items : []}
            onCancel={() => setMode(null)}
            onSave={(form) => {
              if (mode?.kind === 'edit') handleEditBlock(mode.items, form);
              else handleAddBlock(form);
            }}
          />
        </SheetContent>
      </Sheet>

      {/* Split sheet */}
      <Sheet open={mode?.kind === 'split'} onOpenChange={(open) => !open && setMode(null)}>
        <SheetContent side="bottom" className="h-auto max-h-[85vh] overflow-y-auto rounded-t-2xl px-4 pb-10">
          <SheetHeader className="pb-4">
            <SheetTitle>Split this block</SheetTitle>
          </SheetHeader>
          {mode?.kind === 'split' && (
            <SplitForm
              items={mode.items}
              onCancel={() => setMode(null)}
              onConfirm={(cutoff) => handleSplit(mode.items, cutoff)}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ── Block card ─────────────────────────────────────────────────────────────

function BlockCard({
  items,
  isMultiBlock,
  blockNumber,
  totalBlocks,
  onEdit,
  onSplit,
  onRemove,
}: {
  items: ScheduleItem[];
  isMultiBlock: boolean;
  blockNumber: number;
  totalBlocks: number;
  onEdit: () => void;
  onSplit: () => void;
  onRemove: () => void;
}) {
  const summary = summariseBookings(items);
  // Split only makes sense when the block has 2+ days — splitting a
  // single-day block produces a 1-day keeper and a 0-day "rest", which
  // isn't useful.
  const canSplit = items.length > 1;

  return (
    <div className="rounded-xl bg-orange-50/60 border border-orange-200 overflow-hidden">
      <div className="flex items-start gap-3 p-3">
        <div className="w-9 h-9 rounded-xl bg-orange-100 flex items-center justify-center shrink-0">
          <Briefcase size={17} className="text-orange-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          {isMultiBlock && (
            <p className="text-[10px] font-semibold uppercase tracking-wide text-orange-700 mb-0.5">
              Block {blockNumber} of {totalBlocks}
            </p>
          )}
          <p className="text-sm font-medium text-foreground">{summary.rangeLabel}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {summary.timeLabel}
            {summary.dayCount > 1 && <> · {summary.dayCount} days</>}
          </p>
        </div>
      </div>
      {/* Action strip — sits at the bottom of the card so the three actions
          are equally weighted and don't compete with the summary line. */}
      <div className="flex border-t border-orange-200/70 divide-x divide-orange-200/70">
        <button
          onClick={onEdit}
          className="flex-1 flex items-center justify-center gap-1.5 h-9 text-xs font-medium text-orange-900 hover:bg-orange-100/60 transition-colors"
        >
          <Pencil size={12} /> Edit
        </button>
        {canSplit && (
          <button
            onClick={onSplit}
            className="flex-1 flex items-center justify-center gap-1.5 h-9 text-xs font-medium text-orange-900 hover:bg-orange-100/60 transition-colors"
            title="Split this block into two — e.g. pause and resume later"
          >
            <Scissors size={12} /> Split
          </button>
        )}
        <button
          onClick={onRemove}
          className="flex-1 flex items-center justify-center gap-1.5 h-9 text-xs font-medium text-red-700 hover:bg-red-50 transition-colors"
        >
          <Trash2 size={12} /> Remove
        </button>
      </div>
    </div>
  );
}

// ── Add/Edit form ──────────────────────────────────────────────────────────

interface BookingFormValues {
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  notes: string;
}

function BookedDatesForm({
  existing,
  onSave,
  onCancel,
}: {
  existing: ScheduleItem[];
  onSave: (form: BookingFormValues) => void;
  onCancel: () => void;
}) {
  // Pre-fill from existing block if editing. Otherwise default to today.
  const today = new Date().toISOString().split('T')[0];
  const firstExisting = existing[0];
  const lastExisting = existing[existing.length - 1];

  const [startDate, setStartDate] = useState(firstExisting?.date ?? today);
  const [endDate, setEndDate] = useState(lastExisting?.date ?? firstExisting?.date ?? today);
  const [startTime, setStartTime] = useState(firstExisting?.startTime ?? '');
  const [endTime, setEndTime] = useState(firstExisting?.endTime ?? '');
  const [notes, setNotes] = useState(firstExisting?.notes ?? '');

  const dayCount = datesBetween(startDate, endDate || startDate).length;
  const valid = !!startDate && (!endDate || parseISODate(endDate) >= parseISODate(startDate));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Start date *">
          <FormInput
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              // If end date is before the new start date, snap it forward.
              if (endDate && parseISODate(endDate) < parseISODate(e.target.value)) {
                setEndDate(e.target.value);
              }
              // If end date is empty, default it to start date for convenience.
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

      {dayCount > 1 && (
        <p className="text-xs text-muted-foreground -mt-1">
          {dayCount} consecutive days
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Start time">
          <FormInput type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </FormField>
        <FormField label="End time">
          <FormInput type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </FormField>
      </div>

      <FormField label="Notes">
        <Textarea
          placeholder="Access, parking, paint colour, etc."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="resize-none text-sm"
          rows={2}
        />
      </FormField>

      <div className="flex gap-2 pt-1">
        <Button variant="outline" className="flex-1 h-11" onClick={onCancel}>Cancel</Button>
        <Button
          className={cn('flex-1 h-11 bg-primary')}
          disabled={!valid}
          onClick={() => onSave({ startDate, endDate: endDate || startDate, startTime, endTime, notes })}
        >
          {dayCount > 1 ? `Save ${dayCount} days` : 'Save'}
        </Button>
      </div>
    </div>
  );
}

// ── Split form ─────────────────────────────────────────────────────────────

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

  // Default the cutoff to the day BEFORE the last day so the keeper block
  // is the natural majority of the original block. The user can adjust.
  const defaultCutoff = items.length > 1 ? items[items.length - 2].date : first.date;
  const [cutoff, setCutoff] = useState(defaultCutoff);

  // Valid cutoff: must fall within the block, AND must leave at least one
  // day on each side (cutoff cannot be the very last day).
  const valid =
    cutoff >= first.date &&
    cutoff < last.date;

  const keepDays = items.filter((it) => it.date <= cutoff).length;
  const dropDays = items.filter((it) => it.date > cutoff).length;
  const resumeFromHint = addDaysISO(cutoff, 1);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Cut this block on the last day you worked. Anything scheduled after
        that day will be removed, and you'll be prompted to set a new date
        range for when the work resumes.
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
          <span className="text-muted-foreground">Block 2 will need new dates</span>{' '}
          <span className="text-muted-foreground">({dropDays} day{dropDays === 1 ? '' : 's'} from {format(parseISO(resumeFromHint), 'EEE d MMM')} onward will be removed)</span>
        </p>
      </div>

      <div className="flex gap-2 pt-1">
        <Button variant="outline" className="flex-1 h-11" onClick={onCancel}>Cancel</Button>
        <Button
          className="flex-1 h-11 bg-primary"
          disabled={!valid}
          onClick={() => onConfirm(cutoff)}
        >
          Split & set new dates
        </Button>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Group date-sorted bookings into contiguous-date "blocks". Two rows belong
 * to the same block iff their dates are exactly 1 day apart. Any larger
 * gap starts a new block.
 *
 * Input must be sorted ascending by date — the caller does that.
 */
function groupBlocks(sorted: ScheduleItem[]): ScheduleItem[][] {
  if (sorted.length === 0) return [];
  const blocks: ScheduleItem[][] = [];
  let current: ScheduleItem[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const expectedNext = addDaysISO(prev.date, 1);
    if (cur.date === expectedNext) {
      current.push(cur);
    } else {
      blocks.push(current);
      current = [cur];
    }
  }
  blocks.push(current);
  return blocks;
}

/**
 * Create one schedule_items row per day in the requested range. Pure side
 * effect, no state. Shared by Add and Edit (Edit deletes the original
 * rows first, then calls this).
 */
function createBlockRows({
  job,
  businessId,
  form,
  addScheduleItem,
}: {
  job: Job;
  businessId: string;
  form: BookingFormValues;
  addScheduleItem: (item: ScheduleItem) => void;
}) {
  const days = datesBetween(form.startDate, form.endDate || form.startDate);
  days.forEach((d, i) => {
    addScheduleItem({
      // uuid from the start — schedule_items.id is a uuid column in
      // Supabase. See schedule/page.tsx handleAdd for the longer
      // rationale.
      id: crypto.randomUUID(),
      businessId,
      createdAt: new Date().toISOString(),
      type: 'job_booking',
      jobId: job.id,
      title:
        days.length > 1
          ? `${job.name} (Day ${i + 1}/${days.length})`
          : job.name,
      date: d,
      startTime: form.startTime || undefined,
      endTime: form.endTime || undefined,
      notes: form.notes || undefined,
      completed: false,
    });
  });
}

// Build a human-readable summary like "Mon 4 May – Wed 6 May" + "8:00–4:30".
function summariseBookings(bookings: ScheduleItem[]): {
  rangeLabel: string;
  timeLabel: string;
  dayCount: number;
} {
  const first = bookings[0];
  const last = bookings[bookings.length - 1];
  const startDate = parseISO(first.date);
  const endDate = parseISO(last.date);

  const sameDay = first.date === last.date;
  const sameYear = startDate.getFullYear() === endDate.getFullYear();
  const thisYear = startDate.getFullYear() === new Date().getFullYear();

  const yearSuffix = thisYear ? '' : ` ${startDate.getFullYear()}`;
  const startLabel = format(startDate, 'EEE d MMM') + yearSuffix;
  const endLabel = sameYear
    ? format(endDate, 'EEE d MMM') + (thisYear ? '' : ` ${endDate.getFullYear()}`)
    : format(endDate, 'EEE d MMM yyyy');

  const rangeLabel = sameDay ? startLabel : `${startLabel} – ${endLabel}`;

  let timeLabel = 'No times set';
  if (first.startTime && first.endTime) {
    timeLabel = `${first.startTime}–${first.endTime}`;
  } else if (first.startTime) {
    timeLabel = `From ${first.startTime}`;
  } else if (first.endTime) {
    timeLabel = `Until ${first.endTime}`;
  }

  return { rangeLabel, timeLabel, dayCount: bookings.length };
}
