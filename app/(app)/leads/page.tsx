'use client';

// Leads — the chase-list.
//
// This page exists because the Jobs list, with its dozen chips, doesn't
// answer the question Brad needs answered every morning: "which leads
// have I not gotten back to, and how cold are they?". Leads cool off
// fast — 48 hours of silence and they've usually gone with another
// painter. The chase-list surfaces stale-ness front and centre so the
// "I forgot to reply to Sarah" failure mode stops happening.
//
// Scope on purpose:
//   - Open leads only (status = 'lead' or 'quoted'). Once a lead is
//     accepted/lost/cancelled it has its own resting place in Jobs.
//   - Sorted by stale-ness, coldest first. The whole point is to act
//     on the most-at-risk one before anything else.
//   - One-tap actions inline: call, email, mark contacted, open in
//     Jobs for full detail. No multi-step wizards — 5:30pm rule.
//   - A small summary strip across the top (count, open pipeline $,
//     source breakdown) so the page also doubles as a glance-view.
//
// Deliberately NOT on this page:
//   - Funnel / pipeline-stage visualisation. Single-painter operation,
//     ~5-15 leads at a time — a funnel chart looks silly and adds nothing.
//   - Conversion-rate-by-source. Needs ~20+ closed leads to be honest,
//     and we'd rather not show misleading numbers in the meantime.
//     Will revisit when there's enough data.
//   - Lost-reason breakdown. Same — wait for data. Surfaced in a future
//     "insights" tile when there's enough signal.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useStore } from '@/lib/store';
import { Job, LeadSource, ScheduleItem, WorkType } from '@/lib/types';
import { LeadInsights } from '@/components/leads/lead-insights';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { JobDetailSheet } from '@/components/jobs/job-detail-sheet';
import { JobForm } from '@/components/jobs/job-form';
import { MarkAsQuotedSheet } from '@/components/jobs/mark-as-quoted-sheet';
import { BookVisitSheet } from '@/components/schedule/book-visit-sheet';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  Phone, Mail, MapPin, MessageCircle, Sparkles, Snowflake, Flame, Clock,
  ChevronRight, Globe, Search, UserPlus, Inbox, CalendarPlus, CalendarDays,
  CalendarCheck, FileText, Send, X, Plus,
} from 'lucide-react';
import { cn, gmailComposeUrl } from '@/lib/utils';
import { computeQuoteFollowUps, type QuoteFollowUp } from '@/lib/quote-follow-up';

// Stale-ness thresholds. These match how leads actually behave for a
// solo painter — most clients want a reply same-day, expect a quote
// within a week, and have moved on by two weeks. Tweak the numbers
// here, not in the component, so the whole page agrees.
//
// "hot"   = touched in the last 2 days. Doing fine, leave alone.
// "warm"  = 3-6 days since last touch. Should chase.
// "cold"  = 7-13 days since last touch. Probably losing them.
// "dead"  = 14+ days. Almost certainly gone. Worth one last try then mark lost.
type Temperature = 'hot' | 'warm' | 'cold' | 'dead';

interface RankedLead {
  job: Job;
  daysSinceContact: number;
  /** Date used for the staleness calc — lastContactedDate or createdAt fallback. */
  contactRef: string;
  temperature: Temperature;
}

function temperatureOf(days: number): Temperature {
  if (days <= 2)  return 'hot';
  if (days <= 6)  return 'warm';
  if (days <= 13) return 'cold';
  return 'dead';
}

function daysSince(iso: string, today = new Date()): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  const diffMs = today.getTime() - then;
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

// Source pill — same vocabulary as job-card.tsx but a slightly larger
// pill since the leads page has more breathing room than the jobs list.
const SOURCE_PILL: Record<LeadSource, { label: string; Icon: typeof Globe } | null> = {
  website:  { label: 'Website',  Icon: Globe    },
  email:    { label: 'Email',    Icon: Mail     },
  phone:    { label: 'Phone',    Icon: Phone    },
  referral: { label: 'Referral', Icon: UserPlus },
  gmb:      { label: 'Google',   Icon: Search   },
  manual:   null,
};

export default function LeadsPage() {
  const { jobs, updateJob, addJob, businessId, scheduleItems, quotes } = useStore();
  const [openJob, setOpenJob] = useState<Job | null>(null);
  // Manual "Add lead" sheet — for enquiries that didn't come in via the
  // website form or Tapi (phone, walk-in, referral).
  const [showAddLead, setShowAddLead] = useState(false);
  // When set, the BookVisitSheet opens for this lead.
  const [visitForJob, setVisitForJob] = useState<Job | null>(null);
  // When set, the MarkAsQuotedSheet opens for this lead — shortcut
  // from the To-quote section's secondary CTA so the user doesn't
  // have to detour through the job detail when the quote was
  // prepared outside the app.
  const [markQuotedForJob, setMarkQuotedForJob] = useState<Job | null>(null);
  // Insights panel: work-type filter (drives the panel AND the chase-list
  // below) + collapsed/expanded state. Collapsed by default so the 5:30pm
  // "what do I chase?" view stays uncluttered; Brad opens it when he wants
  // the bird's-eye read.
  const [workFilter, setWorkFilter] = useState<WorkType | 'all'>('all');
  const [insightsOpen, setInsightsOpen] = useState(false);

  // Three buckets, mutually exclusive. Each answers a different
  // "what do I do next?" question:
  //
  //   toQuote     — site visit done, customer's waiting on a quote.
  //                 Action: prep + send the quote.
  //   awaitingReply — quote sent, customer hasn't responded. Action:
  //                 follow up if they go quiet.
  //   newEnquiries — lead with no visit booked yet. Action: book a visit.
  //
  // Sorting differs per bucket because the "what's most urgent" axis
  // is different:
  //   toQuote: by quoteReadyBy (soonest first) — Brad's promise to
  //            the customer.
  //   awaitingReply: by stale-ness (coldest first) — the chase-list
  //            original behaviour.
  //   newEnquiries: by stale-ness (coldest first) — same.
  //
  // hasWrapUpData = the "looks like Brad's done a site visit" signal.
  // Wrap-up sheet writes scopeNotes / paint area / prep level / quote-
  // ready-by date among others, so we treat any of them being set as
  // proof that the visit happened. Trade-off: a job manually edited
  // to set one of these would also land in "to quote" — fine, that's
  // probably what Brad wants anyway.
  const today = useMemo(() => new Date(), []);
  function hasWrapUpData(j: Job): boolean {
    return Boolean(
      j.scopeNotes
      || j.surfaceAreaM2
      || j.prepLevel
      || j.quoteReadyBy
      || (j.accessNotes && j.accessNotes.length > 0),
    );
  }
  function rankBy(j: Job, byField: 'lastContactedDate' | 'createdAt'): RankedLead {
    const contactRef = j[byField] ?? j.createdAt;
    const days = daysSince(contactRef, today);
    return {
      job: j,
      daysSinceContact: days,
      contactRef,
      temperature: temperatureOf(days),
    };
  }

  // Local YYYY-MM-DD for "is this visit still upcoming?" comparisons.
  const todayISO = useMemo(() => {
    const d = today;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, [today]);

  // jobId → the soonest upcoming quote_visit (not completed, not skipped,
  // today or later). Drives the "Visit booked" section + card badge so a
  // lead with a scheduled visit no longer looks identical to a fresh one.
  const nextVisitByJob = useMemo(() => {
    const map = new Map<string, ScheduleItem>();
    for (const s of scheduleItems) {
      if (s.type !== 'quote_visit' || !s.jobId) continue;
      if (s.completed || s.skipReasonKind) continue;
      if (s.date < todayISO) continue;
      const existing = map.get(s.jobId);
      if (!existing || s.date < existing.date) map.set(s.jobId, s);
    }
    return map;
  }, [scheduleItems, todayISO]);

  const toQuote = useMemo<RankedLead[]>(() => {
    return jobs
      .filter((j) => j.status === 'lead' && hasWrapUpData(j))
      .map((j) => rankBy(j, 'lastContactedDate'))
      // Sort by quoteReadyBy ascending — sooner promised = more urgent.
      // Falls back to days-since-contact for jobs with no promised date.
      .sort((a, b) => {
        const aDue = a.job.quoteReadyBy ?? '';
        const bDue = b.job.quoteReadyBy ?? '';
        if (aDue && bDue) return aDue.localeCompare(bDue);
        if (aDue) return -1;
        if (bDue) return 1;
        return b.daysSinceContact - a.daysSinceContact;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, today]);

  const awaitingReply = useMemo<RankedLead[]>(() => {
    return jobs
      .filter((j) => j.status === 'quoted')
      .map((j) => rankBy(j, 'lastContactedDate'))
      .sort((a, b) => b.daysSinceContact - a.daysSinceContact);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, today]);

  // Follow-up ladder for quoted jobs (shared rules with the Home flag —
  // lib/quote-follow-up.ts): day 7 nudge → day 21 "either way" message →
  // a week of silence after that → prompt to mark lost. Keyed by job id
  // so the awaiting-reply cards can show a stage pill + Mark lost action.
  const followUpByJob = useMemo(() => {
    const map = new Map<string, QuoteFollowUp>();
    for (const f of computeQuoteFollowUps(jobs, quotes, todayISO)) {
      map.set(f.job.id, f);
    }
    return map;
  }, [jobs, quotes, todayISO]);

  // "Visit booked": a fresh lead (no wrap-up data yet) that has an upcoming
  // quote_visit. Carved out of New enquiries so it doesn't look un-actioned.
  // Sorted soonest-visit-first — the next thing on the calendar is top.
  const visitBooked = useMemo<RankedLead[]>(() => {
    return jobs
      .filter((j) => j.status === 'lead' && !hasWrapUpData(j) && nextVisitByJob.has(j.id))
      .map((j) => rankBy(j, 'lastContactedDate'))
      .sort((a, b) => {
        const av = nextVisitByJob.get(a.job.id)!;
        const bv = nextVisitByJob.get(b.job.id)!;
        return `${av.date}${av.startTime ?? ''}`.localeCompare(`${bv.date}${bv.startTime ?? ''}`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, today, nextVisitByJob]);

  const newEnquiries = useMemo<RankedLead[]>(() => {
    return jobs
      .filter((j) => j.status === 'lead' && !hasWrapUpData(j) && !nextVisitByJob.has(j.id))
      .map((j) => rankBy(j, 'lastContactedDate'))
      .sort((a, b) => b.daysSinceContact - a.daysSinceContact);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, today, nextVisitByJob]);

  // Apply the insights panel's work-type filter to the chase-list too, so
  // picking "Cedar" focuses the whole page on cedar leads. 'all' = no-op.
  // Jobs with no work-type only show under 'all' (we can't honestly file an
  // untyped lead under a specific type).
  const fToQuote = useMemo(
    () => toQuote.filter((r) => workFilter === 'all' || r.job.workType === workFilter),
    [toQuote, workFilter]);
  const fVisitBooked = useMemo(
    () => visitBooked.filter((r) => workFilter === 'all' || r.job.workType === workFilter),
    [visitBooked, workFilter]);
  const fAwaitingReply = useMemo(
    () => awaitingReply.filter((r) => workFilter === 'all' || r.job.workType === workFilter),
    [awaitingReply, workFilter]);
  const fNewEnquiries = useMemo(
    () => newEnquiries.filter((r) => workFilter === 'all' || r.job.workType === workFilter),
    [newEnquiries, workFilter]);

  // Unfiltered open count — lets the empty state tell "no leads at all" apart
  // from "no leads of the type you've filtered to".
  const totalOpenUnfiltered =
    toQuote.length + visitBooked.length + awaitingReply.length + newEnquiries.length;

  // Top-strip stats summarise across all three (filtered) buckets. Pipeline
  // value is still useful as a single rolled-up number; coldOrDead now counts
  // anything (in any bucket) that's been waiting too long.
  const stats = useMemo(() => {
    const all = [...fToQuote, ...fVisitBooked, ...fAwaitingReply, ...fNewEnquiries];
    const openCount = all.length;
    const pipelineValue = all.reduce((sum, r) => {
      // Use quoteAmount when we have it (more reliable); otherwise the
      // estimatedValue Brad jotted when logging the enquiry.
      return sum + (r.job.quoteAmount ?? r.job.estimatedValue ?? 0);
    }, 0);
    const coldOrDead = all.filter((r) => r.temperature === 'cold' || r.temperature === 'dead').length;
    return { openCount, pipelineValue, coldOrDead };
  }, [fToQuote, fVisitBooked, fAwaitingReply, fNewEnquiries]);

  function markContacted(jobId: string) {
    // Stamp "now" as the last contact moment. The chase-list re-ranks
    // immediately because the store update flows through useMemo above.
    updateJob(jobId, { lastContactedDate: new Date().toISOString() });
  }

  function handleAddLead(data: Omit<Job, 'id' | 'businessId' | 'createdAt' | 'updatedAt'>) {
    addJob({
      id: `job_${Date.now()}`,
      businessId: businessId ?? '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data,
    });
    setShowAddLead(false);
  }

  function markLost(jobId: string) {
    // Close the loop on a quote that never got a reply. Only offered
    // when the follow-up ladder says the lead is dead (a week of
    // silence after the "either way" message). Recoverable from the
    // job detail sheet if the client resurfaces.
    updateJob(jobId, { status: 'lost', lostReason: 'no-reply' });
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Leads"
        subtitle={
          stats.openCount === 0
            ? 'No open leads right now'
            : `${stats.openCount} open · ${formatNZD(stats.pipelineValue)} pipeline`
        }
        action={
          <Button size="sm" className="bg-primary h-9" onClick={() => setShowAddLead(true)}>
            <Plus size={16} className="mr-1" /> Add lead
          </Button>
        }
      />

      <div className="px-4 md:px-6 space-y-4 pb-8">
        {/* Insights — collapsible pipeline analytics (win rate, leads/week,
            by type, by source) with a work-type filter that also scopes the
            chase-list below. Renders over ALL jobs, so it's useful even on a
            quiet week with no open leads. */}
        <LeadInsights
          jobs={jobs}
          filter={workFilter}
          onFilter={setWorkFilter}
          open={insightsOpen}
          onToggle={() => setInsightsOpen((v) => !v)}
          onSelectJob={setOpenJob}
        />

        {/* Summary strip — quick stats. Only shown when there's data;
            empty state below covers the zero case. */}
        {stats.openCount > 0 && (
          <div className="grid grid-cols-3 gap-2.5">
            <SummaryCard
              label="Open"
              value={String(stats.openCount)}
              icon={<Inbox size={14} className="text-blue-500" strokeWidth={1.8} />}
            />
            <SummaryCard
              label="Pipeline"
              value={formatNZDShort(stats.pipelineValue)}
              icon={<Sparkles size={14} className="text-amber-500" strokeWidth={1.8} />}
            />
            <SummaryCard
              label="Need chasing"
              value={String(stats.coldOrDead)}
              icon={<Snowflake size={14} className="text-slate-500" strokeWidth={1.8} />}
              tone={stats.coldOrDead > 0 ? 'warn' : undefined}
            />
          </div>
        )}

        {/* Empty state — nothing in any bucket. Soft tone because
            "no leads to chase" is also a perfectly normal "quiet
            week" state, not an error. */}
        {stats.openCount === 0 && totalOpenUnfiltered === 0 && (
          <EmptyState
            icon={Inbox}
            title="No leads right now"
            description="When you log an enquiry on the Entry page, it'll show up here. Once you've done a site visit, the job moves into 'To quote' so you know what to prepare next."
            action={
              <Link href="/entry?type=enquiry">
                <Button variant="outline">Log an enquiry</Button>
              </Link>
            }
          />
        )}

        {/* Filtered to a type that has no open leads — distinct from the
            "no leads at all" state above; offer a one-tap way back. */}
        {stats.openCount === 0 && totalOpenUnfiltered > 0 && (
          <div className="rounded-xl border border-border bg-muted/30 px-4 py-6 text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              No open <span className="font-medium text-foreground">{workFilter}</span> leads right now.
            </p>
            <Button variant="outline" size="sm" onClick={() => setWorkFilter('all')}>
              Show all leads
            </Button>
          </div>
        )}

        {/* Three sections — render order matches the natural funnel
            order (to quote → awaiting reply → new enquiries), but
            'To quote' is the visually-promoted bucket because it's
            where action is most needed. Each section hides when
            empty to keep the page tight. */}
        <FunnelSection
          icon={FileText}
          iconClass="text-amber-600 bg-amber-50"
          title="To quote"
          subtitle="Site visit done — customer's waiting on a quote"
          items={fToQuote}
          emptyHint={null /* hide when empty */}
          renderItem={(r) => (
            <LeadCard
              key={r.job.id}
              ranked={r}
              variant="to-quote"
              onMarkContacted={() => markContacted(r.job.id)}
              onBookVisit={() => setVisitForJob(r.job)}
              onMarkQuoted={() => setMarkQuotedForJob(r.job)}
              onOpen={() => setOpenJob(r.job)}
            />
          )}
        />

        <FunnelSection
          icon={CalendarCheck}
          iconClass="text-emerald-600 bg-emerald-50"
          title="Visit booked"
          subtitle="Site visit scheduled — turn up, then quote"
          items={fVisitBooked}
          emptyHint={null}
          renderItem={(r) => (
            <LeadCard
              key={r.job.id}
              ranked={r}
              variant="visit-booked"
              bookedVisit={nextVisitByJob.get(r.job.id)}
              onMarkContacted={() => markContacted(r.job.id)}
              onBookVisit={() => setVisitForJob(r.job)}
              onOpen={() => setOpenJob(r.job)}
            />
          )}
        />

        <FunnelSection
          icon={Send}
          iconClass="text-blue-600 bg-blue-50"
          title="Quoted, awaiting reply"
          subtitle="Quote sent — chase if they go quiet"
          items={fAwaitingReply}
          emptyHint={null}
          renderItem={(r) => (
            <LeadCard
              key={r.job.id}
              ranked={r}
              variant="awaiting-reply"
              followUp={followUpByJob.get(r.job.id)}
              onMarkContacted={() => markContacted(r.job.id)}
              onBookVisit={() => setVisitForJob(r.job)}
              onMarkLost={() => markLost(r.job.id)}
              onOpen={() => setOpenJob(r.job)}
            />
          )}
        />

        <FunnelSection
          icon={Inbox}
          iconClass="text-violet-600 bg-violet-50"
          title="New enquiries"
          subtitle="No site visit booked yet — book one to qualify"
          items={fNewEnquiries}
          emptyHint={null}
          renderItem={(r) => (
            <LeadCard
              key={r.job.id}
              ranked={r}
              variant="new-enquiry"
              onMarkContacted={() => markContacted(r.job.id)}
              onBookVisit={() => setVisitForJob(r.job)}
              onOpen={() => setOpenJob(r.job)}
            />
          )}
        />
      </div>

      {/* Add a lead by hand — for enquiries that didn't arrive via the
          website form or Tapi (phone, walk-in, referral). Reuses the shared
          JobForm with lead-friendly defaults (status = lead, today's date). */}
      <Sheet open={showAddLead} onOpenChange={setShowAddLead}>
        <SheetContent side="bottom" className="h-[92vh] overflow-y-auto rounded-t-2xl px-4 pb-10">
          <SheetHeader className="pb-4">
            <SheetTitle>New lead</SheetTitle>
          </SheetHeader>
          <JobForm
            defaultValues={{ status: 'lead', leadDate: todayISO }}
            onSave={handleAddLead}
            onCancel={() => setShowAddLead(false)}
          />
        </SheetContent>
      </Sheet>

      {/* Reuse the existing job sheet for full detail. Keeps the leads
          page focused on the chase action without re-implementing the
          whole job-detail view. */}
      <JobDetailSheet
        job={openJob}
        open={openJob !== null}
        onClose={() => setOpenJob(null)}
      />

      {/* Mark-as-quoted shortcut sheet — opens directly from the
          To-quote section's secondary CTA when the user prepared
          the quote outside the app. The same sheet that lives on
          the JobDetail; just hoisted up here so we don't have to
          open the detail first. */}
      <MarkAsQuotedSheet
        open={markQuotedForJob !== null}
        job={markQuotedForJob}
        onSaved={() => setMarkQuotedForJob(null)}
        onCancel={() => setMarkQuotedForJob(null)}
      />

      {/* Book-visit sheet — shared with the Home screen's "site visit
          arranged?" flow. Owns its own save (adds the quote_visit
          schedule item, bumps lastContactedDate, downloads the .ics). */}
      <BookVisitSheet
        job={visitForJob}
        open={visitForJob !== null}
        onSaved={() => setVisitForJob(null)}
        onCancel={() => setVisitForJob(null)}
      />
    </div>
  );
}

// ─── Lead card ─────────────────────────────────────────────────────────────

interface LeadCardProps {
  ranked: RankedLead;
  /**
   * Which funnel bucket this card lives in. Drives which primary
   * action shows up in the action row:
   *   to-quote       → 'Prep quote' + 'Mark quoted' (side-by-side)
   *   awaiting-reply → Call / Email (chase the already-sent quote; no
   *                    'Book visit' since the site visit is already done)
   *   new-enquiry    → 'Book visit' is the primary CTA
   *
   * Defaults to 'awaiting-reply' for backward compat in case a caller
   * hasn't been updated yet. The other action buttons stay available
   * across all variants — only the primary changes.
   */
  variant?: 'to-quote' | 'awaiting-reply' | 'new-enquiry' | 'visit-booked';
  /** Follow-up ladder stage for awaiting-reply cards (undefined = nothing
   *  due right now). Drives the stage pill + the Mark lost action. */
  followUp?: QuoteFollowUp;
  onMarkContacted: () => void;
  onBookVisit: () => void;
  /** Mark the job lost (no reply). Only rendered when the follow-up
   *  ladder reaches the 'close' stage. */
  onMarkLost?: () => void;
  /** Open the inline 'Mark as quoted' sheet. Only meaningful for
   *  to-quote variant — others ignore it. Optional so existing
   *  awaiting-reply / new-enquiry callers don't have to pass it. */
  onMarkQuoted?: () => void;
  /** The upcoming quote_visit for this lead — only passed for the
   *  'visit-booked' variant. Drives the date badge + 'Reschedule' label. */
  bookedVisit?: ScheduleItem;
  onOpen: () => void;
}

function LeadCard({
  ranked, variant = 'awaiting-reply', followUp,
  onMarkContacted, onBookVisit, onMarkQuoted, onMarkLost, onOpen, bookedVisit,
}: LeadCardProps) {
  const { job, daysSinceContact, temperature } = ranked;
  // Two-tap Mark lost — first tap arms, second confirms. Fat-finger
  // protection without a modal (5:30pm rule).
  const [lostArmed, setLostArmed] = useState(false);
  const value = job.quoteAmount ?? job.estimatedValue;
  const sourceCfg = job.source ? SOURCE_PILL[job.source] : null;
  // 'To quote' rows: also show the promised delivery date as a
  // pill so Brad sees urgency at a glance.
  const quoteReadyBy = variant === 'to-quote' ? job.quoteReadyBy : undefined;

  return (
    <div
      className={cn(
        'bg-card rounded-2xl border transition-colors',
        // Border tone matches temperature so the eye lands on dead ones first.
        temperature === 'dead' && 'border-red-200 bg-red-50/30',
        temperature === 'cold' && 'border-amber-200',
        temperature === 'warm' && 'border-border',
        temperature === 'hot'  && 'border-border',
      )}
    >
      {/* Header row — opens the full job sheet on tap. Keeping the tap
          target the whole row title region matches the Jobs list pattern. */}
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left p-4 pb-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-foreground truncate">{job.name}</h3>
              <StatusChip status={job.status} />
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">{job.clientName}</p>
            {job.location && (
              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                <MapPin size={11} strokeWidth={1.8} /> {job.location}
              </p>
            )}
          </div>
          <TemperatureBadge temperature={temperature} days={daysSinceContact} />
        </div>

        {/* Pills row — source + value if we have either. Plus a
            quoteReadyBy chip on to-quote rows so Brad sees the
            promised delivery date inline. */}
        {(sourceCfg || value || quoteReadyBy || bookedVisit || followUp) && (
          <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
            {followUp && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold',
                  followUp.stage === 'first' && 'bg-amber-50 text-amber-700',
                  followUp.stage === 'second' && 'bg-orange-50 text-orange-700',
                  followUp.stage === 'close' && 'bg-red-50 text-red-700',
                )}
                title={`Quoted ${followUp.daysSinceSent} day${followUp.daysSinceSent === 1 ? '' : 's'} ago`}
              >
                <Send size={11} strokeWidth={2} />
                {followUp.stage === 'first' && '1st follow-up due'}
                {followUp.stage === 'second' && '2nd follow-up due'}
                {followUp.stage === 'close' && 'No reply — mark lost?'}
              </span>
            )}
            {bookedVisit && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 text-[11px] text-emerald-700 font-medium">
                <CalendarCheck size={11} strokeWidth={2} />
                Visit {formatDueDate(bookedVisit.date)}{bookedVisit.startTime ? `, ${bookedVisit.startTime}` : ''}
              </span>
            )}
            {quoteReadyBy && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 text-[11px] text-amber-700 font-medium">
                <CalendarDays size={11} strokeWidth={2} />
                Quote by {formatDueDate(quoteReadyBy)}
              </span>
            )}
            {sourceCfg && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted text-[11px] text-muted-foreground font-medium">
                <sourceCfg.Icon size={11} strokeWidth={2} />
                {sourceCfg.label}
              </span>
            )}
            {value !== undefined && value > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 text-[11px] text-emerald-700 font-medium">
                {formatNZD(value)}
              </span>
            )}
          </div>
        )}
      </button>

      {/* Action row — split into two tiers so we don't cram 5 buttons
          into one row on a phone. Top tier = the "primary CTA" row.
          Bottom tier = small utility actions.

          The primary CTA varies by variant:
            to-quote       → 'Prep quote' (opens the job detail; AI in S3)
            new-enquiry    → 'Book visit' (the original chase-list flow)
            awaiting-reply → Call / Email (chase the sent quote; no
                             'Book visit' — the site visit's already done) */}
      <div className="border-t border-border/60 px-2 py-1.5 space-y-1">
        <div className="flex items-center gap-1">
          {variant === 'to-quote' ? (
            // To-quote variant: two side-by-side primary CTAs. The
            // AI flow lives behind 'Prep quote' (opens the job →
            // PrepWithAISheet). 'Mark quoted' is the escape hatch
            // when the quote was drafted outside the app — opens
            // MarkAsQuotedSheet directly without the job detour.
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen();
                }}
                className="flex-1 min-h-[40px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-xs font-semibold text-primary bg-primary/10 hover:bg-primary/15 transition-colors"
                title="Open the job to prep the quote"
              >
                <FileText size={13} strokeWidth={2} /> Prep quote
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onMarkQuoted?.();
                }}
                disabled={!onMarkQuoted}
                className="flex-1 min-h-[40px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-xs font-semibold text-foreground bg-card border border-border hover:bg-accent transition-colors disabled:opacity-50"
                title="Already sent the quote? Mark it as quoted and optionally attach the PDF"
              >
                <Send size={13} strokeWidth={2} /> Mark quoted
              </button>
            </>
          ) : (
            <>
              {/* Book visit — only for variants where a site visit is still
                  ahead (new-enquiry books one, visit-booked reschedules).
                  Deliberately omitted for awaiting-reply: the quote is sent
                  AFTER the visit, so offering to book one then is backwards.
                  Call / Email below become the primary chase actions. */}
              {variant !== 'awaiting-reply' && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onBookVisit();
                  }}
                  className="flex-1 min-h-[40px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-xs font-semibold text-primary bg-primary/10 hover:bg-primary/15 transition-colors"
                  title={variant === 'visit-booked' ? 'Reschedule the site visit' : 'Book a site visit and download a calendar invite'}
                >
                  <CalendarPlus size={13} strokeWidth={2} /> {variant === 'visit-booked' ? 'Reschedule' : 'Book visit'}
                </button>
              )}
              {job.clientPhone && (
                <a
                  href={`tel:${job.clientPhone}`}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 min-h-[40px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-xs font-medium text-foreground hover:bg-accent transition-colors"
                  title={`Call ${job.clientName}`}
                >
                  <Phone size={13} strokeWidth={1.8} /> Call
                </a>
              )}
              {job.clientEmail && (
                <a
                  href={gmailComposeUrl(job.clientEmail)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 min-h-[40px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-xs font-medium text-foreground hover:bg-accent transition-colors"
                  title={`Email ${job.clientName} in Gmail`}
                >
                  <Mail size={13} strokeWidth={1.8} /> Email
                </a>
              )}
            </>
          )}
        </div>
        {/* Secondary row — fallback utilities. Smaller, less prominent.
            For to-quote, Call/Email move down here (the primary row is
            taken by Prep quote + Mark quoted). For other variants, Call
            and Email already live in the primary row above. */}
        <div className="flex items-center gap-1">
          {variant === 'to-quote' && job.clientPhone && (
            <a
              href={`tel:${job.clientPhone}`}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 min-h-[36px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title={`Call ${job.clientName}`}
            >
              <Phone size={12} strokeWidth={1.8} /> Call
            </a>
          )}
          {variant === 'to-quote' && job.clientEmail && (
            <a
              href={gmailComposeUrl(job.clientEmail)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex-1 min-h-[36px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title={`Email ${job.clientName} in Gmail`}
            >
              <Mail size={12} strokeWidth={1.8} /> Email
            </a>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMarkContacted();
            }}
            className="flex-1 min-h-[36px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="Mark as contacted now — resets the staleness timer without booking anything"
          >
            <MessageCircle size={12} strokeWidth={1.8} /> Mark contacted
          </button>
          {followUp?.stage === 'close' && onMarkLost && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (!lostArmed) {
                  setLostArmed(true);
                  setTimeout(() => setLostArmed(false), 4000);
                } else {
                  onMarkLost();
                }
              }}
              className={cn(
                'flex-1 min-h-[36px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-[11px] font-semibold transition-colors',
                lostArmed
                  ? 'bg-red-600 text-white'
                  : 'text-red-700 bg-red-50 hover:bg-red-100',
              )}
              title="Mark this job as lost (no reply). Recoverable from the job detail."
            >
              <X size={12} strokeWidth={2} /> {lostArmed ? 'Sure?' : 'Mark lost'}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="min-h-[36px] inline-flex items-center justify-center gap-0.5 px-2 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="Open full job detail"
          >
            Details <ChevronRight size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Temperature badge ─────────────────────────────────────────────────────

function TemperatureBadge({ temperature, days }: { temperature: Temperature; days: number }) {
  // Pick an icon + tone that matches the temperature. The "days" number
  // lives inside the badge so the eye gets a single colour-coded signal
  // instead of having to read two separate elements.
  const config = {
    hot:  { label: daysLabel(days), Icon: Flame,     className: 'bg-green-50 text-green-700 border-green-200' },
    warm: { label: daysLabel(days), Icon: Clock,     className: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
    cold: { label: daysLabel(days), Icon: Snowflake, className: 'bg-amber-50 text-amber-700 border-amber-200' },
    dead: { label: daysLabel(days), Icon: Snowflake, className: 'bg-red-50 text-red-700 border-red-200' },
  }[temperature];

  const { Icon, className, label } = config;
  return (
    <span
      className={cn(
        'shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-semibold whitespace-nowrap',
        className,
      )}
      title={`Last contact: ${days} day${days === 1 ? '' : 's'} ago`}
    >
      <Icon size={12} strokeWidth={2} />
      {label}
    </span>
  );
}

function daysLabel(days: number): string {
  if (days === 0) return 'Today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

// ─── Status chip (mini) ────────────────────────────────────────────────────

function StatusChip({ status }: { status: Job['status'] }) {
  // Small, low-contrast pill — the status isn't the primary signal on
  // this page (temperature is) but it's useful context for distinguishing
  // a fresh enquiry from one that's already been quoted.
  const label = status === 'quoted' ? 'Quoted' : 'New lead';
  const className = status === 'quoted'
    ? 'bg-blue-50 text-blue-700'
    : 'bg-violet-50 text-violet-700';
  return (
    <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', className)}>
      {label}
    </span>
  );
}

// ─── Funnel section ────────────────────────────────────────────────────────
// Generic wrapper around a list of LeadCards. Renders a header strip
// (icon + title + subtitle + count badge) and the cards below. Hides
// itself entirely when the list is empty AND no emptyHint was passed,
// per the AGENTS.md "no empty visualisations" rule. Pass an emptyHint
// string if you want the section to keep showing with a soft message
// (e.g. on the To-quote section we might say "you're caught up" — but
// for v1 we just hide).

interface FunnelSectionProps {
  icon: React.ElementType;
  iconClass: string;
  title: string;
  subtitle: string;
  items: RankedLead[];
  emptyHint: string | null;
  renderItem: (r: RankedLead) => React.ReactNode;
}

function FunnelSection({
  icon: Icon, iconClass, title, subtitle, items, emptyHint, renderItem,
}: FunnelSectionProps) {
  if (items.length === 0 && !emptyHint) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2.5 px-0.5">
        <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', iconClass)}>
          <Icon size={14} strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {items.length > 0 && (
              <span className="text-[11px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded-md">
                {items.length}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground leading-snug">{subtitle}</p>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground italic px-2 py-3">{emptyHint}</p>
      ) : (
        <div className="space-y-2">
          {items.map(renderItem)}
        </div>
      )}
    </section>
  );
}

// ─── Summary card ──────────────────────────────────────────────────────────

interface SummaryCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  tone?: 'warn';
}

function SummaryCard({ label, value, icon, tone }: SummaryCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        tone === 'warn'
          ? 'bg-amber-50/60 border-amber-200'
          : 'bg-card border-border',
      )}
    >
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon} {label}
      </div>
      <p className="text-lg font-bold text-foreground mt-1 leading-none">{value}</p>
    </div>
  );
}

// ─── Money + date formatters ──────────────────────────────────────────────

function formatNZD(n: number): string {
  return `$${n.toLocaleString('en-NZ', { maximumFractionDigits: 0 })}`;
}

/**
 * Short "Mon 24" / "Today" / "Tomorrow" / "Overdue" style label for the
 * quote-ready-by chip on To-quote cards. Optimised for the at-a-glance
 * read: Brad wants to know whether he's behind, on time, or has a few
 * days' breathing room — not the exact date.
 */
function formatDueDate(iso: string): string {
  // ISO YYYY-MM-DD; parse as local-time so a date string of "2026-05-25"
  // doesn't read as midnight UTC and get pushed to the wrong day.
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return `Overdue (${Math.abs(diffDays)}d)`;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays < 7) return date.toLocaleDateString('en-NZ', { weekday: 'short' });
  return date.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
}

// Short form — $12.5k instead of $12,500 — for the summary cards
// where vertical real estate matters more than precision.
function formatNZDShort(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `$${n}`;
}
