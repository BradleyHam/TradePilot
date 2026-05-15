// Map between Supabase rows (snake_case) and Trade Pilot domain types (camelCase).
// Keep all column-name knowledge here so the rest of the app stays clean.

import type {
  Job, Entry, ScheduleItem, Material, Quote, QuoteAttachment, QuoteAttachmentKind,
  Setting, Invoice, BankTransaction,
  JobImport, ImportConfidence, ImportStatus, ImportDecision,
  FolderFileCounts, ParsedQuote,
  JobStatus, EntryType, ExpenseCategory, ActivityType,
  ProductType, Finish, Unit, QuoteStatus, ScheduleItemType, InvoiceKind,
  BankTransactionStatus, LeadSource, WorkType, PrepLevel, LostReason, WonReason,
} from '../types';

type Row = Record<string, unknown>;

// ── Helpers ─────────────────────────────────────────────────────────────────
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : undefined;
}
function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'TRUE' || v === 'true';
  return fallback;
}

// ── Job ─────────────────────────────────────────────────────────────────────
export function rowToJob(r: Row): Job {
  return {
    id: r.id as string,
    businessId: r.business_id as string,
    legacyId: asString(r.legacy_id),
    name: r.name as string,
    clientName: r.client_name as string,
    clientEmail: asString(r.client_email),
    clientPhone: asString(r.client_phone),
    location: asString(r.location),
    status: r.status as JobStatus,
    estimatedValue: asNumber(r.estimated_value),
    quoteAmount: asNumber(r.quote_amount),
    invoiceAmount: asNumber(r.invoice_amount),
    startDate: asString(r.start_date),
    endDate: asString(r.end_date),
    followUpDate: asString(r.follow_up_date),
    notes: asString(r.notes),
    source: (asString(r.source) as LeadSource | undefined),
    workType: (asString(r.work_type) as WorkType | undefined),
    surfaceAreaM2: asNumber(r.surface_area_m2),
    prepLevel: (asString(r.prep_level) as PrepLevel | undefined),
    lostReason: (asString(r.lost_reason) as LostReason | undefined),
    wonReason: (asString(r.won_reason) as WonReason | undefined),
    outcomeNotes: asString(r.outcome_notes),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function jobToRow(j: Partial<Job>): Row {
  // Only include defined fields so partial updates don't clobber columns.
  const out: Row = {};
  if (j.businessId !== undefined) out.business_id = j.businessId;
  if (j.legacyId !== undefined) out.legacy_id = j.legacyId;
  if (j.name !== undefined) out.name = j.name;
  if (j.clientName !== undefined) out.client_name = j.clientName;
  if (j.clientEmail !== undefined) out.client_email = j.clientEmail;
  if (j.clientPhone !== undefined) out.client_phone = j.clientPhone;
  if (j.location !== undefined) out.location = j.location;
  if (j.status !== undefined) out.status = j.status;
  if (j.estimatedValue !== undefined) out.estimated_value = j.estimatedValue;
  if (j.quoteAmount !== undefined) out.quote_amount = j.quoteAmount;
  if (j.invoiceAmount !== undefined) out.invoice_amount = j.invoiceAmount;
  if (j.startDate !== undefined) out.start_date = j.startDate;
  if (j.endDate !== undefined) out.end_date = j.endDate;
  if (j.followUpDate !== undefined) out.follow_up_date = j.followUpDate;
  if (j.notes !== undefined) out.notes = j.notes;
  if (j.source !== undefined) out.source = j.source || null;
  if (j.workType !== undefined) out.work_type = j.workType || null;
  if (j.surfaceAreaM2 !== undefined) out.surface_area_m2 = j.surfaceAreaM2 ?? null;
  if (j.prepLevel !== undefined) out.prep_level = j.prepLevel || null;
  if (j.lostReason !== undefined) out.lost_reason = j.lostReason || null;
  if (j.wonReason !== undefined) out.won_reason = j.wonReason || null;
  if (j.outcomeNotes !== undefined) out.outcome_notes = j.outcomeNotes || null;
  return out;
}

// ── Entry ───────────────────────────────────────────────────────────────────
export function rowToEntry(r: Row): Entry {
  return {
    id: r.id as string,
    businessId: r.business_id as string,
    jobId: asString(r.job_id),
    type: r.type as EntryType,
    category: (asString(r.category) as ExpenseCategory | undefined),
    amount: asNumber(r.amount),
    hours: asNumber(r.hours),
    activity: (asString(r.activity) as ActivityType | undefined),
    supplier: asString(r.supplier),
    paymentMethod: asString(r.payment_method),
    gstApplies: asBool(r.gst_applies, true),
    amountExGst: asNumber(r.amount_ex_gst),
    gstComponent: asNumber(r.gst_component),
    description: r.description as string,
    entryDate: r.entry_date as string,
    dueDate: asString(r.due_date),
    company: asString(r.company),
    paid: asBool(r.paid, false),
    paidDate: asString(r.paid_date),
    paymentRef: asString(r.payment_ref),
    bankTransactionId: asString(r.bank_transaction_id),
    // Draft-bill fields. asBool(_, false) so legacy rows (column nullable
    // before migration applied locally) read as confirmed.
    isDraft: asBool(r.is_draft, false),
    billPdfUrl: asString(r.bill_pdf_url),
    parserConfidence: asString(r.parser_confidence) as Entry['parserConfidence'],
    parserRaw: r.parser_raw ?? undefined,
    sourceMessageId: asString(r.source_message_id),
    createdAt: r.created_at as string,
  };
}

export function entryToRow(e: Partial<Entry>): Row {
  const out: Row = {};
  if (e.businessId !== undefined) out.business_id = e.businessId;
  if (e.jobId !== undefined) out.job_id = e.jobId || null;
  if (e.type !== undefined) out.type = e.type;
  if (e.category !== undefined) out.category = e.category || null;
  if (e.amount !== undefined) out.amount = e.amount ?? null;
  if (e.hours !== undefined) out.hours = e.hours ?? null;
  if (e.activity !== undefined) out.activity = e.activity || null;
  if (e.supplier !== undefined) out.supplier = e.supplier || null;
  if (e.paymentMethod !== undefined) out.payment_method = e.paymentMethod || null;
  if (e.gstApplies !== undefined) out.gst_applies = e.gstApplies;
  if (e.amountExGst !== undefined) out.amount_ex_gst = e.amountExGst ?? null;
  if (e.gstComponent !== undefined) out.gst_component = e.gstComponent ?? null;
  if (e.description !== undefined) out.description = e.description;
  if (e.entryDate !== undefined) out.entry_date = e.entryDate;
  if (e.dueDate !== undefined) out.due_date = e.dueDate || null;
  if (e.company !== undefined) out.company = e.company || null;
  if (e.paid !== undefined) out.paid = e.paid;
  if (e.paidDate !== undefined) out.paid_date = e.paidDate || null;
  if (e.paymentRef !== undefined) out.payment_ref = e.paymentRef || null;
  if (e.bankTransactionId !== undefined) out.bank_transaction_id = e.bankTransactionId || null;
  // Draft-bill fields. Use the same `!== undefined` guard pattern so
  // partial updates don't accidentally clear other fields.
  if (e.isDraft !== undefined) out.is_draft = e.isDraft;
  if (e.billPdfUrl !== undefined) out.bill_pdf_url = e.billPdfUrl || null;
  if (e.parserConfidence !== undefined) out.parser_confidence = e.parserConfidence || null;
  if (e.parserRaw !== undefined) out.parser_raw = e.parserRaw ?? null;
  if (e.sourceMessageId !== undefined) out.source_message_id = e.sourceMessageId || null;
  return out;
}

// ── ScheduleItem ────────────────────────────────────────────────────────────
export function rowToScheduleItem(r: Row): ScheduleItem {
  return {
    id: r.id as string,
    businessId: r.business_id as string,
    jobId: asString(r.job_id),
    type: r.type as ScheduleItemType,
    title: r.title as string,
    date: r.date as string,
    startTime: asString(r.start_time),
    endTime: asString(r.end_time),
    notes: asString(r.notes),
    completed: asBool(r.completed, false),
    createdAt: r.created_at as string,
  };
}

export function scheduleItemToRow(s: Partial<ScheduleItem>): Row {
  const out: Row = {};
  if (s.businessId !== undefined) out.business_id = s.businessId;
  if (s.jobId !== undefined) out.job_id = s.jobId || null;
  if (s.type !== undefined) out.type = s.type;
  if (s.title !== undefined) out.title = s.title;
  if (s.date !== undefined) out.date = s.date;
  if (s.startTime !== undefined) out.start_time = s.startTime || null;
  if (s.endTime !== undefined) out.end_time = s.endTime || null;
  if (s.notes !== undefined) out.notes = s.notes || null;
  if (s.completed !== undefined) out.completed = s.completed;
  return out;
}

// ── Material ────────────────────────────────────────────────────────────────
export function rowToMaterial(r: Row): Material {
  return {
    id: r.id as string,
    businessId: r.business_id as string,
    jobId: asString(r.job_id),
    entryId: asString(r.entry_id),
    usedOn: asString(r.used_on),
    productType: (asString(r.product_type) as ProductType | undefined),
    brand: asString(r.brand),
    productName: asString(r.product_name),
    color: asString(r.color),
    finish: (asString(r.finish) as Finish | undefined),
    quantity: asNumber(r.quantity),
    unit: (asString(r.unit) as Unit | undefined),
    cost: asNumber(r.cost),
    supplier: asString(r.supplier),
    area: asString(r.area),
    notes: asString(r.notes),
    createdAt: r.created_at as string,
  };
}

export function materialToRow(m: Partial<Material>): Row {
  const out: Row = {};
  if (m.businessId !== undefined) out.business_id = m.businessId;
  if (m.jobId !== undefined) out.job_id = m.jobId || null;
  if (m.entryId !== undefined) out.entry_id = m.entryId || null;
  if (m.usedOn !== undefined) out.used_on = m.usedOn || null;
  // Enum-typed fields: an empty string would violate the column's CHECK.
  // Coerce empty/undefined back to null so partial updates can clear them.
  if (m.productType !== undefined) out.product_type = m.productType || null;
  if (m.brand !== undefined) out.brand = m.brand || null;
  if (m.productName !== undefined) out.product_name = m.productName || null;
  if (m.color !== undefined) out.color = m.color || null;
  if (m.finish !== undefined) out.finish = m.finish || null;
  if (m.quantity !== undefined) out.quantity = m.quantity ?? null;
  if (m.unit !== undefined) out.unit = m.unit || null;
  if (m.cost !== undefined) out.cost = m.cost ?? null;
  if (m.supplier !== undefined) out.supplier = m.supplier || null;
  if (m.area !== undefined) out.area = m.area || null;
  if (m.notes !== undefined) out.notes = m.notes || null;
  return out;
}

// ── Quote ───────────────────────────────────────────────────────────────────
export function rowToQuote(r: Row): Quote {
  return {
    id: r.id as string,
    businessId: r.business_id as string,
    legacyId: asString(r.legacy_id),
    legacyEnquiryId: asString(r.legacy_enquiry_id),
    jobId: asString(r.job_id),
    dateSent: asString(r.date_sent),
    clientName: asString(r.client_name),
    jobAddress: asString(r.job_address),
    jobType: asString(r.job_type),
    scopeSummary: asString(r.scope_summary),
    baseAmountExGst: asNumber(r.base_amount_ex_gst),
    optionAmountExGst: asNumber(r.option_amount_ex_gst),
    totalAmountInclGst: asNumber(r.total_amount_incl_gst),
    status: (asString(r.status) as QuoteStatus | undefined),
    wonAmountExGst: asNumber(r.won_amount_ex_gst),
    varianceAmount: asNumber(r.variance_amount),
    variancePercent: asNumber(r.variance_percent),
    notes: asString(r.notes),
    surfaceAreaM2ByZone: (r.surface_area_m2_by_zone as Record<string, number> | null) ?? undefined,
    prepLevel: (asString(r.prep_level) as PrepLevel | undefined),
    surfaceType: asString(r.surface_type),
    clientSignals: (r.client_signals as Record<string, unknown> | null) ?? undefined,
    importSourcePath: asString(r.import_source_path),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function quoteToRow(q: Partial<Quote>): Row {
  const out: Row = {};
  if (q.businessId !== undefined) out.business_id = q.businessId;
  if (q.legacyId !== undefined) out.legacy_id = q.legacyId || null;
  if (q.legacyEnquiryId !== undefined) out.legacy_enquiry_id = q.legacyEnquiryId || null;
  if (q.jobId !== undefined) out.job_id = q.jobId || null;
  if (q.dateSent !== undefined) out.date_sent = q.dateSent || null;
  if (q.clientName !== undefined) out.client_name = q.clientName || null;
  if (q.jobAddress !== undefined) out.job_address = q.jobAddress || null;
  if (q.jobType !== undefined) out.job_type = q.jobType || null;
  if (q.scopeSummary !== undefined) out.scope_summary = q.scopeSummary || null;
  if (q.baseAmountExGst !== undefined) out.base_amount_ex_gst = q.baseAmountExGst ?? null;
  if (q.optionAmountExGst !== undefined) out.option_amount_ex_gst = q.optionAmountExGst ?? null;
  if (q.totalAmountInclGst !== undefined) out.total_amount_incl_gst = q.totalAmountInclGst ?? null;
  if (q.status !== undefined) out.status = q.status || null;
  if (q.wonAmountExGst !== undefined) out.won_amount_ex_gst = q.wonAmountExGst ?? null;
  if (q.varianceAmount !== undefined) out.variance_amount = q.varianceAmount ?? null;
  if (q.variancePercent !== undefined) out.variance_percent = q.variancePercent ?? null;
  if (q.notes !== undefined) out.notes = q.notes || null;
  if (q.surfaceAreaM2ByZone !== undefined) out.surface_area_m2_by_zone = q.surfaceAreaM2ByZone ?? null;
  if (q.prepLevel !== undefined) out.prep_level = q.prepLevel || null;
  if (q.surfaceType !== undefined) out.surface_type = q.surfaceType || null;
  if (q.clientSignals !== undefined) out.client_signals = q.clientSignals ?? null;
  if (q.importSourcePath !== undefined) out.import_source_path = q.importSourcePath || null;
  return out;
}

// ── QuoteAttachment ─────────────────────────────────────────────────────────
export function rowToQuoteAttachment(r: Row): QuoteAttachment {
  return {
    id: r.id as string,
    businessId: r.business_id as string,
    quoteId: r.quote_id as string,
    kind: r.kind as QuoteAttachmentKind,
    storagePath: r.storage_path as string,
    fileName: asString(r.file_name),
    pageCount: asNumber(r.page_count),
    parsedM2ByZone: (r.parsed_m2_by_zone as Record<string, number> | null) ?? undefined,
    parsedConfidence: (asString(r.parsed_confidence) as 'high' | 'medium' | 'low' | undefined),
    createdAt: r.created_at as string,
  };
}

export function quoteAttachmentToRow(a: Partial<QuoteAttachment>): Row {
  const out: Row = {};
  if (a.businessId !== undefined) out.business_id = a.businessId;
  if (a.quoteId !== undefined) out.quote_id = a.quoteId;
  if (a.kind !== undefined) out.kind = a.kind;
  if (a.storagePath !== undefined) out.storage_path = a.storagePath;
  if (a.fileName !== undefined) out.file_name = a.fileName || null;
  if (a.pageCount !== undefined) out.page_count = a.pageCount ?? null;
  if (a.parsedM2ByZone !== undefined) out.parsed_m2_by_zone = a.parsedM2ByZone ?? null;
  if (a.parsedConfidence !== undefined) out.parsed_confidence = a.parsedConfidence || null;
  return out;
}

// ── JobImport ───────────────────────────────────────────────────────────────
export function rowToJobImport(r: Row): JobImport {
  return {
    id: r.id as string,
    businessId: r.business_id as string,
    sourcePath: r.source_path as string,
    folderName: r.folder_name as string,
    suggestedJobId: asString(r.suggested_job_id),
    suggestedLegacyId: asString(r.suggested_legacy_id),
    suggestedLabel: asString(r.suggested_label),
    matchConfidence: (asString(r.match_confidence) as ImportConfidence | undefined) ?? 'none',
    matchSource: asString(r.match_source),
    filesSummary: (r.files_summary as FolderFileCounts | null) ?? {},
    attachmentsStoragePrefix: asString(r.attachments_storage_prefix),
    parsedData: (r.parsed_data as ParsedQuote | null) ?? undefined,
    status: (asString(r.status) as ImportStatus | undefined) ?? 'pending',
    commitAction: (asString(r.commit_action) as ImportDecision | undefined),
    commitTargetJobId: asString(r.commit_target_job_id),
    commitTargetQuoteId: asString(r.commit_target_quote_id),
    committedAt: asString(r.committed_at),
    notes: asString(r.notes),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function jobImportToRow(i: Partial<JobImport>): Row {
  const out: Row = {};
  if (i.businessId !== undefined) out.business_id = i.businessId;
  if (i.sourcePath !== undefined) out.source_path = i.sourcePath;
  if (i.folderName !== undefined) out.folder_name = i.folderName;
  if (i.suggestedJobId !== undefined) out.suggested_job_id = i.suggestedJobId || null;
  if (i.suggestedLegacyId !== undefined) out.suggested_legacy_id = i.suggestedLegacyId || null;
  if (i.suggestedLabel !== undefined) out.suggested_label = i.suggestedLabel || null;
  if (i.matchConfidence !== undefined) out.match_confidence = i.matchConfidence;
  if (i.matchSource !== undefined) out.match_source = i.matchSource || null;
  if (i.filesSummary !== undefined) out.files_summary = i.filesSummary ?? {};
  if (i.attachmentsStoragePrefix !== undefined) {
    out.attachments_storage_prefix = i.attachmentsStoragePrefix || null;
  }
  if (i.parsedData !== undefined) out.parsed_data = i.parsedData ?? null;
  if (i.status !== undefined) out.status = i.status;
  if (i.commitAction !== undefined) out.commit_action = i.commitAction || null;
  if (i.commitTargetJobId !== undefined) out.commit_target_job_id = i.commitTargetJobId || null;
  if (i.commitTargetQuoteId !== undefined) out.commit_target_quote_id = i.commitTargetQuoteId || null;
  if (i.committedAt !== undefined) out.committed_at = i.committedAt || null;
  if (i.notes !== undefined) out.notes = i.notes || null;
  return out;
}

// ── Setting ─────────────────────────────────────────────────────────────────
export function rowToSetting(r: Row): Setting {
  return {
    businessId: r.business_id as string,
    key: r.key as string,
    value: asString(r.value),
    notes: asString(r.notes),
    updatedAt: r.updated_at as string,
  };
}

// ── Invoice ─────────────────────────────────────────────────────────────────
export function rowToInvoice(r: Row): Invoice {
  return {
    id: r.id as string,
    businessId: r.business_id as string,
    jobId: r.job_id as string,
    invoiceNumber: r.invoice_number as string,
    invoiceDate: r.invoice_date as string,
    kind: (r.kind as InvoiceKind) ?? 'final',
    amountExGst: asNumber(r.amount_ex_gst) ?? 0,
    gstApplies: asBool(r.gst_applies, true),
    gstComponent: asNumber(r.gst_component),
    amountInclGst: asNumber(r.amount_incl_gst),
    paid: asBool(r.paid, false),
    paidDate: asString(r.paid_date),
    paidVia: asString(r.paid_via),
    incomeEntryId: asString(r.income_entry_id),
    notes: asString(r.notes),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function invoiceToRow(inv: Partial<Invoice>): Row {
  const out: Row = {};
  if (inv.businessId !== undefined)     out.business_id     = inv.businessId;
  if (inv.jobId !== undefined)          out.job_id          = inv.jobId;
  if (inv.invoiceNumber !== undefined)  out.invoice_number  = inv.invoiceNumber;
  if (inv.invoiceDate !== undefined)    out.invoice_date    = inv.invoiceDate;
  if (inv.kind !== undefined)           out.kind            = inv.kind;
  if (inv.amountExGst !== undefined)    out.amount_ex_gst   = inv.amountExGst;
  if (inv.gstApplies !== undefined)     out.gst_applies     = inv.gstApplies;
  if (inv.gstComponent !== undefined)   out.gst_component   = inv.gstComponent ?? null;
  if (inv.amountInclGst !== undefined)  out.amount_incl_gst = inv.amountInclGst ?? null;
  if (inv.paid !== undefined)           out.paid            = inv.paid;
  if (inv.paidDate !== undefined)       out.paid_date       = inv.paidDate || null;
  if (inv.paidVia !== undefined)        out.paid_via        = inv.paidVia || null;
  if (inv.incomeEntryId !== undefined)  out.income_entry_id = inv.incomeEntryId || null;
  if (inv.notes !== undefined)          out.notes           = inv.notes || null;
  return out;
}

// ── BankTransaction ─────────────────────────────────────────────────────────
export function rowToBankTransaction(r: Row): BankTransaction {
  return {
    id: r.id as string,
    businessId: r.business_id as string,
    bankAccountId: asString(r.bank_account_id),
    txnDate: r.txn_date as string,
    amount: asNumber(r.amount) ?? 0,
    payee: asString(r.payee),
    particulars: asString(r.particulars),
    code: asString(r.code),
    reference: asString(r.reference),
    tranType: asString(r.tran_type),
    otherPartyAccount: asString(r.other_party_account),
    description: r.description as string,
    fingerprint: r.fingerprint as string,
    status: (r.status as BankTransactionStatus) ?? 'unreconciled',
    entryId: asString(r.entry_id),
    notes: asString(r.notes),
    importedAt: r.imported_at as string,
  };
}

export function bankTransactionToRow(t: Partial<BankTransaction>): Row {
  const out: Row = {};
  if (t.businessId !== undefined)        out.business_id         = t.businessId;
  if (t.bankAccountId !== undefined)     out.bank_account_id     = t.bankAccountId || null;
  if (t.txnDate !== undefined)           out.txn_date            = t.txnDate;
  if (t.amount !== undefined)            out.amount              = t.amount;
  if (t.payee !== undefined)             out.payee               = t.payee || null;
  if (t.particulars !== undefined)       out.particulars         = t.particulars || null;
  if (t.code !== undefined)              out.code                = t.code || null;
  if (t.reference !== undefined)         out.reference           = t.reference || null;
  if (t.tranType !== undefined)          out.tran_type           = t.tranType || null;
  if (t.otherPartyAccount !== undefined) out.other_party_account = t.otherPartyAccount || null;
  if (t.description !== undefined)       out.description         = t.description;
  if (t.fingerprint !== undefined)       out.fingerprint         = t.fingerprint;
  if (t.status !== undefined)            out.status              = t.status;
  if (t.entryId !== undefined)           out.entry_id            = t.entryId || null;
  if (t.notes !== undefined)             out.notes               = t.notes || null;
  return out;
}
