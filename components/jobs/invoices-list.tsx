'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import type { Invoice } from '@/lib/types';
import {
  defaultInvoiceDueDate,
  invoiceCountsAsIssued,
  invoiceDisplayStatus,
  invoiceIsOutstanding,
} from '@/lib/invoice-lifecycle';
import { Receipt, CheckCircle2, Circle, AlertTriangle, FilePenLine, Ban, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LogHoursPrompt, shouldPromptForHours } from './log-hours-prompt';

const fmt = (n: number) =>
  `$${n.toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDateNZ = (iso: string) => {
  if (!iso || iso.length < 10) return iso;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

interface InvoicesListProps {
  jobId: string;
  onEdit?: (invoice: Invoice) => void;
}

export function InvoicesList({ jobId, onEdit }: InvoicesListProps) {
  const {
    invoices, entries, updateInvoice, markInvoicePaid, unmarkInvoicePaid, getQuoteTemplate,
  } = useStore();
  const list = invoices
    .filter((i) => i.jobId === jobId)
    .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));

  const [activePaidPopoverId, setActivePaidPopoverId] = useState<string | null>(null);
  const [activeUndoId, setActiveUndoId] = useState<string | null>(null);
  const [paidDate, setPaidDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [hoursPromptJobId, setHoursPromptJobId] = useState<string | null>(null);

  if (list.length === 0) return null;

  const issued = list.filter(invoiceCountsAsIssued);
  const paidTotal = issued.filter((i) => i.paid).reduce((s, i) => s + i.amountExGst, 0);
  const outstanding = issued.filter(invoiceIsOutstanding).reduce((s, i) => s + i.amountExGst, 0);

  async function handleMarkPaid(inv: Invoice) {
    setBusyId(inv.id);
    setActionError(null);
    setActionNote(null);
    const result = await markInvoicePaid(inv.id, paidDate);
    setBusyId(null);
    if (!result.ok) {
      setActionError(result.error ?? 'Payment was not saved.');
      return;
    }
    setActivePaidPopoverId(null);
    if (shouldPromptForHours(inv, entries)) setHoursPromptJobId(jobId);
  }

  async function handleUndoPayment(inv: Invoice) {
    setBusyId(inv.id);
    setActionError(null);
    setActionNote(null);
    const result = await unmarkInvoicePaid(inv.id);
    setBusyId(null);
    if (!result.ok) {
      setActionError(result.error ?? 'Payment correction was not saved.');
      return;
    }
    setActiveUndoId(null);
    if (result.preservedEntry) {
      setActionNote('Invoice corrected. The existing bank/imported income record was kept for your audit trail.');
    }
  }

  function handleMarkSent(inv: Invoice) {
    const depositDays = getQuoteTemplate()?.paymentTerms?.depositDueDays ?? 0;
    updateInvoice(inv.id, {
      status: 'sent',
      sentAt: new Date().toISOString(),
      dueDate: inv.dueDate ?? defaultInvoiceDueDate(inv.invoiceDate, inv.kind, depositDays),
    });
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Invoices ({list.length})
        </p>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {fmt(paidTotal)} paid{outstanding > 0 ? ` · ${fmt(outstanding)} owing` : ''}
        </p>
      </div>

      {(actionError || actionNote) && (
        <p className={cn(
          'mb-2 rounded-lg border px-3 py-2 text-xs',
          actionError ? 'border-red-200 bg-red-50 text-red-700' : 'border-blue-200 bg-blue-50 text-blue-800',
        )}>
          {actionError ?? actionNote}
        </p>
      )}

      <div className="space-y-2">
        {list.map((inv) => {
          const display = invoiceDisplayStatus(inv);
          const popoverOpen = activePaidPopoverId === inv.id;
          const undoOpen = activeUndoId === inv.id;
          const isBusy = busyId === inv.id;
          return (
            <div key={inv.id} className={cn('rounded-xl bg-muted/40 overflow-hidden', display === 'void' && 'opacity-65')}>
              <button
                onClick={() => onEdit?.(inv)}
                className={cn(
                  'flex min-h-14 items-center gap-3 p-3 w-full text-left',
                  onEdit && 'hover:bg-muted/60 active:bg-muted transition-colors cursor-pointer',
                )}
              >
                <Receipt size={17} className={cn(statusTone(display).icon, 'shrink-0')} strokeWidth={1.8} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className={cn('text-sm font-medium text-foreground truncate', display === 'void' && 'line-through')}>
                      {inv.invoiceNumber}
                    </p>
                    <KindBadge kind={inv.kind} />
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">
                    Issued {fmtDateNZ(inv.invoiceDate)}
                    {inv.dueDate && display !== 'draft' && display !== 'void' && ` · due ${fmtDateNZ(inv.dueDate)}`}
                    {inv.paid && inv.paidDate && ` · paid ${fmtDateNZ(inv.paidDate)}`}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold text-foreground tabular-nums">{fmt(inv.amountExGst)}</p>
                  <StatusBadge status={display} />
                </div>
              </button>

              <div className="flex items-center gap-2 px-3 pb-2 min-h-11">
                {display === 'paid' && (
                  <>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-700">
                      <CheckCircle2 size={13} strokeWidth={2} /> Payment recorded
                    </span>
                    <button
                      onClick={() => setActiveUndoId(undoOpen ? null : inv.id)}
                      className="ml-auto min-h-11 px-2 inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground"
                    >
                      <RotateCcw size={12} /> Correct payment
                    </button>
                  </>
                )}
                {display === 'draft' && (
                  <>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600">
                      <FilePenLine size={13} /> Not sent yet
                    </span>
                    <button
                      onClick={() => handleMarkSent(inv)}
                      className="ml-auto min-h-11 px-3 rounded-lg text-[11px] font-semibold text-primary"
                    >
                      Mark sent
                    </button>
                  </>
                )}
                {(display === 'sent' || display === 'due' || display === 'overdue') && (
                  <>
                    <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium', statusTone(display).text)}>
                      {display === 'overdue' ? <AlertTriangle size={13} /> : <Circle size={12} strokeWidth={2} />}
                      {display === 'overdue' ? 'Overdue' : display === 'due' ? 'Due today' : 'Awaiting payment'}
                    </span>
                    <button
                      onClick={() => {
                        setPaidDate(new Date().toISOString().slice(0, 10));
                        setActivePaidPopoverId(popoverOpen ? null : inv.id);
                      }}
                      className="ml-auto min-h-11 px-3 rounded-lg text-[11px] font-semibold text-primary"
                    >
                      Mark paid
                    </button>
                  </>
                )}
                {display === 'void' && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                    <Ban size={13} /> Void{inv.voidReason ? ` · ${inv.voidReason}` : ''}
                  </span>
                )}
              </div>

              {popoverOpen && invoiceIsOutstanding(inv) && (
                <div className="border-t border-border bg-card p-3 space-y-2">
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide block">
                    Payment date
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={paidDate}
                      onChange={(e) => setPaidDate(e.target.value)}
                      className="flex-1 min-w-0 h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <button
                      onClick={() => void handleMarkPaid(inv)}
                      disabled={isBusy}
                      className="h-11 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-60"
                    >
                      {isBusy ? 'Saving…' : 'Confirm'}
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Records the invoice and income together. If either fails, neither is saved.
                  </p>
                </div>
              )}

              {undoOpen && inv.paid && (
                <div className="border-t border-border bg-card p-3 space-y-2">
                  <p className="text-xs text-foreground">
                    Wrong payment? This makes the invoice unpaid again. TradePilot-created income is removed; imported or bank evidence is kept.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setActiveUndoId(null)}
                      className="h-11 flex-1 rounded-lg border border-border text-sm font-medium"
                    >
                      Keep paid
                    </button>
                    <button
                      onClick={() => void handleUndoPayment(inv)}
                      disabled={isBusy}
                      className="h-11 flex-1 rounded-lg bg-amber-600 text-white text-sm font-semibold disabled:opacity-60"
                    >
                      {isBusy ? 'Correcting…' : 'Undo payment'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <LogHoursPrompt jobId={hoursPromptJobId} onClose={() => setHoursPromptJobId(null)} />
    </div>
  );
}

function statusTone(status: ReturnType<typeof invoiceDisplayStatus>) {
  if (status === 'paid') return { icon: 'text-green-500', text: 'text-green-700' };
  if (status === 'overdue') return { icon: 'text-red-500', text: 'text-red-700' };
  if (status === 'due') return { icon: 'text-amber-500', text: 'text-amber-700' };
  if (status === 'sent') return { icon: 'text-blue-500', text: 'text-blue-700' };
  return { icon: 'text-slate-400', text: 'text-slate-600' };
}

function StatusBadge({ status }: { status: ReturnType<typeof invoiceDisplayStatus> }) {
  const labels = { draft: 'Draft', sent: 'Sent', due: 'Due', overdue: 'Overdue', paid: 'Paid', void: 'Void' };
  const styles = {
    draft: 'bg-slate-100 text-slate-600',
    sent: 'bg-blue-100 text-blue-700',
    due: 'bg-amber-100 text-amber-800',
    overdue: 'bg-red-100 text-red-700',
    paid: 'bg-green-100 text-green-700',
    void: 'bg-slate-100 text-slate-500',
  };
  return <span className={cn('inline-flex rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide', styles[status])}>{labels[status]}</span>;
}

function KindBadge({ kind }: { kind: Invoice['kind'] }) {
  const styles = {
    deposit: 'bg-blue-100 text-blue-700',
    progress: 'bg-violet-100 text-violet-700',
    final: 'bg-green-100 text-green-700',
  } as const;
  return (
    <span className={cn('inline-flex items-center px-1.5 rounded text-[9px] font-semibold uppercase tracking-wide', styles[kind])}>
      {kind}
    </span>
  );
}
