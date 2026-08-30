'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Job, Invoice, InvoiceKind, InvoiceStatus, ParsedInvoice } from '@/lib/types';
import { useStore } from '@/lib/store';
import { defaultInvoiceDueDate } from '@/lib/invoice-lifecycle';
import { buildInvoicePdfData } from '@/lib/invoice-pdf-data';
import { supabase } from '@/lib/supabase/client';
import { extractPdfText } from '@/lib/pdf/extract-text';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Receipt, Upload, Undo2, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LogHoursPrompt, shouldPromptForHours } from './log-hours-prompt';

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
  /** When provided (create mode), the sheet opens pre-loaded from this PDF —
   *  used when recording an invoice dropped on the job's documents panel. */
  initialFile?: File;
}

/**
 * Sheet for creating or editing an invoice on a job.
 *
 * Create mode (default — no invoice prop):
 *   - No invoices yet → kind = deposit, suggest 30% of quote.
 *   - Deposit issued → kind = final, suggest balance (job total − deposit).
 *   - On save: creates an invoice and updates invoice_amount if needed.
 *     Work status is deliberately untouched.
 *
 * Edit mode (invoice prop passed):
 *   - Form populated with the invoice's existing values.
 *   - On save: updates the invoice in place. Job's invoice_amount adjusts
 *     to reflect the new sum of invoices if it changed.
 *   - "Mark paid" is atomic with the linked income entry. Corrections use
 *     the invoice list's explicit "Correct payment" action.
 */
export function InvoiceAction({ job, open, onClose, invoice, initialFile }: InvoiceActionProps) {
  const { invoices, entries, addInvoice, updateInvoice, updateJob, markInvoicePaid, voidInvoice, businessId, ensureJobHasQuote, addQuoteAttachments, getQuoteTemplate, quotes, resolveLogoUrl } = useStore();
  const isEdit = invoice != null;

  // Opens the "no hours on this job" quick-add right after a save that
  // marked the invoice paid. Lives OUTSIDE the main Sheet (which will have
  // closed by then) so the prompt survives onClose(). Null = closed.
  const [hoursPromptJobId, setHoursPromptJobId] = useState<string | null>(null);

  // Invoice-PDF generation state (the "Download invoice PDF" button).
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // Existing invoices on this job
  const jobInvoices = useMemo(
    () => invoices.filter((i) => i.jobId === job.id && i.status !== 'void').sort((a, b) =>
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
      // Deposit % comes from the quote template (Settings → Quote template),
      // falling back to the NZ-standard 30% when it's unset. Keeps the
      // auto-filled deposit in step with whatever Brad set there.
      const pct = getQuoteTemplate()?.paymentTerms?.depositPercent;
      const fraction = typeof pct === 'number' && pct > 0 ? pct / 100 : 0.3;
      return Math.round(quote * fraction * 100) / 100;
    }
    if (defaultKind === 'final') {
      const total = totalWorkValue > 0 ? totalWorkValue : quote;
      return Math.max(0, Math.round((total - totalInvoicedSoFar) * 100) / 100);
    }
    return 0;
  }, [defaultKind, quote, totalWorkValue, totalInvoicedSoFar, getQuoteTemplate]);

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
  const [invoiceStatus, setInvoiceStatus] = useState<Extract<InvoiceStatus, 'draft' | 'sent'>>(
    invoice?.status === 'draft' ? 'draft' : 'sent',
  );
  const depositDueDays = getQuoteTemplate()?.paymentTerms?.depositDueDays ?? 0;
  const [dueDate, setDueDate] = useState(
    invoice?.dueDate ?? defaultInvoiceDueDate(invoice?.invoiceDate ?? todayIso(), invoice?.kind ?? defaultKind, depositDueDays),
  );
  const [amountStr, setAmountStr]         = useState(
    invoice
      ? String(invoice.amountExGst)
      : (suggestedAmount > 0 ? String(suggestedAmount) : '')
  );
  const [variation, setVariation]         = useState(invoice?.notes ?? '');
  const [markPaid, setMarkPaid]           = useState(invoice?.paid ?? false);
  const [paidDate, setPaidDate]           = useState(invoice?.paidDate ?? todayIso());
  const [submitting, setSubmitting]       = useState(false);
  const [saveError, setSaveError]         = useState<string | null>(null);
  const [showVoidConfirm, setShowVoidConfirm] = useState(false);
  const [voidReason, setVoidReason] = useState(invoice?.voidReason ?? '');

  // ── PDF upload / extract state ──────────────────────────────────────────
  // The user can drag an invoice PDF into the drop zone (or tap to pick one).
  // We extract text client-side, POST to /api/parse-invoice, then populate
  // the form fields with what came back. A snapshot of pre-upload values is
  // captured so the "Undo" affordance can roll back.
  type ExtractStage = 'idle' | 'reading' | 'parsing' | 'error' | 'done';
  const [extractStage, setExtractStage] = useState<ExtractStage>('idle');
  const [extractMsg, setExtractMsg] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  // The previous form values captured right before we overwrite from PDF.
  // null = no undo available (haven't extracted yet, or already undone).
  type FormSnapshot = {
    kind: InvoiceKind;
    invoiceNumber: string;
    invoiceDate: string;
    amountStr: string;
    variation: string;
  };
  const [undoSnapshot, setUndoSnapshot] = useState<FormSnapshot | null>(null);
  // How many fields the most recent extraction actually filled. Drives
  // the "Filled N fields from PDF" banner copy.
  const [filledCount, setFilledCount] = useState(0);
  // The dropped invoice PDF, kept so we can store it on the job when the
  // invoice is saved (the parse above only reads it for the numbers).
  const [attachFile, setAttachFile] = useState<File | null>(null);

  const handleExtractFile = useCallback(async (file: File) => {
    setExtractMsg(null);
    setUndoSnapshot(null);

    // 1. Validate file.
    const MAX_PDF_BYTES = 10 * 1024 * 1024;
    if (file.size === 0) {
      setExtractStage('error');
      setExtractMsg('File is empty.');
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setExtractStage('error');
      setExtractMsg(`PDF too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 10MB.`);
      return;
    }
    if (file.type && file.type !== 'application/pdf') {
      setExtractStage('error');
      setExtractMsg('Not a PDF file.');
      return;
    }

    // Keep the file so saving the invoice also stores the PDF on the job.
    setAttachFile(file);

    // 2. Extract text client-side.
    setExtractStage('reading');
    let extracted: Awaited<ReturnType<typeof extractPdfText>>;
    try {
      extracted = await extractPdfText(file);
    } catch (err) {
      console.error('[invoice-extract] PDF text extract failed:', err);
      setExtractStage('error');
      setExtractMsg("Couldn't read this PDF — it may be an image-only scan or password-protected.");
      return;
    }
    if (extracted.text.trim().length < 20) {
      setExtractStage('error');
      setExtractMsg("No readable text in this PDF — image-only scans aren't supported yet.");
      return;
    }

    // 3. POST /api/parse-invoice.
    setExtractStage('parsing');
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setExtractStage('error');
      setExtractMsg('Not signed in — please refresh and sign in again.');
      return;
    }
    let parsed: ParsedInvoice;
    try {
      const res = await fetch('/api/parse-invoice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ text: extracted.text }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        const detail = json.error ?? `HTTP ${res.status}`;
        setExtractStage('error');
        setExtractMsg(`Parser failed: ${detail}`);
        return;
      }
      parsed = json.parsed as ParsedInvoice;
    } catch (err) {
      console.error('[invoice-extract] parse request failed:', err);
      setExtractStage('error');
      setExtractMsg("Couldn't reach the parser. Check your connection and try again.");
      return;
    }

    // 4. Snapshot current values for Undo, then overwrite from parsed.
    //    We capture BEFORE setState calls so the snapshot is the user's
    //    state at moment-of-upload, not the half-updated state.
    const snapshot: FormSnapshot = {
      kind, invoiceNumber, invoiceDate, amountStr, variation,
    };

    let filled = 0;
    if (parsed.kind && !hasFinal /* don't auto-set to 'final' when one exists */) {
      // Only auto-set kind if the picker would have allowed it manually —
      // i.e. skip when a deposit/final of the same kind already exists.
      if (!(parsed.kind === 'deposit' && hasDeposit)) {
        setKind(parsed.kind);
        filled++;
      }
    }
    if (parsed.invoiceNumber) {
      setInvoiceNumber(parsed.invoiceNumber);
      filled++;
    }
    if (parsed.invoiceDate) {
      setInvoiceDate(parsed.invoiceDate);
      filled++;
    }
    if (typeof parsed.amountExGst === 'number' && parsed.amountExGst > 0) {
      setAmountStr(parsed.amountExGst.toFixed(2));
      filled++;
    }
    if (parsed.description) {
      setVariation(parsed.description);
      filled++;
    }

    if (filled === 0) {
      // Parser ran but nothing usable came back. Don't show "filled 0
      // fields" — surface as an error instead.
      setExtractStage('error');
      setExtractMsg("Couldn't read enough from this PDF to fill any fields.");
      return;
    }

    setUndoSnapshot(snapshot);
    setFilledCount(filled);
    setExtractStage('done');
    setExtractMsg(null);
  }, [kind, invoiceNumber, invoiceDate, amountStr, variation, hasDeposit, hasFinal]);

  function undoExtract() {
    if (!undoSnapshot) return;
    setKind(undoSnapshot.kind);
    setInvoiceNumber(undoSnapshot.invoiceNumber);
    setInvoiceDate(undoSnapshot.invoiceDate);
    setAmountStr(undoSnapshot.amountStr);
    setVariation(undoSnapshot.variation);
    setUndoSnapshot(null);
    setExtractStage('idle');
  }

  // Drag-drop handlers. dragDepth tracks nested enter/leave so the styling
  // doesn't flicker when the cursor passes over child elements.
  function onDragEnter(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepth.current++;
    setDragOver(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleExtractFile(file);
  }
  const extractBusy = extractStage === 'reading' || extractStage === 'parsing';
  const extractBusyLabel = extractStage === 'reading' ? 'Reading PDF…'
    : extractStage === 'parsing' ? 'Reading invoice…'
    : null;

  // Re-seed when re-opened or job/invoice changes
  // When opened from the job's documents drop (initialFile passed in create
  // mode), parse it straight away to auto-fill the form. The ref stops it
  // re-running on every render while the sheet is open, and resets on close.
  const handledInitialFileRef = useRef<File | null>(null);
  useEffect(() => {
    if (!open) { handledInitialFileRef.current = null; return; }
    if (isEdit || !initialFile) return;
    if (handledInitialFileRef.current === initialFile) return;
    handledInitialFileRef.current = initialFile;
    void handleExtractFile(initialFile);
  }, [open, isEdit, initialFile, handleExtractFile]);

  useEffect(() => {
    if (!open) return;
    if (invoice) {
      setKind(invoice.kind);
      setInvoiceNumber(invoice.invoiceNumber);
      setInvoiceDate(invoice.invoiceDate);
      setInvoiceStatus(invoice.status === 'draft' ? 'draft' : 'sent');
      setDueDate(invoice.dueDate ?? defaultInvoiceDueDate(invoice.invoiceDate, invoice.kind, depositDueDays));
      setAmountStr(String(invoice.amountExGst));
      setVariation(invoice.notes ?? '');
      setMarkPaid(invoice.paid);
      setPaidDate(invoice.paidDate ?? todayIso());
      setVoidReason(invoice.voidReason ?? '');
    } else {
      setKind(defaultKind);
      setInvoiceNumber(defaultNumber);
      const today = todayIso();
      setInvoiceDate(today);
      setInvoiceStatus('sent');
      setDueDate(defaultInvoiceDueDate(today, defaultKind, depositDueDays));
      setAmountStr(suggestedAmount > 0 ? String(suggestedAmount) : '');
      setVariation('');
      setMarkPaid(false);
      setPaidDate(todayIso());
      setVoidReason('');
    }
    setSaveError(null);
    setShowVoidConfirm(false);
    // Clear extract state too — re-opening should feel like a fresh start,
    // not show a stale "Filled 4 fields" banner from the last time.
    setExtractStage('idle');
    setExtractMsg(null);
    setUndoSnapshot(null);
    setFilledCount(0);
  }, [open, job.id, invoice, defaultKind, defaultNumber, suggestedAmount, depositDueDays]);

  // Re-derive number when user changes kind — but only in CREATE mode.
  // In edit mode we don't auto-rewrite the user's existing invoice number.
  useEffect(() => {
    if (isEdit) return;
    const base = `INV-${job.legacyId ?? job.id.slice(0, 6).toUpperCase()}`;
    if (kind === 'deposit') setInvoiceNumber(base);
    else if (kind === 'final') setInvoiceNumber(hasDeposit ? `${base}-F` : base);
    else setInvoiceNumber(`${base}-P${jobInvoices.filter(i => i.kind === 'progress').length + 1}`);
  }, [kind, job.legacyId, job.id, hasDeposit, jobInvoices, isEdit]);

  function handleKindChange(nextKind: InvoiceKind) {
    setKind(nextKind);
    if (!isEdit) setDueDate(defaultInvoiceDueDate(invoiceDate, nextKind, depositDueDays));
  }

  function handleInvoiceDateChange(nextDate: string) {
    setInvoiceDate(nextDate);
    if (!isEdit) setDueDate(defaultInvoiceDueDate(nextDate, kind, depositDueDays));
  }

  const amountExGst = useMemo(() => {
    const n = Number(amountStr.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }, [amountStr]);
  const gst = amountExGst * NZ_GST_RATE;
  const inclGst = amountExGst + gst;

  // After this invoice (whether new or edited), what's the total invoiced?
  const balanceAfter = totalInvoicedExcludingThis + amountExGst;
  const willUpdateTotal = balanceAfter > totalWorkValue;

  const canSave = amountExGst > 0
    && invoiceNumber.trim().length > 0
    && !submitting
    && !!businessId;

  async function handleSave() {
    if (!canSave) return;
    setSubmitting(true);
    setSaveError(null);

    const noteParts: string[] = [];
    if (variation.trim()) noteParts.push(variation.trim());
    const noteValue = noteParts.length > 0 ? noteParts.join(' ') : undefined;

    if (isEdit) {
      if (invoice.status === 'void') {
        setSubmitting(false);
        return;
      }
      // Edit mode: update the existing invoice in place.
      const saved = await updateInvoice(invoice.id, {
        invoiceNumber: invoiceNumber.trim(),
        invoiceDate,
        status: invoice.paid ? 'paid' : invoiceStatus,
        dueDate,
        sentAt: !invoice.paid && invoiceStatus === 'sent'
          ? (invoice.sentAt ?? new Date().toISOString())
          : (!invoice.paid ? '' : invoice.sentAt),
        kind,
        amountExGst,
        gstApplies: true,
        gstComponent: gst,
        amountInclGst: inclGst,
        notes: noteValue,
      });
      if (!saved.ok) {
        setSaveError(saved.error ?? 'Invoice changes were not saved.');
        setSubmitting(false);
        return;
      }

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
        const paidResult = await markInvoicePaid(invoice.id, paidDate);
        if (!paidResult.ok) {
          setSaveError(paidResult.error ?? 'The invoice saved, but the payment did not.');
          setSubmitting(false);
          return;
        }
        // Paid with zero hours on the job → prompt to backfill them so the
        // $/h maths can exist. Uses the form's CURRENT kind (deposits are
        // exempt — paid-before-work is their normal state).
        if (shouldPromptForHours({ jobId: job.id, kind }, entries)) {
          setHoursPromptJobId(job.id);
        }
      }
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
      status: invoiceStatus,
      dueDate,
      sentAt: invoiceStatus === 'sent' ? new Date().toISOString() : undefined,
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
    // Kick off the insert. Keep the promise so that, when "mark paid" is
    // ticked, we can wait for the REAL Supabase UUID before marking it paid.
    // Marking paid with the optimistic temp id ('inv_…') was the cause of the
    // 22P02 "invalid input syntax for type uuid" failure — markInvoicePaid
    // ran an .eq('id', tempId) update before addInvoice had swapped in the
    // real id (the old setTimeout(…, 0) raced the network insert and lost).
    const createdPromise = addInvoice(newInvoice);

    const newTotal = Math.max(totalWorkValue, balanceAfter);
    updateJob(job.id, { invoiceAmount: newTotal });

    // Keep the dropped invoice PDF on the job as a document (best-effort —
    // the invoice record itself is what drives the money; this is the file).
    if (attachFile) {
      const pdf = attachFile;
      setAttachFile(null);
      (async () => {
        const quoteId = await ensureJobHasQuote(job.id);
        if (quoteId) await addQuoteAttachments(quoteId, [{ file: pdf, kind: 'other' }]);
      })();
    }

    if (markPaid) {
      // Wait for the persisted invoice (real UUID) before marking it paid so
      // we never key the DB update on the temp id. If the insert failed,
      // addInvoice resolves null (and has already surfaced the error +
      // rolled back the optimistic row), so there's nothing to mark paid.
      const created = await createdPromise;
      if (created) {
        const paidResult = await markInvoicePaid(created.id, paidDate);
        if (!paidResult.ok) {
          setSaveError(paidResult.error ?? 'The invoice saved, but the payment did not.');
          setSubmitting(false);
          return;
        }
        if (shouldPromptForHours({ jobId: job.id, kind }, entries)) {
          setHoursPromptJobId(job.id);
        }
      }
    }

    setSubmitting(false);
    onClose();
  }

  async function handleVoid() {
    if (!isEdit || invoice.paid || invoice.status === 'void') return;
    setSubmitting(true);
    setSaveError(null);
    const result = await voidInvoice(invoice.id, voidReason);
    setSubmitting(false);
    if (!result.ok) {
      setSaveError(result.error ?? 'Invoice was not voided.');
      return;
    }
    onClose();
  }

  // Build the branded invoice PDF from the current form values + job +
  // template, render it to a blob, and download it. Works before the
  // invoice is saved — it reads the live form state, not the DB record.
  async function handleDownloadPdf() {
    setPdfError(null);
    const template = getQuoteTemplate();
    if (!template) {
      setPdfError('Set up your quote template first (Settings → Quote template).');
      return;
    }
    if (!invoiceNumber.trim()) {
      setPdfError('Add an invoice number first.');
      return;
    }
    setPdfBusy(true);
    try {
      const logoUrl = resolveLogoUrl(template.header.logoStoragePath);
      const jobQuote = quotes.find((q) => q.jobId === job.id);

      const depPct = template.paymentTerms?.depositPercent ?? 30;
      const jobTotalExGst = totalWorkValue > 0 ? totalWorkValue : quote;
      const jobTotalInclGst = jobTotalExGst * (1 + NZ_GST_RATE);
      const balanceInclGst = Math.max(0, Math.round((jobTotalInclGst - inclGst) * 100) / 100);

      const pdfData = buildInvoicePdfData({
        kind,
        invoiceNumber: invoiceNumber.trim(),
        invoiceDateISO: invoiceDate,
        dueDateISO: dueDate,
        amountExGst, gst, inclGst,
        job, quote: jobQuote, balanceInclGst, depositPercent: depPct,
      });

      const { pdf } = await import('@react-pdf/renderer');
      const { InvoicePdfDocument } = await import('@/components/invoices/invoice-pdf');
      const doc = (
        <InvoicePdfDocument template={template} job={job} logoUrl={logoUrl} data={pdfData} />
      );
      const blob = await pdf(doc).toBlob();

      const slug = job.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'invoice';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Invoice-${slug}-${invoiceNumber.trim()}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setPdfError(`Couldn't generate the PDF: ${(err as Error)?.message ?? 'unknown error'}`);
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <>
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="bottom" className="rounded-t-2xl p-0" showCloseButton={false}>
        <div className="h-auto max-h-[92vh] md:h-full md:max-h-none flex flex-col overflow-hidden">
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
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-3">
            {/* PDF drop zone — drag in an invoice PDF (e.g. one you wrote
                in Word/Pages/your accounting tool) to auto-fill the form
                below. Hidden in edit mode since the form is already
                populated with the existing invoice's data. */}
            {!isEdit && (
              <div
                onDragEnter={onDragEnter}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
              >
                <label
                  className={cn(
                    'flex items-center justify-center gap-2 px-3 h-12 rounded-lg border-2 border-dashed cursor-pointer transition-colors text-sm',
                    extractBusy && 'cursor-wait opacity-60',
                    dragOver
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'border-input bg-muted/30 hover:bg-muted/50 text-muted-foreground',
                  )}
                >
                  <Upload
                    size={15}
                    className={cn(dragOver ? 'text-primary' : 'text-muted-foreground')}
                    strokeWidth={1.8}
                  />
                  <span className="font-medium">
                    {dragOver
                      ? 'Drop invoice PDF'
                      : extractBusy
                        ? extractBusyLabel
                        : 'Drop invoice PDF to auto-fill'}
                  </span>
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    disabled={extractBusy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleExtractFile(f);
                      e.target.value = '';
                    }}
                  />
                </label>

                {/* Success banner with Undo. Only shown for the most recent
                    extraction; user can dismiss by undoing or by editing
                    any field (we don't auto-clear, so the affordance stays
                    discoverable for as long as it's useful). */}
                {extractStage === 'done' && undoSnapshot && (
                  <div className="mt-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-[11px]">
                    <span className="text-emerald-800 flex-1">
                      Filled {filledCount} field{filledCount === 1 ? '' : 's'} from PDF — check and edit if needed.
                    </span>
                    <button
                      type="button"
                      onClick={undoExtract}
                      className="inline-flex items-center gap-1 text-emerald-800 hover:text-emerald-900 font-medium"
                    >
                      <Undo2 size={11} strokeWidth={2.2} />
                      Undo
                    </button>
                  </div>
                )}

                {/* Error banner */}
                {extractStage === 'error' && extractMsg && (
                  <p className="mt-2 text-[11px] px-3 py-1.5 rounded-lg bg-red-50 text-red-700 border border-red-200">
                    {extractMsg}
                  </p>
                )}
              </div>
            )}

            {/* Kind picker — Deposit / Final / Progress */}
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">
                Invoice type
              </label>
              <div className="flex gap-2">
                <KindButton label="Deposit" value="deposit" current={kind} onClick={() => handleKindChange('deposit')} disabled={hasDeposit} />
                <KindButton label="Final"   value="final"   current={kind} onClick={() => handleKindChange('final')} disabled={hasFinal} />
                <KindButton label="Progress" value="progress" current={kind} onClick={() => handleKindChange('progress')} />
              </div>
              {hasDeposit && kind === 'deposit' && (
                <p className="mt-1 text-[10px] text-amber-600">A deposit invoice already exists.</p>
              )}
              {hasFinal && kind === 'final' && (
                <p className="mt-1 text-[10px] text-amber-600">A final invoice already exists. Saving will create another.</p>
              )}
            </div>

            {!invoice?.paid && invoice?.status !== 'void' && (
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Invoice status
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setInvoiceStatus('draft')}
                    className={cn(
                      'h-11 rounded-lg border text-sm font-semibold',
                      invoiceStatus === 'draft'
                        ? 'border-slate-500 bg-slate-100 text-slate-800'
                        : 'border-border bg-background text-muted-foreground',
                    )}
                  >
                    Draft
                  </button>
                  <button
                    type="button"
                    onClick={() => setInvoiceStatus('sent')}
                    className={cn(
                      'h-11 rounded-lg border text-sm font-semibold',
                      invoiceStatus === 'sent'
                        ? 'border-blue-500 bg-blue-50 text-blue-800'
                        : 'border-border bg-background text-muted-foreground',
                    )}
                  >
                    Sent to client
                  </button>
                </div>
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  Drafts stay out of GST and money owing until you mark them sent.
                </p>
              </div>
            )}

            {invoice?.paid && (
              <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm font-medium text-green-800">
                Paid {invoice.paidDate ? `on ${invoice.paidDate}` : ''}. Use “Correct payment” on the invoice row if this was a mistake.
              </div>
            )}

            {invoice?.status === 'void' && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                This invoice is void and kept only for the audit trail{invoice.voidReason ? `: ${invoice.voidReason}` : '.'}
              </div>
            )}

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
                  onChange={(e) => handleInvoiceDateChange(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            {!invoice?.paid && invoice?.status !== 'void' && invoiceStatus === 'sent' && (
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">
                  Payment due
                </label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}

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

            {!invoice?.paid && invoice?.status !== 'void' && (
              <label className="flex min-h-11 items-center gap-2.5 cursor-pointer p-3 rounded-xl border border-border bg-muted/30">
                <input
                  type="checkbox"
                  checked={markPaid}
                  onChange={(e) => setMarkPaid(e.target.checked)}
                  className="h-5 w-5 accent-primary"
                />
                <span className="text-sm font-medium text-foreground flex-1">Payment has already arrived</span>
              </label>
            )}
            {!invoice?.paid && invoice?.status !== 'void' && markPaid && (
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
                  The invoice and {fmt(inclGst)} income record are saved together.
                </p>
              </div>
            )}

            {isEdit && !invoice.paid && invoice.status !== 'void' && (
              <div className="border-t border-border pt-3">
                {!showVoidConfirm ? (
                  <button
                    type="button"
                    onClick={() => setShowVoidConfirm(true)}
                    className="min-h-11 w-full text-sm font-medium text-muted-foreground"
                  >
                    Void this invoice
                  </button>
                ) : (
                  <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
                    <p className="text-xs text-amber-900">Void invoices stay in the history but no longer count as billed or owing.</p>
                    <input
                      value={voidReason}
                      onChange={(e) => setVoidReason(e.target.value)}
                      placeholder="Reason, optional"
                      className="h-11 w-full rounded-lg border border-amber-300 bg-white px-3 text-sm"
                    />
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setShowVoidConfirm(false)} className="h-11 flex-1 rounded-lg border border-amber-300 bg-white text-sm font-medium">Cancel</button>
                      <button type="button" onClick={() => void handleVoid()} disabled={submitting} className="h-11 flex-1 rounded-lg bg-amber-700 text-sm font-semibold text-white disabled:opacity-60">
                        {submitting ? 'Voiding…' : 'Confirm void'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="shrink-0 px-4 py-3 border-t border-border bg-card flex flex-col gap-2">
            {(pdfError || saveError) && (
              <p className="text-[11px] px-3 py-1.5 rounded-lg bg-red-50 text-red-700 border border-red-200">
                {pdfError ?? saveError}
              </p>
            )}
            <Button
              variant="outline"
              className="w-full"
              onClick={handleDownloadPdf}
              disabled={pdfBusy || !invoiceNumber.trim()}
            >
              <Download size={15} strokeWidth={1.8} className="mr-1.5" />
              {pdfBusy ? 'Generating PDF…' : 'Download invoice PDF'}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={onClose} disabled={submitting}>
                {invoice?.status === 'void' ? 'Close' : 'Cancel'}
              </Button>
              {invoice?.status !== 'void' && (
                <Button className={cn('flex-1 bg-primary')} onClick={handleSave} disabled={!canSave}>
                  {isEdit
                    ? (markPaid && !invoice.paid ? 'Save & mark paid' : 'Save changes')
                    : (markPaid ? 'Save & mark paid' : invoiceStatus === 'draft' ? 'Save draft' : 'Save invoice')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>

    {/* "No hours on this job" quick-add — opens after Save & mark paid when
        the job has zero hours logged. Sibling of the main Sheet so it can
        show after that sheet has closed. */}
    <LogHoursPrompt jobId={hoursPromptJobId} onClose={() => setHoursPromptJobId(null)} />
    </>
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
