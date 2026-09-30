'use client';

import type { MonthlyData } from '@/lib/types';
import { cn } from '@/lib/utils';

interface MonthlyBreakdownProps {
  data: MonthlyData[];
  basis: 'cash' | 'earned';
  scopeLabel?: string;
}

function money(value: number): string {
  const absolute = Math.abs(value);
  const formatted = absolute.toLocaleString('en-NZ', {
    minimumFractionDigits: Number.isInteger(absolute) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? '-' : ''}$${formatted}`;
}

export function MonthlyBreakdown({ data, basis, scopeLabel }: MonthlyBreakdownProps) {
  const visible = data.slice(-6).reverse();

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3.5">
        <p className="text-sm font-semibold text-foreground">Exact monthly totals</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Last 6 months · {basis === 'earned' ? (scopeLabel ? 'job progress' : 'work done') : 'cash'} view
          {scopeLabel ? ` · ${scopeLabel}` : ''}
        </p>
      </div>

      <div className="grid grid-cols-[0.75fr_1fr_1fr_1fr] gap-2 border-b border-border bg-muted/30 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Month</span>
        <span className="text-right">Income</span>
        <span className="text-right">Costs</span>
        <span className="text-right">Left</span>
      </div>

      <div className="divide-y divide-border">
        {visible.map((row, index) => {
          const left = row.revenue - row.expenses;
          return (
            <div
              key={`${row.month}-${index}`}
              className="grid min-h-12 grid-cols-[0.75fr_1fr_1fr_1fr] items-center gap-2 px-4 py-2.5 text-xs tabular-nums"
            >
              <span className="font-semibold text-foreground">{row.month}</span>
              <span className="truncate text-right text-foreground">{money(row.revenue)}</span>
              <span className="truncate text-right text-foreground">{money(row.expenses)}</span>
              <span className={cn(
                'truncate text-right font-bold text-foreground',
                left < 0 && 'text-red-600',
              )}>
                {money(left)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
