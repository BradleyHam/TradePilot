import type { Job, ScheduleItem } from '@/lib/types';

/** Human-readable marker on the follow-up created by "Dates not confirmed". */
export const BOOKING_DATES_FOLLOW_UP_NOTE = 'Booking dates not confirmed yet.';

export function isBookingDatesFollowUp(item: ScheduleItem, jobId?: string): boolean {
  return item.type === 'follow_up'
    && item.notes === BOOKING_DATES_FOLLOW_UP_NOTE
    && (!jobId || item.jobId === jobId);
}

/**
 * Won work still missing a real future work day. A future date-confirmation
 * follow-up temporarily owns the next action, so Home does not nag twice.
 */
export function needsBookingDates(
  job: Job,
  scheduleItems: ScheduleItem[],
  todayISO: string,
  visibleReminderFromISO: string = todayISO,
): boolean {
  if (job.status !== 'accepted') return false;

  const hasFutureWork = scheduleItems.some((item) =>
    item.jobId === job.id
    && item.type === 'job_booking'
    && !item.completed
    && !item.skipReasonKind
    && item.date >= todayISO,
  );
  if (hasFutureWork) return false;

  const waitingForFollowUp = scheduleItems.some((item) =>
    isBookingDatesFollowUp(item, job.id)
    && !item.completed
    // Future reminders and reminders still visible in Home's current-week
    // Today list own the next action. Once an ignored reminder falls out of
    // that list, the stronger booking flag returns instead of disappearing.
    && item.date >= visibleReminderFromISO,
  );
  return !waitingForFollowUp;
}
