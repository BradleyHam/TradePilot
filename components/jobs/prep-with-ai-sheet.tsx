'use client';

// =============================================================
// PrepWithAISheet — the live AI quote-drafter flow
// =============================================================
//
// Opened from the JobDetailSheet's "Prep quote with AI" CTA on a
// lead-stage job. Replaces the earlier placeholder sheet now that
// the API route + PDF renderer are real.
//
// States the user sees:
//
//   loading   — calling /api/draft-quote, waiting for Claude
//   draft     — showing the returned scope + line items + total
//   error     — something went wrong; show the message + retry
//   downloaded — PDF generated and downloaded; prompt for next step
//
// Regenerate-with-hint:
//   At any point during 'draft' the user can add a one-line hint
//   ("upper section is more weathered, charge more") and tap
//   Regenerate. We re-call the API with the hint included so
//   Claude can take the guidance into account.
//
// After download we prompt "Mark as quoted now?" so the funnel
// keeps progressing — but skipping is fine, the job stays as a
// lead until the user explicitly flips it.

import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/lib/supabase/client';
import { useStore } from '@/lib/store';
import type { DraftedQuote } from '@/lib/quote-drafter';
import type { Job } from '@/lib/types';
import {
  Sparkles, Download, RotateCcw, AlertCircle, CheckCircle2,
  Send, Info, MapPin,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Props ─────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  /** The lead being quoted. null = sheet stays closed. */
  job: Job | null;
  /** Called when the user taps "Mark as quoted now" after download —
   *  the parent opens the existing MarkAsQuotedSheet, optionally
   *  pre-filled with the AI's suggested total. */
  onMarkAsQuoted: (suggestedTotal: number) => void;
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────

type SheetState =
  | { kind: 'idle' }
  | { kind: 'loading'; hint?: string }
  | { kind: 'draft'; draft: DraftedQuote }
  | { kind: 'error'; message: string }
  | { kind: 'downloaded'; draft: DraftedQuote };

export function PrepWithAISheet({ open, job, onMarkAsQuoted, onClose }: Props) {
  const { getQuoteTemplate, resolveLogoUrl } = useStore();
  const [state, setState] = useState<SheetState>({ kind: 'idle' });
  const [hint, setHint] = useState('');

  // Auto-trigger the first draft when the sheet opens for a job.
  // Subsequent regenerates are user-initiated via the Regenerate
  // button. We key off (open, job.id) so a fresh open of a different
  // job kicks off a new draft, but unrelated re-renders don't.
  useEffect(() => {
    if (!open || !job) {
      setState({ kind: 'idle' });
      setHint('');
      return;
    }
    if (state.kind === 'idle') {
      void runDraft();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job?.id]);

  async function runDraft(withHint?: string) {
    if (!job) return;
    setState({ kind: 'loading', hint: withHint });
    try {
      // Get the user's access token to authenticate the API call.
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setState({ kind: 'error', message: 'Not signed in — refresh and try again.' });
        return;
      }
      const res = await fetch('/api/draft-quote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ jobId: job.id, hint: withHint }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setState({
          kind: 'error',
          message: json.error ?? `Drafting failed (HTTP ${res.status}).`,
        });
        return;
      }
      setState({ kind: 'draft', draft: json.draft as DraftedQuote });
      setHint(''); // clear hint after successful regenerate
    } catch (err) {
      setState({
        kind: 'error',
        message: `Network error: ${(err as Error).message ?? 'unknown'}`,
      });
    }
  }

  async function handleDownload() {
    if (state.kind !== 'draft' || !job) return;
    const template = getQuoteTemplate();
    if (!template) {
      setState({ kind: 'error', message: 'Quote template not set up — go to Settings → Quote template first.' });
      return;
    }
    const logoUrl = resolveLogoUrl(template.header.logoStoragePath);

    try {
      // Dynamic import @react-pdf/renderer — it's heavy (~500KB) and
      // we don't need it on initial page load. Bundle only loads when
      // the user actually taps Download.
      const { pdf } = await import('@react-pdf/renderer');
      const { QuotePdfDocument } = await import('@/components/quotes/quote-pdf');

      const quoteNumber = generateQuoteNumber();
      const doc = (
        <QuotePdfDocument
          draft={state.draft}
          template={template}
          job={job}
          logoUrl={logoUrl}
          quoteNumber={quoteNumber}
        />
      );
      const blob = await pdf(doc).toBlob();
      triggerDownload(blob, `Quote-${slugify(job.name)}-${quoteNumber}.pdf`);
      setState({ kind: 'downloaded', draft: state.draft });
    } catch (err) {
      setState({
        kind: 'error',
        message: `PDF generation failed: ${(err as Error).message ?? 'unknown'}`,
      });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────

  if (!job) return null;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl max-h-[92dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles size={16} className="text-primary" strokeWidth={2} />
            AI quote drafter
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-4 pb-6">
          {/* Job context strip — always visible so user sees what we're
              drafting for. */}
          <div className="rounded-xl bg-muted/40 border border-border px-3 py-2.5">
            <p className="text-sm font-medium text-foreground">{job.name}</p>
            <p className="text-xs text-muted-foreground">{job.clientName}</p>
            {job.location && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <MapPin size={11} strokeWidth={1.8} /> {job.location}
              </p>
            )}
          </div>

          {/* State-specific body */}
          {state.kind === 'loading' && <LoadingView hint={state.hint} />}
          {state.kind === 'error' && (
            <ErrorView message={state.message} onRetry={() => runDraft()} onClose={onClose} />
          )}
          {state.kind === 'draft' && (
            <DraftView
              draft={state.draft}
              hint={hint}
              setHint={setHint}
              onRegenerate={() => runDraft(hint.trim() || undefined)}
              onDownload={handleDownload}
            />
          )}
          {state.kind === 'downloaded' && (
            <DownloadedView
              draft={state.draft}
              onMarkAsQuoted={() => onMarkAsQuoted(state.draft.totalInclGst)}
              onClose={onClose}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Sub-views ─────────────────────────────────────────────────────────

function LoadingView({ hint }: { hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-8 flex flex-col items-center gap-3 text-center">
      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center animate-pulse">
        <Sparkles size={18} className="text-primary" strokeWidth={2} />
      </div>
      <p className="text-sm font-medium text-foreground">
        {hint ? 'Regenerating with your note…' : 'Drafting the quote…'}
      </p>
      <p className="text-xs text-muted-foreground max-w-xs leading-snug">
        Claude is reading the wrap-up data, your template, the Resene rate sheet,
        and any comparable past jobs. Usually takes 20-30 seconds.
      </p>
    </div>
  );
}

function ErrorView({
  message, onRetry, onClose,
}: {
  message: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
        <AlertCircle size={15} className="text-red-600 mt-0.5 shrink-0" strokeWidth={2} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-red-700">Something went wrong</p>
          <p className="text-xs text-red-600 mt-1 leading-snug">{message}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onClose}>Close</Button>
        <Button className="flex-1 bg-primary" onClick={onRetry}>
          <RotateCcw size={13} className="mr-1.5" /> Try again
        </Button>
      </div>
    </div>
  );
}

function DraftView({
  draft, hint, setHint, onRegenerate, onDownload,
}: {
  draft: DraftedQuote;
  hint: string;
  setHint: (v: string) => void;
  onRegenerate: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* Warnings strip — surfaced loudly so Brad sees them before
          committing to download. */}
      {draft.warnings && draft.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <Info size={14} className="text-amber-700 mt-0.5 shrink-0" strokeWidth={2} />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide">
                Double-check before sending
              </p>
              <ul className="mt-1 space-y-1">
                {draft.warnings.map((w, i) => (
                  <li key={i} className="text-xs text-amber-900 leading-snug">• {w}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Scope paragraph */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
          Scope (customer-facing)
        </p>
        <p className="text-sm text-foreground leading-relaxed bg-card border border-border rounded-xl px-3 py-2.5">
          {draft.scopeParagraph}
        </p>
      </div>

      {/* Line items */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
          Line items
        </p>
        <div className="rounded-xl border border-border bg-card overflow-hidden divide-y divide-border">
          {draft.lineItems.map((item, i) => (
            <div key={i} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-foreground flex-1 min-w-0">
                  {item.description}
                </p>
                <p className="text-sm font-semibold text-foreground shrink-0">
                  {formatMoney(item.totalExGst)}
                </p>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {formatQty(item.quantity)} {item.unit} × {formatMoney(item.unitPriceExGst)}
              </p>
              {item.reasoning && (
                <p className="text-[11px] text-muted-foreground/80 mt-1 italic leading-snug">
                  {item.reasoning}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Totals strip */}
      <div className="rounded-xl border border-border bg-card px-3 py-2.5 space-y-1">
        <Row label="Subtotal (ex-GST)" value={formatMoney(draft.subtotalExGst)} />
        <Row label="GST" value={formatMoney(draft.gstAmount)} />
        <div className="pt-1.5 mt-1.5 border-t border-border">
          <Row
            label="Total inc-GST"
            value={formatMoney(draft.totalInclGst)}
            emphasis
          />
        </div>
      </div>

      {/* AI reasoning — collapsible-feel section. Not hidden because
          it's important context for the price; just styled muted so
          it doesn't compete with the numbers. */}
      {draft.reasoning && (
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
            How I arrived at the price
          </p>
          <p className="text-xs text-muted-foreground leading-snug bg-muted/40 border border-border rounded-xl px-3 py-2.5">
            {draft.reasoning}
          </p>
        </div>
      )}

      {/* Regenerate-with-hint */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
          Not quite right? Add a note and regenerate
        </p>
        <Textarea
          placeholder="e.g. The upper cedar section is more weathered — needs heavy prep and an extra coat."
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          className="resize-none text-sm"
          rows={2}
        />
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full"
          onClick={onRegenerate}
        >
          <RotateCcw size={13} className="mr-1.5" /> Regenerate
        </Button>
      </div>

      {/* Primary action: download */}
      <Button className="w-full bg-primary" onClick={onDownload}>
        <Download size={14} className="mr-1.5" /> Download quote PDF
      </Button>
    </div>
  );
}

function DownloadedView({
  draft, onMarkAsQuoted, onClose,
}: {
  draft: DraftedQuote;
  onMarkAsQuoted: () => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3">
        <div className="flex items-start gap-2">
          <CheckCircle2 size={15} className="text-emerald-700 mt-0.5 shrink-0" strokeWidth={2} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-emerald-800">
              PDF downloaded — total ${formatMoney(draft.totalInclGst)}
            </p>
            <p className="text-xs text-emerald-700 mt-0.5 leading-snug">
              Check it over, send it to the customer (your usual email or messaging),
              then come back and mark it as quoted so the chase-list keeps an eye on it.
            </p>
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onClose}>
          Close
        </Button>
        <Button className="flex-1 bg-primary" onClick={onMarkAsQuoted}>
          <Send size={14} className="mr-1.5" /> Mark as quoted now
        </Button>
      </div>
    </div>
  );
}

function Row({
  label, value, emphasis,
}: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className={cn('text-sm', emphasis ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
        {label}
      </span>
      <span className={cn('text-sm tabular-nums', emphasis ? 'font-bold text-foreground' : 'text-foreground')}>
        {value}
      </span>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatMoney(n: number): string {
  return `$${n.toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * Trigger a browser download of the blob with the given filename.
 * Standard append-click-remove pattern that works on iOS Safari too.
 */
function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Quote numbering — simple year + timestamp slug for now. e.g.
 * "Q-2026-0524-1830". A future enhancement is a real running counter
 * stored on the business, but this is unique-enough for v1 and
 * sorts naturally in Brad's Downloads folder.
 */
function generateQuoteNumber(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `Q-${y}-${m}${day}-${hh}${mm}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'job';
}
