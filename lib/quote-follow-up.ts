// Quote follow-up ladder — the "don't let a sent quote rot" logic.
//
// Brad's cadence (his words, June 2026):
//   1. First follow-up ~7 days after sending. Long enough not to crowd
//      them, short enough that the job's still front of mind. Most
//      quotes are won or lost in this window.
//   2. Second follow-up at the 3-week mark — the short "either way"
//      message that closes the loop.
//   3. If they still haven't replied a week after that second message,
//      the lead is dead. Prompt to mark it lost (one tap, never auto).
//
// Consumed by the Home screen (QuoteFollowUpsFlag) and the Leads tab
// ("Quoted, awaiting reply" cards get a stage pill). Keep the rules HERE
// so both surfaces always agree.
//
// The only "Brad chased them" signal we have is job.lastContactedDate —
// a single timestamp, bumped by Mark contacted / Book visit / Mark
// quoted. Two consequences shape the logic below:
//
//   - Mark-as-quoted bumps lastContactedDate at the send moment, so
//     "contact exists after dateSent" does NOT mean a follow-up
//     happened. We instead test contact against each milestone date.
//   - A milestone counts as satisfied if Brad made contact within
//     SATISFY_SLOP_DAYS before it (or any time after). So chasing on
//     day 5 satisfies the day-7 milestone — we don't nag him two days
//     after he already chased.

import type { Job, Quote } from './types';

/** Days after dateSent for the first follow-up (default — an explicit
 *  job.followUpDate overrides this when it's set and later than the send). */
export const FIRST_FOLLOW_UP_DAYS = 7;
/** Days after dateSent for the second, "either way" follow-up. */
export const SECOND_FOLLOW_UP_DAYS = 21;
/** Days of silence AFTER the second follow-up before prompting Mark lost. */
export const CLOSE_AFTER_SILENCE_DAYS = 7;
/** Contact this many days BEFORE a milestone still counts as doing it. */
export const SATISFY_SLOP_DAYS = 3;

export type FollowUpStage = 'first' | 'second' | 'close';

export interface QuoteFollowUp {
  job: Job;
  stage: FollowUpStage;
  /** ISO date the clock started — quote.dateSent (or fallback, see below). */
  dateSent: string;
  daysSinceSent: number;
  daysSinceContact: number;
}

// ── ISO date helpers (date-only, local — same convention as home/page.tsx) ──

function dateOnly(iso: string): string {
  // Accepts both YYYY-MM-DD and full timestamps.
  return iso.slice(0, 10);
}

function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d + n);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function daysBetween(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = dateOnly(fromISO).split('-').map(Number);
  const [ty, tm, td] = dateOnly(toISO).split('-').map(Number);
  if (!fy || !ty) return 0;
  const from = new Date(fy, (fm ?? 1) - 1, fd ?? 1).getTime();
  const to = new Date(ty, (tm ?? 1) - 1, td ?? 1).getTime();
  return Math.round((to - from) / 86400000);
}

/**
 * The date the quote went out, for follow-up purposes. Latest dateSent
 * across the job's quote rows (preferring status='sent' rows, since a
 * superseded draft shouldn't restart the clock). Falls back to the
 * job's updatedAt — weak (any edit moves it) but better than nothing
 * for legacy quoted jobs that predate the quotes table.
 */
function sentDateFor(job: Job, quotes: Quote[]): string {
  const mine = quotes.filter((q) => q.jobId === job.id && q.dateSent);
  if (mine.length > 0) {
    const sent = mine.filter((q) => q.status === 'sent');
    const pool = sent.length > 0 ? sent : mine;
    return pool
      .map((q) => dateOnly(q.dateSent!))
      .sort()
      .at(-1)!;
  }
  return dateOnly(job.updatedAt);
}

/**
 * Compute the follow-up stage for every quoted job. Jobs with no stage
 * due (fresh quote, or Brad already chased on schedule) are omitted —
 * callers render flags only, never empty rows.
 *
 * Sorted most-urgent first: close > second > first, then oldest quote
 * first within a stage.
 */
export function computeQuoteFollowUps(
  jobs: Job[],
  quotes: Quote[],
  todayISO: string,
): QuoteFollowUp[] {
  const out: QuoteFollowUp[] = [];

  for (const job of jobs) {
    if (job.status !== 'quoted') continue;

    // Snoozed = Brad has consciously decided not to chase yet. Nagging him
    // anyway defeats the point of the snooze, and it's worst for the case
    // snoozing exists for: a quote to a builder who's tendering for the
    // main contract can't be hurried, so a weekly "2nd follow-up due" flag
    // is pure noise. The ladder resumes by itself the day the snooze ends
    // (or never, for an indefinite one, until it's cleared).
    if (job.snoozeUntil && job.snoozeUntil > todayISO) continue;

    const sent = sentDateFor(job, quotes);
    const daysSinceSent = daysBetween(sent, todayISO);
    if (daysSinceSent < 0) continue; // future-dated — clock hasn't started

    // Contact reference, clamped to the send date: contact BEFORE the
    // quote went out (e.g. the site-visit call) can't satisfy anything.
    const rawContact = job.lastContactedDate
      ? dateOnly(job.lastContactedDate)
      : sent;
    const contact = rawContact > sent ? rawContact : sent;
    const daysSinceContact = daysBetween(contact, todayISO);

    // Milestones. An explicit followUpDate (set in MarkAsQuotedSheet,
    // defaults to +5 days) overrides the day-7 default for the FIRST
    // milestone — it's a promise Brad typed in, honour it. Guard against
    // a followUpDate at/after the second milestone, which would make the
    // ladder degenerate.
    const m2 = addDaysISO(sent, SECOND_FOLLOW_UP_DAYS);
    const followUp = job.followUpDate ? dateOnly(job.followUpDate) : null;
    const m1 = followUp && followUp > sent && followUp < m2
      ? followUp
      : addDaysISO(sent, FIRST_FOLLOW_UP_DAYS);

    // A milestone is "done" if Brad made contact within SLOP days before
    // it or any time after — but the contact must be after the send
    // itself (the mark-as-quoted bump lands ON the send date and counts
    // for nothing).
    const satisfied = (m: string) =>
      contact > sent && contact >= addDaysISO(m, -SATISFY_SLOP_DAYS);

    let stage: FollowUpStage | null = null;
    if (todayISO >= m2 && !satisfied(m2)) {
      // Past three weeks and the "either way" message hasn't gone out.
      // This supersedes the first-follow-up flag — show one row per job,
      // the most urgent one.
      stage = 'second';
    } else if (todayISO >= m1 && todayISO < m2 && !satisfied(m1)) {
      stage = 'first';
    } else if (satisfied(m2) && daysSinceContact >= CLOSE_AFTER_SILENCE_DAYS) {
      // Second follow-up sent, a week of silence since — close the loop.
      stage = 'close';
    }

    if (stage) {
      out.push({ job, stage, dateSent: sent, daysSinceSent, daysSinceContact });
    }
  }

  const rank: Record<FollowUpStage, number> = { close: 0, second: 1, first: 2 };
  return out.sort((a, b) =>
    rank[a.stage] - rank[b.stage] || b.daysSinceSent - a.daysSinceSent,
  );
}
