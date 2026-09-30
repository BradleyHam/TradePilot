/**
 * Dated, progress-based earned-income calculations.
 *
 * This module is deliberately pure. It does not create income entries, alter
 * invoices, or feed GST / PAYE / income-tax calculations. It is a management
 * view of how much of an agreed job value has been completed.
 *
 * A saved snapshot freezes the actual person-hours, remaining person-hours,
 * agreed value and cumulative earned amount that were known on its as-of date.
 * Later hours consume that saved remaining-hours forecast one-for-one until a
 * newer snapshot replaces the forecast. Consequently, September work or a
 * September reforecast cannot rewrite August; an explicitly backdated August
 * snapshot can, because that is an intentional correction.
 */

import type {
  Entry,
  Job,
  JobProgressPerson,
  JobProgressSnapshot,
  JobProgressState,
  JobProgressValueSource,
} from './types';
import { localTodayISO } from './format-date';

const TERMINAL_EARNED_STATUSES: ReadonlyArray<Job['status']> = [
  'completed',
  'invoiced',
  'paid',
];

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const positive = (value: number | undefined): number =>
  value != null && Number.isFinite(value) && value > 0 ? value : 0;

/** The person-hours found in entries, with the retired helper field visible. */
export interface JobPersonHours {
  /** Hours held in the canonical `hours` column. */
  direct: number;
  /** Retired helperHours carried on historical owner entries. */
  legacyHelper: number;
  /** `direct + legacyHelper`: the actual labour consumed by the job. */
  total: number;
}

function addEntryHours(total: JobPersonHours, entry: Entry): void {
  total.direct += positive(entry.hours);
  total.legacyHelper += positive(entry.helperHours);
  total.total = total.direct + total.legacyHelper;
}

/**
 * Person-hours on a job up to and including an ISO date.
 *
 * Legacy helperHours are real second-person hours, so they are included in
 * progress even though new entry flows no longer write them. They remain
 * separate in the result so the UI can flag possible historical double-ups.
 */
export function jobPersonHours(
  entries: ReadonlyArray<Entry>,
  jobId: string,
  throughISO: string,
): JobPersonHours {
  const result: JobPersonHours = { direct: 0, legacyHelper: 0, total: 0 };
  for (const entry of entries) {
    if (entry.jobId !== jobId || entry.type !== 'hours') continue;
    if (entry.entryDate > throughISO) continue;
    addEntryHours(result, entry);
  }
  return {
    direct: round2(result.direct),
    legacyHelper: round2(result.legacyHelper),
    total: round2(result.total),
  };
}

/** Person-hours in `(afterExclusive, throughInclusive]`. */
export function jobPersonHoursBetween(
  entries: ReadonlyArray<Entry>,
  jobId: string,
  afterExclusive: string,
  throughInclusive: string,
): JobPersonHours {
  const result: JobPersonHours = { direct: 0, legacyHelper: 0, total: 0 };
  if (throughInclusive <= afterExclusive) return result;
  for (const entry of entries) {
    if (entry.jobId !== jobId || entry.type !== 'hours') continue;
    if (entry.entryDate <= afterExclusive || entry.entryDate > throughInclusive) continue;
    addEntryHours(result, entry);
  }
  return {
    direct: round2(result.direct),
    legacyHelper: round2(result.legacyHelper),
    total: round2(result.total),
  };
}

export interface JobValueSnapshot {
  amountExGst: number;
  source: JobProgressValueSource;
  /** False only when the figure is an early estimate or absent. */
  confident: boolean;
}

/**
 * The whole agreed job value, ex-GST.
 *
 * `invoiceAmount` is the job-level full work value, not the sum of payments.
 * Approved variations already raise quoteAmount / invoiceAmount atomically,
 * so callers must not add variation rows to this result a second time.
 */
export function jobValueSnapshot(job: Job): JobValueSnapshot {
  if (positive(job.invoiceAmount) > 0) {
    return { amountExGst: round2(positive(job.invoiceAmount)), source: 'invoice', confident: true };
  }
  if (positive(job.quoteAmount) > 0) {
    return { amountExGst: round2(positive(job.quoteAmount)), source: 'quote', confident: true };
  }
  if (positive(job.estimatedValue) > 0) {
    return { amountExGst: round2(positive(job.estimatedValue)), source: 'estimate', confident: false };
  }
  return { amountExGst: 0, source: 'none', confident: false };
}

export type ProgressPersonInput = Pick<JobProgressPerson, 'remainingHours'>;

/** The calculated fields persisted on a progress snapshot. */
export type ProgressSnapshotCalculation = Pick<
  JobProgressSnapshot,
  | 'jobId'
  | 'asOfDate'
  | 'state'
  | 'actualPersonHours'
  | 'legacyHelperHours'
  | 'remainingPersonHours'
  | 'forecastPersonHours'
  | 'jobValueExGst'
  | 'valueSource'
  | 'progressFraction'
  | 'earnedToDateExGst'
>;

export interface BuildProgressSnapshotInput {
  job: Job;
  entries: ReadonlyArray<Entry>;
  asOfDate: string;
  state: JobProgressState;
  people: ReadonlyArray<ProgressPersonInput>;
}

/**
 * Calculate the auditable values for a new snapshot.
 *
 * The named people only supply remaining person-hours here; identity and
 * category snapshots are persistence/UI concerns. Invalid negative or
 * non-finite hours are rejected instead of silently moving earned income.
 */
export function buildProgressSnapshot(
  input: BuildProgressSnapshotInput,
): ProgressSnapshotCalculation {
  const actual = jobPersonHours(input.entries, input.job.id, input.asOfDate);
  let remainingPersonHours = 0;
  for (const person of input.people) {
    if (!Number.isFinite(person.remainingHours) || person.remainingHours < 0) {
      throw new RangeError('Remaining person-hours must be a finite number at or above zero.');
    }
    remainingPersonHours += person.remainingHours;
  }
  remainingPersonHours = input.state === 'complete' ? 0 : round2(remainingPersonHours);

  const forecastPersonHours = round2(actual.total + remainingPersonHours);
  const progressFraction = input.state === 'complete'
    ? 1
    : forecastPersonHours > 0
      ? clamp01(actual.total / forecastPersonHours)
      : 0;
  const value = jobValueSnapshot(input.job);

  return {
    jobId: input.job.id,
    asOfDate: input.asOfDate,
    state: input.state,
    actualPersonHours: actual.total,
    legacyHelperHours: actual.legacyHelper,
    remainingPersonHours,
    forecastPersonHours,
    jobValueExGst: value.amountExGst,
    valueSource: value.source,
    progressFraction,
    earnedToDateExGst: round2(value.amountExGst * progressFraction),
  };
}

/**
 * Latest effective snapshot at a date. A later-created same-day row wins,
 * which makes corrections append-only while retaining the earlier audit row.
 */
export function latestProgressAt(
  snapshots: ReadonlyArray<JobProgressSnapshot>,
  jobId: string,
  asOfDate: string,
): JobProgressSnapshot | null {
  let latest: JobProgressSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.jobId !== jobId || snapshot.asOfDate > asOfDate) continue;
    if (
      latest == null
      || snapshot.asOfDate > latest.asOfDate
      || (
        snapshot.asOfDate === latest.asOfDate
        && (
          snapshot.createdAt > latest.createdAt
          || (snapshot.createdAt === latest.createdAt && snapshot.id > latest.id)
        )
      )
    ) {
      latest = snapshot;
    }
  }
  return latest;
}

export type EarnedPositionSource = 'snapshot' | 'terminal-status' | 'legacy-terminal' | 'none';

/** Cumulative progress-earned position at the end of an ISO date. */
export interface EarnedPosition {
  amountExGst: number;
  progressFraction: number;
  jobValueExGst: number;
  valueSource: JobProgressValueSource;
  source: EarnedPositionSource;
  /** Forecast snapshots remain estimates until a complete snapshot is saved. */
  isProvisional: boolean;
  /** An active job has hours/value but no remaining-work forecast yet. */
  missingForecast: boolean;
  snapshotId?: string;
}

function personHoursForEntry(entry: Entry): number {
  return positive(entry.hours) + positive(entry.helperHours);
}

/**
 * Compatibility path for jobs completed before progress snapshots existed.
 * It preserves the existing hours-by-month allocation shape, now correctly
 * treating legacy helperHours as person-hours as well.
 */
function legacyTerminalEarnedToDate(
  job: Job,
  entries: ReadonlyArray<Entry>,
  asOfDate: string,
  todayISO: string,
): EarnedPosition {
  const value = jobValueSnapshot(job);
  const jobHours = entries.filter((entry) =>
    entry.jobId === job.id
    && entry.type === 'hours'
    && personHoursForEntry(entry) > 0,
  );
  const totalHours = jobHours.reduce((sum, entry) => sum + personHoursForEntry(entry), 0);

  let progressFraction = 0;
  if (totalHours > 0) {
    // The former allocator worked in YYYY-MM buckets, not partial months.
    // Preserve that so existing completed-job monthly totals do not jump.
    const throughMonth = asOfDate.slice(0, 7);
    const recognisedHours = jobHours
      .filter((entry) => entry.entryDate.slice(0, 7) <= throughMonth)
      .reduce((sum, entry) => sum + personHoursForEntry(entry), 0);
    progressFraction = clamp01(recognisedHours / totalHours);
  } else {
    // Current allocation falls back to completion, then start, then "now".
    // Keep that exact legacy behaviour. `todayISO` is injected by callers so
    // tests and a whole multi-month calculation can pin one consistent day.
    const fallbackDate = job.endDate ?? job.startDate ?? todayISO;
    progressFraction = fallbackDate.slice(0, 7) <= asOfDate.slice(0, 7) ? 1 : 0;
  }

  return {
    amountExGst: round2(value.amountExGst * progressFraction),
    progressFraction,
    jobValueExGst: value.amountExGst,
    valueSource: value.source,
    source: 'legacy-terminal',
    isProvisional: false,
    missingForecast: false,
  };
}

export interface EarnedToDateInput {
  job: Job;
  entries: ReadonlyArray<Entry>;
  snapshots: ReadonlyArray<JobProgressSnapshot>;
  asOfDate: string;
  /** Pins the legacy no-hours/no-date fallback. Defaults to today. */
  todayISO?: string;
}

/**
 * Cumulative progress-earned value as of a date.
 *
 * Between snapshots, actual person-hours consume the latest snapshot's saved
 * remaining hours. A newer snapshot may create a positive or negative catch-up
 * on its as-of date; that adjustment belongs to that period and is not clamped.
 */
export function earnedToDateAt(input: EarnedToDateInput): EarnedPosition {
  const jobSnapshots = input.snapshots.filter((snapshot) => snapshot.jobId === input.job.id);
  const snapshot = latestProgressAt(jobSnapshots, input.job.id, input.asOfDate);
  const terminalDate = TERMINAL_EARNED_STATUSES.includes(input.job.status)
    ? (input.job.endDate ?? input.job.updatedAt.slice(0, 10))
    : null;

  // Once a forecasted job reaches a terminal status, recognise the residual
  // on its finish/status date. This keeps the saved August position intact
  // while preventing a skipped finish-date prompt from leaving the job at,
  // say, 73% forever. Legacy terminal jobs with no snapshots still use their
  // established hours-by-month allocator below.
  if (jobSnapshots.length > 0 && terminalDate && terminalDate <= input.asOfDate) {
    const currentValue = jobValueSnapshot(input.job);
    const value = currentValue.amountExGst > 0
      ? currentValue
      : snapshot
        ? {
            amountExGst: snapshot.jobValueExGst,
            source: snapshot.valueSource,
            confident: snapshot.valueSource === 'invoice' || snapshot.valueSource === 'quote',
          }
        : currentValue;
    return {
      amountExGst: value.amountExGst,
      progressFraction: 1,
      jobValueExGst: value.amountExGst,
      valueSource: value.source,
      source: 'terminal-status',
      isProvisional: false,
      missingForecast: false,
      snapshotId: snapshot?.id,
    };
  }

  if (snapshot) {
    const extra = snapshot.state === 'complete'
      ? 0
      : Math.max(
          0,
          round2(
            jobPersonHours(input.entries, input.job.id, input.asOfDate).total
            - snapshot.actualPersonHours,
          ),
        );

    let amountExGst = snapshot.earnedToDateExGst;
    let progressFraction = snapshot.progressFraction;
    if (snapshot.state === 'forecast' && snapshot.remainingPersonHours > 0 && extra > 0) {
      const consumed = Math.min(extra, snapshot.remainingPersonHours);
      const unearnedAtSnapshot = snapshot.jobValueExGst - snapshot.earnedToDateExGst;
      amountExGst += consumed * (unearnedAtSnapshot / snapshot.remainingPersonHours);
      if (snapshot.forecastPersonHours > 0) {
        progressFraction = clamp01(
          (snapshot.actualPersonHours + consumed) / snapshot.forecastPersonHours,
        );
      }
    }

    return {
      amountExGst: round2(Math.min(snapshot.jobValueExGst, Math.max(0, amountExGst))),
      progressFraction,
      jobValueExGst: snapshot.jobValueExGst,
      valueSource: snapshot.valueSource,
      source: 'snapshot',
      isProvisional: snapshot.state !== 'complete',
      missingForecast: false,
      snapshotId: snapshot.id,
    };
  }

  // Once a job has entered the snapshot system, do not fall back to the old
  // terminal allocator for dates before its first snapshot. Mixing the two
  // models would recognise the same job twice around the switchover.
  if (jobSnapshots.length === 0 && TERMINAL_EARNED_STATUSES.includes(input.job.status)) {
    return legacyTerminalEarnedToDate(
      input.job,
      input.entries,
      input.asOfDate,
      input.todayISO ?? localTodayISO(),
    );
  }

  const value = jobValueSnapshot(input.job);
  return {
    amountExGst: 0,
    progressFraction: 0,
    jobValueExGst: value.amountExGst,
    valueSource: value.source,
    source: 'none',
    isProvisional: input.job.status === 'in-progress',
    missingForecast: input.job.status === 'in-progress',
  };
}

function addIsoDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface EarnedDeltaInput {
  job: Job;
  entries: ReadonlyArray<Entry>;
  snapshots: ReadonlyArray<JobProgressSnapshot>;
  startISO: string;
  endISO: string;
  /** Pins the legacy no-hours/no-date fallback. Defaults to today. */
  todayISO?: string;
}

/** Earned movement inside `[startISO, endISO]`, including negative catch-ups. */
export function earnedDeltaInWindow(input: EarnedDeltaInput): number {
  if (input.endISO < input.startISO) {
    throw new RangeError('Earned-income window end must be on or after its start.');
  }
  // Resolve once so a calculation straddling midnight cannot use two dates.
  const todayISO = input.todayISO ?? localTodayISO();
  const opening = earnedToDateAt({
    job: input.job,
    entries: input.entries,
    snapshots: input.snapshots,
    asOfDate: addIsoDays(input.startISO, -1),
    todayISO,
  });
  const closing = earnedToDateAt({
    job: input.job,
    entries: input.entries,
    snapshots: input.snapshots,
    asOfDate: input.endISO,
    todayISO,
  });
  return round2(closing.amountExGst - opening.amountExGst);
}

export interface EarnedBusinessWindowInput {
  jobs: ReadonlyArray<Job>;
  entries: ReadonlyArray<Entry>;
  snapshots: ReadonlyArray<JobProgressSnapshot>;
  startISO: string;
  endISO: string;
  /** Pins the legacy no-hours/no-date fallback. Defaults to today. */
  todayISO?: string;
}

/** Business-wide progress-earned income. Management reporting only. */
export function earnedIncomeInWindowFromProgress(input: EarnedBusinessWindowInput): number {
  const todayISO = input.todayISO ?? localTodayISO();
  return round2(input.jobs.reduce((sum, job) => sum + earnedDeltaInWindow({
    job,
    entries: input.entries,
    snapshots: input.snapshots,
    startISO: input.startISO,
    endISO: input.endISO,
    todayISO,
  }), 0));
}

function monthBounds(month: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new RangeError(`Invalid YYYY-MM month: ${month}`);
  const [year, monthNumber] = month.split('-').map(Number);
  if (monthNumber < 1 || monthNumber > 12) throw new RangeError(`Invalid YYYY-MM month: ${month}`);
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(last).padStart(2, '0')}`,
  };
}

/** One exact progress-earned delta per requested YYYY-MM key. */
export function earnedIncomeByMonthFromProgress(
  jobs: ReadonlyArray<Job>,
  entries: ReadonlyArray<Entry>,
  snapshots: ReadonlyArray<JobProgressSnapshot>,
  monthsAsc: ReadonlyArray<string>,
  todayISO = localTodayISO(),
): Map<string, number> {
  const result = new Map<string, number>();
  for (const month of monthsAsc) {
    const bounds = monthBounds(month);
    result.set(month, earnedIncomeInWindowFromProgress({
      jobs,
      entries,
      snapshots,
      startISO: bounds.start,
      endISO: bounds.end,
      todayISO,
    }));
  }
  return result;
}
