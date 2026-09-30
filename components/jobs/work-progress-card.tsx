'use client';

import { ChevronRight, Gauge, TriangleAlert } from 'lucide-react';
import type { Entry, Job, JobProgressPerson, JobProgressSnapshot } from '@/lib/types';
import {
  earnedToDateAt,
  jobPersonHours,
  latestProgressAt,
} from '@/lib/job-progress';
import { cn } from '@/lib/utils';

interface WorkProgressCardProps {
  job: Job;
  entries: Entry[];
  snapshots: JobProgressSnapshot[];
  people: JobProgressPerson[];
  asOfDate: string;
  onEdit: () => void;
  compact?: boolean;
}

const money = (value: number) => value.toLocaleString('en-NZ', {
  style: 'currency',
  currency: 'NZD',
  maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
});

const hours = (value: number) => value.toLocaleString('en-NZ', {
  maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
});

function shortDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-NZ', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function peopleSummary(names: string[]): string {
  if (names.length <= 2) return names.join(' + ');
  return `${names.slice(0, 2).join(' + ')} + ${names.length - 2} other${names.length > 3 ? 's' : ''}`;
}

/**
 * Shared readout for Job and Money. It is intentionally a management card:
 * tapping it edits work remaining only and cannot alter billing or tax data.
 */
export function WorkProgressCard({
  job,
  entries,
  snapshots,
  people,
  asOfDate,
  onEdit,
  compact = false,
}: WorkProgressCardProps) {
  const position = earnedToDateAt({ job, entries, snapshots, asOfDate });
  const snapshot = latestProgressAt(snapshots, job.id, asOfDate);
  const actualHours = jobPersonHours(entries, job.id, asOfDate).total;

  if (!snapshot && (!position.missingForecast || actualHours <= 0 || position.jobValueExGst <= 0)) return null;

  if (!snapshot) {
    return (
      <button
        type="button"
        onClick={onEdit}
        className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-left transition-colors hover:bg-amber-100/80 active:bg-amber-100"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <TriangleAlert size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-amber-950">Work left hasn&apos;t been added</span>
          <span className="mt-0.5 block text-xs leading-snug text-amber-800">
            This unfinished job is not included in Work done yet.
          </span>
        </span>
        <span className="shrink-0 text-xs font-bold text-amber-800">Add</span>
      </button>
    );
  }

  const snapshotPeople = people.filter((person) => person.snapshotId === snapshot.id);
  const consumedSinceSnapshot = snapshot.state === 'complete'
    ? 0
    : Math.max(0, actualHours - snapshot.actualPersonHours);
  const remaining = Math.max(0, snapshot.remainingPersonHours - consumedSinceSnapshot);
  const percent = Math.round(position.progressFraction * 100);
  const estimateUsedUp = snapshot.state === 'forecast' && remaining <= 0;
  const personNames = peopleSummary(snapshotPeople.map((person) => person.personName));

  return (
    <button
      type="button"
      onClick={onEdit}
      className={cn(
        'w-full rounded-2xl border border-border bg-card text-left shadow-sm transition-colors hover:bg-muted/25 active:bg-muted/40',
        compact ? 'p-3.5' : 'p-4',
      )}
    >
      <span className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Gauge size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-foreground">Work done</span>
            <span className="flex shrink-0 items-center gap-1 text-sm font-bold tabular-nums text-foreground">
              {snapshot.state === 'complete' ? 'Complete' : estimateUsedUp ? 'Needs update' : `${percent}%`}
              <ChevronRight size={15} className="text-muted-foreground" />
            </span>
          </span>
          <span className="mt-2 block h-2 overflow-hidden rounded-full bg-muted">
            <span
              role="progressbar"
              aria-label="Work done"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, Math.max(0, percent))}
              className="block h-full rounded-full bg-emerald-500 transition-[width]"
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          </span>
          <span className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-xs text-muted-foreground">
              {money(position.amountExGst)} of {money(position.jobValueExGst)} earned
            </span>
            <span className="text-xs font-semibold text-foreground">
              {snapshot.state === 'complete'
                ? 'No work left'
                : estimateUsedUp
                  ? 'Finished or more left?'
                  : `${hours(remaining)} person-hours left`}
            </span>
          </span>
          {snapshot.state !== 'complete' && !estimateUsedUp && personNames && (
            <span className="mt-1 block truncate text-[11px] text-muted-foreground">
              Returning: {personNames}
            </span>
          )}
          <span className="mt-1 block text-[10px] text-muted-foreground">
            Updated for {shortDate(snapshot.asOfDate)} · management estimate, ex GST
          </span>
        </span>
      </span>
    </button>
  );
}
