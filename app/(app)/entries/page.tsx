'use client';

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { Entry, EntryType } from '@/lib/types';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { EntryForm } from '@/components/entry/entry-form';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Receipt, DollarSign, Clock, MessageSquare, FileText, AlertCircle, StickyNote,
  Search, X, FileSearch,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Type meta ─────────────────────────────────────────────────────────────
// Same icon/colour mapping used on the Entry tab's Recent Entries section,
// kept local so this page can stand on its own without coupling to the entry
// page module.
const TYPE_ICON: Record<EntryType, React.ElementType> = {
  expense: Receipt, income: DollarSign, hours: Clock, enquiry: MessageSquare,
  quote: FileText, bill: AlertCircle, note: StickyNote,
};
const TYPE_COLOR: Record<EntryType, string> = {
  expense: 'text-red-500', income: 'text-green-500', hours: 'text-blue-500',
  enquiry: 'text-violet-500', quote: 'text-amber-500', bill: 'text-orange-500',
  note: 'text-slate-500',
};

type TypeFilter = 'all' | EntryType;
const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all',     label: 'All'      },
  { value: 'expense', label: 'Expenses' },
  { value: 'income',  label: 'Income'   },
  { value: 'hours',   label: 'Hours'    },
  { value: 'bill',    label: 'Bills'    },
  { value: 'quote',   label: 'Quotes'   },
  { value: 'enquiry', label: 'Enquiries'},
  { value: 'note',    label: 'Notes'    },
];

export default function EntriesPage() {
  const { entries, jobs, updateEntry, deleteEntry } = useStore();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [editingId, setEditingId] = useState<string | null>(null);

  const jobNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const j of jobs) map.set(j.id, j.name);
    return map;
  }, [jobs]);

  // Filtered + sorted list. Date desc by entryDate (the canonical "when did
  // this happen" field). Tie-break by createdAt desc so duplicate-day items
  // come out in a stable, useful order.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...entries]
      .filter((e) => typeFilter === 'all' ? true : e.type === typeFilter)
      .filter((e) => {
        if (!q) return true;
        // Match against description, supplier, company, and the linked job
        // name. That covers the most common "I'm looking for…" patterns.
        const haystack = [
          e.description,
          e.supplier,
          e.company,
          e.jobId ? jobNameById.get(e.jobId) : '',
          e.entryDate,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      })
      .sort((a, b) => {
        if (a.entryDate !== b.entryDate) return b.entryDate.localeCompare(a.entryDate);
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [entries, typeFilter, search, jobNameById]);

  const editing = editingId ? entries.find((e) => e.id === editingId) : null;

  function handleSave(data: Omit<Entry, 'id' | 'businessId' | 'createdAt'>) {
    if (!editingId) return;
    updateEntry(editingId, data);
    setEditingId(null);
  }

  function handleDelete() {
    if (!editingId || !editing) return;
    if (!confirm(`Delete this ${editing.type} entry? This can't be undone.`)) return;
    deleteEntry(editingId);
    setEditingId(null);
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="All entries"
        subtitle={`${entries.length} total · tap a row to edit`}
      />

      <div className="px-4 md:px-6 pb-6 w-full max-w-4xl mx-auto">
        {/* Search */}
        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" strokeWidth={2} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search description, supplier, job, date…"
            className="w-full h-10 pl-9 pr-9 rounded-xl border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Type filter chips */}
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide -mx-1 px-1">
          {TYPE_FILTERS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setTypeFilter(value)}
              className={cn(
                'shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                typeFilter === value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/30'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* List */}
        {entries.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              icon={FileSearch}
              title="No entries yet"
              description="Add some from the Entry tab — expenses, hours, quotes, bills."
            />
          </div>
        ) : visible.length === 0 ? (
          <div className="mt-8 text-center text-sm text-muted-foreground">
            Nothing matches your search.
          </div>
        ) : (
          <ul className="mt-2 space-y-2">
            {visible.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                jobName={entry.jobId ? jobNameById.get(entry.jobId) : undefined}
                onClick={() => setEditingId(entry.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Edit sheet — uses the same EntryForm as the create flow but in
          edit mode (defaultValues + Update label + Delete button). */}
      <Sheet open={!!editingId} onOpenChange={(open) => !open && setEditingId(null)}>
        <SheetContent side="bottom" className="h-[90vh] overflow-y-auto rounded-t-2xl px-4 pb-10">
          <SheetHeader className="pb-4">
            <SheetTitle>Edit entry</SheetTitle>
          </SheetHeader>
          {editing && (
            <EntryForm
              defaultValues={editing}
              onSave={handleSave}
              onCancel={() => setEditingId(null)}
              onDelete={handleDelete}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────
// Compact single-line layout: type icon, description (truncated), small
// metadata row underneath, and a money/hours figure on the right. Whole row
// is a button so the entire 44px target opens the edit sheet — matches the
// "tired-painter, big tap targets" UX rule.
function EntryRow({
  entry,
  jobName,
  onClick,
}: {
  entry: Entry;
  jobName?: string | undefined;
  onClick: () => void;
}) {
  const Icon = TYPE_ICON[entry.type] ?? StickyNote;
  const isOverhead = entry.description.startsWith('[OH] ');
  const description = isOverhead ? entry.description.slice('[OH] '.length) : entry.description;

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center gap-3 p-3 rounded-xl bg-card border border-border hover:border-primary/40 hover:bg-accent/30 transition-colors text-left min-h-[56px]"
      >
        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted/50')}>
          <Icon size={15} className={cn(TYPE_COLOR[entry.type], 'shrink-0')} strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground leading-snug truncate">
            {isOverhead && (
              <span className="text-[10px] font-semibold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded mr-1.5 align-middle">
                OH
              </span>
            )}
            {description}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            <span className="capitalize">{entry.type}</span>
            <span> · {entry.entryDate}</span>
            {jobName && <span> · {jobName}</span>}
            {entry.supplier && <span> · {entry.supplier}</span>}
            {entry.activity && <span> · {entry.activity}</span>}
            {entry.type === 'bill' && entry.paid && <span> · paid</span>}
          </p>
        </div>
        <div className="shrink-0 text-right">
          {entry.amount !== undefined && (
            <span className={cn(
              'text-sm font-semibold tabular-nums',
              entry.type === 'income' ? 'text-green-600'
              : entry.type === 'expense' || entry.type === 'bill' ? 'text-foreground'
              : 'text-muted-foreground'
            )}>
              {entry.type === 'expense' || entry.type === 'bill' ? '-' : '+'}
              ${entry.amount.toLocaleString('en-NZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
            </span>
          )}
          {entry.hours !== undefined && entry.amount === undefined && (
            <span className="text-sm font-semibold text-blue-600 tabular-nums">{entry.hours}h</span>
          )}
        </div>
      </button>
    </li>
  );
}
