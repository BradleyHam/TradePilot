'use client';

// Review-and-send screen for the deposit invoice.
//
// Opened from the "Invoice them now?" prompt when a job is marked accepted
// (and reusable anywhere a deposit needs sending). It:
//   1. Renders a live PDF preview of the deposit invoice (same branded doc
//      as the Download button), so Brad can eyeball it looks right.
//   2. Shows the deposit figures (editable amount/number/date) and an
//      editable email draft to the client.
//   3. "Save & open Gmail" records the invoice as sent, downloads
//      the PDF, and opens Gmail pre-filled — Brad attaches the PDF + sends.
//
// Why download-then-attach rather than a true in-app send: a Gmail compose
// link can pre-fill to/subject/body but can't attach a file. Full Gmail-API
// sending was deliberately deferred (needs OAuth setup) — see the chat.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Invoice, Job } from '@/lib/types';
import { useStore } from '@/lib/store';
import { defaultInvoiceDueDate } from '@/lib/invoice-lifecycle';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Download, Mail, FileText, Loader2 } from 'lucide-react';
import { gmailComposeUrl } from '@/lib/utils';
import { depositDefaultsFor, buildInvoicePdfData, fmtMoney2 } from '@/lib/invoice-pdf-data';

const NZ_GST_RATE = 0.15;
const round2 = (n: number) => Math.round(n * 100) / 100;

interface Props {
  job: Job | null;
  open: boolean;
  onClose: () => void;
}

export function InvoiceReviewSheet({ job, open, onClose }: Props) {
  const { invoices, quotes, addInvoice, updateInvoice, updateJob, getQuoteTemplate, resolveLogoUrl, businessId } = useStore();

  // Editable invoice fields
  const [amountStr, setAmountStr] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(''); // ISO yyyy-mm-dd
  const [dueDate, setDueDate] = useState('');
  // Editable email draft
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  // Preview + status
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blobRef = useRef<Blob | null>(null);
  const urlRef = useRef<string | null>(null);
  const createdRef = useRef<Invoice | null>(null); // guard against creating the invoice twice

  const jobQuote = useMemo(
    () => (job ? quotes.find((q) => q.jobId === job.id) : undefined),
    [quotes, job],
  );

  // Initialise the form + email draft when the sheet opens for a job.
  useEffect(() => {
    if (!open || !job) return;
    const tpl = getQuoteTemplate();
    const d = depositDefaultsFor(job, tpl);
    setAmountStr(d.amountExGst.toFixed(2));
    setInvoiceNumber(d.invoiceNumber);
    setInvoiceDate(d.invoiceDateISO);
    setDueDate(defaultInvoiceDueDate(d.invoiceDateISO, 'deposit', tpl?.paymentTerms?.depositDueDays ?? 0));
    createdRef.current = null;
    setError(null);

    const biz = tpl?.header.businessName || 'Lakeside Painting';
    const first = (job.clientName || '').trim().split(/\s+/)[0] || 'there';
    const proj = job.location || job.name;
    setEmailTo(job.clientEmail ?? '');
    setEmailSubject(`Deposit invoice ${d.invoiceNumber} — ${biz}`);
    setEmailBody(
      `Hi ${first},\n\n`
      + `Thanks for confirming the painting work${proj ? ` at ${proj}` : ''}.\n\n`
      + `Attached is your deposit invoice (${d.invoiceNumber}) for ${fmtMoney2(d.inclGst)} incl GST, which secures your booking — bank details are on the invoice. Once that's through I'll lock your dates in.\n\n`
      + `Any questions, just reply here.\n\n`
      + `Cheers,\n${biz}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job?.id]);

  // Derived amounts from the editable ex-GST amount.
  const amountExGst = useMemo(() => {
    const n = parseFloat(amountStr.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? round2(n) : 0;
  }, [amountStr]);
  const gst = round2(amountExGst * NZ_GST_RATE);
  const inclGst = round2(amountExGst + gst);

  // (Re)render the PDF preview — debounced so typing in the amount doesn't
  // thrash react-pdf.
  useEffect(() => {
    if (!open || !job) return;
    const tpl = getQuoteTemplate();
    if (!tpl) {
      setError('Set up your quote template first (Settings → Quote template).');
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setPreviewBusy(true);
      setError(null);
      try {
        const d = depositDefaultsFor(job, tpl);
        const balanceInclGst = Math.max(0, round2(d.jobTotalExGst * (1 + NZ_GST_RATE) - inclGst));
        const pdfData = buildInvoicePdfData({
          kind: 'deposit',
          invoiceNumber: invoiceNumber.trim() || d.invoiceNumber,
          invoiceDateISO: invoiceDate || d.invoiceDateISO,
          dueDateISO: dueDate,
          amountExGst, gst, inclGst,
          job, quote: jobQuote, balanceInclGst, depositPercent: d.depositPercent,
        });
        const logoUrl = resolveLogoUrl(tpl.header.logoStoragePath);
        const { pdf } = await import('@react-pdf/renderer');
        const { InvoicePdfDocument } = await import('@/components/invoices/invoice-pdf');
        const blob = await pdf(
          <InvoicePdfDocument template={tpl} job={job} logoUrl={logoUrl} data={pdfData} />,
        ).toBlob();
        if (cancelled) return;
        blobRef.current = blob;
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setPreviewUrl(url);
      } catch (e) {
        if (!cancelled) setError(`Couldn't render the preview: ${(e as Error)?.message ?? 'unknown error'}`);
      } finally {
        if (!cancelled) setPreviewBusy(false);
      }
    }, 450);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job?.id, amountExGst, invoiceNumber, invoiceDate, dueDate]);

  // Revoke the object URL on unmount.
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  if (!job) return null;

  async function ensureInvoiceSaved(status: 'draft' | 'sent'): Promise<boolean> {
    if (!job || !businessId) return false;
    const existing = createdRef.current
      ?? invoices.find((i) => i.jobId === job.id && i.kind === 'deposit' && i.status !== 'void');
    if (existing) {
      if (status === 'sent' && existing.status === 'draft') {
        const result = await updateInvoice(existing.id, {
          status: 'sent', dueDate, sentAt: new Date().toISOString(),
        });
        if (!result.ok) {
          setError(result.error ?? 'Could not mark the invoice sent.');
          return false;
        }
      }
      createdRef.current = { ...existing, status };
      return true;
    }
    const now = new Date().toISOString();
    const created = await addInvoice({
      id: `inv_${Date.now()}`,
      businessId,
      jobId: job.id,
      invoiceNumber: invoiceNumber.trim(),
      invoiceDate,
      status,
      dueDate,
      sentAt: status === 'sent' ? now : undefined,
      kind: 'deposit',
      amountExGst,
      gstApplies: true,
      gstComponent: gst,
      amountInclGst: inclGst,
      paid: false,
      createdAt: now,
      updatedAt: now,
    });
    if (!created) {
      setError('The invoice was not saved. Nothing was sent.');
      return false;
    }
    // invoiceAmount tracks the FULL work value so the job shows its true
    // expected income, not just the deposit slice.
    const fullValue = Math.max(job.invoiceAmount ?? 0, job.quoteAmount ?? 0, amountExGst);
    updateJob(job.id, { invoiceAmount: fullValue });
    createdRef.current = created;
    return true;
  }

  function downloadCurrentPdf() {
    const blob = blobRef.current;
    if (!blob || !job) return;
    const slug = job.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'invoice';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Invoice-${slug}-${invoiceNumber.trim()}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handleSendViaGmail() {
    if (!emailTo.trim()) { setError("Add the client's email address to send."); return; }
    if (!blobRef.current) { setError('Hang on — the invoice is still rendering.'); return; }
    if (!await ensureInvoiceSaved('sent')) return;
    downloadCurrentPdf();
    window.open(gmailComposeUrl(emailTo.trim(), { subject: emailSubject, body: emailBody }), '_blank');
    onClose();
  }

  async function handleDownloadOnly() {
    if (!blobRef.current) return;
    if (!await ensureInvoiceSaved('draft')) return;
    downloadCurrentPdf();
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl p-0" showCloseButton={false}>
        <div className="h-auto max-h-[94vh] md:h-full md:max-h-none flex flex-col overflow-hidden">
          <SheetHeader className="px-4 pt-4 pb-2 shrink-0">
            <SheetTitle className="flex items-center gap-2">
              <FileText size={16} className="text-primary" strokeWidth={2} />
              Review &amp; send deposit invoice
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 space-y-4">
            {/* PDF preview */}
            <div className="rounded-xl border border-border overflow-hidden bg-muted/30">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border/60">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Invoice preview</span>
                {previewBusy && (
                  <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin" /> rendering…
                  </span>
                )}
              </div>
              {previewUrl ? (
                <iframe title="Invoice preview" src={previewUrl} className="w-full h-[440px] bg-white" />
              ) : (
                <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">
                  Generating preview…
                </div>
              )}
            </div>

            {error && (
              <p className="text-[11px] px-3 py-1.5 rounded-lg bg-red-50 text-red-700 border border-red-200">{error}</p>
            )}

            {/* Invoice figures */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (ex GST)" value={amountStr} onChange={setAmountStr} prefix="$" />
              <div className="flex items-end pb-2.5 text-[11px] text-muted-foreground">
                GST {fmtMoney2(gst)} · Total {fmtMoney2(inclGst)}
              </div>
              <Field label="Invoice #" value={invoiceNumber} onChange={setInvoiceNumber} />
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">Invoice date</label>
                <input
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">Payment due</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {/* Email draft */}
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Email to client</p>
              <Field label="To" value={emailTo} onChange={setEmailTo} type="email" placeholder="client@email.com" />
              <Field label="Subject" value={emailSubject} onChange={setEmailSubject} />
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">Message</label>
                <textarea
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  rows={7}
                  className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Gmail opens with this drafted, and the PDF downloads at the same time — drag it into the email, then hit send. (Gmail can&apos;t attach it for you.)
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="shrink-0 px-4 py-3 border-t border-border bg-card flex flex-col gap-2">
            <Button className="w-full bg-primary" onClick={() => void handleSendViaGmail()} disabled={previewBusy || !emailTo.trim()}>
              <Mail size={15} strokeWidth={1.8} className="mr-1.5" />
              Save &amp; open Gmail
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
              <Button variant="outline" className="flex-1" onClick={() => void handleDownloadOnly()} disabled={previewBusy || !previewUrl}>
                <Download size={15} strokeWidth={1.8} className="mr-1.5" />
                Save draft &amp; download
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Small field helper ────────────────────────────────────────────────
function Field({
  label, value, onChange, type = 'text', prefix, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  prefix?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">{label}</label>
      <div className="relative">
        {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">{prefix}</span>}
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full h-10 ${prefix ? 'pl-7' : 'pl-3'} pr-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring`}
        />
      </div>
    </div>
  );
}
