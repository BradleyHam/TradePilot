'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import type { Invoice } from '@/lib/types';
import { Receipt, CheckCircle2, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

const fmt = (n: number) =>
  `$${n.toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDateNZ = (iso: string) => {
  if (!iso || iso.length < 10) return iso;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

interface InvoicesListProps {
  jobId: string;
  /** Tap on an invoice row to open it in the edit form. */
  onEdit?: (invoice: Invoice) => void;
}

/**
 * Renders the list of invoices issued on a job. Each row shows the invoice
 * number, date, kind, amount, and a paid/unpaid pill. Tapping a row triggers
 * onEdit so the parent can open an edit form. Unpaid rows have a "Mark paid"
 * inline action that opens a small popover for the payment date.
 */
export function InvoicesList({ jobId, onEdit }: InvoicesListProps) {
  const { invoices, markInvoicePaid } = useStore();

  const list = invoices
    .filter((i) => i.jobId === jobId)
    .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));

  const [activePaidPopoverId, setActivePaidPopoverId] = useState<string | null>(null);
  const [paidDate, setPaidDate] = useState<string>(() => new Date().toISOString().slice(0, 10));

  if (list.length === 0) return null;

  const total = list.reduce((s, i) => s + i.amountExGst, 0);
  const paidTotal = list.filter((i) => i.paid).reduce((s, i) => s + i.amountExGst, 0);
  const outstanding = total - paidTotal;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Invoices ({list.length})
        </p>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {fmt(paidTotal)} paid · {outstanding > 0 ? `${fmt(outstanding)} outstanding` : 'all paid'}
        </p>
      </div>
      <div className="space-y-2">
        {list.map((inv) => {
          const popoverOpen = activePaidPopoverId === inv.id;
          return (
            <div key={inv.id} className="rounded-xl bg-muted/40 overflow-hidden">
              {/* Tappable row — opens edit form via onEdit. */}
              <button
                onClick={() => onEdit?.(inv)}
                className={cn(
                  'flex items-center gap-3 p-3 w-full text-left',
                  onEdit && 'hover:bg-muted/60 active:bg-muted transition-colors cursor-pointer',
                )}
              >
                <Receipt size={16} className={cn(
                  inv.paid ? 'text-green-500' : 'text-amber-500',
                  'shrink-0',
                )} strokeWidth={1.8} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium text-foreground truncate">{inv.invoiceNumber}</p>
                    <KindBadge kind={inv.kind} />
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {fmtDateNZ(inv.invoiceDate)}
                    {inv.paid && inv.paidDate && ` · paid ${fmtDateNZ(inv.paidDate)}`}
                    {inv.notes && ` · ${inv.notes}`}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold text-foreground tabular-nums">{fmt(inv.amountExGst)}</p>
                  {inv.amountInclGst != null && (
                    <p className="text-[10px] text-muted-foreground tabular-nums">
                      {fmt(inv.amountInclGst)} incl
                    </p>
                  )}
                </div>
              </button>
              {/* Footer row: paid badge or mark-paid button */}
              <div className="flex items-center gap-2 px-3 pb-2">
                {inv.paid ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-700">
                    <CheckCircle2 size={12} strokeWidth={2} /> Paid
                  </span>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700">
                      <Circle size={11} strokeWidth={2} /> Awaiting payment
                    </span>
                    <button
                      onClick={() => {
                        setPaidDate(new Date().toISOString().slice(0, 10));
                        setActivePaidPopoverId(popoverOpen ? null : inv.id);
                      }}
                      className="ml-auto text-[11px] font-medium text-primary hover:underline"
                    >
                      Mark paid
                    </button>
                  </>
                )}
              </div>
              {popoverOpen && !inv.paid && (
                <div className="border-t border-border bg-card p-3 space-y-2">
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide block">
                    Payment date
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={paidDate}
                      onChange={(e) => setPaidDate(e.target.value)}
                      className="flex-1 h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <button
                      onClick={() => {
                        markInvoicePaid(inv.id, paidDate);
                        setActivePaidPopoverId(null);
                      }}
                      className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-semibold"
                    >
                      Confirm
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground italic">
                    An income entry will be auto-created on this date.
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: Invoice['kind'] }) {
  const styles = {
    deposit:  'bg-blue-100 text-blue-700',
    progress: 'bg-violet-100 text-violet-700',
    final:    'bg-green-100 text-green-700',
  } as const;
  return (
    <span className={cn(
      'inline-flex items-center px-1.5 py-0 rounded text-[9px] font-semibold uppercase tracking-wide',
      styles[kind],
    )}>
      {kind}
    </span>
  );
}
