'use client';

// Quote catch-up — step 2 of the "Already visited" flow.
//
// The flow it belongs to: Brad taps "Mark contacted" on a lead from the
// Home leads-to-contact list, and the app asks whether a site visit was
// arranged. Sometimes the honest answer is "I already went, I've just
// been slack about logging it" — that's the "Already visited" branch.
// After the backdated wrap-up saves, we land here and ask the obvious
// next question: has the quote gone out too?
//
// Two answers, two outcomes:
//
//   Yes → capture the amount and the date it was sent. The job moves to
//         status 'quoted' with quoteAmount set, lastContactedDate is
//         stamped to the send date (so the chase-list measures silence
//         from when the customer actually heard from Brad, not from
//         today), and quoteReadyBy is cleared — the promise is kept, so
//         it shouldn't keep showing as a quote owed.
//
//   No  → nothing to write here. The wrap-up already set quoteReadyBy,
//         which is what drives the "quote owed" surface on Home. The
//         parent stamps lastContactedDate.
//
// Deliberately NOT here: sending anything, generating a PDF, or touching
// the quotes table. This sheet exists to make the app's record match
// reality that already happened offline. It's bookkeeping, not workflow.

import { useState, useMemo } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Job } from '@/lib/types';
import { FileText, CalendarClock } from 'lucide-react';
import { cn } from '@/lib/utils';

const NZ_GST_RATE = 0.15;

/** What the parent needs to patch the job when the answer is Yes. */
export interface QuoteCatchUpResult {
  /** Dollar value of the quote, EX-GST (the storage convention for
   *  job.quoteAmount — the form converts if Brad enters incl-GST).
   *  Undefined when Brad skipped the field. */
  amount?: number;
  /** YYYY-MM-DD the quote was sent. Always populated. */
  sentDate: string;
}

interface QuoteCatchUpSheetProps {
  /** The lead being caught up. null = sheet stays closed. */
  job: Job | null;
  /** Answered yes — quote already sent, with the captured details. */
  onQuoted: (job: Job, result: QuoteCatchUpResult) => void;
  /** Answered no — quote still owed. */
  onNotQuoted: (job: Job) => void;
  /** Dismissed without answering. */
  onCancel: () => void;
}

export function QuoteCatchUpSheet({
  job, onQuoted, onNotQuoted, onCancel,
}: QuoteCatchUpSheetProps) {
  return (
    <Sheet open={job !== null} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl max-h-[90dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Quote already sent?</SheetTitle>
        </SheetHeader>
        {job && (
          // Keyed on the job so the form resets between leads rather
          // than carrying the previous lead's amount over. Same pattern
          // as BookVisitSheet.
          <QuoteCatchUpForm
            key={job.id}
            job={job}
            onQuoted={onQuoted}
            onNotQuoted={onNotQuoted}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function QuoteCatchUpForm({
  job, onQuoted, onNotQuoted,
}: {
  job: Job;
  onQuoted: (job: Job, result: QuoteCatchUpResult) => void;
  onNotQuoted: (job: Job) => void;
}) {
  // Local-time today — not toISOString(), which is UTC and reads as
  // yesterday in NZ for anything logged before about noon.
  const todayLocalISO = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  // `expanded` is the two-step disclosure: the sheet opens as a plain
  // yes/no question, and only unfolds the amount + date fields once Brad
  // says yes. Asking for a dollar figure before the yes/no would make
  // the "no" path — which needs no input at all — look like work.
  const [expanded, setExpanded] = useState(false);
  const [amount, setAmount] = useState(
    job.quoteAmount != null ? String(job.quoteAmount) : '',
  );
  // Which way the typed figure is quoted. job.quoteAmount is stored
  // EX-GST (every money calc in the app is ex-GST), but a remembered
  // price arrives either way. Silently assuming ex-GST is the Aubrey
  // Road / J16 bug class — so ask, and convert. Defaults to ex-GST,
  // matching the stored convention.
  const [basis, setBasis] = useState<'ex' | 'incl'>('ex');
  const [sentDate, setSentDate] = useState(todayLocalISO);

  /** Digits + one decimal point. Strips $, commas, and stray minus signs. */
  function sanitizeAmount(raw: string): string {
    let s = raw.replace(/[^\d.]/g, '');
    const firstDot = s.indexOf('.');
    if (firstDot !== -1) {
      s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
    }
    return s;
  }

  /** Ex-GST figure to store, per the basis chip. */
  function toExGst(n: number): number {
    return basis === 'incl' ? Math.round((n / (1 + NZ_GST_RATE)) * 100) / 100 : n;
  }

  function handleConfirm() {
    const parsed = amount ? parseFloat(amount) : NaN;
    onQuoted(job, {
      amount: Number.isFinite(parsed) && parsed > 0 ? toExGst(parsed) : undefined,
      sentDate: sentDate || todayLocalISO,
    });
  }

  const parsedAmount = amount ? parseFloat(amount) : NaN;

  return (
    <div className="mt-4 space-y-4 pb-4">
      <div className="rounded-xl bg-muted/40 border border-border px-3 py-2.5">
        <p className="text-sm font-medium text-foreground">{job.name}</p>
        {job.clientName && (
          <p className="text-xs text-muted-foreground">{job.clientName}</p>
        )}
      </div>

      {!expanded ? (
        <>
          <p className="text-sm text-muted-foreground leading-snug">
            Visit logged. Have you sent this customer a quote yet? If you have,
            we&apos;ll move them out of your leads list and into quote follow-ups.
          </p>

          <div className="space-y-2">
            <Button
              className="w-full h-12 bg-primary text-base"
              onClick={() => setExpanded(true)}
            >
              <FileText size={18} className="mr-2" strokeWidth={2} />
              Yes — quote&apos;s already gone
            </Button>
            <Button
              variant="outline"
              className="w-full h-12 text-base"
              onClick={() => onNotQuoted(job)}
            >
              <CalendarClock size={18} className="mr-2" strokeWidth={2} />
              Not yet — quote still to write
            </Button>
          </div>
        </>
      ) : (
        <>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Quote amount
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="e.g. 6800"
                value={amount}
                onChange={(e) => setAmount(sanitizeAmount(e.target.value))}
                className="w-full h-10 pl-7 pr-3 rounded-lg border border-input bg-background text-sm"
              />
            </div>
            {/* GST basis — same explicit question as the money tiles.
                Wrong basis throws out profit, $/h and the tax estimate. */}
            <div className="flex gap-1 mt-1.5">
              {([
                { v: 'ex' as const, label: '+ GST' },
                { v: 'incl' as const, label: 'incl GST' },
              ]).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setBasis(o.v)}
                  aria-pressed={basis === o.v}
                  className={cn(
                    // h-11 = 44px — the app-wide minimum tap target. These
                    // were h-8 (32px); a mis-tap here is a silent 15% error.
                    'flex-1 h-11 rounded-lg border text-xs font-medium transition-colors',
                    basis === o.v
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background border-input text-muted-foreground',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {Number.isFinite(parsedAmount) && parsedAmount > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Saves as ${toExGst(parsedAmount).toLocaleString('en-NZ')} ex GST
              </p>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
              Optional — leave blank if you can&apos;t remember. You can fill it
              in on the job later.
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Date sent
            </label>
            <input
              type="date"
              value={sentDate}
              max={todayLocalISO}
              onChange={(e) => setSentDate(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
              Used to work out how long the customer has been sitting on it —
              your follow-up nudge counts from here.
            </p>
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setExpanded(false)}
            >
              Back
            </Button>
            <Button
              className="flex-1 bg-primary"
              onClick={handleConfirm}
              disabled={!sentDate}
            >
              Mark as quoted
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
