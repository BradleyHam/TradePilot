'use client';

import { useMemo } from 'react';
import { useStore } from '@/lib/store';
import { CalendarDays, MapPin, Clock } from 'lucide-react';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function prettyDate(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  const t = todayIso();
  if (iso === t) return 'Today';
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (iso === tomorrow.toISOString().slice(0, 10)) return 'Tomorrow';
  return d.toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'short' });
}
function fmtTime(t?: string) {
  if (!t) return null;
  // stored as HH:MM:SS — trim to HH:MM
  return t.slice(0, 5);
}

export default function MySchedulePage() {
  const { scheduleItems, jobs } = useStore();

  // Upcoming job bookings (employee RLS only returns job_booking rows).
  const upcoming = useMemo(() => {
    const t = todayIso();
    return scheduleItems
      .filter((s) => s.type === 'job_booking' && s.date >= t)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  }, [scheduleItems]);

  // Group by date.
  const groups = useMemo(() => {
    const map = new Map<string, typeof upcoming>();
    for (const s of upcoming) {
      const arr = map.get(s.date) ?? [];
      arr.push(s);
      map.set(s.date, arr);
    }
    return [...map.entries()];
  }, [upcoming]);

  return (
    <div className="max-w-xl mx-auto w-full px-4 py-5 pb-24 space-y-5">
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Your work</p>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <CalendarDays size={22} className="text-primary" /> My schedule
        </h1>
      </div>

      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6">
          Nothing booked coming up. Brad will add jobs here when they&apos;re scheduled.
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map(([date, items]) => (
            <div key={date} className="space-y-2">
              <p className="text-sm font-semibold text-foreground">{prettyDate(date)}</p>
              {items.map((s) => {
                const job = jobs.find((j) => j.id === s.jobId);
                const start = fmtTime(s.startTime);
                const end = fmtTime(s.endTime);
                return (
                  <div key={s.id} className="rounded-xl border border-border bg-card p-3">
                    <p className="font-semibold text-sm">{job?.name ?? s.title}</p>
                    {job?.location && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <MapPin size={12} /> {job.location}
                      </p>
                    )}
                    {(start || end) && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock size={12} /> {start ?? '?'}{end ? `–${end}` : ''}
                      </p>
                    )}
                    {s.notes && <p className="text-xs mt-1 whitespace-pre-wrap">{s.notes}</p>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
