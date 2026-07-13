'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ActivityType, JobStatus } from '@/lib/types';
import { Clock, LogOut, MapPin, Check, Trash2 } from 'lucide-react';

// Statuses an employee can log time against — "any active job".
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
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
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

  // Jobs Suzie is BOOKED on (has a job_booking schedule item), workable
  // status only. Jobs booked for the chosen day float to the top; if
  // exactly one is booked that day we pre-select it.
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

  // Effective selection: an explicit tap wins, otherwise the day's single
  // booked job is pre-selected so the common case is zero taps to pick.
  const selectedId = jobId || suggestedJobId;
  const selectedJob = jobs.find((j) => j.id === selectedId);

  // Hours I've logged this week (Monday-based) — for the summary. Hours
  // only, never money.
  const weekHours = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
    const monday = d.toISOString().slice(0, 10);
    return entries
      .filter((e) => e.type === 'hours' && (!myUid || e.loggedByUserId === myUid) && e.entryDate >= monday)
      .reduce((sum, e) => sum + (e.hours ?? 0), 0);
  }, [entries, myUid]);

  // Hours I've logged for the chosen date.
  const todaysLogged = useMemo(() => {
    return entries
      .filter((e) => e.type === 'hours' && e.entryDate === date
        && (!myUid || e.loggedByUserId === myUid))
      .sort((a, b) => (b.createdAt).localeCompare(a.createdAt));
  }, [entries, date, myUid]);

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
    // Reset the entry fields but keep the job + date selected — the common
    // case is logging a couple of activities on the same job/day.
    setHours('');
    setActivity('');
    setNote('');
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
            {membership?.displayName ? `Hi ${membership.displayName}` : 'Log hours'}
          </p>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Clock size={22} className="text-primary" /> Log hours
          </h1>
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

      {/* Date */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Day
        </label>
        <div className="flex gap-2">
          {[todayIso(), isoDaysAgo(1), isoDaysAgo(2)].map((d) => (
            <button
              key={d}
              onClick={() => setDate(d)}
              className={cn(
                'flex-1 min-h-[44px] rounded-xl border text-sm font-medium transition-colors',
                date === d
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {prettyDate(d)}
            </button>
          ))}
        </div>
      </div>

      {/* Job picker */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Job
        </label>
        {myJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-3">
            No jobs booked for you yet. Brad will schedule you onto a job and it&apos;ll show up here.
          </p>
        ) : (
          <div className="space-y-2">
            {myJobs.map((j) => (
              <button
                key={j.id}
                onClick={() => setJobId(j.id)}
                className={cn(
                  'w-full text-left rounded-xl border p-3 min-h-[44px] transition-colors',
                  selectedId === j.id
                    ? 'bg-primary/10 border-primary'
                    : 'bg-card border-border hover:border-primary/40',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm">{j.name}</span>
                  {selectedId === j.id && <Check size={16} className="text-primary shrink-0" />}
                </div>
                {j.location && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                    <MapPin size={12} /> {j.location}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Scope (money-free job detail) + tap-to-navigate */}
      {selectedJob && (selectedJob.notes || selectedJob.location) && (
        <div className="rounded-xl bg-muted/40 border border-border p-3 space-y-2">
          {selectedJob.location && (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selectedJob.location)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary font-medium flex items-center gap-1.5"
            >
              <MapPin size={14} /> {selectedJob.location}
            </a>
          )}
          {selectedJob.notes && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Job notes</p>
              <p className="text-sm whitespace-pre-wrap">{selectedJob.notes}</p>
            </div>
          )}
        </div>
      )}

      {/* Hours */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Hours worked
        </label>
        <div className="flex gap-2 mb-2">
          {HOUR_CHIPS.map((h) => (
            <button
              key={h}
              onClick={() => setHours(String(h))}
              className={cn(
                'flex-1 min-h-[48px] rounded-xl border text-base font-semibold transition-colors',
                hours === String(h)
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card border-border hover:border-primary/40',
              )}
            >
              {h}h
            </button>
          ))}
        </div>
        <input
          type="number"
          inputMode="decimal"
          step="0.5"
          min="0"
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
                activity === a
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card border-border text-muted-foreground hover:text-foreground',
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
                <button
                  onClick={() => deleteEntry(e.id)}
                  className="text-muted-foreground hover:text-destructive p-2 shrink-0"
                  aria-label="Delete"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Sticky save */}
      <div className="fixed bottom-16 md:bottom-0 left-0 right-0 md:left-60 bg-background/95 backdrop-blur border-t border-border p-3 z-40">
        <div className="max-w-xl mx-auto">
          <Button
            className="w-full min-h-[52px] text-base"
            disabled={!canSave}
            onClick={handleSave}
          >
            {justSaved ? (<><Check size={18} /> Saved</>) : `Save ${hours ? hours + 'h' : 'hours'}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
