'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import { parseBnzCsv } from '@/lib/bank-csv';
import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BankUploadCardProps {
  /** When true, renders without the outer card chrome (useful when this is
   *  embedded inside another section that already has a card around it). */
  bare?: boolean;
  /** Compact = smaller intro copy, smaller drop zone. Used on the Entry tab
   *  where the reconcile UI is one of many sections fighting for space. */
  compact?: boolean;
  /** Called after a successful import. The page can use it to auto-scroll
   *  to the pending list, flash a banner, etc. */
  onImported?: (summary: { inserted: number; skipped: number; errors: number }) => void;
}

export function BankUploadCard({ bare, compact, onImported }: BankUploadCardProps) {
  const { importBankTransactions } = useStore();
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Track depth so dragenter on a child doesn't get cancelled by dragleave on
  // its parent. Standard HTML5 drag-leave fix.
  const dragDepth = useRef(0);

  const handleFile = useCallback(async (file: File) => {
    setImporting(true);
    setImportMessage(null);
    try {
      // Loose extension check — better to attempt the parse and let the BNZ
      // detector reject than refuse a valid file with a weird name.
      if (file.size === 0) {
        setImportMessage('File is empty.');
        setImporting(false);
        return;
      }
      const text = await file.text();
      const result = parseBnzCsv(text);
      if (result.bank !== 'bnz') {
        setImportMessage(
          `Couldn't recognise the CSV format. Expected BNZ. ` +
          (result.errors[0]?.message ?? '')
        );
        setImporting(false);
        return;
      }
      const txns = result.rows.map((r) => ({
        ...r,
        status: 'unreconciled' as const,
      }));
      const { inserted, skipped } = await importBankTransactions(txns);
      const errs = result.errors.length;
      setImportMessage(
        `Imported ${inserted} new transaction${inserted !== 1 ? 's' : ''}` +
        (skipped > 0 ? ` · ${skipped} already imported` : '') +
        (errs > 0 ? ` · ${errs} parse error${errs !== 1 ? 's' : ''}` : '')
      );
      onImported?.({ inserted, skipped, errors: errs });
    } catch (err) {
      console.error('Import failed:', err);
      setImportMessage(
        err instanceof Error ? `Import failed: ${err.message}` : 'Import failed'
      );
    } finally {
      setImporting(false);
    }
  }, [importBankTransactions, onImported]);

  // ── Drag-and-drop wiring ─────────────────────────────────────────────────
  // Only the drop zone itself should accept drops, but we also want to
  // suppress the browser's default behaviour of opening the file in the tab
  // if the user misses the drop zone — otherwise an off-target drop wipes
  // out their session. We do that with window-level dragover/drop listeners
  // that just preventDefault() if the dragged item isn't over our zone.

  useEffect(() => {
    const swallow = (e: DragEvent) => {
      // Prevent the browser from navigating to the file when dropped outside
      // the drop zone. Don't swallow drops onto child inputs etc.
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-bank-drop-zone]')) return;
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
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true);
    }
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
    if (!file) return;
    void handleFile(file);
  }

  const intro = (
    <>
      <div className="flex items-center justify-between mb-2">
        <p className={cn('font-semibold text-foreground', compact ? 'text-xs' : 'text-sm')}>
          Import BNZ CSV
        </p>
        {importing && (
          <p className="text-[11px] text-muted-foreground">Importing…</p>
        )}
      </div>
      {!compact && (
        <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
          In BNZ internet banking → your account → Export as CSV. Drop the file here
          or tap to choose. Re-importing the same file is safe — duplicates are skipped.
        </p>
      )}
    </>
  );

  const dropZone = (
    <label
      data-bank-drop-zone
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'flex items-center justify-center gap-2 px-3 rounded-lg border-2 border-dashed cursor-pointer transition-colors text-sm',
        compact ? 'h-12' : 'h-14',
        dragOver
          ? 'border-primary bg-primary/5 text-foreground'
          : 'border-input bg-muted/30 hover:bg-muted/50 text-muted-foreground',
      )}
    >
      <Upload size={16} className={cn(dragOver ? 'text-primary' : 'text-muted-foreground')} strokeWidth={1.8} />
      <span className="font-medium">
        {dragOver ? 'Drop CSV to import' : 'Drop CSV or tap to choose'}
      </span>
      <input
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
    </label>
  );

  const message = importMessage && (
    <p className={cn(
      'mt-2 text-xs px-3 py-2 rounded-lg',
      importMessage.startsWith('Imported')
        ? 'bg-green-50 text-green-700 border border-green-200'
        : 'bg-amber-50 text-amber-800 border border-amber-200',
    )}>
      {importMessage}
    </p>
  );

  if (bare) {
    return (
      <div>
        {intro}
        {dropZone}
        {message}
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      {intro}
      {dropZone}
      {message}
    </div>
  );
}
