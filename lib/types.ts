export type JobStatus =
  | 'lead'
  | 'quoted'
  | 'accepted'
  | 'booked'
  | 'in-progress'
  | 'completed'
  | 'invoiced'
  | 'paid'
  // The two ways a job ends without work. Kept apart on purpose:
  //   'lost'     — we wanted it and didn't get it (outbid, ghosted,
  //                project cancelled). Counts against the win rate.
  //   'declined' — WE said no (out of area, wrong fit, too small, too
  //                busy). Never a contest, so it counts neither way.
  // Conflating them made the conversion rate punish good decisions.
  // See migration 040; 'declined' also replaced the old "park" flow.
  | 'lost'
  | 'declined';

/**
 * Sentinel `snoozeUntil` meaning "waiting on them — no known date".
 *
 * The case this exists for: Brad quotes a building company that is itself
 * tendering for the main contract. Nobody has beaten him (not `lost`), he
 * hasn't said no (not `declined`), and the quote is genuinely live — if the
 * builder wins, Brad probably gets the work, and that has to be able to
 * count as a WIN. But there's nothing to chase in the meantime, and the
 * follow-up ladder nagging him weekly about it is just noise.
 *
 * Implemented as a far-future date rather than a new column so every
 * existing filter, sort and mapper keeps working untouched — `isSnoozed`
 * is already "is snoozeUntil in the future", and sorting by wake-date puts
 * these last, which is exactly right. Only the display needs to special-case
 * it, via `isWaitingIndefinitely` below. Never render this date raw.
 */
export const SNOOZE_INDEFINITE = '9999-12-31';

/** True when a job is snoozed with no known wake date — see SNOOZE_INDEFINITE. */
export function isWaitingIndefinitely(job: Pick<Job, 'snoozeUntil'>): boolean {
  return job.snoozeUntil === SNOOZE_INDEFINITE;
}

export type EntryType =
  | 'expense'
  | 'income'
  | 'hours'
  | 'enquiry'
  | 'quote'
  | 'bill'
  | 'note';

export type ExpenseCategory =
  | 'labour'
  | 'paint'
  | 'materials'
  | 'tools'
  | 'fuel'
  | 'vehicle'
  | 'admin'
  | 'software'
  | 'marketing'
  | 'subcontractor'
  | 'other';

export type ActivityType =
  // On site.
  | 'prep'
  | 'painting'
  | 'staining'
  | 'wallpapering'
  | 'stopping'
  | 'primer'
  | 'repair'
  | 'cleanup'
  | 'travel'
  // Off site / office. These are paid work with no job attached, so an
  // entry carrying one of these usually has `jobId` undefined (the same
  // overhead shape as Brad's `[OH]` entries). Kept in sync with the
  // `entries_activity_check` constraint — see migration 038.
  | 'quoting'
  | 'admin'
  | 'website'
  | 'marketing'
  | 'training';

/**
 * Activities that happen away from a job site. The employee hours screen
 * makes the job optional when only these are selected, and RLS permits a
 * null `job_id` to match (migration 038).
 */
export const OFFSITE_ACTIVITIES: ActivityType[] = [
  'quoting', 'admin', 'website', 'marketing', 'training',
];

export function isOffsiteActivity(a: ActivityType): boolean {
  return OFFSITE_ACTIVITIES.includes(a);
}

/**
 * Who did the work for a logged-hours entry. Drives the blended-target
 * hourly rate on the job's gauge — each tier has its own target rate
 * pulled from the per-business settings table (worker_rate_owner,
 * worker_rate_helper, etc).
 *
 * - `owner`        — Brad himself. Default for all logged hours. The
 *                    fully-loaded PD rate sits here (~$90/hr 2026).
 * - `experienced`  — Trade-qualified second pair of hands. Subbie or
 *                    casual painter at full rate.
 * - `apprentice`   — 2nd-year+ with some skill, supervised. Lower target
 *                    because productivity is lower while learning.
 * - `helper`       — Inexperienced labourer. Prep, sanding, masking,
 *                    cleanup. Brad's partner Suzie sits here.
 * - `subcontractor`— Paid per-job, not per-hour, but we still log time
 *                    so the job's hours math is honest. Charge-out rate
 *                    typically 60-70% of owner rate.
 */
export type WorkerKind =
  | 'owner'
  | 'experienced'
  | 'apprentice'
  | 'helper'
  | 'subcontractor';

/** Settings keys for the per-tier target hourly rates. Stored as strings
 *  in `settings.value`, parsed at read-time. PD-anchored defaults live
 *  in `lib/worker-rates.ts`. */
export const WORKER_RATE_SETTING_KEYS: Record<WorkerKind, string> = {
  owner:         'worker_rate_owner',
  experienced:   'worker_rate_experienced',
  apprentice:    'worker_rate_apprentice',
  helper:        'worker_rate_helper',
  subcontractor: 'worker_rate_subcontractor',
};

/**
 * A person's role within a business. Drives what they can see and do.
 * - `owner`    — full access (Brad). Sees money, tax, everything; can add
 *                employees.
 * - `employee` — money-blind. Logs their own hours to jobs, sees their
 *                schedule + job details minus any financials. Enforced at
 *                the database (RLS), not just hidden in the UI.
 */
export type MemberRole = 'owner' | 'employee';

/**
 * Links a signed-in auth user to a business with a role. One row per
 * (business, user). The owner is backfilled from `businesses.owner_id`;
 * employees are added later (Supabase dashboard for now, in-app screen
 * once Phase 4 ships).
 */
export interface BusinessMember {
  id: string;
  businessId: string;
  userId: string;
  role: MemberRole;
  /** Friendly name shown in the team list + attributed on their hours. */
  displayName?: string;
  /** Which worker tier this person's logged hours default to (e.g. Suzie = 'helper'). */
  workerKind?: WorkerKind;
  createdAt: string;
}

/**
 * "This person is on this job." Job-level assignment (migration 035).
 * Drives which jobs an employee sees + can log hours against. Per-day
 * exceptions live in ScheduleAssignment.
 */
export interface JobAssignment {
  id: string;
  businessId: string;
  jobId: string;
  /** Auth uid of the assigned member (matches BusinessMember.userId). */
  userId: string;
  createdAt: string;
}

/**
 * Per-BOOKING override of the job-level assignment: if a booking has ANY
 * of these rows, exactly those people are on it that day; if none, the
 * job-level assignees are. Matches the DB-side semantics in
 * `user_assigned_to_booking()` (migration 035).
 */
export interface ScheduleAssignment {
  id: string;
  businessId: string;
  scheduleItemId: string;
  userId: string;
  createdAt: string;
}

/**
 * Which way a contact went. 'out' = Brad reached out; 'in' = the customer
 * came back to him. The gap between an 'out' and the next 'in' on a job is
 * the response time, which is the whole reason direction is recorded.
 */
export type ContactDirection = 'out' | 'in';

/**
 * How the contact happened. App-side vocabulary — the DB column is plain
 * text with no check constraint, so adding a channel here needs no
 * migration. 'quote-sent' is a channel rather than a separate concept
 * because sending a quote IS a contact, and the follow-up clock should
 * treat it as one.
 *
 * 'unknown' is for rows we genuinely can't classify — chiefly the ones
 * backfilled from the old single `lastContactedDate`. It exists so grouped
 * reports never have a nameless bucket.
 */
export type ContactChannel =
  | 'phone' | 'email' | 'text' | 'visit' | 'quote-sent' | 'other' | 'unknown';

export const CONTACT_CHANNEL_LABELS: Record<ContactChannel, string> = {
  phone: 'Called',
  email: 'Emailed',
  text: 'Texted',
  visit: 'Visited',
  'quote-sent': 'Quote sent',
  other: 'Contacted',
  unknown: 'Contacted',
};

/**
 * One contact with a customer about a job, in either direction (migration
 * 042). Append-only in practice: rows are inserted, never edited.
 *
 * This is the history that `jobs.lastContactedDate` used to destroy on every
 * write. That column still exists and is still what the chase-list and the
 * follow-up ladder read — the store keeps it in sync as a cache of the newest
 * row here. If the two ever disagree, this table is the truth.
 */
export interface JobContact {
  id: string;
  businessId: string;
  jobId: string;
  /**
   * When the contact actually happened — NOT when the row was written.
   * The quote catch-up flow backdates, so these genuinely differ.
   */
  contactedAt: string;
  direction: ContactDirection;
  channel: ContactChannel;
  /** Optional free text. Never required — logging must stay one tap. */
  note?: string;
  /** Auth uid of whoever logged it. */
  loggedBy?: string;
  createdAt: string;
}

/**
 * A photo taken on a shift, logged by whoever worked it (usually an
 * employee). Tied to a job + date rather than strictly to an hours entry,
 * so the capture flow doesn't depend on the optimistic entry insert
 * resolving first. Stored in the private `shift-photos` bucket.
 */
export interface ShiftPhoto {
  id: string;
  businessId: string;
  jobId?: string;
  /** Optional link to the hours entry it was logged alongside. */
  entryId?: string;
  /** Auth uid of whoever uploaded it. */
  uploadedBy?: string;
  /** The shift date the photo belongs to. */
  takenOn: string;
  /** Object path inside the `shift-photos` bucket (NOT a URL — signed on demand). */
  storagePath: string;
  caption?: string;
  createdAt: string;
}

/**
 * One wage payment to an employee for one pay period (fortnightly for
 * Suzie). Rows are created only when the period is marked PAID — pending
 * periods are computed on the fly from the cycle anchor in lib/payroll.ts.
 *
 * The gross wage is the deductible expense (s DA 1) and lands in the books
 * via the linked `entries` expense row (`expenseEntryId`, category
 * 'labour', no GST — wages are outside the GST net). The PAYE remittance
 * to IRD is NOT a second expense — it reconciles as a bank transaction
 * with status='tax', taxKind='paye'.
 *
 * Two IRD follow-ups hang off every pay run:
 *   - `eiFiled`  — payday employment information filed in myIR (due
 *                  within 2 working days of the pay day).
 *   - `payePaid` — PAYE for the month containing paidDate remitted
 *                  (small-employer schedule: due the 20th of the
 *                  following month).
 */
export interface PayRun {
  id: string;
  businessId: string;
  memberId?: string;
  /** Denormalised so wage history survives a membership being revoked. */
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  /** Hours snapshot the gross was computed from (own + helper) — the IRD "pay matches timesheets" evidence trail. */
  hours?: number;
  rate?: number;
  gross: number;
  /** From the IRD PAYE calculator — optional, drives the monthly PAYE reminder figure. */
  paye?: number;
  net?: number;
  paid: boolean;
  paidDate?: string;
  eiFiled: boolean;
  payePaid: boolean;
  expenseEntryId?: string;
  notes?: string;
  createdAt: string;
}

export type QuoteStatus =
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'superseded';

export type ProductType =
  | 'paint'
  | 'primer'
  | 'stain'
  | 'filler'
  | 'tape'
  | 'sandpaper'
  | 'brush'
  | 'roller'
  | 'drop_sheet'
  | 'caulk'
  | 'wallpaper'
  | 'other';

export type Finish =
  | 'matte'
  | 'flat'
  | 'low_sheen'
  | 'satin'
  | 'semi_gloss'
  | 'gloss'
  | 'eggshell';

export type Unit =
  | 'litres'
  | 'rolls'
  | 'sheets'
  | 'each'
  | 'metres'
  | 'kg';

export type ScheduleItemType =
  | 'job_booking'
  | 'quote_visit'
  | 'follow_up'
  | 'bill_due'
  | 'invoice_due'
  | 'reminder';

/**
 * Where a lead/job originally came from. Free-form (not a check constraint
 * in the DB) so we can add new channels without a migration.
 */
export type LeadSource = 'website' | 'email' | 'phone' | 'referral' | 'gmb' | 'manual';

/**
 * Type of work being quoted.
 *
 * `mixed` is no longer selectable — since migration 034 a job carries a
 * SET of types (`Job.workTypes`) and `mixed` is simply what the derived
 * single-value summary (`Job.workType`) says when there's more than one.
 * It stays in the union because legacy rows still hold it and every
 * one-bucket grouping in the app still needs somewhere to put them.
 */
export type WorkType =
  | 'interior'
  | 'exterior'
  | 'cedar'
  | 'wallpaper'
  | 'roof'
  | 'mixed';

/** The types a user can actually tag. `mixed` is derived, never picked. */
export const SELECTABLE_WORK_TYPES: WorkType[] = [
  'interior',
  'exterior',
  'cedar',
  'wallpaper',
  'roof',
];

/** Display labels, so the chip rows across the app can't drift apart. */
export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  interior: 'Interior',
  exterior: 'Exterior',
  cedar: 'Cedar',
  wallpaper: 'Wallpaper',
  roof: 'Roof',
  mixed: 'Mixed',
};

/**
 * Collapse a set of work types into the single-value summary stored on
 * `Job.workType`. One type → that type; several → 'mixed'; none →
 * undefined. Keeps every existing single-value reader (leads filter,
 * insights, marketing service mapper, quote drafter) working unchanged.
 */
export function deriveWorkType(types: WorkType[] | undefined): WorkType | undefined {
  if (!types || types.length === 0) return undefined;
  if (types.length === 1) return types[0];
  return 'mixed';
}

/**
 * The types a job covers, as a set — for jobs saved before migration 034
 * this falls back to the singular field so callers never have to handle
 * "array missing" themselves. A legacy `mixed` row yields `['mixed']`,
 * which is honest: we don't know what it was mixed OF.
 */
export function jobWorkTypes(job: Pick<Job, 'workType' | 'workTypes'>): WorkType[] {
  if (job.workTypes && job.workTypes.length > 0) return job.workTypes;
  return job.workType ? [job.workType] : [];
}

/**
 * Does this job match a single-type filter? True when the type is in the
 * job's set — so an interior+exterior job answers yes to BOTH 'interior'
 * and 'exterior' rather than hiding under 'mixed'. Legacy 'mixed' rows
 * still match a 'mixed' filter.
 */
export function jobHasWorkType(
  job: Pick<Job, 'workType' | 'workTypes'>,
  type: WorkType,
): boolean {
  return jobWorkTypes(job).includes(type);
}

/**
 * Loose categorisation of how much prep the job needs. Used to compare
 * "$/m²" between jobs apples-to-apples — a heavy-prep exterior costs more
 * per m² than a light-prep one, and we want the data to reflect that.
 */
export type PrepLevel = 'light' | 'medium' | 'heavy' | 'full-strip';

/** Why a quoted/accepted job didn't convert. Set when status moves to 'lost'. */
export type LostReason =
  | 'price'
  | 'no-reply'
  | 'went-elsewhere'
  | 'scope-changed'
  | 'project-cancelled'
  | 'timing'
  // LEGACY (pre-040). These two meant "Brad turned it down", squeezed into
  // the loss enum back when 'lost' was the only terminal non-win status.
  // That's now `status = 'declined'` + `declineReason`, so these are no
  // longer offered in the picker — kept in the union only so historical
  // rows still typecheck and render. Don't set them on new jobs.
  | 'too-far'      // outside the service area (e.g. Queenstown)
  | 'wrong-fit'    // not our kind of work (e.g. new builds)
  | 'other';

/** Why a quote landed. Set when status moves to 'accepted'. */
export type WonReason =
  | 'referral'
  | 'returning-client'
  | 'price'
  | 'trust-rapport'
  | 'speed-of-response'
  | 'unique-fit'
  | 'other';

export interface Job {
  id: string;
  businessId: string;
  legacyId?: string;
  name: string;
  clientName: string;
  clientEmail?: string;
  clientPhone?: string;
  location?: string;
  status: JobStatus;
  estimatedValue?: number;
  quoteAmount?: number;
  invoiceAmount?: number;
  startDate?: string;
  endDate?: string;
  followUpDate?: string;
  /**
   * The date the lead/enquiry actually came in (YYYY-MM-DD), as opposed to
   * `createdAt` which is when the row was created in the app. They diverge
   * badly for imported jobs (a whole backlog shares one import date), which
   * made the Leads "leads per week" chart spike on the import day. The Leads
   * insights bucket by `leadDate ?? createdAt`, and it's editable per job.
   */
  leadDate?: string;
  /**
   * Last time Brad actively touched this lead/client — sent a message,
   * picked up the phone, sent the quote, replied to a question. Used by
   * the Leads chase-list to surface stale leads ("9 days since you last
   * heard from Sarah"). Bumped by the "Mark contacted" button on the
   * leads page and auto-set when a quote is sent. Null on legacy rows
   * and on rows that have never been touched since creation — the UI
   * falls back to createdAt in that case so the badge still reads sensibly.
   */
  lastContactedDate?: string;
  notes?: string;
  /**
   * The job's main image — an object path in the **shift-photos** bucket
   * (never a URL; signed on demand). That bucket is deliberate: employees
   * can read it, whereas `quote-attachments` is owner-only because it
   * holds priced quote PDFs. Setting a cover COPIES the chosen image into
   * shift-photos (see store.setJobCoverPhoto).
   *
   * Null means "no explicit pick" — the UI falls back to the newest shift
   * photo on the job, so most jobs get a thumbnail with zero effort.
   * Use `jobCoverPath(job, shiftPhotos)` rather than reading this raw.
   */
  coverPhotoPath?: string;
  /**
   * The ORIGINAL object path the cover was pinned from, when it came from
   * a bucket employees can't read (quote-attachments) and had to be
   * copied. Purely so the UI can star the right thumbnail — the copy's
   * path bears no resemblance to the source's. Equal to `coverPhotoPath`
   * when the source was already in shift-photos.
   */
  coverPhotoSource?: string;
  /**
   * Plain-language scope for whoever is ON SITE — what this job includes
   * and what it explicitly doesn't. Visible to employees (it's in
   * `jobs_public`), so it must never carry prices: the extractor strips
   * money and Brad reviews before saving. Usually populated by pulling
   * the quote PDF apart, but freely editable.
   */
  scopeIncluded?: string[];
  scopeExcluded?: string[];
  /** How the lead came in. Null for legacy/imported rows. */
  source?: LeadSource;
  /** What kind of work — drives like-with-like comparisons. */
  /**
   * Single-value summary of the job's work type — DERIVED from
   * `workTypes` (one type → that type, several → 'mixed'). Written by
   * every save path so one-bucket groupers can keep reading it. Don't
   * set it directly; set `workTypes` and let `deriveWorkType` do it.
   */
  workType?: WorkType;
  /**
   * Every type of work the job involves. A renovation can be interior
   * AND exterior; forcing that into one bucket ('mixed') threw away the
   * detail that makes benchmarks and past-job comparisons useful.
   * Undefined on rows saved before migration 034 — use `jobWorkTypes()`
   * rather than reading this directly.
   */
  workTypes?: WorkType[];
  /** Approximate quoted surface area in m². Used for $/m² benchmarks. */
  surfaceAreaM2?: number;
  /** Subjective sense of how much prep this job needs. */
  prepLevel?: PrepLevel;
  /**
   * Free-form scope notes captured at the site visit, in Brad's words.
   * Distinct from `notes` (which is general-purpose) — this is specifically
   * the "I walked the property and saw…" capture from the wrap-up sheet.
   * Feeds Tier-2 quote drafting later.
   */
  scopeNotes?: string;
  /**
   * Site-access chip values captured at the wrap-up. Drives whether Brad
   * needs scaffold, a cherry-picker, or just a ladder — and reminds him
   * to mention these in the quote. Free-form strings so the chip
   * vocabulary can evolve without a migration.
   *
   * Example: ['ladder-ok', 'second-storey', 'tight-driveway']
   */
  accessNotes?: string[];
  /**
   * Date Brad promised the customer the quote by. Drives a "quote owed"
   * surface on Home — the bridge between "site visit done" and "quote
   * actually sent". Nullable; only meaningful while status is lead/quoted.
   */
  quoteReadyBy?: string;
  /**
   * Coats to apply — 1 / 2 / 3 typically. After area, the single biggest
   * lever on materials cost AND labour (each extra coat is ~1 extra day
   * for a 100m² job once drying time is factored in).
   */
  coatsCount?: number;
  /**
   * Stain / paint product brand+name. Free text so Brad can write what
   * he actually uses ('Wood-X mid stain', 'Cedarshield natural', 'Resene
   * Woodsman cedar'). Drives materials cost AND recommended coat count.
   */
  stainProduct?: string;
  /**
   * Rough count of windows + doors in the cedar area. Used to estimate
   * cutting-in time (every window means ~10 minutes of slow careful
   * brush work). 0 is valid (a fully-clad shed has none).
   */
  windowDoorCount?: number;
  /**
   * Additional items the quote covers beyond the main cedar walls.
   * Multi-select chip values: 'soffits', 'decking', 'handrails',
   * 'pergola', 'gates', 'window-frames', 'fascia', 'garage-doors',
   * 'pergola-posts'. Free-form strings so the vocabulary evolves
   * without a migration. Stored as text[].
   */
  addonItems?: string[];
  /**
   * Site logistics chips — practical realities that affect job setup
   * time and tool/material selection. Examples: 'off-street-parking',
   * 'water-available', 'power-for-sander', 'pets-to-manage',
   * 'tenanted', 'children-on-site', 'restricted-hours'. Multi-select.
   */
  siteLogistics?: string[];
  /**
   * Brad's gut estimate of the job duration in WORKING days (decimal
   * allowed for half-days) — days actually on the tools with the crew
   * in `crewSize`, not calendar days. Weather padding does NOT belong
   * here; rain risk is a quote-timeline caveat, not a labour input.
   * Sanity-checked against area+prep math by the AI — if they disagree
   * by >30% something's worth a second look.
   */
  daysEstimate?: number;
  /**
   * How many people on the tools for `daysEstimate` — 3 days solo and
   * 3 days as a pair are the same daysEstimate but double the labour.
   * daysEstimate × crewSize = person-days, which is what actually
   * prices the job. 1 = Brad solo (the usual). Optional: legacy rows
   * and quick wrap-ups won't have it; treat missing as "probably 1,
   * unverified".
   */
  crewSize?: number;
  /**
   * Soft commercial factors that move the quote price ±15% without
   * changing the cost basis. Examples: 'referral', 'repeat-customer',
   * 'price-shopping', 'urgent', 'mentioned-budget', 'first-impression-strong',
   * 'decision-maker-present', 'not-a-rush'. Drives the AI's suggested
   * price range vs. its calculated cost. Multi-select chips.
   */
  commercialSignals?: string[];
  /** Set when status = 'lost'. Mutually exclusive with wonReason. */
  lostReason?: LostReason;
  /** Set when status = 'accepted'. Mutually exclusive with lostReason. */
  wonReason?: WonReason;
  /**
   * ISO timestamp of when the job FIRST moved to `status = 'accepted'`
   * (migration 041). Write-once: the store stamps it on the transition and
   * never touches it again, so it survives every later edit — which is
   * exactly what `updatedAt` cannot do, since the jobs_updated_at trigger
   * rewrites that on any change.
   *
   * Paired with the quote's `dateSent` it gives time-to-decision. Rows
   * backfilled by 041 carry an approximate value derived from `updatedAt`.
   */
  acceptedAt?: string;
  /** Free-text colour on the win/loss reason. Optional. */
  outcomeNotes?: string;
  /**
   * ISO timestamp of when Brad turned this job down. Always set alongside
   * `status = 'declined'` (migration 040 renamed this from `dismissedAt`,
   * which powered the old "park" flow). Carries the date the decision was
   * made, which `updatedAt` can't — any later edit would overwrite it.
   */
  declinedAt?: string;
  /**
   * The preset reasons picked when turning the job down. MULTI-SELECT —
   * a job is often declined for more than one reason at once ("out of
   * area" *and* "too busy"), and forcing a single pick threw away half
   * the answer. Free-form strings rather than an enum: a job you chose
   * not to take has a much longer tail of reasons than one you lost.
   *
   * Deliberately NOT `lostReason` — declining never touches the win/loss
   * stats.
   */
  declineReasons?: string[];
  /**
   * Free-text note alongside the chips, in Brad's words. Optional —
   * declining is one tap, any reason at all is a skippable second step.
   * Also holds legacy reasons migrated off the old park flow.
   */
  declineReason?: string;
  /**
   * The status the job held immediately before it was declined, so
   * "Put it back on the list" restores it exactly (a declined quote
   * returns to 'quoted', not 'lead'). This is what preserves the old
   * park flow's best property — the decision is always reversible.
   * Cleared on restore.
   */
  declinedFromStatus?: JobStatus;
  /**
   * "Snooze" a lead — give it more time before it's worth chasing again.
   * Local date (YYYY-MM-DD). While this is in the future the lead is hidden
   * from the Leads chase-list (shown in a "Snoozed" drawer instead); on/after
   * this date it flows back into its normal bucket automatically. Distinct
   * from `followUpDate` (which drives the quote follow-up ladder) and from
   * declining (which is a decision, not a delay). Clearing it (null)
   * un-snoozes now.
   */
  snoozeUntil?: string;
  /**
   * Why the deposit hasn't been issued yet — the pill picked on the Home
   * "Deposits to send" flag's "Not yet" flow (migration 045). Most reasons
   * pair with `depositSnoozeUntil` for a temporary quieting; 'no_deposit'
   * hides the job from the flag for good (no deposit is coming — small job,
   * trusted client, or tender/progress-claim terms). Clearing it ('' → null)
   * puts the job back on the flag.
   */
  depositNotYetReason?: DepositNotYetReason;
  /**
   * Local date (YYYY-MM-DD). While in the future, the job is hidden from
   * the "Deposits to send" flag; on/after this date it flows back in
   * automatically. Same shape as `snoozeUntil`, deliberately separate —
   * snoozing a lead chase and quieting a deposit nag are different
   * decisions. Clearing it ('' → null) un-snoozes now.
   */
  depositSnoozeUntil?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The "Not yet" pills on the Home deposits flag. All but 'no_deposit' are
 * delays (the flag comes back on `depositSnoozeUntil`); 'no_deposit' is a
 * decision — this job simply isn't getting a deposit invoice.
 */
export type DepositNotYetReason =
  | 'dates_not_locked'
  | 'client_hold'
  | 'in_person'
  | 'no_deposit';

export interface Entry {
  id: string;
  businessId: string;
  jobId?: string;
  type: EntryType;
  category?: ExpenseCategory;
  amount?: number;
  hours?: number;
  activity?: ActivityType;
  /**
   * Who did the work. Only meaningful for `type === 'hours'`. Defaults
   * to 'owner' (Brad solo) on the entry form. Drives the blended-target
   * gauge on the job's hourly-rate chart.
   */
  workerKind?: WorkerKind;
  /**
   * Name of the person who did the work, when they aren't on the team —
   * a subcontractor or one-off helper with no login. Free text, optional,
   * only meaningful for `type === 'hours'` rows with no `loggedByUserId`
   * and a non-owner `workerKind`. Display-only: it's what stops a row
   * reading "Subcontractor · 8h" with no way to remember which sub.
   */
  workerName?: string;
  /**
   * What this person COSTS per hour, ex-GST. Only for `type === 'hours'`
   * rows worked by someone not on payroll (a subcontractor or one-off
   * helper) — payroll wages arrive via pay runs instead, and accruing
   * them here would double-count.
   *
   * NOT the same number as the `worker_rate_*` settings: those are
   * charge-out TARGETS for the hourly-rate gauge (what an hour should
   * earn); this is what the hour costs. Undefined = unknown, which
   * accrues nothing rather than guessing. See `lib/labour-accrual.ts`.
   */
  workerCostRate?: number;
  /**
   * True once the worker has actually invoiced these hours — their bill
   * is now in the books, so the accrual must stop or the cost counts
   * twice. Set by the prompt when confirming a bill against the job, or
   * by hand on the entry.
   */
  labourBilled?: boolean;
  /** The bill entry that covered these hours, when it was linked at confirm time. */
  labourBillEntryId?: string;
  /**
   * LEGACY (write path removed July 2026). Additional hours from a
   * helper on the same shift, captured on Brad's own entry via the old
   * "+ helper hrs" form field. Employees now log their own hours from
   * /my/hours (with `loggedByUserId`), which is what payroll pays from.
   * The field stays because historical entries carry it — job-stats'
   * blended-rate math and lib/payroll's legacy pickup still honour it.
   * Don't write it on new entries.
   */
  helperHours?: number;
  /**
   * The auth user who logged this entry. Set for hours logged by an
   * EMPLOYEE (e.g. Suzie logging her own time) — the database requires it
   * to match the signed-in user for employee inserts, and it's how their
   * hours are attributed on payroll timesheets. Null/undefined for the
   * owner's own historical entries. Only meaningful for `type === 'hours'`.
   */
  loggedByUserId?: string;
  supplier?: string;
  paymentMethod?: string;
  gstApplies: boolean;
  amountExGst?: number;
  gstComponent?: number;
  description: string;
  entryDate: string;
  dueDate?: string;
  // Bill-specific
  company?: string;
  paid?: boolean;
  paidDate?: string;
  paymentRef?: string;
  /** Set when reconciled to a bank transaction. */
  bankTransactionId?: string;
  /**
   * Where this lead came from. Only meaningful for `type === 'enquiry'`
   * entries; the entry form only surfaces the picker for enquiries. Null
   * for other entry types and for legacy enquiries logged before this
   * field existed.
   */
  leadSource?: LeadSource;
  // Draft-bill fields (populated by the PDF upload + LLM extraction flow).
  // A draft is an unconfirmed bill — it doesn't count against expenses or
  // GST until isDraft flips to false (via the Home "Bills to confirm"
  // Confirm button). EVERY bill-aggregating query in the app must filter
  // !isDraft or drafts will leak into money math.
  /** True while awaiting Brad's confirmation. Always undefined/false for non-bill entries. */
  isDraft?: boolean;
  /** Object path inside the `bill-pdfs` Supabase Storage bucket. NOT a URL — URLs expire. */
  billPdfUrl?: string;
  /** Coarse confidence from the parser; used to nudge Brad to double-check on confirm. */
  parserConfidence?: 'high' | 'medium' | 'low';
  /** Raw JSON the parser emitted. Debugging / future re-processing only. */
  parserRaw?: unknown;
  /**
   * Email Message-ID of the inbound webhook that created this draft. Used
   * for idempotency — retried webhook deliveries with the same Message-ID
   * hit the unique index and short-circuit. Only set on entries created
   * via /api/webhooks/inbound-bill; null for manual uploads + legacy data.
   */
  sourceMessageId?: string;
  /**
   * Links the slices of ONE supplier bill that was split across multiple
   * jobs at confirm time. Every sibling bill entry created from the same
   * invoice shares this id; a normal single-job bill leaves it undefined.
   * Lets us keep the slices together for display, exempt them from
   * duplicate detection, and reconcile a payment against the whole group.
   */
  billGroupId?: string;
  createdAt: string;
}

/**
 * Structured fields extracted by the bill PDF parser. Returned by the
 * /api/parse-bill route. All money values in NZD; dates ISO YYYY-MM-DD.
 * Every field is optional because parsing is best-effort — the confirm UI
 * shows what was found and Brad fills any gaps before confirming.
 */
export interface ParsedBill {
  supplier?: string;
  invoiceNumber?: string;
  /** Gross amount the bill says to pay. */
  totalInclGst?: number;
  /** GST portion of the total. For NZ-registered suppliers this is total ÷ 23 × 3. */
  gstComponent?: number;
  /** Derived server-side: totalInclGst - gstComponent. The "real cost" Brad pays. */
  amountExGst?: number;
  /** Date the supplier issued the invoice. */
  invoiceDate?: string;
  /** Date Brad needs to pay by. */
  dueDate?: string;
  /** Optional itemised list. */
  lineItems?: { description: string; quantity?: number; unitPrice?: number; total?: number }[];
  /** Freeform text the parser thinks identifies the job: address, PO number, etc. */
  jobHint?: string;
  /** Overall confidence — informs the UI's "double-check this" affordance. */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Extracted fields from a customer-facing INVOICE PDF (one we issued, not
 * a supplier bill). Used by the Issue-invoice form's drop-zone: drag the
 * PDF in, this gets populated, the form pre-fills.
 *
 * Distinct from ParsedBill — bills are money-OUT (suppliers billing us),
 * invoices are money-IN (us billing customers). Different schema fields
 * (no supplier; has invoice kind), different LLM prompt (NZ tradie
 * invoice vs supplier invoice).
 */
export interface ParsedInvoice {
  /** The invoice number as printed on the document (e.g. "INV-034-DEP"). */
  invoiceNumber?: string;
  /** Date the invoice was issued (ISO YYYY-MM-DD). */
  invoiceDate?: string;
  /** Date payment is due (ISO YYYY-MM-DD) — often "On receipt", which becomes invoiceDate. */
  dueDate?: string;
  /** Total gross amount due (GST-inclusive). */
  totalInclGst?: number;
  /** GST portion. For NZ-registered tradies this is total ÷ 23 × 3. */
  gstComponent?: number;
  /** Net amount excluding GST (derived server-side: totalInclGst - gstComponent). */
  amountExGst?: number;
  /**
   * Invoice classification — deposit / progress / final. Inferred from the
   * description line ("Deposit (30%)…", "Final invoice…") or the invoice
   * number suffix (-DEP, -F, -P1). Omitted when ambiguous.
   */
  kind?: InvoiceKind;
  /** Project / job reference printed on the invoice (e.g. "Administration Building"). */
  projectRef?: string;
  /** Customer name (e.g. "Terry Emmitt"). Used for job-matching. */
  customerName?: string;
  /** Quote reference printed on the invoice (e.g. "QUO-034"). */
  quoteRef?: string;
  /** Short description line for the form's notes/variation field. */
  description?: string;
  /** Overall confidence — informs the UI's "double-check this" affordance. */
  confidence: 'high' | 'medium' | 'low';
}

export type BankTransactionStatus = 'unreconciled' | 'matched' | 'ignored' | 'personal' | 'tax';

/**
 * Sub-type of a payment to Inland Revenue, set when a bank transaction is
 * classified as `status = 'tax'`. None of these are deductible business
 * expenses — the classification exists so the money is recorded and
 * reconciled WITHOUT creating an `entries` expense row (which would wrongly
 * reduce taxable profit). Drives the "Paid to IRD" breakdown on the Money tab.
 *
 *   income_tax → company/personal income tax (IR4 / terminal / provisional).
 *                Non-deductible appropriation of profit (s DB 1).
 *   gst        → GST paid over on a return. Pass-through liability, not an expense.
 *   paye       → PAYE remitted for wages (e.g. Suzie). The gross wage is the
 *                deductible expense; the PAYE remittance itself isn't a second one.
 *   penalty    → late-payment penalties / use-of-money interest. Penalties are
 *                non-deductible; kept separate so UOMI can be reviewed at year-end.
 *   other      → anything else paid to IRD that isn't a business expense.
 */
export type TaxPaymentKind =
  | 'income_tax'
  | 'gst'
  | 'paye'
  | 'penalty'
  | 'other';

export interface BankTransaction {
  id: string;
  businessId: string;
  bankAccountId?: string;
  txnDate: string;
  /** Signed: negative for debits, positive for credits. */
  amount: number;
  payee?: string;
  particulars?: string;
  code?: string;
  reference?: string;
  tranType?: string;
  otherPartyAccount?: string;
  description: string;
  fingerprint: string;
  status: BankTransactionStatus;
  entryId?: string;
  /** Sub-type when status === 'tax'. Undefined for all other statuses. */
  taxKind?: TaxPaymentKind;
  notes?: string;
  importedAt: string;
}

export interface Material {
  id: string;
  businessId: string;
  jobId?: string;
  entryId?: string;
  usedOn?: string;
  productType?: ProductType;
  brand?: string;
  productName?: string;
  color?: string;
  finish?: Finish;
  quantity?: number;
  unit?: Unit;
  cost?: number;
  supplier?: string;
  area?: string;
  notes?: string;
  /**
   * Where this material row came from:
   *   - 'bill'     : derived from a confirmed supplier bill line item
   *                  (linked via entryId). The bill's entry is what
   *                  drives business-wide expense totals.
   *   - 'overhead' : user-entered usage of something they already owned
   *                  (no entryId, no fresh cash outflow). Counts toward
   *                  the JOB'S material cost in per-job profit, but
   *                  does NOT count in business-wide expenses (because
   *                  the original purchase already counted under
   *                  overhead at the time).
   *
   * Older rows that pre-date migration 010 read back as 'bill' by
   * default (set by the migration's column default).
   */
  source?: 'bill' | 'overhead';
  createdAt: string;
}

export type PaintStockKind =
  | 'topcoat' | 'enamel' | 'ceiling' | 'primer_sealer' | 'stain'
  | 'test_pot' | 'other';

export type PaintStockLocation = 'garage' | 'van';

/**
 * Paint inventory on hand — deliberately separate from Material.
 * Material is a usage/purchase LOG (historical, tied to jobs/bills);
 * PaintStockItem is CURRENT state (what's in the garage or van right
 * now), mutated as paint is used and bought. Low-stock is derived in
 * the UI (litres <= 1 and not a test pot), never stored.
 */
export interface PaintStockItem {
  id: string;
  businessId: string;
  /** Product line, e.g. "Lumbersider", "Wash&Wear Low Sheen". */
  product: string;
  brand?: string;
  /** Tint, e.g. "Flax Pod". Undefined for untinted (sealers etc). */
  color?: string;
  kind: PaintStockKind;
  /**
   * Approx litres remaining. Undefined = not tracked by volume
   * (test pots, spray cans — presence is what matters).
   */
  litres?: number;
  location: PaintStockLocation;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Quote {
  id: string;
  businessId: string;
  legacyId?: string;
  legacyEnquiryId?: string;
  jobId?: string;
  dateSent?: string;
  clientName?: string;
  jobAddress?: string;
  jobType?: string;
  scopeSummary?: string;
  baseAmountExGst?: number;
  optionAmountExGst?: number;
  totalAmountInclGst?: number;
  status?: QuoteStatus;
  wonAmountExGst?: number;
  varianceAmount?: number;
  variancePercent?: number;
  notes?: string;
  // Scope fields populated by the site-capture flow + the project importer
  // (which extracts what it can from quote PDFs + council plans).
  // m²-by-zone is a map: { "weatherboards": 120, "soffits": 30, ... } so
  // we can later analyse $/m² per surface type, not just per whole job.
  surfaceAreaM2ByZone?: Record<string, number>;
  prepLevel?: PrepLevel;
  /** Free-form surface description ("weatherboard", "cedar", "linea", etc). */
  surfaceType?: string;
  /**
   * Qualitative signals captured at the site visit. Kept loose so the
   * vocabulary can grow without a schema change. Typical shape:
   *   priceSensitivity: 'cheap' | 'mid' | 'premium'
   *   urgency: 'low' | 'medium' | 'high'
   *   decisionMakerPresent: boolean
   *   leadSource: LeadSource
   */
  clientSignals?: Record<string, unknown>;
  /** Folder path the project importer pulled this row from. */
  importSourcePath?: string;
  /**
   * Per-zone structured scope used by the cost engine. Richer than the
   * legacy `surfaceAreaM2ByZone` map (which only knows m² per labelled
   * zone) — each entry here also carries surface type, work kind,
   * prep level, and the measurement unit (m² / LM / count).
   *
   * Shape mirrors `ScopeZone` in `lib/pricing/cost-engine.ts`. Kept as
   * `unknown[]` here to avoid a circular import between types and the
   * pricing module; cost-engine.ts re-exports the typed shape.
   */
  scopeZones?: unknown[];
  /** What a competing painter quoted for the same job, if known. ex-GST. */
  competitorPriceExGst?: number;
  /** When the outcome (won/lost/ghosted) was decided. */
  outcomeDate?: string;
  /** Free-form reason text — supersedes the legacy enums. */
  outcomeReason?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A file attached to a quote — council plan, before/after photo, scope
 * photo, or the sent quote PDF itself. Storage object lives in the
 * `quote-attachments` Supabase Storage bucket; we store the path, never
 * a signed URL (URLs expire, paths don't).
 */
export type QuoteAttachmentKind =
  | 'plan'
  | 'before_photo'
  | 'after_photo'
  | 'scope_photo'
  | 'process_photo'
  /**
   * A generated 1080×1080 testimonial card (the client's review rendered
   * as a branded image, drawn client-side on a canvas). Made in the
   * Facebook composer to lead a social post. NEVER shown in website
   * galleries — the publish pipeline only reads photo kinds.
   */
  | 'testimonial_image'
  | 'quote_pdf'
  | 'other';

/**
 * Project archive import staging row. One per folder discovered by
 * scripts/import-projects.ts --apply. Holds the suggested job match +
 * classified files + LLM-parsed quote data BEFORE it lands in real
 * jobs/quotes/quote_attachments tables. User reviews each row in the
 * "Imports to review" flag on Home and commits it as link/create/skip.
 */
export type ImportConfidence = 'high' | 'medium' | 'low' | 'none';
export type ImportStatus = 'pending' | 'committed' | 'skipped';
export type ImportDecision = 'link' | 'create' | 'skip';

/** Counts of classified files in a folder, returned by the importer walker. */
export interface FolderFileCounts {
  plan?: number;
  quote_pdf?: number;
  invoice_pdf?: number;
  before_photo?: number;
  after_photo?: number;
  scope_photo?: number;
  notes_md?: number;
  video?: number;
  spreadsheet?: number;
  other?: number;
}

/**
 * Result of parsing a quote PDF via Anthropic. Mirrors the shape of
 * ParsedBill but for the quote use case — extracted fields land here,
 * then on commit they flow into the corresponding `quotes` row.
 */
export interface ParsedQuote {
  clientName?: string;
  jobAddress?: string;
  jobType?: string;
  scopeSummary?: string;
  baseAmountExGst?: number;
  totalAmountInclGst?: number;
  dateSent?: string;
  lineItems?: { description: string; amount?: number }[];
  /** Optional surface-area-by-zone extracted from the quote scope text. */
  surfaceAreaM2ByZone?: Record<string, number>;
  /** Free-form surface description if the quote mentions it ("weatherboard"). */
  surfaceType?: string;
  prepLevel?: PrepLevel;
  confidence: 'high' | 'medium' | 'low';
}

export interface JobImport {
  id: string;
  businessId: string;
  /** Absolute filesystem path the folder was discovered at. Audit only. */
  sourcePath: string;
  /** Display name (basename) of the folder. */
  folderName: string;
  /** Suggested existing job from the dry-run matcher; user can override. */
  suggestedJobId?: string;
  suggestedLegacyId?: string;
  suggestedLabel?: string;
  matchConfidence: ImportConfidence;
  matchSource?: string;
  /** Classified file counts — for the UI's at-a-glance summary. */
  filesSummary: FolderFileCounts;
  /** Storage prefix where staged attachments live ("_pending/{importId}/"). */
  attachmentsStoragePrefix?: string;
  /** LLM-extracted quote fields if a quote PDF was found in the folder. */
  parsedData?: ParsedQuote;
  status: ImportStatus;
  commitAction?: ImportDecision;
  commitTargetJobId?: string;
  commitTargetQuoteId?: string;
  committedAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteAttachment {
  id: string;
  businessId: string;
  quoteId: string;
  kind: QuoteAttachmentKind;
  /** Object path inside the `quote-attachments` bucket. */
  storagePath: string;
  fileName?: string;
  pageCount?: number;
  /** Filled in by the council-plan parser once it runs over a `plan` kind. */
  parsedM2ByZone?: Record<string, number>;
  parsedConfidence?: 'high' | 'medium' | 'low';
  createdAt: string;
}

export interface Setting {
  businessId: string;
  key: string;
  value?: string;
  notes?: string;
  updatedAt: string;
}

/**
 * Per-business quote template. Stored as a JSON blob in the `settings`
 * row keyed 'quote_template' so the schema can evolve without
 * migrations. Seeded by migration 014 with sensible Lakeside defaults;
 * editable via /settings/quote-template (Session 1 of the quote
 * builder work).
 *
 * Used by:
 *   - The settings UI (read + write).
 *   - The future AI quote drafter (read — to know the business
 *     identity it's writing on behalf of).
 *   - The future React-PDF generator (read — to render header,
 *     payment terms, T&Cs on the PDF).
 *
 * All fields nullable so an under-filled template still renders
 * something (just with placeholders) rather than blowing up.
 */
export interface QuoteTemplate {
  header: {
    /** Trading name shown at the top of the PDF. */
    businessName?: string;
    /** NZ GST registration number, formatted XX-XXX-XXX. */
    gstNumber?: string;
    phone?: string;
    email?: string;
    /** Physical address — appears under the header. */
    address?: string;
    /** Website shown in the invoice/quote FROM block, e.g. lakesidepainting.co.nz. */
    website?: string;
    /**
     * Storage path of the logo in the `business-logos` bucket,
     * e.g. "<businessId>/logo.png". The UI resolves this to a
     * public URL for display + PDF embed.
     */
    logoStoragePath?: string;
  };
  paymentTerms: {
    /** % deposit required to confirm the booking. NZ standard ~30%. */
    depositPercent: number;
    /** Days from quote acceptance to deposit due. */
    depositDueDays: number;
    /**
     * When the balance is payable. 'on_completion' = single lump
     * at job end. Future: 'progress' would add a midway payment.
     */
    balanceDue: 'on_completion' | 'progress';
  };
  /** Quote validity in days from issue date. Default 30. */
  validityDays: number;
  /**
   * 'incl' = totals shown GST-inclusive (NZ retail convention).
   * 'excl' = ex-GST + GST line + incl-GST total. We default to
   * 'incl' because residential customers expect it.
   */
  gstTreatment: 'incl' | 'excl';
  /**
   * Free-form T&Cs / scope-exclusions block. Plain text — bullets
   * with hyphens, line breaks via \n. The PDF generator splits on
   * newlines to render a list.
   */
  defaultTerms?: string;
  /**
   * Bank account shown in the PAYMENT DETAILS box on invoices. Optional —
   * invoices render a "set this in Settings" prompt until it's filled in.
   */
  bankDetails?: {
    accountName?: string;
    bankName?: string;
    accountNumber?: string;
  };
}

export type InvoiceKind = 'deposit' | 'progress' | 'final';
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'void';

export interface Invoice {
  id: string;
  businessId: string;
  jobId: string;
  invoiceNumber: string;
  invoiceDate: string;
  /** Accounting lifecycle. `due` / `overdue` are derived from sent + dueDate. */
  status: InvoiceStatus;
  dueDate?: string;
  sentAt?: string;
  kind: InvoiceKind;
  amountExGst: number;
  gstApplies: boolean;
  gstComponent?: number;
  amountInclGst?: number;
  paid: boolean;
  paidDate?: string;
  paidVia?: string;
  /** When marked paid, an income entry is auto-created and linked here. */
  incomeEntryId?: string;
  /** True only when TradePilot created the linked income entry for this payment. */
  paymentEntryGenerated?: boolean;
  /** Restores a draft correctly if a mistaken payment is undone. */
  statusBeforePaid?: 'draft' | 'sent';
  voidedAt?: string;
  voidReason?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Reason a scheduled day was skipped (not worked). Free-form text in
 * Postgres (migration 020) so the vocabulary can evolve without an
 * ALTER TYPE migration; this union is the canonical client-side list.
 *
 *   rained_off       → weather. Most common reason for an outdoor painter.
 *   sick             → Brad or a crew member sick.
 *   client_postponed → customer wasn't ready / asked to delay.
 *   other            → catch-all. Always paired with a free-form note in
 *                      `skip_reason`.
 */
export type ScheduleSkipReasonKind =
  | 'rained_off'
  | 'sick'
  | 'client_postponed'
  | 'other';

export interface ScheduleItem {
  id: string;
  businessId: string;
  jobId?: string;
  type: ScheduleItemType;
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  notes?: string;
  /**
   * Site address for this item — typed directly on the schedule item
   * rather than only inherited from a linked job, since site visits
   * (especially no-job leads) often need an address before a Job row
   * exists. When both this and a linked job's location are present,
   * this one wins (the user explicitly typed it for this visit).
   */
  location?: string;
  /**
   * Optional client contact captured directly on a schedule item —
   * mainly for quote_visit rows booked before a Job exists yet. None
   * of the three are required; Brad can add just a phone number, just
   * an email, or nothing at all.
   */
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  /**
   * People on this booking who have no login — subcontractors, one-off
   * helpers. Plain names (migration 048), the same escape hatch
   * `Entry.workerName` uses for logged hours.
   *
   * Staff and Brad himself are NOT here: they have auth users, so they
   * go through `ScheduleAssignment` where the RLS gates can see them.
   * The two lists are independent — a booking can have a named sub on it
   * whether or not it overrides the job team.
   */
  crewNames?: string[];
  completed: boolean;
  /**
   * When set, this scheduled day was skipped — the user couldn't / didn't
   * work it. Distinct from `completed` (which means "I worked it"). A
   * skipped day stays visible on the calendar but renders faded with the
   * reason chip, and never shows as Overdue.
   *
   * Migration 020 added the underlying columns. Both null = not skipped.
   */
  skipReasonKind?: ScheduleSkipReasonKind;
  /** Optional free-form note. Required when skipReasonKind === 'other'. */
  skipReason?: string;
  /**
   * True once the user has downloaded the .ics calendar invite for this
   * item. Only meaningful for type='quote_visit' rows today — drives the
   * "Reminders set" vs "Add to calendar" badge on the Schedule page so
   * Brad can see at a glance which site visits actually have phone
   * reminders attached vs which were skipped.
   *
   * Note: this is a "best guess" signal — it tells us the file was
   * downloaded, NOT that the user actually imported it into their
   * calendar app. There's no way to confirm the latter from a browser.
   * The badge wording reflects this honestly ("Reminders set" assumes
   * the obvious next step happened; we don't claim "Reminders active").
   */
  icsDownloaded?: boolean;
  createdAt: string;
}

export interface Business {
  id: string;
  ownerId: string;
  name: string;
  industry: string;
  createdAt: string;
}

export interface ParsedEntry {
  type: EntryType;
  jobName?: string;
  clientName?: string;
  amount?: number;
  hours?: number;
  category?: ExpenseCategory;
  supplier?: string;
  description: string;
  dueDate?: string;
  /** ISO YYYY-MM-DD if the parser detected a date in the text. */
  entryDate?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface MonthlyData {
  month: string;
  revenue: number;
  expenses: number;
}

export interface CategoryData {
  category: string;
  amount: number;
}

export interface PipelineData {
  status: string;
  value: number;
  count: number;
}

/**
 * Where a job's marketing content sits in its lifecycle.
 *   draft     — being put together (default for any job once it has marketing data).
 *   ready     — Brad has eyeballed the photos + blurb and it's good to publish.
 *   published — pushed live to the website (set by the future publish flow).
 */
export type JobMarketingStatus = 'draft' | 'ready' | 'published';

/**
 * Facebook channel state for a job, nested inside JobMarketing (same settings
 * JSON blob — no new table). The caption is the platform-tailored copy Brad
 * reviews/edits in the preview; once posted we keep the Graph API post id +
 * permalink so the UI can show a "View on Facebook" link and a posted badge.
 */
export interface JobFacebook {
  /** The Facebook-flavoured caption shown in the preview and posted as-is. */
  caption?: string;
  /** quote_attachments.ids of the photos to attach, in post order (hero first). */
  photoAttachmentIds?: string[];
  /**
   * Burn a small BEFORE / AFTER pill onto before+after photos when posting
   * (composited client-side at post time; originals in storage stay clean).
   * Defaults to true in the composer.
   */
  labelPhotos?: boolean;
  /** 'draft' until posted, then 'posted'. */
  status?: 'draft' | 'posted';
  /** Graph API post id returned on a successful publish. */
  postId?: string;
  /** Public permalink to the post (permalink_url), for the "View on Facebook" link. */
  permalink?: string;
  /** ISO timestamp of the successful post. */
  postedAt?: string;
}

/**
 * Instagram channel state — same shape as JobFacebook (caption, ordered photo
 * ids, posted status + permalink), nested inside the same JobMarketing blob.
 * `postId` here is the IG media id returned by /media_publish.
 */
export type JobInstagram = JobFacebook;

/**
 * Marketing/portfolio metadata for a completed job — the bits that turn a
 * finished job into a website project + (later) a social post.
 *
 * Deliberately NOT a database table. It's persisted as a JSON blob in the
 * `settings` table keyed `marketing:{jobId}`, exactly the same pattern as
 * QuoteTemplate (settings key 'quote_template'). That means this whole
 * feature ships with ZERO schema migration and can't disturb any existing
 * table — see getJobMarketing / saveJobMarketing in lib/store.tsx.
 *
 * Photos are NOT stored here. They reuse the existing quote_attachments
 * pipeline: `before_photo` / `scope_photo` (captured at the site-visit
 * wrap-up) and `after_photo` (added on the Marketing tab once the job's
 * done). The Marketing tab reads them per job via the job's quotes, the
 * same way JobDetailSheet's "Plans & photos" panel does.
 */
/** A client testimonial shown on the website project page. */
export interface JobReview {
  /** The client's words, verbatim. */
  quote: string;
  /** First name (or however the client should be credited). */
  author?: string;
  /**
   * Role line under the name on the generated testimonial card
   * (e.g. "Home Owner", "Property Manager"). Card-only — the website
   * publish pipeline ignores it (project.json has no role field).
   */
  role?: string;
}

export interface JobMarketing {
  jobId: string;
  /** Page title for the website project (defaults to the job name). */
  title?: string;
  /** Lead paragraph / card summary — the substantial opening line(s) on the page. */
  description?: string;
  /** The body of the project page: 2–4 paragraphs. Reviewed + edited before publish. */
  overview?: string[];
  /** Services Provided list shown on the page (selectable pills in the preview). */
  services?: string[];
  /** Publishing lifecycle. See JobMarketingStatus. */
  status: JobMarketingStatus;
  /** Chosen hero image: the quote_attachments.id of the best 'after' shot. */
  heroAttachmentId?: string;
  /** Hero presentation on the project page: a single image, or a before/after slider. */
  heroMode?: 'image' | 'slider';
  /** Chosen BEFORE image (quote_attachments.id) for the slider. */
  heroBeforeId?: string;
  /** Chosen AFTER image (quote_attachments.id) — slider's after side + the main/card image. */
  heroAfterId?: string;
  /**
   * quote_attachments.ids Brad has hidden from the website project page.
   * Hidden photos stay on the job (and in the app) but are skipped by the
   * publish pipeline's galleries. Opt-out rather than opt-in so newly added
   * photos show by default.
   */
  excludedImageIds?: string[];
  /**
   * Optional client testimonial for the project page. Rendered by the
   * painters-wanaka site's `review` block in project.json. Omitted from the
   * published page when there's no quote. The quote is the client's own
   * words — never AI-rewritten.
   */
  review?: JobReview;
  /** Facebook channel: caption + post status/link. See JobFacebook. */
  facebook?: JobFacebook;
  /** Instagram channel: caption + post status/link. See JobInstagram. */
  instagram?: JobInstagram;
  /** ISO timestamp of the last save. */
  updatedAt?: string;
}
