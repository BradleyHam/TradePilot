'use client';

// Mark-as-quoted — the action that flips a lead into the "Quoted,
// awaiting reply" bucket. v1 captures the three pricing/scheduling
// essentials:
//
//   1. Total $ — the number you sent the customer (incl-GST per NZ
//      retail convention). Drives expectedIncome + pipeline-value math.
//   2. Date sent — defaults to today. Drives "how long since I
//      quoted them" stale-ness on the chase-list.
//   3. Follow-up date — defaults to +5 business days. Sets job.followUpDate
//      so the chase-list pings Brad when the customer goes quiet.
//
// On save: flips job.status → 'quoted', writes quote.totalAmountInclGst
// + quote.dateSent + quote.status='sent', bumps job.lastContactedDate.
// All in one go — no in-between states where the data is half-saved.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { useStore } from '@/lib/store';
import type { Job } from '@/lib/types';
import { Send, CalendarClock, DollarSign, MapPin, FileText, X } from 'lucide-react';

interface Props {
  open: boolean;
  /** The lead being quoted. null = sheet stays closed. */
  job: Job | null;
  /**
   * Pre-fill the total field. Used by the AI quote drafter flow to
   * carry through the suggested total without the user re-typing it.
   * Takes precedence over the job's existing quoteAmount when set.
   */
  initialTotal?: number;
  onSaved: () => void;
  onCancel: () => void;
}

export function MarkAsQuotedSheet({ open, job, initialTotal, onSaved, onCancel }: Props) {
  const { updateJob, ensureJobHasQuote, updateQuote, addQuoteAttachments } = useStore();

  // Form state
  const [totalIncl, setTotalIncl] = useState('');
  const [dateSent, setDateSent] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optional PDF of the quote document the user sent the customer.
  // Uploaded as kind='quote_pdf' attachment on save so the job has a
  // record of what was actually quoted. Useful when the user wrote
  // the quote outside the app (Word, Pages, accounting tool) and
  // wants the file kept alongside the structured job data.
  const [stagedPdf, setStagedPdf] = useState<File | null>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  // Defaults — today for date sent, +5 calendar days for follow-up.
  // 5 days because tradies typically expect a "we'll think about it"
  // window of a working week. Past that, silence means trouble.
  const todayISO = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const defaultFollowUp = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 5);
    return d.toISOString().slice(0, 10);
  }, []);

  // Hydrate on open. Priority for total:
  //   1. initialTotal (AI-suggested, takes precedence)
  //   2. job.quoteAmount (Brad's editing a previous save)
  //   3. empty (fresh manual quote)
  useEffect(() => {
    if (!open || !job) return;
    const initial = initialTotal ?? job.quoteAmount;
    setTotalIncl(initial ? String(initial) : '');
    setDateSent(todayISO);
    setFollowUpDate(job.followUpDate ?? defaultFollowUp);
    setStagedPdf(null);
    setError(null);
  }, [open, job, initialTotal, todayISO, defaultFollowUp]);

  async function handleSave() {
    if (!job) return;
    const totalNum = parseFloat(totalIncl);
    if (!Number.isFinite(totalNum) || totalNum <= 0) {
      setError('Enter the total quote amount you sent the customer.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Ensure the job has a quote row, then patch it with the sent
      // amount + date. ensureJobHasQuote returns the quote id so we
      // can write directly to that row.
      const quoteId = await ensureJobHasQuote(job.id);
      if (!quoteId) {
        setError('Could not prepare the quote record. Try again in a moment.');
        return;
      }
      const res = await updateQuote(quoteId, {
        totalAmountInclGst: totalNum,
        dateSent,
        status: 'sent',
      });
      if (!res.ok) {
        setError(res.error ?? 'Failed to save the quote details.');
        return;
      }

      // Upload the optional PDF as a quote_pdf attachment. We do this
      // AFTER the quote row update so we know the row is committed in
      // Supabase before the FK reference is created. If the upload
      // fails the whole mark-as-quoted is still considered a success —
      // surfacing the partial-fail message but letting the status flip
      // go through. Brad can re-attach later via the job detail.
      let uploadWarning: string | null = null;
      if (stagedPdf) {
        const uploadRes = await addQuoteAttachments(quoteId, [
          { file: stagedPdf, kind: 'quote_pdf' },
        ]);
        if (uploadRes.failed > 0) {
          uploadWarning = 'Marked as quoted, but the PDF didn\'t upload. You can attach it later from the job\'s Plans & photos section.';
        }
      }

      // Flip the job's status + write the headline numbers + bump
      // contact timestamp. We write quoteAmount on the job (used by
      // every existing money calc) AND keep it on the quote row
      // (canonical source of truth going forward).
      updateJob(job.id, {
        status: 'quoted',
        quoteAmount: totalNum,
        followUpDate: followUpDate || undefined,
        lastContactedDate: new Date().toISOString(),
      });

      if (uploadWarning) {
        // Surface the partial-fail but close the sheet — the
        // important state changes happened, no point trapping the
        // user in a half-saved view.
        alert(uploadWarning);
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  function handlePickPdf(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (pdfInputRef.current) pdfInputRef.current.value = '';
    if (!file) return;
    // Only accept PDFs — anything else gets silently ignored. We
    // could fall back to allowing images / docx etc but the field
    // is explicitly "the quote PDF you sent" so the constraint is
    // intentional.
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      setError('Attach a PDF — that\'s the format quotes get sent in.');
      return;
    }
    setStagedPdf(file);
    setError(null);
  }

  if (!job) return null;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl max-h-[92dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Mark as quoted</SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-4 pb-6">
          {/* Job context — confirms what we're marking. */}
          <div className="rounded-xl bg-muted/40 border border-border px-3 py-2.5">
            <p className="text-sm font-medium text-foreground">{job.name}</p>
            <p className="text-xs text-muted-foreground">{job.clientName}</p>
            {job.location && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <MapPin size={11} strokeWidth={1.8} /> {job.location}
              </p>
            )}
          </div>

          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          {/* Total — the headline number. Inc-GST per NZ convention.
              Step 0.01 so cents work, but the field shows just the
              integer dollar amount until the user types decimals. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block flex items-center gap-1.5">
              <DollarSign size={11} strokeWidth={1.8} />
              Total quoted (NZD, inc GST)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                placeholder="e.g. 5450"
                value={totalIncl}
                onChange={(e) => setTotalIncl(e.target.value)}
                className="w-full h-10 pl-7 pr-3 rounded-lg border border-input bg-background text-sm"
                autoFocus
              />
            </div>
          </div>

          {/* Date sent */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block flex items-center gap-1.5">
              <Send size={11} strokeWidth={1.8} />
              Date sent
            </label>
            <input
              type="date"
              value={dateSent}
              onChange={(e) => setDateSent(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
            />
          </div>

          {/* Follow-up date */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block flex items-center gap-1.5">
              <CalendarClock size={11} strokeWidth={1.8} />
              Follow up if no reply by
            </label>
            <input
              type="date"
              value={followUpDate}
              onChange={(e) => setFollowUpDate(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
              Default is 5 days — adjust for tighter or looser windows.
            </p>
          </div>

          {/* Optional PDF attach — for when the quote was prepared
              outside the app (Word, Pages, accounting tool). Attaches
              as a quote_pdf kind so it lives with the job for
              reference. AI-generated quotes already have their PDF
              tied to the draft; this is the manual escape hatch. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block flex items-center gap-1.5">
              <FileText size={11} strokeWidth={1.8} />
              Quote PDF (optional)
            </label>
            {!stagedPdf ? (
              <button
                type="button"
                onClick={() => pdfInputRef.current?.click()}
                className="w-full min-h-[44px] rounded-xl border-2 border-dashed border-input bg-background hover:bg-accent transition-colors flex items-center justify-center gap-2 text-sm font-medium text-foreground"
              >
                <FileText size={14} strokeWidth={1.8} />
                Attach the quote PDF you sent
              </button>
            ) : (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-muted/40 border border-border">
                <FileText size={14} className="text-muted-foreground shrink-0" strokeWidth={1.8} />
                <p className="text-xs text-foreground truncate flex-1 min-w-0">
                  {stagedPdf.name}
                </p>
                <button
                  type="button"
                  onClick={() => setStagedPdf(null)}
                  className="w-6 h-6 rounded-full hover:bg-background flex items-center justify-center text-muted-foreground hover:text-foreground"
                  title="Remove"
                >
                  <X size={12} strokeWidth={2.2} />
                </button>
              </div>
            )}
            <input
              ref={pdfInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={handlePickPdf}
            />
            <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
              Skip this if you used the AI-generated PDF — that's already saved on the job.
            </p>
          </div>

          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button className="flex-1 bg-primary" onClick={handleSave} disabled={saving}>
              {saving
                ? 'Saving…'
                : stagedPdf
                  ? 'Mark as quoted + upload PDF'
                  : 'Mark as quoted'}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
