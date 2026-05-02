/**
 * Smart job-list ranking. Given a list of jobs and an optional context blob
 * (e.g. a bank-transaction payee/particulars/reference), return jobs sorted
 * by relevance:
 *
 *   1. Active jobs that fuzzy-match the context (highest priority)
 *   2. Active jobs (in-progress, booked, accepted, quoted, lead)
 *   3. Recently-completed jobs (within 60 days), still match-boosted
 *   4. Older jobs, hidden behind a "show all" affordance in the UI
 *
 * Match scoring is intentionally cheap: we tokenise the context blob and
 * each job's name/client/location, count overlaps. A token is any 3+ char
 * lowercase word.
 */

import type { Job } from './types';

export type JobRelevanceTier = 'active-match' | 'active' | 'recent' | 'older';

export interface RankedJob {
  job: Job;
  tier: JobRelevanceTier;
  /** 0–100 fuzzy-match score against context. Higher = better. */
  score: number;
}

const ACTIVE_STATUSES = new Set<Job['status']>(['lead','quoted','accepted','booked','in-progress']);
const COMPLETED_STATUSES = new Set<Job['status']>(['completed','invoiced','paid']);
const RECENT_DAYS = 60;

function tokenise(s: string | undefined | null): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/** Score how well a job's identifying text matches the context tokens. */
function fuzzyScore(job: Job, ctxTokens: Set<string>): number {
  if (ctxTokens.size === 0) return 0;
  const jobBlob = [job.name, job.clientName, job.location, job.legacyId]
    .filter(Boolean).join(' ');
  const jobTokens = new Set(tokenise(jobBlob));
  let hits = 0;
  for (const t of ctxTokens) {
    if (jobTokens.has(t)) { hits += 10; continue; }
    // Soft-match: substring (covers "perrow" matching "perrow st")
    for (const jt of jobTokens) {
      if (jt.includes(t) || t.includes(jt)) { hits += 5; break; }
    }
  }
  return hits;
}

function isRecent(job: Job, now: Date): boolean {
  if (!COMPLETED_STATUSES.has(job.status)) return false;
  const ref = job.endDate ?? job.updatedAt;
  if (!ref) return false;
  const t = new Date(ref).getTime();
  if (!Number.isFinite(t)) return false;
  return (now.getTime() - t) <= RECENT_DAYS * 86_400_000;
}

/**
 * Sort jobs by relevance for a picker.
 *
 * If `context` is provided (e.g. bank txn description), jobs whose name/
 * client/legacy_id match tokens from the context get a strong boost.
 *
 * Returns ALL jobs ranked, with `tier` for the UI to optionally section them.
 */
export function rankJobs(
  jobs: Job[],
  context?: string,
  now: Date = new Date(),
): RankedJob[] {
  const ctxTokens = new Set(tokenise(context ?? ''));
  const ranked: RankedJob[] = jobs.map((job) => {
    const score = fuzzyScore(job, ctxTokens);
    const active = ACTIVE_STATUSES.has(job.status);
    const recent = isRecent(job, now);
    let tier: JobRelevanceTier;
    if (active && score > 0) tier = 'active-match';
    else if (active) tier = 'active';
    else if (recent) tier = 'recent';
    else tier = 'older';
    return { job, tier, score };
  });

  const tierWeight: Record<JobRelevanceTier, number> = {
    'active-match': 0,
    'active':       1,
    'recent':       2,
    'older':        3,
  };

  ranked.sort((a, b) => {
    if (tierWeight[a.tier] !== tierWeight[b.tier]) {
      return tierWeight[a.tier] - tierWeight[b.tier];
    }
    if (a.score !== b.score) return b.score - a.score;
    // Within tier+score, sort by recency
    const aT = new Date(a.job.updatedAt).getTime();
    const bT = new Date(b.job.updatedAt).getTime();
    return bT - aT;
  });

  return ranked;
}
