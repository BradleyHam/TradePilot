'use client';

/**
 * JobPhoto — a job's main image, tappable to open full-screen.
 *
 * Used on the employee screens (Log Hours hero, schedule day sheet), where
 * "what does this place actually look like" is the whole point of the
 * thumbnail — a 140px-tall strip isn't enough to recognise a wall you
 * haven't seen before.
 *
 * The viewer shows every photo of the job the signed-in person is allowed
 * to see, so they can swipe through:
 *   • the cover (readable by any member — that's why covers are copied
 *     into the shift-photos bucket in the first place), plus
 *   • their own shift photos for that job (employee RLS on `shift_photos`
 *     returns only their own uploads; the owner sees all of them).
 *
 * Nothing here can reach `quote-attachments` — that bucket is owner-only
 * and holds priced PDFs.
 */

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { jobCoverPath, useSignedCovers } from '@/lib/job-cover';
import { PhotoLightbox, type LightboxImage } from '@/components/jobs/photo-lightbox';
import { cn } from '@/lib/utils';
import { Camera, Maximize2 } from 'lucide-react';

export function JobPhoto({
  jobId,
  className,
  /** Rendered instead of nothing when the job has no photos at all. */
  fallback = 'icon',
}: {
  jobId: string;
  className?: string;
  fallback?: 'icon' | 'none';
}) {
  const { jobs, shiftPhotos } = useStore();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const job = jobs.find((j) => j.id === jobId);

  // Cover first, then this person's own shift photos, newest first.
  // De-duped so a cover pinned FROM a shift photo doesn't appear twice.
  const paths = useMemo(() => {
    if (!job) return [];
    const cover = jobCoverPath(job, shiftPhotos);
    const mine = shiftPhotos
      .filter((p) => p.jobId === jobId)
      .sort((a, b) => b.takenOn.localeCompare(a.takenOn) || b.createdAt.localeCompare(a.createdAt))
      .map((p) => p.storagePath);
    return [...new Set([...(cover ? [cover] : []), ...mine])];
  }, [job, jobId, shiftPhotos]);

  const urls = useSignedCovers(paths);

  const images: LightboxImage[] = paths.map((p, i) => ({
    id: p,
    fileName: i === 0 ? 'Job photo' : `Photo ${i + 1}`,
    signedUrl: urls[p] ?? null,
  }));

  const heroUrl = paths.length > 0 ? urls[paths[0]] : undefined;

  if (paths.length === 0 || !heroUrl) {
    if (fallback === 'none') return null;
    return (
      <span className={cn(
        'rounded-xl bg-muted border border-border flex items-center justify-center text-muted-foreground',
        className,
      )}>
        <Camera size={18} />
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setLightboxIndex(0)}
        aria-label="Open photo full screen"
        className={cn('relative group overflow-hidden rounded-xl border border-border', className)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={heroUrl} alt="" className="w-full h-full object-cover" />
        {/* Affordance — without it a photo doesn't look tappable. */}
        <span className="absolute bottom-1.5 right-1.5 rounded-lg bg-black/55 text-white p-1.5 backdrop-blur-sm">
          <Maximize2 size={13} />
        </span>
        {paths.length > 1 && (
          <span className="absolute bottom-1.5 left-1.5 rounded-lg bg-black/55 text-white text-[11px] font-medium px-1.5 py-0.5 backdrop-blur-sm">
            {paths.length} photos
          </span>
        )}
      </button>

      {lightboxIndex !== null && (
        <PhotoLightbox
          images={images}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
