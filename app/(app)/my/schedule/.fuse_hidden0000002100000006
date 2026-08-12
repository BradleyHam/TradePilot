'use client';

/**
 * Employee schedule — month calendar by default (Brad's preferred view),
 * with a List toggle for the "what's next" read on a small phone.
 *
 * Everything here is already assignment-filtered at the database: RLS on
 * schedule_items only returns job_booking rows this person is on
 * (migration 035), so no client-side filtering by user is needed.
 *
 * Deliberately simpler than the owner's calendar — no editing, no money,
 * no inline logging. Tap a day → see where you're working, tap through to
 * log hours for it.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { ScopeLists } from '@/components/jobs/job-scope-panel';
import { JobPhoto } from '@/components/shared/job-photo';
import type { Job, ScheduleItem } from '@/lib/types';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  CalendarDays, MapPin, Clock, ChevronLeft, ChevronRight,
  List as ListIcon, LayoutGrid, Navigation,
} from 'lucide-react';
import {
  format, isToday, isSameMonth, startOfMonth, endOfMonth,
  startOfWeek, endOfWeek, eachDayOfInterval, addMonths,
} from 'date-fns';

// ── Local date helpers (local time, so DST never shifts a day) ───────────
function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}
function formatISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayIso() {
  return formatISODate(new Date());
}
function prettyDate(iso: string) {
  const t = todayIso();
  if (iso === t) return 'Today';
  const tm = new Date();
  tm.setDate(tm.getDate() + 1);
  if (iso === formatISODate(tm)) return 'Tomorrow';
  return format(parseISODate(iso), 'EEEE, d MMM');
}
function fmtTime(t?: string) {
  return t ? t.slice(0, 5) : null;
}
function mapsHref(location: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

type ViewMode = 'month' | 'list';

export default function MySchedulePage() {
  const { scheduleItems, jobs } = useStore();
  const router = useRouter();

  // Remember the choice — a tired painter shouldn't re-pick every time.
  const [view, setView] = useState<ViewMode>('month');
  useEffect(() => {
    const saved = window.localStorage.getItem('my-schedule-view');
    if (saved === 'month' || saved === 'list') setView(saved);
  }, []);
  function pickView(v: ViewMode) {
    setView(v);
    window.localStorage.setItem('my-schedule-view', v);
  }

  // RLS already scopes these to bookings this person is assigned to.
  const bookings = useMemo(
    () => scheduleItems.filter((s) => s.type === 'job_booking'),
    [scheduleItems],
  );

  const jobById = useMemo(() => {
    const m = new Map(jobs.map((j) => [j.id, j]));
    return m;
  }, [jobs]);

  return (
    <div className="max-w-xl mx-auto w-full px-4 py-5 pb-24 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Your work</p>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarDays size={22} className="text-primary" /> My schedule
          </h1>
        </div>
        <div className="flex gap-1 shrink-0">
          {([
            { v: 'month' as const, label: 'Month', Icon: LayoutGrid },
            { v: 'list' as const, label: 'List', Icon: ListIcon },
          ]).map(({ v, label, Icon }) => (
            <button
              key={v}
              onClick={() => pickView(v)}
              aria-pressed={view === v}
              aria-label={label}
              className={cn(
                'h-11 w-11 rounded-xl border flex items-center justify-center transition-colors',
                view === v
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card text-muted-foreground border-border',
              )}
            >
              <Icon size={17} />
            </button>
          ))}
        </div>
      </div>

      {view === 'month'
        ? <MonthCalendar bookings={bookings} jobById={jobById} onLogHours={() => router.push('/my/hours')} />
        : <UpcomingList bookings={bookings} jobById={jobById} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Month calendar
// ─────────────────────────────────────────────────────────────────────────
function MonthCalendar({
  bookings,
  jobById,
  onLogHours,
}: {
  bookings: ScheduleItem[];
  jobById: Map<string, Job>;
  onLogHours: () => void;
}) {
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const monthStart = startOfMonth(anchor);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  // date → bookings on it.
  const byDate = useMemo(() => {
    const m = new Map<string, ScheduleItem[]>();
    for (const b of bookings) {
      const arr = m.get(b.date) ?? [];
      arr.push(b);
      m.set(b.date, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
    }
    return m;
  }, [bookings]);

  const dayItems = selectedDay ? (byDate.get(selectedDay) ?? []) : [];
  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div>
      {/* Month nav */}
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setAnchor(addMonths(anchor, -1))}
          className="h-11 w-11 rounded-xl hover:bg-muted flex items-center justify-center text-muted-foreground"
          aria-label="Previous month"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="text-sm font-semibold text-center">
          {format(anchor, 'MMMM yyyy')}
          {!isSameMonth(anchor, new Date()) && (
            <button
              onClick={() => setAnchor(new Date())}
              className="ml-2 text-xs text-primary font-normal underline-offset-2 hover:underline"
            >
              Today
            </button>
          )}
        </div>
        <button
          onClick={() => setAnchor(addMonths(anchor, 1))}
          className="h-11 w-11 rounded-xl hover:bg-muted flex items-center justify-center text-muted-foreground"
          aria-label="Next month"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {weekdayLabels.map((d) => (
          <div key={d} className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground text-center py-1">
            {d}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const iso = formatISODate(d);
          const inMonth = isSameMonth(d, anchor);
          const today = isToday(d);
          const items = byDate.get(iso) ?? [];
          const working = items.length > 0;
          return (
            <button
              key={iso}
              type="button"
              onClick={() => working && setSelectedDay(iso)}
              disabled={!working}
              className={cn(
                'aspect-square rounded-xl border p-1 flex flex-col items-center justify-start gap-0.5 transition-colors',
                working
                  ? 'bg-primary/10 border-primary/40 hover:bg-primary/20 cursor-pointer'
                  : 'bg-card border-border',
                !inMonth && 'opacity-40',
                today && 'ring-2 ring-primary ring-offset-1',
              )}
            >
              <span className={cn('text-xs', today ? 'font-bold text-primary' : 'font-medium')}>
                {format(d, 'd')}
              </span>
              {working && (
                <span className="flex gap-0.5 flex-wrap justify-center">
                  {items.slice(0, 3).map((it) => (
                    <span
                      key={it.id}
                      className={cn(
                        'w-1.5 h-1.5 rounded-full',
                        it.completed ? 'bg-muted-foreground/50' : 'bg-primary',
                      )}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground mt-2 text-center">
        Highlighted days are days you&apos;re on a job. Tap one for the details.
      </p>

      {/* Day detail */}
      <Sheet open={!!selectedDay} onOpenChange={(o) => { if (!o) setSelectedDay(null); }}>
        <SheetContent side="bottom" className="rounded-t-2xl px-4 pb-8 max-h-[80vh] overflow-y-auto">
          <SheetHeader className="pb-2">
            <SheetTitle>{selectedDay ? prettyDate(selectedDay) : ''}</SheetTitle>
          </SheetHeader>
          <div className="space-y-3 max-w-xl mx-auto w-full">
            {dayItems.map((s) => {
              const job = s.jobId ? jobById.get(s.jobId) : undefined;
              const start = fmtTime(s.startTime);
              const end = fmtTime(s.endTime);
              return (
                <div key={s.id} className="rounded-xl border border-border bg-card p-3 space-y-1.5">
                  {s.jobId && <JobPhoto jobId={s.jobId} className="w-full h-32" fallback="none" />}
                  <p className="font-semibold text-sm">{job?.name ?? s.title}</p>
                  {(start || end) && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock size={12} /> {start ?? '?'}{end ? `–${end}` : ''}
                    </p>
                  )}
                  {job?.location && (
                    <a
                      href={mapsHref(job.location)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm text-primary font-medium"
                    >
                      <Navigation size={14} /> {job.location}
                    </a>
                  )}
                  {job?.notes && (
                    <div className="rounded-lg bg-muted/40 p-2.5">
                      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">What to do</p>
                      <p className="text-sm whitespace-pre-wrap">{job.notes}</p>
                    </div>
                  )}
                  {s.notes && <p className="text-xs whitespace-pre-wrap">{s.notes}</p>}
                  {job && ((job.scopeIncluded?.length ?? 0) > 0 || (job.scopeExcluded?.length ?? 0) > 0) && (
                    <div className="rounded-lg bg-muted/40 p-2.5">
                      <ScopeLists
                        included={job.scopeIncluded ?? []}
                        excluded={job.scopeExcluded ?? []}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {selectedDay && selectedDay <= todayIso() && (
              <Button className="w-full min-h-[48px]" onClick={onLogHours}>
                <Clock size={16} /> Log hours for this day
              </Button>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// List (the previous view, kept as a toggle)
// ─────────────────────────────────────────────────────────────────────────
function UpcomingList({
  bookings,
  jobById,
}: {
  bookings: ScheduleItem[];
  jobById: Map<string, Job>;
}) {
  const groups = useMemo(() => {
    const t = todayIso();
    const upcoming = bookings
      .filter((s) => s.date >= t)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? '').localeCompare(b.startTime ?? ''));
    const map = new Map<string, ScheduleItem[]>();
    for (const s of upcoming) {
      const arr = map.get(s.date) ?? [];
      arr.push(s);
      map.set(s.date, arr);
    }
    return [...map.entries()];
  }, [bookings]);

  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6">
        Nothing booked coming up. Brad will add jobs here when they&apos;re scheduled.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {groups.map(([date, items]) => (
        <div key={date} className="space-y-2">
          <p className="text-sm font-semibold text-foreground">{prettyDate(date)}</p>
          {items.map((s) => {
            const job = s.jobId ? jobById.get(s.jobId) : undefined;
            const start = fmtTime(s.startTime);
            const end = fmtTime(s.endTime);
            return (
              <div key={s.id} className="rounded-xl border border-border bg-card p-3 flex gap-3">
                {s.jobId && <JobPhoto jobId={s.jobId} className="w-16 h-16 shrink-0" fallback="none" />}
                <div className="min-w-0 flex-1">
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
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
