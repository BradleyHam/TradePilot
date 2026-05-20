/**
 * Availability computation — figures out when the business is free to
 * take on new work, based on real schedule data.
 *
 * Used by the public availability API (/api/public/availability) that
 * the customer-facing site reads to render a "next available" banner.
 * Lives on main because it's general enough — any business with
 * scheduled jobs can use it, the route is pinned to whichever
 * TRADEPILOT_BUSINESS_ID is set in the deployment's env.
 *
 * ── Design notes ──────────────────────────────────────────────────────
 *
 * Why this isn't just "max(endDate)":
 *   Painters get bookings with gaps between them. Brad might finish a
 *   job on 14 June, have nothing until a one-week job starting 6 July,
 *   then be free again from 13 July. A "booked until X" banner that
 *   reads "until 14 July" makes the late-June gap invisible — exactly
 *   the kind of week he'd love to fill. So we compute actual gaps, not
 *   just the latest occupied date.
 *
 * What counts as "occupied":
 *   A schedule_item belongs to a job with status accepted/booked/
 *   in-progress. Anything still on lead/quoted is NOT counted — those
 *   haven't actually been committed to yet. This keeps the banner
 *   honest: it represents work the business has SAID YES to, not work
 *   it might eventually win.
 *
 * What counts as a "stretch":
 *   A run of consecutive working days (Mon-Fri) with no occupied
 *   schedule items. Weekends are passed through but don't count toward
 *   the minimum-stretch length. Default minimum: 5 working days, i.e.
 *   one full week — anything shorter isn't really a job slot.
 *
 * What we DON'T do here:
 *   - Quote conversion heuristics (e.g. "50% of quoted work converts,
 *     so block out half their dates"). Too much guessing.
 *   - Holidays / personal time. Would have to go in the schedule
 *     manually as accepted-status jobs or 'reminder' items.
 *   - Multi-day-per-week work patterns. A schedule item on Tuesday
 *     blocks the whole Tuesday — we don't try to figure out part-days.
 */

import type { Job, ScheduleItem } from './types';

const MIN_WORKING_DAYS_FOR_GAP = 5;            // ≥1 working week to advertise
const LOOKAHEAD_DAYS = 180;                    // 6 months out — beyond that nobody cares
const OCCUPIED_JOB_STATUSES = new Set<Job['status']>(['accepted', 'booked', 'in-progress']);

export interface AvailabilityWindow {
  /** First free working day in this window (YYYY-MM-DD). */
  start: string;
  /**
   * Last free working day in this window (YYYY-MM-DD), or null if the
   * window extends past our lookahead horizon (so we're not pretending
   * to know what happens 7 months out).
   */
  end: string | null;
  /**
   * Working days inside the window (Mon-Fri count, weekends excluded).
   * Null when `end` is null — we don't have a confident count for a
   * window that runs off the end of our lookahead, and reporting "85
   * working days" when those days are just "everything until the
   * horizon" would mislead readers.
   */
  workingDays: number | null;
}

export interface AvailabilityReport {
  /** ISO date the calculation was anchored to. */
  todayISO: string;

  /** Is today itself a working day with no schedule items on it? */
  currentlyAvailable: boolean;

  /**
   * When the current job ends (last occupied date in the contiguous
   * stretch starting today/yesterday). Null if currentlyAvailable=true.
   */
  currentJobEnds: string | null;

  /**
   * Next stretch of free working days that's >= MIN_WORKING_DAYS_FOR_GAP.
   * If currentlyAvailable=true, this represents the current window
   * (since "now" itself is free).
   */
  nextWindow: AvailabilityWindow | null;

  /**
   * Subsequent occupied stretches the business is committed to —
   * useful for the banner to say "...then booked 6-12 July, then
   * free again." Includes the job's name for tooltip display.
   * Capped to the next 3 to keep the response small.
   */
  upcomingBookings: { start: string; end: string; jobName?: string }[];

  /**
   * Subsequent free windows after nextWindow. Capped to the next 2
   * so the banner has data for "free 15-30 June, then 14 July onwards"
   * style messaging without becoming overwhelming.
   */
  followingWindows: AvailabilityWindow[];

  /**
   * One-sentence natural-language summary suitable for direct display.
   * Always present; chooses the right phrasing based on the situation.
   */
  summary: string;
}

// ─── Date helpers ───────────────────────────────────────────────────────────

function parseISO(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}
function formatISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(iso: string, days: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return formatISO(d);
}
/** 0 = Sun, 1 = Mon, ..., 6 = Sat. Mon-Fri considered working. */
function isWorkingDay(iso: string): boolean {
  const dow = parseISO(iso).getDay();
  return dow >= 1 && dow <= 5;
}
function fmtPretty(iso: string): string {
  const d = parseISO(iso);
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'long' });
}

// ─── Core algorithm ──────────────────────────────────────────────────────────

export function computeAvailability(
  scheduleItems: ScheduleItem[],
  jobs: Job[],
  todayISO: string = formatISO(new Date()),
): AvailabilityReport {
  // Map jobs by id for quick status lookup.
  const jobById = new Map<string, Job>();
  for (const j of jobs) jobById.set(j.id, j);

  // Build the set of occupied dates within our lookahead window.
  // A date is occupied if any schedule_item on that date belongs to a
  // job with status in OCCUPIED_JOB_STATUSES.
  const horizonISO = addDays(todayISO, LOOKAHEAD_DAYS);
  const occupiedDates = new Set<string>();
  // Track which job blocked which date, so we can label upcoming bookings.
  const dateJobLabel = new Map<string, string>();
  for (const item of scheduleItems) {
    if (!item.jobId) continue;
    if (item.date < todayISO || item.date > horizonISO) continue;
    const job = jobById.get(item.jobId);
    if (!job || !OCCUPIED_JOB_STATUSES.has(job.status)) continue;
    occupiedDates.add(item.date);
    if (!dateJobLabel.has(item.date)) {
      dateJobLabel.set(item.date, job.name || job.clientName || '(booking)');
    }
  }

  // Walk forward day-by-day from today, classifying each date.
  // Build alternating runs of "occupied" and "free" working-day stretches.
  type Run = { kind: 'occupied' | 'free'; start: string; end: string; workingDays: number; jobLabel?: string };
  const runs: Run[] = [];
  let cursor = todayISO;
  const horizonExclusive = addDays(horizonISO, 1);

  while (cursor < horizonExclusive) {
    const occupied = occupiedDates.has(cursor);
    // Skip weekends entirely from run construction — they don't count
    // toward 'free' (you don't book a job for Saturday) but also don't
    // break an 'occupied' run (a job that runs Fri-Mon is one job).
    // Simplest correct treatment: weekends inherit the surrounding run.
    const isWorking = isWorkingDay(cursor);

    const lastRun = runs[runs.length - 1];
    const wantKind: Run['kind'] = occupied ? 'occupied' : 'free';

    if (!lastRun) {
      runs.push({
        kind: wantKind,
        start: cursor,
        end: cursor,
        workingDays: isWorking ? 1 : 0,
        jobLabel: occupied ? dateJobLabel.get(cursor) : undefined,
      });
    } else if (lastRun.kind === wantKind) {
      lastRun.end = cursor;
      if (isWorking) lastRun.workingDays += 1;
      if (occupied && !lastRun.jobLabel) lastRun.jobLabel = dateJobLabel.get(cursor);
    } else if (!isWorking) {
      // Weekend day with a different state than the prev working-day run.
      // Extend the previous run through the weekend rather than starting
      // a new free-window the moment Saturday lands. This matches the
      // intuition that "I'm booked Mon-Fri this week" doesn't suddenly
      // become "I'm available" on Saturday morning.
      lastRun.end = cursor;
    } else {
      runs.push({
        kind: wantKind,
        start: cursor,
        end: cursor,
        workingDays: 1,
        jobLabel: occupied ? dateJobLabel.get(cursor) : undefined,
      });
    }
    cursor = addDays(cursor, 1);
  }

  // ── Derive the report fields ──────────────────────────────────────────────
  const todayIsWorking = isWorkingDay(todayISO);
  const todayIsOccupied = occupiedDates.has(todayISO);
  const currentlyAvailable = todayIsWorking && !todayIsOccupied;

  // currentJobEnds = last day of the first 'occupied' run if it starts today.
  let currentJobEnds: string | null = null;
  if (todayIsOccupied && runs[0]?.kind === 'occupied') {
    currentJobEnds = runs[0].end;
  }

  // Find the next free window >= MIN_WORKING_DAYS_FOR_GAP working days.
  const freeWindows: AvailabilityWindow[] = runs
    .filter((r) => r.kind === 'free' && r.workingDays >= MIN_WORKING_DAYS_FOR_GAP)
    .map((r, i, all) => {
      // Last window that runs off the lookahead horizon — we don't have
      // confident bounds. Null both `end` and `workingDays` so readers
      // can't accidentally treat the horizon count as a real commitment.
      const isOpenEnded = i === all.length - 1 && r.end >= horizonISO;
      return {
        start: r.start,
        end: isOpenEnded ? null : r.end,
        workingDays: isOpenEnded ? null : r.workingDays,
      };
    });

  const nextWindow = freeWindows[0] ?? null;
  const followingWindows = freeWindows.slice(1, 3); // next 2

  // Upcoming bookings: occupied runs other than the current-job one.
  const upcomingBookings = runs
    .filter((r) => r.kind === 'occupied' && r.end > todayISO && r.start > todayISO)
    .slice(0, 3)
    .map((r) => ({ start: r.start, end: r.end, jobName: r.jobLabel }));

  // ── Compose summary sentence ─────────────────────────────────────────────
  let summary: string;
  if (currentlyAvailable) {
    if (upcomingBookings.length === 0) {
      summary = nextWindow
        ? `Available now — booking work from ${fmtPretty(nextWindow.start)}.`
        : 'Available now — get in touch.';
    } else {
      const firstBooking = upcomingBookings[0];
      summary = `Available now — next booked stretch is ${fmtPretty(firstBooking.start)} to ${fmtPretty(firstBooking.end)}.`;
    }
  } else if (currentJobEnds) {
    if (upcomingBookings.length === 0 && nextWindow) {
      summary = `Currently working — free from ${fmtPretty(nextWindow.start)}.`;
    } else if (upcomingBookings.length > 0 && nextWindow) {
      // The classic gap case: current ends, then a free window, then booked again.
      const gapDesc = nextWindow.workingDays != null
        ? `free from ${fmtPretty(nextWindow.start)} for ${nextWindow.workingDays} working days`
        : `free from ${fmtPretty(nextWindow.start)}`;
      summary = `Currently working — ${gapDesc}, then booked ${fmtPretty(upcomingBookings[0].start)}.`;
    } else {
      summary = `Currently working — ends ${fmtPretty(currentJobEnds)}.`;
    }
  } else {
    // Today's a non-working day or no schedule info available.
    summary = nextWindow
      ? `Next available: ${fmtPretty(nextWindow.start)}.`
      : 'Get in touch for availability.';
  }

  return {
    todayISO,
    currentlyAvailable,
    currentJobEnds,
    nextWindow,
    upcomingBookings,
    followingWindows,
    summary,
  };
}
