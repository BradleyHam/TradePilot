'use client';

import { useMemo, useState } from 'react';
import { EntryType, Entry, ExpenseCategory, ActivityType } from '@/lib/types';
import { EXPENSE_CATEGORIES, ACTIVITY_TYPES } from '@/lib/mock-data';
import { useStore } from '@/lib/store';
import { rankJobs } from '@/lib/job-match';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface EntryFormProps {
  defaultType?: EntryType;
  onSave: (entry: Omit<Entry, 'id' | 'businessId' | 'createdAt'>) => void;
  onCancel: () => void;
}

const ENTRY_TYPES: { value: EntryType; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'hours', label: 'Hours' },
  { value: 'enquiry', label: 'Enquiry' },
  { value: 'quote', label: 'Quote' },
  { value: 'bill', label: 'Bill Due' },
  { value: 'note', label: 'Note' },
];

export function EntryForm({ defaultType = 'expense', onSave, onCancel }: EntryFormProps) {
  const { jobs } = useStore();
  const today = new Date().toISOString().split('T')[0];
  const [type, setType] = useState<EntryType>(defaultType);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [hours, setHours] = useState('');
  const [category, setCategory] = useState<ExpenseCategory | ''>('');
  const [activity, setActivity] = useState<ActivityType | ''>('');
  const [jobId, setJobId] = useState('');
  // Overhead = no job, deliberately. Distinct from "I forgot to pick one".
  // Stored as `[OH]` description prefix; jobId stays null.
  const [isOverhead, setIsOverhead] = useState(false);
  const [supplier, setSupplier] = useState('');
  const [dueDate, setDueDate] = useState('');
  // Entry date — defaults to today but editable so the user can backdate
  // hours, expenses etc. Critical for the hours-by-month allocation.
  const [entryDate, setEntryDate] = useState(today);

  function handleSave() {
    if (!description.trim()) return;
    onSave({
      jobId: jobId || undefined,
      type,
      category: (category as ExpenseCategory) || undefined,
      amount: amount ? parseFloat(amount) : undefined,
      hours: hours ? parseFloat(hours) : undefined,
      activity: (activity as ActivityType) || undefined,
      supplier: supplier || undefined,
      gstApplies: type === 'expense' || type === 'income' || type === 'bill',
      // Tag overheads in the description so they're greppable later.
      description: (isOverhead ? '[OH] ' : '') + description.trim(),
      entryDate: entryDate || today,
      dueDate: dueDate || undefined,
    });
  }

  return (
    <div className="space-y-3">
      {/* Type selector */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Entry type
        </label>
        <div className="flex flex-wrap gap-2">
          {ENTRY_TYPES.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setType(value)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                type === value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground border-border hover:border-primary/40 hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Description */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Description
        </label>
        <Textarea
          placeholder={
            type === 'expense' ? 'e.g. Paint and supplies from Resene'
            : type === 'income' ? 'e.g. Payment received from Johnson'
            : type === 'hours' ? 'e.g. Painting second coat bedrooms'
            : type === 'enquiry' ? 'e.g. Sarah Thompson - interior repaint Wanaka'
            : type === 'quote' ? 'e.g. Quote sent to McLeod for cedar restain'
            : type === 'bill' ? 'e.g. Power bill due'
            : 'Add a note...'
          }
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="resize-none text-sm"
          rows={2}
        />
      </div>

      {/* Entry date — editable so hours/expenses can be backdated. */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Date {entryDate !== today && (
            <span className="ml-1 text-amber-600 normal-case">· backdated</span>
          )}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            className="flex-1 h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {entryDate !== today && (
            <button
              type="button"
              onClick={() => setEntryDate(today)}
              className="text-xs text-muted-foreground hover:text-foreground px-2 h-9 rounded-md hover:bg-muted"
            >
              Today
            </button>
          )}
        </div>
      </div>

      {/* Amount / Hours */}
      <div className="grid grid-cols-2 gap-3">
        {(type === 'expense' || type === 'income' || type === 'quote' || type === 'bill') && (
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Amount ($)
            </label>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        )}
        {type === 'hours' && (
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Hours
            </label>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0"
              step="0.5"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        )}

        {/* Category */}
        {type === 'expense' && (
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Category
            </label>
            <Select value={category} onValueChange={(v) => setCategory(v as ExpenseCategory)}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Select" />
              </SelectTrigger>
              <SelectContent>
                {EXPENSE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Activity */}
        {type === 'hours' && (
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Activity
            </label>
            <Select value={activity} onValueChange={(v) => setActivity(v as ActivityType)}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Select" />
              </SelectTrigger>
              <SelectContent>
                {ACTIVITY_TYPES.map((a) => (
                  <SelectItem key={a} value={a} className="capitalize">{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Job + overhead toggle */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Job (optional)
        </label>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Select
              value={jobId}
              onValueChange={(v) => {
                setJobId(v ?? '');
                if (v) setIsOverhead(false);
              }}
            >
              <SelectTrigger className={cn('h-9 text-sm', isOverhead && 'opacity-50')}>
                <SelectValue placeholder="No job selected" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">No job</SelectItem>
                {(() => {
                  // Tier-grouped: active first, then recently completed, then
                  // older. The "Older" bucket is hidden when there are active
                  // jobs and the user hasn't already selected one — matches
                  // the schedule page picker so completed-from-months-ago
                  // doesn't clutter the list.
                  const ranked = rankJobs(jobs);
                  const tiers: Array<['active' | 'recent' | 'older', string]> = [
                    ['active',  'Active'],
                    ['recent',  'Recently completed'],
                    ['older',   'Older'],
                  ];
                  const hasActive = ranked.some((r) => r.tier === 'active' || r.tier === 'active-match');
                  const selectedIsOlder = !!jobId && ranked.find((r) => r.job.id === jobId)?.tier === 'older';
                  return tiers.flatMap(([tier, label]) => {
                    const items = ranked.filter((r) => r.tier === tier);
                    if (items.length === 0) return [];
                    if (tier === 'older' && hasActive && !selectedIsOlder) return [];
                    return [
                      <div
                        key={`${tier}-label`}
                        className="px-2 pt-2 pb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide"
                      >
                        {label}
                      </div>,
                      ...items.map((r) => (
                        <SelectItem key={r.job.id} value={r.job.id}>
                          {r.job.name}
                        </SelectItem>
                      )),
                    ];
                  });
                })()}
              </SelectContent>
            </Select>
          </div>
          <button
            type="button"
            onClick={() => {
              setIsOverhead((v) => !v);
              if (!isOverhead) setJobId('');
            }}
            className={cn(
              'shrink-0 h-9 px-3 rounded-lg text-xs font-semibold border transition-colors',
              isOverhead
                ? 'bg-blue-100 text-blue-700 border-blue-200'
                : 'bg-background text-muted-foreground border-border hover:text-foreground hover:border-primary/30',
            )}
            title="Mark as overhead — a business expense not tied to a specific job"
          >
            Overhead
          </button>
        </div>
      </div>

      {/* Supplier (expense) */}
      {type === 'expense' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Supplier (optional)
          </label>
          <input
            type="text"
            placeholder="e.g. Resene, Mitre 10"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      )}

      {/* Due date (bill) */}
      {type === 'bill' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Due date
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Button variant="outline" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          className="flex-1 bg-primary"
          onClick={handleSave}
          disabled={!description.trim()}
        >
          Save Entry
        </Button>
      </div>
    </div>
  );
}
