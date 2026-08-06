// Static enum-ish constants used by forms and filters.
// The demo data that used to live here (DEMO_JOBS, DEMO_ENTRIES, DEMO_SCHEDULE,
// DEMO_BUSINESS) was retired when the app was wired to Supabase. Real data now
// loads via lib/store.tsx → Supabase.

export const EXPENSE_CATEGORIES = [
  'paint', 'materials', 'tools', 'fuel', 'vehicle',
  'labour', 'subcontractor', 'admin', 'software', 'marketing', 'other',
] as const;

// Keep in sync with ActivityType in lib/types.ts AND the
// entries_activity_check constraint (migration 038). On-site first, then
// off-site/office.
export const ACTIVITY_TYPES = [
  'prep', 'painting', 'staining', 'wallpapering', 'stopping',
  'primer', 'repair', 'cleanup', 'travel',
  'quoting', 'admin', 'website', 'marketing', 'training',
] as const;

export const JOB_STATUSES = [
  'lead', 'quoted', 'accepted', 'booked', 'in-progress',
  // 'declined' sits last, past 'lost': it's the rarest pick and the two
  // read as a pair at the bottom of the dropdown (didn't get it / said no).
  'completed', 'invoiced', 'paid', 'lost', 'declined',
] as const;
