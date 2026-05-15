'use client';

// Pops up the moment a job's status flips to a terminal value (completed,
// invoiced, paid). Asks for the actual day the job wrapped — that single
// answer is what reconcileJobSchedule uses to decide which planned days were
// real (mark done) and which never happened (delete).
//
// We default to today because that's right ~80% of the time ("I'm marking
// this done now because I just finished"). The picker lets the user backdate
// to the actual finish day in the other ~20%. Skipping leaves endDate unset
// and the calendar stays as-is — same as the existing OutcomeSheet pattern,
// status flip already happened.

import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { CalendarCheck } from 'lucide-react';

interface CompletionDateSheetProps {
  open: boolean;
  jobName: string;
  /** Pre-fill the picker with this date if the job already has one. */
  initialDate?: string;
  onSave: (completionDate: string) => void;
  onCancel: () => void;
}

export function CompletionDateSheet({
  open, jobName, initialDate, onSave, onCancel,
}: CompletionDateSheetProps) {
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(initialDate ?? today);

  // Reset when the sheet reopens for a different job. Same pattern the
  // OutcomeSheet uses — `open` is the "edge trigger" we sync to. Today is
  // re-evaluated each render but only matters at open time so it doesn't
  // need to be in the dep array.
  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setDate(initialDate ?? today);
  }, [open, initialDate]);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <CalendarCheck size={18} className="text-primary" strokeWidth={2} />
            When did you finish?
          </SheetTitle>
          <p className="text-sm text-muted-foreground">
            Setting the actual finish date for <span className="font-medium text-foreground">{jobName}</span> lets us
            tidy up any scheduled days after that won&apos;t happen now.
          </p>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* Quick-pick chips for the common answers, plus a full date input
              for anything else. Today is the default; "Yesterday" covers
              "marked it done the morning after I finished". */}
          <div className="flex flex-wrap gap-2">
            {[
              { label: 'Today', value: today },
              { label: 'Yesterday', value: shiftDays(today, -1) },
              { label: '2 days ago', value: shiftDays(today, -2) },
              { label: '3 days ago', value: shiftDays(today, -3) },
            ].map(({ label, value }) => {
              const selected = date === value;
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => setDate(value)}
                  className={
                    'shrink-0 px-3 py-2 rounded-lg text-sm font-medium border transition-colors min-h-[44px] ' +
                    (selected
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card text-foreground border-border hover:border-primary/30')
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Or pick a specific date
            </label>
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => setDate(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={onCancel}>
              Skip
            </Button>
            <Button
              className="flex-1 bg-primary"
              onClick={() => onSave(date)}
              disabled={!date || date > today}
            >
              Save finish date
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// Shift a YYYY-MM-DD date by N days. Stays in local-date space so we don't
// drift across timezones.
function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
