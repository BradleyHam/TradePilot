'use client';

// "Turn it down" — Brad said no to this job.
//
// Replaces the old ParkLeadSheet (see migration 040). Parking used to hide a
// lead from the chase-list while leaving `status` alone; declining is now a
// real status, so there's one word for one idea instead of two. The behaviour
// Brad actually relied on is unchanged: it comes off the chase-list, it does
// NOT count as a loss, and it's reversible from the job's detail sheet.
//
// The reason is genuinely optional and the sheet is built around that.
// "Turn it down" (no reason) is a full-width primary button, not a greyed-out
// fallback — Brad at 5:30pm should be able to open this and close it in one
// tap. Picking a chip just swaps the button label. Nothing here blocks.

import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// Presets cover the common shapes of "I'm not taking this on". Deliberately
// wider than LOST_REASONS: declining catches work that was never a contest,
// not just quotes that fell over. Free text handles the rest.
//
// 'Out of area' and 'Not our kind of work' are the old LostReason values
// 'too-far' / 'wrong-fit', finally living somewhere that doesn't pollute the
// win rate.
const DECLINE_REASONS: string[] = [
  'Out of area',
  'Too small',
  'Not our kind of work',
  'Too busy',
  'Bad timing',
  'Price expectations',
  'Gone quiet',
];

interface DeclineJobSheetProps {
  open: boolean;
  /** Existing chip selections, when editing an already-declined job. */
  initialReasons?: string[];
  /** Existing free-text note, when editing an already-declined job. */
  initialNote?: string;
  /** True when the job is already declined and we're only editing the reason. */
  editing?: boolean;
  onSave: (reasons: string[], note: string | undefined) => void;
  onCancel: () => void;
}

export function DeclineJobSheet({
  open, initialReasons, initialNote, editing = false, onSave, onCancel,
}: DeclineJobSheetProps) {
  // Chips are MULTI-select: "out of area" and "too busy" are both true of
  // the same job often enough that forcing one threw away half the answer.
  // Held separately from the free text so typing doesn't clear a selection
  // and vice versa — both are saved, neither wins.
  const [chips, setChips] = useState<string[]>([]);
  const [notes, setNotes] = useState('');

  // Reset on each open, so a reason typed for job A doesn't carry over to
  // job B.
  //
  // Done during render (React's "adjust state when a prop changes" pattern,
  // as used for the inline rename in job-detail-sheet) rather than in an
  // effect, which would trigger a cascading render.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setChips(initialReasons ?? []);
      setNotes(initialNote ?? '');
    }
  }

  function toggleChip(label: string) {
    setChips((prev) => (
      prev.includes(label) ? prev.filter((c) => c !== label) : [...prev, label]
    ));
  }

  const typed = notes.trim();
  const answered = chips.length > 0 || typed.length > 0;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>{editing ? 'Why did you turn it down?' : 'Turn this one down?'}</SheetTitle>
          <p className="text-sm text-muted-foreground">
            {editing
              ? 'Just for your own records — it won’t change anything else.'
              : 'It comes off the leads list and sits in Declined, so you can put it back anytime. It won’t count as a lost job.'}
          </p>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* Reason chips — optional. Tapping a selected chip clears it. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Reason <span className="normal-case tracking-normal font-normal">— optional, pick as many as apply</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {DECLINE_REASONS.map((label) => {
                const selected = chips.includes(label);
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleChip(label)}
                    className={cn(
                      'shrink-0 px-3 py-2 rounded-lg text-sm font-medium border transition-colors min-h-[44px]',
                      selected
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card text-foreground border-border hover:border-primary/30',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <Textarea
              placeholder="eg. Lake Hayes, too far from Albert Town to price it properly."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="resize-none text-sm"
              rows={2}
            />
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={onCancel}>
              Cancel
            </Button>
            {/* Never disabled — no reason is a valid answer. */}
            <Button className="flex-1 bg-primary" onClick={() => onSave(chips, typed || undefined)}>
              {editing
                ? 'Save reason'
                : answered ? 'Turn it down' : 'Turn it down anyway'}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
