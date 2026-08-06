'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { jobCoverPath, useSignedCovers } from '@/lib/job-cover';
import { ScopeLists } from '@/components/jobs/job-scope-panel';
import { JobPhoto } from '@/components/shared/job-photo';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ActivityType, JobStatus } from '@/lib/types';
import {
  Clock, LogOut, Check, Trash2, Navigation, CalendarDays, ChevronRight,
  Camera, X, ClipboardList, ChevronDown, ChevronUp,
} from 'lucide-react';

// Statuses an employee can log time against.
const LOGGABLE: JobStatus[] = ['accepted', 'booked', 'in-progress'];

/** On-site work — needs a job to log against. */
const SITE_ACTIVITIES: ActivityType[] = [
  'prep', 'painting', 'staining', 'wallpapering',
  'stopping', 'primer', 'repair', 'cleanup', 'travel',
];

/**
 * Off-site work — paid, but attached to no job (admin, the website,
 * marketing, training, quoting). Logged as overhead with a null jobId,
 * which RLS permits for hours entries (migration 038).
 */
const OFFSITE: ActivityType[] = ['admin', 'website', 'marketing', 'training', 'quoting'];

const ACTIVITY_LABELS: Partial<Record<ActivityType, string>> = {
  website: 'Website',
  marketing: 'Marketing',
  training: 'Training',
  admin: 'Admin',
  quoting: 'Quoting',
};

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
  const { jobs, entries, scheduleItems, membership, logMyHours, deleteEntry, shiftPhotos, uploadShiftPhotos } = useStore();

  const [jobId, setJobId] = useState<string>('');
  const [hours, setHours] = useState<string>('');
  /**
   * Activities worked, in the order they were tapped. One selected =
   * all the hours go to it (identical to the old single-select flow, no
   * extra taps). Two or more = a per-activity hours box appears, prefilled
   * with an even split, and each activity saves as its OWN entry — that's
   * what keeps the hours-by-activity chart honest instead of attributing a
   * whole day to whichever activity happened to be tapped first.
   */
  const [activities, setActivities] = useState<ActivityType[]>([]);
  /** activity → hours string, only used when 2+ activities are selected. */
  const [activitySplit, setActivitySplit] = useState<Partial<Record<ActivityType, string>>>({});
  const [note, setNote] = useState('');
  const [date, setDate] = useState(todayIso());
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  /** Is the collapsible "what's included" block open? Closed by default. */
  const [showDetail, setShowDetail] = useState(false);

  const photoPreviews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);

  const myUid = membership?.userId;
  const firstName = membership?.displayName?.split(' ')[0];

  // Jobs this person is ASSIGNED to (RLS on jobs_public already filters
  // to assigned jobs — migration 035), workable status only. Jobs booked
  // for the chosen day float to the top; a single one is pre-selected so
  // it's zero taps in the common case.
  const { myJobs, suggestedJobId } = useMemo(() => {
    const bookedForDate = new Set(
      scheduleItems.filter((s) => s.type === 'job_booking' && s.date === date && s.jobId).map((s) => s.jobId as string),
    );
    const list = jobs
      .filter((j) => LOGGABLE.includes(j.status))
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

  // Picking a different job starts collapsed again — selecting a job
  // should never dump a wall of scope on you, which was the complaint.
  useEffect(() => { setShowDetail(false); }, [selectedId]);

  // Is there anything behind the "What's included?" toggle worth opening?
  const hasDetail = !!selectedJob && (
    !!selectedJob.notes
    || (selectedJob.scopeIncluded?.length ?? 0) > 0
    || (selectedJob.scopeExcluded?.length ?? 0) > 0
  );

  // Job thumbnails — recognising a site by sight beats reading similar
  // names. Signed in one batched call; missing images just don't render.
  const coverPaths = useMemo(
    () => myJobs.map((j) => jobCoverPath(j, shiftPhotos)),
    [myJobs, shiftPhotos],
  );
  const coverUrls = useSignedCovers(coverPaths);
  const coverFor = (j: { id: string; coverPhotoPath?: string }) => {
    const p = jobCoverPath(j, shiftPhotos);
    return p ? coverUrls[p] : undefined;
  };

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

  // Photos already uploaded for this job + day (confirmation count).
  const uploadedTodayCount = shiftPhotos.filter((p) => p.jobId === selectedId && p.takenOn === date).length;

  // ── Activity selection + the multi-activity split ──────────────────────
  const multi = activities.length > 1;
  const totalHours = parseFloat(hours) || 0;

  // Off-site-only sessions need no job — that's the whole point of the
  // category. Mixed selections (e.g. painting + admin) still need a job,
  // because the on-site half has to be attributed to one.
  const offsiteOnly = activities.length > 0 && activities.every((a) => OFFSITE.includes(a));
  const jobRequired = !offsiteOnly;

  /** Even split of the total across the picked activities, to 0.25h. */
  function evenSplit(list: ActivityType[], total: number): Partial<Record<ActivityType, string>> {
    if (list.length === 0 || total <= 0) return {};
    const each = Math.round((total / list.length) * 4) / 4;
    const out: Partial<Record<ActivityType, string>> = {};
    list.forEach((a, i) => {
      // Last one absorbs the rounding remainder so the parts always sum
      // to the total the person actually typed.
      out[a] = i === list.length - 1
        ? String(Math.round((total - each * (list.length - 1)) * 100) / 100)
        : String(each);
    });
    return out;
  }

  function toggleActivity(a: ActivityType) {
    const next = activities.includes(a)
      ? activities.filter((x) => x !== a)
      : [...activities, a];
    setActivities(next);
    setActivitySplit(next.length > 1 ? evenSplit(next, totalHours) : {});
  }

  function setHoursAndResplit(v: string) {
    setHours(v);
    if (activities.length > 1) setActivitySplit(evenSplit(activities, parseFloat(v) || 0));
  }

  const allocated = multi
    ? activities.reduce((s, a) => s + (parseFloat(activitySplit[a] ?? '') || 0), 0)
    : totalHours;
  // Allow a cent of float slop so 8/3 splits don't block the save button.
  const splitBalances = !multi || Math.abs(allocated - totalHours) < 0.01;

  const canSave = (!jobRequired || !!selectedId) && totalHours > 0 && splitBalances && !busy;

  function onPickPhotos(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    if (picked.length) setPhotos((prev) => [...prev, ...picked].slice(0, 8));
    e.target.value = '';
  }
  function removePhoto(i: number) {
    setPhotos((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSave() {
    if (!canSave) return;
    const theJob = selectedId;
    const theDate = date;
    const toUpload = photos;
    // One entry per activity, so hours-by-activity stays truthful. A
    // single activity (or none) is still exactly one entry — the common
    // case is unchanged.
    // Off-site work belongs to no job — send it as overhead (undefined
    // jobId) even if a job happens to be selected, so admin time never
    // lands on a customer's job costs.
    const jobFor = (a?: ActivityType) =>
      a && OFFSITE.includes(a) ? undefined : (theJob || undefined);

    if (multi) {
      for (const a of activities) {
        const h = parseFloat(activitySplit[a] ?? '') || 0;
        if (h <= 0) continue;
        logMyHours({
          jobId: jobFor(a),
          hours: h,
          activity: a,
          note: note.trim() || undefined,
          entryDate: theDate,
        });
      }
    } else {
      logMyHours({
        jobId: jobFor(activities[0]),
        hours: totalHours,
        activity: activities[0] || undefined,
        note: note.trim() || undefined,
        entryDate: theDate,
      });
    }
    setHours(''); setActivities([]); setActivitySplit({}); setNote(''); setPhotos([]);
    // Photos hang off a job, so there's nothing to attach on an
    // office-only day.
    if (toUpload.length > 0 && theJob) {
      setBusy(true);
      await uploadShiftPhotos({ jobId: theJob, takenOn: theDate, files: toUpload });
      setBusy(false);
    }
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

      {/* Active job hero — where to go today. Suppressed on an off-site
          day: there's no site to go to. */}
      {offsiteOnly ? null : selectedJob ? (
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
          {/* Tap to see it full screen — a 144px strip isn't enough to
              recognise a place you haven't been to. */}
          <JobPhoto jobId={selectedJob.id} className="w-full h-36" fallback="none" />
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
          {/* Scope + notes are COLLAPSED by default. Most of the time the
              person already knows the job and just wants to log the day —
              a wall of inclusions between them and the hours field is in
              the way. It's one tap when they do need to check. */}
          {hasDetail && (
            <div>
              <button
                type="button"
                onClick={() => setShowDetail((v) => !v)}
                aria-expanded={showDetail}
                className="w-full min-h-[44px] rounded-xl border border-border bg-muted/40 px-3 flex items-center justify-between text-sm font-medium"
              >
                <span className="flex items-center gap-1.5">
                  <ClipboardList size={14} className="text-muted-foreground" />
                  {showDetail ? 'Hide job details' : 'What’s included?'}
                </span>
                {showDetail ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>

              {showDetail && (
                <div className="mt-2 space-y-2">
                  {selectedJob.notes && (
                    <div className="rounded-xl bg-muted/40 p-3">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">What to do</p>
                      <p className="text-sm whitespace-pre-wrap">{selectedJob.notes}</p>
                    </div>
                  )}
                  {/* What the job covers — and, more importantly, what it
                      doesn't, so nobody does unpaid extras by accident. */}
                  {((selectedJob.scopeIncluded?.length ?? 0) > 0
                    || (selectedJob.scopeExcluded?.length ?? 0) > 0) && (
                    <div className="rounded-xl bg-muted/40 p-3">
                      <ScopeLists
                        included={selectedJob.scopeIncluded ?? []}
                        excluded={selectedJob.scopeExcluded ?? []}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          No job booked for {prettyDate(date).toLowerCase()}. Pick one below to log
          time, or if you were off site that day pick Admin / Website / Marketing
          under “What did you do?”.
        </div>
      )}

      {/* Day selector — three quick chips cover most logging; the date
          field below is there for catching up on an older week. */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Log for</label>
        <div className="flex gap-2">
          {[todayIso(), isoDaysAgo(1), isoDaysAgo(2)].map((d) => (
            <button
              key={d}
              // Deliberately does NOT clear the picked job. Changing the
              // day used to wipe the selection, which is maddening when
              // you're logging the same job across several days — the
              // whole point of switching to Yesterday. If nothing was
              // explicitly picked, the day's suggestion still applies.
              onClick={() => setDate(d)}
              className={cn(
                'flex-1 min-h-[44px] rounded-xl border text-sm font-medium transition-colors',
                date === d ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground',
              )}
            >
              {prettyDate(d)}
            </button>
          ))}
        </div>
        {/* Any earlier date. Capped at today — you can't log hours you
            haven't worked yet. */}
        <div className="mt-2">
          <input
            type="date"
            value={date}
            max={todayIso()}
            onChange={(e) => {
              // Same as the chips: keep whatever job was picked.
              if (e.target.value) setDate(e.target.value);
            }}
            className="w-full min-h-[44px] rounded-xl border border-border bg-card px-3 text-sm outline-none focus:border-primary"
          />
          {![todayIso(), isoDaysAgo(1), isoDaysAgo(2)].includes(date) && (
            <p className="text-[11px] text-primary font-medium mt-1">
              Catching up on {prettyDate(date)}.
            </p>
          )}
        </div>
      </div>

      {/* Job picker (only if more than one booked job, or none pre-selected) */}
      {!offsiteOnly && myJobs.length > 0 && (myJobs.length > 1 || !selectedId) && (
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Job</label>
          <div className="space-y-2">
            {myJobs.map((j) => {
              const cover = coverFor(j);
              return (
                <button
                  key={j.id}
                  onClick={() => setJobId(j.id)}
                  className={cn(
                    'w-full text-left rounded-xl border p-2.5 min-h-[44px] transition-colors flex items-center gap-3',
                    selectedId === j.id ? 'bg-primary/10 border-primary' : 'bg-card border-border',
                  )}
                >
                  {/* Plain img, NOT JobPhoto: inside a row whose whole
                      job is to select the job, a tappable photo would
                      steal the tap. Enlarge lives on the hero above. */}
                  {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={cover}
                      alt=""
                      className="w-14 h-14 rounded-lg object-cover border border-border shrink-0"
                    />
                  ) : (
                    <span className="w-14 h-14 rounded-lg bg-muted border border-border shrink-0 flex items-center justify-center text-muted-foreground">
                      <Camera size={16} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold text-sm block truncate">{j.name}</span>
                    {j.location && (
                      <span className="text-xs text-muted-foreground block truncate">{j.location}</span>
                    )}
                  </span>
                  {selectedId === j.id && <Check size={16} className="text-primary shrink-0" />}
                </button>
              );
            })}
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
              onClick={() => setHoursAndResplit(String(h))}
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
          onChange={(e) => setHoursAndResplit(e.target.value)}
          className="w-full min-h-[48px] rounded-xl border border-border bg-card px-3 text-base outline-none focus:border-primary"
        />
      </div>

      {/* Activity */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          What did you do? <span className="normal-case text-[10px]">(pick as many as you like)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {SITE_ACTIVITIES.map((a) => {
            const on = activities.includes(a);
            return (
              <button
                key={a}
                onClick={() => toggleActivity(a)}
                aria-pressed={on}
                className={cn(
                  'min-h-[40px] px-3 rounded-full border text-sm capitalize transition-colors',
                  on ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground',
                )}
              >
                {a}
              </button>
            );
          })}
        </div>

        {/* Off the tools — no job needed, logged as overhead. */}
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mt-3 mb-1.5">
          Off site
        </p>
        <div className="flex flex-wrap gap-2">
          {OFFSITE.map((a) => {
            const on = activities.includes(a);
            return (
              <button
                key={a}
                onClick={() => toggleActivity(a)}
                aria-pressed={on}
                className={cn(
                  'min-h-[40px] px-3 rounded-full border text-sm transition-colors',
                  on ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground',
                )}
              >
                {ACTIVITY_LABELS[a] ?? a}
              </button>
            );
          })}
        </div>
        {offsiteOnly && (
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Off-site time isn&apos;t tied to a job — no need to pick one.
          </p>
        )}

        {/* Split — only once there's more than one activity. Prefilled
            evenly so it's already correct-ish; adjust if the day wasn't
            an even split. Each row saves as its own entry. */}
        {multi && (
          <div className="mt-3 rounded-xl border border-border bg-card p-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              How many hours on each?
            </p>
            {activities.map((a) => (
              <div key={a} className="flex items-center gap-2">
                <span className="flex-1 text-sm capitalize">{a}</span>
                <input
                  type="number" inputMode="decimal" step="0.25" min="0"
                  value={activitySplit[a] ?? ''}
                  onChange={(e) => setActivitySplit((prev) => ({ ...prev, [a]: e.target.value }))}
                  className="w-24 min-h-[44px] rounded-lg border border-border bg-background px-2.5 text-base text-right outline-none focus:border-primary"
                />
                <span className="text-sm text-muted-foreground w-4">h</span>
              </div>
            ))}
            <p className={cn(
              'text-xs',
              splitBalances ? 'text-muted-foreground' : 'text-destructive font-medium',
            )}>
              {splitBalances
                ? `Adds up to ${totalHours}h ✓`
                : `These add up to ${Math.round(allocated * 100) / 100}h — your total says ${totalHours}h.`}
            </p>
          </div>
        )}
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

      {/* Photos */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Photos <span className="normal-case text-[10px]">(optional)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {photoPreviews.map((src, i) => (
            <div key={i} className="relative w-20 h-20 rounded-xl overflow-hidden border border-border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" className="w-full h-full object-cover" />
              <button
                onClick={() => removePhoto(i)}
                className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded-full p-0.5"
                aria-label="Remove photo"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <label className="w-20 h-20 rounded-xl border border-dashed border-border flex flex-col items-center justify-center cursor-pointer text-muted-foreground hover:border-primary/50">
            <Camera size={20} />
            <span className="text-[10px] mt-0.5">Add</span>
            <input type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={onPickPhotos} />
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">
          Snap the work you did — Brad sees these on the job.
          {uploadedTodayCount > 0 && ` · ${uploadedTodayCount} already added.`}
        </p>
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
            {busy ? 'Uploading photos…' : justSaved ? (<><Check size={18} /> Saved</>) : `Save ${hours ? hours + 'h' : 'hours'}${photos.length ? ` + ${photos.length} photo${photos.length > 1 ? 's' : ''}` : ''}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
