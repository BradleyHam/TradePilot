'use client';

import { Job } from '@/lib/types';
import { StatusBadge } from './status-badge';
import { MapPin, User, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

interface JobCardProps {
  job: Job;
  totalHours?: number;
  totalExpenses?: number;
  totalIncome?: number;
  /** Pre-computed by the parent via lib/job-stats.ts. Falls back to invoiced/quoted/estimated when actual income is zero. */
  expectedProfit?: number;
  /** True when expected profit is based on a real quote/invoice rather than an estimate. */
  expectedIsConfident?: boolean;
  onClick?: () => void;
}

export function JobCard({
  job, totalHours, totalExpenses, totalIncome,
  expectedProfit, expectedIsConfident, onClick,
}: JobCardProps) {
  const value = job.quoteAmount ?? job.estimatedValue;
  // Prefer the parent-provided expected profit; fall back to the simple
  // received-only calc if for some reason it wasn't passed in.
  const profit = expectedProfit ?? (
    totalIncome !== undefined && totalExpenses !== undefined
      ? totalIncome - totalExpenses
      : undefined
  );
  const profitLabel = totalIncome && totalIncome > 0 ? 'Profit' : 'Est. profit';

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-card border border-border rounded-2xl p-4 hover:border-primary/30 hover:shadow-sm active:scale-[0.99] transition-all"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-foreground truncate">{job.name}</p>
          <div className="flex items-center gap-1.5 mt-1 text-muted-foreground">
            <User size={12} strokeWidth={1.8} />
            <span className="text-xs truncate">{job.clientName}</span>
          </div>
          {job.location && (
            <div className="flex items-center gap-1.5 mt-0.5 text-muted-foreground">
              <MapPin size={12} strokeWidth={1.8} />
              <span className="text-xs truncate">{job.location}</span>
            </div>
          )}
        </div>
        <StatusBadge status={job.status} />
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3">
        {value !== undefined && (
          <Stat label="Value" value={`$${value.toLocaleString('en-NZ')}`} />
        )}
        {totalHours !== undefined && totalHours > 0 && (
          <Stat label="Hours" value={`${totalHours}h`} />
        )}
        {profit !== undefined && (
          <Stat
            label={profitLabel}
            value={`$${profit.toLocaleString('en-NZ')}`}
            valueClass={profit >= 0 ? 'text-green-600' : 'text-red-500'}
          />
        )}
      </div>
    </button>
  );
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex flex-col bg-muted/50 rounded-lg px-2.5 py-1.5 min-w-0">
      <span className="text-[10px] text-muted-foreground font-medium">{label}</span>
      <span className={cn('text-sm font-semibold', valueClass ?? 'text-foreground')}>{value}</span>
    </div>
  );
}
