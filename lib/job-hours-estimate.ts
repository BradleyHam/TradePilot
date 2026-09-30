import type { Entry, JobHoursEstimate, LabourEstimateRole } from './types';

export const LABOUR_ESTIMATE_ROLES: { key: LabourEstimateRole; label: string }[] = [
  { key: 'experienced', label: 'Experienced painter' },
  { key: 'helper', label: 'Brush hand' },
  { key: 'apprentice', label: 'Apprentice' },
  { key: 'subcontractor', label: 'Subcontractor' },
];

const round = (n: number) => Math.round(n * 100) / 100;
const positive = (n: number | undefined) => Number.isFinite(n) && n! > 0 ? n! : 0;

export interface HoursEstimateDraft {
  split: boolean;
  total: string;
  roles: Record<LabourEstimateRole, string>;
}

export function hoursEstimateDraft(value?: JobHoursEstimate | null): HoursEstimateDraft {
  return {
    split: !!value?.byRole,
    total: value?.total.toString() ?? '',
    roles: {
      experienced: value?.byRole?.experienced?.toString() ?? '',
      helper: value?.byRole?.helper?.toString() ?? '',
      apprentice: value?.byRole?.apprentice?.toString() ?? '',
      subcontractor: value?.byRole?.subcontractor?.toString() ?? '',
    },
  };
}

/** Accept pasted "12 hours" and decimals without turning negative input positive. */
function parseHours(raw: string): number | null {
  const cleaned = raw.trim().replace(/\s*(?:hours?|hrs?|h)$/i, '').replace(/,/g, '').trim();
  if (!cleaned) return raw.trim() ? null : 0;
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : null;
}

export function parseHoursEstimate(draft: HoursEstimateDraft): {
  value: JobHoursEstimate | null;
  error?: string;
} {
  if (!draft.split || Object.values(draft.roles).every((hours) => !hours.trim())) {
    const total = parseHours(draft.total);
    if (total === null) return { value: null, error: 'Enter hours from 0 to 100,000, with up to two decimal places.' };
    return { value: total > 0 ? { total } : null };
  }
  const byRole: Partial<Record<LabourEstimateRole, number>> = {};
  let total = 0;
  for (const { key, label } of LABOUR_ESTIMATE_ROLES) {
    const hours = parseHours(draft.roles[key]);
    if (hours === null) return { value: null, error: `Check ${label.toLowerCase()} hours: use a positive number with up to two decimal places.` };
    if (hours > 0) byRole[key] = hours;
    total += hours;
  }
  if (total > 100000) return { value: null, error: 'Total hours must be 100,000 or less.' };
  return { value: total > 0 ? { total: round(total), byRole } : null };
}

/** Validate persisted JSON at the boundary; never display a malformed budget. */
export function readHoursEstimate(raw: unknown): JobHoursEstimate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.total !== 'number' || !Number.isFinite(value.total) || value.total <= 0 || value.total > 100000) return null;
  if (value.byRole === undefined) return { total: value.total };
  if (!value.byRole || typeof value.byRole !== 'object' || Array.isArray(value.byRole)) return null;
  const byRole: Partial<Record<LabourEstimateRole, number>> = {};
  for (const [key, hours] of Object.entries(value.byRole)) {
    if (!LABOUR_ESTIMATE_ROLES.some((role) => role.key === key)
      || typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) return null;
    byRole[key as LabourEstimateRole] = hours;
  }
  if (Math.abs(Object.values(byRole).reduce((sum, n) => sum + n, 0) - value.total) > 0.001) return null;
  return { total: value.total, byRole };
}

/** All logged person-hours, including legacy second-person helper hours. */
export function actualHoursByRole(entries: readonly Entry[], jobId: string) {
  const byRole: Record<LabourEstimateRole, number> = { experienced: 0, helper: 0, apprentice: 0, subcontractor: 0 };
  let legacyHelper = 0;
  for (const entry of entries) {
    if (entry.jobId !== jobId || entry.type !== 'hours' || entry.isDraft) continue;
    const kind = entry.workerKind ?? 'owner';
    const role = kind === 'owner' ? 'experienced' : kind;
    byRole[role] += positive(entry.hours);
    const helperHours = positive(entry.helperHours);
    byRole.helper += helperHours;
    legacyHelper += helperHours;
  }
  const total = round(Object.values(byRole).reduce((sum, n) => sum + n, 0));
  for (const { key } of LABOUR_ESTIMATE_ROLES) byRole[key] = round(byRole[key]);
  return { total, byRole, legacyHelper: round(legacyHelper) };
}

/** Budget usage is not percent complete. A forecast needs an explicit work-left check. */
export function compareJobHours(estimate: number, actual: number, remaining?: number, complete = false) {
  const delta = round(actual - estimate);
  const forecast = complete ? actual : remaining == null ? null : round(actual + remaining);
  return {
    delta,
    budgetLeft: round(Math.max(0, estimate - actual)),
    usedPercent: estimate > 0 ? Math.round(actual / estimate * 100) : 0,
    forecast,
    forecastDelta: forecast == null ? null : round(forecast - estimate),
  };
}
