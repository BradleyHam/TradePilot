// Map between Supabase rows (snake_case) and Trade Pilot domain types (camelCase).
// Keep all column-name knowledge here so the rest of the app stays clean.

import type {
  Job, Entry, ScheduleItem, Material, Quote, Setting,
  JobStatus, EntryType, ExpenseCategory, ActivityType,
  ProductType, Finish, Unit, QuoteStatus, ScheduleItemType,
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
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
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
