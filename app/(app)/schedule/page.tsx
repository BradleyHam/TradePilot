'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import { ScheduleItem, ScheduleItemType } from '@/lib/types';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  CalendarDays, Plus, Briefcase, FileText, Bell, AlertCircle, Receipt, CheckCircle2,
} from 'lucide-react';
import { format, parseISO, isToday, isTomorrow, isPast, isThisWeek, addDays } from 'date-fns';
import { cn } from '@/lib/utils';

const TYPE_CONFIG: Record<ScheduleItemType, { label: string; icon: React.ElementType; color: string; bg: string }> = {
  job_booking:  { label: 'Job',      icon: Briefcase,    color: 'text-orange-600', bg: 'bg-orange-50' },
  quote_visit:  { label: 'Quote',    icon: FileText,     color: 'text-blue-600',   bg: 'bg-blue-50' },
  follow_up:    { label: 'Follow up',icon: Bell,         color: 'text-violet-600', bg: 'bg-violet-50' },
  bill_due:     { label: 'Bill due', icon: AlertCircle,  color: 'text-red-500',    bg: 'bg-red-50' },
  invoice_due:  { label: 'Invoice',  icon: Receipt,      color: 'text-amber-600',  bg: 'bg-amber-50' },
  reminder:     { label: 'Reminder', icon: Bell,         color: 'text-slate-600',  bg: 'bg-slate-50' },
};

function dateGroup(dateStr: string): string {
  const date = parseISO(dateStr);
  if (isToday(date)) return 'Today';
  if (isTomorrow(date)) return 'Tomorrow';
  if (isThisWeek(date, { weekStartsOn: 1 })) return format(date, 'EEEE');
  return format(date, 'd MMM yyyy');
}

export default function SchedulePage() {
  const { scheduleItems, jobs, addScheduleItem, updateScheduleItem, businessId } = useStore();
  const [showAdd, setShowAdd] = useState(false);

  const upcoming = [...scheduleItems]
    .filter((s) => !s.completed)
    .sort((a, b) => a.date.localeCompare(b.date));

  const completed = [...scheduleItems]
    .filter((s) => s.completed)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);

  // Group by date
  const grouped: Record<string, ScheduleItem[]> = {};
  for (const item of upcoming) {
    const g = dateGroup(item.date);
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(item);
  }

  function handleComplete(id: string) {
    updateScheduleItem(id, { completed: true });
  }

  function handleAdd(data: Omit<ScheduleItem, 'id' | 'businessId' | 'createdAt'>) {
    addScheduleItem({
      id: `sch_${Date.now()}`,
      businessId: businessId ?? '',
      createdAt: new Date().toISOString(),
      ...data,
    });
    setShowAdd(false);
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Schedule"
        subtitle={`${upcoming.length} upcoming`}
        action={
          <Button size="sm" className="bg-primary h-9" onClick={() => setShowAdd(true)}>
            <Plus size={16} className="mr-1" /> Add
          </Button>
        }
      />

      <div className="px-4 md:px-6 pb-6">
        {upcoming.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="Nothing scheduled"
            description="Add job bookings, quote visits, follow-ups, and bill due dates to stay organised."
            action={
              <Button className="bg-primary" onClick={() => setShowAdd(true)}>
                <Plus size={16} className="mr-1.5" /> Add first item
              </Button>
            }
          />
        ) : (
          <div className="space-y-6">
            {Object.entries(grouped).map(([group, items]) => (
              <div key={group}>
                <h3 className={cn(
                  'text-sm font-semibold mb-2',
                  group === 'Today' ? 'text-primary' : 'text-muted-foreground'
                )}>
                  {group}
                </h3>
                <div className="space-y-2">
                  {items.map((item) => (
                    <ScheduleItemCard
                      key={item.id}
                      item={item}
                      job={item.jobId ? jobs.find((j) => j.id === item.jobId) : undefined}
                      onComplete={() => handleComplete(item.id)}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* Completed */}
            {completed.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-muted-foreground mb-2">Done</h3>
                <div className="space-y-2 opacity-60">
                  {completed.map((item) => (
                    <ScheduleItemCard
                      key={item.id}
                      item={item}
                      job={item.jobId ? jobs.find((j) => j.id === item.jobId) : undefined}
                      onComplete={() => {}}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add schedule sheet */}
      <Sheet open={showAdd} onOpenChange={setShowAdd}>
        <SheetContent side="bottom" className="h-[85vh] overflow-y-auto rounded-t-2xl px-4 pb-10">
          <SheetHeader className="pb-4">
            <SheetTitle>Add schedule item</SheetTitle>
          </SheetHeader>
          <AddScheduleForm jobs={jobs} onSave={handleAdd} onCancel={() => setShowAdd(false)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ScheduleItemCard({
  item,
  job,
  onComplete,
}: {
  item: ScheduleItem;
  job?: { name: string } | undefined;
  onComplete: () => void;
}) {
  const config = TYPE_CONFIG[item.type];
  const Icon = config.icon;
  const date = parseISO(item.date);
  const overdue = isPast(date) && !isToday(date) && !item.completed;

  return (
    <div className={cn(
      'flex items-start gap-3 p-3.5 rounded-2xl border transition-colors',
      item.completed ? 'bg-muted/30 border-border' : 'bg-card border-border',
      overdue && !item.completed && 'border-red-200 bg-red-50/30'
    )}>
      <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5', config.bg)}>
        <Icon size={17} className={config.color} strokeWidth={1.8} />
      </div>

      <div className="flex-1 min-w-0">
        <p className={cn('text-sm font-medium leading-snug', item.completed && 'line-through text-muted-foreground')}>
          {item.title}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
          <span className={cn('text-xs', config.color, 'font-medium')}>{config.label}</span>
          {item.startTime && (
            <span className="text-xs text-muted-foreground">{item.startTime}{item.endTime ? `–${item.endTime}` : ''}</span>
          )}
          {job && <span className="text-xs text-muted-foreground truncate">{job.name}</span>}
          {overdue && <span className="text-xs font-medium text-red-500">Overdue</span>}
        </div>
        {item.notes && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.notes}</p>
        )}
      </div>

      {!item.completed && (
        <button
          onClick={onComplete}
          className="shrink-0 w-7 h-7 rounded-full border-2 border-border hover:border-green-400 hover:bg-green-50 flex items-center justify-center transition-colors mt-0.5"
          title="Mark done"
        >
          <CheckCircle2 size={14} className="text-muted-foreground hover:text-green-500" />
        </button>
      )}
    </div>
  );
}

const SCHEDULE_TYPES: { value: ScheduleItemType; label: string }[] = [
  { value: 'job_booking', label: 'Job booking' },
  { value: 'quote_visit', label: 'Quote visit' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'bill_due', label: 'Bill due' },
  { value: 'invoice_due', label: 'Invoice due' },
  { value: 'reminder', label: 'Reminder' },
];

function AddScheduleForm({
  jobs,
  onSave,
  onCancel,
}: {
  jobs: { id: string; name: string }[];
  onSave: (data: Omit<ScheduleItem, 'id' | 'businessId' | 'createdAt'>) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<ScheduleItemType>('job_booking');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [jobId, setJobId] = useState('');
  const [notes, setNotes] = useState('');

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">{label}</label>
      {children}
    </div>
  );

  const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      {...props}
      className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    />
  );

  return (
    <div className="space-y-3">
      <Field label="Type">
        <Select value={type} onValueChange={(v) => setType(v as ScheduleItemType)}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Title *">
        <Input placeholder="e.g. Smith Exterior - Day 1" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>

      <Field label="Date *">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Start time">
          <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </Field>
        <Field label="End time">
          <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </Field>
      </div>

      <Field label="Job (optional)">
        <Select value={jobId} onValueChange={(v) => setJobId(v ?? '')}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="No job" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">No job</SelectItem>
            {jobs.map((j) => (
              <SelectItem key={j.id} value={j.id}>{j.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Notes">
        <Textarea
          placeholder="Any details..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="resize-none text-sm"
          rows={2}
        />
      </Field>

      <div className="flex gap-2 pt-1">
        <Button variant="outline" className="flex-1" onClick={onCancel}>Cancel</Button>
        <Button
          className="flex-1 bg-primary"
          disabled={!title.trim() || !date}
          onClick={() =>
            onSave({ type, title: title.trim(), date, startTime: startTime || undefined, endTime: endTime || undefined, jobId: jobId || undefined, notes: notes || undefined, completed: false })
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}
