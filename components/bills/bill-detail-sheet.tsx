'use client';

// Tap a bill anywhere on Home → this sheet. Shows everything we know about
// the bill (issue date, invoice number, the PO/job reference printed on it,
// GST split, line items) and — the main event — its job allocation, which
// can be CHANGED after confirmation: move the whole bill to another job,
// or split an amount off to a second job / overhead. Re-allocation goes
// through store.reallocateBill, which replaces the bill_group atomically so
// the slices always sum to the invoice total.
//
// Dulux secure-link bills arrive with correct figures but no line items
// (their PDF is gated behind an account-number check). For those we show
// the "items pending" state: a button to the secure link + the drop-zone
// that merges the downloaded PDF's items in (BillItemsAttacher).
//
// 5:30pm rule: single screen, no wizard. The common case — "this was all
// for the Smith job" — is one select + Save.

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { rankJobs } from '@/lib/job-match';
import type { Entry } from '@/lib/types';
import { ExternalLink, Plus, X, Split, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
// BillItemsAttacher's prop is named `draft` for historical reasons but it
// works on any bill entry — it just merges parsed line items into
// parser_raw via updateEntry, never touching the trusted amount.
import { BillItemsAttacher } from './bill-items-attacher';

interface BillDetailSheetProps {
  /** Any entry id in the bill's group — the sheet resolves the whole group. */
  entryId: string | null;
  open: boolean;
  onClose: () => void;
}

// Same defensive line-item narrowing as the Home confirm row — parserRaw is
// untyped jsonb and the LLM may emit loose JSON.
interface ParsedLineItem {
  description?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  total?: unknown;
}

interface BillParserRaw {
  jobHint?: string;
  dueDateSource?: 'pdf' | 'computed' | 'manual';
  lineItems?: unknown;
  lineItemsPending?: boolean;
  duluxSecureLink?: string;
}

const NZ_GST_RATE = 0.15;
const r2 = (n: number) => Math.round(n * 100) / 100;

function exGstOf(e: Entry): number {
  if (e.amountExGst != null) return e.amountExGst;
  if (e.amount == null) return 0;
  return e.gstApplies ? e.amount / (1 + NZ_GST_RATE) : e.amount;
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' });
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-NZ', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

/** Forgiving amount parse: "$186", "186", "186.00", " 186 " all work. */
function parseAmount(s: string): number | undefined {
  const cleaned = s.replace(/[$,\s]/g, '');
  if (cleaned === '') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function BillDetailSheet({ entryId, open, onClose }: BillDetailSheetProps) {
  const { entries, jobs, reallocateBill, updateEntry } = useStore();

  // Live records from the store — never trust a prop snapshot (stale-prop
  // trap, see AGENTS.md). The sheet re-renders as the store mutates.
  const bill = useMemo(
    () => entries.find((e) => e.id === entryId) ?? null,
    [entries, entryId],
  );
  const group = useMemo<Entry[]>(() => {
    if (!bill) return [];
    if (!bill.billGroupId) return [bill];
    return entries
      .filter((e) => e.type === 'bill' && e.billGroupId === bill.billGroupId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [entries, bill]);
  // Primary = the row carrying parser_raw / the PDF / source_message_id.
  const primary = useMemo<Entry | null>(() => {
    if (group.length === 0) return null;
    return group.find((g) => g.sourceMessageId) ?? group[0];
  }, [group]);

  const parserRaw = (primary?.parserRaw && typeof primary.parserRaw === 'object')
    ? primary.parserRaw as BillParserRaw : null;
  const lineItems: ParsedLineItem[] = useMemo(() => {
    const raw = parserRaw?.lineItems;
    if (!Array.isArray(raw)) return [];
    return raw.filter((li): li is ParsedLineItem =>
      typeof li === 'object' && li !== null && typeof (li as ParsedLineItem).description === 'string');
  }, [parserRaw?.lineItems]);

  const exTotal = r2(group.reduce((s, e) => s + exGstOf(e), 0));
  const grossTotal = r2(group.reduce((s, e) => s + (e.amount ?? 0), 0));
  const gstTotal = r2(grossTotal - exTotal);
  const isPaid = group.length > 0 && group.every((e) => e.paid);

  // ── Allocation editing state ─────────────────────────────────────────────
  // Each editable row = {jobId, text amount}. Row 0 is the REMAINDER row —
  // its amount is derived (total − the others), so the math always balances
  // and Brad only ever types the amount he's splitting OFF.
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<{ jobId: string; amountText: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Mark-paid state (group-aware).
  const [payOpen, setPayOpen] = useState(false);
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));

  const [opening, setOpening] = useState(false);

  const ranked = useMemo(
    () => rankJobs(jobs, parserRaw?.jobHint),
    [jobs, parserRaw?.jobHint],
  );

  if (!bill || !primary) return null;

  const jobName = (jobId: string | undefined | null): string => {
    if (!jobId) return 'Overhead (no job)';
    return jobs.find((j) => j.id === jobId)?.name ?? 'Unknown job';
  };

  function startEditing() {
    // Seed rows from the current allocation: primary first (remainder row),
    // then siblings with their current ex-GST amounts.
    const siblings = group.filter((g) => g.id !== primary!.id);
    setRows([
      { jobId: primary!.jobId ?? '', amountText: '' },
      ...siblings.map((s) => ({ jobId: s.jobId ?? '', amountText: exGstOf(s).toFixed(2) })),
    ]);
    setEditError(null);
    setEditing(true);
  }

  // Derived amounts for the edit view. Row 0 absorbs the remainder.
  const typedSum = rows.slice(1).reduce((s, row) => s + (parseAmount(row.amountText) ?? 0), 0);
  const remainder = r2(exTotal - typedSum);
  const amountsValid = rows.slice(1).every((row) => {
    const n = parseAmount(row.amountText);
    return n !== undefined && n > 0;
  });
  const canSave = amountsValid && remainder >= -0.005;

  async function handleSave() {
    if (!canSave || saving) return;
    // Build slices; drop a zero remainder row (everything was split off).
    const slices: { jobId: string | null; exGst: number }[] = [];
    if (remainder > 0.005) slices.push({ jobId: rows[0].jobId || null, exGst: remainder });
    for (const row of rows.slice(1)) {
      const n = parseAmount(row.amountText);
      if (n !== undefined && n > 0.005) slices.push({ jobId: row.jobId || null, exGst: r2(n) });
    }
    if (slices.length === 0) { setEditError('Nothing left allocated.'); return; }
    setSaving(true);
    setEditError(null);
    try {
      const res = await reallocateBill(primary!.id, slices);
      if (!res.ok) {
        setEditError(res.error ?? 'Couldn’t save the allocation — try again.');
        return;
      }
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function handleMarkPaid() {
    // Flip the whole group together — a split bill is never half-paid.
    for (const e of group) updateEntry(e.id, { paid: true, paidDate: payDate });
    setPayOpen(false);
  }

  async function handleViewPdf() {
    if (!primary?.billPdfUrl) return;
    setOpening(true);
    try {
      const { data, error } = await supabase.storage
        .from('bill-pdfs')
        .createSignedUrl(primary.billPdfUrl, 300);
      if (error || !data) {
        console.error('[bill-detail] Failed to sign PDF URL:', error);
        alert('Couldn’t open the PDF — please try again.');
        return;
      }
      window.open(data.signedUrl, '_blank', 'noopener');
    } finally {
      setOpening(false);
    }
  }

  const lineCost = (li: ParsedLineItem): number | undefined => {
    if (typeof li.total === 'number' && Number.isFinite(li.total)) return li.total;
    if (typeof li.quantity === 'number' && typeof li.unitPrice === 'number') {
      return li.quantity * li.unitPrice;
    }
    return undefined;
  };

  const itemsPending = lineItems.length === 0 && parserRaw?.lineItemsPending === true;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) { setEditing(false); setPayOpen(false); onClose(); } }}>
      <SheetContent side="bottom" className="rounded-t-2xl p-0">
        <div className="max-h-[88dvh] flex flex-col overflow-hidden">
          {/* Header */}
          <SheetHeader className="shrink-0 px-4 pt-4 pb-3 border-b border-border text-left space-y-0">
            <div className="flex items-start justify-between gap-3 pr-8">
              <div className="min-w-0">
                <SheetTitle className="text-base font-bold leading-tight truncate">
                  {bill.company ?? bill.supplier ?? 'Bill'}
                </SheetTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {bill.paymentRef ? `#${bill.paymentRef}` : 'No invoice number'}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-base font-bold tabular-nums">{fmtMoney(exTotal)}</p>
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  ex-GST · {fmtMoney(grossTotal)} incl
                </p>
              </div>
            </div>
          </SheetHeader>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            {/* Facts */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Issued</p>
                <p>{fmtDate(bill.entryDate)}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Due</p>
                <p>
                  {fmtDate(bill.dueDate)}
                  {parserRaw?.dueDateSource === 'computed' && (
                    <span className="text-[11px] text-amber-700"> (computed)</span>
                  )}
                </p>
              </div>
              {parserRaw?.jobHint && (
                <div className="col-span-2">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Reference on the bill
                  </p>
                  <p className="truncate" title={parserRaw.jobHint}>{parserRaw.jobHint}</p>
                </div>
              )}
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">GST</p>
                <p className="tabular-nums">{fmtMoney(gstTotal)}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Status</p>
                <p>
                  {isPaid
                    ? <span className="text-green-700 font-medium">Paid{bill.paidDate ? ` ${fmtDate(bill.paidDate)}` : ''}</span>
                    : <span className="text-amber-700 font-medium">Unpaid</span>}
                </p>
              </div>
            </div>

            {/* Allocation */}
            <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {group.length > 1 ? `Split across ${group.length} buckets` : 'Allocated to'}
                </p>
                {!editing && (
                  <button
                    type="button"
                    onClick={startEditing}
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline min-h-[44px] px-1"
                  >
                    <Pencil size={12} strokeWidth={2} />
                    Change
                  </button>
                )}
              </div>

              {!editing && (
                <ul className="space-y-1">
                  {group.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className={cn('truncate', !e.jobId && 'text-muted-foreground')}>
                        {jobName(e.jobId)}
                      </span>
                      <span className="tabular-nums text-muted-foreground shrink-0">
                        {fmtMoney(exGstOf(e))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {editing && (
                <div className="space-y-2">
                  {rows.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select
                        value={row.jobId}
                        onChange={(ev) => setRows((prev) =>
                          prev.map((r, j) => j === i ? { ...r, jobId: ev.target.value } : r))}
                        className="flex-1 min-w-0 h-11 px-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        aria-label={`Allocation ${i + 1} job`}
                      >
                        <option value="">Overhead (no job)</option>
                        {ranked.map(({ job, tier }) => (
                          <option key={job.id} value={job.id}>
                            {tier === 'active-match' ? '★ ' : ''}
                            {job.name}
                            {job.clientName ? ` — ${job.clientName}` : ''}
                          </option>
                        ))}
                      </select>
                      {i === 0 ? (
                        // Remainder row — derived, so the split always balances.
                        <span className={cn(
                          'w-20 text-right text-sm tabular-nums shrink-0',
                          remainder < -0.005 ? 'text-red-600 font-semibold' : 'text-muted-foreground',
                        )}>
                          {fmtMoney(Math.max(remainder, 0))}
                        </span>
                      ) : (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={row.amountText}
                          placeholder="0.00"
                          onChange={(ev) => setRows((prev) =>
                            prev.map((r, j) => j === i ? { ...r, amountText: ev.target.value } : r))}
                          className="w-20 h-11 px-2 rounded-lg border border-input bg-background text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-ring shrink-0"
                          aria-label={`Allocation ${i + 1} amount ex-GST`}
                        />
                      )}
                      {i > 0 && (
                        <button
                          type="button"
                          onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                          aria-label="Remove this split"
                          className="w-8 h-11 flex items-center justify-center text-muted-foreground hover:text-red-600 shrink-0"
                        >
                          <X size={14} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={() => setRows((prev) => [...prev, { jobId: '', amountText: '' }])}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline min-h-[44px]"
                  >
                    <Plus size={13} strokeWidth={2} />
                    Split an amount to another job / overhead
                  </button>

                  {remainder < -0.005 && (
                    <p className="text-[11px] text-red-600">
                      Splits add up to more than the bill total ({fmtMoney(exTotal)} ex-GST).
                    </p>
                  )}
                  {editError && (
                    <p className="text-[11px] px-2 py-1.5 rounded-md bg-red-50 text-red-700 border border-red-200">
                      {editError}
                    </p>
                  )}

                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={!canSave || saving}
                      className="flex-1 h-11 rounded-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-semibold transition-colors active:scale-95"
                    >
                      {saving ? 'Saving…' : 'Save allocation'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditing(false); setEditError(null); }}
                      className="h-11 px-4 rounded-full border border-border text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Line items */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                {lineItems.length > 0 ? `Line items · ${lineItems.length}` : 'Line items'}
              </p>
              {lineItems.length > 0 ? (
                <ul className="space-y-1">
                  {lineItems.map((li, i) => {
                    const cost = lineCost(li);
                    return (
                      <li key={i} className="flex items-start justify-between gap-2 text-xs rounded-lg border border-border bg-background px-2.5 py-2">
                        <span className="flex-1 min-w-0 break-words">
                          {String(li.description ?? '—')}
                          {typeof li.quantity === 'number' && li.quantity !== 1 && (
                            <span className="text-muted-foreground"> ×{li.quantity}</span>
                          )}
                        </span>
                        <span className="tabular-nums text-muted-foreground shrink-0">
                          {cost !== undefined ? fmtMoney(cost) : '—'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="space-y-1.5">
                  {itemsPending && parserRaw?.duluxSecureLink && (
                    <a
                      href={parserRaw.duluxSecureLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-3 min-h-[44px] rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-300 text-xs font-medium hover:bg-blue-100 dark:hover:bg-blue-950/50 transition-colors"
                    >
                      <ExternalLink size={13} strokeWidth={1.8} className="shrink-0" />
                      Get the PDF from Dulux&apos;s secure link, then drop it below
                    </a>
                  )}
                  <BillItemsAttacher draft={primary} />
                </div>
              )}
            </div>
          </div>

          {/* Footer actions */}
          <div className="shrink-0 border-t border-border px-4 py-3 flex items-center justify-between gap-2"
            style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}
          >
            {primary.billPdfUrl ? (
              <button
                type="button"
                onClick={handleViewPdf}
                disabled={opening}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-50 min-h-[44px]"
              >
                <ExternalLink size={12} />
                {opening ? 'Opening…' : 'View PDF'}
              </button>
            ) : (
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <Split size={12} className="rotate-90" />
                No PDF attached
              </span>
            )}

            {!isPaid && !payOpen && (
              <button
                type="button"
                onClick={() => setPayOpen(true)}
                className="h-11 px-4 rounded-full bg-green-600 hover:bg-green-700 text-white text-xs font-semibold transition-colors active:scale-95"
              >
                Mark paid
              </button>
            )}
            {!isPaid && payOpen && (
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={payDate}
                  autoFocus
                  onChange={(e) => setPayDate(e.target.value)}
                  className="h-11 px-2 rounded-lg border border-input bg-background text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={handleMarkPaid}
                  className="h-11 px-3 rounded-full bg-green-600 hover:bg-green-700 text-white text-xs font-semibold transition-colors active:scale-95"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setPayOpen(false)}
                  aria-label="Cancel"
                  className="h-11 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
