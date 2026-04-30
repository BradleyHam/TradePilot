'use client';

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import type { Entry, EntryType } from '@/lib/types';
import { format, parseISO, isToday, isYesterday, differenceInCalendarDays } from 'date-fns';
import {
  Receipt, DollarSign, Clock, AlertCircle, FileText, MessageSquare, StickyNote,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const TYPE_ICON: Record<EntryType, React.ElementType> = {
  expense: Receipt,
  income: DollarSign,
  hours: Clock,
  bill: AlertCircle,
  quote: FileText,
  enquiry: MessageSquare,
  note: StickyNote,
};

const TYPE_COLOR: Record<EntryType, string> = {
  expense: 'text-red-500',
  income: 'text-green-500',
  hours: 'text-blue-500',
  bill: 'text-orange-500',
  quote: 'text-amber-500',
  enquiry: 'text-violet-500',
  note: 'text-slate-500',
};

type Filter = 'all' | 'expense' | 'income' | 'hours' | 'bill';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all',     label: 'All' },
  { value: 'expense', label: 'Expenses' },
  { value: 'income',  label: 'Income' },
  { value: 'hours',   label: 'Hours' },
  { value: 'bill',    label: 'Bills' },
];

const DAY_WINDOW = 30;

/**
 * Flag pairs of entries that look like duplicates: same job, same type, same
 * amount (or hours), within 7 days of each other. Best-effort heuristic — the
 * user is the final judge.
 */
function findDuplicateIds(entries: Entry[]): Set<string> {
  const dupes = new Set<string>();
  // Bucket by (jobId|type|amount|hours) so we don't N² over everything.
  const buckets = new Map<string, Entry[]>();
  for (const e of entries) {
    const value = e.amount ?? e.hours;
    if (value == null) continue;
    const key = `${e.jobId ?? '_'}|${e.type}|${value}`;
    const list = buckets.get(key) ?? [];
    list.push(e);
    buckets.set(key, list);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    // Sort by date so we compare neighbours.
    const sorted = [...list].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    for (let i = 1; i < sorted.length; i++) {
      const a = parseISO(sorted[i - 1].entryDate);
      const b = parseISO(sorted[i].entryDate);
      if (Math.abs(differenceInCalendarDays(a, b)) <= 7) {
        dupes.add(sorted[i - 1].id);
        dupes.add(sorted[i].id);
      }
    }
  }
  return dupes;
}

function dateLabel(iso: string): string {
  const d = parseISO(iso);
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  // Same week: show the day name
  const days = differenceInCalendarDays(new Date(), d);
  if (days < 7) return format(d, 'EEEE');
  return format(d, 'EEE d MMM');
}

export function TransactionList() {
  const { entries, jobs } = useStore();
  const [filter, setFilter] = useState<Filter>('all');

  const cutoff = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - DAY_WINDOW);
    return d.toISOString().slice(0, 10);
  }, []);

  // Last 30 days, newest first
  const recent = useMemo(
    () => entries
      .filter((e) => e.entryDate >= cutoff)
      .sort((a, b) => b.entryDate.localeCompare(a.entryDate)),
    [entries, cutoff],
  );

  const duplicateIds = useMemo(() => findDuplicateIds(recent), [recent]);

  const filtered = useMemo(
    () => filter === 'all' ? recent : recent.filter((e) => e.type === filter),
    [recent, filter],
  );

  // Group by entry_date
  const groups = useMemo(() => {
    const out: { date: string; entries: Entry[] }[] = [];
    for (const e of filtered) {
      const last = out[out.length - 1];
      if (last && last.date === e.entryDate) last.entries.push(e);
      else out.push({ date: e.entryDate, entries: [e] });
    }
    return out;
  }, [filtered]);

  const jobNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const j of jobs) map.set(j.id, j.name);
    return map;
  }, [jobs]);

  const dupeCount = duplicateIds.size;

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="px-4 pt-4 pb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">Recent transactions</p>
        <p className="text-xs text-muted-foreground">Last {DAY_WINDOW} days · {recent.length} entries</p>
      </div>

      {/* Filter chips */}
      <div className="flex gap-2 px-4 pb-3 overflow-x-auto scrollbar-hide">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={cn(
              'shrink-0 px-3 h-9 rounded-lg text-sm font-medium border transition-colors',
              filter === value
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground border-border hover:text-foreground hover:border-primary/30',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Duplicate-warning banner */}
      {dupeCount > 0 && filter === 'all' && (
        <div className="mx-4 mb-3 flex items-start gap-2 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-800">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" strokeWidth={2} />
          <p className="text-xs leading-relaxed">
            <span className="font-semibold">{dupeCount} possible duplicate{dupeCount !== 1 ? 's' : ''}.</span>{' '}
            Same job, same amount, within a week. Marked with an amber dot below.
          </p>
        </div>
      )}

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="px-4 pb-6 text-center text-sm text-muted-foreground">
          No {filter === 'all' ? 'transactions' : filter} in the last {DAY_WINDOW} days.
        </div>
      )}

      {/* Grouped list */}
      {groups.map((group) => (
        <div key={group.date} className="border-t border-border">
          <p className="px-4 py-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide bg-muted/30">
            {dateLabel(group.date)}
          </p>
          {group.entries.map((e) => {
            const Icon = TYPE_ICON[e.type] ?? StickyNote;
            const isDupe = duplicateIds.has(e.id);
            const jobName = e.jobId ? jobNameById.get(e.jobId) : null;
            return (
              <div
                key={e.id}
                className="flex items-center gap-3 px-4 py-3 border-t border-border first:border-t-0"
              >
                <div className="relative shrink-0">
                  <Icon size={16} className={cn(TYPE_COLOR[e.type])} strokeWidth={1.8} />
                  {isDupe && (
                    <span
                      className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-500 ring-2 ring-card"
                      aria-label="Possible duplicate"
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{e.description}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {jobName && <>{jobName} · </>}
                    {e.category && <span className="capitalize">{e.category}</span>}
                    {e.supplier && <> · {e.supplier}</>}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {e.amount != null && (
                    <p className={cn(
                      'text-sm font-semibold',
                      e.type === 'income' ? 'text-green-600'
                        : e.type === 'expense' || e.type === 'bill' ? 'text-foreground'
                        : 'text-foreground',
                    )}>
                      {e.type === 'expense' || e.type === 'bill' ? '-' : '+'}
                      ${e.amount.toLocaleString('en-NZ')}
                    </p>
                  )}
                  {e.hours != null && (
                    <p className="text-sm font-semibold text-blue-600">{e.hours}h</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
