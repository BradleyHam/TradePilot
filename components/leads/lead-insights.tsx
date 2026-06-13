'use client';

// Lead insights — the "how's my pipeline actually doing?" panel that sits
// above the chase-list on the Leads page. Deliberately a step back from the
// chase-list's "what do I do next?" focus: this answers "am I winning enough
// work, where's it coming from, and is it speeding up or slowing down?".
//
// Computes over ALL jobs (won / lost / open), not just open leads — win-rate
// and trend only mean anything across closed work. The chase-list below still
// shows open leads only.
//
// A work-type filter row at the top drives BOTH this panel and the chase-list
// (the parent lifts the filter state), so Brad can answer "how does my cedar
// work convert vs interior?" end to end.
//
// Charts are raw SVG / CSS bars on purpose — small, phone-first (~380px), no
// chart-library weight, and they degrade to nothing when a section has no
// data (no empty axes staring back at him — the golden UX rule).

import { useMemo, useState } from 'react';
import type { Job, JobStatus, WorkType, LeadSource } from '@/lib/types';
import { ChevronDown, BarChart3, X, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Win / loss vocabulary ───────────────────────────────────────────────────
// "Won" = the quote turned into real work (any status past 'quoted' that
// isn't 'lost'). "Lost" = explicitly lost. 'lead' / 'quoted' are still open
// and don't count either way — a quote you haven't heard back on isn't a loss
// yet, and counting it as one would make the win-rate read pessimistically.
const WON_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'accepted', 'booked', 'in-progress', 'completed', 'invoiced', 'paid',
]);
function isWon(j: Job): boolean { return WON_STATUSES.has(j.status); }
function isLost(j: Job): boolean { return j.status === 'lost'; }
function isClosed(j: Job): boolean { return isWon(j) || isLost(j); }

// When did this lead actually come in? Prefer the explicit lead date; fall
// back to createdAt (the row-creation date) when it hasn't been set. Imported
// jobs all share one createdAt, so the explicit leadDate is what makes the
// per-week trend honest.
function leadDayISO(j: Job): string | null {
  if (j.leadDate) return j.leadDate.slice(0, 10);
  if (j.createdAt) return j.createdAt.slice(0, 10);
  return null;
}
function leadMoment(j: Job): Date | null {
  // Plain dates get a midday local time so week-bucketing never slips a day
  // across the UTC boundary; timestamps parse as-is.
  const raw = j.leadDate ? `${j.leadDate.slice(0, 10)}T12:00:00` : j.createdAt;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

const WORK_TYPES: WorkType[] = ['interior', 'exterior', 'cedar', 'wallpaper', 'roof', 'mixed'];
const WORK_TYPE_LABEL: Record<WorkType, string> = {
  interior: 'Interior', exterior: 'Exterior', cedar: 'Cedar',
  wallpaper: 'Wallpaper', roof: 'Roof', mixed: 'Mixed',
};

const SOURCE_LABEL: Record<LeadSource, string> = {
  website: 'Website', email: 'Email', phone: 'Phone',
  referral: 'Referral', gmb: 'Google', manual: 'Manual',
};

const WEEKS_SHOWN = 8;

function moneyShort(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

/** Local YYYY-MM-DD for a date (no UTC shift). */
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The Monday (local) of the week containing d, as a Date. */
function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - dow);
  return x;
}

function addWeeks(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n * 7);
  return x;
}

/** Monday-start week key (YYYY-MM-DD of that Monday) for a date. */
function weekStartISO(d: Date): string {
  return isoOf(mondayOf(d));
}

/** First-of-month key (YYYY-MM-01) for a date. */
function monthStartISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

type Granularity = 'week' | 'month';

/** Bucket key for a date at the chosen granularity. */
function bucketKeyOf(d: Date, g: Granularity): string {
  return g === 'week' ? weekStartISO(d) : monthStartISO(d);
}

/** Short axis/label for a bucket key at the chosen granularity. */
function bucketLabel(key: string, g: Granularity): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d || 1);
  return g === 'week'
    ? date.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
    : date.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' });
}

// Cap how many bars we draw, so a wide window doesn't render hundreds of
// hair-thin bars. Beyond this we show the most recent N buckets in the window.
const MAX_WEEK_BARS = 16;
const MAX_MONTH_BARS = 24;

type TimeFrame = 'all' | '30d' | '90d' | 'year' | 'custom';

const TIMEFRAME_OPTIONS: { value: TimeFrame; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom' },
];


interface LeadInsightsProps {
  /** All jobs from the store (open + closed). */
  jobs: Job[];
  /** Active work-type filter, or 'all'. Lifted to the page so it also
   *  filters the chase-list. */
  filter: WorkType | 'all';
  onFilter: (f: WorkType | 'all') => void;
  /** Controlled open/closed so the parent can remember it if it wants. */
  open: boolean;
  onToggle: () => void;
  /** Open a job in the detail sheet — used by the per-week drill-down so a
   *  lead can be tapped straight through to its full record. */
  onSelectJob?: (job: Job) => void;
}

/** Won / lost / open badge styling for a job, shared by the drill-down list. */
function statusMeta(j: Job): { label: string; cls: string } {
  if (isWon(j)) return { label: 'Won', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
  if (isLost(j)) return { label: 'Lost', cls: 'bg-red-100 text-red-800 border-red-200' };
  return { label: 'Open', cls: 'bg-muted text-muted-foreground border-border' };
}

export function LeadInsights({ jobs, filter, onFilter, open, onToggle, onSelectJob }: LeadInsightsProps) {
  // Timeframe is local to the panel (it scopes the insights only, NOT the
  // chase-list — that's the work-type filter's job). Default 'all'.
  const [timeframe, setTimeframe] = useState<TimeFrame>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // Week vs month bars for the leads-over-time chart.
  const [granularity, setGranularity] = useState<Granularity>('week');
  // Drill-down: which bar (bucket key) is expanded, or null.
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);

  // Resolve the timeframe to an inclusive [start, end] date window (local
  // YYYY-MM-DD). null = unbounded on that side.
  const dateWindow = useMemo<{ start: string | null; end: string | null }>(() => {
    const today = new Date();
    const end = isoOf(today);
    switch (timeframe) {
      case '30d': return { start: isoOf(new Date(today.getTime() - 30 * 86400000)), end };
      case '90d': return { start: isoOf(new Date(today.getTime() - 90 * 86400000)), end };
      case 'year': return { start: `${today.getFullYear()}-01-01`, end };
      case 'custom': return { start: customFrom || null, end: customTo || null };
      default: return { start: null, end: null };
    }
  }, [timeframe, customFrom, customTo]);

  // Jobs in scope for the metrics: work-type filter + timeframe window. (We
  // never count jobs with no work-type into a specific type — only into "All".)
  const scoped = useMemo(() => {
    const { start, end } = dateWindow;
    return jobs.filter((j) => {
      if (filter !== 'all' && j.workType !== filter) return false;
      if (start || end) {
        const d = leadDayISO(j);
        if (!d) return false;
        if (start && d < start) return false;
        if (end && d > end) return false;
      }
      return true;
    });
  }, [jobs, filter, dateWindow]);

  // Which work-type chips to show — only types that actually appear in the
  // data, so a one-man painter isn't staring at empty "Roof" tabs.
  const typesPresent = useMemo(() => {
    const present = new Set<WorkType>();
    for (const j of jobs) if (j.workType) present.add(j.workType);
    return WORK_TYPES.filter((t) => present.has(t));
  }, [jobs]);

  // ── Win / loss ────────────────────────────────────────────────────────────
  const winLoss = useMemo(() => {
    const won = scoped.filter(isWon).length;
    const lost = scoped.filter(isLost).length;
    const closed = won + lost;
    const rate = closed > 0 ? Math.round((won / closed) * 100) : null;
    return { won, lost, closed, rate };
  }, [scoped]);

  // ── Leads over time (week or month buckets, spanning the timeframe) ─────────
  const perWeek = useMemo(() => {
    const g = granularity;
    const today = new Date();
    // Step a date to the start of its bucket, and to the next bucket.
    const startOf = (d: Date) => g === 'week'
      ? mondayOf(d)
      : new Date(d.getFullYear(), d.getMonth(), 1);
    const next = (d: Date) => g === 'week'
      ? addWeeks(d, 1)
      : new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const curBucket = bucketKeyOf(today, g);
    const lastStart = startOf(today);

    // First bucket: window start, else earliest scoped lead, else a sensible
    // default span back from now.
    let firstStart: Date;
    if (dateWindow.start) {
      firstStart = startOf(new Date(`${dateWindow.start}T12:00:00`));
    } else {
      const moments = scoped.map(leadMoment).filter((d): d is Date => d !== null)
        .sort((a, b) => a.getTime() - b.getTime());
      if (moments.length) firstStart = startOf(moments[0]);
      else firstStart = g === 'week' ? addWeeks(lastStart, -(WEEKS_SHOWN - 1))
        : new Date(today.getFullYear(), today.getMonth() - 5, 1);
    }
    let endStart = dateWindow.end ? startOf(new Date(`${dateWindow.end}T12:00:00`)) : lastStart;
    if (endStart > lastStart) endStart = lastStart;
    if (firstStart > endStart) firstStart = endStart;

    const allKeys: string[] = [];
    for (let c = new Date(firstStart); c <= endStart && allKeys.length < 300; c = next(c)) {
      allKeys.push(bucketKeyOf(c, g));
    }
    // Cap: most-recent N buckets if the window is huge.
    const cap = g === 'week' ? MAX_WEEK_BARS : MAX_MONTH_BARS;
    const keys = allKeys.length > cap ? allKeys.slice(-cap) : allKeys;

    const counts = new Map<string, number>(keys.map((k) => [k, 0]));
    for (const j of scoped) {
      const m = leadMoment(j);
      if (!m) continue;
      const k = bucketKeyOf(m, g);
      if (counts.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const data = keys.map((k) => ({ key: k, count: counts.get(k) ?? 0 }));
    const max = Math.max(1, ...data.map((d) => d.count));
    const total = data.reduce((s, d) => s + d.count, 0);
    return { data, max, total, curBucket };
  }, [scoped, dateWindow, granularity]);

  // The selected bucket is only "active" while it's still one of the visible
  // bars — changing the timeframe/type/granularity can reshuffle the bars out
  // from under it, in which case we ignore the stale selection (no effect /
  // setState-in-render needed). A fresh tap overwrites it.
  const activeWeek = (selectedWeek && perWeek.data.some((d) => d.key === selectedWeek))
    ? selectedWeek : null;

  // Leads that landed in the drilled-into bucket (within the current scope),
  // newest first. Drives the click-through list under the chart.
  const weekLeads = useMemo(() => {
    if (!activeWeek) return [];
    return scoped
      .filter((j) => { const m = leadMoment(j); return m !== null && bucketKeyOf(m, granularity) === activeWeek; })
      .sort((a, b) => (leadDayISO(b) || '').localeCompare(leadDayISO(a) || ''));
  }, [scoped, activeWeek, granularity]);

  // ── Breakdown by work type (only shown when not already type-filtered) ─────
  // Uses `scoped`, which when filter==='all' is exactly the timeframe window
  // across all types — so the breakdown respects the selected period.
  const byType = useMemo(() => {
    return typesPresent
      .map((t) => {
        const rows = scoped.filter((j) => j.workType === t);
        const won = rows.filter(isWon).length;
        const closed = rows.filter(isClosed).length;
        return { type: t, count: rows.length, won, closed, rate: closed > 0 ? Math.round((won / closed) * 100) : null };
      })
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [scoped, typesPresent]);

  const untyped = useMemo(() => scoped.filter((j) => !j.workType).length, [scoped]);

  // ── By source + avg quote value ────────────────────────────────────────────
  const bySource = useMemo(() => {
    const groups = new Map<string, { count: number; valueSum: number; valueN: number }>();
    for (const j of scoped) {
      const key = j.source ?? 'unknown';
      const g = groups.get(key) ?? { count: 0, valueSum: 0, valueN: 0 };
      g.count += 1;
      const v = j.quoteAmount ?? j.estimatedValue;
      if (typeof v === 'number' && v > 0) { g.valueSum += v; g.valueN += 1; }
      groups.set(key, g);
    }
    const rows = [...groups.entries()].map(([key, g]) => ({
      source: key,
      label: key === 'unknown' ? 'Uncategorised' : (SOURCE_LABEL[key as LeadSource] ?? key),
      count: g.count,
      avg: g.valueN > 0 ? g.valueSum / g.valueN : null,
    }));
    return rows.sort((a, b) => b.count - a.count);
  }, [scoped]);

  const maxSourceCount = Math.max(1, ...bySource.map((r) => r.count));

  // One-line summary for the collapsed header — the single most useful number.
  // Prefix the active work-type filter (if any) so a filtered chase-list below
  // never looks unexplained while the panel is collapsed.
  const baseSummary = winLoss.rate !== null
    ? `${winLoss.rate}% win rate · ${scoped.length} ${scoped.length === 1 ? 'lead' : 'leads'}`
    : `${scoped.length} ${scoped.length === 1 ? 'lead' : 'leads'}`;
  const headerSummary = filter === 'all'
    ? baseSummary
    : `${WORK_TYPE_LABEL[filter]} · ${baseSummary}`;

  // Nothing to show at all (fresh account) — render nothing.
  if (jobs.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-accent transition-colors text-left"
      >
        <div className="w-8 h-8 rounded-xl bg-violet-50 dark:bg-violet-950/40 flex items-center justify-center shrink-0">
          <BarChart3 size={16} className="text-violet-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">Insights</p>
          <p className="text-xs text-muted-foreground">{headerSummary}</p>
        </div>
        <ChevronDown
          size={16}
          className={cn('text-muted-foreground shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-5 border-t border-border pt-4">
          {/* Timeframe — preset pills + a custom range. Scopes the insights
              only (not the chase-list). Defaults to All time. */}
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {TIMEFRAME_OPTIONS.map((o) => (
                <FilterChip key={o.value} active={timeframe === o.value} onClick={() => setTimeframe(o.value)}>
                  {o.label}
                </FilterChip>
              ))}
            </div>
            {timeframe === 'custom' && (
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  aria-label="From date"
                  className="h-10 px-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                  aria-label="To date"
                  className="h-10 px-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}
          </div>

          {/* Work-type filter — drives this panel AND the chase-list below. */}
          {typesPresent.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <FilterChip active={filter === 'all'} onClick={() => onFilter('all')}>All</FilterChip>
              {typesPresent.map((t) => (
                <FilterChip key={t} active={filter === t} onClick={() => onFilter(t)}>
                  {WORK_TYPE_LABEL[t]}
                </FilterChip>
              ))}
            </div>
          )}

          {/* Empty period — one clear note instead of a stack of blank sections. */}
          {scoped.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No leads in this period{filter !== 'all' ? ` for ${WORK_TYPE_LABEL[filter]}` : ''}.
            </p>
          )}

          {/* Win / loss */}
          {scoped.length > 0 && (winLoss.closed > 0 ? (
            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Win rate</h3>
                <span className="text-xs text-muted-foreground">
                  {winLoss.won} won · {winLoss.lost} lost
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-2xl font-bold tabular-nums">{winLoss.rate}%</span>
                <div className="flex-1 h-3 rounded-full overflow-hidden bg-muted flex">
                  <div className="h-full bg-emerald-500" style={{ width: `${winLoss.rate}%` }} aria-hidden="true" />
                  <div className="h-full bg-red-400" style={{ width: `${100 - (winLoss.rate ?? 0)}%` }} aria-hidden="true" />
                </div>
              </div>
            </section>
          ) : (
            <p className="text-xs text-muted-foreground">No closed quotes in this period yet — win rate appears once you&apos;ve won or lost a quote.</p>
          ))}

          {/* Leads over time */}
          {perWeek.total > 0 && (
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Leads per {granularity === 'week' ? 'week' : 'month'}
                  <span className="font-normal normal-case tracking-normal"> · {perWeek.total} total</span>
                </h3>
                <div className="inline-flex rounded-lg border border-border overflow-hidden shrink-0">
                  {(['week', 'month'] as Granularity[]).map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => { setGranularity(g); setSelectedWeek(null); }}
                      aria-pressed={granularity === g}
                      className={cn(
                        'px-2.5 h-7 text-[11px] font-medium transition-colors',
                        granularity === g ? 'bg-foreground text-background' : 'bg-card text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {g === 'week' ? 'Week' : 'Month'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-end gap-1.5 h-20">
                {perWeek.data.map((d) => {
                  const isCurrent = d.key === perWeek.curBucket;
                  const isSelected = d.key === activeWeek;
                  return (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => setSelectedWeek(isSelected ? null : d.key)}
                      aria-pressed={isSelected}
                      className="flex-1 flex flex-col items-center gap-1 min-w-0 group cursor-pointer"
                      title={`${bucketLabel(d.key, granularity)}: ${d.count} ${d.count === 1 ? 'lead' : 'leads'}`}
                    >
                      <span className="text-[10px] text-muted-foreground tabular-nums leading-none">
                        {d.count > 0 ? d.count : ''}
                      </span>
                      <div
                        className={cn(
                          'w-full rounded-t transition-colors',
                          isSelected
                            ? 'bg-violet-700 ring-2 ring-violet-400'
                            : isCurrent
                              ? 'bg-violet-600 group-hover:bg-violet-700'
                              : 'bg-violet-300 dark:bg-violet-800 group-hover:bg-violet-400 dark:group-hover:bg-violet-700',
                        )}
                        style={{ height: `${Math.max(4, (d.count / perWeek.max) * 56)}px` }}
                        aria-hidden="true"
                      />
                      <span className={cn(
                        'text-[9px] leading-none whitespace-nowrap',
                        isCurrent ? 'text-violet-600 font-medium' : 'text-muted-foreground',
                      )}>
                        {isCurrent
                          ? (granularity === 'week' ? 'This wk' : 'This mo')
                          : bucketLabel(d.key, granularity)}
                      </span>
                    </button>
                  );
                })}
              </div>

              {activeWeek && (
                <div className="rounded-lg border border-border bg-muted/30 p-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-foreground">
                      {granularity === 'week' ? 'Week of ' : ''}{bucketLabel(activeWeek, granularity)} · {weekLeads.length} {weekLeads.length === 1 ? 'lead' : 'leads'}
                    </p>
                    <button
                      type="button"
                      onClick={() => setSelectedWeek(null)}
                      aria-label="Close week breakdown"
                      className="w-7 h-7 -mr-1 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                    >
                      <X size={14} strokeWidth={2} />
                    </button>
                  </div>
                  {weekLeads.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-1 pb-1">No leads came in this week.</p>
                  ) : (
                    <ul className="space-y-1">
                      {weekLeads.map((j) => {
                        const st = statusMeta(j);
                        return (
                          <li key={j.id}>
                            <button
                              type="button"
                              onClick={() => onSelectJob?.(j)}
                              disabled={!onSelectJob}
                              className={cn(
                                'w-full flex items-center gap-2 px-2 py-2 min-h-[44px] rounded-lg bg-card border border-border text-left',
                                onSelectJob && 'hover:border-primary/40 transition-colors',
                              )}
                            >
                              <div className="flex-1 min-w-0">
                                <p className="text-sm text-foreground truncate">{j.name}</p>
                                {j.workType && (
                                  <p className="text-[11px] text-muted-foreground capitalize">{j.workType}</p>
                                )}
                              </div>
                              <span className={cn('shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium border', st.cls)}>
                                {st.label}
                              </span>
                              {onSelectJob && <ChevronRight size={14} className="text-muted-foreground shrink-0" />}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}

          {/* By work type — only when viewing All (a specific filter makes
              this a single bar, which is just noise). */}
          {filter === 'all' && byType.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">By job type</h3>
              <ul className="space-y-1.5">
                {byType.map((t) => {
                  const pct = (t.count / Math.max(1, ...byType.map((x) => x.count))) * 100;
                  return (
                    <li key={t.type}>
                      <button
                        type="button"
                        onClick={() => onFilter(t.type)}
                        className="w-full text-left group"
                      >
                        <div className="flex items-center justify-between text-xs mb-0.5">
                          <span className="font-medium text-foreground group-hover:text-violet-600 transition-colors">
                            {WORK_TYPE_LABEL[t.type]}
                          </span>
                          <span className="text-muted-foreground tabular-nums">
                            {t.count} {t.count === 1 ? 'lead' : 'leads'}
                            {t.rate !== null && <span className="text-emerald-600"> · {t.rate}% win</span>}
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                          <div className="h-full bg-violet-400 group-hover:bg-violet-500 transition-colors" style={{ width: `${pct}%` }} />
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {untyped > 0 && (
                <p className="text-[11px] text-muted-foreground">+ {untyped} with no job type set</p>
              )}
            </section>
          )}

          {/* By source + avg quote value */}
          {bySource.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">By source</h3>
              <ul className="space-y-1.5">
                {bySource.map((s) => (
                  <li key={s.source}>
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="font-medium text-foreground">{s.label}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {s.count} {s.count === 1 ? 'lead' : 'leads'}
                        {s.avg !== null && <span> · avg {moneyShort(s.avg)}</span>}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div className="h-full bg-blue-400" style={{ width: `${(s.count / maxSourceCount) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 h-8 rounded-full text-xs font-medium border transition-colors',
        active
          ? 'bg-foreground text-background border-foreground'
          : 'bg-card text-muted-foreground border-border hover:border-foreground/30',
      )}
    >
      {children}
    </button>
  );
}
