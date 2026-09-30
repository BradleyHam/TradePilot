'use client';

import { downloadIcs } from './ics';
import type { Job, ScheduleItem } from './types';

/**
 * Download the current version of a site visit for the phone's calendar.
 * The schedule-item id stays as the UID and buildIcs supplies an increasing
 * SEQUENCE, so importing after a date/time edit updates the existing event.
 */
export function downloadSiteVisitCalendar(
  item: ScheduleItem,
  jobs: Job[],
): void {
  const [year, month, day] = item.date.split('-').map(Number);
  const [startHour, startMinute] = (item.startTime ?? '09:00').split(':').map(Number);
  const start = new Date(year, month - 1, day, startHour, startMinute);

  let end: Date | undefined;
  if (item.endTime) {
    const [endHour, endMinute] = item.endTime.split(':').map(Number);
    end = new Date(year, month - 1, day, endHour, endMinute);
  }

  const linkedJob = item.jobId ? jobs.find((job) => job.id === item.jobId) : undefined;
  const clientName = item.clientName ?? linkedJob?.clientName;
  const clientPhone = item.clientPhone ?? linkedJob?.clientPhone;

  downloadIcs({
    uid: `${item.id}@tradepilot`,
    title: item.title || 'Site visit',
    start,
    end,
    location: item.location ?? linkedJob?.location,
    description: [
      clientName && `Client: ${clientName}`,
      clientPhone && `Phone: ${clientPhone}`,
      item.notes,
    ].filter(Boolean).join('\n') || undefined,
  });
}
