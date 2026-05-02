'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Job, Invoice, InvoiceKind } from '@/lib/types';
import { useStore } from '@/lib/store';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Receipt } from 'lucide-react';
import { cn } from '@/lib/utils';

const NZ_GST_RATE = 0.15;

const todayIso = (): string => new Date().toISOString().slice(0, 10);

const fmt = (n: number): string =>
  `$${n.toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface InvoiceActionProps {
  job: Job;
  open: boolean;
  onClose: () => void;
  /** When provided, the form edits this invoice rather than creating a new one. */
  invoice?: Invoice;
}

/**
 * Sheet for creating or editing an invoice on a job.
 *
 * Create mode (default — no invoice prop):
 *   - No invoices yet → kind = deposit, suggest 30% of quote.
 *   - Deposit issued → kind = final, suggest balance (job total − deposit).
 *   - On save: creates an invoice, sets job.status = 'invoiced', updates
 *     invoice_amount if needed.
 *
 * Edit mode (invoice prop passed):
 *   - Form populated with the invoice's existing values.
 *   - On save: updates the invoice in place. Job's invoice_amount adjusts
 *     to reflect the new sum of invoices if it changed.
 *   - "Mark paid" tickbox handles transition unpaid → paid (auto-creates
 *     income entry). Going paid → unpaid would need a separate "unmark paid"
 *     action; not built tonight.
 */
export function InvoiceAction({ job, open, onClose, invoice }: InvoiceActionProps) {
  const { invoices, addInvoice, updateInvoice, updateJob, markInvoicePaid, businessId } = useStore();
  const isEdit = invoice != null;

  // Existing invoices on this job
  const jobInvoices = useMemo(
    () => invoices.filter((i) => i.jobId === job.id).sort((a, b) =>
      a.invoiceDate.localeCompare(b.invoiceDate),
    ),
    [invoices, job.id],
  );

  // For "do other invoices of this kind already exist" checks we exclude the
  // one being edited so the form doesn't disable its own kind chip.
  const otherInvoices = isEdit
    ? jobInvoices.filter((i) => i.id !== invoice.id)
    : jobInvoices;
  const hasDeposit = otherInvoices.some((i) => i.kind === 'deposit');
  const hasFinal = otherInvoices.some((i) => i.kind === 'final');
  // Sum of all OTHER invoices — used to derive job total when this invoice
  // changes amount. Excluding the edited invoice avoids double-counting.
  const totalInvoicedExcludingThis = otherInvoices.reduce((s, i) => s + i.amountExGst, 0);
  const totalInvoicedSoFar = jobInvoices.reduce((s, i) => s + i.amountExGst, 0);

  // Smart defaults for kind + amount
  const defaultKind: InvoiceKind = !hasDeposit && !hasFinal ? 'deposit' : 'final';

  const quote = job.quoteAmount ?? 0;
  const totalWorkValue = job.invoiceAmount ?? quote ?? 0;
  // If a deposit exists, balance = totalWorkValue - deposit. Otherwise default
  // to 30% of quote for a deposit, or full quote for a final.
  const suggestedAmount = useMemo(() => {
    if (defaultKind === 'deposit' && quote > 0) {
      return Math.round(quote * 0.3 * 100) / 100;
    }
    if (defaultKind === 'final') {
      const total = totalWorkValue > 0 ? totalWorkValue : quote;
      return Math.max(0, Math.round((total - totalInvoicedSoFar) * 100) / 100);
    }
    return 0;
  }, [defaultKind, quote, totalWorkValue, totalInvoicedSoFar]);

  // Form state
  const defaultNumber = useMemo(() => {
    const base = `INV-${job.legacyId ?? job.id.slice(0, 6).toUpperCase()}`;
    if (defaultKind === 'deposit') return base;
    // For finals, suffix -F if a deposit already exists
    return hasDeposit ? `${base}-F` : base;
  }, [job.legacyId, job.id, defaultKind, hasDeposit]);

  // Initial values come from the existing invoice (edit mode) or the smart
  // defaults (create mode).
  const [kind, setKind]                   = useState<InvoiceKind>(invoice?.kind ?? defaultKind);
  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoiceNumber ?? defaultNumber);
  const [invoiceDate, setInvoiceDate]     = useState(invoice?.invoiceDate ?? todayIso());
  const [amountStr, setAmountStr]         = useState(
    invoice
      ? String(invoice.amountExGst)
      : (suggestedAmount > 0 ? String(suggestedAmount) : '')
  );
  const [variation, setVariation]         = useState(invoice?.notes ?? '');
  const [markPaid, setMarkPaid]           = useState(invoice?.paid ?? false);
  const [paidDate, setPaidDate]           = useState(invoice?.paidDate ?? todayIso());
  const [submitting, setSubmitting]       = useState(false);

  // Re-seed when re-opened or job/invoice changes
  useEffect(() => {
    if (!open) return;
    if (invoice) {
      setKind(invoice.kind);
      setInvoiceNumber(invoice.invoiceNumber);
      setInvoiceDate(invoice.invoiceDate);
      setAmountStr(String(invoice.amountExGst));
      setVariation(invoice.notes ?? '');
      setMarkPaid(invoice.paid);
      setPaidDate(invoice.paidDate ?? todayIso());
    } else {
      setKind(defaultKind);
      setInvoiceNumber(defaultNumber);
      setInvoiceDate(todayIso());
      setAmountStr(suggestedAmount > 0 ? String(suggestedAmount) : '');
      setVariation('');
      setMarkPaid(false);
      setPaidDate(todayIso());
    }
  }, [open, job.id, invoice, defaultKind, defaultNumber, suggestedAmount]);

  // Re-derive number when user changes kind — but only in CREATE mode.
  // In edit mode we don't auto-rewrite the user's existing invoice number.
  useEffect(() => {
    if (isEdit) return;
    const base = `INV-${job.legacyId ?? job.id.slice(0, 6).toUpperCase()}`;
    if (kind === 'deposit') setInvoiceNumber(base);
    else if (kind === 'final') setInvoiceNumber(hasDeposit ? `${base}-F` : base);
    else setInvoiceNumber(`${base}-P${jobInvoices.filter(i => i.kind === 'progress').length + 1}`);
  }, [kind, job.legacyId, job.id, hasDeposit, jobInvoices, isEdit]);

  const amountExGst = useMemo(() => {
    const n = Number(amountStr.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }, [amountStr]);
  const gst = amountExGst * NZ_GST_RATE;
  const inclGst = amountExGst + gst;

  // After this invoice (whether new or edited), what's the total invoiced?
  const balanceAfter = totalInvoicedExcludingThis + amountExGst;
  const variance = totalWorkValue > 0 ? balanceAfter - totalWorkValue : 0;
  const willUpdateTotal = balanceAfter > totalWorkValue;

  const canSave = amountExGst > 0
    && invoiceNumber.trim().length > 0
    && !submitting
    && !!businessId;

  async function handleSave() {
    if (!canSave) return;
    setSubmitting(true);

    const noteParts: string[] = [];
    if (variation.trim()) noteParts.push(variation.trim());
    const noteValue = noteParts.length > 0 ? noteParts.join(' ') : undefined;

    if (isEdit) {
      // Edit mode: update the existing invoice in place.
      updateInvoice(invoice.id, {
        invoiceNumber: invoiceNumber.trim(),
        invoiceDate,
        kind,
        amountExGst,
        gstApplies: true,
        gstComponent: gst,
        amountInclGst: inclGst,
        notes: noteValue,
      });

      // If the job's invoice_amount was tracking the old total and the new
      // sum has changed, update it. We only bump it up; never auto-shrink
      // it because the user might still want a higher total for future
      // invoices on the same job.
      const newTotal = Math.max(totalWorkValue, balanceAfter);
      if (newTotal !== totalWorkValue) {
        updateJob(job.id, { invoiceAmount: newTotal });
      }

      // Paid-status transitions:
      //   was unpaid, now ticked → mark paid (auto-creates income entry)
      //   was paid, now unticked → not built tonight; show a note
      const wasPaid = invoice.paid;
      if (!wasPaid && markPaid) {
        markInvoicePaid(invoice.id, paidDate);
      }
      // Note: paid → unpaid would need to delete the linked income entry too.
      // Not handling it here; user can do via SQL if needed.

      setSubmitting(false);
      onClose();
      return;
    }

    // Create mode
    const tempId = `inv_${Date.now()}`;
    const newInvoice: Invoice = {
      id: tempId,
      businessId: businessId!,
      jobId: job.id,
      invoiceNumber: invoiceNumber.trim(),
      invoiceDate,
      kind,
      amountExGst,
      gstApplies: true,
      gstComponent: gst,
      amountInclGst: inclGst,
      paid: false,
      notes: noteValue,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    addInvoice(newInvoice);

    const newTotal = Math.max(totalWorkValue, balanceAfter);
    updateJob(job.id, {
      status: 'invoiced',
      invoiceAmount: newTotal,
    });

    if (markPaid) {
      setTimeout(() => markInvoicePaid(tempId, paidDate), 0);
    }

    setSubmitting(false);
    onClose();
  }

  const allInvoiced = totalInvoicedSoFar >= totalWorkValue && totalWorkValue > 0;

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="bottom" className="rounded-t-2xl p-0" showCloseButton={false}>
        <div className="h-auto max-h-[92vh] flex flex-col overflow-hidden">
          {/* Header */}
          <div className="shrink-0 px-4 pt-4 pb-3 border-b border-border bg-card">
            <div className="flex items-center gap-2">
              <Receipt size={18} className="text-amber-500 shrink-0" strokeWidth={1.8} />
              <SheetHeader className="p-0">
                <SheetTitle className="text-base font-bold text-foreground">
                  {isEdit ? `Edit ${invoice.invoiceNumber}` : `Issue invoice — ${job.name}`}
                </SheetTitle>
              </SheetHeader>
            </div>
            {/* Summary of what's been invoiced so far */}
            {jobInvoices.length > 0 && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {jobInvoices.length} invoice{jobInvoices.length !== 1 ? 's' : ''} so far
                · {fmt(totalInvoicedSoFar)} ex-GST
                {totalWorkValue > 0 && ` of ${fmt(totalWorkValue)} total`}
              </p>
            )}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {/* Kind picker — Deposit / Final / Progress */}
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">
                Invoice type
              </label>
              <div className="flex gap-2">
                <KindButton label="Deposit" value="deposit" current={kind} onClick={() => setKind('deposit')} disabled={hasDeposit} />
                <KindButton label="Final"   value="final"   current={kind} onClick={() => setKind('final')} disabled={hasFinal} />
                <KindButton label="Progress" value="progress" current={kind} onClick={() => setKind('progress')} />
              </div>
              {hasDeposit && kind === 'deposit' && (
                <p className="mt-1 text-[10px] text-amber-600">A deposit invoice already exists.</p>
              )}
              {hasFinal && kind === 'final' && (
                <p className="mt-1 text-[10px] text-amber-600">A final invoice already exists. Saving will create another.</p>
              )}
            </div>

            {/* Invoice number + date */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">
                  Invoice #
                </label>
                <input
                  type="text"
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">
                  Invoice date
                </label>
                <input
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            {/* Amount */}
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">
                Amount this invoice (ex GST)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-base">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  placeholder="0.00"
                  className="w-full h-12 pl-7 pr-3 rounded-lg border border-input bg-background text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex items-center justify-between mt-2 text-xs">
                <span className="text-muted-foreground">
                  GST (15%): <span className="text-foreground font-medium">{fmt(gst)}</span>
                </span>
                <span className="text-muted-foreground">
                  Total incl GST: <span className="text-foreground font-semibold">{fmt(inclGst)}</span>
                </span>
              </div>
              {totalWorkValue > 0 && (
                <div className="mt-1.5 text-[11px] text-muted-foreground">
                  After this invoice: {fmt(balanceAfter)} of {fmt(totalWorkValue)} invoiced
                  {willUpdateTotal && (
                    <span className="text-amber-600 font-medium"> · job total will rise to {fmt(balanceAfter)}</span>
                  )}
                  {balanceAfter < totalWorkValue && (
                    <span> · {fmt(totalWorkValue - balanceAfter)} still to invoice</span>
                  )}
                </div>
              )}
            </div>

            {/* Variation reason */}
            {willUpdateTotal && (
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">
                  Reason for variation
                </label>
                <input
                  type="text"
                  value={variation}
                  onChange={(e) => setVariation(e.target.value)}
                  placeholder="e.g. additional prep on sun-exposed elevations"
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}

            {/* Mark paid */}
            <label className="flex items-center gap-2.5 cursor-pointer p-3 rounded-xl border border-border bg-muted/30">
              <input
                type="checkbox"
                checked={markPaid}
                onChange={(e) => setMarkPaid(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              <span className="text-sm font-medium text-foreground flex-1">Mark as paid now</span>
            </label>
            {markPaid && (
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">
                  Payment date
                </label>
                <input
                  type="date"
                  value={paidDate}
                  onChange={(e) => setPaidDate(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-[10px] text-muted-foreground mt-1.5 italic">
                  An income entry of {fmt(inclGst)} ({fmt(amountExGst)} ex GST) will be added on this date.
                </p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="shrink-0 px-4 py-3 border-t border-border bg-card flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button className={cn('flex-1 bg-primary')} onClick={handleSave} disabled={!canSave}>
              {isEdit
                ? (markPaid && !invoice.paid ? 'Save & mark paid' : 'Save changes')
                : (markPaid ? 'Save & mark paid' : 'Save invoice')}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function KindButton({
  label, value, current, onClick, disabled,
}: { label: string; value: InvoiceKind; current: InvoiceKind; onClick: () => void; disabled?: boolean }) {
  const active = current === value;
  return (
    <button
      onClick={onClick}
      disabled={disabled && !active}
      className={cn(
        'flex-1 h-9 rounded-lg text-sm font-medium border transition-colors',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : disabled
            ? 'bg-muted/40 text-muted-foreground/50 border-border cursor-not-allowed'
            : 'bg-background text-muted-foreground border-border hover:text-foreground hover:border-primary/30',
      )}
    >
      {label}
    </button>
  );
}
