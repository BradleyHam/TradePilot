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
import { Job, LeadSource, ScheduleItem } from '@/lib/types';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { JobDetailSheet } from '@/components/jobs/job-detail-sheet';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import {
  Phone, Mail, MapPin, MessageCircle, Sparkles, Snowflake, Flame, Clock,
  ChevronRight, Globe, Search, UserPlus, Inbox, CalendarPlus, CalendarDays,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { downloadIcs } from '@/lib/ics';

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
  const { jobs, updateJob, addScheduleItem, businessId } = useStore();
  const [openJob, setOpenJob] = useState<Job | null>(null);
  // When set, the BookVisitSheet opens for this lead.
  const [visitForJob, setVisitForJob] = useState<Job | null>(null);

  // Build the ranked list. Memoised because the list re-renders on
  // any store update (mark-contacted bumps a job's timestamp) and we
  // don't want to repeat the sort on unrelated state changes.
  const ranked = useMemo<RankedLead[]>(() => {
    const today = new Date();
    return jobs
      .filter((j) => j.status === 'lead' || j.status === 'quoted')
      .map((j): RankedLead => {
        // Fall back to createdAt when lastContactedDate is null — keeps
        // the chase-list legible for leads that pre-date this column.
        const contactRef = j.lastContactedDate ?? j.createdAt;
        const days = daysSince(contactRef, today);
        return {
          job: j,
          daysSinceContact: days,
          contactRef,
          temperature: temperatureOf(days),
        };
      })
      // Coldest first. The whole UX premise is "the lead most at risk
      // is the lead you should look at first".
      .sort((a, b) => b.daysSinceContact - a.daysSinceContact);
  }, [jobs]);

  // Top-strip stats. Deliberately limited to numbers that mean something
  // even at low volume — pipeline $ and source breakdown both make sense
  // from N=1, unlike conversion rates which need a sample size.
  const stats = useMemo(() => {
    const openCount = ranked.length;
    const pipelineValue = ranked.reduce((sum, r) => {
      // Use quoteAmount when we have it (more reliable); otherwise the
      // estimatedValue Brad jotted when logging the enquiry.
      return sum + (r.job.quoteAmount ?? r.job.estimatedValue ?? 0);
    }, 0);
    const coldOrDead = ranked.filter((r) => r.temperature === 'cold' || r.temperature === 'dead').length;
    return { openCount, pipelineValue, coldOrDead };
  }, [ranked]);

  function markContacted(jobId: string) {
    // Stamp "now" as the last contact moment. The chase-list re-ranks
    // immediately because the store update flows through useMemo above.
    updateJob(jobId, { lastContactedDate: new Date().toISOString() });
  }

  /**
   * Save a booked site visit for the given lead. Three things happen:
   *
   *   1. A schedule_item of type 'quote_visit' is added so it shows up
   *      on the Schedule tab and the upcoming-work surfaces.
   *   2. The lead's lastContactedDate is bumped — booking a visit IS
   *      contact, and the chase-list shouldn't keep nagging about a
   *      lead Brad has actively engaged with.
   *   3. The .ics file is downloaded so the user can add it to their
   *      phone's calendar for native reminders.
   *
   * The sheet closes on success so the leads page returns to the chase
   * list. If any of the three steps fail, the others still run — the
   * schedule_item is the most important, and partial success here is
   * better than refusing to do anything.
   */
  function handleSaveVisit(input: {
    date: string;       // YYYY-MM-DD
    startTime: string;  // HH:mm
    endTime?: string;
    notes?: string;
  }) {
    if (!visitForJob) return;
    const job = visitForJob;
    // Real uuid because schedule_items.id is a uuid column in Supabase.
    // Generating a string like `sch_<ts>` would work for the insert (the
    // store's id-swap reconciles it), but any update that races ahead of
    // the insert response would hit Postgres' 22P02 "invalid input
    // syntax for uuid" error. uuid from the start = no race window.
    const scheduleItemId = crypto.randomUUID();
    const title = `Site visit — ${job.name}`;

    // Save & download is one atomic action from the user's POV — the
    // sheet text literally says "Saving downloads a calendar invite".
    // So we flag icsDownloaded=true at creation, no second store write
    // needed. If the download itself throws (unlikely — Blob URLs don't
    // fail in modern browsers), the flag would be optimistic but harmless:
    // the user can re-trigger from the badge on the schedule row.
    addScheduleItem({
      id: scheduleItemId,
      businessId: businessId ?? '',
      jobId: job.id,
      type: 'quote_visit',
      title,
      date: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      notes: input.notes,
      completed: false,
      icsDownloaded: true,
      createdAt: new Date().toISOString(),
    });

    updateJob(job.id, { lastContactedDate: new Date().toISOString() });

    // Build the calendar invite. Local-time Date constructed from the
    // form inputs — no UTC funny business so the calendar event lands
    // on the wall-clock time Brad picked.
    const [y, m, d] = input.date.split('-').map(Number);
    const [hh, mm] = input.startTime.split(':').map(Number);
    const start = new Date(y, m - 1, d, hh, mm);
    let end: Date | undefined;
    if (input.endTime) {
      const [eh, em] = input.endTime.split(':').map(Number);
      end = new Date(y, m - 1, d, eh, em);
    }

    downloadIcs({
      // Stable UID = the schedule_item id, so re-downloading later
      // (via the badge on the schedule row) updates the same calendar
      // event rather than creating a duplicate.
      uid: `${scheduleItemId}@tradepilot`,
      title,
      start,
      end,
      location: job.location,
      description: [
        job.clientName && `Client: ${job.clientName}`,
        job.clientPhone && `Phone: ${job.clientPhone}`,
        input.notes,
      ].filter(Boolean).join('\n'),
    });

    setVisitForJob(null);
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
      />

      <div className="px-4 md:px-6 space-y-4 pb-8">
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

        {/* Empty state — no open leads. Soft tone since this is also
            a perfectly normal state (nothing to chase = quiet week,
            which is fine). */}
        {stats.openCount === 0 && (
          <EmptyState
            icon={Inbox}
            title="No leads to chase"
            description="When you log an enquiry on the Entry page, it'll show up here. Open leads sit at the top — the coldest ones first — so you always know who to follow up with."
            action={
              <Link href="/entry?type=enquiry">
                <Button variant="outline">Log an enquiry</Button>
              </Link>
            }
          />
        )}

        {/* Chase list */}
        {ranked.map((r) => (
          <LeadCard
            key={r.job.id}
            ranked={r}
            onMarkContacted={() => markContacted(r.job.id)}
            onBookVisit={() => setVisitForJob(r.job)}
            onOpen={() => setOpenJob(r.job)}
          />
        ))}
      </div>

      {/* Reuse the existing job sheet for full detail. Keeps the leads
          page focused on the chase action without re-implementing the
          whole job-detail view. */}
      <JobDetailSheet
        job={openJob}
        open={openJob !== null}
        onClose={() => setOpenJob(null)}
      />

      {/* Book-visit sheet — small focused form. Inline rather than a
          shared component because the leads flow has lead-specific
          defaults (title prefilled with the job name, calendar invite
          downloaded automatically on save) that don't make sense as
          options on a generic schedule-add form. */}
      <BookVisitSheet
        job={visitForJob}
        open={visitForJob !== null}
        onSave={handleSaveVisit}
        onCancel={() => setVisitForJob(null)}
      />
    </div>
  );
}

// ─── Book-visit sheet ─────────────────────────────────────────────────────

interface BookVisitSheetProps {
  job: Job | null;
  open: boolean;
  onSave: (input: { date: string; startTime: string; endTime?: string; notes?: string }) => void;
  onCancel: () => void;
}

function BookVisitSheet({ job, open, onSave, onCancel }: BookVisitSheetProps) {
  // Sensible defaults — tomorrow 9am, hour-long visit. Most site visits
  // get booked for the next morning, and a one-hour slot is roughly the
  // right size for a quote visit. The user can change any of it.
  const tomorrow = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }, []);

  const [date, setDate] = useState(tomorrow);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [notes, setNotes] = useState('');

  // Reset state whenever the sheet reopens for a different lead. Without
  // this, leftover notes/dates from a previous booking would persist.
  useMemo(() => {
    if (open) {
      setDate(tomorrow);
      setStartTime('09:00');
      setEndTime('10:00');
      setNotes('');
    }
  }, [open, tomorrow]);

  function handleSubmit() {
    onSave({ date, startTime, endTime: endTime || undefined, notes: notes.trim() || undefined });
  }

  if (!job) return null;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>Book site visit</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-3 pb-4">
          {/* Job context — read-only summary so the user can confirm they're
              booking against the right lead before tapping save. */}
          <div className="rounded-xl bg-muted/40 border border-border px-3 py-2.5">
            <p className="text-sm font-medium text-foreground">{job.name}</p>
            <p className="text-xs text-muted-foreground">{job.clientName}</p>
            {job.location && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <MapPin size={11} strokeWidth={1.8} /> {job.location}
              </p>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Date
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-input text-sm bg-background"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                Start
              </label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-input text-sm bg-background"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                End
              </label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-input text-sm bg-background"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Notes (optional)
            </label>
            <Textarea
              placeholder="e.g. Check cedar condition on north face. Bring colour swatches."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="resize-none text-sm"
              rows={3}
            />
          </div>

          <p className="text-xs text-muted-foreground leading-snug">
            <CalendarDays size={12} className="inline mr-1 -mt-0.5" />
            Saving downloads a calendar invite with reminders the night before
            and 1 hour before. Add it to your phone's calendar to get the alerts.
          </p>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              className="flex-1 bg-primary"
              onClick={handleSubmit}
              disabled={!date || !startTime}
            >
              Save & download
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Lead card ─────────────────────────────────────────────────────────────

interface LeadCardProps {
  ranked: RankedLead;
  onMarkContacted: () => void;
  onBookVisit: () => void;
  onOpen: () => void;
}

function LeadCard({ ranked, onMarkContacted, onBookVisit, onOpen }: LeadCardProps) {
  const { job, daysSinceContact, temperature } = ranked;
  const value = job.quoteAmount ?? job.estimatedValue;
  const sourceCfg = job.source ? SOURCE_PILL[job.source] : null;

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

        {/* Pills row — source + value if we have either */}
        {(sourceCfg || value) && (
          <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
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
          into one row on a phone. Top tier = the "primary CTA" row
          (Book visit + the reach-out actions). Bottom tier = small
          utility actions. */}
      <div className="border-t border-border/60 px-2 py-1.5 space-y-1">
        {/* Primary row — the things you actually came here to do. */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onBookVisit();
            }}
            className="flex-1 min-h-[40px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-xs font-semibold text-primary bg-primary/10 hover:bg-primary/15 transition-colors"
            title="Book a site visit and download a calendar invite"
          >
            <CalendarPlus size={13} strokeWidth={2} /> Book visit
          </button>
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
              href={`mailto:${job.clientEmail}`}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 min-h-[40px] inline-flex items-center justify-center gap-1.5 px-2 rounded-lg text-xs font-medium text-foreground hover:bg-accent transition-colors"
              title={`Email ${job.clientName}`}
            >
              <Mail size={13} strokeWidth={1.8} /> Email
            </a>
          )}
        </div>
        {/* Secondary row — fallback utilities. Smaller, less prominent. */}
        <div className="flex items-center gap-1">
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

// ─── Money formatters ──────────────────────────────────────────────────────

function formatNZD(n: number): string {
  return `$${n.toLocaleString('en-NZ', { maximumFractionDigits: 0 })}`;
}

// Short form — $12.5k instead of $12,500 — for the summary cards
// where vertical real estate matters more than precision.
function formatNZDShort(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `$${n}`;
}
