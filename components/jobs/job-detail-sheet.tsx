'use client';

import { useState, useRef } from 'react';
import { Job, Entry, Material, Quote, QuoteAttachment, QuoteAttachmentKind, ActivityType, Unit } from '@/lib/types';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import {
  Phone, Mail, MapPin, Clock, DollarSign, Receipt, FileText, MessageSquare,
  AlertCircle, StickyNote, TrendingUp, Edit3, Plus, Package, ExternalLink, X,
  Camera, Trash2, Loader2, CalendarDays, Sparkles, Send,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatEntryDate } from '@/lib/format-date';
import { JOB_STATUSES } from '@/lib/mock-data';
import { JobStatus, LostReason, WonReason } from '@/lib/types';
import { jobStats, entryExGst } from '@/lib/job-stats';
import { hoursByWorker, blendedTargetRate, allWorkerRates, describeMix } from '@/lib/worker-rates';
import { HourlyRateGauge, IncomeVsExpenses, HoursByActivity } from './job-charts';
import { InvoiceAction } from './invoice-action';
import { InvoicesList } from './invoices-list';
import { BookedDates } from './booked-dates';
import { OutcomeSheet, OutcomeKind } from './outcome-sheet';
import { MarkAsQuotedSheet } from './mark-as-quoted-sheet';
import { PrepWithAISheet } from './prep-with-ai-sheet';
import { CompletionDateSheet } from './completion-date-sheet';
import { CostEnginePreview } from './cost-engine-preview';

interface JobDetailSheetProps {
  job: Job | null;
  open: boolean;
  onClose: () => void;
}

const TYPE_ICON: Record<string, React.ElementType> = {
  expense: Receipt, income: DollarSign, hours: Clock, enquiry: MessageSquare,
  quote: FileText, bill: AlertCircle, note: StickyNote,
};

const TYPE_COLOR: Record<string, string> = {
  expense: 'text-red-500', income: 'text-green-500', hours: 'text-blue-500',
  enquiry: 'text-violet-500', quote: 'text-amber-500', bill: 'text-orange-500', note: 'text-slate-500',
};

// Human-readable labels for the outcome reasons stored on a job. Keep these
// in sync with the chip options in `outcome-sheet.tsx` — same wording so the
// captured-then-displayed text feels stable.
const LOST_REASON_LABEL: Record<LostReason, string> = {
  'price':             'Price too high',
  'no-reply':          'No reply',
  'went-elsewhere':    'Went with another painter',
  'scope-changed':     'Scope changed',
  'project-cancelled': 'Project cancelled',
  'timing':            'Timing didn’t work',
  'other':             'Other',
};

const WON_REASON_LABEL: Record<WonReason, string> = {
  'referral':          'Referral',
  'returning-client':  'Returning client',
  'price':             'Best price',
  'trust-rapport':     'Trust / rapport',
  'speed-of-response': 'Speed of response',
  'unique-fit':        'Right fit for the job',
  'other':             'Other',
};

/**
 * Has a site-visit wrap-up been completed for this job? Used to gate
 * the 'Prep with AI' CTA on the lead-stage action strip. Mirrors the
 * same rule the Leads page's "To quote" filter uses — any wrap-up
 * field being set counts.
 */
function hasWrapUpData(job: Job): boolean {
  return Boolean(
    job.scopeNotes
    || job.surfaceAreaM2
    || job.prepLevel
    || job.quoteReadyBy
    || (job.accessNotes && job.accessNotes.length > 0),
  );
}

export function JobDetailSheet({ job, open, onClose }: JobDetailSheetProps) {
  const {
    jobs, entries, invoices, scheduleItems, materials, quotes, quoteAttachments,
    businessId, updateJob, reconcileJobSchedule, deleteJob, addEntry,
    settings,
  } = useStore();
  const [reconciling, setReconciling] = useState(false);
  const [showInvoice, setShowInvoice] = useState(false);
  // When set, the InvoiceAction sheet opens in edit mode for this invoice.
  const [editingInvoice, setEditingInvoice] = useState<import('@/lib/types').Invoice | null>(null);
  // When set, the OutcomeSheet opens to capture why we won/lost a job.
  const [outcomePrompt, setOutcomePrompt] = useState<OutcomeKind | null>(null);
  // True when the OutcomeSheet was opened via the "Edit" button on the
  // outcome panel (as opposed to being auto-prompted by a status change).
  // We use this to decide whether to auto-close the whole job sheet after
  // save — closing makes sense after a status flip, but is jarring when
  // Brad just tweaked the reason on an already-lost job.
  const [outcomeEditing, setOutcomeEditing] = useState(false);
  // When true, the CompletionDateSheet opens to capture the actual finish
  // date so we can reconcile the calendar accurately.
  const [askCompletionDate, setAskCompletionDate] = useState(false);
  // When true, the MarkAsQuotedSheet opens — collects total $, date
  // sent, and follow-up date, then flips the lead to status='quoted'.
  const [markAsQuotedOpen, setMarkAsQuotedOpen] = useState(false);
  // When the user goes Prep-with-AI → Download PDF → Mark as quoted,
  // we pre-fill the total with whatever Claude suggested. Carried in
  // this state so the flow doesn't have to thread it through props.
  // Null = no AI suggestion, MarkAsQuotedSheet uses the job's quoteAmount.
  const [aiSuggestedTotal, setAiSuggestedTotal] = useState<number | null>(null);
  // When true, the live AI quote drafter sheet opens.
  const [prepWithAIOpen, setPrepWithAIOpen] = useState(false);

  if (!job) return null;

  // The `job` prop is captured at click time and won't reflect store updates
  // (e.g. status changes). Look up the live version from the store so the
  // controlled Select and the rest of this view stay in sync.
  const liveJob = jobs.find((j) => j.id === job.id) ?? job;

  const jobEntries = entries
    // Drafts (unconfirmed parsed bills, may have a fuzzy-matched jobId
    // pre-filled by the parser) excluded from the job activity log until
    // Brad confirms them on Home. Avoids them inflating jobStats() too.
    .filter((e) => e.jobId === liveJob.id && !e.isDraft)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // Pass materials so jobStats can include source='overhead' rows in
  // per-job expenses. Bill-sourced material rows are NOT added here —
  // they're already represented by the bill entries jobStats already sums.
  const stats = jobStats(liveJob, entries, materials);
  const { totalHours, totalExpenses, totalIncome, expectedIncome, expectedProfit, expectedIsConfident, expectedHourlyRate } = stats;

  function handleStatusChange(s: string | null) {
    if (!s) return;
    const newStatus = s as JobStatus;
    const prevStatus = liveJob.status;
    updateJob(liveJob.id, { status: newStatus });

    // Once the status flip is in flight, prompt for outcome reason. We don't
    // re-prompt if the user already filled it in for this job — they can
    // change the status away and back to re-trigger.
    if (newStatus === 'lost' && !liveJob.lostReason) {
      setOutcomePrompt('lost');
    } else if (newStatus === 'accepted' && !liveJob.wonReason) {
      setOutcomePrompt('won');
    }

    // First time entering a "done" status (and not lost) → ask for the
    // actual finish date. The auto-reconcile inside updateJob runs with
    // whatever's already set; once the user answers here, we re-reconcile
    // with the explicit date so the calendar tidies up correctly.
    const TERMINAL_DONE: JobStatus[] = ['completed', 'invoiced', 'paid'];
    const wasTerminalDone = TERMINAL_DONE.includes(prevStatus);
    if (TERMINAL_DONE.includes(newStatus) && !wasTerminalDone) {
      setAskCompletionDate(true);
    }
  }

  function handleCompletionDateSave(completionDate: string) {
    setAskCompletionDate(false);
    // Persist the finish date on the job, then reconcile the schedule using
    // that explicit date as the source of truth.
    updateJob(liveJob.id, { endDate: completionDate });
    reconcileJobSchedule(liveJob.id, false, completionDate).catch((err) => {
      console.error('[job-detail-sheet] reconcile after completion-date save failed:', err);
    });
  }

  function handleOutcomeSave(data: {
    lostReason?: import('@/lib/types').LostReason;
    wonReason?: import('@/lib/types').WonReason;
    outcomeNotes?: string;
  }) {
    updateJob(liveJob.id, data);
    setOutcomePrompt(null);
    // After a status flip there's nothing else to do on a lost/accepted
    // job in this sheet, so close it and return Brad to the jobs list.
    // But if he opened the outcome sheet via the "Edit" affordance on an
    // already-set outcome panel, keep the job sheet open so he can carry
    // on browsing the job.
    if (outcomeEditing) {
      setOutcomeEditing(false);
    } else {
      onClose();
    }
  }

  // Delete the job. Blocked if anything's attached; the prompt shows
  // counts so the user knows what to move/skip first. Hard delete after
  // a confirm — the block rule means only genuinely empty jobs reach
  // the confirm step, so there's nothing worth soft-deleting.
  async function handleDelete() {
    const res = await deleteJob(liveJob.id);
    if (res.ok) {
      onClose();
      return;
    }
    if (res.blockedBy) {
      const b = res.blockedBy;
      const items: string[] = [];
      if (b.entries) items.push(`${b.entries} entr${b.entries === 1 ? 'y' : 'ies'} (hours/expenses/bills)`);
      if (b.materials) items.push(`${b.materials} material${b.materials === 1 ? '' : 's'}`);
      if (b.quotes) items.push(`${b.quotes} quote${b.quotes === 1 ? '' : 's'}`);
      if (b.invoices) items.push(`${b.invoices} invoice${b.invoices === 1 ? '' : 's'}`);
      if (b.quoteAttachments) items.push(`${b.quoteAttachments} attachment${b.quoteAttachments === 1 ? '' : 's'}`);
      if (b.scheduleItems) items.push(`${b.scheduleItems} schedule item${b.scheduleItems === 1 ? '' : 's'}`);
      alert(
        `Can't delete "${liveJob.name}" — it has:\n\n• ${items.join('\n• ')}\n\n`
        + `Move these to a different job (or delete them) first, then try again.`,
      );
      return;
    }
    if (res.error) alert(`Couldn't delete: ${res.error}`);
  }

  function confirmAndDelete() {
    if (typeof window === 'undefined') return;
    if (!window.confirm(
      `Delete "${liveJob.name}"?\n\nThis can't be undone. The job will only be deleted if nothing's attached to it.`,
    )) return;
    void handleDelete();
  }

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="bottom" className="rounded-t-2xl p-0" showCloseButton={false}>
        {/* h-[92dvh] (dynamic viewport height) instead of vh so the sheet
            shrinks/grows with Safari's URL bar on iOS — otherwise the top
            of the sheet (and its sticky header) sits hidden behind the URL
            bar when it's showing. */}
        <div className="h-[92dvh] flex flex-col overflow-hidden">
          {/* Fixed header — always visible. Inner wrapper caps width on desktop
              so the title/status row doesn't sprawl across a 27" monitor.
              Top padding uses safe-area-inset-top so the status dropdown
              isn't hidden under Safari's URL bar / Dynamic Island when the
              sheet is at 92vh on iPhone. */}
          <div className="shrink-0 bg-card border-b border-border">
            <div
              className="mx-auto w-full max-w-2xl px-4 md:px-6 pb-3"
              style={{ paddingTop: 'max(env(safe-area-inset-top), 1rem)' }}
            >
              <div className="flex items-start justify-between gap-3">
                <SheetTitle className="text-lg font-bold leading-tight text-left flex-1 min-w-0">
                  {liveJob.name}
                </SheetTitle>
                <Select value={liveJob.status} onValueChange={handleStatusChange}>
                  <SelectTrigger className="h-9 text-sm w-36 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {JOB_STATUSES.map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">
                        {s.replace('-', ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Scrollable body — same max-width container so the content column
              stays a comfortable reading width. Phone is unaffected (max-w-2xl
              is wider than any phone viewport). */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="mx-auto w-full max-w-2xl px-4 md:px-6 pt-4 pb-10 space-y-5">
          {/* Client info — read-only block + inline editor toggle.
              The wrap-up auto-creates jobs with clientName='New lead'
              as a placeholder; before the quote PDF can go out, Brad
              needs to fix that. Inline editing is faster than a
              separate sheet and the fields are short. */}
          <ClientInfoBlock
            job={liveJob}
            onSave={(patch) => updateJob(liveJob.id, patch)}
          />

          {/* Lead-stage action strip — only on leads. The two CTAs are
              the entire user-facing API for the quote flow today:
                'Prep with AI' for jobs with wrap-up data; and
                'Mark as quoted' for jobs you've handled outside the
                app. Both flip the funnel forward. */}

          {/* Lead-stage action strip — only on leads. The two CTAs are
              the entire user-facing API for the quote flow today:
                'Prep with AI' (placeholder until Session 3) for jobs
                with wrap-up data; and 'Mark as quoted' for jobs you've
                handled outside the app. Both flip the funnel forward. */}
          {liveJob.status === 'lead' && (
            <div className="flex flex-col sm:flex-row gap-2">
              {hasWrapUpData(liveJob) && (
                <button
                  type="button"
                  onClick={() => setPrepWithAIOpen(true)}
                  className="flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
                >
                  <Sparkles size={15} strokeWidth={2} />
                  Prep quote with AI
                </button>
              )}
              <button
                type="button"
                onClick={() => setMarkAsQuotedOpen(true)}
                className="flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] rounded-xl border border-border bg-background text-foreground text-sm font-semibold hover:bg-accent transition-colors"
              >
                <Send size={15} strokeWidth={2} />
                Mark as quoted
              </button>
            </div>
          )}

          {/* Outcome panel — shows the captured win/loss reason and any
              freeform notes once Brad has answered the OutcomeSheet prompt.
              This is where the data we collect when a status flips to
              lost/accepted actually surfaces — without this block the
              answers vanish into the database. Tap to edit re-opens the
              same OutcomeSheet in edit mode (initial values come from the
              live job). Hidden if no reason has been recorded yet. */}
          {(() => {
            const isLost = liveJob.status === 'lost';
            const isWon = (['accepted','booked','in-progress','completed','invoiced','paid'] as JobStatus[])
              .includes(liveJob.status);
            const reasonLabel = isLost && liveJob.lostReason
              ? LOST_REASON_LABEL[liveJob.lostReason]
              : isWon && liveJob.wonReason
                ? WON_REASON_LABEL[liveJob.wonReason]
                : null;
            const notes = liveJob.outcomeNotes;
            // Don't render if there's nothing captured yet — keeps the
            // pre-quote stages of the sheet uncluttered.
            if (!reasonLabel && !notes) return null;

            const heading = isLost ? 'Why we lost it' : 'Why we won it';
            const accent = isLost
              ? 'border-rose-200 bg-rose-50/60'
              : 'border-emerald-200 bg-emerald-50/60';
            const chip = isLost
              ? 'bg-rose-100 text-rose-900 border-rose-200'
              : 'bg-emerald-100 text-emerald-900 border-emerald-200';

            return (
              <div className={cn('rounded-xl border p-3', accent)}>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {heading}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setOutcomeEditing(true);
                      setOutcomePrompt(isLost ? 'lost' : 'won');
                    }}
                    className="text-xs text-primary font-medium hover:underline min-h-[28px] px-1 -mr-1"
                  >
                    Edit
                  </button>
                </div>
                {reasonLabel && (
                  <span className={cn(
                    'inline-block mt-2 px-2 py-1 rounded-md text-xs font-medium border',
                    chip,
                  )}>
                    {reasonLabel}
                  </span>
                )}
                {notes && (
                  <p className="mt-2 text-sm text-foreground whitespace-pre-wrap leading-snug">
                    {notes}
                  </p>
                )}
              </div>
            );
          })()}

          {/* Completed on — only meaningful for terminal-status jobs. Shows
              the recorded endDate (formatted) or 'Unknown — tap to set' so
              Brad can backfill historical jobs in-place. The endDate is what
              the Completed-tab sort uses, so populating this directly fixes
              the order of the Jobs list. */}
          {(['completed','invoiced','paid'] as JobStatus[]).includes(liveJob.status) && (
            <CompletedOnRow
              job={liveJob}
              onChange={(endDate) => updateJob(liveJob.id, { endDate })}
            />
          )}

          {/* Booked dates — visible from accepted through in-progress. Once
              the job is completed/invoiced/paid the calendar entries are
              historical and edited via the Schedule page if needed. */}
          {(['accepted','booked','in-progress'] as JobStatus[]).includes(liveJob.status) && (
            <BookedDates job={liveJob} />
          )}

          {/* "Reconcile schedule" — only shown for terminal-status jobs that
              still have plan-level schedule items hanging around. Lets the
              user retroactively clean up "I marked this done but the calendar
              still shows the original plan" cases.
              For non-lost jobs we open the completion-date prompt first so
              the user can pick the actual finish day; for lost jobs we just
              prune future plans (no date needed). */}
          {(() => {
            const TERMINAL: JobStatus[] = ['completed', 'invoiced', 'paid', 'lost'];
            if (!TERMINAL.includes(liveJob.status)) return null;
            const isLost = liveJob.status === 'lost';
            const today = new Date().toISOString().split('T')[0];
            // Resolve the same effective completion date the reconcile would
            // use, so the "X items out of date" count is accurate.
            //   1. job.endDate (set by the prompt)
            //   2. latest hours-entry date on this job
            //   3. today
            let latestHoursDate = '';
            for (const e of entries) {
              if (e.jobId === liveJob.id && e.type === 'hours' && e.entryDate) {
                if (!latestHoursDate || e.entryDate > latestHoursDate) {
                  latestHoursDate = e.entryDate;
                }
              }
            }
            let completionDate = today;
            if (!isLost) {
              if (liveJob.endDate) completionDate = liveJob.endDate;
              else if (latestHoursDate && latestHoursDate <= today) completionDate = latestHoursDate;
            }
            const stale = scheduleItems.filter((s) => {
              if (s.jobId !== liveJob.id) return false;
              if (isLost) return !s.completed && s.date > today;
              if (s.date > completionDate) return true;
              return !s.completed;
            });
            if (stale.length === 0) return null;
            return (
              <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm">
                <p className="font-medium text-amber-900 mb-1">
                  {stale.length} schedule item{stale.length === 1 ? '' : 's'} out of date
                </p>
                <p className="text-xs text-amber-800/80 mb-2">
                  {isLost
                    ? 'This job was lost — the calendar still has future bookings for it. Tidy them up.'
                    : liveJob.endDate
                      ? `Using ${liveJob.endDate} as the finish date. Days after that will be removed; days on or before will be marked done.`
                      : 'Set the actual finish date so the calendar can tidy up days that didn\'t happen.'}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="bg-card border-amber-300 hover:bg-amber-100 text-amber-900"
                  disabled={reconciling}
                  onClick={async () => {
                    if (isLost) {
                      // No date needed for lost jobs; reconcile immediately.
                      setReconciling(true);
                      try {
                        await reconcileJobSchedule(liveJob.id, true);
                      } finally {
                        setReconciling(false);
                      }
                    } else if (liveJob.endDate) {
                      // We already know the finish date — just reconcile,
                      // no need to prompt again. Pass the explicit date so
                      // the store doesn't have to read it through state.
                      setReconciling(true);
                      try {
                        await reconcileJobSchedule(liveJob.id, false, liveJob.endDate);
                      } finally {
                        setReconciling(false);
                      }
                    } else {
                      // No finish date yet — ask for one. Saving it will
                      // trigger the reconcile with the explicit date.
                      setAskCompletionDate(true);
                    }
                  }}
                >
                  {reconciling
                    ? 'Reconciling…'
                    : isLost
                      ? 'Tidy up calendar'
                      : liveJob.endDate ? 'Reconcile schedule' : 'Set finish date & tidy up'}
                </Button>
              </div>
            );
          })()}

          {/* Invoice action — visible from accepted onwards. Button label
              adapts to what's already issued. */}
          {(['accepted','booked','in-progress','completed','invoiced','paid'] as JobStatus[])
            .includes(liveJob.status) && (() => {
              const jobInvoices = invoices.filter((i) => i.jobId === liveJob.id);
              const totalInvoiced = jobInvoices.reduce((s, i) => s + i.amountExGst, 0);
              const totalWork = liveJob.invoiceAmount ?? liveJob.quoteAmount ?? 0;
              const allInvoiced = totalWork > 0 && totalInvoiced >= totalWork - 0.01;
              const allPaid = jobInvoices.length > 0 && jobInvoices.every((i) => i.paid);

              if (allInvoiced && allPaid) return null;

              const label = jobInvoices.length === 0
                ? 'Issue first invoice'
                : allInvoiced
                  ? 'Issue another invoice'
                  : `Issue invoice (${jobInvoices.length} so far)`;

              return (
                <Button
                  variant="outline"
                  className="w-full h-11 border-amber-300 bg-amber-50/50 text-amber-900 hover:bg-amber-100/60"
                  onClick={() => { setEditingInvoice(null); setShowInvoice(true); }}
                >
                  <Receipt size={16} className="mr-2 text-amber-600" strokeWidth={1.8} />
                  {label}
                </Button>
              );
            })()}

          <Separator />

          {/* Financial summary */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Financials</p>
              <p className="text-[10px] text-muted-foreground italic">all amounts ex GST</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(() => {
                // Pre-derive what the income/profit/$h cards should show. The
                // expectedIncome already reflects: invoiced/paid → invoice
                // amount, otherwise → income received → quote → estimate.
                const isFinalised = liveJob.status === 'invoiced'
                  || liveJob.status === 'completed'
                  || liveJob.status === 'paid';
                const isFullyPaid = isFinalised
                  && expectedIncome > 0
                  && totalIncome >= expectedIncome - 0.01;

                let incomeLabel: string;
                let incomeSubvalue: string | undefined;
                if (isFullyPaid) {
                  incomeLabel = 'Income received';
                  incomeSubvalue = undefined;
                } else if (isFinalised && expectedIncome > 0) {
                  incomeLabel = 'Invoiced';
                  incomeSubvalue = totalIncome > 0
                    ? `$${totalIncome.toLocaleString('en-NZ')} received so far`
                    : 'awaiting payment';
                } else if (totalIncome > 0) {
                  incomeLabel = 'Income received';
                  incomeSubvalue = undefined;
                } else if (expectedIncome > 0) {
                  incomeLabel = 'Expected income';
                  incomeSubvalue = expectedIsConfident ? 'projected' : 'estimated';
                } else {
                  incomeLabel = 'Expected income';
                  incomeSubvalue = undefined;
                }

                const profitLabel = isFullyPaid
                  ? 'Profit'
                  : isFinalised
                    ? 'Profit (when paid)'
                    : totalIncome > 0
                      ? 'Profit'
                      : 'Expected profit';

                const hourlyLabel = isFullyPaid
                  ? 'Hourly rate'
                  : isFinalised
                    ? 'Hourly rate (when paid)'
                    : totalIncome > 0
                      ? 'Hourly rate'
                      : 'Expected $/h';

                return (
                  <>
                    <StatCard label="Quote" value={liveJob.quoteAmount ? `$${liveJob.quoteAmount.toLocaleString('en-NZ')}` : '—'} />
                    <StatCard
                      label={incomeLabel}
                      value={expectedIncome > 0 ? `$${expectedIncome.toLocaleString('en-NZ')}` : '—'}
                      valueClass="text-green-600"
                      subvalue={incomeSubvalue}
                    />
                    <StatCard
                      label="Expenses"
                      value={totalExpenses > 0 ? `$${totalExpenses.toLocaleString('en-NZ')}` : '—'}
                      valueClass="text-red-500"
                    />
                    <StatCard
                      label={profitLabel}
                      value={
                        expectedIncome > 0 || totalExpenses > 0
                          ? `$${expectedProfit.toLocaleString('en-NZ')}`
                          : '—'
                      }
                      valueClass={expectedProfit >= 0 ? 'text-green-600' : 'text-red-500'}
                    />
                    <StatCard label="Hours" value={totalHours > 0 ? `${totalHours}h` : '—'} valueClass="text-blue-600" />
                    <StatCard
                      label={hourlyLabel}
                      value={expectedHourlyRate != null ? `$${expectedHourlyRate.toFixed(0)}/h` : '—'}
                    />
                  </>
                );
              })()}
            </div>
          </div>

          {/* Visualisations — only render the ones that have data */}
          {(expectedHourlyRate != null || stats.totalExpenses > 0 || stats.totalHours > 0) && (
            <>
              <Separator />
              <div className="space-y-3">
                {(() => {
                  // Blended-target gauge: weight the per-tier rates by
                  // the actual hours mix on this job. Falls back to the
                  // static $85–100 default when no hours have been
                  // logged yet (gauge keeps the global target).
                  const hoursEntries = jobEntries.filter((e) => e.type === 'hours');
                  const mix = hoursByWorker(hoursEntries);
                  const rates = allWorkerRates(settings);
                  const blendedTarget = blendedTargetRate(mix, rates);
                  const mixDesc = describeMix(mix);
                  return (
                    <HourlyRateGauge
                      hourlyRate={expectedHourlyRate}
                      // "Expected" means the income hasn't fully landed yet —
                      // either no income at all, or the job is invoiced but
                      // payments are partial (e.g. deposit only).
                      isExpected={
                        totalIncome === 0
                        || ((liveJob.status === 'invoiced' || liveJob.status === 'completed')
                            && expectedIncome > totalIncome + 0.01)
                      }
                      blendedTarget={blendedTarget}
                      mixDescription={mix.totalLabourHours > 0 ? mixDesc : undefined}
                    />
                  );
                })()}
                <IncomeVsExpenses stats={stats} />
                <HoursByActivity entries={jobEntries} />
              </div>
            </>
          )}

          {/* Invoices issued on this job */}
          {invoices.some((i) => i.jobId === liveJob.id) && (
            <>
              <Separator />
              <InvoicesList
                jobId={liveJob.id}
                onEdit={(inv) => {
                  setEditingInvoice(inv);
                  setShowInvoice(true);
                }}
              />
            </>
          )}

          {/* Materials used on this job — paint, primer, sundries etc.
              Populated automatically when bills are confirmed with line
              items on the Home "Bills to confirm" flag. Hidden when empty
              so we don't render a "Materials (0)" stub on jobs that
              haven't had any bills attached yet. */}
          {/* Cost engine preview — shows the Resene PD-anchored cost
              estimate for any quote on this job with structured
              scope_zones data. Hidden when no quote has scope_zones,
              so legacy jobs stay clean. */}
          <CostEnginePreview
            job={liveJob}
            quotes={quotes}
            entries={entries}
            invoices={invoices}
          />

          {/* Quotes on this job — surfaces both legacy-imported quotes
              (from the Finances sheet) AND ones created by the project-
              archive importer's Link flow. Hidden when empty. */}
          <JobQuotesList jobId={liveJob.id} quotes={quotes} />

          {/* Plans + photos attached to any of the job's quotes. Tap
              to open the signed Storage URL in a new tab. Hidden when
              empty. */}
          <JobAttachmentsList
            jobId={liveJob.id}
            quotes={quotes}
            attachments={quoteAttachments}
          />

          <JobMaterialsList jobId={liveJob.id} materials={materials} entries={entries} />

          {/* Notes — always rendered so the user can add/edit notes on any
              job, including lost ones. NotesEditor flips between read mode
              (text + Edit button) and edit mode (textarea + Save/Cancel). */}
          <Separator />
          <NotesEditor
            value={liveJob.notes ?? ''}
            onSave={(next) => updateJob(liveJob.id, { notes: next })}
          />

          {/* Entries */}
          {jobEntries.length > 0 && (
            <>
              <Separator />
              <div>
                {/* Header doubles as a reconciliation hint: the rows below
                    show GROSS amounts (matching what's on the receipt) but
                    the Financials/profit numbers above are ex-GST. Showing
                    both totals here lets the eye reconcile the two views
                    without doing GST arithmetic in your head. We hide the
                    breakdown when there's no expense/bill activity since
                    GST only matters for those (income on jobs is stored
                    ex-GST already). */}
                {(() => {
                  const costEntries = jobEntries.filter(
                    // Drafts (unconfirmed parsed bills) excluded — they
                    // mustn't affect any job's cost totals until confirmed.
                    (e) => (e.type === 'expense' || e.type === 'bill') && !e.isDraft,
                  );
                  const grossSum = costEntries.reduce(
                    (s, e) => s + (e.amount ?? 0),
                    0,
                  );
                  const exGstSum = costEntries.reduce(
                    (s, e) => s + entryExGst(e),
                    0,
                  );
                  const fmt0 = (n: number) =>
                    `$${Math.round(n).toLocaleString('en-NZ')}`;
                  return (
                    <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Activity ({jobEntries.length})
                      </p>
                      {costEntries.length > 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          {fmt0(grossSum)} gross · {fmt0(exGstSum)} ex-GST
                        </p>
                      )}
                    </div>
                  );
                })()}
                <div className="space-y-2">
                  {jobEntries.map((entry) => {
                    const Icon = TYPE_ICON[entry.type] ?? StickyNote;
                    return (
                      <div key={entry.id} className="flex items-center gap-3 p-3 rounded-xl bg-muted/40">
                        <Icon size={15} className={cn(TYPE_COLOR[entry.type], 'shrink-0')} strokeWidth={1.8} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground truncate">{entry.description}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {entry.category && <span className="capitalize">{entry.category} · </span>}
                            {entry.entryDate}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          {entry.amount !== undefined && (
                            <p className={cn('text-sm font-semibold', entry.type === 'income' ? 'text-green-600' : 'text-foreground')}>
                              {/* Bills count as costs against the job (whether paid yet or not),
                                  so they get the '-' sign just like expenses. Income is the
                                  only positive flow on a job. */}
                              {entry.type === 'expense' || entry.type === 'bill' ? '-' : '+'}${entry.amount.toLocaleString('en-NZ')}
                            </p>
                          )}
                          {entry.hours !== undefined && (
                            <p className="text-sm font-semibold text-blue-600">{entry.hours}h</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Danger zone — sits last in the scroll, kept visually distinct
              from the normal sections so a fat-finger on "close sheet" or
              "change status" can never delete a job. The delete itself is
              still guarded server-side: blocked if anything's attached
              (entries / quotes / materials / etc), so this button only
              succeeds for genuinely empty test rows. */}
          <Separator />
          <div className="rounded-2xl border border-red-200 bg-red-50/40 p-4 mt-2">
            <p className="text-xs font-semibold text-red-700 uppercase tracking-wide">
              Danger zone
            </p>
            <p className="text-xs text-red-700/80 mt-1 mb-3">
              Permanently delete this job. Only works if no entries, quotes,
              materials, invoices, attachments or schedule items are attached.
            </p>
            <button
              type="button"
              onClick={confirmAndDelete}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-xl border border-red-300 bg-card hover:bg-red-100 text-red-700 text-sm font-semibold transition-colors active:scale-95"
            >
              <X size={14} strokeWidth={2.2} />
              Delete this job
            </button>
          </div>
            </div>
          </div>

          {/* Sticky Log hours bar — sits at the bottom of the sheet so it's
              always one tap away no matter how far you've scrolled. The
              tired-painter UX rule: logging today's hours on a known job
              should NEVER require navigation.
              Hidden for jobs that are done-and-dusted: 'lost' (never
              happened), 'paid' (closed out), 'invoiced' / 'completed'
              (work is finished — rare touch-ups can still be logged via
              /entry). Also hidden on lead/quoted because you don't log
              hours against a job that hasn't even been accepted yet —
              keeps the lead-stage CTAs (Prep with AI / Mark as quoted)
              as the only action buttons. */}
          {!(['lost','paid','invoiced','completed','lead','quoted'] as JobStatus[]).includes(liveJob.status) && (
            <LogHoursBar
              lastActivity={lastActivityForJob(liveJob.id, entries)}
              onSave={(fields) => {
                addEntry({
                  id: `ent_${Date.now()}`,
                  businessId: businessId ?? '',
                  jobId: liveJob.id,
                  type: 'hours',
                  hours: fields.hours,
                  activity: fields.activity,
                  description: fields.description || `${fields.activity} on ${liveJob.name}`,
                  entryDate: fields.entryDate,
                  gstApplies: false,
                  createdAt: new Date().toISOString(),
                });
              }}
            />
          )}
        </div>
      </SheetContent>

      {/* Invoice action — opens on top of this sheet. Edits the existing
          invoice if one is set, otherwise creates a new one. */}
      <InvoiceAction
        job={liveJob}
        open={showInvoice}
        invoice={editingInvoice ?? undefined}
        onClose={() => {
          setShowInvoice(false);
          setEditingInvoice(null);
        }}
      />

      {/* Outcome capture — opens after a status flip to lost/accepted.
          Saving updates the job; skipping leaves the reason null. */}
      <OutcomeSheet
        open={outcomePrompt !== null}
        kind={outcomePrompt ?? 'lost'}
        initialReason={outcomePrompt === 'lost' ? liveJob.lostReason : liveJob.wonReason}
        initialNotes={liveJob.outcomeNotes}
        onSave={handleOutcomeSave}
        onCancel={() => { setOutcomePrompt(null); setOutcomeEditing(false); }}
      />

      {/* Finish-date prompt — opens after a status flip to completed/
          invoiced/paid. Picking a date stores it on the job and re-runs the
          schedule reconcile with that explicit date as truth. */}
      <CompletionDateSheet
        open={askCompletionDate}
        jobName={liveJob.name}
        initialDate={liveJob.endDate}
        onSave={handleCompletionDateSave}
        onCancel={() => setAskCompletionDate(false)}
      />

      {/* Mark-as-quoted — flips the lead's status to 'quoted' after
          capturing total + date sent + follow-up date. The AI flow
          can pre-fill `initialTotal` with Claude's suggested total
          via the aiSuggestedTotal state. */}
      <MarkAsQuotedSheet
        open={markAsQuotedOpen}
        job={markAsQuotedOpen ? liveJob : null}
        initialTotal={aiSuggestedTotal ?? undefined}
        onSaved={() => {
          setMarkAsQuotedOpen(false);
          setAiSuggestedTotal(null);
        }}
        onCancel={() => {
          setMarkAsQuotedOpen(false);
          setAiSuggestedTotal(null);
        }}
      />

      {/* Real AI quote drafter — calls /api/draft-quote with the job
          context, shows the structured draft, lets the user
          regenerate with a hint, then renders a branded PDF via
          react-pdf and triggers a browser download. */}
      <PrepWithAISheet
        open={prepWithAIOpen}
        job={prepWithAIOpen ? liveJob : null}
        onMarkAsQuoted={(suggestedTotal) => {
          setAiSuggestedTotal(suggestedTotal);
          setPrepWithAIOpen(false);
          setMarkAsQuotedOpen(true);
        }}
        onClose={() => setPrepWithAIOpen(false)}
      />
    </Sheet>
  );
}

/**
 * Client info block — read-only by default, expands to an inline
 * editor when Brad taps Edit (or auto-expands when clientName is
 * still the 'New lead' placeholder, nudging him to fix it before
 * a quote PDF goes out with that text as the customer's name).
 *
 * Edits four fields: clientName, clientPhone, clientEmail, location.
 * Saves via the parent's updateJob callback — optimistic store
 * update handles the persistence + rollback.
 */
function ClientInfoBlock({
  job, onSave,
}: {
  job: Job;
  onSave: (patch: Partial<Job>) => void;
}) {
  // The wrap-up flow seeds new jobs with 'New lead' as a placeholder
  // because the wrap-up form doesn't capture a client name. Auto-
  // expanding the editor for that exact string means Brad sees a
  // form he can fill in straight away rather than a misleading
  // read-only display.
  const isPlaceholder = job.clientName === 'New lead';
  const [editing, setEditing] = useState(isPlaceholder);

  const [name, setName] = useState(job.clientName);
  const [phone, setPhone] = useState(job.clientPhone ?? '');
  const [email, setEmail] = useState(job.clientEmail ?? '');
  const [location, setLocation] = useState(job.location ?? '');

  function handleSave() {
    onSave({
      clientName: name.trim() || 'New lead',
      clientPhone: phone.trim() || undefined,
      clientEmail: email.trim() || undefined,
      location: location.trim() || undefined,
    });
    setEditing(false);
  }

  function handleCancel() {
    setName(job.clientName);
    setPhone(job.clientPhone ?? '');
    setEmail(job.clientEmail ?? '');
    setLocation(job.location ?? '');
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Client</p>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs font-medium text-primary hover:underline inline-flex items-center gap-1"
          >
            <Edit3 size={11} strokeWidth={2} />
            Edit
          </button>
        </div>
        <p className={cn(
          'font-medium',
          isPlaceholder ? 'text-muted-foreground italic' : 'text-foreground',
        )}>
          {isPlaceholder ? 'Set client name…' : job.clientName}
        </p>
        <div className="flex flex-wrap gap-3">
          {job.clientPhone && (
            <a href={`tel:${job.clientPhone}`} className="flex items-center gap-1.5 text-sm text-primary">
              <Phone size={14} /> {job.clientPhone}
            </a>
          )}
          {job.clientEmail && (
            <a href={`mailto:${job.clientEmail}`} className="flex items-center gap-1.5 text-sm text-primary">
              <Mail size={14} /> {job.clientEmail}
            </a>
          )}
        </div>
        {job.location && (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <MapPin size={14} /> {job.location}
          </div>
        )}
      </div>
    );
  }

  // Edit mode
  return (
    <div className="space-y-2.5 rounded-xl border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Client</p>
      </div>
      <div className="space-y-2">
        <input
          type="text"
          placeholder="Client name (e.g. Catherine Smith)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
          autoFocus={isPlaceholder}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            type="tel"
            placeholder="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
          />
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
          />
        </div>
        <input
          type="text"
          placeholder="Address / location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
        />
      </div>
      <div className="flex gap-2 pt-1">
        <Button variant="outline" size="sm" className="flex-1" onClick={handleCancel}>
          Cancel
        </Button>
        <Button size="sm" className="flex-1 bg-primary" onClick={handleSave}>
          Save
        </Button>
      </div>
    </div>
  );
}

function StatCard({
  label, value, valueClass, subvalue,
}: { label: string; value: string; valueClass?: string; subvalue?: string }) {
  return (
    <div className="bg-muted/50 rounded-xl px-3 py-2.5">
      <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
      <p className={cn('text-base font-bold mt-0.5', valueClass ?? 'text-foreground')}>{value}</p>
      {subvalue && (
        <p className="text-[10px] text-muted-foreground mt-0.5 italic">{subvalue}</p>
      )}
    </div>
  );
}

/**
 * Inline notes editor for the job detail sheet.
 *
 * - Read mode: renders the existing whitespace-preserving block plus a small
 *   Edit pencil. If there are no notes yet, shows an "Add notes" call-to-action
 *   so the user can start from empty (previously the section was hidden).
 * - Edit mode: textarea seeded with the current value, Save/Cancel buttons.
 *
 * Save calls onSave with the trimmed value (or `undefined` when cleared, so
 * the underlying mutator stores `null` rather than an empty string). The store
 * mutator is optimistic; if it fails the local state rolls back, but the
 * editor stays closed — the user will see the old text reappear and can retry.
 */
function NotesEditor({
  value,
  onSave,
}: {
  value: string;
  onSave: (next: string | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  // Drop into edit mode pre-populated with the current value. Reset every
  // time we enter edit mode so re-opening after a cancel doesn't keep stale
  // text in the textarea.
  function startEditing() {
    setDraft(value);
    setEditing(true);
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  function save() {
    const trimmed = draft.trim();
    // Skip the write if nothing changed — avoids a needless round-trip.
    if (trimmed === (value ?? '').trim()) {
      setEditing(false);
      return;
    }
    onSave(trimmed.length > 0 ? trimmed : undefined);
    setEditing(false);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Notes</p>
        {!editing && value && (
          <button
            type="button"
            onClick={startEditing}
            className="text-xs font-medium text-primary inline-flex items-center gap-1 hover:underline underline-offset-2"
          >
            <Edit3 size={12} strokeWidth={2} /> Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Anything worth remembering — site access, paint codes, what the client cares about…"
            className="resize-y text-sm min-h-[5rem]"
            rows={4}
            autoFocus
          />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" className="h-8" onClick={cancel}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 bg-primary" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      ) : value ? (
        <p className="text-sm text-foreground leading-relaxed bg-muted/40 rounded-xl px-3 py-2.5 whitespace-pre-wrap">
          {value}
        </p>
      ) : (
        <button
          type="button"
          onClick={startEditing}
          className="w-full text-sm text-muted-foreground hover:text-foreground bg-muted/30 hover:bg-muted/60 rounded-xl px-3 py-2.5 text-left inline-flex items-center gap-2 transition-colors"
        >
          <Plus size={14} strokeWidth={2} /> Add notes
        </button>
      )}
    </div>
  );
}

// ── Materials list on the job detail sheet ─────────────────────────────────
//
// Populated by the bill-PDF confirm flow. Each material row carries the
// supplier, description, qty and ex-GST cost. Tapping a row opens the
// source bill's PDF in a new tab (signed URL, 5min expiry) so Brad can
// answer "where did this come from?" without leaving the sheet.
//
// Excludes materials whose source bill is still a draft — drafts don't
// have a confirmed jobId yet and shouldn't pollute the per-job log even
// if the parser pre-filled a guess.

function JobMaterialsList({
  jobId, materials, entries,
}: {
  jobId: string;
  materials: Material[];
  entries: Entry[];
}) {
  const { addMaterialFromOverhead } = useStore();
  const [adding, setAdding] = useState(false);

  // Build a quick lookup so each material row can ask "is my source bill
  // still a draft?" without an O(N*M) sweep. Tiny dataset — even with
  // years of bills this stays cheap.
  const draftEntryIds = new Set(
    entries.filter((e) => e.isDraft).map((e) => e.id),
  );

  const jobMaterials = materials
    .filter((m) => m.jobId === jobId)
    .filter((m) => !m.entryId || !draftEntryIds.has(m.entryId))
    // Newest first by used_on (the date on the source bill). Falls back
    // to createdAt for materials added without a used_on (older imports).
    .sort((a, b) => {
      const ad = a.usedOn ?? a.createdAt;
      const bd = b.usedOn ?? b.createdAt;
      return bd.localeCompare(ad);
    });

  // Total ex-GST across all materials. Materials.cost is stored ex-GST
  // (see commit notes — line items come off the bill's "exc GST" column).
  const totalExGst = jobMaterials.reduce((s, m) => s + (m.cost ?? 0), 0);

  return (
    <>
      <Separator />
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Materials {jobMaterials.length > 0 ? `(${jobMaterials.length})` : ''}
            </p>
            {jobMaterials.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                ${Math.round(totalExGst).toLocaleString('en-NZ')} ex-GST
              </p>
            )}
          </div>
          {!adding && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs gap-1 shrink-0"
              onClick={() => setAdding(true)}
            >
              <Plus size={13} strokeWidth={2} />
              Add
            </Button>
          )}
        </div>

        {jobMaterials.length > 0 ? (
          <ul className="space-y-1.5">
            {jobMaterials.map((m) => (
              <JobMaterialRow key={m.id} material={m} entries={entries} />
            ))}
          </ul>
        ) : !adding ? (
          <p className="text-xs text-muted-foreground">
            Nothing logged yet. Add materials you used — fresh purchase or pulled from your van overhead.
          </p>
        ) : null}

        {adding && (
          <AddMaterialForm
            jobId={jobId}
            onSubmit={async ({ productName, cost, quantity, unit }) => {
              const result = await addMaterialFromOverhead({
                jobId,
                productName: productName.trim() || undefined,
                cost,
                quantity,
                unit,
                usedOn: new Date().toISOString().slice(0, 10),
              });
              if (!result.ok) {
                alert(`Couldn't save: ${result.error ?? 'unknown error'}`);
                return false;
              }
              return true;
            }}
            onCancel={() => setAdding(false)}
            onDone={() => setAdding(false)}
          />
        )}
      </div>
    </>
  );
}

/**
 * Inline form for adding a material to a job from the JobDetailSheet.
 *
 * Phase 1 (what we ship now): only the "Used from overhead" path. The
 * user types name + cost (+ optional qty/unit) and we record a
 * `source='overhead'` material row. No new bill is created; the cost
 * counts toward per-job profit (via jobStats) but NOT business-wide
 * expenses (those still flow from real bill entries).
 *
 * Phase 2 (future): a "New expense" path that also creates a bill
 * entry attached to this job. For now, fresh purchases are still
 * logged via the existing supplier-bill upload / Home confirm flow.
 */
function AddMaterialForm({
  onSubmit, onCancel, onDone,
}: {
  jobId: string;
  onSubmit: (fields: {
    productName: string;
    cost: number;
    quantity?: number;
    unit?: Unit;
  }) => Promise<boolean>;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [productName, setProductName] = useState('');
  const [costStr, setCostStr] = useState('');
  const [qtyStr, setQtyStr] = useState('');
  const [unit, setUnit] = useState<Unit | ''>('');
  const [saving, setSaving] = useState(false);

  const costNum = parseFloat(costStr);
  const qtyNum = parseFloat(qtyStr);
  const canSave = !Number.isNaN(costNum) && costNum > 0 && productName.trim().length > 0;

  async function handleSave() {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const ok = await onSubmit({
        productName,
        cost: costNum,
        quantity: Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : undefined,
        unit: unit || undefined,
      });
      if (ok) onDone();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 rounded-xl border border-border bg-muted/30 p-3 space-y-2.5">
      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
          What
        </label>
        <input
          type="text"
          autoFocus
          value={productName}
          onChange={(e) => setProductName(e.target.value)}
          placeholder="e.g. Resene Lumbersider Beach Sand"
          className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1 min-w-0">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
            Cost (ex-GST)
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min={0}
              value={costStr}
              onChange={(e) => setCostStr(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSave(); } }}
              placeholder="0"
              className="w-full h-11 pl-7 pr-3 rounded-lg border border-input bg-background text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
        <div className="w-24">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
            Qty
          </label>
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            min={0}
            value={qtyStr}
            onChange={(e) => setQtyStr(e.target.value)}
            placeholder="—"
            className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="w-24">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
            Unit
          </label>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as Unit | '')}
            className="w-full h-11 px-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">—</option>
            <option value="litres">L</option>
            <option value="kg">kg</option>
            <option value="metres">m</option>
            <option value="rolls">rolls</option>
            <option value="sheets">sheets</option>
            <option value="each">each</option>
          </select>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground leading-snug">
        Saved as <span className="font-medium">from overhead</span> — counted in this job&rsquo;s
        profit but not in business-wide expenses (the original purchase already counted).
      </p>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="h-10 px-4 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave || saving}
          className={cn(
            'h-10 px-5 rounded-xl text-sm font-semibold transition-colors',
            canSave && !saving
              ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95'
              : 'bg-muted text-muted-foreground cursor-not-allowed',
          )}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function JobMaterialRow({ material, entries }: { material: Material; entries: Entry[] }) {
  const [opening, setOpening] = useState(false);

  // Look up the source bill to see if it has a PDF attached. Materials
  // logged before the bill-upload feature (legacy imports) won't have an
  // entryId; ones from the confirm flow do.
  const sourceBill = material.entryId
    ? entries.find((e) => e.id === material.entryId)
    : undefined;
  const hasPdf = Boolean(sourceBill?.billPdfUrl);

  async function handleOpenPdf() {
    if (!sourceBill?.billPdfUrl) return;
    setOpening(true);
    try {
      const { data, error } = await supabase.storage
        .from('bill-pdfs')
        .createSignedUrl(sourceBill.billPdfUrl, 300);
      if (error || !data) {
        console.error('[job-materials] Failed to sign PDF URL:', error);
        alert("Couldn't open the source bill — please try again.");
        return;
      }
      window.open(data.signedUrl, '_blank', 'noopener');
    } finally {
      setOpening(false);
    }
  }

  // Build the compact description line: "Resene Woodsman ... · 1 · $179"
  // Description first (truncates), then qty (no truncate, tabular-nums),
  // then cost on the right.
  const qtyLabel = material.quantity != null
    ? `${material.quantity}${material.unit ? ` ${material.unit}` : ''}`
    : null;
  const costLabel = material.cost != null
    ? `$${Math.round(material.cost).toLocaleString('en-NZ')}`
    : '—';

  const baseClass = 'w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-muted/40 text-left';
  const interactiveClass = hasPdf
    ? 'hover:bg-muted/70 cursor-pointer active:scale-[0.99] transition-all'
    : 'cursor-default';

  const isOverhead = material.source === 'overhead';
  const content = (
    <>
      <Package size={14} className="text-muted-foreground shrink-0" strokeWidth={1.8} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className="text-sm text-foreground truncate" title={material.productName ?? ''}>
            {material.productName ?? '(no description)'}
          </p>
          {isOverhead && (
            <span
              className="shrink-0 inline-flex items-center text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
              title="From overhead — counted in this job's profit but not in business-wide expenses"
            >
              From overhead
            </span>
          )}
        </div>
        {(material.supplier || qtyLabel) && (
          <p className="text-[11px] text-muted-foreground truncate">
            {material.supplier ?? ''}
            {material.supplier && qtyLabel ? ' · ' : ''}
            {qtyLabel ?? ''}
          </p>
        )}
      </div>
      <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">
        {costLabel}
      </span>
      {hasPdf && (
        <ExternalLink
          size={12}
          className={cn('text-muted-foreground shrink-0', opening && 'opacity-50')}
          strokeWidth={2}
        />
      )}
    </>
  );

  if (!hasPdf) {
    // Non-interactive: rendered as a div so screen readers don't announce
    // it as a button when there's nothing to do on tap.
    return <li><div className={cn(baseClass, interactiveClass)}>{content}</div></li>;
  }
  return (
    <li>
      <button
        type="button"
        onClick={handleOpenPdf}
        disabled={opening}
        aria-label={`Open source bill PDF for ${material.productName ?? 'material'}`}
        className={cn(baseClass, interactiveClass)}
      >
        {content}
      </button>
    </li>
  );
}

// ── Quotes on the job ──────────────────────────────────────────────────────
//
// Surfaces both legacy-imported quotes (from the Finances sheet — these
// typically have legacy_id like "QUO-019" set) AND ones created by the
// project-archive importer's Link flow (no legacy_id, but populated
// from parsed_data). One row per quote, sorted by date_sent desc.

function JobQuotesList({ jobId, quotes }: { jobId: string; quotes: Quote[] }) {
  const jobQuotes = quotes
    .filter((q) => q.jobId === jobId)
    .sort((a, b) => {
      const ad = a.dateSent ?? a.createdAt;
      const bd = b.dateSent ?? b.createdAt;
      return bd.localeCompare(ad);
    });
  if (jobQuotes.length === 0) return null;

  // Sum of all quote totals on this job. Useful at a glance to compare
  // against the invoice_amount + drift over time. NZ-style ex-GST since
  // we generally show take-home everywhere else.
  const totalExGst = jobQuotes.reduce((s, q) => s + (q.baseAmountExGst ?? 0), 0);

  return (
    <>
      <Separator />
      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Quotes ({jobQuotes.length})
          </p>
          {totalExGst > 0 && (
            <p className="text-[11px] text-muted-foreground">
              ${Math.round(totalExGst).toLocaleString('en-NZ')} ex-GST total
            </p>
          )}
        </div>
        <ul className="space-y-2">
          {jobQuotes.map((q) => (
            <JobQuoteRow key={q.id} quote={q} />
          ))}
        </ul>
      </div>
    </>
  );
}

function JobQuoteRow({ quote }: { quote: Quote }) {
  const { updateQuote, deleteQuote } = useStore();
  const [editing, setEditing] = useState(false);

  // Header line: legacy QUO-id if present, else short uuid prefix; then
  // total incl GST on the right. Subline: status + scope summary truncated.
  const idLabel = quote.legacyId ?? `#${quote.id.slice(0, 8)}`;
  const totalLabel = quote.totalAmountInclGst != null
    ? `$${Math.round(quote.totalAmountInclGst).toLocaleString('en-NZ')}`
    : '—';
  const statusColor = quote.status === 'accepted' ? 'text-green-700 bg-green-50'
    : quote.status === 'declined' ? 'text-red-700 bg-red-50'
    : quote.status === 'sent'     ? 'text-blue-700 bg-blue-50'
    : 'text-muted-foreground bg-muted/40';
  const statusLabel = quote.status ?? 'draft';

  if (editing) {
    return (
      <li>
        <QuoteEditForm
          quote={quote}
          onSave={async (patches) => {
            const res = await updateQuote(quote.id, patches);
            if (res.ok) setEditing(false);
            else alert(`Couldn't save: ${res.error ?? 'unknown error'}`);
          }}
          onCancel={() => setEditing(false)}
          onDelete={async () => {
            if (!confirm('Delete this quote? This can\'t be undone.')) return;
            const res = await deleteQuote(quote.id);
            if (!res.ok) {
              if (res.blockedBy) {
                alert(`Can't delete — this quote has ${res.blockedBy.quoteAttachments} attached file(s). Remove those from Plans & photos first.`);
              } else {
                alert(`Couldn't delete: ${res.error ?? 'unknown error'}`);
              }
              return;
            }
            // Row unmounts on success because the quote disappears from store state.
          }}
        />
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Edit quote ${idLabel}`}
        className="w-full bg-muted/40 hover:bg-muted/60 rounded-xl px-3 py-2.5 text-left transition-colors active:scale-[0.995]"
      >
        <div className="flex items-start gap-2 min-w-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <p className="text-sm font-semibold text-foreground truncate">{idLabel}</p>
              <span className={cn('text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded', statusColor)}>
                {statusLabel}
              </span>
              {quote.dateSent && (
                <span className="text-[11px] text-muted-foreground">{fmtIsoDate(quote.dateSent)}</span>
              )}
            </div>
            {quote.scopeSummary && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{quote.scopeSummary}</p>
            )}
            {(quote.jobType || quote.clientName) && (
              <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                {quote.jobType ?? ''}
                {quote.jobType && quote.clientName ? ' · ' : ''}
                {quote.clientName ?? ''}
              </p>
            )}
          </div>
          <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">
            {totalLabel}
          </span>
        </div>
      </button>
    </li>
  );
}

/**
 * Inline edit form for a single quote. Lets the user fill in or fix
 * status, total (incl GST), date sent, and scope summary without
 * leaving the JobDetailSheet. Trash icon → confirm → deleteQuote
 * (blocked if attachments exist — caller surfaces that).
 *
 * GST handling: we let the user type the GST-inclusive total (the
 * number they remember; matches what the client paid). ex-GST is
 * derived on save via the NZ 15% rule (total / 1.15). If the user
 * wants to enter ex-GST directly we can add a toggle later.
 */
function QuoteEditForm({
  quote, onSave, onCancel, onDelete,
}: {
  quote: Quote;
  onSave: (patches: Partial<Quote>) => Promise<void>;
  onCancel: () => void;
  onDelete: () => Promise<void>;
}) {
  const [status, setStatus] = useState<Quote['status']>(quote.status ?? 'draft');
  const [totalStr, setTotalStr] = useState(
    quote.totalAmountInclGst != null ? String(quote.totalAmountInclGst) : '',
  );
  const [dateSent, setDateSent] = useState(quote.dateSent ?? '');
  const [scopeSummary, setScopeSummary] = useState(quote.scopeSummary ?? '');
  const [saving, setSaving] = useState(false);

  const totalNum = parseFloat(totalStr);
  const totalValid = totalStr === '' || (Number.isFinite(totalNum) && totalNum >= 0);

  async function handleSave() {
    if (!totalValid || saving) return;
    setSaving(true);
    try {
      const patches: Partial<Quote> = {
        status: status ?? undefined,
        scopeSummary: scopeSummary.trim() || undefined,
        dateSent: dateSent || undefined,
      };
      if (totalStr === '') {
        // User cleared the field — null it out.
        patches.totalAmountInclGst = undefined;
        patches.baseAmountExGst = undefined;
      } else if (Number.isFinite(totalNum)) {
        // NZ GST 15% — derive ex-GST so reporting stays consistent.
        patches.totalAmountInclGst = totalNum;
        patches.baseAmountExGst = Math.round((totalNum / 1.15) * 100) / 100;
      }
      await onSave(patches);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-2.5">
      <div className="flex items-end gap-2">
        <div className="flex-1 min-w-0">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
            Status
          </label>
          <select
            value={status ?? 'draft'}
            onChange={(e) => setStatus(e.target.value as Quote['status'])}
            className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="accepted">Accepted</option>
            <option value="declined">Declined</option>
            <option value="expired">Expired</option>
            <option value="superseded">Superseded</option>
          </select>
        </div>
        <div className="flex-1 min-w-0">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
            Date sent
          </label>
          <input
            type="date"
            value={dateSent}
            onChange={(e) => setDateSent(e.target.value)}
            className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
          Total (incl GST)
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min={0}
            value={totalStr}
            onChange={(e) => setTotalStr(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSave(); } }}
            placeholder="0"
            className="w-full h-10 pl-7 pr-3 rounded-lg border border-input bg-background text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        {Number.isFinite(totalNum) && totalNum > 0 && (
          <p className="text-[11px] text-muted-foreground mt-1">
            ${(Math.round((totalNum / 1.15) * 100) / 100).toLocaleString('en-NZ')} ex-GST
          </p>
        )}
      </div>

      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
          Scope summary
        </label>
        <Textarea
          value={scopeSummary}
          onChange={(e) => setScopeSummary(e.target.value)}
          rows={3}
          placeholder="e.g. Exterior repaint, weatherboard + soffits, medium prep."
          className="w-full text-sm"
        />
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={onDelete}
          disabled={saving}
          aria-label="Delete quote"
          className="h-10 px-3 rounded-xl text-sm text-red-600 hover:bg-red-50 hover:text-red-700 transition-colors flex items-center gap-1.5"
        >
          <Trash2 size={14} strokeWidth={1.8} />
          Delete
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="h-10 px-4 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!totalValid || saving}
            className={cn(
              'h-10 px-5 rounded-xl text-sm font-semibold transition-colors',
              totalValid && !saving
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95'
                : 'bg-muted text-muted-foreground cursor-not-allowed',
            )}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Plans + photos attached to the job ─────────────────────────────────────
//
// Reads quote_attachments via store, filtered to attachments whose
// quote_id belongs to one of this job's quotes. Tap to open the file
// via a signed Storage URL (5-min expiry). Grouped by kind so plans
// (the high-value drawings) come first, before/after photos next,
// generic scope photos last.

function JobAttachmentsList({
  jobId, quotes, attachments,
}: {
  jobId: string;
  quotes: Quote[];
  attachments: QuoteAttachment[];
}) {
  const { addQuoteAttachments, ensureJobHasQuote, deleteQuoteAttachment } = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Staged files = picked but not yet uploaded. Each has an editable kind.
  const [staged, setStaged] = useState<{ id: string; file: File; kind: QuoteAttachmentKind }[]>([]);
  const [uploading, setUploading] = useState(false);

  // Set of quote ids on this job — used to filter attachments + know
  // whether we already have a quote to attach to.
  const jobQuoteIds = new Set(quotes.filter((q) => q.jobId === jobId).map((q) => q.id));
  const jobAttachments = attachments.filter((a) => jobQuoteIds.has(a.quoteId));

  // Group existing attachments by kind. Order: plans → before → after →
  // scope → quote_pdf → other.
  const order: QuoteAttachment['kind'][] = [
    'plan', 'before_photo', 'after_photo', 'scope_photo', 'quote_pdf', 'other',
  ];
  const grouped: Record<string, QuoteAttachment[]> = {};
  for (const a of jobAttachments) {
    (grouped[a.kind] ??= []).push(a);
  }

  const scopePhotoCount = (grouped.scope_photo?.length ?? 0) + staged.filter((s) => s.kind === 'scope_photo').length;
  const softCapHit = scopePhotoCount > 4;

  function handlePickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const next = files.map((f) => ({
      id: `staged_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      file: f,
      // Default to scope_photo. inferAttachmentKind-style guess from
      // filename: PDFs that look like plans get classified, photos with
      // before/after in the name get picked up.
      kind: guessKind(f.name),
    }));
    setStaged((prev) => [...prev, ...next]);
    // Reset the input so picking the same file twice re-fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function updateStagedKind(id: string, kind: QuoteAttachmentKind) {
    setStaged((prev) => prev.map((s) => s.id === id ? { ...s, kind } : s));
  }

  function removeStaged(id: string) {
    setStaged((prev) => prev.filter((s) => s.id !== id));
  }

  async function handleUpload() {
    if (staged.length === 0) return;
    setUploading(true);
    try {
      // Ensure we have a quote to attach to — creates a draft if needed.
      const quoteId = await ensureJobHasQuote(jobId);
      if (!quoteId) {
        alert("Couldn't prepare a quote to attach these to. Try again or create a quote manually.");
        return;
      }
      const { inserted, failed } = await addQuoteAttachments(
        quoteId,
        staged.map(({ file, kind }) => ({ file, kind })),
      );
      if (failed > 0) {
        alert(`${inserted} of ${staged.length} uploaded. ${failed} failed — see console for details.`);
      }
      // Clear successfully-uploaded items. If some failed, the user
      // already saw an alert; we still clear so they're not stuck with
      // a stale staged list. (Failed uploads can be re-picked.)
      setStaged([]);
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <Separator />
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Plans &amp; photos {jobAttachments.length > 0 ? `(${jobAttachments.length})` : ''}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <Camera size={13} strokeWidth={2} />
            Add photos
          </Button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf,.heic"
          multiple
          className="hidden"
          onChange={handlePickFiles}
        />

        {/* Existing attachments grouped by kind. */}
        {jobAttachments.length > 0 ? (
          <div className="space-y-3 mb-3">
            {order.map((kind) => {
              const items = grouped[kind];
              if (!items || items.length === 0) return null;
              return (
                <div key={kind}>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                    {kindLabel(kind)} ({items.length})
                  </p>
                  <ul className="space-y-1.5">
                    {items.map((a) => (
                      <AttachmentRow
                        key={a.id}
                        attachment={a}
                        onDelete={() => deleteQuoteAttachment(a.id)}
                      />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : staged.length === 0 ? (
          <p className="text-xs text-muted-foreground mb-3">
            No photos yet. Add 1–4 scope photos to help the quoting assistant price similar jobs.
          </p>
        ) : null}

        {/* Staged (picked but not yet uploaded) files. */}
        {staged.length > 0 && (
          <div className="space-y-2 mb-2">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              To upload ({staged.length})
            </p>
            <ul className="space-y-1.5">
              {staged.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-xl bg-muted/40"
                >
                  <Camera size={13} className="text-muted-foreground shrink-0" strokeWidth={1.8} />
                  <p className="flex-1 min-w-0 text-xs text-foreground truncate" title={s.file.name}>
                    {s.file.name}
                  </p>
                  <Select
                    value={s.kind}
                    onValueChange={(v) => updateStagedKind(s.id, v as QuoteAttachmentKind)}
                  >
                    <SelectTrigger className="h-7 w-[120px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="scope_photo">Scope</SelectItem>
                      <SelectItem value="before_photo">Before</SelectItem>
                      <SelectItem value="after_photo">After</SelectItem>
                      <SelectItem value="plan">Plan</SelectItem>
                      <SelectItem value="quote_pdf">Quote PDF</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    onClick={() => removeStaged(s.id)}
                    aria-label="Remove from upload"
                    className="text-muted-foreground hover:text-foreground p-1"
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </li>
              ))}
            </ul>
            {softCapHit && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                You'll have {scopePhotoCount} scope photos for this job — 1–4 is usually plenty.
              </p>
            )}
            <Button
              type="button"
              size="sm"
              onClick={handleUpload}
              disabled={uploading}
              className="w-full h-9 text-xs gap-1.5"
            >
              {uploading ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Uploading…
                </>
              ) : (
                <>Upload {staged.length} {staged.length === 1 ? 'file' : 'files'}</>
              )}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Best-effort kind guess from filename. Same logic as
 * lib/store.tsx inferAttachmentKind so the staged-file UI defaults
 * match what the importer + commit flow would have classified.
 */
function guessKind(name: string): QuoteAttachmentKind {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) {
    if (lower.includes('plan') || lower.includes('consent') || lower.includes('drawing')) return 'plan';
    if (lower.startsWith('q-') || lower.includes('quote')) return 'quote_pdf';
    return 'other';
  }
  if (lower.includes('before') || lower.includes('start')) return 'before_photo';
  if (lower.includes('after') || lower.includes('final') || lower.includes('done')) return 'after_photo';
  return 'scope_photo';
}

function kindLabel(kind: QuoteAttachment['kind']): string {
  switch (kind) {
    case 'plan': return 'Plans';
    case 'before_photo': return 'Before';
    case 'after_photo': return 'After';
    case 'scope_photo': return 'Scope photos';
    case 'quote_pdf': return 'Quote PDF';
    case 'other': return 'Other';
  }
}

function AttachmentRow({
  attachment, onDelete,
}: {
  attachment: QuoteAttachment;
  onDelete?: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const [opening, setOpening] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isPdf = (attachment.fileName ?? '').toLowerCase().endsWith('.pdf');
  const Icon = isPdf ? FileText : Package;
  const displayName = attachment.fileName ?? attachment.storagePath.split('/').pop() ?? '(file)';

  async function handleOpen() {
    setOpening(true);
    try {
      const { data, error } = await supabase.storage
        .from('quote-attachments')
        .createSignedUrl(attachment.storagePath, 300);
      if (error || !data) {
        console.error('[job-attachments] Failed to sign URL:', error);
        alert("Couldn't open the file — please try again.");
        return;
      }
      window.open(data.signedUrl, '_blank', 'noopener');
    } finally {
      setOpening(false);
    }
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onDelete) return;
    if (!confirm(`Delete ${displayName}? This can't be undone.`)) return;
    setDeleting(true);
    try {
      const result = await onDelete();
      if (!result.ok) {
        alert(`Couldn't delete: ${result.error ?? 'unknown error'}`);
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <li className="flex items-stretch gap-1">
      <button
        type="button"
        onClick={handleOpen}
        disabled={opening || deleting}
        aria-label={`Open ${displayName}`}
        className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded-xl bg-muted/40 hover:bg-muted/70 cursor-pointer active:scale-[0.99] transition-all text-left"
      >
        <Icon size={14} className="text-muted-foreground shrink-0" strokeWidth={1.8} />
        <p className="flex-1 min-w-0 text-sm text-foreground truncate" title={displayName}>
          {displayName}
        </p>
        <ExternalLink
          size={12}
          className={cn('text-muted-foreground shrink-0', opening && 'opacity-50')}
          strokeWidth={2}
        />
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting || opening}
          aria-label={`Delete ${displayName}`}
          className="shrink-0 px-2 rounded-xl text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
        >
          {deleting ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Trash2 size={13} strokeWidth={1.8} />
          )}
        </button>
      )}
    </li>
  );
}

/** ISO YYYY-MM-DD → "Thu 13 May" style. Delegates to the shared helper
 *  so the date format stays consistent across the app. */
function fmtIsoDate(iso: string): string {
  return formatEntryDate(iso);
}

// ── Completed on (editable) ───────────────────────────────────────────────
//
// Inline editable row that surfaces the job's endDate for terminal-status
// jobs. Two states:
//
//   - endDate set     : shows "Completed: Thu 14 May 2025" — tap to edit.
//   - endDate missing : shows "Completed: Unknown — tap to set" so the user
//                       knows it's worth filling in. Sorting the Completed
//                       tab depends on this field.
//
// Tap → swaps to <input type="date">. Changing the value fires onChange
// immediately (no separate Save button; the date input has its own native
// confirm step on mobile). Blur swaps back to the display row.

function CompletedOnRow({
  job, onChange,
}: {
  job: Job;
  onChange: (endDate: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  function handleDateChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value; // YYYY-MM-DD or ''
    if (!next) return; // user cleared it — leave existing value alone
    onChange(next);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <CalendarDays size={14} className="text-muted-foreground shrink-0" strokeWidth={1.8} />
        <span className="text-muted-foreground">Completed:</span>
        <input
          type="date"
          autoFocus
          defaultValue={job.endDate ?? ''}
          onChange={handleDateChange}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
          className="h-8 px-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
    );
  }

  const hasDate = Boolean(job.endDate);
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn(
        'flex items-center gap-1.5 text-sm rounded-lg -mx-1 px-1 py-0.5',
        'hover:bg-muted/60 transition-colors text-left',
        hasDate ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400',
      )}
      aria-label={hasDate ? `Completed on ${job.endDate} — tap to edit` : 'Set completion date'}
    >
      <CalendarDays size={14} strokeWidth={1.8} />
      <span>Completed:</span>
      {hasDate ? (
        <span className="font-medium text-foreground">{formatEntryDate(job.endDate!)}</span>
      ) : (
        <span className="italic">Unknown — tap to set</span>
      )}
    </button>
  );
}

// ── Log hours from inside a job ────────────────────────────────────────────
//
// Sticks to the bottom of the JobDetailSheet's scrollable body. Collapsed
// state = a single full-width "Log hours" button. Expanded = inline form
// with hours / activity / optional description / date. Submit calls
// addEntry with the job's id pre-set, then collapses back to the button.
//
// Activity default = the activity used on this job most recently, falling
// back to 'painting'. The intuition: if you were prepping yesterday you're
// probably prepping today too. If not, the dropdown is one tap away.
//
// Date default = today (todayISO). Edit-date input lets the user log a
// missed day from earlier in the week without going to the Entry tab.

/**
 * Most-recently-used activity for hours entries on a given job, by entryDate.
 * Returns null if the job has no hours entries yet (caller falls back to
 * 'painting' as the sensible default).
 */
function lastActivityForJob(jobId: string, entries: Entry[]): ActivityType | null {
  const hoursOnJob = entries
    .filter((e) => e.type === 'hours' && e.jobId === jobId && e.activity)
    .sort((a, b) => (b.entryDate ?? '').localeCompare(a.entryDate ?? ''));
  if (hoursOnJob.length === 0) return null;
  return hoursOnJob[0].activity as ActivityType;
}

const JOB_ACTIVITY_OPTIONS: { value: ActivityType; label: string }[] = [
  { value: 'painting',     label: 'Painting' },
  { value: 'prep',         label: 'Prep' },
  { value: 'staining',     label: 'Staining' },
  { value: 'wallpapering', label: 'Wallpapering' },
  { value: 'stopping',     label: 'Stopping' },
  { value: 'primer',       label: 'Primer' },
  { value: 'repair',       label: 'Repair' },
  { value: 'cleanup',      label: 'Cleanup' },
  { value: 'travel',       label: 'Travel' },
  { value: 'quoting',      label: 'Quoting' },
  { value: 'admin',        label: 'Admin' },
];

function LogHoursBar({
  lastActivity, onSave,
}: {
  lastActivity: ActivityType | null;
  /** Called with the entry to insert. Parent handles the addEntry call so
   *  this component stays presentation-only. */
  onSave: (fields: { hours: number; activity: ActivityType; description: string; entryDate: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hoursStr, setHoursStr] = useState('');
  const [activity, setActivity] = useState<ActivityType>(lastActivity ?? 'painting');
  const [description, setDescription] = useState('');
  const [entryDate, setEntryDate] = useState<string>(() => new Date().toISOString().slice(0, 10));

  const hoursNum = parseFloat(hoursStr);
  const canSave = !Number.isNaN(hoursNum) && hoursNum > 0;

  function reset() {
    setHoursStr('');
    setDescription('');
    setActivity(lastActivity ?? 'painting');
    setEntryDate(new Date().toISOString().slice(0, 10));
  }

  function handleSubmit() {
    if (!canSave) return;
    onSave({ hours: hoursNum, activity, description: description.trim(), entryDate });
    reset();
    setOpen(false);
  }

  function handleCancel() {
    reset();
    setOpen(false);
  }

  if (!open) {
    return (
      <div
        className="shrink-0 border-t border-border bg-card px-4 md:px-6 py-3"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}
      >
        <div className="mx-auto w-full max-w-2xl">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition-transform"
          >
            <Clock size={16} strokeWidth={2} />
            Log hours on this job
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="shrink-0 border-t border-border bg-card px-4 md:px-6 py-3 space-y-3"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}
    >
      <div className="mx-auto w-full max-w-2xl space-y-3">
        <div className="flex items-end gap-3">
          <div className="flex-1 min-w-0">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
              Hours
            </label>
            <input
              type="number"
              inputMode="decimal"
              step="0.25"
              min={0}
              autoFocus
              value={hoursStr}
              onChange={(e) => setHoursStr(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); } }}
              placeholder="0"
              className="w-full h-11 px-3 rounded-lg border border-input bg-background text-base font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex-1 min-w-0">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
              Date
            </label>
            <input
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div>
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
            Activity
          </label>
          <select
            value={activity}
            onChange={(e) => setActivity(e.target.value as ActivityType)}
            className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {JOB_ACTIVITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
            Notes (optional)
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); } }}
            placeholder="e.g. second coat front elevation"
            className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={handleCancel}
            className="h-11 px-4 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSave}
            className={cn(
              'h-11 px-5 rounded-xl text-sm font-semibold transition-colors',
              canSave
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95'
                : 'bg-muted text-muted-foreground cursor-not-allowed',
            )}
          >
            Save hours
          </button>
        </div>
      </div>
    </div>
  );
}
