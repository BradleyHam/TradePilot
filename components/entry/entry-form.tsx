'use client';

import { useState } from 'react';
import { EntryType, Entry, ExpenseCategory, ActivityType } from '@/lib/types';
import { EXPENSE_CATEGORIES, ACTIVITY_TYPES } from '@/lib/mock-data';
import { useStore } from '@/lib/store';
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
  const [type, setType] = useState<EntryType>(defaultType);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [hours, setHours] = useState('');
  const [category, setCategory] = useState<ExpenseCategory | ''>('');
  const [activity, setActivity] = useState<ActivityType | ''>('');
  const [jobId, setJobId] = useState('');
  const [supplier, setSupplier] = useState('');
  const [dueDate, setDueDate] = useState('');

  const today = new Date().toISOString().split('T')[0];

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
      description: description.trim(),
      entryDate: today,
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

      {/* Job */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Job (optional)
        </label>
        <Select value={jobId} onValueChange={(v) => setJobId(v ?? '')}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="No job selected" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">No job</SelectItem>
            {jobs.map((j) => (
              <SelectItem key={j.id} value={j.id}>{j.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
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
