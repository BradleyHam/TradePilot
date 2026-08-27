'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import { jobCoverPath, useSignedCovers } from '@/lib/job-cover';
import { Job, JobStatus, ScheduleItem, ScheduleItemType } from '@/lib/types';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { JobCard } from '@/components/jobs/job-card';
import { JobDetailSheet } from '@/components/jobs/job-detail-sheet';
import { JobForm } from '@/components/jobs/job-form';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Briefcase, Plus, Search, Filter } from 'lucide-react';
import { JOB_STATUSES } from '@/lib/mock-data';
import { jobStats } from '@/lib/job-stats';
import { payrollConfig } from '@/lib/payroll';
import { cn } from '@/lib/utils';

// Filter values: a synthetic 'coming-up' group, or a literal JobStatus.
// 'coming-up' is committed work (accepted/booked) plus any lead/quote
// that has a booked work day on the calendar (a site visit does NOT
// count — that's still pipeline, not committed work); sits cleanly
// alongside In progress. No 'all' chip — search covers the cross-status
// case better than a giant mixed list does, and the page now defaults
// to In progress (what am I doing right now) which is far more useful as
// a first-glance view.
type FilterValue = 'coming-up' | JobStatus;

// Schedule item types that represent committed WORK — an actual day on
// the tools. These are the only types that should pull a lead/quote into
// Coming up via the schedule-reality override below. Everything else on
// the calendar is pipeline or admin, not committed work:
//   - quote_visit  : a SITE VISIT to price the job. The job is still a
//                    lead/quote until Brad's won it — it does NOT belong
//                    in Coming up just because a visit is booked.
//   - follow_up    : a reminder to chase a lead. Pipeline, not work.
//   - bill_due / invoice_due / reminder : money/admin reminders, not work.
const COMMITTED_WORK_SCHEDULE_TYPES: ScheduleItemType[] = ['job_booking'];

const FILTER_OPTIONS: { label: string; value: FilterValue }[] = [
  { label: 'In progress', value: 'in-progress' },
  { label: 'Coming up',   value: 'coming-up' },
  { label: 'Completed',   value: 'completed' },
  { label: 'Leads',       value: 'lead' },
  { label: 'Quoted',      value: 'quoted' },
  { label: 'Booked',      value: 'booked' },
  { label: 'Invoiced',    value: 'invoiced' },
  { label: 'Paid',        value: 'paid' },
  // These two sit at the end — only relevant when reviewing what didn't
  // convert. Kept as separate chips because they answer different questions:
  // Lost is "where am I getting beaten?", Declined is "what am I choosing
  // not to take?". Rolling them together hid both.
  { label: 'Lost',        value: 'lost' },
  { label: 'Declined',    value: 'declined' },
];

/**
 * Earliest future schedule item date for a given job, or null if no
 * future items. Used by both the Coming up filter and its sort so
 * jobs whose calendar reality lives in schedule_items (rather than
 * the Job row's startDate) still surface correctly.
 *
 * Pass `types` to only consider certain schedule item types. The
 * Coming up qualifier passes COMMITTED_WORK_SCHEDULE_TYPES so a booked
 * site visit doesn't masquerade as committed work; the sort leaves it
 * unset so ordering still respects every calendar event (including the
 * next site visit) when deciding what's soonest.
 */
function earliestFutureScheduleDate(
  jobId: string,
  scheduleItems: ScheduleItem[],
  todayISO: string,
  types?: ScheduleItemType[],
): string | null {
  let earliest: string | null = null;
  for (const s of scheduleItems) {
    if (s.jobId !== jobId) continue;
    if (s.completed) continue;
    if (types && !types.includes(s.type)) continue;
    if (s.date < todayISO) continue;
    if (!earliest || s.date < earliest) earliest = s.date;
  }
  return earliest;
}

/**
 * Should this job appear in the Coming up tab? Coming up means
 * "committed work that's coming". Leads and quoted jobs are pipeline,
 * not coming up — they have their own chips. The only exception is
 * the schedule reality override: if a job has a future booked WORK day
 * attached (job_booking), treat it as coming up regardless of status
 * (catches the "I forgot to flip status to booked after scheduling it"
 * case). A booked site visit (quote_visit) does NOT count — the job is
 * still a lead/quote in the pipeline until Brad's actually won it.
 *
 *   - in-progress        : never (it's on the job already — In progress
 *     chip is the right home). Coming up and In progress are meant to be
 *     mutually exclusive per AGENTS.md.
 *   - completed/invoiced/paid/lost : never (terminal — own chips).
 *   - accepted / booked  : always in (committed work).
 *   - lead / quoted      : in only if a future booked work day
 *     (job_booking) exists. A booked site visit does not qualify.
 */
function comingUpQualifies(
  job: Job,
  scheduleItems: ScheduleItem[],
  todayISO: string,
): boolean {
  // Hard excludes: in-progress lives on the In progress chip; terminal
  // statuses live on their own chips. Letting any of these leak in via
  // the schedule override breaks the mutual-exclusivity rule and shows
  // jobs in two places at once.
  if (
    job.status === 'in-progress'
    || job.status === 'completed'
    || job.status === 'invoiced'
    || job.status === 'paid'
    || job.status === 'lost'
    || job.status === 'declined'
  ) {
    return false;
  }

  // Committed statuses: always in.
  if (job.status === 'accepted' || job.status === 'booked') return true;

  // Schedule reality override (lead/quoted only): a future booked WORK
  // day means this job is genuinely coming up, even if its status hasn't
  // caught up yet. Catches Troy-style cases where the calendar knows about
  // July but the Job row still says 'quoted'. Restricted to
  // COMMITTED_WORK_SCHEDULE_TYPES so a booked site visit (quote_visit) —
  // which is still pipeline, not committed work — doesn't drag a lead in.
  if (earliestFutureScheduleDate(job.id, scheduleItems, todayISO, COMMITTED_WORK_SCHEDULE_TYPES)) {
    return true;
  }

  return false;
}

/**
 * Filter-aware job sort. Different chips want different date axes:
 *
 *   - Completed / Invoiced / Paid : endDate desc (most recently finished first).
 *       Falls back to updatedAt if endDate isn't recorded.
 *
 *   - Coming up + Lead + Quoted + Accepted + Booked : startDate asc
 *       (next thing on the calendar first). Falls back to followUpDate,
 *       then createdAt desc for fresh leads with no dates set.
 *
 *   - In progress : updatedAt desc — the most recently touched live job
 *       is the most useful one to surface first.
 *
 *   - Lost : updatedAt desc (most recently lost first).
 *
 *   - All : updatedAt desc (no single right axis when statuses are mixed).
 *
 * All comparators are stable on ties: jobs with identical sort keys keep
 * their existing order so the list doesn't jitter on re-render.
 */
function jobComparatorForFilter(
  filter: FilterValue,
  scheduleItems: ScheduleItem[] = [],
  todayISO: string = new Date().toISOString().slice(0, 10),
): (a: Job, b: Job) => number {
  // Build a millisecond timestamp from an ISO string, falling back through
  // an ordered list of optional dates. Missing-everywhere = +/- Infinity
  // depending on direction, so those jobs collapse to the end of the list.
  const ts = (s?: string | null) => (s ? new Date(s).getTime() : NaN);
  const firstTs = (...candidates: (string | undefined | null)[]) => {
    for (const c of candidates) {
      const t = ts(c);
      if (Number.isFinite(t)) return t;
    }
    return NaN;
  };

  const comingUpLike: JobStatus[] = ['lead', 'quoted', 'accepted', 'booked'];

  // Completed bucket — most recently finished first.
  if (filter === 'completed' || filter === 'invoiced' || filter === 'paid') {
    return (a, b) => {
      const at = firstTs(a.endDate, a.updatedAt);
      const bt = firstTs(b.endDate, b.updatedAt);
      // Jobs with no usable date sink to the bottom.
      if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
      if (Number.isNaN(at)) return 1;
      if (Number.isNaN(bt)) return -1;
      return bt - at;
    };
  }

  // Coming-up bucket — soonest first. The "soonest" date is the
  // earliest of: startDate on the Job row, followUpDate, or the
  // earliest future schedule item tied to this job. This is how
  // Troy's-ceiling-in-July surfaces correctly even when its Job row
  // has no startDate set — schedule_items knows about July.
  if (filter === 'coming-up' || comingUpLike.includes(filter as JobStatus)) {
    return (a, b) => {
      const aSched = earliestFutureScheduleDate(a.id, scheduleItems, todayISO);
      const bSched = earliestFutureScheduleDate(b.id, scheduleItems, todayISO);
      const at = firstTs(a.startDate, a.followUpDate, aSched);
      const bt = firstTs(b.startDate, b.followUpDate, bSched);
      if (Number.isNaN(at) && Number.isNaN(bt)) {
        // Both date-less — newest lead first so fresh enquiries surface.
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      // Jobs with no scheduled date sink to the bottom of the upcoming list
      // since they can't be "next".
      if (Number.isNaN(at)) return 1;
      if (Number.isNaN(bt)) return -1;
      return at - bt;
    };
  }

  // In progress — most recently touched first.
  if (filter === 'in-progress') {
    return (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  }

  // Lost / Declined — most recently closed out first.
  if (filter === 'lost' || filter === 'declined') {
    return (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  }

  // Fallback — should be unreachable now that every FilterValue has an
  // explicit branch above. Kept as updatedAt-desc so any future status
  // added to the enum still gets a sensible default ordering instead of
  // crashing or returning 0 across the board.
  return (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export default function JobsPage() {
  const { jobs, entries, materials, scheduleItems, addJob, businessId, shiftPhotos, settings, teamMembers } = useStore();
  // Same labour-costing options the job sheet uses — the card and the sheet
  // must never disagree about what a job made.
  const statsOpts = {
    wageRate: payrollConfig(settings).wageRate,
    ownerUserId: teamMembers.find((m) => m.role === 'owner')?.userId,
  };
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [showAddJob, setShowAddJob] = useState(false);
  const [search, setSearch] = useState('');
  // Default to In progress — most-useful first-glance view (what am I
  // actively working on right now?). Replaces the old 'All' default
  // which produced a confusing mixed-status list.
  const [filter, setFilter] = useState<FilterValue>('in-progress');

  const todayISO = new Date().toISOString().slice(0, 10);
  const searching = search.trim().length > 0;
  const filteredJobs = jobs.filter((j) => {
    // When searching, ignore the active chip — the user is looking for
    // a specific job and probably can't remember which status it's in.
    // The search bar effectively becomes a cross-status finder.
    if (searching) {
      const q = search.toLowerCase();
      return (
        j.name.toLowerCase().includes(q) ||
        j.clientName.toLowerCase().includes(q) ||
        (j.location ?? '').toLowerCase().includes(q)
      );
    }
    // Coming up uses the smart helper: committed-work + future schedule.
    if (filter === 'coming-up') return comingUpQualifies(j, scheduleItems, todayISO);
    return j.status === filter;
  }).sort(jobComparatorForFilter(filter, scheduleItems, todayISO));

  // Stats are derived from entries via the shared util in lib/job-stats.ts so
  // this list view and the detail sheet always agree.

  // Card thumbnails. Signed for the FILTERED list only (one batched call),
  // so flipping chips doesn't sign every job in the business.
  // useSignedCovers already de-dupes + sorts into a stable key internally,
  // so passing a freshly-built array each render is fine — and it means a
  // newly-set cover picks up immediately.
  const coverPaths = filteredJobs.map((j) => jobCoverPath(j, shiftPhotos));
  const coverUrls = useSignedCovers(coverPaths);

  function handleAddJob(data: Omit<Job, 'id' | 'businessId' | 'createdAt' | 'updatedAt'>) {
    addJob({
      // Real UUID — jobs.id is a uuid column, so a "job_123" temp id fails
      // the insert with "invalid input syntax for type uuid".
      id: crypto.randomUUID(),
      businessId: businessId ?? '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data,
    });
    setShowAddJob(false);
  }

  // Work that could still turn into money. 'declined' belongs in this
  // exclusion list for the same reason 'lost' does — it's never happening,
  // so counting a turned-down $29k tender as pipeline overstates the number.
  // Must stay in step with the identical filter on the Money tab.
  const pipelineValue = jobs
    .filter((j) => !['paid', 'lost', 'declined'].includes(j.status))
    .reduce((s, j) => s + (j.quoteAmount ?? j.estimatedValue ?? 0), 0);

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Jobs"
        subtitle={`${jobs.filter((j) => ['in-progress', 'booked'].includes(j.status)).length} active · $${pipelineValue.toLocaleString('en-NZ')} pipeline`}
        action={
          <Button size="sm" className="bg-primary h-9" onClick={() => setShowAddJob(true)}>
            <Plus size={16} className="mr-1" /> Add job
          </Button>
        }
      />

      <div className="px-4 md:px-6 space-y-3">
        {/* Search */}
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search jobs or clients..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-10 pl-9 pr-3 rounded-xl border border-input bg-card text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {FILTER_OPTIONS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={cn(
                'shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                filter === value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/30'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Job list */}
        {filteredJobs.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title="No jobs yet"
            description="Add your first job to start tracking work, hours, and profit."
            action={
              <Button className="bg-primary" onClick={() => setShowAddJob(true)}>
                <Plus size={16} className="mr-1.5" /> Add first job
              </Button>
            }
          />
        ) : (
          <div className="space-y-2.5 pb-6">
            {filteredJobs.map((job) => {
              const stats = jobStats(job, entries, materials, statsOpts);
              const coverPath = jobCoverPath(job, shiftPhotos);
              return (
                <JobCard
                  key={job.id}
                  job={job}
                  totalHours={stats.totalHours}
                  totalExpenses={stats.totalExpenses}
                  totalIncome={stats.totalIncome}
                  expectedProfit={stats.expectedProfit}
                  expectedIsConfident={stats.expectedIsConfident}
                  coverUrl={coverPath ? coverUrls[coverPath] : undefined}
                  onClick={() => setSelectedJob(job)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Job detail sheet */}
      <JobDetailSheet
        job={selectedJob}
        open={!!selectedJob}
        onClose={() => setSelectedJob(null)}
      />

      {/* Add job sheet */}
      <Sheet open={showAddJob} onOpenChange={setShowAddJob}>
        <SheetContent side="bottom" className="h-[92vh] overflow-y-auto rounded-t-2xl pb-10">
          <SheetHeader className="pb-4">
            <SheetTitle>New job</SheetTitle>
          </SheetHeader>
          <JobForm onSave={handleAddJob} onCancel={() => setShowAddJob(false)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
