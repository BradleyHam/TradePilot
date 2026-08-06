'use client';

/**
 * Job cover photos — one resolution rule, used by every surface that
 * shows a job thumbnail (employee Log Hours picker, employee calendar,
 * owner Jobs list).
 *
 * Rule: an explicit `job.coverPhotoPath` wins; otherwise fall back to the
 * NEWEST shift photo on the job. So a job gets a thumbnail the moment
 * anyone photographs it, and Brad can override with "Make cover".
 *
 * Every path returned points into the **shift-photos** bucket, which any
 * member of the business can read (migration 027). Covers are copied into
 * that bucket on set precisely so employees can see them without opening
 * up `quote-attachments`, which holds priced PDFs.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase/client';
import type { Job, ShiftPhoto } from './types';

/** The storage path to show for a job, or undefined if it has no image. */
export function jobCoverPath(
  job: Pick<Job, 'id' | 'coverPhotoPath'>,
  shiftPhotos: ShiftPhoto[],
): string | undefined {
  if (job.coverPhotoPath) return job.coverPhotoPath;
  let newest: ShiftPhoto | undefined;
  for (const p of shiftPhotos) {
    if (p.jobId !== job.id) continue;
    if (!newest
      || p.takenOn > newest.takenOn
      || (p.takenOn === newest.takenOn && p.createdAt > newest.createdAt)) {
      newest = p;
    }
  }
  return newest?.storagePath;
}

/**
 * Batch-sign a set of shift-photos paths and return a path→URL map.
 * Signing in one call keeps a list of 20 job cards to a single request.
 * Failures resolve to an empty map — a missing thumbnail must never break
 * the list it sits in.
 */
export function useSignedCovers(paths: (string | undefined)[]): Record<string, string> {
  // Stable key so the effect doesn't refire on every render of a new array.
  const key = useMemo(
    () => [...new Set(paths.filter((p): p is string => !!p))].sort().join('|'),
    [paths],
  );
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const list = key ? key.split('|') : [];
    if (list.length === 0) {
      setUrls({});
      return;
    }
    let cancelled = false;
    supabase.storage
      .from('shift-photos')
      .createSignedUrls(list, 3600)
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        const map: Record<string, string> = {};
        for (const row of data) if (row.signedUrl && row.path) map[row.path] = row.signedUrl;
        setUrls(map);
      })
      .catch(() => { /* thumbnails are decoration — never surface an error */ });
    return () => { cancelled = true; };
  }, [key]);

  return urls;
}
