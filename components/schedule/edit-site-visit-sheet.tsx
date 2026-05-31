'use client';

// Dedicated edit UI for quote_visit (site visit) schedule items.
//
// The shared EditScheduleItemSheet is built around the multi-day job_booking
// flow — it has working-days chips, an end-date picker, "Day N/M" plumbing
// and a Split-into-two-blocks affordance. A site visit is always one day,
// usually 20–30 minutes, and that whole apparatus is just noise the user
// has to scroll past. This sheet strips the form back to exactly the
// fields a quote visit needs:
//
//   - Title (defaults populated from the existing item)
//   - Date (one — no range, no end-date)
//   - Start time + End time, with the same 20/30/45/60 duration chips
//     used in the BookVisitSheet so the two flows feel like one feature
//   - Linked job (optional)
//   - Notes
//   - Mark as done toggle
//   - Save + Delete + Cancel
//
// Delete lives directly inside this sheet so the user doesn't have to
// dig — fixing "I booked the wrong day" should take two taps from the
// schedule list. We update the existing row in place (preserves id and
// any linked records like the .ics-downloaded flag) rather than the
// delete-and-recreate dance the multi-day flow needs.

import { useEffect, useMemo, useState } from 'react';
import { Job, ScheduleItem } from '@/lib/types';
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
import { Trash2, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Duration chip presets ────────────────────────────────────────────────
// Same set used by BookVisitSheet on the Leads page so the booking flow
// and the edit flow speak the same language. Keep them in sync.
const VISIT_DURATION_OPTIONS = [20, 30, 45, 60] as const;

/** Add `minutes` to a `HH:MM` (24h) time string, wrapping over midnight. */
function addMinutesToTime(time: string, minutes: number): string {
  const [hStr, mStr] = time.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  const total = ((h * 60 + m + minutes) % (24 * 60) + 24 * 60) % (24 * 60);
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

/** Minutes between two `HH:MM` times; null when malformed or end < start. */
function minutesBetween(start: string, end: string): number | null {
  if (!start || !end) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  return diff >= 0 ? diff : null;
}

// ── Form atoms (matches edit-schedule-item-sheet styling) ────────────────
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

// ── Props ────────────────────────────────────────────────────────────────
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The site-visit row being edited. Single item — quote visits don't
   *  multi-day. When null the sheet doesn't render its form (matches the
   *  EditScheduleItemSheet pattern). */
  item: ScheduleItem | null;
  jobs: Job[];
}

export function EditSiteVisitSheet({ open, onOpenChange, item, jobs }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[90vh] overflow-y-auto rounded-t-2xl px-4 pb-10"
      >
        <SheetHeader className="pb-4">
          <SheetTitle>Edit site visit</SheetTitle>
        </SheetHeader>
        {item && (
          <EditForm
            item={item}
            jobs={jobs}
            onClose={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function EditForm({
  item,
  jobs,
  onClose,
}: {
  item: ScheduleItem;
  jobs: Job[];
  onClose: () => void;
}) {
  const { updateScheduleItem, deleteScheduleItem } = useStore();

  // State seeded from the item. Local copies so the user can cancel
  // without committing partial edits. Reset whenever the item changes
  // — we may stay mounted while the parent swaps targets.
  const [title, setTitle] = useState(item.title);
  const [date, setDate] = useState(item.date);
  const [startTime, setStartTime] = useState(item.startTime ?? '09:00');
  const [endTime, setEndTime] = useState(item.endTime ?? '09:30');
  const [jobId, setJobId] = useState(item.jobId ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [completed, setCompleted] = useState(item.completed);

  useEffect(() => {
    setTitle(item.title);
    setDate(item.date);
    setStartTime(item.startTime ?? '09:00');
    setEndTime(item.endTime ?? '09:30');
    setJobId(item.jobId ?? '');
    setNotes(item.notes ?? '');
    setCompleted(item.completed);
  }, [item.id, item.title, item.date, item.startTime, item.endTime, item.jobId, item.notes, item.completed]);

  // Which preset (if any) the current start→end span matches. Drives the
  // pressed look on the chips. Custom values leave every chip un-pressed.
  const activeDuration = minutesBetween(startTime, endTime);

  /** Snap end time to a preset length, anchored on the current start. */
  function applyDuration(minutes: number) {
    setEndTime(addMinutesToTime(startTime, minutes));
  }

  const jobNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const j of jobs) map[j.id] = j.name;
    return map;
  }, [jobs]);

  const valid = !!title.trim() && !!date;

  function handleSave() {
    if (!valid) return;
    updateScheduleItem(item.id, {
      title: title.trim(),
      date,
      startTime: startTime || undefined,
      endTime: endTime || undefined,
      jobId: jobId || undefined,
      notes: notes || undefined,
      completed,
    });
    onClose();
  }

  function handleDelete() {
    if (!confirm('Delete this site visit?')) return;
    deleteScheduleItem(item.id);
    onClose();
  }

  return (
    <div className="space-y-4">
      {/* Read-only type label — keeps the sheet visually consistent with
          the multi-day edit sheet but makes clear we're in the focused
          site-visit flow. */}
      <div className="text-xs text-muted-foreground">
        Type: <span className="font-medium text-foreground">Site visit</span>
      </div>

      <FormField label="Title *">
        <FormInput
          placeholder="e.g. Site visit — 12 Avalanche Place"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </FormField>

      <FormField label="Date *">
        <FormInput
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </FormField>

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

      {/* Duration chips — same set as BookVisitSheet on the Leads page so
          the booking and edit flows behave identically. End time stays
          editable for anything custom; chips are an accelerator only. */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Duration
        </label>
        <div className="flex gap-2 flex-wrap">
          {VISIT_DURATION_OPTIONS.map((mins) => {
            const isActive = activeDuration === mins;
            return (
              <button
                key={mins}
                type="button"
                onClick={() => applyDuration(mins)}
                className={cn(
                  'h-9 px-3 rounded-full border text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-foreground border-input hover:bg-muted',
                )}
                aria-pressed={isActive}
              >
                {mins} min
              </button>
            );
          })}
        </div>
      </div>

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
          placeholder="Access, parking, what to inspect, swatches to bring…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="resize-none text-sm"
          rows={3}
        />
      </FormField>

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
            Save
          </Button>
        </div>
        <Button
          variant="ghost"
          className="h-11 text-red-600 hover:text-red-700 hover:bg-red-50"
          onClick={handleDelete}
        >
          <Trash2 size={16} className="mr-2" />
          Delete site visit
        </Button>
      </div>
    </div>
  );
}
