import type { ActivityType } from './types';

export function hourSlices(activities: ActivityType[], values: Record<string, string>) {
  const keys = activities.length ? activities : [''];
  const slices = keys.map((activity) => ({
    activity: (activity || undefined) as ActivityType | undefined,
    hours: Number(values[activity]?.trim() || 0),
  }));
  if (slices.some((s) => !Number.isFinite(s.hours) || s.hours < 0)) {
    throw new Error('Enter valid hours of zero or more.');
  }
  const worked = slices.filter((s) => s.hours > 0);
  if (!worked.length) throw new Error('Enter hours for each selected person, or deselect anyone who did not work.');
  return worked;
}
