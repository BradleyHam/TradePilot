'use client';

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { classifyBankRow, findMatchingEntry, type Suggestion } from '@/lib/bank-classifier';
import { rankJobs } from '@/lib/job-match';
import type { BankTransaction, Entry, ExpenseCategory } from '@/lib/types';
import { CheckCircle2, ArrowRight, Receipt, DollarSign } from 'lucide-react';
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
  onIgnore: () => void;
  onMarkPersonal: () => void;
}

export function ReconcileRow({
  txn, entries, jobs,
  onLinkToEntry, onCreateEntry, onIgnore, onMarkPersonal,
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

  // For "create new entry" we need a job picker + GST toggle
  const [showCreateForm, setShowCreateForm] = useState(false);

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
        {suggestion.kind === 'transfer' && !showCreateForm ? (
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
          <NewEntryForm
            txn={txn}
            suggestion={suggestion}
            jobs={jobs}
            onSubmit={(entry) => onCreateEntry(entry)}
          />
        )}
        {/* Bottom-right escape hatches — always visible regardless of
            primary suggestion. */}
        {!(suggestion.kind === 'transfer' && !showCreateForm) && (
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
