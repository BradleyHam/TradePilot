'use client';

/**
 * EmployeeDetailSheet — the owner's per-person view, opened by tapping an
 * employee on Settings → Team. Three sections:
 *
 *   1. Jobs — every workable job as a toggle row; tap to assign/unassign
 *      this person (writes job-level `job_assignments` via
 *      store.setJobAssignees, preserving everyone else on the job).
 *   2. Hours — this week + total, plus their recent hours entries.
 *      Owner RLS sees all entries; filtered by logged_by_user_id, so only
 *      hours the person logged THEMSELVES count (legacy helperHours from
 *      before employee logins don't appear here).
 *   3. Photos — their shift-photo uploads, signed on demand (same pattern
 *      as ShiftPhotosPanel).
 *
 * Money never renders here — it's a staffing lens, not a payroll one
 * (pay lives in the Home payroll flags).
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import type { BusinessMember, JobStatus } from '@/lib/types';
import { Briefcase, Clock, Camera, Check } from 'lucide-react';

/** Statuses worth assigning people to — matches the migration backfill. */
const WORKABLE: JobStatus[] = ['accepted', 'booked', 'in-progress'];

function mondayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function prettyDay(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

export function EmployeeDetailSheet({
  member,
  open,
  onClose,
}: {
  member: BusinessMember | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="h-[90vh] overflow-y-auto rounded-t-2xl px-4 pb-10">
        <SheetHeader className="pb-3">
          <SheetTitle>{member?.displayName ?? 'Employee'}</SheetTitle>
        </SheetHeader>
        {member && <EmployeeDetailBody member={member} />}
      </SheetContent>
    </Sheet>
  );
}

function EmployeeDetailBody({ member }: { member: BusinessMember }) {
  const { jobs, entries, shiftPhotos, jobAssignments, setJobAssignees } = useStore();
  const uid = member.userId;
  const firstName = member.displayName?.split(' ')[0];

  // ── Jobs: workable ones, assigned first ─────────────────────────────────
  const workable = useMemo(
    () =>
      jobs
        .filter((j) => WORKABLE.includes(j.status))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [jobs],
  );
  const myJobIds = useMemo(
    () => new Set(jobAssignments.filter((a) => a.userId === uid).map((a) => a.jobId)),
    [jobAssignments, uid],
  );

  function toggleJob(jobId: string) {
    // Preserve everyone else on the job — setJobAssignees replaces the
    // job's FULL assignee set, so rebuild it from current state ± this uid.
    const others = jobAssignments
      .filter((a) => a.jobId === jobId && a.userId !== uid)
      .map((a) => a.userId);
    const next = myJobIds.has(jobId) ? others : [...others, uid];
    void setJobAssignees(jobId, next);
  }

  // ── Hours: their own logged entries ─────────────────────────────────────
  const myHours = useMemo(
    () =>
      entries
        .filter((e) => e.type === 'hours' && e.loggedByUserId === uid)
        .sort((a, b) => b.entryDate.localeCompare(a.entryDate) || b.createdAt.localeCompare(a.createdAt)),
    [entries, uid],
  );
  const weekTotal = useMemo(() => {
    const monday = mondayIso();
    return myHours.filter((e) => e.entryDate >= monday).reduce((s, e) => s + (e.hours ?? 0), 0);
  }, [myHours]);
  const allTotal = myHours.reduce((s, e) => s + (e.hours ?? 0), 0);
  const recentHours = myHours.slice(0, 12);

  const jobName = (id?: string) => jobs.find((j) => j.id === id)?.name ?? 'Job';

  // ── Photos: their uploads, signed on demand ─────────────────────────────
  const myPhotos = useMemo(
    () =>
      shiftPhotos
        .filter((p) => p.uploadedBy === uid)
        .sort((a, b) => b.takenOn.localeCompare(a.takenOn) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, 30),
    [shiftPhotos, uid],
  );
  const pathsKey = myPhotos.map((p) => p.storagePath).join('|');
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    const paths = pathsKey ? pathsKey.split('|') : [];
    if (paths.length === 0) return;
    let cancelled = false;
    supabase.storage.from('shift-photos').createSignedUrls(paths, 3600).then(({ data, error }) => {
      if (cancelled || error || !data) return;
      const map: Record<string, string> = {};
      for (const row of data) if (row.signedUrl && row.path) map[row.path] = row.signedUrl;
      setUrls(map);
    });
    return () => { cancelled = true; };
  }, [pathsKey]);

  return (
    <div className="space-y-6 max-w-xl mx-auto w-full">
      {/* Hours summary strip */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-2xl bg-primary/5 border border-primary/20 p-3">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">This week</p>
          <p className="text-xl font-bold">{weekTotal}<span className="text-sm font-medium text-muted-foreground"> hrs</span></p>
        </div>
        <div className="rounded-2xl bg-card border border-border p-3">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">All time</p>
          <p className="text-xl font-bold">{allTotal}<span className="text-sm font-medium text-muted-foreground"> hrs</span></p>
        </div>
      </div>

      {/* Jobs */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
          <Briefcase size={13} /> On {myJobIds.size === 0 ? 'no jobs' : `${[...myJobIds].filter((id) => workable.some((j) => j.id === id)).length} of ${workable.length} active jobs`}
        </p>
        {workable.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active jobs to assign right now.</p>
        ) : (
          <div className="space-y-2">
            {[...workable]
              .sort((a, b) => Number(myJobIds.has(b.id)) - Number(myJobIds.has(a.id)) || a.name.localeCompare(b.name))
              .map((j) => {
                const on = myJobIds.has(j.id);
                return (
                  <button
                    key={j.id}
                    type="button"
                    onClick={() => toggleJob(j.id)}
                    aria-pressed={on}
                    className={cn(
                      'w-full text-left rounded-xl border p-3 min-h-[44px] transition-colors flex items-center justify-between gap-2',
                      on ? 'bg-primary/10 border-primary' : 'bg-card border-border',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="font-semibold text-sm block truncate">{j.name}</span>
                      {j.location && <span className="text-xs text-muted-foreground block truncate">{j.location}</span>}
                    </span>
                    {on
                      ? <span className="text-xs font-medium text-primary flex items-center gap-1 shrink-0"><Check size={14} /> Assigned</span>
                      : <span className="text-xs text-muted-foreground shrink-0">Tap to assign</span>}
                  </button>
                );
              })}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground mt-1.5">
          Assigned jobs (and their booked days) show on {firstName ? `${firstName}’s` : 'their'} phone. Day-by-day overrides live on the schedule — tap a booking there.
        </p>
      </div>

      {/* Recent hours */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
          <Clock size={13} /> Recent hours
        </p>
        {recentHours.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing logged yet — hours appear here once they log time from their phone.
          </p>
        ) : (
          <div className="space-y-2">
            {recentHours.map((e) => (
              <div key={e.id} className="flex items-center justify-between rounded-xl border border-border bg-card p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{jobName(e.jobId)}</p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {prettyDay(e.entryDate)}{e.activity ? ` · ${e.activity}` : ''}
                    {e.description && e.description !== 'Hours' && !e.activity ? ` · ${e.description}` : ''}
                  </p>
                </div>
                <span className="text-sm font-semibold shrink-0">{e.hours ?? 0}h</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Photos */}
      {myPhotos.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
            <Camera size={13} /> Their site photos ({myPhotos.length}{shiftPhotos.filter((p) => p.uploadedBy === uid).length > 30 ? ' latest' : ''})
          </p>
          <div className="grid grid-cols-3 gap-2">
            {myPhotos.map((p) => {
              const u = urls[p.storagePath];
              return (
                <div key={p.id} className="relative aspect-square rounded-lg overflow-hidden border border-border bg-muted">
                  {u ? (
                    <a href={u} target="_blank" rel="noopener noreferrer" className="block w-full h-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={u} alt="" className="w-full h-full object-cover" />
                    </a>
                  ) : (
                    <div className="w-full h-full animate-pulse" />
                  )}
                  <span className="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[10px] px-1.5 py-0.5 truncate">
                    {prettyDay(p.takenOn)} · {jobName(p.jobId)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
