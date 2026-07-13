'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ActivityType, JobStatus } from '@/lib/types';
import { Clock, LogOut, Check, Trash2, Navigation, CalendarDays, ChevronRight } from 'lucide-react';

// Statuses an employee can log time against.
const LOGGABLE: JobStatus[] = ['accepted', 'booked', 'in-progress'];

const ACTIVITIES: ActivityType[] = [
  'prep', 'painting', 'staining', 'wallpapering',
  'stopping', 'primer', 'repair', 'cleanup', 'travel',
];

const HOUR_CHIPS = [2, 4, 6, 8];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function isoDaysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function prettyDate(iso: string) {
  if (iso === todayIso()) return 'Today';
  if (iso === isoDaysAgo(1)) return 'Yesterday';
  if (iso === isoDaysAgo(-1)) return 'Tomorrow';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}
function fmtTime(t?: string) {
  return t ? t.slice(0, 5) : null;
}
function mapsHref(location: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

export default function MyHoursPage() {
  const router = useRouter();
  const { jobs, entries, scheduleItems, membership, logMyHours, deleteEntry } = useStore();

  const [jobId, setJobId] = useState<string>('');
  const [hours, setHours] = useState<string>('');
  const [activity, setActivity] = useState<ActivityType | ''>('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(todayIso());
  const [justSaved, setJustSaved] = useState(false);

  const myUid = membership?.userId;
  const firstName = membership?.displayName?.split(' ')[0];

  // Jobs Suzie is BOOKED on (has a job_booking), workable status only.
  // Jobs booked for the chosen day float to the top; a single one is
  // pre-selected so it's zero taps in the common case.
  const { myJobs, suggestedJobId } = useMemo(() => {
    const bookedJobIds = new Set(
      scheduleItems.filter((s) => s.type === 'job_booking' && s.jobId).map((s) => s.jobId as string),
    );
    const bookedForDate = new Set(
      scheduleItems.filter((s) => s.type === 'job_booking' && s.date === date && s.jobId).map((s) => s.jobId as string),
    );
    const list = jobs
      .filter((j) => bookedJobIds.has(j.id) && LOGGABLE.includes(j.status))
      .sort((a, b) => {
        const aB = bookedForDate.has(a.id) ? 0 : 1;
        const bB = bookedForDate.has(b.id) ? 0 : 1;
        if (aB !== bB) return aB - bB;
        return a.name.localeCompare(b.name);
      });
    const todays = list.filter((j) => bookedForDate.has(j.id));
    return { myJobs: list, suggestedJobId: todays.length === 1 ? todays[0].id : '' };
  }, [jobs, scheduleItems, date]);

  const selectedId = jobId || suggestedJobId;
  const selectedJob = jobs.find((j) => j.id === selectedId);

  // The booking row for the selected job on the selected day (for the time).
  const selectedBooking = useMemo(() =>
    scheduleItems.find((s) => s.type === 'job_booking' && s.jobId === selectedId && s.date === date),
    [scheduleItems, selectedId, date]);

  // Next booking after today, across her booked jobs — a "what's next" peek.
  const nextUp = useMemo(() => {
    const t = todayIso();
    const future = scheduleItems
      .filter((s) => s.type === 'job_booking' && s.date > t)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? '').localeCompare(b.startTime ?? ''));
    return future[0];
  }, [scheduleItems]);

  // Hours logged this week (Monday-based). Hours only — never money.
  const weekHours = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const monday = d.toISOString().slice(0, 10);
    return entries
      .filter((e) => e.type === 'hours' && (!myUid || e.loggedByUserId === myUid) && e.entryDate >= monday)
      .reduce((sum, e) => sum + (e.hours ?? 0), 0);
  }, [entries, myUid]);

  const todaysLogged = useMemo(() =>
    entries
      .filter((e) => e.type === 'hours' && e.entryDate === date && (!myUid || e.loggedByUserId === myUid))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [entries, date, myUid]);
  const totalToday = todaysLogged.reduce((sum, e) => sum + (e.hours ?? 0), 0);

  const canSave = !!selectedId && !!hours && parseFloat(hours) > 0;

  function handleSave() {
    if (!canSave) return;
    logMyHours({
      jobId: selectedId,
      hours: parseFloat(hours),
      activity: activity || undefined,
      note: note.trim() || undefined,
      entryDate: date,
    });
    setHours(''); setActivity(''); setNote('');
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace('/login');
  }

  return (
    <div className="max-w-xl mx-auto w-full px-4 py-5 pb-32 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {firstName ? `Hi ${firstName}` : 'Welcome'}
          </p>
          <h1 className="text-2xl font-bold">{prettyDate(todayIso())}</h1>
        </div>
        <Button variant="outline" size="sm" onClick={handleSignOut}>
          <LogOut size={15} /> Sign out
        </Button>
      </div>

      {/* This week (hours only — never money) */}
      <div className="rounded-2xl bg-primary/5 border border-primary/20 p-4 flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">This week</p>
          <p className="text-2xl font-bold">{weekHours}<span className="text-base font-medium text-muted-foreground"> hours</span></p>
        </div>
        <Clock size={28} className="text-primary/50" />
      </div>

      {/* Active job hero — where to go today */}
      {selectedJob ? (
        <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-primary uppercase tracking-wide">
              {date === todayIso() ? 'Today’s job' : prettyDate(date) + '’s job'}
            </p>
            {selectedBooking && (fmtTime(selectedBooking.startTime) || fmtTime(selectedBooking.endTime)) && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock size={12} />
                {fmtTime(selectedBooking.startTime) ?? '?'}{fmtTime(selectedBooking.endTime) ? `–${fmtTime(selectedBooking.endTime)}` : ''}
              </span>
            )}
          </div>
          <p className="text-lg font-bold leading-tight">{selectedJob.name}</p>
          {selectedJob.location && (
            <a
              href={mapsHref(selectedJob.location)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary font-medium"
            >
              <Navigation size={14} /> {selectedJob.location}
            </a>
          )}
          {selectedJob.notes && (
            <div className="rounded-xl bg-muted/40 p-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">What to do</p>
              <p className="text-sm whitespace-pre-wrap">{selectedJob.notes}</p>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          No job booked for {prettyDate(date).toLowerCase()}. Pick one below to log time, or check your schedule.
        </div>
      )}

      {/* Day selector */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Log for</label>
        <div className="flex gap-2">
          {[todayIso(), isoDaysAgo(1), isoDaysAgo(2)].map((d) => (
            <button
              key={d}
              onClick={() => { setDate(d); setJobId(''); }}
              className={cn(
                'flex-1 min-h-[44px] rounded-xl border text-sm font-medium transition-colors',
                date === d ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground',
              )}
            >
              {prettyDate(d)}
            </button>
          ))}
        </div>
      </div>

      {/* Job picker (only if more than one booked job, or none pre-selected) */}
      {myJobs.length > 0 && (myJobs.length > 1 || !selectedId) && (
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Job</label>
          <div className="space-y-2">
            {myJobs.map((j) => (
              <button
                key={j.id}
                onClick={() => setJobId(j.id)}
                className={cn(
                  'w-full text-left rounded-xl border p-3 min-h-[44px] transition-colors flex items-center justify-between gap-2',
                  selectedId === j.id ? 'bg-primary/10 border-primary' : 'bg-card border-border',
                )}
              >
                <span className="font-semibold text-sm">{j.name}</span>
                {selectedId === j.id && <Check size={16} className="text-primary shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Hours */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Hours worked</label>
        <div className="flex gap-2 mb-2">
          {HOUR_CHIPS.map((h) => (
            <button
              key={h}
              onClick={() => setHours(String(h))}
              className={cn(
                'flex-1 min-h-[48px] rounded-xl border text-base font-semibold transition-colors',
                hours === String(h) ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border',
              )}
            >
              {h}h
            </button>
          ))}
        </div>
        <input
          type="number" inputMode="decimal" step="0.5" min="0"
          placeholder="or type exact hours (e.g. 5.5)"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          className="w-full min-h-[48px] rounded-xl border border-border bg-card px-3 text-base outline-none focus:border-primary"
        />
      </div>

      {/* Activity */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          What did you do? <span className="normal-case text-[10px]">(optional)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {ACTIVITIES.map((a) => (
            <button
              key={a}
              onClick={() => setActivity(activity === a ? '' : a)}
              className={cn(
                'min-h-[40px] px-3 rounded-full border text-sm capitalize transition-colors',
                activity === a ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground',
              )}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      {/* Note */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Note <span className="normal-case text-[10px]">(optional)</span>
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. masked and sanded the west wall"
          rows={2}
          className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary resize-none"
        />
      </div>

      {/* Today's logged list */}
      {todaysLogged.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {prettyDate(date)} · {totalToday}h logged
          </p>
          {todaysLogged.map((e) => {
            const jn = jobs.find((j) => j.id === e.jobId)?.name ?? 'Job';
            return (
              <div key={e.id} className="flex items-center justify-between rounded-xl border border-border bg-card p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{jn}</p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {e.hours}h{e.activity ? ` · ${e.activity}` : ''}
                  </p>
                </div>
                <button onClick={() => deleteEntry(e.id)} className="text-muted-foreground hover:text-destructive p-2 shrink-0" aria-label="Delete">
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Next up peek */}
      {nextUp && (
        <Link href="/my/schedule" className="flex items-center justify-between rounded-xl border border-border bg-card p-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <CalendarDays size={12} /> Next up
            </p>
            <p className="text-sm font-medium truncate mt-0.5">
              {prettyDate(nextUp.date)} · {jobs.find((j) => j.id === nextUp.jobId)?.name ?? nextUp.title}
            </p>
          </div>
          <ChevronRight size={16} className="text-muted-foreground shrink-0" />
        </Link>
      )}

      {/* Sticky save */}
      <div className="fixed bottom-16 md:bottom-0 left-0 right-0 md:left-60 bg-background/95 backdrop-blur border-t border-border p-3 z-40">
        <div className="max-w-xl mx-auto">
          <Button className="w-full min-h-[52px] text-base" disabled={!canSave} onClick={handleSave}>
            {justSaved ? (<><Check size={18} /> Saved</>) : `Save ${hours ? hours + 'h' : 'hours'}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
