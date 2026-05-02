'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import { estimateTax, taxYearOf, previousTaxYearOf } from '@/lib/tax-estimator';
import { ChevronDown, Receipt, TrendingDown, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

const fmt = (n: number) => `$${Math.round(n).toLocaleString('en-NZ')}`;

export function TaxExposureCard() {
  const { entries } = useStore();
  const [open, setOpen] = useState(false);
  // Default to current year. 'prev' shows the year that just finished —
  // useful at filing time (June/July) when you want last year's number.
  const [yearKind, setYearKind] = useState<'current' | 'prev'>('current');

  const ty = yearKind === 'current' ? taxYearOf() : previousTaxYearOf();
  const est = estimateTax(entries, new Date(), ty);
  const pct = est.totalDays > 0 ? Math.round((est.elapsedDays / est.totalDays) * 100) : 0;
  const yearComplete = yearKind === 'prev' || pct >= 100;

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      {/* Header — title + year toggle */}
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2">
        <p className="text-sm font-semibold text-foreground">Tax exposure</p>
        <div className="inline-flex bg-muted rounded-lg p-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); setYearKind('current'); }}
            className={cn(
              'px-2.5 h-7 rounded-md text-[11px] font-medium tabular-nums transition-colors',
              yearKind === 'current'
                ? 'bg-card shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {taxYearOf().label}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setYearKind('prev'); }}
            className={cn(
              'px-2.5 h-7 rounded-md text-[11px] font-medium tabular-nums transition-colors',
              yearKind === 'prev'
                ? 'bg-card shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {previousTaxYearOf().label}
          </button>
        </div>
      </div>

      {/* Headline */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-4 pb-3.5 pt-1 hover:bg-muted/30 active:bg-muted/50 transition-colors"
      >
        <div className="flex items-baseline justify-end mb-3 gap-2">
          <p className="text-[11px] text-muted-foreground">
            {yearComplete ? 'year complete' : `${pct}% through year`}
          </p>
          <ChevronDown
            size={14}
            className={cn(
              'text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        </div>

        {/* Two lines */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-start gap-2">
            <Receipt size={14} className="text-orange-500 mt-0.5 shrink-0" strokeWidth={1.8} />
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">GST owed</p>
              <p className={cn(
                'text-base font-bold',
                est.gstNet > 0 ? 'text-foreground' : 'text-green-600',
              )}>
                {est.gstNet >= 0 ? fmt(est.gstNet) : `-${fmt(-est.gstNet)} refund`}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <TrendingDown size={14} className="text-blue-500 mt-0.5 shrink-0" strokeWidth={1.8} />
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Income tax est.</p>
              <p className="text-base font-bold text-foreground">{fmt(est.incomeTax)}</p>
            </div>
          </div>
        </div>
      </button>

      {/* Expanded breakdown */}
      {open && (
        <div className="border-t border-border px-4 py-4 space-y-4 bg-muted/20">
          {/* GST */}
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">GST</p>
            <Row label="Collected from clients" value={fmt(est.gstOutput)} />
            <Row label="Claimed back on expenses" value={`-${fmt(est.gstInput)}`} />
            <Row label="Net to IRD" value={fmt(est.gstNet)} bold />
            <p className="text-[10px] text-muted-foreground mt-1.5 italic leading-relaxed">
              You file this across regular GST returns. Subtract anything you&apos;ve already paid via myIR.
            </p>
          </div>

          {/* Income tax breakdown */}
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Taxable profit (ex GST)
            </p>
            <Row label="Income received" value={fmt(est.income)} />
            <Row label="Expenses + paid bills" value={`-${fmt(est.expensesLogged)}`} />
            <Row
              label="Auto-applied deductions"
              value={`-${fmt(est.extraDeductions)}`}
            />
            <Row label="Taxable profit" value={fmt(est.taxableProfit)} bold />
            <p className="text-[10px] text-muted-foreground mt-1.5 italic leading-relaxed">
              Personal tax bands assume drawings are reclassified as shareholder salary at year-end.
            </p>
          </div>

          {/* Deduction breakdown */}
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              {yearComplete ? 'Auto-deductions (full year)' : 'Auto-deductions, pro-rated to today'}
            </p>
            <Row label="Vehicle (km claim)" value={fmt(est.deductionBreakdown.vehicle)} />
            <Row label="Home office + shed" value={fmt(est.deductionBreakdown.homeAndShed)} />
            <Row label="Phone & internet uplift" value={fmt(est.deductionBreakdown.phoneInternet)} />
            <Row label="Laptop depreciation" value={fmt(est.deductionBreakdown.laptopDep)} />
          </div>

          <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-800">
            <Info size={12} className="shrink-0 mt-0.5" strokeWidth={2} />
            <p className="text-[11px] leading-relaxed">
              Estimate only. Take to your accountant — they&apos;ll find more (vehicle expenses
              you missed, asset depreciation, prior-year losses) and check it against IRD rules.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className={cn('text-xs', bold ? 'text-foreground font-semibold' : 'text-muted-foreground')}>
        {label}
      </span>
      <span className={cn('text-sm tabular-nums', bold ? 'font-bold text-foreground' : 'text-foreground')}>
        {value}
      </span>
    </div>
  );
}
