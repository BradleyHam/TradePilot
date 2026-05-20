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
