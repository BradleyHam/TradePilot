'use client';

/**
 * Owner Home view of employee close-outs. The card deliberately derives
 * hours and photos from their canonical tables rather than copying totals
 * into shift_reports, so payroll, job costing and the update can never drift.
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import type { Job, JobVariation, ShiftPhoto, ShiftReport } from '@/lib/types';
import { VariationAction } from '@/components/jobs/variation-action';
import {
  AlertTriangle, Camera, Check, ChevronDown, ClipboardCheck,
  Clock, Copy, DollarSign, Sparkles, Star, Users,
} from 'lucide-react';

function localIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function prettyDay(iso: string): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (iso === localIso(today)) return 'Today';
  if (iso === localIso(yesterday)) return 'Yesterday';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-NZ', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

const STATUS_COPY = {
  all_good: { label: 'All good', icon: Check, className: 'bg-green-50 text-green-800 border-green-200' },
  needs_attention: { label: 'Needs your attention', icon: AlertTriangle, className: 'bg-amber-50 text-amber-900 border-amber-300' },
  ready_for_review: { label: 'Ready for review', icon: ClipboardCheck, className: 'bg-orange-50 text-orange-800 border-orange-200' },
} as const;

export function TeamUpdatesCard() {
  const {
    shiftReports, shiftPhotos, entries, jobs, teamMembers, jobVariations, updateShiftPhoto,
  } = useStore();
  const [open, setOpen] = useState(false);
  const [variationTarget, setVariationTarget] = useState<{
    report: ShiftReport;
    job: Job;
    photos: ShiftPhoto[];
  } | null>(null);
  const [copiedVariationId, setCopiedVariationId] = useState<string | null>(null);

  const recent = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 6);
    const cutoffIso = localIso(cutoff);
    const employeeIds = new Set(teamMembers.filter((member) => member.role === 'employee').map((member) => member.userId));
    return shiftReports
      .filter((report) => employeeIds.has(report.uploadedBy) && report.workDate >= cutoffIso)
      .sort((a, b) => b.workDate.localeCompare(a.workDate) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 12);
  }, [shiftReports, teamMembers]);

  const attention = recent.filter((report) => report.status !== 'all_good');
  // Problems and work waiting for Brad's review are never hidden behind the
  // expander. Ordinary all-good reports stay quiet until he wants the detail.
  const visible = open ? recent : attention;

  const photoPaths = useMemo(() => {
    const keys = new Set(recent.map((report) => `${report.jobId}::${report.uploadedBy}::${report.workDate}`));
    return shiftPhotos
      .filter((photo) => photo.jobId && photo.uploadedBy && keys.has(`${photo.jobId}::${photo.uploadedBy}::${photo.takenOn}`))
      .map((photo) => photo.storagePath);
  }, [recent, shiftPhotos]);
  const pathsKey = photoPaths.join('|');
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    const paths = pathsKey ? pathsKey.split('|') : [];
    if (paths.length === 0) return;
    let cancelled = false;
    supabase.storage.from('shift-photos').createSignedUrls(paths, 3600).then(({ data, error }) => {
      if (cancelled || error || !data) return;
      const next: Record<string, string> = {};
      for (const row of data) if (row.path && row.signedUrl) next[row.path] = row.signedUrl;
      setUrls(next);
    });
    return () => { cancelled = true; };
  }, [pathsKey]);

  if (recent.length === 0) return null;

  const firstName = (uid: string) => {
    const full = teamMembers.find((member) => member.userId === uid)?.displayName?.trim();
    return full ? full.split(/\s+/)[0] : 'Team member';
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Team updates</h2>
        <span className="text-xs text-muted-foreground">Last 7 days</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-h-[60px] w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Users size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">
              {recent.length} update{recent.length === 1 ? '' : 's'} from the team
            </span>
            <span className={cn('block text-xs', attention.length > 0 ? 'font-medium text-amber-700' : 'text-muted-foreground')}>
              {attention.length > 0
                ? `${attention.length} need${attention.length === 1 ? 's' : ''} your review`
                : 'Hours, photos and what got done'}
            </span>
          </span>
          <ChevronDown size={17} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </button>

        {visible.length > 0 && (
          <div className="space-y-2 border-t border-border bg-muted/25 p-2">
            {visible.map((report) => {
              const reportJob = jobs.find((job) => job.id === report.jobId);
              const reportPhotos = shiftPhotos
                .filter((photo) => photo.uploadedBy === report.uploadedBy
                  && photo.jobId === report.jobId
                  && photo.takenOn === report.workDate)
                .slice(0, 6);
              const variation = jobVariations.find((item) => item.shiftReportId === report.id);
              return (
                <TeamUpdateRow
                  key={report.id}
                  report={report}
                  person={firstName(report.uploadedBy)}
                  jobName={reportJob?.name ?? 'Job'}
                  hours={entries
                    .filter((entry) => entry.type === 'hours'
                      && entry.loggedByUserId === report.uploadedBy
                      && entry.jobId === report.jobId
                      && entry.entryDate === report.workDate)
                    .reduce((sum, entry) => sum + (entry.hours ?? 0), 0)}
                  photos={reportPhotos}
                  urls={urls}
                  variation={variation}
                  copied={variation?.id === copiedVariationId}
                  onCreateVariation={reportJob ? () => setVariationTarget({ report, job: reportJob, photos: reportPhotos }) : undefined}
                  onCopyVariation={variation ? async () => {
                    try {
                      await navigator.clipboard.writeText(`${window.location.origin}/variation/${variation.approvalToken}`);
                      setCopiedVariationId(variation.id);
                    } catch {
                      setCopiedVariationId(null);
                    }
                  } : undefined}
                  onToggleMarketing={(id, current) => updateShiftPhoto(id, { marketingCandidate: !current })}
                />
              );
            })}
          </div>
        )}
      </div>

      {variationTarget && (
        <VariationAction
          key={variationTarget.report.id}
          job={variationTarget.job}
          shiftReport={variationTarget.report}
          photos={variationTarget.photos}
          open
          onClose={() => setVariationTarget(null)}
        />
      )}
    </section>
  );
}

function TeamUpdateRow({
  report, person, jobName, hours, photos, urls, variation, copied,
  onCreateVariation, onCopyVariation, onToggleMarketing,
}: {
  report: ShiftReport;
  person: string;
  jobName: string;
  hours: number;
  photos: ReturnType<typeof useStore>['shiftPhotos'];
  urls: Record<string, string>;
  variation?: JobVariation;
  copied: boolean;
  onCreateVariation?: () => void;
  onCopyVariation?: () => void;
  onToggleMarketing: (id: string, current: boolean) => void;
}) {
  const status = STATUS_COPY[report.status];
  const StatusIcon = status.icon;
  return (
    <article className={cn('rounded-xl border bg-card p-3', report.status === 'needs_attention' ? 'border-amber-300' : 'border-border')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{person} · {jobName}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {prettyDay(report.workDate)}
            <span aria-hidden="true">·</span>
            <Clock size={12} /> {hours}h
            {photos.length > 0 && <><span aria-hidden="true">·</span><Camera size={12} /> {photos.length}</>}
          </p>
        </div>
        <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold', status.className)}>
          <StatusIcon size={12} /> {status.label}
        </span>
      </div>

      {report.note && (
        <p className="mt-2 whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-sm text-foreground">
          {report.note}
        </p>
      )}

      {photos.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {photos.map((photo) => {
            const url = urls[photo.storagePath];
            return (
              <div key={photo.id} className="relative aspect-square overflow-hidden rounded-lg border border-border bg-muted">
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="block h-full w-full" aria-label="Open full-size job photo">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt="" className="h-full w-full object-cover" />
                  </a>
                ) : <div className="h-full w-full animate-pulse" />}
                <button
                  type="button"
                  onClick={() => onToggleMarketing(photo.id, photo.marketingCandidate)}
                  aria-label={photo.marketingCandidate ? 'Remove from marketing shortlist' : 'Keep for marketing'}
                  title={photo.marketingCandidate ? 'Saved for marketing' : 'Keep for marketing'}
                  className={cn(
                    'absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-xl border shadow-sm backdrop-blur',
                    photo.marketingCandidate
                      ? 'border-orange-300 bg-orange-500 text-white'
                      : 'border-white/70 bg-black/45 text-white',
                  )}
                >
                  {photo.marketingCandidate ? <Sparkles size={17} /> : <Star size={17} />}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {photos.length > 0 && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">Tap a star to keep a photo for marketing. Nothing is published automatically.</p>
      )}

      {report.status === 'needs_attention' && !variation && onCreateVariation && (
        <button
          type="button"
          onClick={onCreateVariation}
          className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground"
        >
          <DollarSign size={17} /> Turn into a variation
        </button>
      )}

      {variation && variation.status !== 'cancelled' && (
        <div className={cn(
          'mt-3 flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2',
          variation.status === 'approved'
            ? 'border-green-200 bg-green-50 text-green-900'
            : variation.status === 'declined'
              ? 'border-red-200 bg-red-50 text-red-900'
              : 'border-blue-200 bg-blue-50 text-blue-900',
        )}>
          <DollarSign size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 text-xs font-semibold">
            {variation.status === 'approved'
              ? 'Variation approved'
              : variation.status === 'declined'
                ? 'Variation declined'
                : 'Variation ready for client'}
          </span>
          {variation.status === 'ready' && onCopyVariation && (
            <button type="button" onClick={onCopyVariation} className="flex min-h-9 shrink-0 items-center gap-1 rounded-lg bg-white px-2 text-xs font-semibold shadow-sm">
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
