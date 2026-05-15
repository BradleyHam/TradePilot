'use client';

// Upload a supplier bill PDF -> extract text -> LLM parse -> draft entry.
//
// Orchestration (sequential, each fails loud):
//   1. User picks / drops PDF. Validate type + size.
//   2. extractPdfText() in the browser. Confirms it's a text PDF (not an
//      image-only scan with no text layer).
//   3. POST /api/parse-bill with Authorization: Bearer <supabase token>.
//      Returns ParsedBill or an error.
//   4. Upload original PDF to bill-pdfs/{businessId}/{uuid}.pdf. Persist
//      the OBJECT PATH (not signed URL — URLs expire).
//   5. rankJobs(parsed.jobHint) to fuzzy-match a job; pre-fill jobId only
//      if top result is 'active-match' tier AND score >= 10. Otherwise
//      leave unallocated so Brad picks on confirm.
//   6. addEntry({ type: 'bill', isDraft: true, billPdfUrl, parserConfidence,
//      parserRaw, ...mapped fields }). Store handles optimistic insert +
//      rollback.
//   7. Navigate to /home so Brad lands on the Bills-to-confirm flag.
//
// Failure handling:
//   - PDF text extract fails (corrupt/encrypted/scan-only) → message, abort.
//   - Parse fails → message, abort (no entry, no upload).
//   - PDF upload fails AFTER successful parse → still create the draft with
//     billPdfUrl=null and surface a warning toast on Home so Brad can re-
//     attach. The parsed fields are valuable.
//   - addEntry fails → delete the just-uploaded PDF from Storage (best
//     effort) so we don't leave orphan files.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { extractPdfText } from '@/lib/pdf/extract-text';
import { rankJobs } from '@/lib/job-match';
import { inferDueDate, type DueDateSource } from '@/lib/bill-due-date';
import type { Entry, ParsedBill } from '@/lib/types';
import { Upload, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

// Tier + score threshold for auto-pre-filling jobId. Higher than the
// default "show but don't trust" floor — we'd rather leave a draft
// unallocated than pre-fill the wrong job (Brad would have to spot and
// correct it before confirming, which is fragile).
const JOB_MATCH_MIN_SCORE = 10;

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB — corporate invoices, plenty

type Stage =
  | 'idle'
  | 'extracting'
  | 'parsing'
  | 'uploading'
  | 'saving'
  | 'done'
  | 'error';

export function BillPdfUploadCard() {
  const { jobs, addEntry, businessId } = useStore();
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  const handleFile = useCallback(async (file: File) => {
    setMessage(null);

    // ── 1. Validate file ──────────────────────────────────────────────
    if (file.size === 0) {
      setStage('error');
      setMessage('File is empty.');
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setStage('error');
      setMessage(`PDF too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 10MB.`);
      return;
    }
    if (file.type && file.type !== 'application/pdf') {
      setStage('error');
      setMessage('Not a PDF file.');
      return;
    }
    if (!businessId) {
      setStage('error');
      setMessage('No business loaded yet — wait a moment and try again.');
      return;
    }

    // ── 2. Extract text ───────────────────────────────────────────────
    setStage('extracting');
    let extracted: Awaited<ReturnType<typeof extractPdfText>>;
    try {
      extracted = await extractPdfText(file);
    } catch (err) {
      console.error('[bill-upload] PDF text extract failed:', err);
      setStage('error');
      setMessage('Couldn\'t read this PDF — it may be an image-only scan or password-protected.');
      return;
    }
    if (extracted.text.trim().length < 20) {
      setStage('error');
      setMessage('No readable text in this PDF — image-only scans aren\'t supported yet.');
      return;
    }

    // ── 3. POST /api/parse-bill ───────────────────────────────────────
    setStage('parsing');
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setStage('error');
      setMessage('Not signed in — please refresh and sign in again.');
      return;
    }
    let parsed: ParsedBill;
    try {
      const res = await fetch('/api/parse-bill', {
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
        setStage('error');
        setMessage(`Parser failed: ${detail}`);
        return;
      }
      parsed = json.parsed as ParsedBill;
    } catch (err) {
      console.error('[bill-upload] parse request failed:', err);
      setStage('error');
      setMessage('Couldn\'t reach the parser. Check your connection and try again.');
      return;
    }

    // ── 4. Upload PDF to Storage ──────────────────────────────────────
    setStage('uploading');
    const uuid = crypto.randomUUID();
    const objectPath = `${businessId}/${uuid}.pdf`;
    let billPdfUrl: string | undefined;
    try {
      const { error: uploadErr } = await supabase.storage
        .from('bill-pdfs')
        .upload(objectPath, file, {
          contentType: 'application/pdf',
          cacheControl: '3600',
          upsert: false,
        });
      if (uploadErr) {
        // Don't abort — the parsed fields are still useful. Continue
        // without an attached PDF and surface a warning on the draft.
        console.warn('[bill-upload] Storage upload failed; continuing without PDF:', uploadErr);
        setMessage('Note: PDF couldn\'t be attached — bill drafted anyway. You can re-attach later.');
      } else {
        billPdfUrl = objectPath;
      }
    } catch (err) {
      console.warn('[bill-upload] Storage upload threw:', err);
      setMessage('Note: PDF couldn\'t be attached — bill drafted anyway.');
    }

    // ── 5. Job-guess via rankJobs ─────────────────────────────────────
    let guessedJobId: string | undefined;
    if (parsed.jobHint) {
      const ranked = rankJobs(jobs, parsed.jobHint);
      const top = ranked[0];
      if (top && top.tier === 'active-match' && top.score >= JOB_MATCH_MIN_SCORE) {
        guessedJobId = top.job.id;
      }
    }

    // ── 6. Create the draft entry ─────────────────────────────────────
    // Due-date resolution: prefer the date printed on the PDF. If the PDF
    // doesn't have one but we know the invoice date, fall back to the NZ
    // trade-standard "20th of the following month" rule. Mark the source
    // in parserRaw so the confirm UI can show "(from PDF)" vs "(computed)"
    // and Brad spots a wrong inference before it lands in the books.
    let resolvedDueDate: string | undefined;
    let dueDateSource: DueDateSource | undefined;
    if (parsed.dueDate) {
      resolvedDueDate = parsed.dueDate;
      dueDateSource = 'pdf';
    } else if (parsed.invoiceDate) {
      const inferred = inferDueDate(parsed.invoiceDate);
      if (inferred) {
        resolvedDueDate = inferred;
        dueDateSource = 'computed';
      }
    }
    // If neither is available, dueDate stays undefined — Brad sets it
    // manually on the confirm row (Phase 2 will surface an editable field).

    setStage('saving');
    const tempId = `ent_${Date.now()}`;
    const draft: Entry = {
      id: tempId,
      businessId,
      jobId: guessedJobId,
      type: 'bill',
      isDraft: true,
      billPdfUrl,
      parserConfidence: parsed.confidence,
      // Augment the raw parser blob with our locally-derived metadata so
      // the home-screen draft row can render provenance ("from PDF" vs
      // "computed") without needing a new column.
      parserRaw: { ...parsed, dueDateSource },
      // Bill fields mapped from the parsed payload.
      company: parsed.supplier,
      supplier: parsed.supplier,
      description: buildDescription(parsed),
      amount: parsed.totalInclGst,
      amountExGst: parsed.amountExGst,
      gstComponent: parsed.gstComponent,
      gstApplies: true, // Phase 1: assume every bill has 15% GST.
      paid: false,
      // entryDate = invoice issue date if known, else today. Bills are
      // ordered by entryDate elsewhere so this matters for listing.
      entryDate: parsed.invoiceDate ?? new Date().toISOString().slice(0, 10),
      dueDate: resolvedDueDate,
      paymentRef: parsed.invoiceNumber,
      createdAt: new Date().toISOString(),
    };

    try {
      addEntry(draft);
    } catch (err) {
      console.error('[bill-upload] addEntry threw synchronously:', err);
      setStage('error');
      setMessage('Couldn\'t save the draft. Try again.');
      // Best-effort: delete the uploaded PDF if we got one.
      if (billPdfUrl) {
        void supabase.storage.from('bill-pdfs').remove([billPdfUrl]).catch(() => {});
      }
      return;
    }

    // ── 7. Done — route to Home so Brad sees the Bills-to-confirm flag.
    setStage('done');
    router.push('/home');
  }, [businessId, jobs, addEntry, router]);

  // ── Drag-and-drop wiring (mirrors BankUploadCard's pattern) ──────────────
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-bill-drop-zone]')) return;
      e.preventDefault();
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current += 1;
    if (e.dataTransfer.types.includes('Files')) setDragOver(true);
  }
  function onDragOver(e: React.DragEvent) {
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
    if (file) void handleFile(file);
  }

  const busy = stage === 'extracting' || stage === 'parsing'
    || stage === 'uploading' || stage === 'saving';
  const busyLabel = stage === 'extracting' ? 'Reading PDF…'
    : stage === 'parsing'   ? 'Parsing bill…'
    : stage === 'uploading' ? 'Saving PDF…'
    : stage === 'saving'    ? 'Creating draft…'
    : null;

  return (
    <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-orange-50 flex items-center justify-center">
          <FileText size={14} className="text-orange-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">Upload supplier bill</p>
          <p className="text-[11px] text-muted-foreground">
            PDF only. Lands as a draft on Home for you to confirm.
          </p>
        </div>
        {busy && <p className="text-[11px] text-muted-foreground">{busyLabel}</p>}
      </div>

      <label
        data-bill-drop-zone
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          'flex items-center justify-center gap-2 px-3 h-14 rounded-lg border-2 border-dashed cursor-pointer transition-colors text-sm',
          busy && 'cursor-wait opacity-60',
          dragOver
            ? 'border-primary bg-primary/5 text-foreground'
            : 'border-input bg-muted/30 hover:bg-muted/50 text-muted-foreground',
        )}
      >
        <Upload
          size={16}
          className={cn(dragOver ? 'text-primary' : 'text-muted-foreground')}
          strokeWidth={1.8}
        />
        <span className="font-medium">
          {dragOver ? 'Drop bill PDF' : busy ? busyLabel : 'Drop PDF or tap to choose'}
        </span>
        <input
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = '';
          }}
        />
      </label>

      {message && (
        <p className={cn(
          'text-xs px-3 py-2 rounded-lg',
          stage === 'error'
            ? 'bg-red-50 text-red-700 border border-red-200'
            : 'bg-amber-50 text-amber-800 border border-amber-200',
        )}>
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * Build a sensible Entry.description from the parsed fields. The bill
 * lists everywhere display this so it needs to be human-readable — falling
 * back through supplier → invoice number → generic "Bill".
 */
function buildDescription(p: ParsedBill): string {
  const parts: string[] = [];
  if (p.supplier) parts.push(p.supplier);
  if (p.invoiceNumber) parts.push(`#${p.invoiceNumber}`);
  if (parts.length === 0) parts.push('Bill');
  return parts.join(' ');
}
