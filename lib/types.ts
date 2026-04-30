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
  notes?: string;
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
  createdAt: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface Setting {
  businessId: string;
  key: string;
  value?: string;
  notes?: string;
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
