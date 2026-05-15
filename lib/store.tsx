'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from './supabase/client';
import {
  rowToJob, rowToEntry, rowToScheduleItem,
  rowToMaterial, rowToQuote, rowToSetting, rowToInvoice, rowToBankTransaction,
  jobToRow, entryToRow, scheduleItemToRow, invoiceToRow, bankTransactionToRow,
  materialToRow,
} from './supabase/mappers';
import type {
  Job, Entry, ScheduleItem, Material, Quote, Setting, Invoice, BankTransaction,
  JobStatus,
} from './types';

/**
 * Supabase's `PostgrestError` doesn't enumerate its fields (Chrome devtools
 * prints it as `{}`). This helper unwraps the relevant pieces into a plain
 * string so logs and `error` state are useful instead of cryptic.
 *
 * Always include code/details/hint when present — that's where the real
 * "what went wrong" usually lives (e.g. `PGRST116` = no rows, `42501` =
 * RLS denied, `23503` = FK violation).
 */
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
  businessId: string | null;
  loading: boolean;
  error: string | null;

  // Mutators — optimistic local update + Supabase write-behind.
  addJob: (job: Job) => void;
  updateJob: (id: string, updates: Partial<Job>) => void;
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
        setBankTransactions([]);
        setLoading(false);
        return;
      }
      const bizId = bizRows[0].id as string;
      setBusinessId(bizId);

      // Fetch all in parallel. Small dataset — fine for now.
      // Errors on individual tables (e.g. a missing-table during migration)
      // shouldn't take down the whole page. Each table degrades to an empty
      // array and the error is logged with full detail.
      const [j, e, s, m, q, st, inv, bnk] = await Promise.all([
        supabase.from('jobs').select('*').eq('business_id', bizId).order('created_at', { ascending: false }),
        supabase.from('entries').select('*').eq('business_id', bizId).order('entry_date', { ascending: false }),
        supabase.from('schedule_items').select('*').eq('business_id', bizId).order('date', { ascending: true }),
        supabase.from('materials').select('*').eq('business_id', bizId).order('used_on', { ascending: false }),
        supabase.from('quotes').select('*').eq('business_id', bizId).order('date_sent', { ascending: false }),
        supabase.from('settings').select('*').eq('business_id', bizId),
        supabase.from('invoices').select('*').eq('business_id', bizId).order('invoice_date', { ascending: false }),
        supabase.from('bank_transactions').select('*').eq('business_id', bizId).order('txn_date', { ascending: false }),
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

  // ── Mutators ─────────────────────────────────────────────────────────────
  // Each one updates local state immediately (optimistic) so the UI feels
  // instant, then writes to Supabase. On failure we roll back local state and
  // surface the error so it's not silently lost.

  const addJob = useCallback((job: Job) => {
    if (!businessId) {
      console.warn('[store] addJob called with no businessId; ignoring');
      return;
    }
    // Optimistic insert with the temporary id from the caller.
    setJobs((prev) => [job, ...prev]);
    const tempId = job.id;

    (async () => {
      const row = jobToRow({ ...job, businessId });
      const { data, error: insertErr } = await supabase
        .from('jobs').insert(row).select('*').single();
      if (insertErr || !data) {
        console.error('[store] addJob failed:', insertErr);
        setError(insertErr?.message ?? 'Failed to save job');
        // Roll back the optimistic insert
        setJobs((prev) => prev.filter((j) => j.id !== tempId));
        return;
      }
      // Replace the temporary row with the persisted one (real id, etc).
      const persisted = rowToJob(data);
      setJobs((prev) => prev.map((j) => (j.id === tempId ? persisted : j)));
    })();
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

  const addEntry = useCallback((entry: Entry) => {
    if (!businessId) {
      console.warn('[store] addEntry called with no businessId; ignoring');
      return;
    }
    setEntries((prev) => [entry, ...prev]);
    const tempId = entry.id;

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
    setEntries((prev) => {
      prevEntry = prev.find((e) => e.id === id);
      return prev.map((e) => (e.id === id ? { ...e, ...updates } : e));
    });

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
        console.error('[store] updateScheduleItem failed:', updErr);
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

  return (
    <StoreContext.Provider
      value={{
        jobs, entries, scheduleItems, materials, quotes, settings, invoices, bankTransactions,
        businessId, loading, error,
        addJob, updateJob, reconcileJobSchedule,
        addEntry, updateEntry, deleteEntry,
        addScheduleItem, updateScheduleItem, deleteScheduleItem,
        addInvoice, updateInvoice, markInvoicePaid,
        confirmBillDraft, confirmBillDraftWithMaterials,
        addMaterials,
        importBankTransactions, updateBankTransaction, reconcileToEntry, reconcileAsNewEntry,
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
