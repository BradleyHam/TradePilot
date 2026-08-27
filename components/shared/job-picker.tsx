'use client';

/**
 * JobPicker — a type-to-search job selector.
 *
 * Replaces the native <select>/base-ui Select job dropdowns across the app.
 * The job list got long enough that scrolling a dropdown to find a job
 * became the slow part of logging an expense (see the reconcile screen).
 *
 * What it does:
 *   - Type to filter. Matches the job NAME, CLIENT name, ADDRESS/location
 *     and legacy id (J12 etc). Multi-word queries are AND-ed, so
 *     "nicholson ceiling" or "78 ball" both narrow correctly.
 *   - When the search box is empty it keeps the existing smart ordering
 *     (likely-match → active → recently completed → older) via rankJobs,
 *     and — when `entries` are supplied — shows a "Recent" shortcut row of
 *     the last few jobs you logged against, tappable without typing.
 *   - Phone-first: 44px tap targets, big search box, single scroll panel.
 *
 * Controlled: `value` is the selected jobId ('' = none). `onChange` fires
 * with the new jobId (or '' when "No job" is chosen).
 *
 * Optional rows for the split / bill-allocation callers:
 *   - `overhead` + `onOverhead`: shows an "Overhead (no job)" row and marks
 *     it selected when `overhead` is true.
 *   - `onCreateNew` (+ `createNewLabel`): turns an empty search result into
 *     a "create it as a new job" action, seeded with the typed text.
 *     Callers should ALSO put a visible New-job button next to the picker —
 *     this path only covers the user who searched first.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { rankJobs, type JobRelevanceTier } from '@/lib/job-match';
import type { Job, Entry } from '@/lib/types';
import { Search, Check, ChevronDown, Plus, X, Briefcase } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface JobPickerProps {
  jobs: Job[];
  /** Selected jobId, '' = none. */
  value: string;
  onChange: (jobId: string) => void;
  /** Entries — used to build the "Recent jobs" shortcut. Optional. */
  entries?: Entry[];
  /** Fuzzy-rank seed, e.g. a bank transaction's payee/particulars. */
  context?: string;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  /** Label for the clear/"no job" row. */
  noJobLabel?: string;
  disabled?: boolean;
  className?: string;
  /** Hide the "Older" tier when active jobs exist (matches entry-form/schedule). */
  hideOlderWhenActive?: boolean;
  /** Overhead support (split + bill allocation). */
  overhead?: boolean;
  onOverhead?: () => void;
  /**
   * Extra fixed rows above the job list, for callers whose value space is
   * wider than "a job id or nothing" — the bill line-item allocator, for
   * instance, also needs "Overhead" and "Skip — don't track".
   *
   * Their `value` flows through `onChange` exactly like a job id, and a
   * selected extra row drives the trigger label, so the caller doesn't
   * have to special-case rendering.
   */
  extraOptions?: { value: string; label: string; description?: string }[];
  /**
   * "Create new job…" support (schedule add-form).
   *
   * Receives the current search text so the caller can seed the new job's
   * name with what the user just typed — the row only appears once a
   * search has come up empty, which is precisely the moment they've
   * spelled out the name of a job that doesn't exist yet.
   */
  onCreateNew?: (query?: string) => void;
  createNewLabel?: string;
}

const TIER_LABELS: Record<JobRelevanceTier, string> = {
  'active-match': 'Likely match',
  'active': 'Active jobs',
  'recent': 'Recently completed',
  'older': 'Older',
};

function normalise(s: string | undefined | null): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Text we search a job against: name + client + address + legacy id. */
function haystack(job: Job): string {
  return normalise([job.name, job.clientName, job.location, job.legacyId].filter(Boolean).join(' '));
}

export function JobPicker({
  jobs,
  value,
  onChange,
  entries,
  context,
  placeholder = 'Select a job…',
  noJobLabel = 'No job',
  disabled = false,
  className,
  hideOlderWhenActive = false,
  overhead = false,
  onOverhead,
  onCreateNew,
  createNewLabel = 'Create it as a new job',
  extraOptions,
}: JobPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedJob = value ? jobs.find((j) => j.id === value) : undefined;

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Focus the search box when the panel opens. (Query is reset in the
  // trigger's onClick, not here, to avoid a setState-in-effect cascade.)
  useEffect(() => {
    if (!open) return;
    // rAF so the input exists + is laid out before we focus.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const ranked = useMemo(() => rankJobs(jobs, context), [jobs, context]);

  // Recent jobs: last few distinct jobs logged against, most-recent first.
  const recentJobs = useMemo(() => {
    if (!entries || entries.length === 0) return [];
    const sorted = [...entries]
      .filter((e) => e.jobId)
      .sort((a, b) =>
        String(b.createdAt ?? b.entryDate ?? '').localeCompare(String(a.createdAt ?? a.entryDate ?? '')),
      );
    const seen = new Set<string>();
    const out: Job[] = [];
    for (const e of sorted) {
      const id = e.jobId!;
      if (seen.has(id)) continue;
      seen.add(id);
      const job = jobs.find((j) => j.id === id);
      if (job) out.push(job);
      if (out.length >= 4) break;
    }
    return out;
  }, [entries, jobs]);

  // Filtered/grouped list for the panel.
  const q = normalise(query);

  const filtered = useMemo(() => {
    const tokens = q ? q.split(' ') : [];
    if (tokens.length === 0) return null; // signals "show grouped view"
    return ranked
      .filter(({ job }) => {
        const hay = haystack(job);
        return tokens.every((t) => hay.includes(t));
      })
      .map((r) => r.job);
  }, [q, ranked]);

  const grouped = useMemo(() => {
    const tiers: JobRelevanceTier[] = ['active-match', 'active', 'recent', 'older'];
    const hasActive = ranked.some((r) => r.tier === 'active' || r.tier === 'active-match');
    const selectedIsOlder = !!value && ranked.find((r) => r.job.id === value)?.tier === 'older';
    return tiers
      .map((tier) => ({ tier, items: ranked.filter((r) => r.tier === tier).map((r) => r.job) }))
      .filter(({ tier, items }) => {
        if (items.length === 0) return false;
        if (tier === 'older' && hideOlderWhenActive && hasActive && !selectedIsOlder) return false;
        return true;
      });
  }, [ranked, value, hideOlderWhenActive]);

  function choose(jobId: string) {
    onChange(jobId);
    setOpen(false);
  }

  const selectedExtra = extraOptions?.find((o) => o.value === value);

  const triggerLabel = overhead
    ? 'Overhead (no job)'
    : selectedExtra
      ? selectedExtra.label
      : selectedJob
        ? selectedJob.name + (selectedJob.clientName ? ` — ${selectedJob.clientName}` : '')
        : placeholder;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!open) setQuery(''); // fresh search each time it opens
          setOpen((v) => !v);
        }}
        className={cn(
          'w-full h-11 px-3 rounded-lg border border-input bg-background text-sm text-left flex items-center gap-2',
          'focus:outline-none focus:ring-2 focus:ring-ring',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <span
          className={cn(
            'flex-1 min-w-0 truncate',
            !selectedJob && !overhead && 'text-muted-foreground',
          )}
        >
          {triggerLabel}
        </span>
        <ChevronDown size={16} strokeWidth={2} className="shrink-0 text-muted-foreground" />
      </button>

      {/* Panel */}
      {open && (
        <div className="absolute z-50 mt-1 left-0 right-0 rounded-xl border border-border bg-card shadow-lg overflow-hidden">
          {/* Search box */}
          <div className="p-2 border-b border-border bg-card sticky top-0">
            <div className="relative">
              <Search
                size={15}
                strokeWidth={2}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, client or address…"
                className="w-full h-10 pl-8 pr-8 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    inputRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto py-1">
            {/* Fixed rows: No job / Overhead / caller extras. ALL hidden
                while searching — the query is a job name, and leaving
                toggles at the top of a filtered list just pushes the
                actual matches down. Clearing the search brings them back. */}
            {!q && (
              <Row selected={!value && !overhead} onClick={() => choose('')}>
                <span className="text-muted-foreground">{noJobLabel}</span>
              </Row>
            )}
            {!q && extraOptions?.map((opt) => (
              <Row key={opt.value} selected={value === opt.value} onClick={() => choose(opt.value)}>
                <span className="text-foreground">{opt.label}</span>
                {opt.description && (
                  <span className="block text-[11px] text-muted-foreground">{opt.description}</span>
                )}
              </Row>
            ))}
            {!q && onOverhead && (
              <Row
                selected={overhead}
                onClick={() => {
                  onOverhead();
                  setOpen(false);
                }}
              >
                <span className="text-blue-700 font-medium">Overhead (no job)</span>
              </Row>
            )}

            {/* Recent shortcut — only when not searching and no job chosen yet */}
            {!q && recentJobs.length > 0 && (
              <div className="px-2 pt-2 pb-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide px-1 pb-1">
                  Recent
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {recentJobs.map((job) => (
                    <button
                      key={job.id}
                      type="button"
                      onClick={() => choose(job.id)}
                      className={cn(
                        'inline-flex items-center gap-1 h-8 px-2.5 rounded-full border text-xs font-medium max-w-full',
                        value === job.id
                          ? 'bg-primary/10 border-primary text-primary'
                          : 'bg-background border-border text-foreground hover:border-primary/40',
                      )}
                    >
                      <Briefcase size={11} strokeWidth={2} className="shrink-0" />
                      <span className="truncate">{job.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Search results (flat, relevance-ordered) */}
            {filtered !== null && (
              filtered.length === 0 ? (
                // Dead end — unless the caller can create. Then the
                // search text IS the name of a job that doesn't exist
                // yet, so offer it directly rather than making the user
                // back out and start again somewhere else.
                <div className="px-3 py-5 text-center">
                  <p className="text-xs text-muted-foreground">
                    No jobs match “{query.trim()}”.
                  </p>
                  {onCreateNew && (
                    <button
                      type="button"
                      onClick={() => {
                        onCreateNew(query.trim());
                        setOpen(false);
                      }}
                      className="mt-2.5 inline-flex items-center gap-1.5 min-h-[40px] px-3.5 rounded-lg border border-primary/40 bg-primary/5 text-primary text-xs font-semibold hover:bg-primary/10 transition-colors"
                    >
                      <Plus size={13} strokeWidth={2.6} />
                      {createNewLabel}
                    </button>
                  )}
                </div>
              ) : (
                filtered.map((job) => (
                  <JobRow key={job.id} job={job} selected={value === job.id} onClick={() => choose(job.id)} />
                ))
              )
            )}

            {/* Grouped view (no query) */}
            {filtered === null &&
              grouped.map(({ tier, items }) => (
                <div key={tier}>
                  <p className="px-3 pt-2 pb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    {TIER_LABELS[tier]}
                  </p>
                  {items.map((job) => (
                    <JobRow key={job.id} job={job} selected={value === job.id} onClick={() => choose(job.id)} />
                  ))}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  children,
  selected,
  onClick,
}: {
  children: React.ReactNode;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full min-h-11 px-3 py-2 flex items-center gap-2 text-sm text-left hover:bg-muted/60 transition-colors',
        selected && 'bg-primary/5',
      )}
    >
      <span className="flex-1 min-w-0">{children}</span>
      {selected && <Check size={15} strokeWidth={2.4} className="shrink-0 text-primary" />}
    </button>
  );
}

function JobRow({ job, selected, onClick }: { job: Job; selected: boolean; onClick: () => void }) {
  const sub = [job.clientName, job.location].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full min-h-11 px-3 py-2 flex items-center gap-2 text-left hover:bg-muted/60 transition-colors',
        selected && 'bg-primary/5',
      )}
    >
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-foreground truncate">{job.name}</span>
        {sub && <span className="block text-[11px] text-muted-foreground truncate">{sub}</span>}
      </span>
      {selected && <Check size={15} strokeWidth={2.4} className="shrink-0 text-primary" />}
    </button>
  );
}
