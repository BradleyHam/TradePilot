'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from './supabase/client';
import {
  rowToJob, rowToEntry, rowToScheduleItem,
  rowToMaterial, rowToQuote, rowToQuoteAttachment, rowToSetting, rowToInvoice, rowToBankTransaction,
  rowToJobImport,
  jobToRow, entryToRow, scheduleItemToRow, invoiceToRow, bankTransactionToRow,
  materialToRow, quoteToRow, quoteAttachmentToRow,
  rowToPaintStock, paintStockToRow,
  rowToBusinessMember, rowToShiftPhoto, rowToShiftReport, rowToJobVariation, rowToJobContact,
  rowToPayRun, payRunToRow,
  rowToJobAssignment, rowToScheduleAssignment,
} from './supabase/mappers';
import type {
  Job, Entry, EntryType, ActivityType, ScheduleItem, Material, Quote, Setting, Invoice, BankTransaction,
  JobImport, QuoteAttachment, QuoteAttachmentKind,
  JobStatus, QuoteTemplate, JobMarketing,
  PaintStockItem,
  BusinessMember, MemberRole, ShiftPhoto, ShiftReport, ShiftReportStatus, JobVariation, PayRun,
  JobAssignment, ScheduleAssignment,
  JobContact, ContactDirection, ContactChannel,
} from './types';
import { deriveWorkType } from './types';
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
    if (lower.includes('progress') || lower.includes('during') || lower.includes('wip')) return 'process_photo';
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
  /**
   * Paint inventory on hand (garage + van). Current-state rows mutated
   * as paint is used/bought — NOT a usage log (that's `materials`).
   */
  paintStock: PaintStockItem[];
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
  /**
   * The signed-in user's role in the current business. Drives UI gating
   * (employees don't see money). Defaults to 'owner' until the membership
   * row resolves (safe for the current single-user state — the real
   * money guard is RLS at the database, not this flag). See BusinessMember.
   */
  role: MemberRole;
  /** The signed-in user's membership row for this business, if resolved. */
  membership: BusinessMember | null;
  /**
   * ALL membership rows for the business (owner + employees). Populated
   * for owners only — employee RLS restricts them to their own row, and
   * the employee UI never needs the list. Drives the payroll flags and
   * the Settings → Team page.
   */
  teamMembers: BusinessMember[];
  /**
   * Wage payments to employees (fortnightly pay runs for Suzie). Rows
   * exist only for PAID periods — pending periods are computed on the
   * fly by lib/payroll.ts. Owner-only at the database (RLS); employees
   * always see an empty array.
   */
  payRuns: PayRun[];
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
  /**
   * Retire an unbilled-labour accrual: mark these hours entries as
   * invoiced by the worker, optionally linking the bill that covered
   * them. Once flagged they stop counting as money owed (see
   * `lib/labour-accrual.ts`) so the real bill is the only cost left —
   * without this the sub's hours and his invoice would both land on the
   * job. Set `billed = false` to undo.
   */
  markLabourBilled: (entryIds: string[], billEntryId: string | null, billed?: boolean) => void;
  /**
   * Employee-facing helper: log the signed-in user's OWN hours against a
   * job. Fills in businessId, workerKind (from the membership), and the
   * required `loggedByUserId = my auth uid` so the row satisfies the
   * employee RLS insert policy. Wraps addEntry, so it also triggers the
   * hours→in-progress auto-advance + schedule auto-complete. Owners can
   * use it too (defaults workerKind to 'owner').
   */
  logMyHours: (input: {
    /**
     * Omit for off-site work (admin / website / marketing / training):
     * those hours belong to no job, matching the app's overhead
     * convention. RLS permits a null job_id for hours (migration 038).
     */
    jobId?: string;
    hours: number;
    activity?: ActivityType;
    note?: string;
    entryDate?: string;
  }) => void;
  /**
   * Job-level assignments (who's on which job). Owner sees all rows;
   * employee RLS restricts to their own. Empty pre-migration-035.
   */
  jobAssignments: JobAssignment[];
  /**
   * Per-booking overrides. If a booking has ANY rows here, exactly those
   * people are on it that day; otherwise the job-level assignees are.
   */
  scheduleAssignments: ScheduleAssignment[];
  /**
   * Owner-only: replace the full assignee set for a job. Diffs against
   * current state — inserts the new, deletes the removed. Optimistic
   * with rollback.
   */
  setJobAssignees: (jobId: string, userIds: string[]) => Promise<void>;
  /**
   * Owner-only: set a per-booking override. Pass the exact people for
   * that day; pass [] to clear the override (booking inherits the job
   * team again).
   */
  setBookingAssignees: (scheduleItemId: string, userIds: string[]) => Promise<void>;
  /**
   * Owner-only: set a job's main image from an existing photo. `bucket`
   * is where the source object lives — 'shift-photos' (already readable
   * by staff, so the path is reused as-is) or 'quote-attachments' (owner-
   * only and full of priced PDFs, so the image is DOWNLOADED and RE-
   * UPLOADED into shift-photos; employees never get access to the source
   * bucket). Pass `null` to clear the cover and fall back to auto-pick.
   */
  setJobCoverPhoto: (
    jobId: string,
    source: { bucket: 'shift-photos' | 'quote-attachments'; path: string } | null,
  ) => Promise<void>;
  /** Site photos, filtered by RLS (employees see only their own uploads). */
  shiftPhotos: ShiftPhoto[];
  uploadShiftPhotos: (input: {
    jobId: string;
    takenOn: string;
    files: File[];
    entryId?: string;
  }) => Promise<{ inserted: number; failed: number; failedFiles: File[] }>;
  /** Owner-only review action. Shortlisting never publishes the photo. */
  updateShiftPhoto: (id: string, updates: Pick<ShiftPhoto, 'marketingCandidate'>) => void;
  deleteShiftPhoto: (id: string) => void;
  /** End-of-day staff handoffs, filtered by RLS for the current role. */
  shiftReports: ShiftReport[];
  saveShiftReport: (input: {
    jobId: string;
    workDate: string;
    status: ShiftReportStatus;
    note?: string;
  }) => Promise<ShiftReport | null>;
  /** Owner-only priced extra work and its client approval state. */
  jobVariations: JobVariation[];
  addJobVariation: (input: {
    jobId: string;
    shiftReportId?: string;
    title: string;
    description?: string;
    amountExGst: number;
    photoIds?: string[];
  }) => Promise<JobVariation | null>;
  /**
   * Every contact with a customer, both directions, newest first
   * (migration 042). Owner-only, so empty for employees.
   */
  jobContacts: JobContact[];
  /**
   * Log one contact and keep `job.lastContactedDate` in step with it.
   *
   * This is the ONLY way contact should be recorded — writing
   * `lastContactedDate` directly still works but silently drops the history,
   * which is the bug this whole table exists to fix.
   *
   * Fire-and-forget: the local row appears immediately and the write happens
   * behind it, because every caller is a one-tap button that must feel
   * instant. A failed insert rolls the optimistic row back.
   */
  logContact: (input: {
    jobId: string;
    direction?: ContactDirection;
    channel?: ContactChannel;
    note?: string;
    /** ISO timestamp. Defaults to now; pass a value to backdate. */
    contactedAt?: string;
  }) => void;
  addScheduleItem: (item: ScheduleItem) => void;
  updateScheduleItem: (id: string, updates: Partial<ScheduleItem>) => void;
  deleteScheduleItem: (id: string) => void;

  // Invoice mutators
  /**
   * Optimistically insert an invoice, then persist it. Resolves with the
   * persisted invoice (carrying its real Supabase UUID) once the row comes
   * back, or `null` if the insert failed (the optimistic row is rolled back
   * in that case). Await the result before chaining anything that references
   * the invoice by id — e.g. markInvoicePaid — so you never hit the DB with
   * the temporary `inv_…` client id.
   */
  addInvoice: (invoice: Invoice) => Promise<Invoice | null>;
  updateInvoice: (id: string, updates: Partial<Invoice>) => Promise<{ ok: boolean; error?: string }>;

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
   * Mark several existing bill entries as PAID against one bank payment.
   *
   * Use case: Brad pays 3–4 supplier invoices with a single transfer. Each
   * bill was already allocated to its job (via the Home confirm flow), so
   * all this does is settle them: set paid=true + paidDate (the bank payment
   * date, which is the correct claim date on payments-basis GST) + link each
   * to the bank transaction. The bank txn flips to 'matched'.
   *
   * Bills only count toward GST / income-tax / Money expense totals once
   * paid=true, so THIS is the step that moves them into the books — confirm
   * (isDraft=false) alone never sets paid.
   *
   * Optimistic with full rollback on failure. Returns counts.
   */
  markBillsPaid: (
    bankTxnId: string,
    billEntryIds: string[],
    paidDate: string,
  ) => Promise<{ updated: number; failed: number; error?: string }>;
  /**
   * Mark an invoice paid AND auto-create a linked income entry on the
   * payment date in one database transaction. Idempotent: if already paid,
   * no-op.
   */
  markInvoicePaid: (id: string, paidDate: string, paidVia?: string) => Promise<{ ok: boolean; error?: string }>;
  /** Safely reverse a mistaken payment without deleting imported/bank evidence. */
  unmarkInvoicePaid: (id: string) => Promise<{ ok: boolean; preservedEntry?: boolean; error?: string }>;
  /** Void an unpaid invoice. Paid invoices must be corrected first. */
  voidInvoice: (id: string, reason?: string) => Promise<{ ok: boolean; error?: string }>;

  /**
   * Record a pay run as PAID and auto-create the linked wages expense
   * entry (category 'labour', no GST — wages are outside the GST net) so
   * the gross lands in the books on the pay date. Mirrors the
   * invoice payment pattern.
   */
  addPayRun: (input: {
    memberId?: string;
    employeeName: string;
    periodStart: string;
    periodEnd: string;
    hours?: number;
    rate?: number;
    gross: number;
    paye?: number;
    net?: number;
    paidDate: string;
    notes?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Flip the IRD follow-up flags on a pay run (eiFiled / payePaid) or
   * patch its recorded figures. Optimistic + rollback.
   */
  updatePayRun: (id: string, patch: Partial<Pick<PayRun, 'eiFiled' | 'payePaid' | 'paye' | 'net' | 'notes'>>) => void;

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
   * Confirm a draft bill by SPLITTING its cost across multiple jobs.
   * Reuses the draft as slice #1 and inserts one extra `bill` entry per
   * additional job, all sharing a new bill_group_id and summing to the
   * original total. Each slice is a real bill entry, so per-job profit /
   * GST / Money pick it up with no other changes; line items are also
   * written as materials for the per-job detail (materials with
   * source='bill' are not double-counted by job-stats).
   *
   * `slices` ex-GST amounts must already sum to the bill's ex-GST total
   * (the caller scales them by line-cost share); this derives gross + GST
   * and pins any rounding remainder to the last slice.
   */
  confirmBillDraftAsSplit: (
    billId: string,
    slices: { jobId: string | null; exGst: number }[],
    materials: Omit<Material, 'id' | 'businessId' | 'createdAt'>[],
  ) => Promise<void>;

  /**
   * Re-allocate a CONFIRMED bill across jobs after the fact — the
   * post-confirm sibling of confirmBillDraftAsSplit. Operates on the whole
   * bill_group (the entry plus any split siblings), replacing the current
   * allocation with `slices`:
   *
   *   - 1 slice  → collapse back to a single entry on that job (siblings
   *                deleted, bill_group_id cleared, full amount restored).
   *   - N slices → primary entry becomes slice #1; siblings are recreated
   *                to match slices 2..N (shared bill_group_id).
   *
   * The primary entry (the one carrying source_message_id / materials /
   * parser_raw) is always KEPT — only derived siblings are deleted and
   * re-inserted, so idempotency and line-item provenance survive any
   * number of re-allocations. Slices must sum to the group's ex-GST total
   * (±$0.02; drift is pinned to the last slice). If the bill is already
   * paid, paid + paid_date are copied onto every slice so GST timing and
   * expense totals are unchanged — re-allocation only ever moves cost
   * BETWEEN jobs, never in or out of the books.
   */
  reallocateBill: (
    billId: string,
    slices: { jobId: string | null; exGst: number }[],
  ) => Promise<{ ok: boolean; error?: string }>;

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
    files: { file: File; kind: QuoteAttachmentKind; skipCompression?: boolean }[],
    options?: {
      /**
       * Called after each file finishes (success OR failure) with the
       * number done so far and the batch total. Lets callers show live
       * "Uploading 3 of 8…" progress instead of a frozen spinner — see
       * SiteVisitWrapUpSheet, where a 10-photo save used to sit on a
       * static "Saving…" for a minute.
       */
      onProgress?: (done: number, total: number) => void;
    },
  ) => Promise<{ inserted: number; failed: number; ids: string[] }>;

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
      lostReason?: import('./types').LostReason;
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

  /**
   * Read a job's marketing metadata (description, publish status, hero
   * image) from the settings-backed store. Returns null when the job has
   * no marketing row yet. No DB round-trip — settings are already loaded.
   */
  getJobMarketing: (jobId: string) => JobMarketing | null;
  /**
   * Save (merge) a job's marketing metadata. Stored as a JSON blob in the
   * settings row keyed `marketing:{jobId}` — same mechanism as
   * saveQuoteTemplate, so no migration is needed. Only the fields you pass
   * are changed; the rest are preserved. Optimistic + rollback on failure.
   */
  saveJobMarketing: (
    jobId: string,
    updates: Partial<Pick<JobMarketing, 'title' | 'description' | 'overview' | 'services' | 'status' | 'heroAttachmentId' | 'heroMode' | 'heroBeforeId' | 'heroAfterId' | 'excludedImageIds' | 'review' | 'facebook' | 'instagram'>>,
  ) => Promise<{ ok: boolean; error?: string }>;

  /**
   * Paint stock mutators. Same optimistic + rollback contract as
   * everything else. addPaintStock resolves with the persisted id so
   * the UI can focus/animate the new row.
   */
  addPaintStock: (
    item: Omit<PaintStockItem, 'id' | 'businessId' | 'createdAt' | 'updatedAt'>,
  ) => Promise<{ ok: boolean; id?: string; error?: string }>;
  updatePaintStock: (id: string, updates: Partial<PaintStockItem>) => void;
  deletePaintStock: (id: string) => void;

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
  const [paintStock, setPaintStock] = useState<PaintStockItem[]>([]);
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
  const [shiftPhotos, setShiftPhotos] = useState<ShiftPhoto[]>([]);
  const [shiftReports, setShiftReports] = useState<ShiftReport[]>([]);
  const [jobVariations, setJobVariations] = useState<JobVariation[]>([]);
  const [jobContacts, setJobContacts] = useState<JobContact[]>([]);
  const [teamMembers, setTeamMembers] = useState<BusinessMember[]>([]);
  const [jobAssignments, setJobAssignments] = useState<JobAssignment[]>([]);
  const [scheduleAssignments, setScheduleAssignments] = useState<ScheduleAssignment[]>([]);
  // Refs so the assign mutators can diff against current state without
  // stale-closure risk (same pattern as jobsRef / jobImportsRef).
  const jobAssignmentsRef = useRef(jobAssignments);
  const scheduleAssignmentsRef = useRef(scheduleAssignments);
  /* eslint-disable react-hooks/refs */
  jobAssignmentsRef.current = jobAssignments;
  scheduleAssignmentsRef.current = scheduleAssignments;
  /* eslint-enable react-hooks/refs */
  const [payRuns, setPayRuns] = useState<PayRun[]>([]);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [role, setRole] = useState<MemberRole>('owner');
  const [membership, setMembership] = useState<BusinessMember | null>(null);
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
        setPaintStock([]); setShiftPhotos([]); setShiftReports([]); setJobVariations([]);
        setLoading(false);
        return;
      }
      const bizId = bizRows[0].id as string;
      setBusinessId(bizId);

      // Resolve the signed-in user's role in this business. Best-effort:
      // if the business_members table doesn't exist yet (migration 025 not
      // applied) or there's no row for this user, we DON'T block the app —
      // we fall back to 'owner' so Brad's single-user experience is
      // unchanged. This flag only drives UI gating; the real money guard
      // is RLS. Employees will always have a membership row (they can't
      // sign in without one being created).
      // Local copy (state setters don't update mid-run) so the jobs fetch
      // below can pick the money-free `jobs_public` view for employees.
      let resolvedRole: MemberRole = 'owner';
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: memRows, error: memErr } = await supabase
            .from('business_members')
            .select('*')
            .eq('business_id', bizId)
            .eq('user_id', user.id)
            .limit(1);
          if (memErr) {
            // Table missing / RLS / migration pending — log, keep owner default.
            console.warn('[store] business_members lookup failed (defaulting role=owner):', memErr.message);
            setMembership(null);
            setRole('owner');
          } else if (memRows && memRows.length > 0) {
            const mem = rowToBusinessMember(memRows[0]);
            setMembership(mem);
            setRole(mem.role);
            resolvedRole = mem.role;
          } else {
            // No membership row yet (e.g. owner backfill not run). Owner default.
            setMembership(null);
            setRole('owner');
          }
        }
      } catch (roleErr) {
        console.warn('[store] role resolution threw (defaulting role=owner):', describeError(roleErr));
        setMembership(null);
        setRole('owner');
      }

      // Fetch all in parallel. Small dataset — fine for now.
      // Errors on individual tables (e.g. a missing-table during migration)
      // shouldn't take down the whole page. Each table degrades to an empty
      // array and the error is logged with full detail.
      // Employees can't read the base `jobs` table (owner-only RLS) — they
      // read the money-free `jobs_public` view instead. rowToJob tolerates
      // the missing money columns (they map to undefined). Owners read the
      // full base table as before.
      const jobsSource = resolvedRole === 'employee' ? 'jobs_public' : 'jobs';
      const [j, e, s, m, q, st, inv, bnk, ji, qa, ps, sp, sr, jv, tm, pr, ja, sa, jc] = await Promise.all([
        supabase.from(jobsSource).select('*').eq('business_id', bizId).order('created_at', { ascending: false }),
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
        // Paint stock — small table, degrades to empty like the others
        // if migration 024 hasn't been applied yet.
        supabase.from('paint_stock').select('*').eq('business_id', bizId)
          .order('created_at', { ascending: true }),
        // Shift photos — employees see only their own (RLS); owner sees all.
        // Degrades to empty if migration 027 hasn't been applied yet.
        supabase.from('shift_photos').select('*').eq('business_id', bizId)
          .order('created_at', { ascending: false }),
        // End-of-day handoffs — employees see their own, owner sees all.
        // Log-only on failure so a pending migration never blanks the app.
        supabase.from('shift_reports').select('*').eq('business_id', bizId)
          .order('work_date', { ascending: false })
          .order('updated_at', { ascending: false }),
        // Priced variations are owner-only. Employee RLS returns an empty
        // list, preserving the existing money-blind staff experience.
        supabase.from('job_variations').select('*').eq('business_id', bizId)
          .order('created_at', { ascending: false }),
        // Team members — owner reads all rows (RLS); employees only their
        // own. Drives payroll flags + Settings → Team.
        supabase.from('business_members').select('*').eq('business_id', bizId)
          .order('created_at', { ascending: true }),
        // Pay runs — owner-only (RLS); employees degrade to empty, as does
        // the whole app if migration 032 hasn't been applied yet.
        supabase.from('pay_runs').select('*').eq('business_id', bizId)
          .order('period_start', { ascending: false }),
        // Assignments — owner sees all (RLS); employees only their own
        // rows. Both degrade to empty pre-migration-035 (log-only below,
        // like pay_runs, so a pending migration doesn't banner the app).
        supabase.from('job_assignments').select('*').eq('business_id', bizId),
        supabase.from('schedule_assignments').select('*').eq('business_id', bizId),
        // Contact log — owner-only (RLS), so employees degrade to empty, as
        // does everyone if migration 042 hasn't been applied yet. Newest first
        // so the per-job timeline needs no re-sort.
        supabase.from('job_contacts').select('*').eq('business_id', bizId)
          .order('contacted_at', { ascending: false }),
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
      collect('paint_stock', ps); collect('shift_photos', sp);
      collect('business_members', tm);
      // pay_runs is deliberately NOT collected into tableErrors — before
      // migration 032 runs, the table doesn't exist, and that shouldn't
      // put a permanent warning banner on the app. It logs below instead.

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
      setPaintStock((ps.data ?? []).map(rowToPaintStock));
      setShiftPhotos((sp.data ?? []).map(rowToShiftPhoto));
      if (sr.error) console.warn('[store] shift_reports load failed (migration 050 applied?):', sr.error.message);
      setShiftReports((sr.data ?? []).map(rowToShiftReport));
      if (jv.error) console.warn('[store] job_variations load failed (migration 051 applied?):', jv.error.message);
      setJobVariations((jv.data ?? []).map(rowToJobVariation));
      setTeamMembers((tm.data ?? []).map(rowToBusinessMember));
      if (pr.error) console.warn('[store] pay_runs load failed (migration 032 applied?):', pr.error.message);
      setPayRuns((pr.data ?? []).map(rowToPayRun));
      if (ja.error) console.warn('[store] job_assignments load failed (migration 035 applied?):', ja.error.message);
      setJobAssignments((ja.data ?? []).map(rowToJobAssignment));
      if (sa.error) console.warn('[store] schedule_assignments load failed (migration 035 applied?):', sa.error.message);
      setScheduleAssignments((sa.data ?? []).map(rowToScheduleAssignment));
      if (jc.error) console.warn('[store] job_contacts load failed (migration 042 applied?):', jc.error.message);
      setJobContacts((jc.data ?? []).map(rowToJobContact));
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
    // Keep the derived single-value summary in step with the set, in the
    // LOCAL state too. jobToRow does the same for the DB write, but the
    // optimistic object here is what every screen renders until the next
    // refetch — without this, re-tagging a job would leave the leads
    // filter and the marketing service mapper reading the old bucket
    // right up until a reload.
    if (updates.workTypes !== undefined && updates.workType === undefined) {
      updates = { ...updates, workType: deriveWorkType(updates.workTypes) };
    }
    // Stamp the moment a job is accepted (migration 041). Done HERE — the one
    // choke point every in-app job write passes through — rather than in the
    // status dropdown handler, so any future "mark accepted" path gets it for
    // free instead of each caller having to remember. (The finance importer
    // writes rows directly and bypasses this; migration 041's backfill is what
    // covers those.)
    //
    // Read from jobsRef, not the `prevJob` captured below: that's assigned
    // inside the setJobs updater, which React may not run until render, so it
    // can still be undefined at this point in the tick.
    //
    // Write-once by design. `!existing.acceptedAt` means a job that goes
    // accepted → lost → accepted again keeps its ORIGINAL yes-date, which is
    // the honest answer for "how long did it take them to say yes". An
    // explicit acceptedAt in the patch always wins, so a correction is still
    // possible.
    if (
      updates.status === 'accepted' &&
      updates.acceptedAt === undefined
    ) {
      const existing = jobsRef.current.find((j) => j.id === id);
      if (existing && !existing.acceptedAt) {
        updates = { ...updates, acceptedAt: new Date().toISOString() };
      }
    }
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
    const TERMINAL: JobStatus[] = ['completed', 'invoiced', 'paid', 'lost', 'declined'];
    const isNowTerminal = !!(updates.status && TERMINAL.includes(updates.status));
    const wasTerminal = !!(prevJob?.status && TERMINAL.includes(prevJob.status));
    if (isNowTerminal && !wasTerminal) {
      // `pruneFuture` = "this job never happened, bin the future plans".
      // True for both ways a job ends without work: lost (we didn't get it)
      // and declined (we said no). Declining a job that was already booked
      // is the case that most needs this — otherwise its work days sit on
      // the calendar blocking availability for work Brad could take.
      const neverHappened = updates.status === 'lost' || updates.status === 'declined';
      reconcileJobSchedule(id, neverHappened).catch((err) => {
        console.error('[store] auto-reconcile after status change failed:', describeError(err));
      });
    }
  }, [reconcileJobSchedule]);

  /**
   * Log one contact with a customer (migration 042) and keep the job's
   * `lastContactedDate` cache in step.
   *
   * ## Why both writes
   *
   * `job_contacts` is the history and the truth. `jobs.last_contacted_date`
   * is a denormalised copy of the newest contact in EITHER direction (see
   * below), kept because the chase-list sort, the lead temperature badge and
   * the follow-up ladder all read it directly — and rewriting those to scan
   * an event log would be a much bigger change than this feature is worth.
   * Two writes, one source of truth, no behaviour change downstream.
   *
   * ## Inbound moves the cache too
   *
   * Deliberately. A customer replying absolutely means the lead has
   * been touched and shouldn't be chased tomorrow — the follow-up ladder's
   * whole question is "has anything happened since the quote went out?", and
   * a reply is the strongest possible yes. The direction is preserved in the
   * log for analysis; the cache just records that contact occurred.
   *
   * ## Backdating
   *
   * The quote catch-up flow logs contacts that happened days ago. Those must
   * NOT drag the cache backwards past a more recent contact, so the cache is
   * only advanced when the new contact is actually the newest one.
   */
  const logContact = useCallback((input: {
    jobId: string;
    direction?: ContactDirection;
    channel?: ContactChannel;
    note?: string;
    contactedAt?: string;
  }) => {
    if (!businessId) return;
    const contactedAt = input.contactedAt ?? new Date().toISOString();
    const direction: ContactDirection = input.direction ?? 'out';
    const channel: ContactChannel = input.channel ?? 'unknown';
    const uid = membership?.userId ?? null;

    // Optimistic row with a temporary id, swapped for the real one below.
    // Every caller is a one-tap button, so the UI can't wait on the network.
    const tempId = `tmp-${crypto.randomUUID()}`;
    const optimistic: JobContact = {
      id: tempId,
      businessId,
      jobId: input.jobId,
      contactedAt,
      direction,
      channel,
      note: input.note,
      createdAt: new Date().toISOString(),
    };
    setJobContacts((prev) => [optimistic, ...prev]);

    // Advance the cache only if this really is the newest contact — see the
    // backdating note above.
    const existing = jobsRef.current.find((j) => j.id === input.jobId);
    if (!existing?.lastContactedDate || contactedAt > existing.lastContactedDate) {
      updateJob(input.jobId, { lastContactedDate: contactedAt });
    }

    (async () => {
      const { data, error: insErr } = await supabase
        .from('job_contacts')
        .insert({
          business_id: businessId,
          job_id: input.jobId,
          contacted_at: contactedAt,
          direction,
          channel,
          note: input.note ?? null,
          logged_by: uid,
        })
        .select('*')
        .single();
      if (insErr || !data) {
        console.error('[store] logContact failed:', describeError(insErr));
        // Drop the optimistic row. The lastContactedDate bump is left alone
        // on purpose: the old single-column behaviour is what the app had
        // before this table existed, so a failed log degrades to exactly
        // that rather than losing the chase entirely.
        setJobContacts((prev) => prev.filter((c) => c.id !== tempId));
        return;
      }
      const saved = rowToJobContact(data);
      setJobContacts((prev) => prev.map((c) => (c.id === tempId ? saved : c)));
    })();
  }, [businessId, membership?.userId, updateJob]);

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

  /**
   * Auto-advance a job to `in-progress` the moment real hours are logged
   * against it. Logging hours IS the act of starting the job, so Brad
   * shouldn't have to also tap the status dropdown.
   *
   * FORWARD-ONLY and conservative. It only ever promotes from a PRE-START status
   * (lead / quoted / accepted / booked) up to `in-progress`. It never
   * demotes a job that's already further along (`in-progress`, or the
   * terminal `completed` / `invoiced` / `paid` / `lost`) — so logging a
   * late/backdated hour on a finished job can't drag it back to active.
   *
   * Inline ref-reading helper (same shape as
   * `maybeCompleteJobBookingForEntry` above).
   */
  function maybeAdvanceJobToInProgress(entry: { type?: EntryType; jobId?: string; hours?: number }) {
    if (entry.type !== 'hours') return;
    if (!entry.jobId) return;
    if (!entry.hours || entry.hours <= 0) return;

    const job = jobsRef.current.find((j) => j.id === entry.jobId);
    if (!job) return;

    // Only promote from a status that sits BEFORE in-progress in the chain.
    const PRE_START: JobStatus[] = ['lead', 'quoted', 'accepted', 'booked'];
    if (!PRE_START.includes(job.status)) return;

    // eslint-disable-next-line no-console
    console.log('[store] hours logged → auto-advancing job to in-progress', {
      jobId: job.id, from: job.status,
    });
    updateJob(job.id, { status: 'in-progress' });
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
    // Logging hours starts the job — bump status to in-progress if it's
    // still sitting in a pre-start state. Forward-only; see helper.
    maybeAdvanceJobToInProgress(entry);

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
    // Same for the in-progress bump — e.g. an entry that just gained a
    // jobId, or was switched to type 'hours', should start its job.
    if (nextEntry) maybeAdvanceJobToInProgress(nextEntry);

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
   * Flag hours entries as invoiced by the worker, so their accrued cost
   * stops counting (the incoming bill takes over). One round trip for the
   * whole set — bills usually cover several shifts at once. Optimistic +
   * rollback like every other mutator.
   */
  const markLabourBilled = useCallback((
    entryIds: string[],
    billEntryId: string | null,
    billed: boolean = true,
  ) => {
    if (entryIds.length === 0) return;
    const ids = new Set(entryIds);
    let prevEntries: Entry[] = [];
    setEntries((prev) => {
      prevEntries = prev.filter((e) => ids.has(e.id));
      return prev.map((e) => (ids.has(e.id)
        ? { ...e, labourBilled: billed, labourBillEntryId: billed ? (billEntryId ?? undefined) : undefined }
        : e));
    });

    (async () => {
      const { error: updErr } = await supabase
        .from('entries')
        .update({ labour_billed: billed, labour_bill_entry_id: billed ? billEntryId : null })
        .in('id', entryIds);
      if (updErr) {
        console.error('[store] markLabourBilled failed:', updErr);
        setError(updErr.message);
        // Roll the whole set back — a half-applied flag would leave some
        // hours accruing and some not, with nothing on screen saying so.
        setEntries((prev) => prev.map((e) => prevEntries.find((p) => p.id === e.id) ?? e));
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

  // ── Paint stock ───────────────────────────────────────────────────────────
  // Inventory on hand, not a usage log. Same optimistic + rollback
  // contract as everything else in here.

  const addPaintStock = useCallback(async (
    item: Omit<PaintStockItem, 'id' | 'businessId' | 'createdAt' | 'updatedAt'>,
  ): Promise<{ ok: boolean; id?: string; error?: string }> => {
    if (!businessId) return { ok: false, error: 'No business loaded.' };

    const tempId = `ps_${Date.now()}`;
    const nowIso = new Date().toISOString();
    const optimistic: PaintStockItem = {
      ...item,
      id: tempId,
      businessId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    setPaintStock((prev) => [...prev, optimistic]);

    const payload = {
      ...paintStockToRow(item),
      business_id: businessId,
    };

    const { data, error: insErr } = await supabase
      .from('paint_stock')
      .insert(payload)
      .select('*')
      .single();

    if (insErr || !data) {
      const msg = describeError(insErr) || 'Failed to add stock item';
      console.error('[store] addPaintStock failed:', msg);
      setError(msg);
      setPaintStock((prev) => prev.filter((p) => p.id !== tempId));
      return { ok: false, error: msg };
    }

    const persisted = rowToPaintStock(data);
    setPaintStock((prev) => prev.map((p) => (p.id === tempId ? persisted : p)));
    return { ok: true, id: persisted.id };
  }, [businessId]);

  const updatePaintStock = useCallback((id: string, updates: Partial<PaintStockItem>) => {
    let prevItem: PaintStockItem | undefined;
    const nowIso = new Date().toISOString();
    setPaintStock((prev) => {
      prevItem = prev.find((p) => p.id === id);
      return prev.map((p) => (p.id === id ? { ...p, ...updates, updatedAt: nowIso } : p));
    });

    (async () => {
      const row = { ...paintStockToRow(updates), updated_at: nowIso };
      const { error: updErr } = await supabase.from('paint_stock').update(row).eq('id', id);
      if (updErr) {
        console.error('[store] updatePaintStock failed:', describeError(updErr));
        setError(describeError(updErr));
        if (prevItem) {
          setPaintStock((prev) => prev.map((p) => (p.id === id ? prevItem! : p)));
        }
      }
    })();
  }, []);

  const deletePaintStock = useCallback((id: string) => {
    let prevItem: PaintStockItem | undefined;
    setPaintStock((prev) => {
      prevItem = prev.find((p) => p.id === id);
      return prev.filter((p) => p.id !== id);
    });

    (async () => {
      const { error: delErr } = await supabase.from('paint_stock').delete().eq('id', id);
      if (delErr) {
        console.error('[store] deletePaintStock failed:', describeError(delErr));
        setError(describeError(delErr));
        if (prevItem) {
          setPaintStock((prev) => [...prev, prevItem!]);
        }
      }
    })();
  }, []);

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
   * Files are processed with limited concurrency (3 in flight at a
   * time) — enough parallelism that an 8-photo wrap-up doesn't take a
   * minute of strictly-serial round-trips, capped so a slow rural
   * connection isn't saturated by 10 simultaneous uploads. Each failure
   * is logged but doesn't abort the batch — the user gets a partial
   * success summary at the end.
   *
   * `options.onProgress(done, total)` fires as each file settles
   * (success or failure), so callers can render live progress.
   *
   * Filenames are sanitised to ASCII-safe characters because Supabase
   * Storage rejects some Unicode patterns; the original name is
   * preserved in the file_name column so the UI can still show it.
   */
  const addQuoteAttachments = useCallback(async (
    quoteId: string,
    files: { file: File; kind: QuoteAttachmentKind; skipCompression?: boolean }[],
    options?: { onProgress?: (done: number, total: number) => void },
  ): Promise<{ inserted: number; failed: number; ids: string[] }> => {
    if (!businessId || files.length === 0) return { inserted: 0, failed: 0, ids: [] };
    // Capture the narrowed value — the `!businessId` guard above doesn't
    // propagate into the nested processOne closure, so TS sees
    // `string | null` again inside it.
    const biz = businessId;

    const total = files.length;
    let inserted = 0;
    let failed = 0;
    let done = 0;
    // ids collected per-slot then flattened, so the order of the result
    // matches the order files were passed in even though slots finish
    // out of order. Callers (e.g. testimonial panel) index into ids.
    const idSlots: (string | null)[] = new Array(total).fill(null);

    // Process one file end-to-end: compress → upload → insert row.
    // Returns nothing; records its outcome in the shared counters.
    // Counter updates are safe without locks — JS is single-threaded,
    // and each `await` boundary only interleaves whole statements.
    async function processOne(index: number): Promise<void> {
      const { file, kind, skipCompression } = files[index];
      try {
        // Compress images. Non-images pass through unchanged. Callers can
        // opt out (skipCompression) for images that are already optimally
        // encoded — e.g. the generated testimonial card, a flat-colour PNG
        // that JPEG re-encoding would only smear.
        const { file: prepared, originalSize, compressedSize, skipped } = skipCompression
          ? { file, originalSize: file.size, compressedSize: file.size, skipped: true }
          : await compressImage(file);
        if (!skipped && originalSize > 0) {
          const savedPct = Math.round((1 - compressedSize / originalSize) * 100);
          console.info(`[addQuoteAttachments] compressed ${file.name}: ${(originalSize / 1024).toFixed(0)}KB → ${(compressedSize / 1024).toFixed(0)}KB (-${savedPct}%)`);
        }

        const safeName = prepared.name.replace(/[^a-zA-Z0-9._-]+/g, '_');
        const storagePath = `${biz}/${quoteId}/${crypto.randomUUID()}__${safeName}`;

        const { error: upErr } = await supabase.storage
          .from('quote-attachments')
          .upload(storagePath, prepared, {
            contentType: prepared.type || 'application/octet-stream',
            upsert: false,
          });
        if (upErr) {
          console.error('[addQuoteAttachments] upload failed for', file.name, '—', describeError(upErr));
          failed++;
          return;
        }

        const { data: insData, error: insErr } = await supabase
          .from('quote_attachments')
          .insert(quoteAttachmentToRow({
            businessId: biz,
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
          return;
        }

        const persisted = rowToQuoteAttachment(insData);
        setQuoteAttachments((prev) => [persisted, ...prev]);
        idSlots[index] = persisted.id;
        inserted++;
      } catch (err) {
        console.error('[addQuoteAttachments] unexpected error for', file.name, err);
        failed++;
      } finally {
        done++;
        options?.onProgress?.(done, total);
      }
    }

    // Simple worker pool: N workers each pull the next un-claimed index.
    const CONCURRENCY = 3;
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, total) },
      async () => {
        while (nextIndex < total) {
          const index = nextIndex++;
          await processOne(index);
        }
      },
    );
    await Promise.all(workers);

    if (failed > 0) {
      setError(`${failed} of ${files.length} uploads failed — check console for details.`);
    }
    return { inserted, failed, ids: idSlots.filter((id): id is string => id !== null) };
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

  const confirmBillDraftAsSplit = useCallback(async (
    billId: string,
    slices: { jobId: string | null; exGst: number }[],
    materials: Omit<Material, 'id' | 'businessId' | 'createdAt'>[],
  ): Promise<void> => {
    if (billId.startsWith('ent_')) {
      setError('Still saving the bill — give it a moment and try again.');
      return;
    }
    if (!businessId) return;
    // Fewer than 2 slices isn't a split — fall back to the single-job path.
    if (slices.length < 2) {
      await confirmBillDraftWithMaterials(billId, { jobId: slices[0]?.jobId ?? null, materials });
      return;
    }

    // Read the draft from the latest entries. This callback is recreated
    // whenever `entries` changes (see deps), so it's current at click time.
    const d = entries.find((e) => e.id === billId);
    if (!d) { setError('Could not find the bill to split.'); return; }

    const NZ_GST_RATE = 0.15;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const gstApplies = d.gstApplies;
    const grossTotal = d.amount ?? r2(slices.reduce((s, x) => s + x.exGst, 0) * (gstApplies ? 1 + NZ_GST_RATE : 1));

    // Derive gross + GST per slice; pin the rounding remainder to the last
    // slice so the slices sum to the bill total to the cent.
    const computed = slices.map((s) => {
      const ex = r2(s.exGst);
      const gross = gstApplies ? r2(ex * (1 + NZ_GST_RATE)) : ex;
      return { jobId: s.jobId, ex, gross, gst: r2(gross - ex) };
    });
    const drift = r2(grossTotal - computed.reduce((s, x) => s + x.gross, 0));
    if (drift !== 0) {
      const last = computed[computed.length - 1];
      last.gross = r2(last.gross + drift);
      last.gst = r2(last.gross - last.ex);
    }

    const groupId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID() : `grp_${Date.now()}`;
    const [first, ...rest] = computed;

    // Optimistic local state: draft becomes slice #1; siblings prepend.
    const prevDraft = d;
    const siblingLocal: Entry[] = rest.map((s, i) => ({
      id: `ent_${Date.now()}_${i}`,
      businessId,
      jobId: s.jobId ?? undefined,
      type: 'bill',
      isDraft: false,
      paid: false,
      company: d.company,
      supplier: d.supplier,
      description: d.description,
      amount: s.gross,
      gstApplies,
      amountExGst: s.ex,
      gstComponent: s.gst,
      entryDate: d.entryDate,
      dueDate: d.dueDate,
      paymentRef: d.paymentRef,
      billPdfUrl: d.billPdfUrl,
      parserConfidence: d.parserConfidence,
      billGroupId: groupId,
      createdAt: new Date().toISOString(),
    }));
    const tempIds = siblingLocal.map((s) => s.id);
    setEntries((list) => {
      const updated = list.map((e) => e.id === billId
        ? { ...e, isDraft: false, jobId: first.jobId ?? undefined, amount: first.gross, amountExGst: first.ex, gstComponent: first.gst, billGroupId: groupId }
        : e);
      return [...siblingLocal, ...updated];
    });

    // Persist. Raw column objects (not entryToRow) so job_id can be set to
    // null directly for overhead slices. Siblings deliberately do NOT carry
    // source_message_id — only the original draft keeps it (the unique
    // (business_id, source_message_id) index must not see duplicates).
    const updateDraft = supabase.from('entries').update({
      is_draft: false,
      job_id: first.jobId,
      amount: first.gross,
      amount_ex_gst: first.ex,
      gst_component: first.gst,
      bill_group_id: groupId,
    }).eq('id', billId);
    const siblingRows = rest.map((s, i) => ({
      business_id: businessId,
      job_id: computed[i + 1].jobId,
      type: 'bill',
      is_draft: false,
      paid: false,
      company: d.company ?? null,
      supplier: d.supplier ?? null,
      description: d.description,
      amount: computed[i + 1].gross,
      amount_ex_gst: computed[i + 1].ex,
      gst_component: computed[i + 1].gst,
      gst_applies: gstApplies,
      entry_date: d.entryDate,
      due_date: d.dueDate ?? null,
      payment_ref: d.paymentRef ?? null,
      bill_pdf_url: d.billPdfUrl ?? null,
      parser_confidence: d.parserConfidence ?? null,
      bill_group_id: groupId,
      created_at: new Date().toISOString(),
    }));
    const [updRes, insRes] = await Promise.all([
      updateDraft,
      supabase.from('entries').insert(siblingRows).select('*'),
    ]);

    if (updRes.error || insRes.error || !insRes.data) {
      const msg = describeError(updRes.error || insRes.error) || 'Failed to split the bill';
      console.error('[store] confirmBillDraftAsSplit failed:', msg);
      setError(msg);
      setEntries((list) => list
        .filter((e) => !tempIds.includes(e.id))
        .map((e) => e.id === billId ? prevDraft : e));
      return;
    }

    // Swap temp sibling ids for persisted rows.
    const persisted = insRes.data.map(rowToEntry);
    setEntries((list) => {
      const withoutTemps = list.filter((e) => !tempIds.includes(e.id));
      return [...persisted, ...withoutTemps];
    });

    // Materials (best-effort) — linked to the original draft (slice #1) for
    // provenance. Their per-line job_id drives which job they display on;
    // job-stats excludes source='bill' materials from cost, so no double count.
    if (materials.length > 0) {
      const stamped = materials.map((m) => ({ ...m, entryId: billId }));
      const { failed } = await addMaterials(stamped);
      if (failed > 0) console.error('[store] confirmBillDraftAsSplit: materials partial failure', { failed, billId });
    }
  }, [businessId, entries, confirmBillDraftWithMaterials, addMaterials]);

  const reallocateBill = useCallback(async (
    billId: string,
    slices: { jobId: string | null; exGst: number }[],
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!businessId) return { ok: false, error: 'No business loaded yet.' };
    if (slices.length === 0) return { ok: false, error: 'Nothing to allocate.' };
    if (billId.startsWith('ent_')) {
      const msg = 'Still saving the bill — give it a moment and try again.';
      setError(msg);
      return { ok: false, error: msg };
    }

    const target = entries.find((e) => e.id === billId);
    if (!target || target.type !== 'bill') {
      const msg = 'Could not find the bill to re-allocate.';
      setError(msg);
      return { ok: false, error: msg };
    }
    if (target.isDraft) {
      // Drafts go through the confirm flow — this mutator is post-confirm only.
      const msg = 'Confirm the bill first, then re-allocate it.';
      setError(msg);
      return { ok: false, error: msg };
    }

    // The whole group: the entry plus any split siblings.
    const group = target.billGroupId
      ? entries.filter((e) => e.type === 'bill' && e.billGroupId === target.billGroupId)
      : [target];
    // Primary = the row carrying provenance (source_message_id, parser_raw,
    // materials links). Falls back to oldest row. Always kept, never deleted.
    const primary = group.find((g) => g.sourceMessageId)
      ?? [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const siblings = group.filter((g) => g.id !== primary.id);
    if (siblings.some((s) => s.id.startsWith('ent_'))) {
      const msg = 'Still saving a previous split — give it a moment and try again.';
      setError(msg);
      return { ok: false, error: msg };
    }

    const NZ_GST_RATE = 0.15;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const gstApplies = primary.gstApplies;
    const exOf = (e: Entry): number => {
      if (e.amountExGst != null) return e.amountExGst;
      if (e.amount == null) return 0;
      return e.gstApplies ? e.amount / (1 + NZ_GST_RATE) : e.amount;
    };
    const exTotal = r2(group.reduce((s, e) => s + exOf(e), 0));
    const grossTotal = r2(group.reduce((s, e) => s + (e.amount ?? 0), 0));

    // Slices must replace the full bill — same tolerance as the SplitForm.
    const sliceSum = r2(slices.reduce((s, x) => s + x.exGst, 0));
    if (Math.abs(sliceSum - exTotal) > 0.02) {
      const msg = `Split must add up to the bill total (${exTotal.toFixed(2)} ex-GST).`;
      setError(msg);
      return { ok: false, error: msg };
    }

    // Derive gross + GST per slice; pin rounding drift to the last slice so
    // the group still sums to the invoice total to the cent.
    const computed = slices.map((s) => {
      const ex = r2(s.exGst);
      const gross = gstApplies ? r2(ex * (1 + NZ_GST_RATE)) : ex;
      return { jobId: s.jobId, ex, gross, gst: r2(gross - ex) };
    });
    const drift = r2(grossTotal - computed.reduce((s, x) => s + x.gross, 0));
    if (drift !== 0) {
      const last = computed[computed.length - 1];
      last.gross = r2(last.gross + drift);
      last.gst = r2(last.gross - last.ex);
      last.ex = r2(last.gross - last.gst);
    }

    const isSplit = computed.length >= 2;
    const groupId: string | null = isSplit
      ? (primary.billGroupId
        ?? ((typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID() : `grp_${Date.now()}`))
      : null;
    const [first, ...rest] = computed;
    const nowISO = new Date().toISOString();

    // New sibling rows for slices 2..N. They inherit paid/paid_date from the
    // primary so a paid bill stays fully paid (GST timing unchanged), and
    // deliberately do NOT carry source_message_id (unique index) or
    // parser_raw (provenance lives on the primary).
    const siblingLocal: Entry[] = rest.map((s, i) => ({
      id: `ent_${Date.now()}_realloc_${i}`,
      businessId,
      jobId: s.jobId ?? undefined,
      type: 'bill',
      isDraft: false,
      paid: primary.paid,
      paidDate: primary.paidDate,
      bankTransactionId: primary.bankTransactionId,
      company: primary.company,
      supplier: primary.supplier,
      description: primary.description,
      amount: s.gross,
      gstApplies,
      amountExGst: s.ex,
      gstComponent: s.gst,
      entryDate: primary.entryDate,
      dueDate: primary.dueDate,
      paymentRef: primary.paymentRef,
      billPdfUrl: primary.billPdfUrl,
      parserConfidence: primary.parserConfidence,
      billGroupId: groupId ?? undefined,
      createdAt: nowISO,
    }));
    const tempIds = siblingLocal.map((s) => s.id);
    const removedSiblingIds = siblings.map((s) => s.id);

    // Optimistic: primary becomes slice #1, old siblings vanish, new ones
    // (if any) prepend. Snapshot for rollback.
    const prevEntries = entries;
    setEntries((list) => {
      const withoutOld = list.filter((e) => !removedSiblingIds.includes(e.id));
      const updated = withoutOld.map((e) => e.id === primary.id
        ? {
          ...e,
          jobId: first.jobId ?? undefined,
          amount: first.gross,
          amountExGst: first.ex,
          gstComponent: first.gst,
          billGroupId: groupId ?? undefined,
        }
        : e);
      return [...siblingLocal, ...updated];
    });

    // Persist via the reallocate_bill() Postgres function (migration 033)
    // so update-primary / delete-old / insert-new happen in ONE
    // transaction — a partial failure can no longer eat sibling rows.
    // Old siblings are deleted by id inside the fn — NOT via deleteEntry,
    // which would also remove the shared bill PDF from Storage.
    const siblingRows = rest.map((s) => ({
      business_id: businessId,
      job_id: s.jobId,
      type: 'bill',
      is_draft: false,
      paid: primary.paid,
      paid_date: primary.paidDate ?? null,
      bank_transaction_id: primary.bankTransactionId ?? null,
      company: primary.company ?? null,
      supplier: primary.supplier ?? null,
      description: primary.description,
      amount: s.gross,
      amount_ex_gst: s.ex,
      gst_component: s.gst,
      gst_applies: gstApplies,
      entry_date: primary.entryDate,
      due_date: primary.dueDate ?? null,
      payment_ref: primary.paymentRef ?? null,
      bill_pdf_url: primary.billPdfUrl ?? null,
      parser_confidence: primary.parserConfidence ?? null,
      bill_group_id: groupId,
      created_at: nowISO,
    }));

    const { data: insData, error: rpcErr } = await supabase.rpc('reallocate_bill', {
      p_primary_id: primary.id,
      p_primary_job: first.jobId,
      p_primary_gross: first.gross,
      p_primary_ex: first.ex,
      p_primary_gst: first.gst,
      p_group_id: groupId,
      p_delete_ids: removedSiblingIds,
      p_new_rows: siblingRows,
    });

    if (rpcErr) {
      const msg = describeError(rpcErr) || 'Failed to re-allocate the bill';
      console.error('[store] reallocateBill failed:', msg);
      setError(msg);
      // The fn is transactional — on error NOTHING persisted, so the
      // local rollback is now actually truthful.
      setEntries(prevEntries);
      return { ok: false, error: msg };
    }

    // Swap temp sibling ids for the persisted rows the fn returned.
    if (insData && (insData as Record<string, unknown>[]).length > 0) {
      const persisted = (insData as Record<string, unknown>[]).map(rowToEntry);
      setEntries((list) => {
        const withoutTemps = list.filter((e) => !tempIds.includes(e.id));
        return [...persisted, ...withoutTemps];
      });
    }
    return { ok: true };
  }, [businessId, entries]);

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

  const logMyHours = useCallback((input: {
    jobId?: string;
    hours: number;
    activity?: ActivityType;
    note?: string;
    entryDate?: string;
  }) => {
    if (!businessId) {
      console.warn('[store] logMyHours called with no businessId; ignoring');
      return;
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    // Attribute to the signed-in user. For an employee this uid is what the
    // RLS insert policy checks; for the owner it's harmless extra provenance.
    const uid = membership?.userId;
    const entry: Entry = {
      id: crypto.randomUUID(),
      businessId,
      jobId: input.jobId,
      type: 'hours',
      hours: input.hours,
      activity: input.activity,
      // description is NOT NULL in the DB — fall back to the activity or a
      // generic label so an empty note never violates the constraint.
      description: (input.note?.trim()) || (input.activity ? `${input.activity} work` : 'Hours'),
      entryDate: input.entryDate || todayIso,
      gstApplies: false,
      workerKind: membership?.workerKind ?? 'owner',
      loggedByUserId: uid,
      createdAt: new Date().toISOString(),
    };
    addEntry(entry);
  }, [businessId, membership, addEntry]);

  /**
   * Upload one or more shift photos against a job + date. Compresses each
   * image, stores it in the private `shift-photos` bucket, and inserts a
   * `shift_photos` row. Attributed to the signed-in user. Independent of
   * the hours entry (so it doesn't wait on the optimistic insert), though
   * an entryId can be passed to link them.
   */
  const uploadShiftPhotos = useCallback(async (input: {
    jobId: string;
    takenOn: string;
    files: File[];
    entryId?: string;
  }): Promise<{ inserted: number; failed: number; failedFiles: File[] }> => {
    if (!businessId || input.files.length === 0) return { inserted: 0, failed: 0, failedFiles: [] };
    const uid = membership?.userId ?? null;
    let inserted = 0;
    let failed = 0;
    const failedFiles: File[] = [];

    for (const file of input.files) {
      try {
        const prepared = await compressImage(file).then((r) => r.file).catch(() => file);
        const safeName = (prepared.name || 'photo.jpg').replace(/[^a-zA-Z0-9._-]+/g, '_');
        const storagePath = `${businessId}/${input.jobId}/${crypto.randomUUID()}__${safeName}`;

        const { error: upErr } = await supabase.storage
          .from('shift-photos')
          .upload(storagePath, prepared, { contentType: prepared.type || 'image/jpeg', upsert: false });
        if (upErr) {
          console.error('[uploadShiftPhotos] upload failed:', describeError(upErr));
          failed++;
          failedFiles.push(file);
          continue;
        }

        const { data, error: insErr } = await supabase
          .from('shift_photos')
          .insert({
            business_id: businessId,
            job_id: input.jobId,
            entry_id: input.entryId ?? null,
            uploaded_by: uid,
            taken_on: input.takenOn,
            storage_path: storagePath,
          })
          .select('*')
          .single();
        if (insErr || !data) {
          console.error('[uploadShiftPhotos] insert failed:', describeError(insErr));
          await supabase.storage.from('shift-photos').remove([storagePath]).catch(() => {});
          failed++;
          failedFiles.push(file);
          continue;
        }
        setShiftPhotos((prev) => [rowToShiftPhoto(data), ...prev]);
        inserted++;
      } catch (err) {
        console.error('[uploadShiftPhotos] unexpected error:', err);
        failed++;
        failedFiles.push(file);
      }
    }
    if (failed > 0) setError(`${failed} of ${input.files.length} photos failed to upload.`);
    return { inserted, failed, failedFiles };
  }, [businessId, membership]);

  const updateShiftPhoto = useCallback((id: string, updates: Pick<ShiftPhoto, 'marketingCandidate'>) => {
    const previous = shiftPhotos.find((photo) => photo.id === id);
    if (!previous) return;
    setShiftPhotos((list) => list.map((photo) => photo.id === id ? { ...photo, ...updates } : photo));
    (async () => {
      const { data, error: updateErr } = await supabase
        .from('shift_photos')
        .update({ marketing_candidate: updates.marketingCandidate })
        .eq('id', id)
        .select('*')
        .single();
      if (updateErr || !data) {
        console.error('[updateShiftPhoto] failed:', describeError(updateErr));
        setError(updateErr?.message ?? 'Could not update that photo.');
        setShiftPhotos((list) => list.map((photo) => photo.id === id ? previous : photo));
        return;
      }
      const persisted = rowToShiftPhoto(data);
      setShiftPhotos((list) => list.map((photo) => photo.id === id ? persisted : photo));
    })();
  }, [shiftPhotos]);

  /**
   * Upsert one end-of-day report per person + job + date. Hours and photo
   * writes stay independent, so editing the report can never alter payroll.
   */
  const saveShiftReport = useCallback(async (input: {
    jobId: string;
    workDate: string;
    status: ShiftReportStatus;
    note?: string;
  }): Promise<ShiftReport | null> => {
    if (!businessId) return null;
    const authUser = membership?.userId
      ? { id: membership.userId }
      : (await supabase.auth.getUser()).data.user;
    if (!authUser?.id) {
      setError('Could not tell which team member is signed in.');
      return null;
    }

    const previous = shiftReports.find((report) =>
      report.jobId === input.jobId
      && report.uploadedBy === authUser.id
      && report.workDate === input.workDate,
    );
    const now = new Date().toISOString();
    const optimistic: ShiftReport = {
      id: previous?.id ?? crypto.randomUUID(),
      businessId,
      jobId: input.jobId,
      uploadedBy: authUser.id,
      workDate: input.workDate,
      status: input.status,
      note: input.note?.trim() || undefined,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    setShiftReports((list) => [optimistic, ...list.filter((report) => report.id !== optimistic.id)]);

    const { data, error: upsertErr } = await supabase
      .from('shift_reports')
      .upsert({
        business_id: businessId,
        job_id: input.jobId,
        uploaded_by: authUser.id,
        work_date: input.workDate,
        status: input.status,
        note: input.note?.trim() || null,
      }, { onConflict: 'job_id,uploaded_by,work_date' })
      .select('*')
      .single();

    if (upsertErr || !data) {
      console.error('[saveShiftReport] failed:', describeError(upsertErr));
      setError(upsertErr?.message ?? 'Could not save the team update.');
      setShiftReports((list) => {
        const withoutOptimistic = list.filter((report) => report.id !== optimistic.id);
        return previous ? [previous, ...withoutOptimistic] : withoutOptimistic;
      });
      return null;
    }
    const persisted = rowToShiftReport(data);
    setShiftReports((list) => [persisted, ...list.filter((report) => report.id !== optimistic.id && report.id !== persisted.id)]);
    return persisted;
  }, [businessId, membership, shiftReports]);

  /**
   * Create a reviewed variation and its public approval token. The client
   * link is never sent here — callers explicitly copy/share it after the
   * persisted row comes back.
   */
  const addJobVariation = useCallback(async (input: {
    jobId: string;
    shiftReportId?: string;
    title: string;
    description?: string;
    amountExGst: number;
    photoIds?: string[];
  }): Promise<JobVariation | null> => {
    if (!businessId) return null;
    const now = new Date().toISOString();
    const tempId = `variation_${crypto.randomUUID()}`;
    const optimistic: JobVariation = {
      id: tempId,
      businessId,
      jobId: input.jobId,
      shiftReportId: input.shiftReportId,
      title: input.title.trim(),
      description: input.description?.trim() || undefined,
      amountExGst: input.amountExGst,
      status: 'ready',
      approvalToken: crypto.randomUUID(),
      photoIds: input.photoIds ?? [],
      createdAt: now,
      updatedAt: now,
    };
    setJobVariations((list) => [optimistic, ...list]);

    const { data, error: insertErr } = await supabase
      .from('job_variations')
      .insert({
        business_id: businessId,
        job_id: input.jobId,
        shift_report_id: input.shiftReportId ?? null,
        title: optimistic.title,
        description: optimistic.description ?? null,
        amount_ex_gst: optimistic.amountExGst,
        status: 'ready',
        approval_token: optimistic.approvalToken,
        photo_ids: optimistic.photoIds,
      })
      .select('*')
      .single();

    if (insertErr || !data) {
      console.error('[addJobVariation] failed:', describeError(insertErr));
      setError(insertErr?.message ?? 'Could not create that variation.');
      setJobVariations((list) => list.filter((variation) => variation.id !== tempId));
      return null;
    }
    const persisted = rowToJobVariation(data);
    setJobVariations((list) => [persisted, ...list.filter((variation) => variation.id !== tempId && variation.id !== persisted.id)]);
    return persisted;
  }, [businessId]);

  /**
   * Set (or clear) a job's cover photo. See the interface docs above for
   * why quote-attachments images get copied rather than referenced: that
   * bucket is owner-only and holds priced PDFs, so handing employees a
   * path into it would break money-blindness.
   *
   * updateJob handles the optimistic write + rollback; the only extra
   * work here is materialising a staff-readable copy of the image first.
   */
  const setJobCoverPhoto = useCallback(async (
    jobId: string,
    source: { bucket: 'shift-photos' | 'quote-attachments'; path: string } | null,
  ) => {
    if (!businessId) return;
    if (!source) {
      updateJob(jobId, { coverPhotoPath: undefined, coverPhotoSource: undefined });
      return;
    }
    // Already in the readable bucket — just point at it. No copy, so the
    // cover stays in sync if the photo is later deleted (it 404s and the
    // fallback kicks in, rather than leaving an orphan duplicate).
    if (source.bucket === 'shift-photos') {
      updateJob(jobId, { coverPhotoPath: source.path, coverPhotoSource: source.path });
      return;
    }
    try {
      const { data: blob, error: dlErr } = await supabase.storage
        .from('quote-attachments')
        .download(source.path);
      if (dlErr || !blob) throw dlErr ?? new Error('Could not read that image.');

      const rawName = source.path.split('/').pop() || 'cover.jpg';
      const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, '_');
      const destPath = `${businessId}/${jobId}/cover__${crypto.randomUUID()}__${safeName}`;
      const { error: upErr } = await supabase.storage
        .from('shift-photos')
        .upload(destPath, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
      if (upErr) throw upErr;

      // Remember where it came from so the UI can star the ORIGINAL
      // thumbnail — the copy's path looks nothing like the source's.
      updateJob(jobId, { coverPhotoPath: destPath, coverPhotoSource: source.path });
    } catch (err) {
      console.error('[store] setJobCoverPhoto failed:', describeError(err));
      setError('Could not set that as the cover photo.');
    }
  }, [businessId, updateJob]);

  const deleteShiftPhoto = useCallback((id: string) => {
    let prev: ShiftPhoto | undefined;
    setShiftPhotos((list) => {
      prev = list.find((p) => p.id === id);
      return list.filter((p) => p.id !== id);
    });
    (async () => {
      const { error: delErr } = await supabase.from('shift_photos').delete().eq('id', id);
      if (delErr) {
        console.error('[deleteShiftPhoto] failed:', delErr);
        setError(delErr.message);
        if (prev) setShiftPhotos((l) => [prev!, ...l]);
        return;
      }
      if (prev?.storagePath) {
        await supabase.storage.from('shift-photos').remove([prev.storagePath]).catch(() => {});
      }
    })();
  }, []);

  /**
   * Replace the assignee set for a job (owner-only — employee RLS will
   * reject the writes). Diff-based: deletes the removed, inserts the new.
   * Optimistic with full rollback on any failure.
   */
  const setJobAssignees = useCallback(async (jobId: string, userIds: string[]) => {
    if (!businessId) return;
    const prev = jobAssignmentsRef.current;
    const current = prev.filter((a) => a.jobId === jobId);
    const currentIds = new Set(current.map((a) => a.userId));
    const nextIds = new Set(userIds);
    const toRemove = current.filter((a) => !nextIds.has(a.userId));
    const toAdd = userIds.filter((uid) => !currentIds.has(uid));
    if (toRemove.length === 0 && toAdd.length === 0) return;

    const tempRows: JobAssignment[] = toAdd.map((uid) => ({
      id: `temp-ja-${crypto.randomUUID()}`,
      businessId, jobId, userId: uid,
      createdAt: new Date().toISOString(),
    }));
    const removeIds = new Set(toRemove.map((a) => a.id));
    setJobAssignments((p) => [...p.filter((a) => !removeIds.has(a.id)), ...tempRows]);

    try {
      if (toRemove.length > 0) {
        const { error: delErr } = await supabase
          .from('job_assignments').delete()
          .in('id', toRemove.map((a) => a.id));
        if (delErr) throw delErr;
      }
      if (toAdd.length > 0) {
        const { data, error: insErr } = await supabase
          .from('job_assignments')
          .insert(toAdd.map((uid) => ({ business_id: businessId, job_id: jobId, user_id: uid })))
          .select('*');
        if (insErr) throw insErr;
        const real = (data ?? []).map(rowToJobAssignment);
        const tempIds = new Set(tempRows.map((t) => t.id));
        setJobAssignments((p) => [...p.filter((a) => !tempIds.has(a.id)), ...real]);
      }
    } catch (err) {
      console.error('[store] setJobAssignees failed:', describeError(err));
      setError('Saving the job team failed — change reverted.');
      setJobAssignments(prev);
    }
  }, [businessId]);

  /**
   * Set a per-booking override (owner-only). Pass the exact people for
   * that day; [] clears the override so the booking inherits the job
   * team. Same diff + optimistic + rollback shape as setJobAssignees.
   */
  const setBookingAssignees = useCallback(async (scheduleItemId: string, userIds: string[]) => {
    if (!businessId) return;
    const prev = scheduleAssignmentsRef.current;
    const current = prev.filter((a) => a.scheduleItemId === scheduleItemId);
    const currentIds = new Set(current.map((a) => a.userId));
    const nextIds = new Set(userIds);
    const toRemove = current.filter((a) => !nextIds.has(a.userId));
    const toAdd = userIds.filter((uid) => !currentIds.has(uid));
    if (toRemove.length === 0 && toAdd.length === 0) return;

    const tempRows: ScheduleAssignment[] = toAdd.map((uid) => ({
      id: `temp-sa-${crypto.randomUUID()}`,
      businessId, scheduleItemId, userId: uid,
      createdAt: new Date().toISOString(),
    }));
    const removeIds = new Set(toRemove.map((a) => a.id));
    setScheduleAssignments((p) => [...p.filter((a) => !removeIds.has(a.id)), ...tempRows]);

    try {
      if (toRemove.length > 0) {
        const { error: delErr } = await supabase
          .from('schedule_assignments').delete()
          .in('id', toRemove.map((a) => a.id));
        if (delErr) throw delErr;
      }
      if (toAdd.length > 0) {
        // The booking itself may still be in-flight (addScheduleItem is an
        // optimistic fire-and-forget insert, and the edit-sheet's range
        // flow re-creates bookings then immediately re-applies the
        // override). A 23503 FK violation here just means "booking row
        // hasn't landed yet" — retry briefly before giving up.
        const rows = toAdd.map((uid) => ({
          business_id: businessId, schedule_item_id: scheduleItemId, user_id: uid,
        }));
        let data: Record<string, unknown>[] | null = null;
        let insErr: unknown = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt));
          const res = await supabase.from('schedule_assignments').insert(rows).select('*');
          data = res.data;
          insErr = res.error;
          const code = res.error && typeof res.error === 'object' && 'code' in res.error
            ? (res.error as { code?: string }).code : undefined;
          if (!res.error || code !== '23503') break;
        }
        if (insErr) throw insErr;
        const real = (data ?? []).map(rowToScheduleAssignment);
        const tempIds = new Set(tempRows.map((t) => t.id));
        setScheduleAssignments((p) => [...p.filter((a) => !tempIds.has(a.id)), ...real]);
      }
    } catch (err) {
      console.error('[store] setBookingAssignees failed:', describeError(err));
      setError('Saving who’s on the booking failed — change reverted.');
      setScheduleAssignments(prev);
    }
  }, [businessId]);

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
    // Mirror the DB cascade: per-booking assignment overrides die with the
    // booking. (Best-effort local cleanup only — Postgres does the real
    // cascade; not restored on rollback since re-editing re-derives it.)
    setScheduleAssignments((prev) => prev.filter((a) => a.scheduleItemId !== id));

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

  const addInvoice = useCallback(async (invoice: Invoice): Promise<Invoice | null> => {
    if (!businessId) {
      console.warn('[store] addInvoice called with no businessId; ignoring');
      return null;
    }
    // Optimistic insert runs synchronously (before the first await) so the
    // invoice shows up in the UI immediately, exactly as before.
    setInvoices((prev) => [invoice, ...prev]);
    const tempId = invoice.id;

    const row = invoiceToRow({ ...invoice, businessId });
    const { data, error: insErr } = await supabase
      .from('invoices').insert(row).select('*').single();
    if (insErr || !data) {
      console.error('[store] addInvoice failed:', insErr);
      setError(insErr?.message ?? 'Failed to save invoice');
      setInvoices((prev) => prev.filter((i) => i.id !== tempId));
      return null;
    }
    // Swap the temp client id ('inv_…') for the persisted row, which carries
    // the real Supabase UUID. Returning it lets callers chain id-dependent
    // work (e.g. markInvoicePaid) against the real id rather than the temp
    // one — the temp id is not a valid UUID and a DB update keyed on it
    // fails with Postgres 22P02.
    const persisted = rowToInvoice(data);
    setInvoices((prev) => prev.map((i) => (i.id === tempId ? persisted : i)));
    return persisted;
  }, [businessId]);

  const updateInvoice = useCallback(async (
    id: string,
    updates: Partial<Invoice>,
  ): Promise<{ ok: boolean; error?: string }> => {
    let prev: Invoice | undefined;
    setInvoices((list) => {
      prev = list.find((i) => i.id === id);
      return list.map((i) => (i.id === id ? { ...i, ...updates } : i));
    });
    const row = invoiceToRow(updates);
    const { error: updErr } = await supabase.from('invoices').update(row).eq('id', id);
    if (updErr) {
      console.error('[store] updateInvoice failed:', updErr);
      setError(updErr.message);
      if (prev) setInvoices((list) => list.map((i) => (i.id === id ? prev! : i)));
      return { ok: false, error: updErr.message };
    }
    return { ok: true };
  }, []);

  /**
   * Mark an invoice paid AND auto-create a linked income entry on the
   * payment date in one Postgres transaction. The invoice gets
   * income_entry_id pointing to the new entry. Idempotent if already paid.
   */
  const markInvoicePaid = useCallback(async (
    id: string,
    paidDate: string,
    paidVia?: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!businessId) return { ok: false, error: 'No business selected' };

    let original: Invoice | undefined;
    setInvoices((list) => {
      original = list.find((i) => i.id === id);
      if (!original || original.paid) return list;
      return list.map((i) => i.id === id ? {
        ...i,
        statusBeforePaid: i.status === 'draft' ? 'draft' : 'sent',
        status: 'paid',
        paid: true,
        paidDate,
        paidVia: paidVia ?? i.paidVia,
      } : i);
    });
    if (!original) return { ok: false, error: 'Invoice not found' };
    if (original.paid) return { ok: true };

    const tempEntryId = original.incomeEntryId ? null : `ent_${Date.now()}`;
    const grossAmount = original.amountInclGst
      ?? (original.gstApplies ? original.amountExGst * 1.15 : original.amountExGst);
    const gst = original.gstComponent
      ?? (original.gstApplies ? original.amountExGst * 0.15 : 0);
    const localEntry: Entry | null = tempEntryId ? {
      id: tempEntryId,
      businessId,
      jobId: original.jobId,
      type: 'income',
      amount: grossAmount,
      gstApplies: original.gstApplies,
      amountExGst: original.amountExGst,
      gstComponent: gst,
      description: `${original.invoiceNumber} payment received`,
      entryDate: paidDate,
      paymentMethod: paidVia ?? 'Bank transfer',
      createdAt: new Date().toISOString(),
    } : null;
    if (localEntry) setEntries((prev) => [localEntry, ...prev]);

    const { data, error: rpcErr } = await supabase.rpc('mark_invoice_paid', {
      p_invoice_id: id,
      p_paid_date: paidDate,
      p_paid_via: paidVia ?? null,
    });
    const payload = data as {
      invoice?: Record<string, unknown>;
      entry?: Record<string, unknown> | null;
    } | null;
    if (rpcErr || !payload?.invoice) {
      const msg = describeError(rpcErr) || 'Failed to mark invoice paid';
      console.error('[store] markInvoicePaid failed:', msg, rpcErr);
      setError(msg);
      if (localEntry) setEntries((prev) => prev.filter((e) => e.id !== localEntry.id));
      setInvoices((list) => list.map((i) => i.id === id ? original! : i));
      return { ok: false, error: msg };
    }

    const persistedInvoice = rowToInvoice(payload.invoice);
    setInvoices((list) => list.map((i) => i.id === id ? persistedInvoice : i));
    if (payload.entry) {
      const persistedEntry = rowToEntry(payload.entry);
      setEntries((list) => {
        if (localEntry) return list.map((e) => e.id === localEntry.id ? persistedEntry : e);
        return list.some((e) => e.id === persistedEntry.id)
          ? list.map((e) => e.id === persistedEntry.id ? persistedEntry : e)
          : [persistedEntry, ...list];
      });
    }
    return { ok: true };
  }, [businessId]);

  const unmarkInvoicePaid = useCallback(async (
    id: string,
  ): Promise<{ ok: boolean; preservedEntry?: boolean; error?: string }> => {
    let original: Invoice | undefined;
    setInvoices((list) => {
      original = list.find((i) => i.id === id);
      if (!original || !original.paid) return list;
      return list.map((i) => i.id === id ? {
        ...i,
        status: i.statusBeforePaid ?? 'sent',
        statusBeforePaid: undefined,
        paid: false,
        paidDate: undefined,
        paidVia: undefined,
        incomeEntryId: undefined,
        paymentEntryGenerated: false,
      } : i);
    });
    if (!original) return { ok: false, error: 'Invoice not found' };
    if (!original.paid) return { ok: true };

    const linkedEntry = original.incomeEntryId
      ? entriesRef.current.find((entry) => entry.id === original!.incomeEntryId)
      : undefined;
    if (linkedEntry && original.paymentEntryGenerated) {
      setEntries((list) => list.filter((entry) => entry.id !== linkedEntry.id));
    }

    const { data, error: rpcErr } = await supabase.rpc('unmark_invoice_paid', { p_invoice_id: id });
    const payload = data as {
      invoice?: Record<string, unknown>;
      deleted_entry?: boolean;
      preserved_entry?: boolean;
    } | null;
    if (rpcErr || !payload?.invoice) {
      const msg = describeError(rpcErr) || 'Failed to undo invoice payment';
      console.error('[store] unmarkInvoicePaid failed:', msg, rpcErr);
      setError(msg);
      setInvoices((list) => list.map((i) => i.id === id ? original! : i));
      if (linkedEntry && original.paymentEntryGenerated) {
        setEntries((list) => list.some((e) => e.id === linkedEntry.id) ? list : [linkedEntry, ...list]);
      }
      return { ok: false, error: msg };
    }

    const persistedInvoice = rowToInvoice(payload.invoice);
    setInvoices((list) => list.map((i) => i.id === id ? persistedInvoice : i));
    if (payload.deleted_entry && original.incomeEntryId) {
      setEntries((list) => list.filter((entry) => entry.id !== original!.incomeEntryId));
    }
    return { ok: true, preservedEntry: payload.preserved_entry === true };
  }, []);

  const voidInvoice = useCallback(async (
    id: string,
    reason?: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    let original: Invoice | undefined;
    const now = new Date().toISOString();
    setInvoices((list) => {
      original = list.find((i) => i.id === id);
      if (!original || original.paid) return list;
      return list.map((i) => i.id === id
        ? { ...i, status: 'void', paid: false, voidedAt: now, voidReason: reason?.trim() || undefined }
        : i);
    });
    if (!original) return { ok: false, error: 'Invoice not found' };
    if (original.paid) return { ok: false, error: 'Undo the payment before voiding this invoice' };

    const { data, error: rpcErr } = await supabase.rpc('void_invoice', {
      p_invoice_id: id,
      p_reason: reason?.trim() || null,
    });
    if (rpcErr || !data) {
      const msg = describeError(rpcErr) || 'Failed to void invoice';
      console.error('[store] voidInvoice failed:', msg, rpcErr);
      setError(msg);
      setInvoices((list) => list.map((i) => i.id === id ? original! : i));
      return { ok: false, error: msg };
    }
    const persistedInvoice = rowToInvoice(data as Record<string, unknown>);
    setInvoices((list) => list.map((i) => i.id === id ? persistedInvoice : i));
    return { ok: true };
  }, []);

  // ── Bank transaction mutators ────────────────────────────────────────────

  /**
   * Bulk-insert parsed CSV rows. The DB unique(business_id, fingerprint)
   * means re-imports of the same file silently skip duplicates. We use
   * upsert with ignoreDuplicates so already-imported rows just no-op rather
   * than erroring.
   */
  // ── Pay runs (employee payroll) ──────────────────────────────────────────

  /**
   * Record a pay run as paid. Two linked writes, mirroring markInvoicePaid:
   *   1. Insert the wages expense entry (the deductible cost, s DA 1).
   *      Wages carry NO GST — gstApplies false, ex-GST = gross.
   *   2. Insert the pay_run row linking back to that entry.
   * If step 2 fails the entry is deleted again (best-effort) so the books
   * never show a wage cost without its pay-run record.
   */
  const addPayRun = useCallback(async (input: {
    memberId?: string;
    employeeName: string;
    periodStart: string;
    periodEnd: string;
    hours?: number;
    rate?: number;
    gross: number;
    paye?: number;
    net?: number;
    paidDate: string;
    notes?: string;
  }): Promise<{ ok: boolean; error?: string }> => {
    if (!businessId) return { ok: false, error: 'No business loaded' };

    const periodLabel = `${input.periodStart} → ${input.periodEnd}`;
    const tempEntryId = `ent_${Date.now()}`;
    const tempRunId = `pay_${Date.now()}`;
    const nowISO = new Date().toISOString();

    // Optimistic local rows — cash/profit numbers update immediately.
    const localEntry: Entry = {
      id: tempEntryId,
      businessId,
      type: 'expense',
      category: 'labour',
      amount: input.gross,
      gstApplies: false,
      amountExGst: input.gross,
      gstComponent: 0,
      description: `Wages — ${input.employeeName} (${periodLabel})`,
      entryDate: input.paidDate,
      createdAt: nowISO,
    };
    const localRun: PayRun = {
      id: tempRunId,
      businessId,
      memberId: input.memberId,
      employeeName: input.employeeName,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      hours: input.hours,
      rate: input.rate,
      gross: input.gross,
      paye: input.paye,
      net: input.net,
      paid: true,
      paidDate: input.paidDate,
      eiFiled: false,
      payePaid: false,
      expenseEntryId: tempEntryId,
      notes: input.notes,
      createdAt: nowISO,
    };
    setEntries((prev) => [localEntry, ...prev]);
    setPayRuns((prev) => [localRun, ...prev]);

    const rollbackLocal = () => {
      setEntries((prev) => prev.filter((e) => e.id !== tempEntryId));
      setPayRuns((prev) => prev.filter((p) => p.id !== tempRunId));
    };

    // 1. Wages expense entry first — its real id goes on the pay run.
    const { data: entryData, error: entryErr } = await supabase
      .from('entries').insert(entryToRow({ ...localEntry, businessId })).select('*').single();
    if (entryErr || !entryData) {
      const msg = describeError(entryErr) || 'Failed to log the wages expense';
      console.error('[store] addPayRun: entry insert failed —', msg, entryErr);
      setError(msg);
      rollbackLocal();
      return { ok: false, error: msg };
    }
    const persistedEntry = rowToEntry(entryData);
    setEntries((prev) => prev.map((e) => (e.id === tempEntryId ? persistedEntry : e)));

    // 2. The pay run itself.
    const runRow = {
      ...payRunToRow({ ...localRun, expenseEntryId: persistedEntry.id }),
      business_id: businessId,
    };
    delete (runRow as Record<string, unknown>).id; // let Postgres mint the uuid
    const { data: runData, error: runErr } = await supabase
      .from('pay_runs').insert(runRow).select('*').single();
    if (runErr || !runData) {
      const msg = describeError(runErr) || 'Failed to save the pay run';
      console.error('[store] addPayRun: pay_run insert failed —', msg, runErr);
      setError(msg);
      // Best-effort: remove the wages entry so the books stay consistent.
      const { error: rbErr } = await supabase.from('entries').delete().eq('id', persistedEntry.id);
      if (rbErr) console.warn('[store] addPayRun: entry rollback also failed —', describeError(rbErr));
      setEntries((prev) => prev.filter((e) => e.id !== persistedEntry.id));
      setPayRuns((prev) => prev.filter((p) => p.id !== tempRunId));
      return { ok: false, error: msg };
    }
    const persistedRun = rowToPayRun(runData);
    setPayRuns((prev) => prev.map((p) => (p.id === tempRunId ? persistedRun : p)));
    return { ok: true };
  }, [businessId]);

  const updatePayRun = useCallback((
    id: string,
    patch: Partial<Pick<PayRun, 'eiFiled' | 'payePaid' | 'paye' | 'net' | 'notes'>>,
  ) => {
    let before: PayRun | undefined;
    setPayRuns((prev) => prev.map((p) => {
      if (p.id !== id) return p;
      before = p;
      return { ...p, ...patch };
    }));
    if (!before) return;
    const snapshot = before;

    (async () => {
      const { data, error: updErr } = await supabase
        .from('pay_runs')
        .update(payRunToRow(patch))
        .eq('id', id)
        .select('id');
      const noRows = !updErr && (!data || data.length === 0);
      if (updErr || noRows) {
        const msg = updErr ? describeError(updErr) : `No pay run matched id=${id}`;
        console.error('[store] updatePayRun failed:', msg, updErr ?? '');
        setError(msg);
        setPayRuns((prev) => prev.map((p) => (p.id === id ? snapshot : p)));
      }
    })();
  }, []);

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

  /**
   * Settle N already-confirmed bills against one bank payment. See the
   * interface doc for the why. Optimistic + rollback; we capture the
   * pre-state inside the functional setState updaters so we never read a
   * stale closure of `entries` / `bankTransactions`.
   */
  const markBillsPaid = useCallback(async (
    bankTxnId: string,
    billEntryIds: string[],
    paidDate: string,
  ): Promise<{ updated: number; failed: number; error?: string }> => {
    if (!businessId) return { updated: 0, failed: billEntryIds.length, error: 'No business loaded.' };
    if (billEntryIds.length === 0) return { updated: 0, failed: 0 };

    const idSet = new Set(billEntryIds);

    // Optimistic flip + capture pre-state for rollback (from freshest state).
    let prevEntries: Entry[] = [];
    setEntries((list) => {
      prevEntries = list.filter((e) => idSet.has(e.id));
      return list.map((e) => idSet.has(e.id)
        ? { ...e, paid: true, paidDate, bankTransactionId: bankTxnId }
        : e);
    });
    // The bank_transactions table has a single entry_id column; point it at
    // the first bill (arbitrary but consistent) — each bill keeps its own
    // bank_transaction_id for the full audit trail.
    let prevTxn: BankTransaction | undefined;
    setBankTransactions((list) => {
      prevTxn = list.find((t) => t.id === bankTxnId);
      return list.map((t) => t.id === bankTxnId
        ? { ...t, status: 'matched', entryId: billEntryIds[0] }
        : t);
    });

    const [re, rt] = await Promise.all([
      supabase.from('entries')
        .update({ paid: true, paid_date: paidDate, bank_transaction_id: bankTxnId })
        .in('id', billEntryIds),
      supabase.from('bank_transactions')
        .update({ status: 'matched', entry_id: billEntryIds[0] })
        .eq('id', bankTxnId),
    ]);

    if (re.error || rt.error) {
      const msg = describeError(re.error || rt.error) || 'Failed to mark bills paid';
      console.error('[store] markBillsPaid failed:', msg);
      setError(msg);
      // Roll back both sides to the captured pre-state.
      setEntries((list) => list.map((e) => {
        const prev = prevEntries.find((p) => p.id === e.id);
        return prev ?? e;
      }));
      if (prevTxn) {
        const restore = prevTxn;
        setBankTransactions((list) => list.map((t) => t.id === bankTxnId ? restore : t));
      }
      return { updated: 0, failed: billEntryIds.length, error: msg };
    }

    return { updated: billEntryIds.length, failed: 0 };
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

  // ── Job marketing ──────────────────────────────────────────────────
  // Per-job marketing metadata (description + publish status + hero image)
  // lives as a JSON blob in the settings row keyed `marketing:{jobId}`.
  // Same read/parse + stringify/upsert pattern as the quote template, so
  // the whole Marketing feature needs no schema migration. Photos are
  // handled separately via quote_attachments (see addQuoteAttachments).
  const marketingKey = (jobId: string) => `marketing:${jobId}`;

  const getJobMarketing = useCallback((jobId: string): JobMarketing | null => {
    const row = settings.find((s) => s.key === marketingKey(jobId));
    if (!row || !row.value) return null;
    try {
      const parsed = JSON.parse(row.value) as Partial<JobMarketing>;
      return {
        jobId,
        title: parsed.title,
        description: parsed.description,
        overview: Array.isArray(parsed.overview) ? parsed.overview : undefined,
        services: Array.isArray(parsed.services) ? parsed.services : undefined,
        status: parsed.status ?? 'draft',
        heroAttachmentId: parsed.heroAttachmentId,
        heroMode: parsed.heroMode,
        heroBeforeId: parsed.heroBeforeId,
        heroAfterId: parsed.heroAfterId,
        excludedImageIds: Array.isArray(parsed.excludedImageIds) ? parsed.excludedImageIds : undefined,
        review: parsed.review?.quote ? parsed.review : undefined,
        facebook: parsed.facebook,
        instagram: parsed.instagram,
        updatedAt: parsed.updatedAt ?? row.updatedAt,
      };
    } catch (e) {
      console.error('[store] getJobMarketing: invalid JSON in settings row', e);
      return null;
    }
  }, [settings]);

  const saveJobMarketing = useCallback(async (
    jobId: string,
    updates: Partial<Pick<JobMarketing, 'title' | 'description' | 'overview' | 'services' | 'status' | 'heroAttachmentId' | 'heroMode' | 'heroBeforeId' | 'heroAfterId' | 'excludedImageIds' | 'review' | 'facebook' | 'instagram'>>,
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!businessId) {
      return { ok: false, error: 'No business loaded — try refreshing.' };
    }
    const key = marketingKey(jobId);
    const now = new Date().toISOString();

    // Merge onto whatever's already stored so a partial update (e.g. just
    // flipping status) doesn't wipe the description.
    const prev = settings.find((s) => s.key === key);
    let prevData: Partial<JobMarketing> = {};
    if (prev?.value) {
      try { prevData = JSON.parse(prev.value) as Partial<JobMarketing>; } catch { /* treat as empty */ }
    }
    const merged: JobMarketing = {
      jobId,
      title: updates.title !== undefined ? updates.title : prevData.title,
      description: updates.description !== undefined ? updates.description : prevData.description,
      overview: updates.overview !== undefined ? updates.overview : prevData.overview,
      services: updates.services !== undefined ? updates.services : prevData.services,
      status: updates.status !== undefined ? updates.status : (prevData.status ?? 'draft'),
      heroAttachmentId: updates.heroAttachmentId !== undefined ? updates.heroAttachmentId : prevData.heroAttachmentId,
      heroMode: updates.heroMode !== undefined ? updates.heroMode : prevData.heroMode,
      heroBeforeId: updates.heroBeforeId !== undefined ? updates.heroBeforeId : prevData.heroBeforeId,
      heroAfterId: updates.heroAfterId !== undefined ? updates.heroAfterId : prevData.heroAfterId,
      excludedImageIds: updates.excludedImageIds !== undefined ? updates.excludedImageIds : prevData.excludedImageIds,
      // `'review' in updates` (not !== undefined) so passing review: undefined
      // explicitly CLEARS a previously-saved review rather than keeping it.
      review: 'review' in updates ? updates.review : prevData.review,
      facebook: updates.facebook !== undefined ? updates.facebook : prevData.facebook,
      instagram: updates.instagram !== undefined ? updates.instagram : prevData.instagram,
      updatedAt: now,
    };
    const valueJson = JSON.stringify(merged);

    // Optimistic local update first; rollback on failure (mirrors saveQuoteTemplate).
    setSettings((list) => {
      const others = list.filter((s) => s.key !== key);
      return [...others, { businessId, key, value: valueJson, notes: prev?.notes, updatedAt: now }];
    });

    const { error: upsertErr } = await supabase
      .from('settings')
      .upsert(
        { business_id: businessId, key, value: valueJson },
        { onConflict: 'business_id,key' },
      );
    if (upsertErr) {
      console.error('[store] saveJobMarketing failed:', {
        message: upsertErr.message, code: upsertErr.code,
        details: upsertErr.details, hint: upsertErr.hint,
      });
      setSettings((list) => {
        const others = list.filter((s) => s.key !== key);
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
        jobs, entries, scheduleItems, materials, paintStock, quotes, settings, invoices, bankTransactions,
        jobImports, quoteAttachments,
        businessId, role, membership, teamMembers, payRuns, loading, error,
        addJob, updateJob, deleteJob, reconcileJobSchedule,
        addEntry, updateEntry, deleteEntry, markLabourBilled, logMyHours,
        shiftPhotos, uploadShiftPhotos, updateShiftPhoto, deleteShiftPhoto, setJobCoverPhoto,
        shiftReports, saveShiftReport,
        jobVariations, addJobVariation,
        jobContacts, logContact,
        jobAssignments, scheduleAssignments, setJobAssignees, setBookingAssignees,
        addScheduleItem, updateScheduleItem, deleteScheduleItem,
        addInvoice, updateInvoice, markInvoicePaid, unmarkInvoicePaid, voidInvoice,
        addPayRun, updatePayRun,
        confirmBillDraft, confirmBillDraftWithMaterials, confirmBillDraftAsSplit, reallocateBill,
        addMaterials, addMaterialFromOverhead,
        addPaintStock, updatePaintStock, deletePaintStock,
        addQuoteAttachments, ensureJobHasQuote, deleteQuoteAttachment,
        updateQuote, deleteQuote,
        commitImportAsLink, commitImportAsCreate, commitImportAsSkip,
        importBankTransactions, updateBankTransaction, reconcileToEntry, reconcileAsNewEntry, reconcileAsSplitEntries,
        markBillsPaid,
        getQuoteTemplate, saveQuoteTemplate, uploadBusinessLogo, resolveLogoUrl,
        getJobMarketing, saveJobMarketing,
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
