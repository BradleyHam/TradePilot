'use client';

// Drop a PDF/photo onto a bill that has NO line items (e.g. a backfilled
// bill created from an email summary) to read its items in. We parse the
// document (text or vision), upload it, and MERGE the line items into the
// bill's existing parser_raw — we do NOT create a new entry and we do NOT
// touch the trusted amount. Once items land, the row re-renders with the
// per-line job pickers so the bill can be split.

import { useCallback, useState } from 'react';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { parseBillFile, uploadBillDocument } from '@/lib/parse-bill-file';
import type { Entry } from '@/lib/types';
import { Upload, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

export function BillItemsAttacher({ draft }: { draft: Entry }) {
  const { businessId, updateEntry } = useStore();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(async (file: File) => {
    setMessage(null);
    if (!businessId) { setMessage('No business loaded yet — try again in a moment.'); return; }
    if (draft.id.startsWith('ent_')) { setMessage('Still saving this bill — give it a moment.'); return; }

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) { setMessage('Not signed in — refresh and try again.'); return; }

    setBusy(true);
    try {
      const res = await parseBillFile(file, token);
      if (!res.ok) { setMessage(res.message); return; }
      const items = res.result.parsed.lineItems ?? [];
      if (items.length === 0) {
        setMessage('Read the document, but couldn\'t find line items on it.');
        return;
      }
      // Upload the doc (best-effort); keep any existing attachment if it fails.
      const billPdfUrl = (await uploadBillDocument(res.result.fileToStore, businessId)) ?? draft.billPdfUrl;
      const existingRaw = (draft.parserRaw && typeof draft.parserRaw === 'object')
        ? (draft.parserRaw as Record<string, unknown>) : {};
      // Merge ONLY the line items (+ attach the doc). Amount/GST stay as-is.
      updateEntry(draft.id, {
        billPdfUrl,
        parserRaw: { ...existingRaw, lineItems: items },
      });
      // On success the bill now has items, so this attacher unmounts and the
      // per-line split UI takes over.
    } finally {
      setBusy(false);
    }
  }, [businessId, draft.id, draft.billPdfUrl, draft.parserRaw, updateEntry]);

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
        No line items yet
      </p>
      <label
        onDragEnter={(e) => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setDragOver(true); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f && !busy) void handleFile(f);
        }}
        className={cn(
          'flex items-center justify-center gap-2 px-3 h-12 rounded-lg border-2 border-dashed cursor-pointer transition-colors text-xs',
          busy && 'cursor-wait opacity-60',
          dragOver
            ? 'border-primary bg-primary/5 text-foreground'
            : 'border-input bg-muted/30 hover:bg-muted/50 text-muted-foreground',
        )}
      >
        {busy ? (
          <><Sparkles size={13} className="text-primary animate-pulse" strokeWidth={1.8} /> Reading items…</>
        ) : (
          <><Upload size={13} strokeWidth={1.8} /> Add the bill&apos;s PDF or photo to read &amp; split its items</>
        )}
        <input
          type="file"
          accept="application/pdf,.pdf,image/*"
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
        <p className="text-[11px] px-2 py-1.5 rounded-md bg-red-50 text-red-700 border border-red-200">
          {message}
        </p>
      )}
    </div>
  );
}
