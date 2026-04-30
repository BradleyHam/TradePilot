'use client';

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
  const { jobs, entries, updateJob } = useStore();

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
          {/* Fixed header — always visible */}
          <div className="shrink-0 px-4 pt-4 pb-3 bg-card border-b border-border">
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

          {/* Scrollable body */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-4 pb-10 space-y-5">
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

          <Separator />

          {/* Financial summary */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Financials</p>
              <p className="text-[10px] text-muted-foreground italic">all amounts ex GST</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Quote" value={liveJob.quoteAmount ? `$${liveJob.quoteAmount.toLocaleString('en-NZ')}` : '—'} />
              <StatCard
                label={totalIncome > 0 ? 'Income received' : 'Expected income'}
                value={
                  totalIncome > 0
                    ? `$${totalIncome.toLocaleString('en-NZ')}`
                    : expectedIncome > 0
                      ? `$${expectedIncome.toLocaleString('en-NZ')}`
                      : '—'
                }
                valueClass="text-green-600"
                subvalue={totalIncome === 0 && expectedIncome > 0
                  ? (expectedIsConfident ? 'projected' : 'estimated')
                  : undefined}
              />
              <StatCard
                label="Expenses"
                value={totalExpenses > 0 ? `$${totalExpenses.toLocaleString('en-NZ')}` : '—'}
                valueClass="text-red-500"
              />
              <StatCard
                label={totalIncome > 0 ? 'Profit' : 'Expected profit'}
                value={
                  expectedIncome > 0 || totalExpenses > 0
                    ? `$${expectedProfit.toLocaleString('en-NZ')}`
                    : '—'
                }
                valueClass={expectedProfit >= 0 ? 'text-green-600' : 'text-red-500'}
                subvalue={totalIncome === 0 && expectedIncome > 0
                  ? (expectedIsConfident ? 'if invoice is paid' : 'estimated')
                  : undefined}
              />
              <StatCard label="Hours" value={totalHours > 0 ? `${totalHours}h` : '—'} valueClass="text-blue-600" />
              <StatCard
                label={totalIncome > 0 ? 'Hourly rate' : 'Expected $/h'}
                value={expectedHourlyRate != null ? `$${expectedHourlyRate.toFixed(0)}/h` : '—'}
              />
            </div>
          </div>

          {/* Visualisations — only render the ones that have data */}
          {(expectedHourlyRate != null || stats.totalExpenses > 0 || stats.totalHours > 0) && (
            <>
              <Separator />
              <div className="space-y-3">
                <HourlyRateGauge
                  hourlyRate={expectedHourlyRate}
                  isExpected={totalIncome === 0}
                />
                <IncomeVsExpenses stats={stats} />
                <HoursByActivity entries={jobEntries} />
              </div>
            </>
          )}

          {/* Notes */}
          {liveJob.notes && (
            <>
              <Separator />
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Notes</p>
                <p className="text-sm text-foreground leading-relaxed bg-muted/40 rounded-xl px-3 py-2.5">{liveJob.notes}</p>
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
      </SheetContent>
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
