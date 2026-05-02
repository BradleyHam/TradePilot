'use client';

import { useState } from 'react';
import { Job, Entry } from '@/lib/types';
import { useStore } from '@/lib/store';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Phone, Mail, MapPin, Clock, DollarSign, Receipt, FileText, MessageSquare,
  AlertCircle, StickyNote, TrendingUp, Edit3,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { JOB_STATUSES } from '@/lib/mock-data';
import { JobStatus } from '@/lib/types';
import { jobStats } from '@/lib/job-stats';
import { HourlyRateGauge, IncomeVsExpenses, HoursByActivity } from './job-charts';
import { InvoiceAction } from './invoice-action';
import { InvoicesList } from './invoices-list';
import { BookedDates } from './booked-dates';

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
  const { jobs, entries, invoices, updateJob } = useStore();
  const [showInvoice, setShowInvoice] = useState(false);
  // When set, the InvoiceAction sheet opens in edit mode for this invoice.
  const [editingInvoice, setEditingInvoice] = useState<import('@/lib/types').Invoice | null>(null);

  if (!job) return null;

  // The `job` prop is captured at click time and won't reflect store updates
  // (e.g. status changes). Look up the live version from the store so the
  // controlled Select and the rest of this view stay in sync.
  const liveJob = jobs.find((j) => j.id === job.id) ?? job;

  const jobEntries = entries
    .filter((e) => e.jobId === liveJob.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const stats = jobStats(liveJob, entries);
  const { totalHours, totalExpenses, totalIncome, expectedIncome, expectedProfit, expectedIsConfident, expectedHourlyRate } = stats;

  function handleStatusChange(s: string | null) {
    if (!s) return;
    updateJob(liveJob.id, { status: s as JobStatus });
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

          {/* Notes */}
          {liveJob.notes && (
            <>
              <Separator />
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Notes</p>
                <p className="text-sm text-foreground leading-relaxed bg-muted/40 rounded-xl px-3 py-2.5 whitespace-pre-wrap">{liveJob.notes}</p>
              </div>
            </>
          )}

          {/* Entries */}
          {jobEntries.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Activity ({jobEntries.length})
                </p>
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
                              {entry.type === 'expense' ? '-' : '+'}${entry.amount.toLocaleString('en-NZ')}
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
