'use client';

// Visit action chooser — the tiny sheet that pops when Brad taps the
// body of a quote_visit RunCard. Two paths from one row:
//
//   1. "Wrap up visit" — capture scope, photos, access etc. The
//      natural post-visit action.
//   2. "Edit details" — change the date / time / job / title. The
//      pre-visit action (or fixing a typo after the fact).
//
// The chooser exists because before this, tapping the row went
// straight to Edit, which was confusing for users who'd just done a
// site visit and were looking for the data-capture flow. Two clearly-
// labelled buttons take less brain than guessing where the wrap-up
// lives. Other schedule_item types skip the chooser — they have no
// wrap-up equivalent so the tap goes straight to edit as before.

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { FileText, Pencil } from 'lucide-react';

interface Props {
  open: boolean;
  /** Short summary of what they tapped — title/date for confirmation. */
  itemTitle?: string;
  itemDate?: string;
  onWrapUp: () => void;
  onEdit: () => void;
  onCancel: () => void;
}

export function VisitActionChooser({
  open, itemTitle, itemDate, onWrapUp, onEdit, onCancel,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>What do you want to do?</SheetTitle>
        </SheetHeader>
        <div className="mt-3 space-y-3 pb-4">
          {/* Context strip so Brad confirms he tapped the right one. */}
          {(itemTitle || itemDate) && (
            <div className="rounded-xl bg-muted/40 border border-border px-3 py-2 text-sm">
              {itemTitle && (
                <p className="font-medium text-foreground">{itemTitle}</p>
              )}
              {itemDate && (
                <p className="text-xs text-muted-foreground">{itemDate}</p>
              )}
            </div>
          )}

          {/* Primary action — wrap-up. Brighter styling because it's
              the action a tradie usually wants right after a visit. */}
          <button
            type="button"
            onClick={onWrapUp}
            className="w-full text-left rounded-xl border border-primary bg-primary/5 hover:bg-primary/10 transition-colors p-3 flex items-start gap-3 min-h-[56px]"
          >
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <FileText size={17} className="text-primary" strokeWidth={1.8} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground">Wrap up visit</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Add photos, scope, prep level, access notes — prep for the quote.
              </p>
            </div>
          </button>

          {/* Secondary action — edit. Muted styling because it's less
              common after a visit. */}
          <button
            type="button"
            onClick={onEdit}
            className="w-full text-left rounded-xl border border-border bg-card hover:bg-accent transition-colors p-3 flex items-start gap-3 min-h-[56px]"
          >
            <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center shrink-0">
              <Pencil size={16} className="text-muted-foreground" strokeWidth={1.8} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground">Edit details</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Change the date, time, title, or linked job.
              </p>
            </div>
          </button>

          <Button variant="outline" className="w-full" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
