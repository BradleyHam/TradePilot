'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from './supabase/client';
import {
  rowToJob, rowToEntry, rowToScheduleItem,
  rowToMaterial, rowToQuote, rowToQuoteAttachment, rowToSetting, rowToInvoice, rowToBankTransaction,
  rowToJobImport,
  jobToRow, entryToRow, scheduleItemToRow, invoiceToRow, bankTransactionToRow,
  materialToRow, quoteToRow, quoteAttachmentToRow,
} from './supabase/mappers';
import type {
  Job, Entry, EntryType, ScheduleItem, Material, Quote, Setting, Invoice, BankTransaction,
  JobImport, QuoteAttachment, QuoteAttachmentKind,
  JobStatus, QuoteTemplate,
} from './types';
import { compressImage } from './image-compress';

/**
 * Supabase's `PostgrestError` doesn't enumerate its fields (Chrome devtools
 * prints it as `{}`). This helper unwraps the relevant pieces into a plain
 * string so logs and `error` state are useful instead of cryptic.
 *
 * Always include code/details/hint when present — that's where the real
 * "what went wrong" usually lives (e.g. `PGRST116` = no rows, `42501` =
 * RLS denied, `23503` = FK violation).
 */
/**
 * Best-guess quote_attachments kind from a filename. Mirrors the
 * importer's file classifier so attachments land in the same buckets
 * after commit as the dry-run report predicted.
 */
function inferAttachmentKind(name: string): QuoteAttachmentKind {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) {
    if (lower.includes('plan') || lower.includes('consent') || lower.includes('drawing')) return 'plan';
    if (lower.startsWith('inv-') || lower.includes('invoice')) return 'other';
    if (lower.startsWith('q-') || lower.includes('quote')) return 'quote_pdf';
    return 'other';
  }
  if (/\.(jpe?g|png|webp|heic)$/.test(lower)) {
    if (lower.includes('before') || lower.includes('start')) return 'before_photo';
    if (lower.includes('after') || lower.includes('final') || lower.includes('done')) return 'after_photo';
    return 'scope_photo';
  }
  return 'other';
}

function describeError(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as { message?: string; code?: string; details?: string; hint?: string };
    const parts = [
      e.message,
      e.code ? `code=${e.code}` : '',
      e.details ? `details=${e.details}` : '',
      e.hint ? `hint=${e.hint}` : '',
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(' · ');
    try { return JSON.stringify(err); } catch { return String(err); }
  }
  return String(err);
}

// Public shape stays close to the original so existing pages keep working.
// New: materials, quotes, settings, loading, error, refresh.
interface StoreState {
  jobs: Job[];
  entries: Entry[];
  scheduleItems: ScheduleItem[];
  materials: Material[];
  quotes: Quote[];
  settings: Setting[];
  invoices: Invoice[];
  bankTransactions: BankTransaction[];
  /**
   * Pending project-archive imports staged by scripts/import-projects.ts.
   * One row per /projects folder. Surfaced on Home as the "Imports to
   * review" flag where the user commits each as link/create/skip.
   */
  jobImports: JobImport[];
  /**
   * Files attached to quotes — plans, before/after photos, scope photos,
   * the quote PDF itself. Populated by the project importer + the
   * commit flow. JobDetailSheet's "Plans & photos" panel reads these,
   * filtered to the quotes tied to that job.
   */
  quoteAttachments: QuoteAttachment[];
  businessId: string | null;
  loading: boolean;
  error: string | null;

  // Mutators — optimistic local update + Supabase write-behind.
  // addJob returns a Promise so callers that need to chain operations
  // on the persisted job (e.g. the wrap-up sheet which then attaches
  // photos via a FK relationship) can await the insert before
  // continuing. Existing fire-and-forget callers are unaffected —
  // they just ignore the returned Promise. Resolves to the persisted
  // Job on success, or null if the insert was rejected (in which
  // case the optimistic local row has already been rolled back).
  addJob: (job: Job) => Promise<Job | null>;
  updateJob: (id: string, updates: Partial<Job>) => void;
  /**
   * Hard-delete a job — only succeeds if NOTHING is attached. Inspects
   * entries / materials / quotes / invoices / quote_attachments /
   * schedule_items for rows referencing the jobId; if any are found,
   * returns blockedBy with counts so the UI can render a clear "can't
   * delete, move these first" message. The single legitimate use case
   * is junk test jobs that were never real (no real data anywhere).
   *
   * Note: this is deliberately NOT a soft delete. The block-on-attached
   * rule means there's nothing worth recovering — anything that survived
   * the rule was empty by definition.
   */
  deleteJob: (id: string) => Promise<{
    ok: boolean;
    blockedBy?: {
      entries: number;
      materials: number;
      quotes: number;
      invoices: number;
      quoteAttachments: number;
      scheduleItems: number;
    };
    error?: string;
  }>;
  /**
   * One-shot cleanup of a job's schedule items against reality. Auto-runs
   * inside updateJob on the first transition into a terminal status; can
   * also be called directly (e.g. from a "Reconcile schedule" button) to
   * fix already-completed jobs whose past plans are still cluttering the
   * calendar.
   *
   * `asLost` = true means treat as a `lost` job — only future incomplete
   * items are removed and history is left alone. Otherwise applies the
   * "smart reconcile" rules: items past the actual completion date are
   * deleted, items on/before are marked done.
   */
  reconcileJobSchedule: (
    jobId: string,
    asLost: boolean,
    /** Explicit completion date (overrides job.endDate / latest-hours / today). */
    explicitCompletionDate?: string,
  ) => Promise<{ completed: number; deleted: number }>;
  addEntry: (entry: Entry) => void;
  updateEntry: (id: string, updates: Partial<Entry>) => void;
  deleteEntry: (id: string) => void;
  addScheduleItem: (item: ScheduleItem) => void;
  updateScheduleItem: (id: string, updates: Partial<ScheduleItem>) => void;
  deleteScheduleItem: (id: string) => void;

  // Invoice mutators
  addInvoice: (invoice: Invoice) => void;
  updateInvoice: (id: string, updates: Partial<Invoice>) => void;

  // Bank-transaction mutators
  /** Bulk-insert parsed CSV rows. Idempotent on (business_id, fingerprint). */
  importBankTransactions: (rows: Omit<BankTransaction, 'id' | 'businessId' | 'importedAt'>[]) => Promise<{ inserted: number; skipped: number }>;
  /** Generic update — mark ignored, change status, edit notes. */
  updateBankTransaction: (id: string, updates: Partial<BankTransaction>) => void;
  /** Link a bank txn to an existing entry (both sides updated). */
  reconcileToEntry: (bankTxnId: string, entryId: string) => void;
  /** Create a new entry from a bank txn AND link them in the same flow. */
  reconcileAsNewEntry: (bankTxnId: string, entry: Omit<Entry, 'id' | 'businessId' | 'createdAt' | 'bankTransactionId'>) => void;

  /**
   * Split a single bank transaction into N entries (different jobs /
   * categories / GST settings). All N entries share the same
   * bank_transaction_id so the bank reconcile audit trail stays intact.
   *
   * The caller is responsible for ensuring the entries' gross amounts
   * sum to the bank txn's amount — the splitter UI enforces this before
   * calling, so any sub-cent rounding has already been resolved.
   *
   * Returns counts. On any failure the bank txn stays unreconciled and
   * any successfully-inserted entries are NOT rolled back (we accept the
   * partial state rather than mass-deleting on a single insert error —
   * easier to fix manually than to recover from a half-rolled-back batch).
   */
  reconcileAsSplitEntries: (
    bankTxnId: string,
    entries: Omit<Entry, 'id' | 'businessId' | 'createdAt' | 'bankTransactionId'>[],
  ) => Promise<{ inserted: number; failed: number; error?: string }>;
  /**
   * Mark an invoice paid AND auto-create a linked income entry on the
   * payment date. Idempotent: if the invoice is already paid, no-op.
   */
  markInvoicePaid: (id: string, paidDate: string, paidVia?: string) => void;

  /**
   * Flip a draft bill (isDraft=true) into a real, counted bill. Optional
   * `patches` lets the caller adjust fields at the same time — typically
   * the user-picked jobId on the Home confirm row, but any Entry field is
   * valid (e.g. correcting the amount before confirming).
   *
   * Thin wrapper around updateEntry — included on the store interface so
   * callers don't have to remember to pass `isDraft: false` every time.
   */
  confirmBillDraft: (id: string, patches?: Partial<Entry>) => void;

  /**
   * Confirm a draft bill AND bulk-insert the line items as `materials`
   * rows tied to the bill via `entry_id`. Used by the per-line allocation
   * UI on the Home "Bills to confirm" flag.
   *
   * The bill update is the source of truth — if it fails (RLS, network),
   * we bail and DON'T touch materials. If the bill succeeds but some
   * materials rows fail to insert, we log loudly and set `error` but the
   * bill stays confirmed. Materials are derived data; the bill itself
   * still carries the parser_raw blob so re-deriving later is possible.
   */
  confirmBillDraftWithMaterials: (
    billId: string,
    opts: { jobId: string | null; materials: Omit<Material, 'id' | 'businessId' | 'createdAt'>[] },
  ) => Promise<void>;

  /**
   * Generic bulk-insert for materials rows. Reusable beyond bill confirms
   * (e.g. future "log a material I bought in person" flow). Returns
   * counts so callers can report partial success.
   */
  addMaterials: (
    rows: Omit<Material, 'id' | 'businessId' | 'createdAt'>[],
  ) => Promise<{ inserted: number; failed: number }>;

  /**
   * Add a single material row marked as source='overhead' — used when
   * the painter pulled something off the van that was already paid for
   * under overhead. Hits per-job profit but not business-wide expenses.
   */
  addMaterialFromOverhead: (
    row: Omit<Material, 'id' | 'businessId' | 'createdAt' | 'entryId' | 'source'>,
  ) => Promise<{ ok: boolean; id?: string; error?: string }>;

  /**
   * Upload one or more files as quote_attachments. Each file is
   * compressed (images only) and uploaded to Storage at
   * `{businessId}/{quoteId}/{uuid}__{cleanName}`, with a matching
   * `quote_attachments` row inserted per success.
   *
   * Returns counts so the UI can show "3 of 4 uploaded, 1 failed".
   * Failed files are NOT inserted into quote_attachments and their
   * Storage objects (if uploaded then errored on insert) are best-effort
   * removed. Local state is updated optimistically and rolled back on
   * each individual failure.
   *
   * `kind` is per-file so a single batch can mix scope_photo / before /
   * after when the user has classified them in the UI.
   */
  addQuoteAttachments: (
    quoteId: string,
    files: { file: File; kind: QuoteAttachmentKind }[],
  ) => Promise<{ inserted: number; failed: number }>;

  /**
   * Returns an existing quote on the given job, or creates a minimal
   * draft quote (status='draft', jobAddress from the job) if none
   * exists. Used by the photo upload flow on the JobDetailSheet so
   * jobs without any quote can still accept attachments.
   *
   * Returns null if quote creation fails (RLS, network); caller should
   * surface a clear error and not proceed with upload.
   */
  ensureJobHasQuote: (jobId: string) => Promise<string | null>;

  /**
   * Delete a single quote_attachment. Removes the Storage object and
   * the row in one go. Optimistic local removal with rollback on
   * failure. Used by the X button on each attachment row.
   */
  deleteQuoteAttachment: (id: string) => Promise<{ ok: boolean; error?: string }>;

  /**
   * Update fields on a quote — used by the inline edit UI on the
   * JobDetailSheet's Quotes panel. Optimistic merge into local state
   * with rollback on DB failure. Server-side: ex-GST + GST component
   * derivation isn't done here (yet) — caller passes whichever fields
   * they want to update.
   */
  updateQuote: (id: string, updates: Partial<Quote>) => Promise<{ ok: boolean; error?: string }>;

  /**
   * Delete a quote. Blocks if any quote_attachments reference this
   * quote — the caller should delete those first (UI shows them as
   * the Plans & photos panel on the job). Optimistic local remove
   * with rollback on failure.
   */
  deleteQuote: (id: string) => Promise<{
    ok: boolean;
    blockedBy?: { quoteAttachments: number };
    error?: string;
  }>;

  /**
   * Commit a pending job_import row by linking it to an EXISTING job.
   * Creates a `quotes` row tied to that job (populated from
   * parsed_data when available), moves the staged Storage objects from
   * `_pending/{importId}/` to `{businessId}/{quoteId}/`, and inserts a
   * `quote_attachments` row per file. Conservatively merges parsed
   * scope fields into the job ONLY where the job's fields are empty.
   * Marks the import as committed on success.
   */
  /**
   * Outcome tag for a committed quote — drives whether the job's status
   * flips to 'lost'/'paid'/etc, and seeds the lostReason / wonReason
   * fields for future quoting-AI signal. 'unknown' = caller couldn't
   * remember; we don't touch the job's outcome fields in that case.
   */
  commitImportAsLink: (
    importId: string,
    jobId: string,
    outcome: {
      result: 'won' | 'lost' | 'unknown';
      /** Required when result='lost'. Maps to Job.lostReason. */
      lostReason?: 'price' | 'no-reply' | 'went-elsewhere' | 'scope-changed' | 'project-cancelled' | 'timing' | 'other';
      /** Free-form note for outcomeNotes on the job. */
      notes?: string;
    },
  ) => Promise<{ ok: boolean; quoteId?: string; error?: string }>;

  /**
   * Same as link, but first creates a NEW jobs row from the import's
   * folder name + parsed_data. Auto-derived defaults: name = folder
   * name (or parsed jobType if better), client_name from parsed_data,
   * status = 'completed' if invoice present, else 'in-progress'.
   */
  commitImportAsCreate: (
    importId: string,
  ) => Promise<{ ok: boolean; jobId?: string; quoteId?: string; error?: string }>;

  /**
   * Mark a pending import as skipped (won't commit). Storage files are
   * left in _pending/ for now — a future cleanup pass can purge them.
   */
  commitImportAsSkip: (
    importId: string,
  ) => Promise<{ ok: boolean; error?: string }>;

  /**
   * Read the current business's quote template (from the settings
   * row keyed 'quote_template'). Returns null if no row exists —
   * the settings UI will then show defaults to start filling. Migration
   * 014 seeds a row for every existing business so this normally
   * returns something even for brand-new accounts.
   */
  getQuoteTemplate: () => QuoteTemplate | null;
  /**
   * Save the template. Upserts the settings row. Returns ok=true on
   * success; on failure surfaces the message so the UI can show it.
   */
  saveQuoteTemplate: (
    template: QuoteTemplate,
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Upload a logo file to the business-logos Storage bucket. Returns
   * the storage path on success (which the caller should write to
   * template.header.logoStoragePath via saveQuoteTemplate). Returns
   * null on failure with the error surfaced to the store's `error`
   * field. Replaces any existing logo at the same path.
   */
  uploadBusinessLogo: (file: File) => Promise<string | null>;
  /**
   * Resolve a storage path to a public URL for display + PDF embed.
   * Returns null if no path provided. Synchronous because the bucket
   * is public — no signing required.
   */
  resolveLogoUrl: (storagePath: string | undefined | null) => string | null;

  // Re-fetch everything from Supabase (useful after a write succeeds).
  refresh: () => Promise<void>;
}

const StoreContext = createContext<StoreState | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [scheduleItems, setScheduleItems] = useState<ScheduleItem[]>([]);

  // Refs that mirror the latest values of the lists above, so async mutators
  // (like reconcileJobSchedule) can read current state without depending on
  // closure capture or relying on setState callbacks running synchronously.
  // Updated synchronously during render so the ref is always current — that's
  // why the lint rule is suppressed below. (Using an effect instead would
  // leave the ref stale during user-event handlers, which is the whole point
  // of having the ref.)
  const jobsRef = useRef(jobs);
  const entriesRef = useRef(entries);
  const scheduleItemsRef = useRef(scheduleItems);
  /* eslint-disable react-hooks/refs */
  jobsRef.current = jobs;
  entriesRef.current = entries;
  scheduleItemsRef.current = scheduleItems;
  /* eslint-enable react-hooks/refs */
  const [materials, setMaterials] = useState<Material[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [bankTransactions, setBankTransactions] = useState<BankTransaction[]>([]);
  const [jobImports, setJobImports] = useState<JobImport[]>([]);
  // jobImportsRef so the commit handlers can read the current import row
  // without depending on closure capture; same pattern as jobsRef above.
  const jobImportsRef = useRef(jobImports);
  /* eslint-disable react-hooks/refs */
  jobImportsRef.current = jobImports;
  /* eslint-enable react-hooks/refs */
  const [quoteAttachments, setQuoteAttachments] = useState<QuoteAttachment[]>([]);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Pick the user's business. With RLS in place, this returns only
      // businesses owned by the signed-in user. We assume one for now.
      const { data: bizRows, error: bizErr } = await supabase
        .from('businesses')
        .select('*')
        .limit(1);
      if (bizErr) throw bizErr;
      if (!bizRows || bizRows.length === 0) {
        // Empty result is almost always RLS — businesses *do* exist, but the
        // signed-in user's auth.uid() doesn't match any owner_id. Make this
        // loud rather than silent.
        const { data: { user } } = await supabase.auth.getUser();
        const msg = user
          ? `Signed in as ${user.email} (${user.id}) but no business is visible. ` +
            `Run "select owner_id from businesses;" in the Supabase SQL editor — ` +
            `if owner_id doesn't match this user id, update it: ` +
            `"update businesses set owner_id = '${user.id}' where name = 'Lakeside Painting';"`
          : 'Not signed in.';
        console.warn('[store]', msg);
        setError(msg);
        setBusinessId(null);
        setJobs([]); setEntries([]); setScheduleItems([]);
        setMaterials([]); setQuotes([]); setSettings([]); setInvoices([]);
        setBankTransactions([]); setJobImports([]); setQuoteAttachments([]);
        setLoading(false);
        return;
      }
      const bizId = bizRows[0].id as string;
      setBusinessId(bizId);

      // Fetch all in parallel. Small dataset — fine for now.
      // Errors on individual tables (e.g. a missing-table during migration)
      // shouldn't take down the whole page. Each table degrades to an empty
      // array and the error is logged with full detail.
      const [j, e, s, m, q, st, inv, bnk, ji, qa] = await Promise.all([
        supabase.from('jobs').select('*').eq('business_id', bizId).order('created_at', { ascending: false }),
        supabase.from('entries').select('*').eq('business_id', bizId).order('entry_date', { ascending: false }),
        supabase.from('schedule_items').select('*').eq('business_id', bizId).order('date', { ascending: true }),
        supabase.from('materials').select('*').eq('business_id', bizId).order('used_on', { ascending: false }),
        supabase.from('quotes').select('*').eq('business_id', bizId).order('date_sent', { ascending: false }),
        supabase.from('settings').select('*').eq('business_id', bizId),
        supabase.from('invoices').select('*').eq('business_id', bizId).order('invoice_date', { ascending: false }),
        supabase.from('bank_transactions').select('*').eq('business_id', bizId).order('txn_date', { ascending: false }),
        // Pending project-archive imports for the "Imports to review" flag.
        // Filtering at the query level so the client never holds the
        // committed/skipped tail of the table (which only grows).
        supabase.from('job_imports').select('*').eq('business_id', bizId)
          .eq('status', 'pending').order('created_at', { ascending: false }),
        // Quote attachments — small table, fetch all. JobDetailSheet
        // filters client-side to the quotes tied to the open job.
        supabase.from('quote_attachments').select('*').eq('business_id', bizId)
          .order('created_at', { ascending: false }),
      ]);

      // Log per-table errors with detail (Supabase errors don't stringify
      // usefully so we extract the fields explicitly), but don't throw.
      const tableErrors: { table: string; err: unknown }[] = [];
      const collect = (table: string, r: { error: unknown }) => {
        if (r.error) tableErrors.push({ table, err: r.error });
      };
      collect('jobs', j); collect('entries', e); collect('schedule_items', s);
      collect('materials', m); collect('quotes', q); collect('settings', st);
      collect('invoices', inv); collect('bank_transactions', bnk);
      collect('job_imports', ji); collect('quote_attachments', qa);

      if (tableErrors.length > 0) {
        for (const { table, err: tErr } of tableErrors) {
          const detail = tErr && typeof tErr === 'object'
            ? JSON.stringify(tErr, Object.getOwnPropertyNames(tErr))
            : String(tErr);
          console.warn(`[store] failed to load ${table}: ${detail}`);
        }
        // Don't blank the screen — just surface a non-blocking note so the
        // dev can see something went wrong while the rest of the app works.
        const firstMsg = tableErrors
          .map(({ table, err: tErr }) => {
            const m = tErr && typeof tErr === 'object' && 'message' in tErr
              ? (tErr as { message?: string }).message
              : null;
            return `${table}: ${m ?? 'unknown error'}`;
          })
          .join(' · ');
        setError(`Some tables failed to load — ${firstMsg}`);
      }

      setJobs((j.data ?? []).map(rowToJob));
      setEntries((e.data ?? []).map(rowToEntry));
      setScheduleItems((s.data ?? []).map(rowToScheduleItem));
      setMaterials((m.data ?? []).map(rowToMaterial));
      setBankTransactions((bnk.data ?? []).map(rowToBankTransaction));
      setQuotes((q.data ?? []).map(rowToQuote));
      setSettings((st.data ?? []).map(rowToSetting));
      setInvoices((inv.data ?? []).map(rowToInvoice));
      setJobImports((ji.data ?? []).map(rowToJobImport));
      setQuoteAttachments((qa.data ?? []).map(rowToQuoteAttachment));
    } catch (err: unknown) {
      // Top-level catch — only fires for the businesses fetch or completely
      // unexpected throws.
      const detail = err && typeof err === 'object'
        ? JSON.stringify(err, Object.getOwnPropertyNames(err))
        : String(err);
      console.error('[store] catastrophic load failure:', detail);
      setError(err instanceof Error ? err.message : detail);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + reload on auth changes (so signing in triggers a fetch).
  useEffect(() => {
    load();
    const { data: sub } = supabase.auth.onAuthStateChange((_event) => {
      load();
    });
    return () => { sub.subscription.unsubscribe(); };
  }, [load]);

  // One-time backfill: reconcile historical hours entries against their
  // matching job_booking schedule_items on app load. The forward-looking
  // auto-complete in addEntry/updateEntry only catches entries logged
  // AFTER the fix shipped — anything older stays Overdue until we do
  // this pass.
  //
  // Gated by ranOnceRef so it only fires the first time both tables have
  // populated for the current business, AND only when there's actually
  // something to fix (avoids a no-op supabase round-trip on every load).
  const overdueBackfillDoneRef = useRef<string | null>(null);
  useEffect(() => {
    // Reset the gate when the business changes (sign out / switch).
    if (overdueBackfillDoneRef.current && overdueBackfillDoneRef.current !== businessId) {
      overdueBackfillDoneRef.current = null;
    }
    if (overdueBackfillDoneRef.current === businessId) return;
    if (loading) return; // wait until the load() call settled
    if (!businessId) return;
    if (entries.length === 0 && scheduleItems.length === 0) return;
    overdueBackfillDoneRef.current = businessId;

    // Build a (jobId, date) → entry index for the cheap lookup. We only
    // care about hours entries with a jobId, entryDate, and hours > 0
    // (mirrors the auto-complete predicate).
    const workedKey = new Set<string>();
    for (const e of entries) {
      if (e.type !== 'hours') continue;
      if (!e.jobId || !e.entryDate) continue;
      if (!e.hours || e.hours <= 0) continue;
      workedKey.add(`${e.jobId}::${e.entryDate}`);
    }

    // Find any uncompleted job_booking rows that have a matching worked
    // key. These are the historical "Overdue" rows the user actually
    // worked but never ticked.
    const toComplete: string[] = [];
    for (const s of scheduleItems) {
      if (s.type !== 'job_booking') continue;
      if (s.completed) continue;
      if (s.skipReasonKind) continue; // skipped days stay skipped
      if (!s.jobId) continue;
      if (workedKey.has(`${s.jobId}::${s.date}`)) toComplete.push(s.id);
    }

    if (toComplete.length === 0) return;

    // eslint-disable-next-line no-console
    console.log('[store] backfill: clearing Overdue on', toComplete.length, 'schedule_items where hours are already logged');

    // Optimistic local flip + batched supabase update in a single
    // call. RLS already filters to the user's own business, so no
    // explicit business_id filter needed beyond the id list.
    setScheduleItems((prev) =>
      prev.map((s) => toComplete.includes(s.id) ? { ...s, completed: true } : s),
    );
    (async () => {
      const { error: updErr } = await supabase
        .from('schedule_items')
        .update({ completed: true })
        .in('id', toComplete);
      if (updErr) {
        console.warn('[store] backfill: supabase update failed (local state still correct):', {
          message: updErr.message, code: updErr.code, count: toComplete.length,
        });
      }
    })();
  }, [businessId, entries, scheduleItems, loading]);

  // ── Mutators ─────────────────────────────────────────────────────────────
  // Each one updates local state immediately (optimistic) so the UI feels
  // instant, then writes to Supabase. On failure we roll back local state and
  // surface the error so it's not silently lost.

  const addJob = useCallback(async (job: Job): Promise<Job | null> => {
    if (!businessId) {
      console.warn('[store] addJob called with no businessId; ignoring');
      return null;
    }
    // Optimistic insert with the temporary id from the caller.
    setJobs((prev) => [job, ...prev]);
    const tempId = job.id;

    const row = jobToRow({ ...job, businessId });
    const { data, error: insertErr } = await supabase
      .from('jobs').insert(row).select('*').single();
    if (insertErr || !data) {
      // Spread the useful Supabase error fields — without this, the
      // log was rendering as `{}` and migrations / FK violations were
      // impossible to diagnose. Same pattern as updateScheduleItem.
      console.error('[store] addJob failed:', {
        message: insertErr?.message,
        code: insertErr?.code,
        details: insertErr?.details,
        hint: insertErr?.hint,
        payload: row,
      });
      setError(insertErr?.message ?? 'Failed to save job');
      // Roll back the optimistic insert
      setJobs((prev) => prev.filter((j) => j.id !== tempId));
      return null;
    }
    // Replace the temporary row with the persisted one (real id, etc).
    const persisted = rowToJob(data);
    setJobs((prev) => prev.map((j) => (j.id === tempId ? persisted : j)));
    return persisted;
  }, [businessId]);

  /**
   * Reconcile a job's schedule items with reality. Called automatically
   * when a job transitions into a terminal status, and exposed as a
   * standalone mutator so the UI can offer a "Reconcile schedule" button on
   * already-completed jobs whose past plans are still cluttering the calendar.
   *
   * `completionDate` resolution priority (when `asLost` is false):
   *   1. Caller-provided `completionDate` (the user's explicit answer when
   *      marking the job complete — most reliable).
   *   2. The job's stored `endDate` (set by the completion-date prompt).
   *   3. Latest entryDate of any hours entry on this job (heuristic — only
   *      meaningful if the user actually logged hours on this job).
   *   4. Today.
   *
   * Behaviour:
   *   asLost = false  (completed/invoiced/paid):
   *     - past items on/before completionDate not done → mark done.
   *     - items after completionDate (past or future) → delete.
   *   asLost = true:
   *     - delete only future incomplete items. Past items are still real
   *       history (quote visits, follow-ups) and aren't touched.
   *
   * Returns counts for the caller's UX (e.g. toast: "Marked 3 items done,
   * removed 2 stale items").
   */
  const reconcileJobSchedule = useCallback(async (
    jobId: string,
    asLost: boolean,
    explicitCompletionDate?: string,
  ): Promise<{ completed: number; deleted: number }> => {
    const now = new Date();
    const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    let completionDate: string = todayISO;
    if (!asLost) {
      // Priority 1: caller-provided explicit date.
      if (explicitCompletionDate) {
        completionDate = explicitCompletionDate;
      } else {
        // Priority 2: the job's stored endDate. Read from the ref so we
        // see the latest committed value, not a stale closure capture.
        const storedEndDate = jobsRef.current.find((j) => j.id === jobId)?.endDate;
        if (storedEndDate) {
          completionDate = storedEndDate;
        } else {
          // Priority 3: latest hours-entry date on this job.
          let latestHoursDate = '';
          for (const e of entriesRef.current) {
            if (e.jobId === jobId && e.type === 'hours' && e.entryDate) {
              if (!latestHoursDate || e.entryDate > latestHoursDate) {
                latestHoursDate = e.entryDate;
              }
            }
          }
          if (latestHoursDate && latestHoursDate <= todayISO) {
            completionDate = latestHoursDate;
          }
          // Priority 4: today (already the default).
        }
      }
      // Clamp future-dated completion (e.g. user typo) so we never delete
      // every past plan as "after completion". Cap at today.
      if (completionDate > todayISO) {
        completionDate = todayISO;
      }
    }

    // Decide which items to touch by reading the current schedule list
    // straight from the ref. Pure read — no side effects — then we apply the
    // update in a single setScheduleItems call below. This avoids the
    // double-invocation pitfall of mutating arrays inside the updater.
    const toDeleteIds: string[] = [];
    const toCompleteIds: string[] = [];
    for (const s of scheduleItemsRef.current) {
      if (s.jobId !== jobId) continue;
      if (asLost) {
        if (!s.completed && s.date > todayISO) toDeleteIds.push(s.id);
        continue;
      }
      if (s.date > completionDate) {
        toDeleteIds.push(s.id);
      } else if (!s.completed) {
        toCompleteIds.push(s.id);
      }
    }

    if (toDeleteIds.length === 0 && toCompleteIds.length === 0) {
      return { completed: 0, deleted: 0 };
    }

    // Apply optimistically.
    setScheduleItems((prev) => prev.flatMap((s) => {
      if (toDeleteIds.includes(s.id)) return [];
      if (toCompleteIds.includes(s.id)) return [{ ...s, completed: true }];
      return [s];
    }));

    console.info('[store] reconcileJobSchedule', {
      jobId,
      asLost,
      completionDate,
      deleteCount: toDeleteIds.length,
      completeCount: toCompleteIds.length,
    });

    if (toDeleteIds.length > 0) {
      // .select() so we can detect the silent "0 rows affected" case (RLS).
      const { data: deleted, error: delErr } = await supabase
        .from('schedule_items')
        .delete()
        .in('id', toDeleteIds)
        .select('id');
      if (delErr) {
        console.error('[store] reconcileJobSchedule delete failed:', describeError(delErr));
        setError(`Couldn't remove stale schedule items: ${describeError(delErr)}`);
      } else if (!deleted || deleted.length !== toDeleteIds.length) {
        console.warn('[store] reconcileJobSchedule delete: expected', toDeleteIds.length,
          'rows but got', deleted?.length ?? 0,
          '— RLS may have silently blocked some.');
      }
    }

    if (toCompleteIds.length > 0) {
      const { data: updated, error: updItemsErr } = await supabase
        .from('schedule_items')
        .update({ completed: true })
        .in('id', toCompleteIds)
        .select('id');
      if (updItemsErr) {
        console.error('[store] reconcileJobSchedule complete failed:', describeError(updItemsErr));
        setError(`Couldn't mark past schedule items done: ${describeError(updItemsErr)}`);
      } else if (!updated || updated.length !== toCompleteIds.length) {
        console.warn('[store] reconcileJobSchedule update: expected', toCompleteIds.length,
          'rows but got', updated?.length ?? 0,
          '— RLS may have silently blocked some.');
      }
    }

    return { completed: toCompleteIds.length, deleted: toDeleteIds.length };
  }, []);

  const updateJob = useCallback((id: string, updates: Partial<Job>) => {
    let prevJob: Job | undefined;
    setJobs((prev) => {
      prevJob = prev.find((j) => j.id === id);
      return prev.map((j) =>
        j.id === id ? { ...j, ...updates, updatedAt: new Date().toISOString() } : j,
      );
    });

    (async () => {
      const row = jobToRow(updates);
      const { error: updErr } = await supabase.from('jobs').update(row).eq('id', id);
      if (updErr) {
        console.error('[store] updateJob failed:', updErr);
        setError(updErr.message);
        // Roll back.
        if (prevJob) {
          setJobs((prev) => prev.map((j) => (j.id === id ? prevJob! : j)));
        }
      }
    })();

    // When a job transitions into a "done" status, reconcile its schedule
    // items with reality so the calendar stops lying. The hours entries are
    // the source of truth for what actually happened; schedule items were
    // just the plan. See `reconcileJobSchedule` above for the rules.
    const TERMINAL: JobStatus[] = ['completed', 'invoiced', 'paid', 'lost'];
    const isNowTerminal = !!(updates.status && TERMINAL.includes(updates.status));
    const wasTerminal = !!(prevJob?.status && TERMINAL.includes(prevJob.status));
    if (isNowTerminal && !wasTerminal) {
      reconcileJobSchedule(id, updates.status === 'lost').catch((err) => {
        console.error('[store] auto-reconcile after status change failed:', describeError(err));
      });
    }
  }, [reconcileJobSchedule]);

  /**
   * Hard-delete a job. Blocked if anything is attached. The block-rule
   * is the only safety net (no soft delete) so we'd rather refuse than
   * silently orphan real data.
   *
   * Counts are computed from local state (fast, no extra round-trip) —
   * the load query already pulled everything for this business. This
   * means if another client added a row right now we might let a delete
   * through that should've been blocked, but the schema's ON DELETE
   * SET NULL means even then the worst case is unlinking a few rows,
   * not actual data loss.
   */
  const deleteJob = useCallback(async (id: string) => {
    if (!businessId) return { ok: false as const, error: 'No business loaded.' };

    const blockedBy = {
      entries: entriesRef.current.filter((e) => e.jobId === id).length,
      materials: 0, // computed below — materials lives in materials state, not a ref
      quotes: 0,
      invoices: 0,
      quoteAttachments: 0,
      scheduleItems: scheduleItemsRef.current.filter((s) => s.jobId === id).length,
    };
    // setMaterials/setQuotes etc don't have refs (they're rarely needed
    // in async closures). Use the setter-callback trick to read latest.
    setMaterials((cur) => { blockedBy.materials = cur.filter((m) => m.jobId === id).length; return cur; });
    setQuotes((cur) => { blockedBy.quotes = cur.filter((q) => q.jobId === id).length; return cur; });
    setInvoices((cur) => { blockedBy.invoices = cur.filter((i) => i.jobId === id).length; return cur; });
    setQuoteAttachments((cur) => {
      // Count attachments tied to any of this job's quotes.
      const quoteIds = new Set<string>();
      setQuotes((qs) => { qs.filter((q) => q.jobId === id).forEach((q) => quoteIds.add(q.id)); return qs; });
      blockedBy.quoteAttachments = cur.filter((a) => quoteIds.has(a.quoteId)).length;
      return cur;
    });

    const totalAttached =
      blockedBy.entries + blockedBy.materials + blockedBy.quotes +
      blockedBy.invoices + blockedBy.quoteAttachments + blockedBy.scheduleItems;
    if (totalAttached > 0) {
      return { ok: false as const, blockedBy };
    }

    // Optimistic remove from local state, then delete from DB. If the
    // DB delete fails, restore.
    let prev: Job | undefined;
    setJobs((js) => {
      prev = js.find((j) => j.id === id);
      return js.filter((j) => j.id !== id);
    });

    const { error: delErr } = await supabase.from('jobs').delete().eq('id', id);
    if (delErr) {
      console.error('[store] deleteJob failed:', describeError(delErr));
      setError(describeError(delErr));
      if (prev) setJobs((js) => [prev!, ...js]);
      return { ok: false as const, error: describeError(delErr) };
    }
    return { ok: true as const };
  }, [businessId]);

  /**
   * Auto-complete a scheduled job_booking row when matching hours are logged.
   *
   * If an hours entry has a jobId + entryDate + hours > 0, find the
   * job_booking schedule_item for that same (jobId, date) and flip its
   * `completed` flag to true if it isn't already. This removes the
   * "Overdue" pill from days the user actually worked — logging hours IS
   * the act of completing the scheduled day, no separate tick needed.
   *
   * One-way: deleting or zero-ing the entry does NOT un-complete the
   * schedule item. The flag represents an intentional human action ("I
   * worked this day"), not a derived view. If the user genuinely wants
   * to mark a day as not-done they can untick it on the schedule page.
   *
   * Implemented as an inline ref-reading helper rather than calling
   * `updateScheduleItem` because that callback is defined later in this
   * component and we don't want a forward dependency.
   */
  function maybeCompleteJobBookingForEntry(entry: { type?: EntryType; jobId?: string; entryDate?: string; hours?: number }) {
    if (entry.type !== 'hours') return;
    if (!entry.jobId || !entry.entryDate) return;
    if (!entry.hours || entry.hours <= 0) return;

    // Use functional setState so we ALWAYS see the freshest scheduleItems —
    // scheduleItemsRef can lag by one render in some HMR edge cases, but
    // the setter callback's `prev` argument is guaranteed current. We do
    // the match-and-flip inside the setter so it's atomic. The matched
    // id is captured in a closure so the supabase update fires once for
    // the correct row.
    let matchedId: string | undefined;
    let diag: { totalJobBookings: number; sameJob: number; sameJobSameDate: number; sameJobSameDateUncompleted: number } | null = null;
    setScheduleItems((prev) => {
      // Diagnostic counters so a no-match case tells us WHY it didn't
      // match (no rows for this job? rows exist but on different dates?
      // matching date but already completed?). Cheap to compute, only
      // logged when there's no match.
      diag = {
        totalJobBookings: prev.filter((s) => s.type === 'job_booking').length,
        sameJob: prev.filter((s) => s.type === 'job_booking' && s.jobId === entry.jobId).length,
        sameJobSameDate: prev.filter((s) => s.type === 'job_booking' && s.jobId === entry.jobId && s.date === entry.entryDate).length,
        sameJobSameDateUncompleted: prev.filter((s) => s.type === 'job_booking' && s.jobId === entry.jobId && s.date === entry.entryDate && !s.completed).length,
      };
      const match = prev.find(
        (s) => s.type === 'job_booking'
          && s.jobId === entry.jobId
          && s.date === entry.entryDate
          && !s.completed,
      );
      if (!match) return prev;
      matchedId = match.id;
      return prev.map((s) => (s.id === match.id ? { ...s, completed: true } : s));
    });

    if (!matchedId) {
      // Verbose log only when an hours entry IS tagged to a job — those
      // are the cases where we expected to match but didn't. Helps
      // diagnose date format mismatches, jobId drift, etc.
      // eslint-disable-next-line no-console
      console.log('[store] auto-complete skipped — no matching schedule_item', {
        entry: { jobId: entry.jobId, entryDate: entry.entryDate, hours: entry.hours },
        scheduleItemCounts: diag,
        // Show 3 sample rows for this job so we can eyeball the actual
        // stored dates if there's a format mismatch.
        sampleSameJobRows: scheduleItemsRef.current
          .filter((s) => s.type === 'job_booking' && s.jobId === entry.jobId)
          .slice(0, 3)
          .map((s) => ({ id: s.id, date: s.date, completed: s.completed, skipReasonKind: s.skipReasonKind })),
      });
      return;
    }

    // Visible in devtools so we can confirm the auto-complete fired.
    // eslint-disable-next-line no-console
    console.log('[store] auto-completed schedule_item for hours entry', {
      scheduleItemId: matchedId,
      jobId: entry.jobId,
      date: entry.entryDate,
    });

    (async () => {
      const { error: updErr } = await supabase
        .from('schedule_items')
        .update({ completed: true })
        .eq('id', matchedId!);
      if (updErr) {
        console.warn('[store] auto-complete schedule_item failed (non-fatal):', {
          message: updErr.message, code: updErr.code, scheduleItemId: matchedId,
        });
      }
    })();
  }

  const addEntry = useCallback((entry: Entry) => {
    if (!businessId) {
      console.warn('[store] addEntry called with no businessId; ignoring');
      return;
    }
    setEntries((prev) => [entry, ...prev]);
    const tempId = entry.id;

    // Fire auto-complete optimistically — the user logs hours, the
    // matching day's "Overdue" clears immediately without waiting for
    // the supabase round-trip. The schedule_items mutation rides along
    // separately and is fire-and-forget.
    maybeCompleteJobBookingForEntry(entry);

    (async () => {
      const row = entryToRow({ ...entry, businessId });
      const { data, error: insertErr } = await supabase
        .from('entries').insert(row).select('*').single();
      if (insertErr || !data) {
        console.error('[store] addEntry failed:', insertErr);
        setError(insertErr?.message ?? 'Failed to save entry');
        setEntries((prev) => prev.filter((e) => e.id !== tempId));
        return;
      }
      const persisted = rowToEntry(data);
      setEntries((prev) => prev.map((e) => (e.id === tempId ? persisted : e)));
    })();
  }, [businessId]);

  const updateEntry = useCallback((id: string, updates: Partial<Entry>) => {
    let prevEntry: Entry | undefined;
    let nextEntry: Entry | undefined;
    setEntries((prev) => {
      prevEntry = prev.find((e) => e.id === id);
      return prev.map((e) => {
        if (e.id !== id) return e;
        nextEntry = { ...e, ...updates };
        return nextEntry;
      });
    });

    // Fire auto-complete optimistically so the UI reacts immediately to
    // edits like "added a jobId" or "moved date onto a scheduled day".
    if (nextEntry) maybeCompleteJobBookingForEntry(nextEntry);

    (async () => {
      const row = entryToRow(updates);
      const { error: updErr } = await supabase.from('entries').update(row).eq('id', id);
      if (updErr) {
        console.error('[store] updateEntry failed:', updErr);
        setError(updErr.message);
        if (prevEntry) {
          setEntries((prev) => prev.map((e) => (e.id === id ? prevEntry! : e)));
        }
      }
    })();
  }, []);

  /**
   * Confirm a draft bill — flips isDraft from true to false, optionally
   * applying user adjustments at the same time (typically the job picked
   * on the Home confirm row). Once confirmed, the bill starts counting in
   * job profit, tax estimator, expense totals, and the bank-reconcile
   * matcher — i.e. everywhere the audit pass in commit 1 added !isDraft.
   *
   * Thin wrapper around updateEntry so callers don't have to remember to
   * pass `isDraft: false`. Optimistic + rollback semantics are inherited.
   */
  const confirmBillDraft = useCallback((id: string, patches?: Partial<Entry>) => {
    updateEntry(id, { ...(patches ?? {}), isDraft: false });
  }, [updateEntry]);

  /**
   * Bulk-insert materials rows. Optimistic: synthesises local rows with
   * temp ids prepended to the materials state, then replaces with the
   * persisted server rows when the insert returns. Per-row failures
   * (e.g. a single bad enum value) don't fail the whole batch — Supabase
   * either inserts all-or-nothing, but we treat the error as "failed"
   * and let the caller decide what to surface.
   *
   * Returns counts so the caller can show "imported X, Y failed".
   */
  const addMaterials = useCallback(async (
    rows: Omit<Material, 'id' | 'businessId' | 'createdAt'>[],
  ): Promise<{ inserted: number; failed: number }> => {
    if (!businessId || rows.length === 0) return { inserted: 0, failed: 0 };

    // Synthesise local rows for optimistic prepend. Real ids overwrite
    // these once the insert returns.
    const tempBase = Date.now();
    const optimistic: Material[] = rows.map((r, i) => ({
      ...r,
      id: `mat_${tempBase}_${i}`,
      businessId,
      createdAt: new Date().toISOString(),
    }));
    setMaterials((prev) => [...optimistic, ...prev]);
    const tempIds = optimistic.map((m) => m.id);

    // Build the row payloads via the new materialToRow mapper.
    const payloads = rows.map((r) => ({
      ...materialToRow(r),
      business_id: businessId,
    }));

    const { data, error: insErr } = await supabase
      .from('materials')
      .insert(payloads)
      .select('*');

    if (insErr || !data) {
      const msg = describeError(insErr) || 'Failed to insert materials';
      console.error('[store] addMaterials failed:', msg, insErr);
      setError(msg);
      // Roll back the optimistic prepend.
      setMaterials((prev) => prev.filter((m) => !tempIds.includes(m.id)));
      return { inserted: 0, failed: rows.length };
    }

    // Replace the temp rows with persisted ones.
    const persisted = data.map(rowToMaterial);
    setMaterials((prev) => {
      const withoutTemps = prev.filter((m) => !tempIds.includes(m.id));
      return [...persisted, ...withoutTemps];
    });
    return { inserted: persisted.length, failed: rows.length - persisted.length };
  }, [businessId]);

  /**
   * Add a SINGLE material row sourced from overhead (no bill, no entry).
   * Used by the "+ Add material → Used from overhead" path on
   * JobDetailSheet. The row has source='overhead' so per-job profit
   * counts it but business-wide expense totals (which read from
   * entries, not materials) correctly DON'T — the original overhead
   * purchase already counted at the time it was made.
   *
   * Optimistic insert with rollback. Returns the persisted row's id so
   * the UI can do whatever it needs (animate, focus the new row, etc).
   */
  const addMaterialFromOverhead = useCallback(async (
    row: Omit<Material, 'id' | 'businessId' | 'createdAt' | 'entryId' | 'source'>,
  ): Promise<{ ok: boolean; id?: string; error?: string }> => {
    if (!businessId) return { ok: false, error: 'No business loaded.' };

    const tempId = `mat_${Date.now()}_oh`;
    const optimistic: Material = {
      ...row,
      id: tempId,
      businessId,
      source: 'overhead',
      createdAt: new Date().toISOString(),
    };
    setMaterials((prev) => [optimistic, ...prev]);

    const payload = {
      ...materialToRow({ ...row, source: 'overhead' }),
      business_id: businessId,
    };

    const { data, error: insErr } = await supabase
      .from('materials')
      .insert(payload)
      .select('*')
      .single();

    if (insErr || !data) {
      const msg = describeError(insErr) || 'Failed to add material';
      console.error('[store] addMaterialFromOverhead failed:', msg);
      setError(msg);
      setMaterials((prev) => prev.filter((m) => m.id !== tempId));
      return { ok: false, error: msg };
    }

    const persisted = rowToMaterial(data);
    setMaterials((prev) => prev.map((m) => (m.id === tempId ? persisted : m)));
    return { ok: true, id: persisted.id };
  }, [businessId]);

  /**
   * Ensure a job has at least one quote — return the existing first quote's
   * id, or create a minimal draft quote if none exists. Used by the photo
   * upload flow on JobDetailSheet so any job can accept attachments
   * without forcing the user through a "create a quote first" detour.
   *
   * Creation is conservative: status='draft', jobAddress copied from the
   * job, everything else left null. The user can fill it in via the
   * Quotes panel later.
   */
  const ensureJobHasQuote = useCallback(async (jobId: string): Promise<string | null> => {
    if (!businessId) {
      setError('No business loaded.');
      return null;
    }
    // Read current quotes via setter-callback so we always see the latest
    // state (avoids stale-closure issues if a quote was just created).
    let existingId: string | null = null;
    setQuotes((cur) => {
      const match = cur.find((q) => q.jobId === jobId);
      if (match) existingId = match.id;
      return cur;
    });
    if (existingId) return existingId;

    // Look up the job for its address — fall back to null if not present.
    let jobAddress: string | undefined;
    setJobs((cur) => {
      const j = cur.find((x) => x.id === jobId);
      if (j) jobAddress = j.location ?? j.name ?? undefined;
      return cur;
    });

    const row = quoteToRow({
      businessId,
      jobId,
      jobAddress,
      status: 'draft',
    });
    const { data, error: insErr } = await supabase
      .from('quotes').insert(row).select('*').single();
    if (insErr || !data) {
      const msg = describeError(insErr) || 'Failed to create quote';
      console.error('[store] ensureJobHasQuote: insert failed —', msg);
      setError(msg);
      return null;
    }
    const newQuote = rowToQuote(data);
    setQuotes((prev) => [newQuote, ...prev]);
    return newQuote.id;
  }, [businessId]);

  /**
   * Upload N files as quote_attachments. For each file:
   *   1. Compress (image files only; PDFs etc pass through).
   *   2. Upload to Storage at {businessId}/{quoteId}/{uuid}__{cleanName}.
   *   3. Insert a quote_attachments row.
   *   4. Mirror into local state.
   *
   * Files are processed sequentially so a slow connection doesn't
   * thrash the network. Each failure is logged but doesn't abort the
   * batch — the user gets a partial success summary at the end.
   *
   * Filenames are sanitised to ASCII-safe characters because Supabase
   * Storage rejects some Unicode patterns; the original name is
   * preserved in the file_name column so the UI can still show it.
   */
  const addQuoteAttachments = useCallback(async (
    quoteId: string,
    files: { file: File; kind: QuoteAttachmentKind }[],
  ): Promise<{ inserted: number; failed: number }> => {
    if (!businessId || files.length === 0) return { inserted: 0, failed: 0 };

    let inserted = 0;
    let failed = 0;

    for (const { file, kind } of files) {
      try {
        // Compress images. Non-images pass through unchanged.
        const { file: prepared, originalSize, compressedSize, skipped } = await compressImage(file);
        if (!skipped && originalSize > 0) {
          const savedPct = Math.round((1 - compressedSize / originalSize) * 100);
          console.info(`[addQuoteAttachments] compressed ${file.name}: ${(originalSize / 1024).toFixed(0)}KB → ${(compressedSize / 1024).toFixed(0)}KB (-${savedPct}%)`);
        }

        const safeName = prepared.name.replace(/[^a-zA-Z0-9._-]+/g, '_');
        const storagePath = `${businessId}/${quoteId}/${crypto.randomUUID()}__${safeName}`;

        const { error: upErr } = await supabase.storage
          .from('quote-attachments')
          .upload(storagePath, prepared, {
            contentType: prepared.type || 'application/octet-stream',
            upsert: false,
          });
        if (upErr) {
          console.error('[addQuoteAttachments] upload failed for', file.name, '—', describeError(upErr));
          failed++;
          continue;
        }

        const { data: insData, error: insErr } = await supabase
          .from('quote_attachments')
          .insert(quoteAttachmentToRow({
            businessId,
            quoteId,
            kind,
            storagePath,
            // Keep the user-facing name (pre-compress) so the UI still
            // shows what they uploaded.
            fileName: file.name,
          }))
          .select('*')
          .single();
        if (insErr || !insData) {
          console.error('[addQuoteAttachments] insert failed for', file.name, '—', describeError(insErr));
          // Best-effort: remove the orphaned Storage object so we don't
          // leak quota for rows that never got a DB record.
          await supabase.storage.from('quote-attachments').remove([storagePath]).catch(() => {});
          failed++;
          continue;
        }

        const persisted = rowToQuoteAttachment(insData);
        setQuoteAttachments((prev) => [persisted, ...prev]);
        inserted++;
      } catch (err) {
        console.error('[addQuoteAttachments] unexpected error for', file.name, err);
        failed++;
      }
    }

    if (failed > 0) {
      setError(`${failed} of ${files.length} uploads failed — check console for details.`);
    }
    return { inserted, failed };
  }, [businessId]);

  /**
   * Delete a single quote_attachment row + its Storage object. Optimistic
   * removal from local state; rolled back if the DB delete fails.
   */
  const deleteQuoteAttachment = useCallback(async (
    id: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    let removed: QuoteAttachment | undefined;
    setQuoteAttachments((prev) => {
      removed = prev.find((a) => a.id === id);
      return prev.filter((a) => a.id !== id);
    });
    if (!removed) return { ok: false, error: 'Attachment not found.' };

    const { error: delErr } = await supabase
      .from('quote_attachments').delete().eq('id', id);
    if (delErr) {
      const msg = describeError(delErr);
      console.error('[deleteQuoteAttachment] delete failed:', msg);
      setError(msg);
      // Roll back.
      setQuoteAttachments((prev) => [removed!, ...prev]);
      return { ok: false, error: msg };
    }

    // Best-effort Storage cleanup. If this fails it's quota waste only,
    // not a correctness issue.
    await supabase.storage
      .from('quote-attachments')
      .remove([removed.storagePath])
      .catch((err) => console.warn('[deleteQuoteAttachment] storage remove failed:', err));

    return { ok: true };
  }, []);

  /**
   * Update fields on a quote. Optimistic merge into local state; rolled
   * back on DB failure. Used by the inline edit UI on the JobDetailSheet
   * Quotes panel to fill in totals/scope/status on stub quotes that
   * came in via the project import without details.
   */
  const updateQuote = useCallback(async (
    id: string,
    updates: Partial<Quote>,
  ): Promise<{ ok: boolean; error?: string }> => {
    // Write to Supabase FIRST so we don't depend on local state to
    // find the row. Previously we checked the local quotes array
    // before doing the update — which broke when ensureJobHasQuote
    // had just created a row that hadn't propagated into local
    // state yet (React 19 batches setQuotes more aggressively than
    // React 18). Supabase is the source of truth; if the row exists
    // there, the update goes through. If not, we get a clean 404
    // back rather than a stale-local-state false negative.
    const row = quoteToRow(updates);
    const { data, error: updErr } = await supabase
      .from('quotes').update(row).eq('id', id).select('*').maybeSingle();
    if (updErr) {
      const msg = describeError(updErr);
      console.error('[updateQuote] update failed:', msg);
      setError(msg);
      return { ok: false, error: msg };
    }
    if (!data) {
      // Row genuinely doesn't exist in Supabase (RLS hid it or it
      // was deleted between create and update).
      return { ok: false, error: 'Quote not found in database.' };
    }
    // Reconcile local state with whatever Supabase returned. Insert
    // if missing (race-recovery), otherwise merge in the updates.
    const persisted = rowToQuote(data);
    setQuotes((prev) => {
      const idx = prev.findIndex((q) => q.id === id);
      if (idx === -1) return [persisted, ...prev];
      const next = [...prev];
      next[idx] = persisted;
      return next;
    });
    return { ok: true };
  }, []);

  /**
   * Delete a quote — blocks if any attachments reference it (otherwise
   * we'd orphan storage rows + DB cascade would kill the attachments
   * silently). Optimistic local remove with rollback on DB failure.
   */
  const deleteQuote = useCallback(async (
    id: string,
  ): Promise<{ ok: boolean; blockedBy?: { quoteAttachments: number }; error?: string }> => {
    // Inspect attachments without an extra round trip — read from local state.
    let attachedCount = 0;
    setQuoteAttachments((cur) => {
      attachedCount = cur.filter((a) => a.quoteId === id).length;
      return cur;
    });
    if (attachedCount > 0) {
      return { ok: false, blockedBy: { quoteAttachments: attachedCount } };
    }

    let removed: Quote | undefined;
    setQuotes((prev) => {
      removed = prev.find((q) => q.id === id);
      return prev.filter((q) => q.id !== id);
    });
    if (!removed) return { ok: false, error: 'Quote not found.' };

    const { error: delErr } = await supabase
      .from('quotes').delete().eq('id', id);
    if (delErr) {
      const msg = describeError(delErr);
      console.error('[deleteQuote] delete failed:', msg);
      setError(msg);
      setQuotes((prev) => [removed!, ...prev]);
      return { ok: false, error: msg };
    }
    return { ok: true };
  }, []);

  /**
   * Confirm a draft bill AND bulk-insert its line items as materials.
   * Order matters: bill update first (source of truth). If that fails
   * we don't touch materials. If the bill succeeds but materials fail,
   * we log loudly + set error but the bill stays confirmed — materials
   * are derived and the parser_raw blob on the entry preserves recovery.
   */
  const confirmBillDraftWithMaterials = useCallback(async (
    billId: string,
    opts: { jobId: string | null; materials: Omit<Material, 'id' | 'businessId' | 'createdAt'>[] },
  ): Promise<void> => {
    // Defensive guard: if the bill is still on its temp id (upload happened
    // moments ago and the persisted id hasn't replaced it yet), bail with
    // a clear message rather than writing a temp id into materials.entry_id.
    if (billId.startsWith('ent_')) {
      setError('Still saving the bill — give it a moment and try again.');
      console.warn('[store] confirmBillDraftWithMaterials: bill still on temp id', billId);
      return;
    }

    // Bill side first — optimistic + rolling back inside updateEntry.
    const patches: Partial<Entry> = { isDraft: false };
    if (opts.jobId !== null) patches.jobId = opts.jobId;
    updateEntry(billId, patches);

    if (opts.materials.length === 0) return;

    // Materials side — best-effort, don't unwind the bill if these fail.
    // Stamp each row with entry_id so they link back to the source bill.
    const stamped = opts.materials.map((m) => ({ ...m, entryId: billId }));
    const { inserted, failed } = await addMaterials(stamped);
    if (failed > 0) {
      console.error('[store] confirmBillDraftWithMaterials: materials partial failure',
        { inserted, failed, billId });
      // setError already called from addMaterials on a hard failure.
    }
  }, [updateEntry, addMaterials]);

  // ── job_imports commit flow ────────────────────────────────────────────
  // Three mutators (link / create / skip) for committing an "Imports to
  // review" row on Home. Shared logic lives in commitImportShared which
  // both link and create call into; skip is a one-line status flip.

  /**
   * Given a confirmed jobId and a pending import row, do the heavy lift:
   *   1. Create a `quotes` row tied to the job, hydrated from parsed_data
   *      when available (folder name as fallback).
   *   2. List the staged files in `_pending/{importId}/`, move each to
   *      `{businessId}/{quoteId}/{uuid}__filename.ext`, create a
   *      `quote_attachments` row per moved file. Kind is inferred from
   *      the file extension + name.
   *   3. Conservative merge: if the linked job has an empty scope field
   *      (surface_area_m2_by_zone, prep_level, surface_type) AND the
   *      import's parsed_data has a value, copy it onto the job. Never
   *      overwrites.
   *   4. Mark the import row committed.
   */
  const commitImportShared = useCallback(async (
    imp: JobImport,
    jobId: string,
    action: 'link' | 'create',
    outcome?: {
      result: 'won' | 'lost' | 'unknown';
      lostReason?: Job['lostReason'];
      notes?: string;
    },
  ): Promise<{ ok: boolean; quoteId?: string; error?: string }> => {
    if (!businessId) return { ok: false, error: 'No business loaded.' };
    const parsed = imp.parsedData;

    // ── 1. Create the quotes row ─────────────────────────────────────────
    const quoteRowData = quoteToRow({
      businessId,
      jobId,
      clientName: parsed?.clientName,
      jobAddress: parsed?.jobAddress ?? imp.folderName,
      jobType: parsed?.jobType,
      scopeSummary: parsed?.scopeSummary,
      baseAmountExGst: parsed?.baseAmountExGst,
      totalAmountInclGst: parsed?.totalAmountInclGst,
      dateSent: parsed?.dateSent,
      status: parsed?.totalAmountInclGst ? 'sent' : 'draft',
      surfaceAreaM2ByZone: parsed?.surfaceAreaM2ByZone,
      prepLevel: parsed?.prepLevel,
      surfaceType: parsed?.surfaceType,
      importSourcePath: imp.sourcePath,
    });
    const { data: quoteInsert, error: quoteErr } = await supabase
      .from('quotes').insert(quoteRowData).select('id').single();
    if (quoteErr || !quoteInsert) {
      const msg = describeError(quoteErr) || 'Failed to create quote';
      console.error('[store] commitImport: quote insert failed —', msg);
      setError(msg);
      return { ok: false, error: msg };
    }
    const quoteId = quoteInsert.id as string;

    // ── 2. Move staged files + insert quote_attachments ──────────────────
    let attachmentsInserted = 0;
    if (imp.attachmentsStoragePrefix) {
      const stagedDir = `${businessId}/${imp.attachmentsStoragePrefix}`;
      console.info('[commit-import] listing storage at:', stagedDir);
      const { data: stagedFiles, error: listErr } = await supabase.storage
        .from('quote-attachments').list(stagedDir, { limit: 100 });
      console.info('[commit-import] list result:',
        listErr ? `ERROR: ${describeError(listErr)}` : `${stagedFiles?.length ?? 0} files`,
        stagedFiles ? stagedFiles.slice(0, 3).map((f) => f.name) : '');
      if (listErr) {
        console.warn('[store] commitImport: could not list staged files —', describeError(listErr));
      } else if (!stagedFiles || stagedFiles.length === 0) {
        console.warn('[store] commitImport: list returned 0 files at', stagedDir,
          '— this is the bug we are chasing. Storage path mismatch?');
      } else {
        console.info('[commit-import] processing', stagedFiles.length, 'staged files');
        // Plans only — photos / videos / other files are NOT committed
        // to quote_attachments. The decision: plans are the high-signal
        // input for the future quoting AI (m² extraction) and are tiny
        // (~200KB each), so they fit comfortably in Supabase free-tier
        // Storage. Photos are nice-to-have but bigger; we keep them on
        // Brad's Mac for now and revisit once the AI proves it needs
        // visual input. Non-plan files staged in _pending/ get removed
        // so we don't leak Storage quota.
        const toRemove: string[] = [];
        for (const f of stagedFiles) {
          const fromPath = `${stagedDir}/${f.name}`;
          const sepIdx = f.name.indexOf('__');
          const cleanName = sepIdx >= 0 ? f.name.slice(sepIdx + 2) : f.name;
          const kind = inferAttachmentKind(cleanName);

          if (kind !== 'plan') {
            // Mark for cleanup; don't attach. inferAttachmentKind also
            // returns 'plan' for quote_pdf files — that's fine, we still
            // want the quote PDF itself attached so the user can preview
            // it from the Plans & photos panel. Tighten the filter to
            // genuinely just plans + quote PDFs.
            toRemove.push(fromPath);
            continue;
          }
          const toPath = `${businessId}/${quoteId}/${crypto.randomUUID()}__${cleanName}`;
          console.info('[commit-import] moving (plan):', fromPath, '→', toPath);
          const { error: mvErr } = await supabase.storage
            .from('quote-attachments').move(fromPath, toPath);
          if (mvErr) {
            console.warn('[commit-import] ✗ move failed for', f.name, '—', describeError(mvErr));
            continue;
          }
          console.info('[commit-import] ✓ moved');
          const attachRow: Partial<QuoteAttachment> = {
            businessId,
            quoteId,
            kind,
            storagePath: toPath,
            fileName: cleanName,
          };
          const { data: attData, error: attErr } = await supabase
            .from('quote_attachments').insert(quoteAttachmentToRow(attachRow))
            .select('*').single();
          if (attErr) {
            console.warn('[commit-import] ✗ insert failed —', describeError(attErr), 'row:', attachRow);
            continue;
          }
          console.info('[commit-import] ✓ inserted attachment row id=', attData?.id);
          // Mirror into local state so JobDetailSheet's Plans & photos
          // panel updates without waiting for a refresh.
          if (attData) {
            setQuoteAttachments((prev) => [rowToQuoteAttachment(attData), ...prev]);
          }
          attachmentsInserted++;
        }
        // Best-effort cleanup of non-plan staged files. If this fails,
        // worst case is some storage quota wasted in _pending/ — the
        // user can sweep it manually later.
        if (toRemove.length > 0) {
          const { error: rmErr } = await supabase.storage
            .from('quote-attachments').remove(toRemove);
          if (rmErr) {
            console.warn('[commit-import] ✗ cleanup of non-plan files failed —', describeError(rmErr));
          } else {
            console.info('[commit-import] cleaned up', toRemove.length, 'non-plan staged files');
          }
        }
      }
    }

    // ── 3. Conservative scope + outcome merge into the job ───────────────
    // For the create path the job was just made with the parsed fields
    // already populated; we still apply the outcome here so a fresh-create
    // can be marked won/lost in the same commit.
    if (parsed || outcome) {
      const job = jobsRef.current.find((j) => j.id === jobId);
      if (job) {
        const jobPatches: Partial<Job> = {};

        // Scope merge — only fill empty fields, never overwrite.
        if (action === 'link' && parsed) {
          if (!job.surfaceAreaM2 && parsed.surfaceAreaM2ByZone) {
            const total = Object.values(parsed.surfaceAreaM2ByZone)
              .reduce((s, v) => s + v, 0);
            if (total > 0) jobPatches.surfaceAreaM2 = total;
          }
          if (!job.prepLevel && parsed.prepLevel) jobPatches.prepLevel = parsed.prepLevel;
        }

        // Outcome merge — drives the future quoting-AI's training signal,
        // so we're more aggressive than scope: the user explicitly told us
        // the result, so trust them.
        // Rules:
        //   - result='won': set status='completed' (or stronger like 'paid'
        //     /'invoiced') only if the current status is earlier in the
        //     pipeline. Never demote a job already at paid/invoiced.
        //     Also clear any stale lostReason.
        //   - result='lost': set status='lost' + record lostReason.
        //     Don't touch a job already marked 'paid'/'invoiced' (those
        //     are won-by-definition; an outcome contradiction probably
        //     means the user is linking the wrong job).
        //   - result='unknown': don't touch outcome fields at all.
        if (outcome?.result === 'won') {
          const stronger: Job['status'][] = ['completed', 'invoiced', 'paid'];
          if (!stronger.includes(job.status)) {
            jobPatches.status = 'completed';
          }
          if (job.lostReason) jobPatches.lostReason = undefined;
        } else if (outcome?.result === 'lost') {
          const wonAlready: Job['status'][] = ['paid', 'invoiced'];
          if (wonAlready.includes(job.status)) {
            console.warn('[store] commitImport: outcome=lost but job is', job.status,
              '— likely a wrong job match; leaving status alone.');
          } else {
            jobPatches.status = 'lost';
            if (outcome.lostReason) jobPatches.lostReason = outcome.lostReason;
          }
        }
        // Free-form notes append (never overwrite — keep history).
        if (outcome?.notes) {
          const prefix = job.outcomeNotes ? `${job.outcomeNotes}\n\n` : '';
          jobPatches.outcomeNotes = `${prefix}${outcome.notes}`;
        }

        if (Object.keys(jobPatches).length > 0) {
          const { error: jobErr } = await supabase.from('jobs')
            .update(jobToRow(jobPatches)).eq('id', jobId);
          if (jobErr) {
            console.warn('[store] commitImport: job merge failed —', describeError(jobErr));
            // Don't fail the commit — merge is a nice-to-have.
          } else {
            setJobs((prev) => prev.map((j) => j.id === jobId ? { ...j, ...jobPatches } : j));
          }
        }
      }
    }

    // ── 4. Mark the import committed ─────────────────────────────────────
    const { error: updErr } = await supabase.from('job_imports').update({
      status: 'committed',
      commit_action: action,
      commit_target_job_id: jobId,
      commit_target_quote_id: quoteId,
      committed_at: new Date().toISOString(),
    }).eq('id', imp.id);
    if (updErr) {
      // The real data landed, just couldn't mark the import. Log + continue.
      console.warn('[store] commitImport: status update failed —', describeError(updErr));
    }
    // Refresh local quotes + jobs in case other UI surfaces want them.
    setQuotes((prev) => [
      { id: quoteId, businessId, jobId, jobAddress: imp.folderName,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        ...parsed,
        importSourcePath: imp.sourcePath,
      } as Quote,
      ...prev,
    ]);
    // Remove the import from the pending list — same effect as removing
    // its row from the active dataset since the load query filters on
    // status='pending'.
    setJobImports((prev) => prev.filter((i) => i.id !== imp.id));

    console.info('[store] commitImport:', action, 'jobId=', jobId, 'quoteId=', quoteId,
      'attachments=', attachmentsInserted);
    return { ok: true, quoteId };
  }, [businessId]);

  const commitImportAsLink = useCallback(async (
    importId: string,
    jobId: string,
    outcome: {
      result: 'won' | 'lost' | 'unknown';
      lostReason?: Job['lostReason'];
      notes?: string;
    },
  ): Promise<{ ok: boolean; quoteId?: string; error?: string }> => {
    const imp = jobImportsRef.current.find((i) => i.id === importId);
    if (!imp) return { ok: false, error: 'Import not found' };
    return commitImportShared(imp, jobId, 'link', outcome);
  }, [commitImportShared]);

  const commitImportAsCreate = useCallback(async (
    importId: string,
  ): Promise<{ ok: boolean; jobId?: string; quoteId?: string; error?: string }> => {
    if (!businessId) return { ok: false, error: 'No business loaded.' };
    const imp = jobImportsRef.current.find((i) => i.id === importId);
    if (!imp) return { ok: false, error: 'Import not found' };

    // Derive new-job defaults from parsed_data + folder name.
    const parsed = imp.parsedData;
    const hasInvoice = (imp.filesSummary.invoice_pdf ?? 0) > 0;
    // Note: Job has prepLevel/surfaceAreaM2 but NOT surfaceType — the
    // surface type lives on the Quote, where it's per-quote rather than
    // a per-job constant. That's fine: a single job can span multiple
    // surfaces (deck + weatherboards + cedar trim), so quote-level is
    // where the granularity should sit.
    const newJobInit: Partial<Job> = {
      businessId,
      name: parsed?.jobType ?? imp.folderName,
      clientName: parsed?.clientName ?? '',
      location: parsed?.jobAddress ?? imp.folderName,
      status: hasInvoice ? 'paid' : (parsed?.totalAmountInclGst ? 'quoted' : 'lead'),
      prepLevel: parsed?.prepLevel,
      surfaceAreaM2: parsed?.surfaceAreaM2ByZone
        ? Object.values(parsed.surfaceAreaM2ByZone).reduce((s, v) => s + v, 0)
        : undefined,
    };
    const { data: jobInsert, error: jobErr } = await supabase
      .from('jobs').insert(jobToRow(newJobInit)).select('*').single();
    if (jobErr || !jobInsert) {
      const msg = describeError(jobErr) || 'Failed to create job';
      console.error('[store] commitImportAsCreate: job insert failed —', msg);
      setError(msg);
      return { ok: false, error: msg };
    }
    const persistedJob = rowToJob(jobInsert);
    setJobs((prev) => [persistedJob, ...prev]);

    const result = await commitImportShared(imp, persistedJob.id, 'create');
    return { ...result, jobId: persistedJob.id };
  }, [businessId, commitImportShared]);

  const commitImportAsSkip = useCallback(async (
    importId: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const { error: updErr } = await supabase.from('job_imports').update({
      status: 'skipped',
      commit_action: 'skip',
      committed_at: new Date().toISOString(),
    }).eq('id', importId);
    if (updErr) {
      const msg = describeError(updErr);
      console.error('[store] commitImportAsSkip failed —', msg);
      setError(msg);
      return { ok: false, error: msg };
    }
    setJobImports((prev) => prev.filter((i) => i.id !== importId));
    return { ok: true };
  }, []);

  const deleteEntry = useCallback((id: string) => {
    let prevEntry: Entry | undefined;
    setEntries((prev) => {
      prevEntry = prev.find((e) => e.id === id);
      return prev.filter((e) => e.id !== id);
    });

    (async () => {
      const { error: delErr } = await supabase.from('entries').delete().eq('id', id);
      if (delErr) {
        console.error('[store] deleteEntry failed:', delErr);
        setError(delErr.message);
        if (prevEntry) {
          // Best-effort restore: prepend. Sorting in pages is by date/createdAt
          // so position doesn't matter for visual correctness.
          setEntries((prev) => [prevEntry!, ...prev]);
        }
        return;
      }
      // If the deleted entry was a bill draft with an attached PDF, clean
      // up the Storage object too. Otherwise we'd accumulate orphan PDFs.
      // Best-effort: a failure here only leaves a few KB of dead bytes —
      // not worth rolling back the entry delete.
      if (prevEntry?.billPdfUrl) {
        const { error: stoErr } = await supabase.storage
          .from('bill-pdfs')
          .remove([prevEntry.billPdfUrl]);
        if (stoErr) {
          console.warn('[store] deleteEntry: PDF cleanup failed (orphan left in bucket):',
            describeError(stoErr));
        }
      }
    })();
  }, []);

  const addScheduleItem = useCallback((item: ScheduleItem) => {
    if (!businessId) {
      console.warn('[store] addScheduleItem called with no businessId; ignoring');
      return;
    }
    setScheduleItems((prev) => [item, ...prev]);
    const tempId = item.id;

    (async () => {
      const row = scheduleItemToRow({ ...item, businessId });
      const { data, error: insertErr } = await supabase
        .from('schedule_items').insert(row).select('*').single();
      if (insertErr || !data) {
        console.error('[store] addScheduleItem failed:', insertErr);
        setError(insertErr?.message ?? 'Failed to save schedule item');
        setScheduleItems((prev) => prev.filter((s) => s.id !== tempId));
        return;
      }
      const persisted = rowToScheduleItem(data);
      setScheduleItems((prev) => prev.map((s) => (s.id === tempId ? persisted : s)));
    })();
  }, [businessId]);

  const updateScheduleItem = useCallback((id: string, updates: Partial<ScheduleItem>) => {
    let prevItem: ScheduleItem | undefined;
    setScheduleItems((prev) => {
      prevItem = prev.find((s) => s.id === id);
      return prev.map((s) => (s.id === id ? { ...s, ...updates } : s));
    });

    (async () => {
      const row = scheduleItemToRow(updates);
      const { error: updErr } = await supabase.from('schedule_items').update(row).eq('id', id);
      if (updErr) {
        // Supabase/PostgREST error objects have non-enumerable properties,
        // so logging `updErr` directly prints "{}". Spread the useful fields
        // so the dev console shows something diagnosable (typically "column
        // X does not exist" when a migration hasn't been applied).
        console.error('[store] updateScheduleItem failed:', {
          message: updErr.message,
          code: updErr.code,
          details: updErr.details,
          hint: updErr.hint,
          payload: row,
        });
        setError(updErr.message);
        if (prevItem) {
          setScheduleItems((prev) => prev.map((s) => (s.id === id ? prevItem! : s)));
        }
      }
    })();
  }, []);

  const deleteScheduleItem = useCallback((id: string) => {
    let prevItem: ScheduleItem | undefined;
    setScheduleItems((prev) => {
      prevItem = prev.find((s) => s.id === id);
      return prev.filter((s) => s.id !== id);
    });

    (async () => {
      const { error: delErr } = await supabase.from('schedule_items').delete().eq('id', id);
      if (delErr) {
        console.error('[store] deleteScheduleItem failed:', delErr);
        setError(delErr.message);
        if (prevItem) {
          // Re-insert at original position (best-effort: prepend; the schedule
          // page sorts by date so position doesn't matter much).
          setScheduleItems((prev) => [prevItem!, ...prev]);
        }
      }
    })();
  }, []);

  // ── Invoice mutators ─────────────────────────────────────────────────────

  /**
   * Auto-advance job.status based on invoice state. Called after invoice
   * inserts/updates. Only ever moves the status FORWARD along the chain
   *   completed → invoiced → paid
   * — never demotes, never touches earlier statuses (lead/quoted/accepted
   * /booked/in-progress/lost) because those are user-driven.
   *
   * Rules:
   *  - If the job has any invoices and status is `completed` → bump to
   *    `invoiced`. (You issued an invoice, so we know it's been invoiced.)
   *  - If the job has at least one paid `final` invoice AND every invoice on
   *    the job is paid → bump to `paid`. (Deposit-only paid jobs do NOT
   *    promote — final invoice is the signal that the job is fully billed.)
   *
   * Reads live state via the setter callbacks so it doesn't capture stale
   * closures from the optimistic-update flow above.
   */
  const maybeAdvanceJobStatus = useCallback((jobId: string | null | undefined) => {
    if (!jobId) return;
    let job: Job | undefined;
    setJobs((js) => { job = js.find((j) => j.id === jobId); return js; });
    if (!job) return;
    // Only auto-advance from these statuses. Anything earlier (lead/quoted
    // /accepted/booked/in-progress) or `lost` is user-driven; don't override.
    if (job.status !== 'completed' && job.status !== 'invoiced') return;

    let jobInvoices: Invoice[] = [];
    setInvoices((list) => { jobInvoices = list.filter((i) => i.jobId === jobId); return list; });
    if (jobInvoices.length === 0) return;

    const allPaid = jobInvoices.every((i) => i.paid);
    const hasPaidFinal = jobInvoices.some((i) => i.paid && i.kind === 'final');

    let nextStatus: JobStatus | null = null;
    if (allPaid && hasPaidFinal) nextStatus = 'paid';
    else if (job.status === 'completed') nextStatus = 'invoiced';

    if (nextStatus && nextStatus !== job.status) {
      updateJob(jobId, { status: nextStatus });
    }
  }, [updateJob]);

  const addInvoice = useCallback((invoice: Invoice) => {
    if (!businessId) {
      console.warn('[store] addInvoice called with no businessId; ignoring');
      return;
    }
    setInvoices((prev) => [invoice, ...prev]);
    const tempId = invoice.id;
    (async () => {
      const row = invoiceToRow({ ...invoice, businessId });
      const { data, error: insErr } = await supabase
        .from('invoices').insert(row).select('*').single();
      if (insErr || !data) {
        console.error('[store] addInvoice failed:', insErr);
        setError(insErr?.message ?? 'Failed to save invoice');
        setInvoices((prev) => prev.filter((i) => i.id !== tempId));
        return;
      }
      const persisted = rowToInvoice(data);
      setInvoices((prev) => prev.map((i) => (i.id === tempId ? persisted : i)));
      maybeAdvanceJobStatus(invoice.jobId);
    })();
  }, [businessId, maybeAdvanceJobStatus]);

  const updateInvoice = useCallback((id: string, updates: Partial<Invoice>) => {
    let prev: Invoice | undefined;
    setInvoices((list) => {
      prev = list.find((i) => i.id === id);
      return list.map((i) => (i.id === id ? { ...i, ...updates } : i));
    });
    (async () => {
      const row = invoiceToRow(updates);
      const { error: updErr } = await supabase.from('invoices').update(row).eq('id', id);
      if (updErr) {
        console.error('[store] updateInvoice failed:', updErr);
        setError(updErr.message);
        if (prev) setInvoices((list) => list.map((i) => (i.id === id ? prev! : i)));
        return;
      }
      // If the edit affects paid status or moved jobs, re-evaluate job status.
      // (jobId moves are unlikely but cheap to handle.)
      const jobId = updates.jobId ?? prev?.jobId;
      if (jobId) maybeAdvanceJobStatus(jobId);
    })();
  }, [maybeAdvanceJobStatus]);

  /**
   * Mark an invoice paid AND auto-create a linked income entry on the
   * payment date. The invoice gets income_entry_id pointing to the new entry.
   * Idempotent: bails if the invoice is already paid.
   */
  const markInvoicePaid = useCallback((id: string, paidDate: string, paidVia?: string) => {
    if (!businessId) return;

    let inv: Invoice | undefined;
    setInvoices((list) => {
      inv = list.find((i) => i.id === id);
      if (!inv || inv.paid) return list;
      return list.map((i) => i.id === id
        ? { ...i, paid: true, paidDate, paidVia: paidVia ?? i.paidVia }
        : i);
    });

    if (!inv || inv.paid) return;

    // Optimistic: also synthesize an income entry locally so cash-basis
    // numbers update immediately. The real entry id replaces the temp one
    // when the Supabase write returns.
    const grossAmount = inv.amountInclGst
      ?? (inv.gstApplies ? inv.amountExGst * 1.15 : inv.amountExGst);
    const gst = inv.gstComponent
      ?? (inv.gstApplies ? inv.amountExGst * 0.15 : 0);
    const tempEntryId = `ent_${Date.now()}`;
    const localEntry: Entry = {
      id: tempEntryId,
      businessId,
      jobId: inv.jobId,
      type: 'income',
      amount: grossAmount,
      gstApplies: inv.gstApplies,
      amountExGst: inv.amountExGst,
      gstComponent: gst,
      description: `${inv.invoiceNumber} payment received`,
      entryDate: paidDate,
      paymentMethod: paidVia ?? 'Bank transfer',
      createdAt: new Date().toISOString(),
    };
    setEntries((prev) => [localEntry, ...prev]);

    (async () => {
      // Insert the entry first, get its real id, then mark the invoice paid
      // with income_entry_id linked. If either step fails, roll back both.
      const entryRow = entryToRow({ ...localEntry, businessId });
      const { data: entryData, error: entryErr } = await supabase
        .from('entries').insert(entryRow).select('*').single();
      if (entryErr || !entryData) {
        const msg = describeError(entryErr) || 'Failed to log payment';
        console.error('[store] markInvoicePaid: entry insert failed —', msg, entryErr);
        setError(msg);
        // Roll back local state
        setEntries((prev) => prev.filter((e) => e.id !== tempEntryId));
        setInvoices((list) => list.map((i) => i.id === id
          ? { ...i, paid: false, paidDate: undefined, paidVia: undefined }
          : i));
        return;
      }
      const persistedEntry = rowToEntry(entryData);
      setEntries((prev) => prev.map((e) => (e.id === tempEntryId ? persistedEntry : e)));

      // Now flip the invoice with the link. We `.select()` the updated rows
      // so we can detect the silent "0 rows changed" case — that happens when
      // RLS blocks the update without returning an error (Supabase quirk).
      const invRow = invoiceToRow({
        paid: true,
        paidDate,
        paidVia,
        incomeEntryId: persistedEntry.id,
      });
      const { data: updated, error: invErr } = await supabase
        .from('invoices')
        .update(invRow)
        .eq('id', id)
        .select('id');

      // Differentiate the two failure modes for diagnostics.
      const noRowsTouched = !invErr && (!updated || updated.length === 0);
      if (invErr || noRowsTouched) {
        const msg = invErr
          ? describeError(invErr)
          : `No invoice row matched id=${id} (likely RLS — confirm businesses.owner_id matches your auth.uid()).`;
        console.error('[store] markInvoicePaid: invoice update failed —', msg, invErr ?? '(no error, 0 rows updated)');
        setError(msg);
        // Best-effort rollback: delete the entry we just created.
        const { error: rollbackErr } = await supabase
          .from('entries').delete().eq('id', persistedEntry.id);
        if (rollbackErr) {
          console.warn('[store] markInvoicePaid: entry rollback also failed —', describeError(rollbackErr));
        }
        setEntries((prev) => prev.filter((e) => e.id !== persistedEntry.id));
        setInvoices((list) => list.map((i) => i.id === id
          ? { ...i, paid: false, paidDate: undefined, paidVia: undefined }
          : i));
        return;
      }
      // Update local invoice with the income_entry_id
      setInvoices((list) => list.map((i) => i.id === id
        ? { ...i, incomeEntryId: persistedEntry.id }
        : i));
      // If this paid invoice means the job is fully billed + paid (final
      // invoice paid AND all invoices paid), bump status to 'paid'. Same
      // helper is also called from addInvoice/updateInvoice so the chain
      // completed → invoiced → paid stays in sync regardless of entry path.
      maybeAdvanceJobStatus(inv!.jobId);
    })();
  }, [businessId, maybeAdvanceJobStatus]);

  // ── Bank transaction mutators ────────────────────────────────────────────

  /**
   * Bulk-insert parsed CSV rows. The DB unique(business_id, fingerprint)
   * means re-imports of the same file silently skip duplicates. We use
   * upsert with ignoreDuplicates so already-imported rows just no-op rather
   * than erroring.
   */
  const importBankTransactions = useCallback(async (
    rows: Omit<BankTransaction, 'id' | 'businessId' | 'importedAt'>[],
  ): Promise<{ inserted: number; skipped: number }> => {
    if (!businessId || rows.length === 0) return { inserted: 0, skipped: 0 };

    // Build the row payloads — the mapper handles the snake_case translation.
    const payloads = rows.map((r) => ({
      ...bankTransactionToRow(r),
      business_id: businessId,
    }));

    const { data, error: insErr } = await supabase
      .from('bank_transactions')
      .upsert(payloads, {
        onConflict: 'business_id,fingerprint',
        ignoreDuplicates: true,
      })
      .select('*');
    if (insErr) {
      console.error('[store] importBankTransactions failed:', insErr);
      setError(insErr.message);
      return { inserted: 0, skipped: 0 };
    }
    const inserted = (data ?? []).length;
    const skipped = rows.length - inserted;
    if (data && data.length > 0) {
      const newOnes = data.map(rowToBankTransaction);
      setBankTransactions((prev) => {
        // Merge: replace existing entries with same fingerprint, prepend new ones
        const byFp = new Map(prev.map((t) => [t.fingerprint, t]));
        for (const t of newOnes) byFp.set(t.fingerprint, t);
        return Array.from(byFp.values()).sort((a, b) => b.txnDate.localeCompare(a.txnDate));
      });
    }
    return { inserted, skipped };
  }, [businessId]);

  const updateBankTransaction = useCallback((id: string, updates: Partial<BankTransaction>) => {
    let prev: BankTransaction | undefined;
    setBankTransactions((list) => {
      prev = list.find((t) => t.id === id);
      return list.map((t) => (t.id === id ? { ...t, ...updates } : t));
    });
    (async () => {
      const row = bankTransactionToRow(updates);
      const { error: updErr } = await supabase.from('bank_transactions').update(row).eq('id', id);
      if (updErr) {
        console.error('[store] updateBankTransaction failed:', updErr);
        setError(updErr.message);
        if (prev) setBankTransactions((list) => list.map((t) => (t.id === id ? prev! : t)));
      }
    })();
  }, []);

  /**
   * Link a bank txn to an existing entry. Both sides hold the link:
   *   bank_transactions.entry_id ← entry.id
   *   entries.bank_transaction_id ← bank_txn.id
   */
  const reconcileToEntry = useCallback((bankTxnId: string, entryId: string) => {
    setBankTransactions((list) => list.map((t) => t.id === bankTxnId
      ? { ...t, status: 'matched', entryId }
      : t));
    setEntries((list) => list.map((e) => e.id === entryId
      ? { ...e, bankTransactionId: bankTxnId }
      : e));
    (async () => {
      const a = supabase.from('bank_transactions')
        .update({ status: 'matched', entry_id: entryId })
        .eq('id', bankTxnId);
      const b = supabase.from('entries')
        .update({ bank_transaction_id: bankTxnId })
        .eq('id', entryId);
      const [ra, rb] = await Promise.all([a, b]);
      if (ra.error || rb.error) {
        console.error('[store] reconcileToEntry failed:', ra.error || rb.error);
        setError((ra.error || rb.error)?.message ?? 'Reconcile failed');
      }
    })();
  }, []);

  /**
   * Create a new entry from a bank txn AND link them. Used for transactions
   * that don't already have a corresponding logged entry (e.g. swiping
   * something on the work card without thinking).
   */
  const reconcileAsNewEntry = useCallback((
    bankTxnId: string,
    entryInit: Omit<Entry, 'id' | 'businessId' | 'createdAt' | 'bankTransactionId'>,
  ) => {
    if (!businessId) return;
    const tempId = `ent_${Date.now()}`;
    const newEntry: Entry = {
      ...entryInit,
      id: tempId,
      businessId,
      bankTransactionId: bankTxnId,
      createdAt: new Date().toISOString(),
    };
    setEntries((prev) => [newEntry, ...prev]);
    setBankTransactions((list) => list.map((t) => t.id === bankTxnId
      ? { ...t, status: 'matched', entryId: tempId }
      : t));
    (async () => {
      const row = entryToRow({ ...newEntry, businessId });
      const { data, error: insErr } = await supabase
        .from('entries').insert(row).select('*').single();
      if (insErr || !data) {
        console.error('[store] reconcileAsNewEntry failed at insert:', insErr);
        setError(insErr?.message ?? 'Failed to log entry');
        setEntries((prev) => prev.filter((e) => e.id !== tempId));
        setBankTransactions((list) => list.map((t) => t.id === bankTxnId
          ? { ...t, status: 'unreconciled', entryId: undefined } : t));
        return;
      }
      const persisted = rowToEntry(data);
      setEntries((prev) => prev.map((e) => e.id === tempId ? persisted : e));
      // Now link the bank txn to the persisted entry id
      const { error: updErr } = await supabase
        .from('bank_transactions')
        .update({ status: 'matched', entry_id: persisted.id })
        .eq('id', bankTxnId);
      if (updErr) {
        console.error('[store] reconcileAsNewEntry failed at link:', updErr);
        setError(updErr.message);
        return;
      }
      setBankTransactions((list) => list.map((t) => t.id === bankTxnId
        ? { ...t, status: 'matched', entryId: persisted.id } : t));
    })();
  }, [businessId]);

  /**
   * Split-reconcile: create N entries from one bank txn, all sharing the
   * same bank_transaction_id. Use case: one Mitre 10 receipt covered three
   * jobs; one direct debit settled three Trademax bills. Bulk insert via
   * Supabase's array-payload .insert() so we make one round trip not N.
   */
  const reconcileAsSplitEntries = useCallback(async (
    bankTxnId: string,
    entryInits: Omit<Entry, 'id' | 'businessId' | 'createdAt' | 'bankTransactionId'>[],
  ): Promise<{ inserted: number; failed: number; error?: string }> => {
    if (!businessId) return { inserted: 0, failed: entryInits.length, error: 'No business loaded.' };
    if (entryInits.length === 0) return { inserted: 0, failed: 0 };

    // Optimistic prepend with temp ids — keeps the UI responsive while the
    // bulk insert flies through the network.
    const tempBase = Date.now();
    const optimistic: Entry[] = entryInits.map((init, i) => ({
      ...init,
      id: `ent_${tempBase}_${i}`,
      businessId,
      bankTransactionId: bankTxnId,
      createdAt: new Date().toISOString(),
    }));
    setEntries((prev) => [...optimistic, ...prev]);
    const tempIds = optimistic.map((e) => e.id);

    // Flip the bank txn to matched immediately too — same optimism. We'll
    // unwind it below if the insert fails.
    setBankTransactions((list) => list.map((t) => t.id === bankTxnId
      ? { ...t, status: 'matched', entryId: tempIds[0] } : t));

    // Bulk insert. One round trip.
    const payloads = optimistic.map((e) => entryToRow(e));
    const { data, error: insErr } = await supabase
      .from('entries')
      .insert(payloads)
      .select('*');

    if (insErr || !data) {
      const msg = describeError(insErr) || 'Failed to insert split entries';
      console.error('[store] reconcileAsSplitEntries failed:', msg);
      setError(msg);
      // Roll back: remove the optimistic entries, unmatch the bank txn.
      setEntries((prev) => prev.filter((e) => !tempIds.includes(e.id)));
      setBankTransactions((list) => list.map((t) => t.id === bankTxnId
        ? { ...t, status: 'unreconciled', entryId: undefined } : t));
      return { inserted: 0, failed: entryInits.length, error: msg };
    }

    // Replace temp ids with persisted rows.
    const persisted = data.map(rowToEntry);
    setEntries((prev) => {
      const withoutTemps = prev.filter((e) => !tempIds.includes(e.id));
      return [...persisted, ...withoutTemps];
    });

    // Link the bank txn to the first persisted entry (bank_transactions
    // schema only has a single entry_id column — picking the first is
    // arbitrary but consistent; the full audit trail lives on each
    // entry's bank_transaction_id).
    const firstId = persisted[0]?.id;
    if (firstId) {
      const { error: updErr } = await supabase
        .from('bank_transactions')
        .update({ status: 'matched', entry_id: firstId })
        .eq('id', bankTxnId);
      if (updErr) {
        console.warn('[store] reconcileAsSplitEntries: bank txn link update failed (entries still inserted):', describeError(updErr));
      } else {
        setBankTransactions((list) => list.map((t) => t.id === bankTxnId
          ? { ...t, status: 'matched', entryId: firstId } : t));
      }
    }

    return { inserted: persisted.length, failed: entryInits.length - persisted.length };
  }, [businessId]);

  // ── Quote template ─────────────────────────────────────────────────
  // The settings row keyed 'quote_template' holds a JSON blob; we
  // parse it on read and stringify on write. Migration 014 seeded a
  // default row for every business so there's normally something to
  // return — but we defend against null in case a future business is
  // somehow created without a seed.
  const getQuoteTemplate = useCallback((): QuoteTemplate | null => {
    const row = settings.find((s) => s.key === 'quote_template');
    if (!row || !row.value) return null;
    try {
      return JSON.parse(row.value) as QuoteTemplate;
    } catch (e) {
      console.error('[store] getQuoteTemplate: invalid JSON in settings row', e);
      return null;
    }
  }, [settings]);

  const saveQuoteTemplate = useCallback(async (
    template: QuoteTemplate,
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!businessId) {
      return { ok: false, error: 'No business loaded — try refreshing.' };
    }
    const valueJson = JSON.stringify(template);
    // Optimistic local update first so the UI reflects the new
    // values immediately. Rollback-on-failure mirrors the other
    // mutators in this file.
    const prev = settings.find((s) => s.key === 'quote_template');
    const now = new Date().toISOString();
    setSettings((list) => {
      const others = list.filter((s) => s.key !== 'quote_template');
      return [...others, {
        businessId,
        key: 'quote_template',
        value: valueJson,
        notes: prev?.notes,
        updatedAt: now,
      }];
    });

    const { error: upsertErr } = await supabase
      .from('settings')
      .upsert(
        { business_id: businessId, key: 'quote_template', value: valueJson },
        { onConflict: 'business_id,key' },
      );
    if (upsertErr) {
      console.error('[store] saveQuoteTemplate failed:', {
        message: upsertErr.message,
        code: upsertErr.code,
        details: upsertErr.details,
        hint: upsertErr.hint,
      });
      // Roll back to whatever was there before (or remove if we
      // just created it).
      setSettings((list) => {
        const others = list.filter((s) => s.key !== 'quote_template');
        return prev ? [...others, prev] : others;
      });
      return { ok: false, error: upsertErr.message };
    }
    return { ok: true };
  }, [businessId, settings]);

  const uploadBusinessLogo = useCallback(async (file: File): Promise<string | null> => {
    if (!businessId) {
      setError('No business loaded — try refreshing.');
      return null;
    }
    // Pick the extension off the original filename. Defaults to
    // 'png' for safety; the storage object's MIME type comes from
    // contentType below regardless.
    const ext = (file.name.split('.').pop() ?? 'png').toLowerCase().slice(0, 4);
    const path = `${businessId}/logo.${ext}`;

    // Compress images >500KB to keep PDFs small and uploads fast.
    // compressImage takes care of skipping SVGs / non-images internally,
    // so we only gate on size here. The returned CompressResult.file
    // is what we actually upload — same shape as the input File when
    // compression was skipped, or a fresh re-encoded File otherwise.
    let payload: File = file;
    if (file.size > 500_000) {
      try {
        const result = await compressImage(file);
        payload = result.file;
      } catch (e) {
        console.warn('[store] uploadBusinessLogo: compression failed, uploading original:', e);
      }
    }

    const { error: upErr } = await supabase.storage
      .from('business-logos')
      .upload(path, payload, {
        // upsert=true so re-uploading replaces the previous logo at
        // the same path without needing a separate delete.
        upsert: true,
        contentType: file.type || 'image/png',
        cacheControl: '3600',
      });
    if (upErr) {
      console.error('[store] uploadBusinessLogo failed:', {
        message: upErr.message,
        path,
        size: file.size,
      });
      setError(upErr.message);
      return null;
    }
    return path;
  }, [businessId]);

  const resolveLogoUrl = useCallback((storagePath: string | undefined | null): string | null => {
    if (!storagePath) return null;
    // The business-logos bucket is public, so getPublicUrl returns
    // a URL anyone can fetch — perfect for embedding in customer-
    // facing PDFs without juggling signed-URL expiry.
    const { data } = supabase.storage
      .from('business-logos')
      .getPublicUrl(storagePath);
    return data.publicUrl ?? null;
  }, []);

  return (
    <StoreContext.Provider
      value={{
        jobs, entries, scheduleItems, materials, quotes, settings, invoices, bankTransactions,
        jobImports, quoteAttachments,
        businessId, loading, error,
        addJob, updateJob, deleteJob, reconcileJobSchedule,
        addEntry, updateEntry, deleteEntry,
        addScheduleItem, updateScheduleItem, deleteScheduleItem,
        addInvoice, updateInvoice, markInvoicePaid,
        confirmBillDraft, confirmBillDraftWithMaterials,
        addMaterials, addMaterialFromOverhead,
        addQuoteAttachments, ensureJobHasQuote, deleteQuoteAttachment,
        updateQuote, deleteQuote,
        commitImportAsLink, commitImportAsCreate, commitImportAsSkip,
        importBankTransactions, updateBankTransaction, reconcileToEntry, reconcileAsNewEntry, reconcileAsSplitEntries,
        getQuoteTemplate, saveQuoteTemplate, uploadBusinessLogo, resolveLogoUrl,
        refresh: load,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}
