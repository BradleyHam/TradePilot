'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import { estimateTax, taxYearOf, previousTaxYearOf } from '@/lib/tax-estimator';
import { ChevronDown, Receipt, TrendingDown, Info, Landmark } from 'lucide-react';
import { cn } from '@/lib/utils';

const fmt = (n: number) => `$${Math.round(n).toLocaleString('en-NZ')}`;

export function TaxExposureCard() {
  const { entries, bankTransactions } = useStore();
  const [open, setOpen] = useState(false);
  // Default to current year. 'prev' shows the year that just finished —
  // useful at filing time (June/July) when you want last year's number.
  const [yearKind, setYearKind] = useState<'current' | 'prev'>('current');

  const ty = yearKind === 'current' ? taxYearOf() : previousTaxYearOf();
  const est = estimateTax(entries, new Date(), ty);
  const pct = est.totalDays > 0 ? Math.round((est.elapsedDays / est.totalDays) * 100) : 0;
  const yearComplete = yearKind === 'prev' || pct >= 100;
  // Only tagged GST and income-tax payments reduce this reserve. PAYE,
  // penalties and other IRD payments are separate obligations and must not
  // silently make the amount Brad needs for GST / income tax look smaller.
  const paidGst = bankTransactions
    .filter((txn) => txn.status === 'tax' && txn.taxKind === 'gst'
      && txn.txnDate >= ty.start && txn.txnDate <= ty.end)
    .reduce((sum, txn) => sum + Math.abs(txn.amount), 0);
  const paidIncomeTax = bankTransactions
    .filter((txn) => txn.status === 'tax' && txn.taxKind === 'income_tax'
      && txn.txnDate >= ty.start && txn.txnDate <= ty.end)
    .reduce((sum, txn) => sum + Math.abs(txn.amount), 0);
  const gstToSetAside = Math.max(0, est.gstNet - paidGst);
  const incomeTaxToSetAside = Math.max(0, est.incomeTax - paidIncomeTax);
  const reserve = gstToSetAside + incomeTaxToSetAside;
  const hasTaggedOffsets = paidGst > 0 || paidIncomeTax > 0;

  return (
    <div className="bg-card border border-border/70 rounded-[1.5rem] overflow-hidden shadow-sm">
      {/* Header — title + year toggle */}
      <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-2">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Set aside for tax</p>
        <div className="inline-flex bg-muted rounded-lg p-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); setYearKind('current'); }}
            className={cn(
              'px-2.5 min-h-11 rounded-md text-[11px] font-medium tabular-nums transition-colors',
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
              'px-2.5 min-h-11 rounded-md text-[11px] font-medium tabular-nums transition-colors',
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
        className="w-full min-h-12 text-left px-5 pb-4 pt-1 hover:bg-muted/30 active:bg-muted/50 transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Landmark size={17} strokeWidth={1.8} />
            </span>
            <div className="min-w-0">
              <p className="text-[2rem] font-bold leading-none tracking-[-0.035em] text-foreground tabular-nums">
                {fmt(reserve)}
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                {hasTaggedOffsets ? 'After tagged IRD payments' : 'Current conservative estimate'}
                {' · '}{yearComplete ? 'year complete' : `${pct}% through year`}
              </p>
            </div>
          </div>
          <ChevronDown
            size={18}
            className={cn(
              'mt-2 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border/60 pt-3">
          <div className="flex items-start gap-2">
            <Receipt size={14} className="text-orange-500 mt-0.5 shrink-0" strokeWidth={1.8} />
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">GST allowance</p>
              <p className={cn(
                'text-base font-bold',
                gstToSetAside > 0 ? 'text-foreground' : 'text-green-600',
              )}>
                {fmt(gstToSetAside)}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <TrendingDown size={14} className="text-blue-500 mt-0.5 shrink-0" strokeWidth={1.8} />
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Income tax</p>
              <p className="text-base font-bold text-foreground">{fmt(incomeTaxToSetAside)}</p>
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
            <Row label="Net GST estimate" value={fmt(est.gstNet)} />
            {paidGst > 0 && <Row label="Tagged GST payments" value={`-${fmt(paidGst)}`} />}
            <Row label="Still to allow for" value={fmt(gstToSetAside)} bold />
            <p className="text-[10px] text-muted-foreground mt-1.5 italic leading-relaxed">
              GST is filed across regular returns. Only payments tagged as GST in Bank Reconcile are deducted here.
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
            <Row label="Income tax estimate" value={fmt(est.incomeTax)} />
            {paidIncomeTax > 0 && <Row label="Tagged income-tax payments" value={`-${fmt(paidIncomeTax)}`} />}
            <Row label="Still to allow for" value={fmt(incomeTaxToSetAside)} bold />
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
              Estimate only. Keep the money separate, then confirm the final position against
              myIR or with an accountant before paying or drawing it.
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
