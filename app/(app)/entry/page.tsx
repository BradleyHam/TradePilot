'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { ParsedPreview } from '@/components/entry/parsed-preview';
import { EntryForm } from '@/components/entry/entry-form';
import { useStore } from '@/lib/store';
import { parseNaturalLanguage } from '@/lib/nl-parser';
import { Entry, EntryType, ParsedEntry } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Receipt, DollarSign, Clock, MessageSquare, FileText, AlertCircle, StickyNote,
  Sparkles, ChevronDown, CheckCircle2, Hammer,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const QUICK_TYPES: { type: EntryType; label: string; icon: React.ElementType; color: string }[] = [
  { type: 'expense',  label: 'Expense',  icon: Receipt,       color: 'text-red-500' },
  { type: 'income',   label: 'Income',   icon: DollarSign,    color: 'text-green-500' },
  { type: 'hours',    label: 'Hours',    icon: Clock,         color: 'text-blue-500' },
  { type: 'enquiry',  label: 'Enquiry',  icon: MessageSquare, color: 'text-violet-500' },
  { type: 'quote',    label: 'Quote',    icon: FileText,      color: 'text-amber-500' },
  { type: 'bill',     label: 'Bill',     icon: AlertCircle,   color: 'text-orange-500' },
  { type: 'note',     label: 'Note',     icon: StickyNote,    color: 'text-slate-500' },
];

const EXAMPLES = [
  'Bought 12L paint from Resene for Smith job $186',
  'Worked 6 hours prep on Johnson exterior',
  'New enquiry from Sarah in Wanaka for interior repaint, maybe $4k',
  'Sent quote to Mike for $8,500',
  'Power bill due Friday $240',
];

type Mode = 'nl' | 'form';

export default function EntryPage() {
  const { addEntry, jobs, businessId } = useStore();

  const [mode, setMode] = useState<Mode>('nl');
  const [nlText, setNlText] = useState('');
  const [parsed, setParsed] = useState<ParsedEntry | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState<EntryType>('expense');
  const [saved, setSaved] = useState(false);
  const [showExamples, setShowExamples] = useState(false);

  function handleParse() {
    if (!nlText.trim()) return;
    const result = parseNaturalLanguage(nlText);
    setParsed(result);
    setShowForm(false);
  }

  function handleConfirm() {
    if (!parsed) return;
    const entry: Entry = {
      id: `ent_${Date.now()}`,
      businessId: businessId ?? '',
      type: parsed.type,
      category: parsed.category,
      amount: parsed.amount,
      hours: parsed.hours,
      supplier: parsed.supplier,
      gstApplies: parsed.type === 'expense' || parsed.type === 'income' || parsed.type === 'bill',
      description: parsed.description,
      entryDate: new Date().toISOString().split('T')[0],
      createdAt: new Date().toISOString(),
    };
    addEntry(entry);
    showSaved();
    resetNl();
  }

  function handleFormSave(data: Omit<Entry, 'id' | 'businessId' | 'createdAt'>) {
    const entry: Entry = {
      id: `ent_${Date.now()}`,
      businessId: businessId ?? '',
      createdAt: new Date().toISOString(),
      ...data,
    };
    addEntry(entry);
    showSaved();
    setShowForm(false);
  }

  function showSaved() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  function resetNl() {
    setNlText('');
    setParsed(null);
  }

  function openFormType(type: EntryType) {
    setFormType(type);
    setShowForm(true);
    setParsed(null);
    setMode('form');
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Entry"
        subtitle={new Date().toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' })}
      />

      <div className="px-4 md:px-6 space-y-4 pb-6">

        {/* Saved confirmation */}
        {saved && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm font-medium">
            <CheckCircle2 size={16} />
            Entry saved
          </div>
        )}

        {/* Mode toggle */}
        <div className="flex bg-muted rounded-xl p-1 gap-1">
          <button
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors',
              mode === 'nl' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'
            )}
            onClick={() => { setMode('nl'); setShowForm(false); }}
          >
            <Sparkles size={14} />
            Natural language
          </button>
          <button
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors',
              mode === 'form' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'
            )}
            onClick={() => setMode('form')}
          >
            <Hammer size={14} />
            Quick form
          </button>
        </div>

        {/* Natural language input */}
        {mode === 'nl' && !showForm && (
          <div className="space-y-3">
            <div>
              <Textarea
                placeholder="Type what happened... e.g. 'Bought paint from Resene for Smith job $186'"
                value={nlText}
                onChange={(e) => { setNlText(e.target.value); if (parsed) setParsed(null); }}
                className="resize-none text-base min-h-[100px] leading-relaxed"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleParse();
                }}
              />
              <button
                onClick={() => setShowExamples(!showExamples)}
                className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronDown size={12} className={cn('transition-transform', showExamples && 'rotate-180')} />
                Show examples
              </button>
              {showExamples && (
                <div className="mt-2 space-y-1.5">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      onClick={() => { setNlText(ex); setShowExamples(false); }}
                      className="block w-full text-left text-xs text-muted-foreground bg-muted/50 hover:bg-muted px-3 py-2 rounded-lg transition-colors"
                    >
                      &ldquo;{ex}&rdquo;
                    </button>
                  ))}
                </div>
              )}
            </div>

            <Button
              className="w-full bg-primary text-primary-foreground h-12 text-base font-semibold"
              onClick={handleParse}
              disabled={!nlText.trim()}
            >
              <Sparkles size={16} className="mr-2" />
              Parse entry
            </Button>

            {parsed && (
              <ParsedPreview
                parsed={parsed}
                onConfirm={handleConfirm}
                onEdit={() => {
                  setFormType(parsed.type);
                  setShowForm(true);
                }}
              />
            )}
          </div>
        )}

        {/* Quick type grid (form mode) */}
        {mode === 'form' && !showForm && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">What do you want to log?</p>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {QUICK_TYPES.map(({ type, label, icon: Icon, color }) => (
                <button
                  key={type}
                  onClick={() => openFormType(type)}
                  className="flex flex-col items-center justify-center gap-2 p-4 rounded-2xl bg-card border border-border hover:border-primary/40 hover:bg-accent transition-colors min-h-[88px] active:scale-95"
                >
                  <Icon size={22} className={color} strokeWidth={1.8} />
                  <span className="text-sm font-medium text-foreground">{label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Entry form */}
        {showForm && (
          <div className="bg-card border border-border rounded-2xl p-4">
            <EntryForm
              defaultType={formType}
              onSave={handleFormSave}
              onCancel={() => { setShowForm(false); setParsed(null); }}
            />
          </div>
        )}

        {/* Recent entries */}
        <RecentEntries />
      </div>
    </div>
  );
}

function RecentEntries() {
  const { entries, jobs } = useStore();

  const recent = [...entries]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  const TYPE_ICON: Record<string, React.ElementType> = {
    expense: Receipt, income: DollarSign, hours: Clock, enquiry: MessageSquare,
    quote: FileText, bill: AlertCircle, note: StickyNote,
  };

  const TYPE_COLOR: Record<string, string> = {
    expense: 'text-red-500', income: 'text-green-500', hours: 'text-blue-500',
    enquiry: 'text-violet-500', quote: 'text-amber-500', bill: 'text-orange-500', note: 'text-slate-500',
  };

  if (recent.length === 0) return null;

  return (
    <div>
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        Recent entries
      </h3>
      <div className="space-y-2">
        {recent.map((entry) => {
          const Icon = TYPE_ICON[entry.type] || StickyNote;
          const job = entry.jobId ? jobs.find((j) => j.id === entry.jobId) : null;
          return (
            <div key={entry.id} className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border">
              <Icon size={16} className={cn(TYPE_COLOR[entry.type], 'shrink-0')} strokeWidth={1.8} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">{entry.description}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {job?.name && <span>{job.name} · </span>}
                  {entry.entryDate}
                </p>
              </div>
              {entry.amount !== undefined && (
                <span className={cn(
                  'text-sm font-semibold shrink-0',
                  entry.type === 'income' ? 'text-green-600' : 'text-foreground'
                )}>
                  {entry.type === 'expense' ? '-' : '+'}${entry.amount.toLocaleString('en-NZ')}
                </span>
              )}
              {entry.hours !== undefined && (
                <span className="text-sm font-semibold shrink-0 text-blue-600">{entry.hours}h</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
