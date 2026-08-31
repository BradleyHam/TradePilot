// Lakeside Painting's verified myIR GST calendar.
//
// Accounting basis: invoice (accruals)
// Filing frequency: six-monthly, periods ending 31 January and 31 July
//
// Keep period/date logic here so the estimator, Money UI, and push reminders
// can never drift onto different filing cycles.

export interface GstPeriod {
  /** ISO YYYY-MM-DD, inclusive. */
  start: string;
  /** ISO YYYY-MM-DD, inclusive. */
  end: string;
  /** Return and payment deadline, rolled off a weekend. */
  dueDate: string;
  label: string;
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseLocalDate(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T12:00:00`);
}

function rollWeekendForward(iso: string): string {
  const date = parseLocalDate(iso);
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
  return isoDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** Six-monthly GST period containing `date` (periods end Jan/Jul). */
export function gstPeriodOf(date: Date = new Date()): GstPeriod {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;

  if (month === 1) {
    return {
      start: isoDate(year - 1, 8, 1),
      end: isoDate(year, 1, 31),
      dueDate: rollWeekendForward(isoDate(year, 2, 28)),
      label: `Aug ${year - 1} – Jan ${year}`,
    };
  }

  if (month <= 7) {
    return {
      start: isoDate(year, 2, 1),
      end: isoDate(year, 7, 31),
      dueDate: rollWeekendForward(isoDate(year, 8, 28)),
      label: `Feb – Jul ${year}`,
    };
  }

  return {
    start: isoDate(year, 8, 1),
    end: isoDate(year + 1, 1, 31),
    dueDate: rollWeekendForward(isoDate(year + 1, 2, 28)),
    label: `Aug ${year} – Jan ${year + 1}`,
  };
}

/**
 * The latest period that has fully ended before `date`.
 *
 * On 31 July the Feb–Jul period is still open until the day finishes, so the
 * latest closed period remains Aug–Jan. On 1 August it becomes Feb–Jul.
 */
export function mostRecentlyClosedGstPeriod(date: Date = new Date()): GstPeriod {
  const current = gstPeriodOf(date);
  const dayBeforeCurrent = parseLocalDate(current.start);
  dayBeforeCurrent.setDate(dayBeforeCurrent.getDate() - 1);
  return gstPeriodOf(dayBeforeCurrent);
}
