/**
 * Shared date formatting helpers.
 *
 * Convention: dates are displayed with the DAY NAME as the lead, because
 * a tradie's mental model is "I was at job X on Thursday", not "I was at
 * job X on the 14th". Showing the weekday makes it trivial to scan an
 * entries list and notice "wait, I thought I was at Aubrey Road on
 * Thursday but there's no row there".
 *
 * Three exports for three different contexts:
 *
 *   formatEntryDate("2026-05-14")  → "Thu 14 May"   (current year)
 *                                  → "Thu 14 May 2025" (different year)
 *     For list rows where space is tight. Year is shown only when it
 *     differs from the current year, so the common case stays compact.
 *
 *   formatEntryDateLong("2026-05-14") → "Thursday 14 May 2026"
 *     For headings and subtitles where readability beats compactness.
 *
 *   formatRelativeOrDate("2026-05-14") → "Today" | "Yesterday" | "Thu 14 May"
 *     For the Home dashboard / activity log where recent dates are
 *     "today/yesterday" and older dates are formatEntryDate.
 *
 * All helpers:
 *   - Accept ISO YYYY-MM-DD strings (the on-disk format throughout the app)
 *   - Use en-NZ locale (matches the tax/currency conventions elsewhere)
 *   - Pass through unparseable input rather than crashing — legacy import
 *     dates occasionally come through as plain text
 */

const NZ = 'en-NZ';

/** Parse an ISO YYYY-MM-DD string into a Date at local midnight. */
function parse(iso: string): Date | null {
  if (!iso) return null;
  // Append T00:00:00 so the Date constructor doesn't interpret as UTC
  // and shift by the local offset. We always want "the day labelled X".
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Compact format with weekday lead: "Thu 14 May" (current year) or
 * "Thu 14 May 2025" (different year). For list rows and dense UIs.
 */
export function formatEntryDate(iso: string): string {
  const d = parse(iso);
  if (!d) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(NZ, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * Long format with full weekday: "Thursday 14 May 2026". For subtitles
 * and headings where readability matters more than width.
 */
export function formatEntryDateLong(iso: string): string {
  const d = parse(iso);
  if (!d) return iso;
  return d.toLocaleDateString(NZ, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * "Today" / "Yesterday" for the last two days, otherwise formatEntryDate.
 * Useful for activity logs where most rows are recent.
 */
export function formatRelativeOrDate(iso: string): string {
  const d = parse(iso);
  if (!d) return iso;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return formatEntryDate(iso);
}

/** Just the weekday: "Thu". For week-strip / day-column UIs. */
export function formatWeekdayShort(iso: string): string {
  const d = parse(iso);
  if (!d) return iso;
  return d.toLocaleDateString(NZ, { weekday: 'short' });
}
