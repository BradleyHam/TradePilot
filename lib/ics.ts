// =============================================================
// .ics (iCalendar) file generator
// =============================================================
//
// Dependency-free RFC 5545 builder for one-off calendar events with
// built-in reminder alarms. The use case is "Brad books a site visit
// on the app → he taps Add to calendar → his phone's native calendar
// imports the event and handles the reminders". Native calendar
// reminders are loud, persistent, and survive airplane mode, which is
// why we picked this approach over web push for the v1.
//
// Why we hand-roll instead of npm install:
//
//   - The .ics format is small enough to write directly (~50 lines)
//     and stable enough that we don't need to track a library version.
//   - All the popular npm options drag in moment.js-flavoured baggage
//     for date math we don't need.
//   - Hand-rolling lets us be precise about CRLF line endings (Apple
//     Calendar is strict about this) and the UID format (which a
//     library would otherwise stamp with its own conventions).
//
// What's NOT in here, on purpose:
//
//   - Recurring events (RRULE). Site visits don't recur — they're
//     one-offs. If we ever need recurring reminders (e.g. provisional
//     tax instalments, GST returns), this is where they'd go.
//   - Timezone (VTIMEZONE block). We emit times in floating local
//     time (no Z suffix, no TZID) because Brad's events are always
//     in his local timezone and his phone interprets them correctly.
//     If we ever onboard a user in a different timezone from the
//     events they're scheduling (unusual for a NZ tradie), revisit.
//   - Attendees / organiser. The events are for Brad to see; nobody
//     is being invited to anything.

/**
 * Inputs needed to build a site-visit calendar invite. Fields map onto
 * the standard VEVENT properties: SUMMARY, DTSTART, DTEND, LOCATION,
 * DESCRIPTION, UID.
 */
export interface IcsEvent {
  /** Short title shown in the calendar event row. e.g. "Site visit — McLeod Ave". */
  title: string;
  /** Local-time start. ISO with date + time, or just date for an all-day event. */
  start: Date;
  /**
   * Local-time end. If omitted, defaults to start + 1 hour — matches the
   * "quick site visit" default we use on the schedule form too.
   */
  end?: Date;
  /** Optional location string. Most useful field for a site visit. */
  location?: string;
  /** Optional notes — surfaced as the event description. */
  description?: string;
  /**
   * Stable identifier. Use the schedule_item id when you have one so that
   * re-downloading the .ics updates the existing event rather than creating
   * a duplicate. Falls back to a random uuid.
   */
  uid?: string;
}

/**
 * Reminder offsets baked into every site-visit invite, in minutes before
 * the event start.
 *
 *   - 1440 min = 1 day before — the "you've got something tomorrow" nudge.
 *     Fires the night before by virtue of being 24h ahead of a 9am visit.
 *   - 60 min = 1 hour before — the "you're about to be late" nudge. Crucial
 *     when Brad's mid-paint on the current job and time-blind.
 *
 * Exported so the UI can describe what'll happen ("You'll be reminded 1 day
 * and 1 hour before").
 */
export const REMINDER_MINUTES_BEFORE = [1440, 60] as const;

/**
 * Build the .ics file body. Returns a string of VCALENDAR text with CRLF
 * line endings (RFC 5545 §3.1 requires CRLF, and Apple Calendar refuses
 * imports that use LF only — learned the hard way).
 *
 * The output is safe to wrap in a Blob with mime type 'text/calendar' and
 * trigger as a download, OR to data-URL into an href if you want a fully
 * in-browser flow.
 */
export function buildIcs(event: IcsEvent): string {
  const end = event.end ?? new Date(event.start.getTime() + 60 * 60 * 1000);
  const uid = event.uid ?? cryptoRandomUid();

  // DTSTAMP must reflect when the .ics was generated, not when the event
  // starts. Some calendar apps use DTSTAMP for "did this event change since
  // last import?" logic, so it's important this updates on every download.
  const now = new Date();

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    // PRODID identifies the software that produced the file. Convention is
    // -//<org>//<product>//<lang>. We use Lakeside Painting because this
    // build ships on the lakeside branch.
    'PRODID:-//Lakeside Painting//TradePilot//EN',
    // Useful for clients that distinguish METHOD (PUBLISH vs REQUEST).
    // PUBLISH = "here is an event, no response needed" which matches our
    // "add it to your own calendar" use case.
    'METHOD:PUBLISH',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeText(uid)}`,
    `DTSTAMP:${formatUtcStamp(now)}`,
    `DTSTART:${formatLocalStamp(event.start)}`,
    `DTEND:${formatLocalStamp(end)}`,
    `SUMMARY:${escapeText(event.title)}`,
  ];

  if (event.location) {
    lines.push(`LOCATION:${escapeText(event.location)}`);
  }
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  }

  // VALARM blocks — one per reminder offset. The order doesn't matter to
  // the spec but stable iteration keeps diffs clean if we ever inspect a
  // generated file by hand.
  for (const mins of REMINDER_MINUTES_BEFORE) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      // TRIGGER:-PT<n>M means "fire <n> minutes before DTSTART".
      // PT1440M and PT24H are equivalent but we use the minute form for
      // both so the format is uniform and grep-friendly.
      `TRIGGER:-PT${mins}M`,
      // DESCRIPTION on the alarm is what gets surfaced in the notification.
      `DESCRIPTION:${escapeText(humanReminderLabel(mins, event.title))}`,
      'END:VALARM',
    );
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  // Line folding (RFC 5545 §3.1) — any logical line longer than 75 octets
  // must be split onto multiple physical lines with a leading whitespace
  // continuation. Apple Calendar tolerates unfolded lines up to ~250 chars
  // but the spec is strict and other clients (Outlook) aren't forgiving.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/**
 * Trigger a download of the .ics file from the browser. Uses a transient
 * Blob URL — no server round-trip, no temporary file on disk.
 *
 * The filename matters: iOS/Apple Calendar uses it as the default event
 * title hint, so we slugify the event title for a useful filename instead
 * of a generic "invite.ics".
 */
export function downloadIcs(event: IcsEvent): void {
  const body = buildIcs(event);
  const blob = new Blob([body], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slugifyForFilename(event.title)}.ics`;
  // Append-click-remove is the most reliable cross-browser idiom for
  // programmatic downloads. Safari in particular ignores .click() on
  // elements that aren't in the DOM.
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Don't revoke immediately — Safari sometimes needs the URL alive for
  // a tick after the click handler returns. 1s is plenty.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Internals ─────────────────────────────────────────────────────────────

/**
 * Escape text content per RFC 5545 §3.3.11. Inside TEXT-typed properties
 * (SUMMARY, DESCRIPTION, LOCATION), the chars backslash, semicolon, comma,
 * and newline must be escaped. Forgetting this is the most common reason
 * an .ics file imports with a mangled title.
 */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/**
 * Format a Date as a floating local-time iCal stamp: YYYYMMDDTHHMMSS (no
 * Z, no TZID). Calendar clients interpret this as "whatever the user's
 * local time is on import" which is exactly what we want for a one-person
 * NZ business — site visits happen at the time on the clock, regardless
 * of whether NZ is in NZST or NZDT.
 */
function formatLocalStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${y}${m}${day}T${hh}${mm}${ss}`;
}

/**
 * UTC stamp form — used for DTSTAMP (the "when was this generated" field)
 * because DTSTAMP per RFC 5545 §3.8.7.2 is always in UTC.
 */
function formatUtcStamp(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}T${hh}${mm}${ss}Z`;
}

/**
 * Fold a single logical line per RFC 5545 §3.1: lines must be ≤75 octets
 * in length; longer lines are split with a CRLF + single whitespace
 * continuation. We count chars rather than octets because all our content
 * is ASCII (no multi-byte UTF-8) — good enough for the foreseeable use.
 */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let i = 0;
  // First chunk is up to 75 chars; subsequent chunks must be ≤74 because
  // we prepend a space (the continuation indicator counts toward the 75).
  chunks.push(line.slice(i, 75));
  i = 75;
  while (i < line.length) {
    chunks.push(' ' + line.slice(i, i + 74));
    i += 74;
  }
  return chunks.join('\r\n');
}

/**
 * UUID-ish stable id for events. crypto.randomUUID() is widely available
 * in modern browsers and Node 19+; we fall back to a timestamp+random
 * combo on the off-chance it isn't, so the function never throws.
 */
function cryptoRandomUid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${crypto.randomUUID()}@tradepilot`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}@tradepilot`;
}

/**
 * Human-readable reminder text — what the lock-screen notification will say.
 * Apple Calendar surfaces the VALARM DESCRIPTION as the alert body.
 */
function humanReminderLabel(minsBefore: number, title: string): string {
  if (minsBefore >= 1440) {
    const days = Math.round(minsBefore / 1440);
    return `${title} — tomorrow${days > 1 ? ` (in ${days} days)` : ''}`;
  }
  if (minsBefore >= 60) {
    const hours = Math.round(minsBefore / 60);
    return `${title} — in ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${title} — in ${minsBefore} minute${minsBefore === 1 ? '' : 's'}`;
}

/**
 * Filename-safe slug. Lower-case, ascii-only, dashes for spaces, drop
 * everything else. Phones and macOS Finder are happiest with this shape.
 */
function slugifyForFilename(s: string): string {
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'site-visit';
}
