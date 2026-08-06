'use client';

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { jobCoverPath } from '@/lib/job-cover';
import { cn } from '@/lib/utils';
import { Camera, Trash2, Star } from 'lucide-react';

/**
 * Site photos logged against this job by whoever worked it (usually an
 * employee, on their Log Hours screen). Signs each private object for an
 * hour and shows a tap-to-open grid, grouped by day. Hidden when empty.
 */
export function ShiftPhotosPanel({ jobId }: { jobId: string }) {
  const { shiftPhotos, deleteShiftPhoto, jobs, role, setJobCoverPhoto } = useStore();

  // Which photo is currently the job's main image (explicit pick, or the
  // newest photo by the auto-fallback rule). Starred in the grid.
  const job = jobs.find((j) => j.id === jobId);
  const coverPath = job ? jobCoverPath(job, shiftPhotos) : undefined;
  const coverIsExplicit = !!job?.coverPhotoPath;

  const photos = useMemo(
    () => shiftPhotos
      .filter((p) => p.jobId === jobId)
      .sort((a, b) => b.takenOn.localeCompare(a.takenOn) || b.createdAt.localeCompare(a.createdAt)),
    [shiftPhotos, jobId],
  );

  const pathsKey = photos.map((p) => p.storagePath).join('|');
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

  if (photos.length === 0) return null;

  // Group by day for a tidy "what happened when" read.
  const groups: [string, typeof photos][] = [];
  for (const p of photos) {
    const last = groups[groups.length - 1];
    if (last && last[0] === p.takenOn) last[1].push(p);
    else groups.push([p.takenOn, [p]]);
  }

  const prettyDay = (iso: string) =>
    new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Camera size={13} /> Site photos ({photos.length})
        </p>
        {role === 'owner' && (
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {coverIsExplicit
              ? 'The starred photo is this job’s main image — tap the star on another to change it.'
              : 'Newest photo is the job’s main image. Tap a star to pin a different one.'}
          </p>
        )}
      </div>
      {groups.map(([day, items]) => (
        <div key={day} className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground">{prettyDay(day)}</p>
          <div className="grid grid-cols-3 gap-2">
            {items.map((p) => {
              const u = urls[p.storagePath];
              const isCover = coverPath === p.storagePath;
              return (
                <div
                  key={p.id}
                  className={cn(
                    'relative group aspect-square rounded-lg overflow-hidden border bg-muted',
                    isCover ? 'border-primary ring-2 ring-primary/40' : 'border-border',
                  )}
                >
                  {u ? (
                    <a href={u} target="_blank" rel="noopener noreferrer" className="block w-full h-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={u} alt="" className="w-full h-full object-cover" />
                    </a>
                  ) : (
                    <div className="w-full h-full animate-pulse" />
                  )}
                  {/* Cover pin — owner only. The current cover's star stays
                      visible; the rest reveal on hover/focus. Tapping the
                      current cover clears it back to auto-pick. */}
                  {role === 'owner' && (
                    <button
                      onClick={() => setJobCoverPhoto(
                        jobId,
                        isCover && coverIsExplicit
                          ? null
                          : { bucket: 'shift-photos', path: p.storagePath },
                      )}
                      className={cn(
                        'absolute top-1 left-1 rounded-full p-1 transition-opacity',
                        isCover
                          ? 'bg-primary text-primary-foreground opacity-100'
                          : 'bg-black/60 text-white opacity-0 group-hover:opacity-100 focus:opacity-100',
                      )}
                      aria-label={isCover ? 'Main image (tap to unpin)' : 'Make main image'}
                      title={isCover ? 'Main image' : 'Make main image'}
                    >
                      <Star size={12} fill={isCover ? 'currentColor' : 'none'} />
                    </button>
                  )}
                  <button
                    onClick={() => deleteShiftPhoto(p.id)}
                    className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="Delete photo"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
