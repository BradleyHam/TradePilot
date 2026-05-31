export type JobStatus =
  | 'lead'
  | 'quoted'
  | 'accepted'
  | 'booked'
  | 'in-progress'
  | 'completed'
  | 'invoiced'
  | 'paid'
  | 'lost';

export type EntryType =
  | 'expense'
  | 'income'
  | 'hours'
  | 'enquiry'
  | 'quote'
  | 'bill'
  | 'note';

export type ExpenseCategory =
  | 'labour'
  | 'paint'
  | 'materials'
  | 'tools'
  | 'fuel'
  | 'vehicle'
  | 'admin'
  | 'software'
  | 'marketing'
  | 'subcontractor'
  | 'other';

export type ActivityType =
  | 'prep'
  | 'painting'
  | 'staining'
  | 'wallpapering'
  | 'stopping'
  | 'primer'
  | 'repair'
  | 'cleanup'
  | 'travel'
  | 'quoting'
  | 'admin';

/**
 * Who did the work for a logged-hours entry. Drives the blended-target
 * hourly rate on the job's gauge — each tier has its own target rate
 * pulled from the per-business settings table (worker_rate_owner,
 * worker_rate_helper, etc).
 *
 * - `owner`        — Brad himself. Default for all logged hours. The
 *                    fully-loaded PD rate sits here (~$90/hr 2026).
 * - `experienced`  — Trade-qualified second pair of hands. Subbie or
 *                    casual painter at full rate.
 * - `apprentice`   — 2nd-year+ with some skill, supervised. Lower target
 *                    because productivity is lower while learning.
 * - `helper`       — Inexperienced labourer. Prep, sanding, masking,
 *                    cleanup. Brad's partner Sophie sits here.
 * - `subcontractor`— Paid per-job, not per-hour, but we still log time
 *                    so the job's hours math is honest. Charge-out rate
 *                    typically 60-70% of owner rate.
 */
export type WorkerKind =
  | 'owner'
  | 'experienced'
  | 'apprentice'
  | 'helper'
  | 'subcontractor';

/** Settings keys for the per-tier target hourly rates. Stored as strings
 *  in `settings.value`, parsed at read-time. PD-anchored defaults live
 *  in `lib/worker-rates.ts`. */
export const WORKER_RATE_SETTING_KEYS: Record<WorkerKind, string> = {
  owner:         'worker_rate_owner',
  experienced:   'worker_rate_experienced',
  apprentice:    'worker_rate_apprentice',
  helper:        'worker_rate_helper',
  subcontractor: 'worker_rate_subcontractor',
};

export type QuoteStatus =
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'superseded';

export type ProductType =
  | 'paint'
  | 'primer'
  | 'stain'
  | 'filler'
  | 'tape'
  | 'sandpaper'
  | 'brush'
  | 'roller'
  | 'drop_sheet'
  | 'caulk'
  | 'wallpaper'
  | 'other';

export type Finish =
  | 'matte'
  | 'flat'
  | 'low_sheen'
  | 'satin'
  | 'semi_gloss'
  | 'gloss'
  | 'eggshell';

export type Unit =
  | 'litres'
  | 'rolls'
  | 'sheets'
  | 'each'
  | 'metres'
  | 'kg';

export type ScheduleItemType =
  | 'job_booking'
  | 'quote_visit'
  | 'follow_up'
  | 'bill_due'
  | 'invoice_due'
  | 'reminder';

/**
 * Where a lead/job originally came from. Free-form (not a check constraint
 * in the DB) so we can add new channels without a migration.
 */
export type LeadSource = 'website' | 'email' | 'phone' | 'referral' | 'gmb' | 'manual';

/**
 * Type of work being quoted. `mixed` covers combination scopes
 * (eg. exterior repaint + deck restain) where one bucket is misleading.
 */
export type WorkType =
  | 'interior'
  | 'exterior'
  | 'cedar'
  | 'wallpaper'
  | 'roof'
  | 'mixed';

/**
 * Loose categorisation of how much prep the job needs. Used to compare
 * "$/m²" between jobs apples-to-apples — a heavy-prep exterior costs more
 * per m² than a light-prep one, and we want the data to reflect that.
 */
export type PrepLevel = 'light' | 'medium' | 'heavy' | 'full-strip';

/** Why a quoted/accepted job didn't convert. Set when status moves to 'lost'. */
export type LostReason =
  | 'price'
  | 'no-reply'
  | 'went-elsewhere'
  | 'scope-changed'
  | 'project-cancelled'
  | 'timing'
  | 'other';

/** Why a quote landed. Set when status moves to 'accepted'. */
export type WonReason =
  | 'referral'
  | 'returning-client'
  | 'price'
  | 'trust-rapport'
  | 'speed-of-response'
  | 'unique-fit'
  | 'other';

export interface Job {
  id: string;
  businessId: string;
  legacyId?: string;
  name: string;
  clientName: string;
  clientEmail?: string;
  clientPhone?: string;
  location?: string;
  status: JobStatus;
  estimatedValue?: number;
  quoteAmount?: number;
  invoiceAmount?: number;
  startDate?: string;
  endDate?: string;
  followUpDate?: string;
  /**
   * Last time Brad actively touched this lead/client — sent a message,
   * picked up the phone, sent the quote, replied to a question. Used by
   * the Leads chase-list to surface stale leads ("9 days since you last
   * heard from Sarah"). Bumped by the "Mark contacted" button on the
   * leads page and auto-set when a quote is sent. Null on legacy rows
   * and on rows that have never been touched since creation — the UI
   * falls back to createdAt in that case so the badge still reads sensibly.
   */
  lastContactedDate?: string;
  notes?: string;
  /** How the lead came in. Null for legacy/imported rows. */
  source?: LeadSource;
  /** What kind of work — drives like-with-like comparisons. */
  workType?: WorkType;
  /** Approximate quoted surface area in m². Used for $/m² benchmarks. */
  surfaceAreaM2?: number;
  /** Subjective sense of how much prep this job needs. */
  prepLevel?: PrepLevel;
  /**
   * Free-form scope notes captured at the site visit, in Brad's words.
   * Distinct from `notes` (which is general-purpose) — this is specifically
   * the "I walked the property and saw…" capture from the wrap-up sheet.
   * Feeds Tier-2 quote drafting later.
   */
  scopeNotes?: string;
  /**
   * Site-access chip values captured at the wrap-up. Drives whether Brad
   * needs scaffold, a cherry-picker, or just a ladder — and reminds him
   * to mention these in the quote. Free-form strings so the chip
   * vocabulary can evolve without a migration.
   *
   * Example: ['ladder-ok', 'second-storey', 'tight-driveway']
   */
  accessNotes?: string[];
  /**
   * Date Brad promised the customer the quote by. Drives a "quote owed"
   * surface on Home — the bridge between "site visit done" and "quote
   * actually sent". Nullable; only meaningful while status is lead/quoted.
   */
  quoteReadyBy?: string;
  /**
   * Coats to apply — 1 / 2 / 3 typically. After area, the single biggest
   * lever on materials cost AND labour (each extra coat is ~1 extra day
   * for a 100m² job once drying time is factored in).
   */
  coatsCount?: number;
  /**
   * Stain / paint product brand+name. Free text so Brad can write what
   * he actually uses ('Wood-X mid stain', 'Cedarshield natural', 'Resene
   * Woodsman cedar'). Drives materials cost AND recommended coat count.
   */
  stainProduct?: string;
  /**
   * Rough count of windows + doors in the cedar area. Used to estimate
   * cutting-in time (every window means ~10 minutes of slow careful
   * brush work). 0 is valid (a fully-clad shed has none).
   */
  windowDoorCount?: number;
  /**
   * Additional items the quote covers beyond the main cedar walls.
   * Multi-select chip values: 'soffits', 'decking', 'handrails',
   * 'pergola', 'gates', 'window-frames', 'fascia', 'garage-doors',
   * 'pergola-posts'. Free-form strings so the vocabulary evolves
   * without a migration. Stored as text[].
   */
  addonItems?: string[];
  /**
   * Site logistics chips — practical realities that affect job setup
   * time and tool/material selection. Examples: 'off-street-parking',
   * 'water-available', 'power-for-sander', 'pets-to-manage',
   * 'tenanted', 'children-on-site', 'restricted-hours'. Multi-select.
   */
  siteLogistics?: string[];
  /**
   * Brad's gut estimate of the job duration in days (decimal allowed
   * for half-days). Sanity-checked against area+prep math by the AI —
   * if they disagree by >30% something's worth a second look.
   */
  daysEstimate?: number;
  /**
   * Soft commercial factors that move the quote price ±15% without
   * changing the cost basis. Examples: 'referral', 'repeat-customer',
   * 'price-shopping', 'urgent', 'mentioned-budget', 'first-impression-strong',
   * 'decision-maker-present', 'not-a-rush'. Drives the AI's suggested
   * price range vs. its calculated cost. Multi-select chips.
   */
  commercialSignals?: string[];
  /** Set when status = 'lost'. Mutually exclusive with wonReason. */
  lostReason?: LostReason;
  /** Set when status = 'accepted'. Mutually exclusive with lostReason. */
  wonReason?: WonReason;
  /** Free-text colour on the win/loss reason. Optional. */
  outcomeNotes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Entry {
  id: string;
  businessId: string;
  jobId?: string;
  type: EntryType;
  category?: ExpenseCategory;
  amount?: number;
  hours?: number;
  activity?: ActivityType;
  /**
   * Who did the work. Only meaningful for `type === 'hours'`. Defaults
   * to 'owner' (Brad solo) on the entry form. Drives the blended-target
   * gauge on the job's hourly-rate chart.
   */
  workerKind?: WorkerKind;
  /**
   * Additional hours from a HELPER on this same shift, captured as a
   * convenience when Brad logs his own hours. Saves logging two
   * separate entries when he + Sophie do the same 6h together (he logs
   * `hours: 6, workerKind: 'owner', helperHours: 6`). The helper-hours
   * portion is priced at the `worker_rate_helper` target rate.
   *
   * For more complex multi-worker setups (apprentice + helper + Brad
   * all different hours), log each as a separate entry with its own
   * workerKind.
   */
  helperHours?: number;
  supplier?: string;
  paymentMethod?: string;
  gstApplies: boolean;
  amountExGst?: number;
  gstComponent?: number;
  description: string;
  entryDate: string;
  dueDate?: string;
  // Bill-specific
  company?: string;
  paid?: boolean;
  paidDate?: string;
  paymentRef?: string;
  /** Set when reconciled to a bank transaction. */
  bankTransactionId?: string;
  /**
   * Where this lead came from. Only meaningful for `type === 'enquiry'`
   * entries; the entry form only surfaces the picker for enquiries. Null
   * for other entry types and for legacy enquiries logged before this
   * field existed.
   */
  leadSource?: LeadSource;
  // Draft-bill fields (populated by the PDF upload + LLM extraction flow).
  // A draft is an unconfirmed bill — it doesn't count against expenses or
  // GST until isDraft flips to false (via the Home "Bills to confirm"
  // Confirm button). EVERY bill-aggregating query in the app must filter
  // !isDraft or drafts will leak into money math.
  /** True while awaiting Brad's confirmation. Always undefined/false for non-bill entries. */
  isDraft?: boolean;
  /** Object path inside the `bill-pdfs` Supabase Storage bucket. NOT a URL — URLs expire. */
  billPdfUrl?: string;
  /** Coarse confidence from the parser; used to nudge Brad to double-check on confirm. */
  parserConfidence?: 'high' | 'medium' | 'low';
  /** Raw JSON the parser emitted. Debugging / future re-processing only. */
  parserRaw?: unknown;
  /**
   * Email Message-ID of the inbound webhook that created this draft. Used
   * for idempotency — retried webhook deliveries with the same Message-ID
   * hit the unique index and short-circuit. Only set on entries created
   * via /api/webhooks/inbound-bill; null for manual uploads + legacy data.
   */
  sourceMessageId?: string;
  /**
   * Links the slices of ONE supplier bill that was split across multiple
   * jobs at confirm time. Every sibling bill entry created from the same
   * invoice shares this id; a normal single-job bill leaves it undefined.
   * Lets us keep the slices together for display, exempt them from
   * duplicate detection, and reconcile a payment against the whole group.
   */
  billGroupId?: string;
  createdAt: string;
}

/**
 * Structured fields extracted by the bill PDF parser. Returned by the
 * /api/parse-bill route. All money values in NZD; dates ISO YYYY-MM-DD.
 * Every field is optional because parsing is best-effort — the confirm UI
 * shows what was found and Brad fills any gaps before confirming.
 */
export interface ParsedBill {
  supplier?: string;
  invoiceNumber?: string;
  /** Gross amount the bill says to pay. */
  totalInclGst?: number;
  /** GST portion of the total. For NZ-registered suppliers this is total ÷ 23 × 3. */
  gstComponent?: number;
  /** Derived server-side: totalInclGst - gstComponent. The "real cost" Brad pays. */
  amountExGst?: number;
  /** Date the supplier issued the invoice. */
  invoiceDate?: string;
  /** Date Brad needs to pay by. */
  dueDate?: string;
  /** Optional itemised list. */
  lineItems?: { description: string; quantity?: number; unitPrice?: number; total?: number }[];
  /** Freeform text the parser thinks identifies the job: address, PO number, etc. */
  jobHint?: string;
  /** Overall confidence — informs the UI's "double-check this" affordance. */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Extracted fields from a customer-facing INVOICE PDF (one we issued, not
 * a supplier bill). Used by the Issue-invoice form's drop-zone: drag the
 * PDF in, this gets populated, the form pre-fills.
 *
 * Distinct from ParsedBill — bills are money-OUT (suppliers billing us),
 * invoices are money-IN (us billing customers). Different schema fields
 * (no supplier; has invoice kind), different LLM prompt (NZ tradie
 * invoice vs supplier invoice).
 */
export interface ParsedInvoice {
  /** The invoice number as printed on the document (e.g. "INV-034-DEP"). */
  invoiceNumber?: string;
  /** Date the invoice was issued (ISO YYYY-MM-DD). */
  invoiceDate?: string;
  /** Date payment is due (ISO YYYY-MM-DD) — often "On receipt", which becomes invoiceDate. */
  dueDate?: string;
  /** Total gross amount due (GST-inclusive). */
  totalInclGst?: number;
  /** GST portion. For NZ-registered tradies this is total ÷ 23 × 3. */
  gstComponent?: number;
  /** Net amount excluding GST (derived server-side: totalInclGst - gstComponent). */
  amountExGst?: number;
  /**
   * Invoice classification — deposit / progress / final. Inferred from the
   * description line ("Deposit (30%)…", "Final invoice…") or the invoice
   * number suffix (-DEP, -F, -P1). Omitted when ambiguous.
   */
  kind?: InvoiceKind;
  /** Project / job reference printed on the invoice (e.g. "Administration Building"). */
  projectRef?: string;
  /** Customer name (e.g. "Terry Emmitt"). Used for job-matching. */
  customerName?: string;
  /** Quote reference printed on the invoice (e.g. "QUO-034"). */
  quoteRef?: string;
  /** Short description line for the form's notes/variation field. */
  description?: string;
  /** Overall confidence — informs the UI's "double-check this" affordance. */
  confidence: 'high' | 'medium' | 'low';
}

export type BankTransactionStatus = 'unreconciled' | 'matched' | 'ignored' | 'personal';

export interface BankTransaction {
  id: string;
  businessId: string;
  bankAccountId?: string;
  txnDate: string;
  /** Signed: negative for debits, positive for credits. */
  amount: number;
  payee?: string;
  particulars?: string;
  code?: string;
  reference?: string;
  tranType?: string;
  otherPartyAccount?: string;
  description: string;
  fingerprint: string;
  status: BankTransactionStatus;
  entryId?: string;
  notes?: string;
  importedAt: string;
}

export interface Material {
  id: string;
  businessId: string;
  jobId?: string;
  entryId?: string;
  usedOn?: string;
  productType?: ProductType;
  brand?: string;
  productName?: string;
  color?: string;
  finish?: Finish;
  quantity?: number;
  unit?: Unit;
  cost?: number;
  supplier?: string;
  area?: string;
  notes?: string;
  /**
   * Where this material row came from:
   *   - 'bill'     : derived from a confirmed supplier bill line item
   *                  (linked via entryId). The bill's entry is what
   *                  drives business-wide expense totals.
   *   - 'overhead' : user-entered usage of something they already owned
   *                  (no entryId, no fresh cash outflow). Counts toward
   *                  the JOB'S material cost in per-job profit, but
   *                  does NOT count in business-wide expenses (because
   *                  the original purchase already counted under
   *                  overhead at the time).
   *
   * Older rows that pre-date migration 010 read back as 'bill' by
   * default (set by the migration's column default).
   */
  source?: 'bill' | 'overhead';
  createdAt: string;
}

export interface Quote {
  id: string;
  businessId: string;
  legacyId?: string;
  legacyEnquiryId?: string;
  jobId?: string;
  dateSent?: string;
  clientName?: string;
  jobAddress?: string;
  jobType?: string;
  scopeSummary?: string;
  baseAmountExGst?: number;
  optionAmountExGst?: number;
  totalAmountInclGst?: number;
  status?: QuoteStatus;
  wonAmountExGst?: number;
  varianceAmount?: number;
  variancePercent?: number;
  notes?: string;
  // Scope fields populated by the site-capture flow + the project importer
  // (which extracts what it can from quote PDFs + council plans).
  // m²-by-zone is a map: { "weatherboards": 120, "soffits": 30, ... } so
  // we can later analyse $/m² per surface type, not just per whole job.
  surfaceAreaM2ByZone?: Record<string, number>;
  prepLevel?: PrepLevel;
  /** Free-form surface description ("weatherboard", "cedar", "linea", etc). */
  surfaceType?: string;
  /**
   * Qualitative signals captured at the site visit. Kept loose so the
   * vocabulary can grow without a schema change. Typical shape:
   *   priceSensitivity: 'cheap' | 'mid' | 'premium'
   *   urgency: 'low' | 'medium' | 'high'
   *   decisionMakerPresent: boolean
   *   leadSource: LeadSource
   */
  clientSignals?: Record<string, unknown>;
  /** Folder path the project importer pulled this row from. */
  importSourcePath?: string;
  /**
   * Per-zone structured scope used by the cost engine. Richer than the
   * legacy `surfaceAreaM2ByZone` map (which only knows m² per labelled
   * zone) — each entry here also carries surface type, work kind,
   * prep level, and the measurement unit (m² / LM / count).
   *
   * Shape mirrors `ScopeZone` in `lib/pricing/cost-engine.ts`. Kept as
   * `unknown[]` here to avoid a circular import between types and the
   * pricing module; cost-engine.ts re-exports the typed shape.
   */
  scopeZones?: unknown[];
  /** What a competing painter quoted for the same job, if known. ex-GST. */
  competitorPriceExGst?: number;
  /** When the outcome (won/lost/ghosted) was decided. */
  outcomeDate?: string;
  /** Free-form reason text — supersedes the legacy enums. */
  outcomeReason?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A file attached to a quote — council plan, before/after photo, scope
 * photo, or the sent quote PDF itself. Storage object lives in the
 * `quote-attachments` Supabase Storage bucket; we store the path, never
 * a signed URL (URLs expire, paths don't).
 */
export type QuoteAttachmentKind =
  | 'plan'
  | 'before_photo'
  | 'after_photo'
  | 'scope_photo'
  | 'quote_pdf'
  | 'other';

/**
 * Project archive import staging row. One per folder discovered by
 * scripts/import-projects.ts --apply. Holds the suggested job match +
 * classified files + LLM-parsed quote data BEFORE it lands in real
 * jobs/quotes/quote_attachments tables. User reviews each row in the
 * "Imports to review" flag on Home and commits it as link/create/skip.
 */
export type ImportConfidence = 'high' | 'medium' | 'low' | 'none';
export type ImportStatus = 'pending' | 'committed' | 'skipped';
export type ImportDecision = 'link' | 'create' | 'skip';

/** Counts of classified files in a folder, returned by the importer walker. */
export interface FolderFileCounts {
  plan?: number;
  quote_pdf?: number;
  invoice_pdf?: number;
  before_photo?: number;
  after_photo?: number;
  scope_photo?: number;
  notes_md?: number;
  video?: number;
  spreadsheet?: number;
  other?: number;
}

/**
 * Result of parsing a quote PDF via Anthropic. Mirrors the shape of
 * ParsedBill but for the quote use case — extracted fields land here,
 * then on commit they flow into the corresponding `quotes` row.
 */
export interface ParsedQuote {
  clientName?: string;
  jobAddress?: string;
  jobType?: string;
  scopeSummary?: string;
  baseAmountExGst?: number;
  totalAmountInclGst?: number;
  dateSent?: string;
  lineItems?: { description: string; amount?: number }[];
  /** Optional surface-area-by-zone extracted from the quote scope text. */
  surfaceAreaM2ByZone?: Record<string, number>;
  /** Free-form surface description if the quote mentions it ("weatherboard"). */
  surfaceType?: string;
  prepLevel?: PrepLevel;
  confidence: 'high' | 'medium' | 'low';
}

export interface JobImport {
  id: string;
  businessId: string;
  /** Absolute filesystem path the folder was discovered at. Audit only. */
  sourcePath: string;
  /** Display name (basename) of the folder. */
  folderName: string;
  /** Suggested existing job from the dry-run matcher; user can override. */
  suggestedJobId?: string;
  suggestedLegacyId?: string;
  suggestedLabel?: string;
  matchConfidence: ImportConfidence;
  matchSource?: string;
  /** Classified file counts — for the UI's at-a-glance summary. */
  filesSummary: FolderFileCounts;
  /** Storage prefix where staged attachments live ("_pending/{importId}/"). */
  attachmentsStoragePrefix?: string;
  /** LLM-extracted quote fields if a quote PDF was found in the folder. */
  parsedData?: ParsedQuote;
  status: ImportStatus;
  commitAction?: ImportDecision;
  commitTargetJobId?: string;
  commitTargetQuoteId?: string;
  committedAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteAttachment {
  id: string;
  businessId: string;
  quoteId: string;
  kind: QuoteAttachmentKind;
  /** Object path inside the `quote-attachments` bucket. */
  storagePath: string;
  fileName?: string;
  pageCount?: number;
  /** Filled in by the council-plan parser once it runs over a `plan` kind. */
  parsedM2ByZone?: Record<string, number>;
  parsedConfidence?: 'high' | 'medium' | 'low';
  createdAt: string;
}

export interface Setting {
  businessId: string;
  key: string;
  value?: string;
  notes?: string;
  updatedAt: string;
}

/**
 * Per-business quote template. Stored as a JSON blob in the `settings`
 * row keyed 'quote_template' so the schema can evolve without
 * migrations. Seeded by migration 014 with sensible Lakeside defaults;
 * editable via /settings/quote-template (Session 1 of the quote
 * builder work).
 *
 * Used by:
 *   - The settings UI (read + write).
 *   - The future AI quote drafter (read — to know the business
 *     identity it's writing on behalf of).
 *   - The future React-PDF generator (read — to render header,
 *     payment terms, T&Cs on the PDF).
 *
 * All fields nullable so an under-filled template still renders
 * something (just with placeholders) rather than blowing up.
 */
export interface QuoteTemplate {
  header: {
    /** Trading name shown at the top of the PDF. */
    businessName?: string;
    /** NZ GST registration number, formatted XX-XXX-XXX. */
    gstNumber?: string;
    phone?: string;
    email?: string;
    /** Physical address — appears under the header. */
    address?: string;
    /**
     * Storage path of the logo in the `business-logos` bucket,
     * e.g. "<businessId>/logo.png". The UI resolves this to a
     * public URL for display + PDF embed.
     */
    logoStoragePath?: string;
  };
  paymentTerms: {
    /** % deposit required to confirm the booking. NZ standard ~30%. */
    depositPercent: number;
    /** Days from quote acceptance to deposit due. */
    depositDueDays: number;
    /**
     * When the balance is payable. 'on_completion' = single lump
     * at job end. Future: 'progress' would add a midway payment.
     */
    balanceDue: 'on_completion' | 'progress';
  };
  /** Quote validity in days from issue date. Default 30. */
  validityDays: number;
  /**
   * 'incl' = totals shown GST-inclusive (NZ retail convention).
   * 'excl' = ex-GST + GST line + incl-GST total. We default to
   * 'incl' because residential customers expect it.
   */
  gstTreatment: 'incl' | 'excl';
  /**
   * Free-form T&Cs / scope-exclusions block. Plain text — bullets
   * with hyphens, line breaks via \n. The PDF generator splits on
   * newlines to render a list.
   */
  defaultTerms?: string;
}

export type InvoiceKind = 'deposit' | 'progress' | 'final';

export interface Invoice {
  id: string;
  businessId: string;
  jobId: string;
  invoiceNumber: string;
  invoiceDate: string;
  kind: InvoiceKind;
  amountExGst: number;
  gstApplies: boolean;
  gstComponent?: number;
  amountInclGst?: number;
  paid: boolean;
  paidDate?: string;
  paidVia?: string;
  /** When marked paid, an income entry is auto-created and linked here. */
  incomeEntryId?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Reason a scheduled day was skipped (not worked). Free-form text in
 * Postgres (migration 020) so the vocabulary can evolve without an
 * ALTER TYPE migration; this union is the canonical client-side list.
 *
 *   rained_off       → weather. Most common reason for an outdoor painter.
 *   sick             → Brad or a crew member sick.
 *   client_postponed → customer wasn't ready / asked to delay.
 *   other            → catch-all. Always paired with a free-form note in
 *                      `skip_reason`.
 */
export type ScheduleSkipReasonKind =
  | 'rained_off'
  | 'sick'
  | 'client_postponed'
  | 'other';

export interface ScheduleItem {
  id: string;
  businessId: string;
  jobId?: string;
  type: ScheduleItemType;
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  notes?: string;
  completed: boolean;
  /**
   * When set, this scheduled day was skipped — the user couldn't / didn't
   * work it. Distinct from `completed` (which means "I worked it"). A
   * skipped day stays visible on the calendar but renders faded with the
   * reason chip, and never shows as Overdue.
   *
   * Migration 020 added the underlying columns. Both null = not skipped.
   */
  skipReasonKind?: ScheduleSkipReasonKind;
  /** Optional free-form note. Required when skipReasonKind === 'other'. */
  skipReason?: string;
  /**
   * True once the user has downloaded the .ics calendar invite for this
   * item. Only meaningful for type='quote_visit' rows today — drives the
   * "Reminders set" vs "Add to calendar" badge on the Schedule page so
   * Brad can see at a glance which site visits actually have phone
   * reminders attached vs which were skipped.
   *
   * Note: this is a "best guess" signal — it tells us the file was
   * downloaded, NOT that the user actually imported it into their
   * calendar app. There's no way to confirm the latter from a browser.
   * The badge wording reflects this honestly ("Reminders set" assumes
   * the obvious next step happened; we don't claim "Reminders active").
   */
  icsDownloaded?: boolean;
  createdAt: string;
}

export interface Business {
  id: string;
  ownerId: string;
  name: string;
  industry: string;
  createdAt: string;
}

export interface ParsedEntry {
  type: EntryType;
  jobName?: string;
  clientName?: string;
  amount?: number;
  hours?: number;
  category?: ExpenseCategory;
  supplier?: string;
  description: string;
  dueDate?: string;
  /** ISO YYYY-MM-DD if the parser detected a date in the text. */
  entryDate?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface MonthlyData {
  month: string;
  revenue: number;
  expenses: number;
}

export interface CategoryData {
  category: string;
  amount: number;
}

export interface PipelineData {
  status: string;
  value: number;
  count: number;
}
