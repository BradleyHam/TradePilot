'use client';

import { useMemo, useState } from 'react';
import { Job, ScheduleItem } from '@/lib/types';
import { useStore } from '@/lib/store';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { CalendarDays, Pencil, Briefcase } from 'lucide-react';
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
 * - Shows existing job_booking schedule items linked to this job, summarised
 *   as a date range + times.
 * - Tapping Add/Edit opens a sheet with start/end date, optional times, notes.
 * - Save: deletes any existing job_booking items for this job, then creates
 *   one schedule_item per day in the new range. Single source of truth lives
 *   in the schedule_items table — the Schedule page picks them up automatically.
 */
export function BookedDates({ job }: BookedDatesProps) {
  const { scheduleItems, businessId, addScheduleItem, deleteScheduleItem } = useStore();
  const [showSheet, setShowSheet] = useState(false);

  // All job_booking items linked to this job, sorted ascending by date.
  const bookings = useMemo(() => {
    return scheduleItems
      .filter((s) => s.jobId === job.id && s.type === 'job_booking')
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [scheduleItems, job.id]);

  const hasBookings = bookings.length > 0;

  // Derive a summary range for the existing bookings. Times are taken from
  // the first item — we assume Brad's bookings use consistent times across days
  // (which is what the form produces).
  const summary = hasBookings ? summariseBookings(bookings) : null;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Booked dates</p>
        {hasBookings && (
          <button
            onClick={() => setShowSheet(true)}
            className="text-xs text-primary font-medium flex items-center gap-1"
          >
            <Pencil size={12} /> Edit
          </button>
        )}
      </div>

      {hasBookings && summary ? (
        <button
          onClick={() => setShowSheet(true)}
          className="w-full flex items-start gap-3 p-3 rounded-xl bg-orange-50/60 border border-orange-200 text-left"
        >
          <div className="w-9 h-9 rounded-xl bg-orange-100 flex items-center justify-center shrink-0">
            <Briefcase size={17} className="text-orange-600" strokeWidth={1.8} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">{summary.rangeLabel}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {summary.timeLabel}
              {summary.dayCount > 1 && <> · {summary.dayCount} days</>}
            </p>
          </div>
        </button>
      ) : (
        <Button
          variant="outline"
          className="w-full h-11 border-orange-300 bg-orange-50/50 text-orange-900 hover:bg-orange-100/60"
          onClick={() => setShowSheet(true)}
        >
          <CalendarDays size={16} className="mr-2 text-orange-600" strokeWidth={1.8} />
          Add booked dates
        </Button>
      )}

      <Sheet open={showSheet} onOpenChange={setShowSheet}>
        <SheetContent side="bottom" className="h-[85vh] overflow-y-auto rounded-t-2xl px-4 pb-10">
          <SheetHeader className="pb-4">
            <SheetTitle>{hasBookings ? 'Edit booked dates' : 'Add booked dates'}</SheetTitle>
          </SheetHeader>
          <BookedDatesForm
            existing={bookings}
            onCancel={() => setShowSheet(false)}
            onSave={async (form) => {
              if (!businessId) return;

              // Delete the existing job_booking items first. Optimistic; the
              // store handles rollback on individual failures.
              for (const b of bookings) deleteScheduleItem(b.id);

              // Create one schedule_item per day in the new range.
              const days = datesBetween(form.startDate, form.endDate || form.startDate);
              days.forEach((d, i) => {
                addScheduleItem({
                  // uuid from the start — schedule_items.id is a uuid
                  // column in Supabase. See schedule/page.tsx handleAdd
                  // for the longer rationale.
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
              setShowSheet(false);
            }}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

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
  // Pre-fill from existing bookings if any. Otherwise default to today.
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
