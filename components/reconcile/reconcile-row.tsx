'use client';

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { classifyBankRow, findMatchingEntry, type Suggestion } from '@/lib/bank-classifier';
import { rankJobs } from '@/lib/job-match';
import type { BankTransaction, Entry, ExpenseCategory } from '@/lib/types';
import { CheckCircle2, ArrowRight, Receipt, DollarSign, Split, Plus, X, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

const fmt = (n: number) =>
  `$${n.toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDateNZ = (iso: string) => {
  if (!iso || iso.length < 10) return iso;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

// ── Single row ──────────────────────────────────────────────────────────────

interface ReconcileRowProps {
  txn: BankTransaction;
  entries: Entry[];
  jobs: ReturnType<typeof useStore>['jobs'];
  onLinkToEntry: (entryId: string) => void;
  onCreateEntry: (entry: Omit<Entry, 'id' | 'businessId' | 'createdAt' | 'bankTransactionId'>) => void;
  /**
   * Called when the user uses the inline splitter to allocate one bank
   * transaction across multiple entries (e.g. a Mitre 10 shop covering
   * two jobs + overhead). The rows are already validated to sum to the
   * bank txn's gross amount.
   */
  onSplitEntries: (entries: Omit<Entry, 'id' | 'businessId' | 'createdAt' | 'bankTransactionId'>[]) => Promise<{ inserted: number; failed: number; error?: string }>;
  /**
   * Called when the user settles one or more already-confirmed bills against
   * this single bank payment (the "I paid 3 Trademax invoices at once" case).
   * Marks each selected bill paid on the payment date and links it to the
   * bank txn. The payment date is supplied by this component (txn.txnDate).
   */
  onMatchBills: (billEntryIds: string[], paidDate: string) => Promise<{ updated: number; failed: number; error?: string }>;
  onIgnore: () => void;
  onMarkPersonal: () => void;
}

export function ReconcileRow({
  txn, entries, jobs,
  onLinkToEntry, onCreateEntry, onSplitEntries, onMatchBills, onIgnore, onMarkPersonal,
}: ReconcileRowProps) {
  const isCredit = txn.amount > 0;

  // Suggestions
  const suggestion = useMemo(
    () => classifyBankRow(txn, { entries }),
    [txn, entries],
  );
  const matchingEntry = useMemo(
    () => findMatchingEntry(txn, entries),
    [txn, entries],
  );

  // Confirmed-but-unpaid bills available to settle against this payment.
  // (type 'bill', confirmed, not yet paid, not yet linked to a bank txn,
  // with a real amount.) Drives whether we show the "Match to bills"
  // affordance — no point offering it when there's nothing to match.
  const unpaidBills = useMemo(
    () => entries.filter(
      (e) => e.type === 'bill' && !e.isDraft && !e.paid && !e.bankTransactionId && (e.amount ?? 0) > 0,
    ),
    [entries],
  );

  // For "create new entry" we need a job picker + GST toggle
  const [showCreateForm, setShowCreateForm] = useState(false);
  // Splitter mode — replaces the single-entry form when the user wants
  // to allocate one bank txn across multiple entries.
  const [showSplitForm, setShowSplitForm] = useState(false);
  // Bill-match mode — settle several already-uploaded bills against this
  // one payment (the "paid 3–4 invoices at once" case). Debits only.
  const [showBillMatch, setShowBillMatch] = useState(false);

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 p-3.5">
        <div className={cn(
          'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
          isCredit ? 'bg-green-50' : 'bg-red-50',
        )}>
          {isCredit
            ? <DollarSign size={16} className="text-green-600" strokeWidth={1.8} />
            : <Receipt size={16} className="text-red-500" strokeWidth={1.8} />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{txn.description}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {fmtDateNZ(txn.txnDate)}
            {txn.tranType && ` · ${txn.tranType}`}
          </p>
        </div>
        <p className={cn(
          'text-base font-bold shrink-0 tabular-nums',
          isCredit ? 'text-green-600' : 'text-foreground',
        )}>
          {isCredit ? '+' : ''}{fmt(txn.amount)}
        </p>
      </div>

      {/* Body — actions */}
      <div className="border-t border-border bg-muted/20 px-3.5 py-3 space-y-2">
        {showBillMatch ? (
          <BillMatchForm
            txn={txn}
            entries={entries}
            jobs={jobs}
            onSubmit={async (billIds) => {
              const result = await onMatchBills(billIds, txn.txnDate);
              if (result.failed > 0) {
                alert(`Couldn't mark bills paid — ${result.error ?? 'see console for details.'}`);
              }
              if (result.updated > 0) {
                // Bank txn flips to matched → parent re-filters and this row
                // unmounts. Defensive close in case it doesn't.
                setShowBillMatch(false);
              }
            }}
            onCancel={() => setShowBillMatch(false)}
          />
        ) : showSplitForm ? (
          <SplitForm
            txn={txn}
            suggestion={suggestion}
            jobs={jobs}
            onSubmit={async (rows) => {
              const result = await onSplitEntries(rows);
              if (result.failed > 0) {
                alert(`${result.inserted} of ${rows.length} entries saved. ${result.failed} failed — see console for details.`);
              }
              if (result.inserted > 0) {
                // Row will unmount because the bank txn flips to matched
                // and the parent re-filters. Defensive close just in case.
                setShowSplitForm(false);
              }
            }}
            onCancel={() => setShowSplitForm(false)}
          />
        ) : suggestion.kind === 'transfer' && !showCreateForm ? (
          // Transfer rows get a one-tap "ignore" — no new entry needed since
          // moving money between your own accounts isn't an expense.
          <TransferSuggestion
            reason={suggestion.reason}
            onIgnore={onIgnore}
            onTreatAsExpense={() => setShowCreateForm(true)}
          />
        ) : matchingEntry && !showCreateForm ? (
          <MatchedSuggestion
            entry={matchingEntry}
            jobs={jobs}
            onConfirm={() => onLinkToEntry(matchingEntry.id)}
            onReject={() => setShowCreateForm(true)}
          />
        ) : (
          <>
            <NewEntryForm
              txn={txn}
              suggestion={suggestion}
              jobs={jobs}
              onSubmit={(entry) => onCreateEntry(entry)}
            />
            {/* Discoverability hooks. Bill-match first (settles invoices
                you've already uploaded against this payment), then the
                manual job splitter. Bill-match only shows for debits with
                unpaid bills waiting — otherwise there's nothing to match. */}
            {!isCredit && unpaidBills.length > 0 && (
              <button
                type="button"
                onClick={() => setShowBillMatch(true)}
                className="w-full text-[11px] font-medium text-primary hover:underline flex items-center justify-center gap-1 h-7"
              >
                <FileText size={11} strokeWidth={2} />
                Match to bills you&apos;ve uploaded ({unpaidBills.length})
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowSplitForm(true)}
              className="w-full text-[11px] font-medium text-primary hover:underline flex items-center justify-center gap-1 h-7"
            >
              <Split size={11} strokeWidth={2} />
              Split this across multiple jobs
            </button>
          </>
        )}
        {/* Bottom-right escape hatches — always visible regardless of
            primary suggestion. Hidden during split form (it has its own
            Cancel button to avoid mixed signals). */}
        {!showSplitForm && !showBillMatch && !(suggestion.kind === 'transfer' && !showCreateForm) && (
          <div className="flex items-center justify-end gap-1 pt-1">
            <button
              onClick={onMarkPersonal}
              className="text-[11px] text-muted-foreground hover:text-foreground px-2 h-7 rounded-md hover:bg-muted"
            >
              Mark personal
            </button>
            <span className="text-muted-foreground/30">·</span>
            <button
              onClick={onIgnore}
              className="text-[11px] text-muted-foreground hover:text-foreground px-2 h-7 rounded-md hover:bg-muted"
            >
              Ignore
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Transfer suggestion: one-tap ignore ─────────────────────────────────────

function TransferSuggestion({
  reason, onIgnore, onTreatAsExpense,
}: { reason: string; onIgnore: () => void; onTreatAsExpense: () => void }) {
  return (
    <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <ArrowRight size={14} className="text-blue-600 mt-0.5 shrink-0" strokeWidth={2} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-blue-900">{reason}</p>
          <p className="text-[11px] text-blue-800 mt-0.5">
            Moving your own money between accounts — not a business expense.
          </p>
        </div>
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={onIgnore}
          className="flex-1 h-8 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 transition-colors"
        >
          Ignore (it&apos;s a transfer)
        </button>
        <button
          onClick={onTreatAsExpense}
          className="px-3 h-8 rounded-md bg-card border border-border text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Actually an expense
        </button>
      </div>
    </div>
  );
}

// ── "We found a matching entry" sub-card ───────────────────────────────────

function MatchedSuggestion({
  entry, jobs, onConfirm, onReject,
}: {
  entry: Entry;
  jobs: ReturnType<typeof useStore>['jobs'];
  onConfirm: () => void;
  onReject: () => void;
}) {
  const job = entry.jobId ? jobs.find((j) => j.id === entry.jobId) : null;
  return (
    <div className="rounded-xl bg-green-50 border border-green-200 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <CheckCircle2 size={14} className="text-green-600 mt-0.5 shrink-0" strokeWidth={2} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-green-900">Matches an existing entry</p>
          <p className="text-[11px] text-green-800 mt-0.5">
            <span className="font-medium">{entry.description}</span>
            {job && <> · {job.name}</>}
            {' '}· {fmtDateNZ(entry.entryDate)}
          </p>
        </div>
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={onConfirm}
          className="flex-1 h-8 rounded-md bg-green-600 text-white text-xs font-semibold hover:bg-green-700 transition-colors"
        >
          Link
        </button>
        <button
          onClick={onReject}
          className="px-3 h-8 rounded-md bg-card border border-border text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Not a match
        </button>
      </div>
    </div>
  );
}

// ── "Create a new entry from this transaction" form ─────────────────────────

const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'paint', 'materials', 'tools', 'fuel', 'vehicle',
  'labour', 'subcontractor', 'admin', 'software', 'marketing', 'other',
];

function NewEntryForm({
  txn, suggestion, jobs, onSubmit,
}: {
  txn: BankTransaction;
  suggestion: Suggestion;
  jobs: ReturnType<typeof useStore>['jobs'];
  onSubmit: (entry: Omit<Entry, 'id' | 'businessId' | 'createdAt' | 'bankTransactionId'>) => void;
}) {
  const isCredit = txn.amount > 0;
  const grossAmount = Math.abs(txn.amount);

  // Defaults seeded from the classifier
  const defaultType = suggestion.kind === 'income' ? 'income' : 'expense';
  const defaultCategory = (suggestion.kind === 'expense' ? suggestion.category : 'other') as ExpenseCategory;
  const defaultSupplier = suggestion.kind === 'expense' ? (suggestion.supplier ?? txn.payee) : undefined;
  // Categories that are inherently business-wide rather than job-specific —
  // pre-flag them as overhead so Brad doesn't have to tap it every time he
  // reconciles a BP fuel charge or an Adobe subscription.
  const OVERHEAD_DEFAULT_CATEGORIES: ReadonlySet<ExpenseCategory> = new Set(['fuel', 'software']);
  const defaultIsOverhead =
    defaultType === 'expense' && OVERHEAD_DEFAULT_CATEGORIES.has(defaultCategory);

  const [type, setType] = useState<'expense' | 'income'>(defaultType);
  const [category, setCategory] = useState<ExpenseCategory>(defaultCategory);
  const [supplier, setSupplier] = useState(defaultSupplier ?? '');
  const [description, setDescription] = useState(txn.description);
  // jobId === '' means "not chosen yet". `isOverhead === true` means the
  // user has explicitly flagged this as a business-wide overhead (no job).
  // We tag the description with [OH] so it's later filterable.
  const [jobId, setJobId] = useState<string>('');
  const [isOverhead, setIsOverhead] = useState<boolean>(defaultIsOverhead);
  const [gstApplies, setGstApplies] = useState(true);

  // Rank jobs by relevance to this bank transaction. Active matches
  // (e.g. payee NICHOLSON → job with client Nicholson) bubble up first,
  // then other active jobs, then recently-completed ones, then the rest.
  const rankedJobs = useMemo(
    () => rankJobs(
      jobs,
      // Context for fuzzy match — the bank txn's identifying text
      [txn.payee, txn.particulars, txn.reference, txn.description]
        .filter(Boolean).join(' '),
    ),
    [jobs, txn.payee, txn.particulars, txn.reference, txn.description],
  );

  const NZ_GST_RATE = 0.15;
  const ex = gstApplies ? grossAmount / (1 + NZ_GST_RATE) : grossAmount;
  const gstC = grossAmount - ex;

  function handleSubmit() {
    const entry: Omit<Entry, 'id' | 'businessId' | 'createdAt' | 'bankTransactionId'> = {
      jobId: jobId || undefined,
      type,
      category: type === 'expense' ? category : undefined,
      supplier: type === 'expense' && supplier ? supplier : undefined,
      amount: grossAmount,
      gstApplies,
      amountExGst: Math.round(ex * 100) / 100,
      gstComponent: Math.round(gstC * 100) / 100,
      // When overhead is flagged, prefix the description with [OH] so it's
      // greppable later. jobId stays null which is the canonical "overhead"
      // shape (matches the importer's "OH" sentinel from the Finances sheet).
      description: (isOverhead ? '[OH] ' : '') + (description.trim() || txn.description),
      entryDate: txn.txnDate,
      paymentMethod: txn.tranType === 'POS' ? 'EFTPOS'
        : txn.tranType === 'FT'  ? 'Internet transfer'
        : txn.tranType === 'BP'  ? 'Bill payment'
        : undefined,
    };
    onSubmit(entry);
  }

  // Confidence chip
  const confColor =
    suggestion.confidence === 'high' ? 'bg-green-100 text-green-700'
    : suggestion.confidence === 'medium' ? 'bg-amber-100 text-amber-700'
    : 'bg-muted text-muted-foreground';

  return (
    <div className="space-y-2.5">
      {/* Type + confidence */}
      <div className="flex items-center gap-2">
        <div className="inline-flex bg-muted rounded-md p-0.5">
          <button
            onClick={() => setType('expense')}
            className={cn(
              'px-2.5 h-7 rounded-sm text-[11px] font-medium transition-colors',
              type === 'expense' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground',
            )}
          >Expense</button>
          <button
            onClick={() => setType('income')}
            className={cn(
              'px-2.5 h-7 rounded-sm text-[11px] font-medium transition-colors',
              type === 'income' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground',
            )}
          >Income</button>
        </div>
        <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide', confColor)}>
          {suggestion.confidence}
        </span>
      </div>

      {/* Category (expense only) + supplier */}
      {type === 'expense' && (
        <div className="grid grid-cols-2 gap-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
            className="h-8 px-2 rounded-md border border-input bg-background text-xs"
          >
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c} className="capitalize">{c}</option>
            ))}
          </select>
          <input
            type="text"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            placeholder="Supplier"
            className="h-8 px-2 rounded-md border border-input bg-background text-xs"
          />
        </div>
      )}

      {/* Job picker + overhead toggle */}
      <div className="flex items-center gap-2">
        <select
          value={jobId}
          onChange={(e) => {
            setJobId(e.target.value);
            // Picking a job implicitly cancels the overhead flag.
            if (e.target.value) setIsOverhead(false);
          }}
          disabled={isOverhead}
          className={cn(
            'flex-1 h-8 px-2 rounded-md border border-input bg-background text-xs',
            isOverhead && 'opacity-50',
          )}
        >
          <option value="">No job</option>
          {/* Render in tiers so the most relevant jobs are at the top, with
              section headers via <optgroup>. The native select on iOS/Mac
              respects optgroup labels and picks them out visually. */}
          {(['active-match', 'active', 'recent', 'older'] as const).map((tier) => {
            const inTier = rankedJobs.filter((r) => r.tier === tier);
            if (inTier.length === 0) return null;
            const label = tier === 'active-match' ? 'Likely match'
              : tier === 'active' ? 'Active jobs'
              : tier === 'recent' ? 'Recently completed'
              : 'Older';
            return (
              <optgroup key={tier} label={label}>
                {inTier.map((r) => (
                  <option key={r.job.id} value={r.job.id}>
                    {r.job.name}
                    {r.job.clientName ? ` — ${r.job.clientName}` : ''}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        <button
          type="button"
          onClick={() => {
            setIsOverhead((v) => !v);
            if (!isOverhead) setJobId(''); // turning ON overhead clears job
          }}
          className={cn(
            'shrink-0 h-8 px-2.5 rounded-md text-[11px] font-semibold border transition-colors',
            isOverhead
              ? 'bg-blue-100 text-blue-700 border-blue-200'
              : 'bg-background text-muted-foreground border-border hover:text-foreground hover:border-primary/30',
          )}
          title="Mark as overhead — a business expense not tied to any specific job"
        >
          Overhead
        </button>
      </div>

      {/* Description */}
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="w-full h-8 px-2 rounded-md border border-input bg-background text-xs"
      />

      {/* GST toggle + amounts */}
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={gstApplies}
            onChange={(e) => setGstApplies(e.target.checked)}
            className="h-3.5 w-3.5 accent-primary"
          />
          <span className="text-[11px] text-muted-foreground">GST applies</span>
        </label>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {gstApplies ? <>{fmt(ex)} ex · {fmt(gstC)} GST</> : 'no GST'}
        </p>
      </div>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        className="w-full h-8 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors flex items-center justify-center gap-1"
      >
        Log as {type} <ArrowRight size={12} />
      </button>
    </div>
  );
}

// ── Split: allocate one bank txn across multiple entries ───────────────────
//
// Inline form that replaces the single-entry form when the user wants to
// split a bank transaction (e.g. a Mitre 10 shop covering two jobs +
// overhead). Two rows by default. Supports either $ amount or %
// percentage entry. Save is blocked until row amounts sum exactly to the
// bank txn's gross amount.
//
// All rows share the same date (the bank txn date) and category default;
// per-row job picker + overhead flag + GST toggle. Description inherits
// the bank txn description but is editable per row.

interface SplitRowState {
  id: string;          // local-only for React keys
  jobId: string;       // '' = none (overhead candidate)
  isOverhead: boolean;
  category: ExpenseCategory;
  amountStr: string;   // raw user input — interpreted as $ or %
  description: string;
  gstApplies: boolean;
}

function SplitForm({
  txn, suggestion, jobs, onSubmit, onCancel,
}: {
  txn: BankTransaction;
  suggestion: Suggestion;
  jobs: ReturnType<typeof useStore>['jobs'];
  onSubmit: (rows: Omit<Entry, 'id' | 'businessId' | 'createdAt' | 'bankTransactionId'>[]) => Promise<void>;
  onCancel: () => void;
}) {
  const isCredit = txn.amount > 0;
  const grossAmount = Math.abs(txn.amount);
  const defaultType: 'income' | 'expense' = isCredit ? 'income' : 'expense';
  const defaultCategory = (suggestion.kind === 'expense' ? suggestion.category : 'other') as ExpenseCategory;

  const [mode, setMode] = useState<'amount' | 'percent'>('amount');
  const [rows, setRows] = useState<SplitRowState[]>(() => [
    { id: 'r1', jobId: '', isOverhead: false, category: defaultCategory, amountStr: '', description: txn.description, gstApplies: true },
    { id: 'r2', jobId: '', isOverhead: false, category: defaultCategory, amountStr: '', description: txn.description, gstApplies: true },
  ]);
  const [saving, setSaving] = useState(false);

  // Rank jobs by relevance — same as NewEntryForm.
  const rankedJobs = useMemo(
    () => rankJobs(
      jobs,
      [txn.payee, txn.particulars, txn.reference, txn.description].filter(Boolean).join(' '),
    ),
    [jobs, txn.payee, txn.particulars, txn.reference, txn.description],
  );

  // Compute each row's gross dollar amount based on the active mode.
  // In percent mode the input is a percent of grossAmount.
  function rowGross(r: SplitRowState): number {
    const n = parseFloat(r.amountStr);
    if (!Number.isFinite(n)) return 0;
    if (mode === 'percent') return Math.round((n / 100) * grossAmount * 100) / 100;
    return Math.round(n * 100) / 100;
  }

  const allocations = rows.map(rowGross);
  const allocated = allocations.reduce((s, n) => s + n, 0);
  const remaining = Math.round((grossAmount - allocated) * 100) / 100;
  // Treat anything inside ±$0.02 as "balanced" — handles GST-rounding
  // edge cases where percentages don't divide cleanly.
  const balanced = Math.abs(remaining) <= 0.02;
  const allRowsValid = rows.every((r) => {
    if (rowGross(r) <= 0) return false;
    if (!r.isOverhead && !r.jobId) return false;
    return true;
  });
  const canSave = balanced && allRowsValid && !saving;

  function updateRow(id: string, patch: Partial<SplitRowState>) {
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, ...patch } : r));
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      {
        id: `r${Date.now()}`,
        jobId: '',
        isOverhead: false,
        category: defaultCategory,
        amountStr: '',
        description: txn.description,
        gstApplies: true,
      },
    ]);
  }

  function removeRow(id: string) {
    setRows((prev) => prev.length <= 1 ? prev : prev.filter((r) => r.id !== id));
  }

  /**
   * Auto-balance the last empty row to make the totals match. Useful
   * shortcut: enter the first N-1 amounts, tap Balance, get the last one
   * filled in for you.
   */
  function balanceLastRow() {
    const lastId = rows[rows.length - 1].id;
    if (mode === 'amount') {
      const otherTotal = rows
        .filter((r) => r.id !== lastId)
        .reduce((s, r) => s + rowGross(r), 0);
      const need = Math.round((grossAmount - otherTotal) * 100) / 100;
      if (need <= 0) return;
      updateRow(lastId, { amountStr: need.toFixed(2) });
    } else {
      const otherPct = rows
        .filter((r) => r.id !== lastId)
        .reduce((s, r) => s + (parseFloat(r.amountStr) || 0), 0);
      const need = Math.round((100 - otherPct) * 100) / 100;
      if (need <= 0) return;
      updateRow(lastId, { amountStr: need.toFixed(2) });
    }
  }

  const NZ_GST_RATE = 0.15;

  async function handleSubmit() {
    if (!canSave) return;
    setSaving(true);
    try {
      const payloads: Omit<Entry, 'id' | 'businessId' | 'createdAt' | 'bankTransactionId'>[] = rows.map((r) => {
        const gross = rowGross(r);
        const ex = r.gstApplies ? gross / (1 + NZ_GST_RATE) : gross;
        const gstC = gross - ex;
        return {
          jobId: r.isOverhead ? undefined : (r.jobId || undefined),
          type: defaultType,
          category: defaultType === 'expense' ? r.category : undefined,
          supplier: defaultType === 'expense' ? txn.payee : undefined,
          amount: gross,
          gstApplies: r.gstApplies,
          amountExGst: Math.round(ex * 100) / 100,
          gstComponent: Math.round(gstC * 100) / 100,
          description: (r.isOverhead ? '[OH] ' : '') + (r.description.trim() || txn.description),
          entryDate: txn.txnDate,
          paymentMethod: txn.tranType === 'POS' ? 'EFTPOS'
            : txn.tranType === 'FT'  ? 'Internet transfer'
            : txn.tranType === 'BP'  ? 'Bill payment'
            : undefined,
        };
      });
      await onSubmit(payloads);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      {/* Header: total + mode toggle */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-foreground">
          Split {fmt(grossAmount)} across…
        </p>
        <div className="inline-flex bg-muted rounded-md p-0.5">
          <button
            type="button"
            onClick={() => setMode('amount')}
            className={cn(
              'px-2 h-6 rounded text-[11px] font-semibold transition-colors',
              mode === 'amount'
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            $
          </button>
          <button
            type="button"
            onClick={() => setMode('percent')}
            className={cn(
              'px-2 h-6 rounded text-[11px] font-semibold transition-colors',
              mode === 'percent'
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            %
          </button>
        </div>
      </div>

      {/* Rows */}
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.id} className="bg-background border border-border rounded-lg p-2 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide w-10 shrink-0">
                #{i + 1}
              </span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min={0}
                value={r.amountStr}
                onChange={(e) => updateRow(r.id, { amountStr: e.target.value })}
                placeholder={mode === 'amount' ? '0.00' : '0'}
                className="w-24 h-8 px-2 rounded-md border border-input bg-background text-xs tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <span className="text-[11px] text-muted-foreground shrink-0 w-12">
                {mode === 'percent' && r.amountStr ? `≈ ${fmt(rowGross(r))}` : ''}
              </span>
              <select
                value={r.isOverhead ? '__OH__' : r.jobId}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '__OH__') updateRow(r.id, { isOverhead: true, jobId: '' });
                  else updateRow(r.id, { isOverhead: false, jobId: v });
                }}
                className="flex-1 min-w-0 h-8 px-2 rounded-md border border-input bg-background text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Pick a job…</option>
                <option value="__OH__">Overhead (no job)</option>
                {rankedJobs.length > 0 && (
                  <optgroup label="Jobs">
                    {rankedJobs.map((r) => (
                      <option key={r.job.id} value={r.job.id}>
                        {r.job.name} {r.job.clientName ? `· ${r.job.clientName}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              {rows.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeRow(r.id)}
                  aria-label={`Remove split row ${i + 1}`}
                  className="shrink-0 h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-red-600 hover:bg-red-50 rounded-md"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={r.description}
                onChange={(e) => updateRow(r.id, { description: e.target.value })}
                placeholder={txn.description}
                className="flex-1 h-7 px-2 rounded-md border border-input bg-background text-[11px] focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {defaultType === 'expense' && (
                <select
                  value={r.category}
                  onChange={(e) => updateRow(r.id, { category: e.target.value as ExpenseCategory })}
                  className="h-7 px-1 rounded-md border border-input bg-background text-[11px] focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              )}
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={r.gstApplies}
                  onChange={(e) => updateRow(r.id, { gstApplies: e.target.checked })}
                  className="h-3 w-3"
                />
                GST
              </label>
            </div>
          </li>
        ))}
      </ul>

      {/* Footer controls */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={addRow}
            className="h-7 px-2 rounded-md text-[11px] font-medium text-primary hover:bg-primary/10 flex items-center gap-1"
          >
            <Plus size={11} strokeWidth={2} /> Add row
          </button>
          {!balanced && (
            <button
              type="button"
              onClick={balanceLastRow}
              className="h-7 px-2 rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              Balance last
            </button>
          )}
        </div>
        <div className={cn(
          'text-[11px] tabular-nums font-semibold flex items-center gap-1',
          balanced ? 'text-green-700' : 'text-amber-700',
        )}>
          {balanced
            ? <><CheckCircle2 size={11} strokeWidth={2} /> {fmt(allocated)} / {fmt(grossAmount)}</>
            : <>{fmt(allocated)} / {fmt(grossAmount)} ({remaining > 0 ? '+' : ''}{fmt(remaining)})</>}
        </div>
      </div>

      {/* Save / Cancel */}
      <div className="flex items-center gap-1.5 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="h-9 px-3 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSave}
          className={cn(
            'flex-1 h-9 rounded-md text-xs font-semibold transition-colors flex items-center justify-center gap-1',
            canSave
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed',
          )}
        >
          {saving
            ? 'Saving…'
            : <>Save {rows.length} entries <ArrowRight size={12} /></>}
        </button>
      </div>
    </div>
  );
}

// ── Match: settle several uploaded bills against one payment ───────────────
//
// The "I paid 3–4 Trademax invoices with one transfer" case. The bills were
// already read by the AI and allocated to their jobs when they landed as
// drafts on Home; here we just tick which ones this payment covered and mark
// them paid on the PAYMENT date — the correct claim date on payments-basis
// GST. No new entries are created (so nothing double-counts), and each split
// bill's job allocation is already baked into the bill entries themselves.

/**
 * Cheap token-overlap score between a bill's supplier/company text and the
 * bank payment's identifying text. Mirrors lib/job-match's tokeniser. Used
 * to float likely matches to the top and pre-tick the obvious ones.
 */
function billSupplierScore(bill: Entry, ctx: string): number {
  const toks = (s: string) => new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3),
  );
  const ctxTokens = toks(ctx);
  if (ctxTokens.size === 0) return 0;
  const billTokens = toks([bill.supplier, bill.company, bill.description].filter(Boolean).join(' '));
  let hits = 0;
  for (const t of ctxTokens) {
    if (billTokens.has(t)) { hits += 10; continue; }
    for (const bt of billTokens) {
      if (bt.includes(t) || t.includes(bt)) { hits += 5; break; }
    }
  }
  return hits;
}

function BillMatchForm({
  txn, entries, jobs, onSubmit, onCancel,
}: {
  txn: BankTransaction;
  entries: Entry[];
  jobs: ReturnType<typeof useStore>['jobs'];
  onSubmit: (billEntryIds: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const paymentGross = Math.abs(txn.amount);
  const ctx = [txn.payee, txn.particulars, txn.reference, txn.description]
    .filter(Boolean).join(' ');

  // Candidate bills: confirmed, unpaid, unlinked, positive amount. Sorted
  // by supplier-match (desc) then most-recent first.
  const candidates = useMemo(() => {
    const list = entries
      .filter((e) => e.type === 'bill' && !e.isDraft && !e.paid && !e.bankTransactionId && (e.amount ?? 0) > 0)
      .map((e) => ({ bill: e, score: billSupplierScore(e, ctx) }));
    list.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return (b.bill.entryDate ?? '').localeCompare(a.bill.entryDate ?? '');
    });
    return list;
  }, [entries, ctx]);

  // Pre-tick the strong supplier matches (score >= 10). If none match the
  // payee, start empty so Brad chooses deliberately.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const init = new Set<string>();
    candidates.forEach((c) => { if (c.score >= 10) init.add(c.bill.id); });
    return init;
  });
  const [saving, setSaving] = useState(false);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const selectedTotal = candidates
    .filter((c) => selected.has(c.bill.id))
    .reduce((s, c) => s + (c.bill.amount ?? 0), 0);
  const remaining = Math.round((paymentGross - selectedTotal) * 100) / 100;
  const balanced = Math.abs(remaining) <= 0.02;
  const canSave = selected.size > 0 && !saving;

  async function handleSubmit() {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSubmit([...selected]);
    } finally {
      setSaving(false);
    }
  }

  if (candidates.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          No unpaid bills to match yet. Upload the supplier invoices first
          (Entry → Upload supplier bill, or they arrive by email), confirm
          them on Home, then come back here to settle them against this payment.
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-foreground">
        Which bills did this {fmt(paymentGross)} payment cover?
      </p>

      <ul className="space-y-1.5">
        {candidates.map(({ bill }) => {
          const job = bill.jobId ? jobs.find((j) => j.id === bill.jobId) : null;
          const isSel = selected.has(bill.id);
          return (
            <li key={bill.id}>
              <button
                type="button"
                onClick={() => toggle(bill.id)}
                aria-pressed={isSel}
                className={cn(
                  'w-full flex items-center gap-2.5 p-2 rounded-lg border text-left transition-colors',
                  isSel
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-background hover:bg-muted/50',
                )}
              >
                <span className={cn(
                  'shrink-0 w-4 h-4 rounded flex items-center justify-center border',
                  isSel ? 'bg-primary border-primary text-primary-foreground' : 'border-input bg-background',
                )}>
                  {isSel && <CheckCircle2 size={12} strokeWidth={2.5} />}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">
                    {bill.supplier ?? bill.company ?? bill.description}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {job ? job.name : 'Overhead'}
                    {' · '}{fmtDateNZ(bill.entryDate)}
                    {bill.paymentRef ? ` · #${bill.paymentRef}` : ''}
                  </p>
                </div>
                <p className="text-xs font-semibold text-foreground shrink-0 tabular-nums">
                  {fmt(bill.amount ?? 0)}
                </p>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Running total vs payment — a cross-check, not a hard gate. */}
      <div className={cn(
        'text-[11px] tabular-nums font-semibold flex items-center justify-end gap-1',
        selected.size === 0 ? 'text-muted-foreground'
          : balanced ? 'text-green-700' : 'text-amber-700',
      )}>
        {balanced && selected.size > 0
          ? <><CheckCircle2 size={11} strokeWidth={2} /> Matches payment · {fmt(selectedTotal)}</>
          : <>{fmt(selectedTotal)} / {fmt(paymentGross)} ({remaining > 0 ? `${fmt(remaining)} left` : `${fmt(Math.abs(remaining))} over`})</>}
      </div>

      {/* Save / Cancel */}
      <div className="flex items-center gap-1.5 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="h-9 px-3 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSave}
          className={cn(
            'flex-1 h-9 rounded-md text-xs font-semibold transition-colors flex items-center justify-center gap-1',
            canSave
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed',
          )}
        >
          {saving
            ? 'Saving…'
            : <>Mark {selected.size || ''} paid <ArrowRight size={12} /></>}
        </button>
      </div>

      {selected.size > 0 && !balanced && (
        <p className="text-[11px] text-muted-foreground">
          Doesn&apos;t have to match exactly — just tick the bills this payment covered. They&apos;ll be marked paid on {fmtDateNZ(txn.txnDate)}.
        </p>
      )}
    </div>
  );
}
