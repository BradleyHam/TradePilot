'use client';

import { useState } from 'react';
import { Job, Entry, Material } from '@/lib/types';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import {
  Phone, Mail, MapPin, Clock, DollarSign, Receipt, FileText, MessageSquare,
  AlertCircle, StickyNote, TrendingUp, Edit3, Plus, Package, ExternalLink,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { JOB_STATUSES } from '@/lib/mock-data';
import { JobStatus } from '@/lib/types';
import { jobStats, entryExGst } from '@/lib/job-stats';
import { HourlyRateGauge, IncomeVsExpenses, HoursByActivity } from './job-charts';
import { InvoiceAction } from './invoice-action';
import { InvoicesList } from './invoices-list';
import { BookedDates } from './booked-dates';
import { OutcomeSheet, OutcomeKind } from './outcome-sheet';
import { CompletionDateSheet } from './completion-date-sheet';

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

export function JobDetailSheet({ job, open, onClose }: JobDetailSheetProps) {
  const { jobs, entries, invoices, scheduleItems, materials, updateJob, reconcileJobSchedule } = useStore();
  const [reconciling, setReconciling] = useState(false);
  const [showInvoice, setShowInvoice] = useState(false);
  // When set, the InvoiceAction sheet opens in edit mode for this invoice.
  const [editingInvoice, setEditingInvoice] = useState<import('@/lib/types').Invoice | null>(null);
  // When set, the OutcomeSheet opens to capture why we won/lost a job.
  const [outcomePrompt, setOutcomePrompt] = useState<OutcomeKind | null>(null);
  // When true, the CompletionDateSheet opens to capture the actual finish
  // date so we can reconcile the calendar accurately.
  const [askCompletionDate, setAskCompletionDate] = useState(false);

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

  const stats = jobStats(liveJob, entries);
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
  }

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="bottom" className="rounded-t-2xl p-0" showCloseButton={false}>
        <div className="h-[92vh] flex flex-col overflow-hidden">
          {/* Fixed header — always visible. Inner wrapper caps width on desktop
              so the title/status row doesn't sprawl across a 27" monitor. */}
          <div className="shrink-0 bg-card border-b border-border">
            <div className="mx-auto w-full max-w-2xl px-4 md:px-6 pt-4 pb-3">
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
          {/* Client info */}
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Client</p>
            <p className="font-medium text-foreground">{liveJob.clientName}</p>
            <div className="flex flex-wrap gap-3">
              {liveJob.clientPhone && (
                <a href={`tel:${liveJob.clientPhone}`} className="flex items-center gap-1.5 text-sm text-primary">
                  <Phone size={14} /> {liveJob.clientPhone}
                </a>
              )}
              {liveJob.clientEmail && (
                <a href={`mailto:${liveJob.clientEmail}`} className="flex items-center gap-1.5 text-sm text-primary">
                  <Mail size={14} /> {liveJob.clientEmail}
                </a>
              )}
            </div>
            {liveJob.location && (
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <MapPin size={14} /> {liveJob.location}
              </div>
            )}
          </div>

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
                />
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
            </div>
          </div>
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
        onCancel={() => setOutcomePrompt(null)}
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
    </Sheet>
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

  if (jobMaterials.length === 0) return null;

  // Total ex-GST across all materials. Materials.cost is stored ex-GST
  // (see commit notes — line items come off the bill's "exc GST" column).
  const totalExGst = jobMaterials.reduce((s, m) => s + (m.cost ?? 0), 0);

  return (
    <>
      <Separator />
      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Materials ({jobMaterials.length})
          </p>
          <p className="text-[11px] text-muted-foreground">
            ${Math.round(totalExGst).toLocaleString('en-NZ')} ex-GST
          </p>
        </div>
        <ul className="space-y-1.5">
          {jobMaterials.map((m) => (
            <JobMaterialRow key={m.id} material={m} entries={entries} />
          ))}
        </ul>
      </div>
    </>
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

  const content = (
    <>
      <Package size={14} className="text-muted-foreground shrink-0" strokeWidth={1.8} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate" title={material.productName ?? ''}>
          {material.productName ?? '(no description)'}
        </p>
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
