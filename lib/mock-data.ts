// Static enum-ish constants used by forms and filters.
// The demo data that used to live here (DEMO_JOBS, DEMO_ENTRIES, DEMO_SCHEDULE,
// DEMO_BUSINESS) was retired when the app was wired to Supabase. Real data now
// loads via lib/store.tsx → Supabase.

export const EXPENSE_CATEGORIES = [
  'paint', 'materials', 'tools', 'fuel', 'vehicle',
  'labour', 'subcontractor', 'admin', 'software', 'marketing', 'other',
] as const;

export const ACTIVITY_TYPES = [
  'prep', 'painting', 'staining', 'wallpapering', 'stopping',
  'primer', 'repair', 'cleanup', 'travel', 'quoting', 'admin',
] as const;

export const JOB_STATUSES = [
  'lead', 'quoted', 'accepted', 'booked', 'in-progress',
  'completed', 'invoiced', 'paid', 'lost',
] as const;
