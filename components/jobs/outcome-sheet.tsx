'use client';

// Captures *why* a quote landed or fell through. Pops up the moment a job's
// status flips to `accepted` or `lost`. Picking a reason from chips + an
// optional note covers ~95% of cases without typing — the 5:30pm rule.
//
// We deliberately do NOT block the status change if the user closes without
// answering. The status flip already happened by the time this opens; this
// sheet only adds the reason after the fact. Skipping leaves the reason null
// (you can still mark it later by changing status away and back).

import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { LostReason, WonReason } from '@/lib/types';

const LOST_REASONS: { value: LostReason; label: string }[] = [
  { value: 'price',             label: 'Price too high' },
  { value: 'no-reply',          label: 'No reply' },
  { value: 'went-elsewhere',    label: 'Went with another painter' },
  { value: 'scope-changed',     label: 'Scope changed' },
  { value: 'project-cancelled', label: 'Project cancelled' },
  { value: 'timing',            label: 'Timing didn’t work' },
  { value: 'other',             label: 'Other' },
];

const WON_REASONS: { value: WonReason; label: string }[] = [
  { value: 'referral',           label: 'Referral' },
  { value: 'returning-client',   label: 'Returning client' },
  { value: 'price',              label: 'Best price' },
  { value: 'trust-rapport',      label: 'Trust / rapport' },
  { value: 'speed-of-response',  label: 'Speed of response' },
  { value: 'unique-fit',         label: 'Right fit for the job' },
  { value: 'other',              label: 'Other' },
];

export type OutcomeKind = 'lost' | 'won';

interface OutcomeSheetProps {
  open: boolean;
  kind: OutcomeKind;
  /** Existing values, if we're editing an already-set outcome. */
  initialReason?: LostReason | WonReason;
  initialNotes?: string;
  onSave: (data: { lostReason?: LostReason; wonReason?: WonReason; outcomeNotes?: string }) => void;
  onCancel: () => void;
}

export function OutcomeSheet({
  open, kind, initialReason, initialNotes, onSave, onCancel,
}: OutcomeSheetProps) {
  const [reason, setReason] = useState<LostReason | WonReason | undefined>(initialReason);
  const [notes, setNotes] = useState(initialNotes ?? '');

  // Reset state when the sheet reopens for a different job.
  useEffect(() => {
    if (open) {
      setReason(initialReason);
      setNotes(initialNotes ?? '');
    }
  }, [open, initialReason, initialNotes]);

  const options = kind === 'lost' ? LOST_REASONS : WON_REASONS;
  const title = kind === 'lost' ? 'Why did this one slip?' : 'Why did we win this one?';
  const subtitle = kind === 'lost'
    ? 'Helps us spot patterns when leads go cold.'
    : 'Helps us double down on what’s working.';

  function handleSave() {
    if (kind === 'lost') {
      onSave({
        lostReason: reason as LostReason | undefined,
        wonReason: undefined,
        outcomeNotes: notes.trim() || undefined,
      });
    } else {
      onSave({
        wonReason: reason as WonReason | undefined,
        lostReason: undefined,
        outcomeNotes: notes.trim() || undefined,
      });
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* Reason chips */}
          <div className="flex flex-wrap gap-2">
            {options.map(({ value, label }) => {
              const selected = reason === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setReason(value)}
                  className={cn(
                    'shrink-0 px-3 py-2 rounded-lg text-sm font-medium border transition-colors min-h-[44px]',
                    selected
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card text-foreground border-border hover:border-primary/30'
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Optional free-text */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Anything worth remembering?
            </label>
            <Textarea
              placeholder={kind === 'lost'
                ? 'eg. Quoted $9.3k, they had a $7k offer from another painter.'
                : 'eg. Came via a referral from the McLeod job. Trusted me from day one.'}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="resize-none text-sm"
              rows={3}
            />
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={onCancel}>
              Skip
            </Button>
            <Button
              className="flex-1 bg-primary"
              onClick={handleSave}
              disabled={!reason}
            >
              Save
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
