/**
 * Booking-block arithmetic — the bits of "a job is booked for 6 days"
 * that have to be right, kept out of the schedule page so they can be
 * reasoned about (and tested) on their own.
 *
 * A "block" is one job's run of job_booking days sharing a title. Days
 * marked "didn't work" stay in the block as rows but are out of the
 * sequence: they don't show on the calendar, they don't get a day
 * number, and they don't define which weekdays the block works.
 */

/** Local-time ISO parse. Never `new Date(iso)` — that's UTC and drifts a day. */
function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}
function formatISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDaysISO(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return formatISODate(d);
}

export interface BlockDay {
  date: string;
  /** Marked "didn't work" — still a row, but out of the sequence. */
  skipped: boolean;
}

/** Mon–Sat: the working week the booking editor defaults to. 0 = Sunday. */
const DEFAULT_WORKING_DAYS = new Set([1, 2, 3, 4, 5, 6]);
/**
 * How many distinct weekdays a block needs before its own shape is
 * treated as a pattern. Below this it's just a short run — three
 * consecutive days say nothing about whether Thursday is a work day, and
 * reading a pattern into them pushes the make-up day a week out.
 */
const PATTERN_CONFIDENCE = 4;

/**
 * Where a make-up day goes: the first date after the block's last day
 * that the block isn't already using and that falls on a working day.
 *
 * A block spanning enough distinct weekdays defines its own working days
 * — a Mon–Fri crew gets Monday, not Saturday. A short block falls back to
 * Mon–Sat, because three days in a row tell you nothing about the shape
 * of the week. Skipped days still count towards the pattern: the day was
 * a work day when it was booked, rain doesn't change that.
 *
 * The answer is always shown to the user before anything is created, so a
 * wrong guess costs one tap, not a misplaced booking.
 */
export function makeUpDate(block: BlockDay[], fallbackFrom: string): string {
  const used = new Set(block.map((b) => b.date));
  const blockWeekdays = new Set(block.map((b) => parseISODate(b.date).getDay()));
  const weekdays = blockWeekdays.size >= PATTERN_CONFIDENCE ? blockWeekdays : DEFAULT_WORKING_DAYS;
  const lastDate = block.reduce((max, b) => (b.date > max ? b.date : max), fallbackFrom);
  let cursor = lastDate;
  // 14 hops clears a weekend plus any days already booked on this block.
  for (let i = 0; i < 14; i++) {
    cursor = addDaysISO(cursor, 1);
    if (used.has(cursor)) continue;
    if (!weekdays.has(parseISODate(cursor).getDay())) continue;
    return cursor;
  }
  return addDaysISO(lastDate, 1);
}

export interface TitledBlockDay extends BlockDay {
  id: string;
  title: string;
}

/**
 * Rebuild the "(Day N/M)" suffixes so they count only the days still
 * standing, in date order. Skipped days aren't numbered — a day that
 * never happened isn't "Day 3 of 6". A block down to a single day loses
 * the suffix entirely.
 *
 * Returns only the rows whose title actually changes, so the caller can
 * fire the minimum number of writes.
 */
export function renumberedTitles(
  block: TitledBlockDay[],
  base: string,
): { id: string; title: string }[] {
  const live = block
    .filter((b) => !b.skipped)
    .sort((a, b) => a.date.localeCompare(b.date));
  const changes: { id: string; title: string }[] = [];
  live.forEach((b, i) => {
    const next = live.length > 1 ? `${base} (Day ${i + 1}/${live.length})` : base;
    if (next !== b.title) changes.push({ id: b.id, title: next });
  });
  // A skipped day keeps its row but loses its number.
  for (const b of block) {
    if (b.skipped && b.title !== base) changes.push({ id: b.id, title: base });
  }
  return changes;
}
