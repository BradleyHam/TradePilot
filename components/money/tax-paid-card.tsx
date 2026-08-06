'use client';

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { taxYearOf, previousTaxYearOf } from '@/lib/tax-estimator';
import type { TaxPaymentKind } from '@/lib/types';
import { ChevronDown, Landmark } from 'lucide-react';
import { cn } from '@/lib/utils';

const fmt = (n: number) => `$${Math.round(n).toLocaleString('en-NZ')}`;

const TAX_KIND_LABELS: Record<TaxPaymentKind, string> = {
  income_tax: 'Income tax',
  gst:        'GST',
  paye:       'PAYE',
  penalty:    'Penalty / interest',
  other:      'Other',
};
const TAX_KIND_ORDER: TaxPaymentKind[] = ['income_tax', 'gst', 'paye', 'penalty', 'other'];

/**
 * "Paid to IRD" — a read-only tally of bank transactions classified as tax
 * payments (status === 'tax') for the chosen NZ tax year. These are NOT
 * expenses (income tax + GST + PAYE + penalties aren't deductible), so they
 * never appear in the profit/expense/GST figures elsewhere on this page —
 * this card is the one place the money is surfaced, purely so Brad can see
 * what he's handed to IRD across the year. Nothing here feeds any calc.
 *
 * Self-contained (reads the store directly) so it drops into the Money page
 * with no prop wiring, exactly like TaxExposureCard.
 */
export function TaxPaidCard() {
  const { bankTransactions } = useStore();
  const [open, setOpen] = useState(false);
  const [yearKind, setYearKind] = useState<'current' | 'prev'>('current');

  const ty = yearKind === 'current' ? taxYearOf() : previousTaxYearOf();

  // Tax-tagged debits in the selected tax year. Amounts are stored signed
  // (negative for money out), so we sum absolute values to a positive "paid".
  const { total, byKind, count } = useMemo(() => {
    const inYear = bankTransactions.filter(
      (t) => t.status === 'tax'
        && t.txnDate >= ty.start
        && t.txnDate <= ty.end,
    );
    const byKind = new Map<TaxPaymentKind | 'untyped', number>();
    let total = 0;
    for (const t of inYear) {
      const amt = Math.abs(t.amount);
      total += amt;
      const key: TaxPaymentKind | 'untyped' = t.taxKind ?? 'untyped';
      byKind.set(key, (byKind.get(key) ?? 0) + amt);
    }
    return { total, byKind, count: inYear.length };
  }, [bankTransactions, ty.start, ty.end]);

  // Nothing tagged yet for either year → hide entirely (no empty card, per
  // the "no empty visualisations" UX rule). We check both years so the card
  // doesn't vanish when you toggle to a year with no payments.
  const anyEver = useMemo(
    () => bankTransactions.some((t) => t.status === 'tax'),
    [bankTransactions],
  );
  if (!anyEver) return null;

  const orderedKinds: (TaxPaymentKind | 'untyped')[] = [
    ...TAX_KIND_ORDER.filter((k) => byKind.has(k)),
    ...(byKind.has('untyped') ? (['untyped'] as const) : []),
  ];

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      {/* Header — title + year toggle */}
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2">
        <p className="text-sm font-semibold text-foreground">Paid to IRD</p>
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
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Landmark size={16} className="text-indigo-500 shrink-0" strokeWidth={1.8} />
            <div>
              <p className="text-base font-bold text-foreground tabular-nums">{fmt(total)}</p>
              <p className="text-[11px] text-muted-foreground">
                {count === 0
                  ? 'Nothing tagged this year'
                  : `${count} payment${count > 1 ? 's' : ''} · not deductible`}
              </p>
            </div>
          </div>
          {count > 0 && (
            <ChevronDown
              size={14}
              className={cn('text-muted-foreground transition-transform', open && 'rotate-180')}
            />
          )}
        </div>
      </button>

      {/* Expanded breakdown by sub-type */}
      {open && count > 0 && (
        <div className="border-t border-border px-4 py-3 space-y-1 bg-muted/20">
          {orderedKinds.map((k) => (
            <div key={k} className="flex items-center justify-between py-1">
              <span className="text-xs text-muted-foreground">
                {k === 'untyped' ? 'Unspecified' : TAX_KIND_LABELS[k]}
              </span>
              <span className="text-sm tabular-nums text-foreground">
                {fmt(byKind.get(k) ?? 0)}
              </span>
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground pt-1.5 italic leading-relaxed">
            Tagged in the bank reconcile. Excluded from profit &amp; GST — income tax,
            GST paid, PAYE and penalties aren&apos;t deductible business expenses.
          </p>
        </div>
      )}
    </div>
  );
}
