'use client';

import { useMemo, useState } from 'react';
import type { BusinessMember, Entry, Job, Material, Setting } from '@/lib/types';
import { jobStats } from '@/lib/job-stats';
import { payrollConfig } from '@/lib/payroll';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface JobMoneySummaryProps {
  jobs: Job[];
  entries: Entry[];
  materials: Material[];
  settings: Setting[];
  teamMembers: BusinessMember[];
  start: string;
  end: string;
  periodLabel: string;
  selectedJobId: string;
  onOpenJob: (jobId: string) => void;
}

function money(value: number): string {
  const absolute = Math.abs(value);
  const formatted = absolute.toLocaleString('en-NZ', {
    minimumFractionDigits: Number.isInteger(absolute) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? '-' : ''}$${formatted}`;
}

/**
 * Job profitability is deliberately shown as a whole-job figure. Trying to
 * slice a quote across a single month makes an in-progress job look like it
 * earned nothing until it is completed. The month filter instead controls
 * which jobs appear; the row then answers the more useful question: "is this
 * job paying?"
 */
export function JobMoneySummary({
  jobs,
  entries,
  materials,
  settings,
  teamMembers,
  start,
  end,
  periodLabel,
  selectedJobId,
  onOpenJob,
}: JobMoneySummaryProps) {
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => {
    const touchedAt = new Map<string, string>();
    for (const entry of entries) {
      // "Worked" means there is actual time logged on the job in this
      // period. A customer payment, supplier bill, note or site visit can
      // touch a job financially without Brad having worked on it that month.
      if (
        entry.type !== 'hours'
        || (entry.hours ?? 0) <= 0
        || !entry.jobId
        || entry.entryDate < start
        || entry.entryDate > end
      ) continue;
      const previous = touchedAt.get(entry.jobId);
      if (!previous || entry.entryDate > previous) touchedAt.set(entry.jobId, entry.entryDate);
    }

    const ownerUserId = teamMembers.find((member) => member.role === 'owner')?.userId;
    const wageRate = payrollConfig(settings).wageRate;

    return jobs
      .filter((job) => selectedJobId ? job.id === selectedJobId : touchedAt.has(job.id))
      .map((job) => ({
        job,
        touchedAt: touchedAt.get(job.id) ?? '',
        stats: jobStats(job, entries, materials, { wageRate, ownerUserId }),
      }))
      .filter(({ stats }) =>
        stats.expectedIncome > 0 || stats.totalExpenses > 0 || stats.totalHours > 0,
      )
      .sort((a, b) => b.touchedAt.localeCompare(a.touchedAt));
  }, [jobs, entries, materials, settings, teamMembers, start, end, selectedJobId]);
  const visibleRows = selectedJobId || showAll ? rows : rows.slice(0, 4);

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="border-b border-border px-4 py-3.5">
        <p className="text-sm font-semibold text-foreground">
          {selectedJobId ? 'This job so far' : `Jobs worked in ${periodLabel}`}
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          Whole-job totals · tap a job for the breakdown
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted-foreground">
          No hours logged against a job in this period yet.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {visibleRows.map(({ job, stats }) => (
            <button
              key={job.id}
              type="button"
              onClick={() => onOpenJob(job.id)}
              className={cn(
                'w-full min-h-20 px-4 py-3 text-left transition-colors hover:bg-muted/35 active:bg-muted/55',
                selectedJobId === job.id && 'bg-primary/[0.045]',
              )}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground">{job.name}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {stats.totalHours.toLocaleString('en-NZ')}h logged
                    {stats.ownerRate != null ? ` · ${money(stats.ownerRate)}/h for your time` : ''}
                  </span>
                </span>
                <ChevronRight size={17} className="mt-0.5 shrink-0 text-muted-foreground" />
              </span>

              <span className="mt-3 grid grid-cols-3 gap-2">
                <MoneyCell label="Income" value={money(stats.expectedIncome)} />
                <MoneyCell label="Costs" value={money(stats.totalExpenses)} />
                <MoneyCell
                  label="Left"
                  value={money(stats.expectedProfit)}
                  negative={stats.expectedProfit < 0}
                  strong
                />
              </span>
            </button>
          ))}
        </div>
      )}
      {!selectedJobId && rows.length > 4 && (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className="min-h-11 w-full border-t border-border px-4 text-sm font-semibold text-primary transition-colors hover:bg-muted/35 active:bg-muted/55"
        >
          {showAll ? 'Show fewer jobs' : `Show all ${rows.length} jobs`}
        </button>
      )}
    </section>
  );
}

function MoneyCell({
  label,
  value,
  negative = false,
  strong = false,
}: {
  label: string;
  value: string;
  negative?: boolean;
  strong?: boolean;
}) {
  return (
    <span className="min-w-0">
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={cn(
        'mt-0.5 block truncate text-sm tabular-nums text-foreground',
        strong && 'font-bold',
        negative && 'text-red-600',
      )}>
        {value}
      </span>
    </span>
  );
}
