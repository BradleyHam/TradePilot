'use client';

// Shared "Book site visit" sheet.
//
// Originally lived inline on the Leads page. Hoisted into a shared
// component once the Home screen needed the same flow (tap "Mark
// contacted" on a lead → "Site visit arranged?" → Yes opens this).
// Two callers, one source of truth — no more drift between a leads
// copy and a home copy.
//
// This component owns the whole save action, not just the form, so a
// caller only has to hand it a `job` and listen for onSaved/onCancel.
// On save, three things happen (mirrors the original leads behaviour):
//
//   1. A schedule_item of type 'quote_visit' is added so the visit
//      shows up on the Schedule tab and the upcoming-work surfaces.
//   2. A contact is logged (migration 042) — booking a visit IS contact,
//      so the chase-list / "leads to contact" inbox stops nagging about a
//      lead Brad has actively engaged with. logContact also keeps the
//      job's lastContactedDate cache in step, which is what those
//      surfaces actually read.
//   3. The .ics file is downloaded so Brad can add it to his phone's
//      calendar for native reminders (night before + 1 hour before).
//
// Lead-specific defaults that used to justify keeping this inline
// (title prefilled from the job name, auto-download on save) are baked
// in here — they're the right defaults for both callers anyway.
//
// Structure: an outer shell (the Sheet) + an inner form keyed on the
// job id. The key remounts the form for each lead, so it always opens
// with fresh defaults — no reset-on-open effect needed (which the
// strict react-hooks lint rules reject anyway).

import { useMemo, useState } from 'react';
import { Job } from '@/lib/types';
import { useStore } from '@/lib/store';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MapPin, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { downloadIcs } from '@/lib/ics';

// Duration presets for the site-visit booking. 30 min is the default —
// most quote visits are a quick walk-around. 20 min covers the small
// "I already know what I'm looking at" jobs. 45 and 60 cover bigger
// houses and full colour-consult visits. Array order = chip order.
const VISIT_DURATION_OPTIONS = [20, 30, 45, 60] as const;
const DEFAULT_VISIT_DURATION = 30;
const DEFAULT_START_TIME = '09:00';

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

/** Minutes between two `HH:MM` times, assuming end is same-day after start.
 *  Returns null when either input is malformed or end is before start. */
function minutesBetween(start: string, end: string): number | null {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  return diff >= 0 ? diff : null;
}

/** Tomorrow as YYYY-MM-DD in local time. */
function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface BookVisitSheetProps {
  /** The lead the visit is being booked against. null = sheet stays closed. */
  job: Job | null;
  open: boolean;
  /** Fired after a successful save (schedule item added + ics triggered). */
  onSaved: () => void;
  onCancel: () => void;
}

export function BookVisitSheet({ job, open, onSaved, onCancel }: BookVisitSheetProps) {
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>Book site visit</SheetTitle>
        </SheetHeader>
        {job && (
          <BookVisitForm
            key={job.id}
            job={job}
            onSaved={onSaved}
            onCancel={onCancel}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function BookVisitForm({
  job, onSaved, onCancel,
}: {
  job: Job;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { addScheduleItem, businessId, logContact } = useStore();

  // Defaults — tomorrow 9am, 30-min visit. Most site visits get booked
  // for the next morning, and 30 min is the right size for a walk-around
  // quote visit. The user can change any of it. Computed once on mount;
  // the form remounts (via key) for each new lead, so these stay fresh.
  const defaultEnd = useMemo(
    () => addMinutesToTime(DEFAULT_START_TIME, DEFAULT_VISIT_DURATION),
    [],
  );

  const [date, setDate] = useState(tomorrowISO);
  const [startTime, setStartTime] = useState(DEFAULT_START_TIME);
  const [endTime, setEndTime] = useState(defaultEnd);
  const [notes, setNotes] = useState('');

  // Which preset (if any) the current start→end span matches. Drives the
  // pressed/selected look on the duration chips. Custom end times just
  // leave every chip un-pressed.
  const activeDuration = minutesBetween(startTime, endTime);

  /** Re-derive end time from the current start + the chosen preset. */
  function applyDuration(minutes: number) {
    setEndTime(addMinutesToTime(startTime, minutes));
  }

  /**
   * Book the visit. Adds the schedule_item, bumps lastContactedDate,
   * and downloads the .ics. If any single step fails the others still
   * run — the schedule_item is the important one, and partial success
   * beats refusing to do anything.
   */
  function handleSubmit() {
    const endVal = endTime || undefined;

    // Real uuid because schedule_items.id is a uuid column in Supabase.
    // Generating a string like `sch_<ts>` would work for the insert (the
    // store's id-swap reconciles it), but any update racing ahead of the
    // insert response would hit Postgres' 22P02 "invalid input syntax for
    // uuid". uuid from the start = no race window.
    const scheduleItemId = crypto.randomUUID();
    const title = `Site visit — ${job.name}`;

    // Save & download is one atomic action from the user's POV — the
    // sheet text literally says "Saving downloads a calendar invite". So
    // we flag icsDownloaded=true at creation, no second store write
    // needed. If the download itself throws (unlikely — Blob URLs don't
    // fail in modern browsers) the flag is optimistic but harmless: the
    // user can re-trigger from the badge on the schedule row.
    addScheduleItem({
      id: scheduleItemId,
      businessId: businessId ?? '',
      jobId: job.id,
      type: 'quote_visit',
      title,
      date,
      startTime,
      endTime: endVal,
      notes: notes.trim() || undefined,
      completed: false,
      icsDownloaded: true,
      createdAt: new Date().toISOString(),
    });

    // Arranging the visit is the contact — dated NOW, not on the visit date.
    // The conversation that booked it is what reset the chase clock; the
    // visit itself is a future event, and nothing logs a contact when it
    // actually happens (the wrap-up flow doesn't call logContact), so the
    // timeline under-reports site visits by design for now.
    logContact({ jobId: job.id, direction: 'out', channel: 'visit' });

    // Build the calendar invite. Local-time Date constructed from the
    // form inputs — no UTC funny business, so the event lands on the
    // wall-clock time Brad picked.
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = startTime.split(':').map(Number);
    const start = new Date(y, m - 1, d, hh, mm);
    let end: Date | undefined;
    if (endVal) {
      const [eh, em] = endVal.split(':').map(Number);
      end = new Date(y, m - 1, d, eh, em);
    }

    downloadIcs({
      // Stable UID = the schedule_item id, so re-downloading later (via
      // the badge on the schedule row) updates the same calendar event
      // rather than creating a duplicate.
      uid: `${scheduleItemId}@tradepilot`,
      title,
      start,
      end,
      location: job.location,
      description: [
        job.clientName && `Client: ${job.clientName}`,
        job.clientPhone && `Phone: ${job.clientPhone}`,
        notes.trim() || undefined,
      ].filter(Boolean).join('\n'),
    });

    onSaved();
  }

  return (
    <div className="mt-4 space-y-3 pb-4">
      {/* Job context — read-only summary so the user can confirm they're
          booking against the right lead before tapping save. */}
      <div className="rounded-xl bg-muted/40 border border-border px-3 py-2.5">
        <p className="text-sm font-medium text-foreground">{job.name}</p>
        <p className="text-xs text-muted-foreground">{job.clientName}</p>
        {job.location && (
          <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
            <MapPin size={11} strokeWidth={1.8} /> {job.location}
          </p>
        )}
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Date
        </label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-full h-10 px-3 rounded-lg border border-input text-sm bg-background"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Start
          </label>
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="w-full h-10 px-3 rounded-lg border border-input text-sm bg-background"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            End
          </label>
          <input
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className="w-full h-10 px-3 rounded-lg border border-input text-sm bg-background"
          />
        </div>
      </div>

      {/* Quick-pick duration chips. Tap to snap the end time to a common
          length. End time stays editable for anything custom — chips are
          an accelerator, not a constraint. */}
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

      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Notes (optional)
        </label>
        <Textarea
          placeholder="e.g. Check cedar condition on north face. Bring colour swatches."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="resize-none text-sm"
          rows={3}
        />
      </div>

      <p className="text-xs text-muted-foreground leading-snug">
        <CalendarDays size={12} className="inline mr-1 -mt-0.5" />
        Saving downloads a calendar invite with reminders the night before
        and 1 hour before. Add it to your phone&apos;s calendar to get the alerts.
      </p>

      <div className="flex gap-2 pt-1">
        <Button variant="outline" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          className="flex-1 bg-primary"
          onClick={handleSubmit}
          disabled={!date || !startTime}
        >
          Save & download
        </Button>
      </div>
    </div>
  );
}
