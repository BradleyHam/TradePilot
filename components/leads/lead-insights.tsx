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

import { useMemo } from 'react';
import type { Job, JobStatus, WorkType, LeadSource } from '@/lib/types';
import { ChevronDown, BarChart3 } from 'lucide-react';
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

/** Monday-start week key (YYYY-MM-DD of that Monday) for a date. */
function weekStartISO(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - dow);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function shortWeekLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
}

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
}

export function LeadInsights({ jobs, filter, onFilter, open, onToggle }: LeadInsightsProps) {
  // Jobs in scope for the metrics: the work-type filter applies to everything
  // here. (We never count jobs with no work-type into a specific type — only
  // into "All".)
  const scoped = useMemo(
    () => (filter === 'all' ? jobs : jobs.filter((j) => j.workType === filter)),
    [jobs, filter],
  );

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

  // ── Leads per week (last 8 weeks, by createdAt) ─────────────────────────────
  const perWeek = useMemo(() => {
    const today = new Date();
    const thisMonday = weekStartISO(today);
    // Build the 8 week-buckets ending this week, oldest first.
    const weeks: string[] = [];
    const cursor = new Date(thisMonday);
    for (let i = WEEKS_SHOWN - 1; i >= 0; i--) {
      const d = new Date(cursor);
      d.setDate(d.getDate() - i * 7);
      weeks.push(weekStartISO(d));
    }
    const counts = new Map<string, number>(weeks.map((w) => [w, 0]));
    for (const j of scoped) {
      if (!j.createdAt) continue;
      const wk = weekStartISO(new Date(j.createdAt));
      if (counts.has(wk)) counts.set(wk, (counts.get(wk) ?? 0) + 1);
    }
    const data = weeks.map((w) => ({ week: w, count: counts.get(w) ?? 0 }));
    const max = Math.max(1, ...data.map((d) => d.count));
    const total = data.reduce((s, d) => s + d.count, 0);
    return { data, max, total };
  }, [scoped]);

  // ── Breakdown by work type (only meaningful when not already filtered) ─────
  const byType = useMemo(() => {
    return typesPresent
      .map((t) => {
        const rows = jobs.filter((j) => j.workType === t);
        const won = rows.filter(isWon).length;
        const closed = rows.filter(isClosed).length;
        return { type: t, count: rows.length, won, closed, rate: closed > 0 ? Math.round((won / closed) * 100) : null };
      })
      .sort((a, b) => b.count - a.count);
  }, [jobs, typesPresent]);

  const untyped = useMemo(() => jobs.filter((j) => !j.workType).length, [jobs]);

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

          {/* Win / loss */}
          {winLoss.closed > 0 ? (
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
            <p className="text-xs text-muted-foreground">No closed quotes yet for this view — win rate appears once you&apos;ve won or lost a quote.</p>
          )}

          {/* Leads per week */}
          {perWeek.total > 0 && (
            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Leads per week</h3>
                <span className="text-xs text-muted-foreground">{perWeek.total} in {WEEKS_SHOWN} wks</span>
              </div>
              <div className="flex items-end gap-1.5 h-20">
                {perWeek.data.map((d, i) => {
                  const isThisWeek = i === perWeek.data.length - 1;
                  return (
                    <div key={d.week} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                      <span className="text-[10px] text-muted-foreground tabular-nums leading-none">
                        {d.count > 0 ? d.count : ''}
                      </span>
                      <div
                        className={cn('w-full rounded-t', isThisWeek ? 'bg-violet-600' : 'bg-violet-300 dark:bg-violet-800')}
                        style={{ height: `${Math.max(4, (d.count / perWeek.max) * 56)}px` }}
                        title={`Week of ${shortWeekLabel(d.week)}: ${d.count}`}
                        aria-label={`Week of ${shortWeekLabel(d.week)}: ${d.count} leads`}
                      />
                      <span className="text-[9px] text-muted-foreground leading-none whitespace-nowrap">
                        {shortWeekLabel(d.week).replace(/ /, ' ')}
                      </span>
                    </div>
                  );
                })}
              </div>
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
