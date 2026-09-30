'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import type { ActivityType, Entry } from '@/lib/types';
import { localTodayISO } from '@/lib/format-date';
import { JobPicker } from '@/components/shared/job-picker';
import { Button } from '@/components/ui/button';
import { EntryForm } from './entry-form';

type Draft = Omit<Entry, 'id' | 'businessId' | 'createdAt'>;

export function QuickHoursForm({ onSaveMany, onCancel }: {
  onSaveMany: (entries: Draft[]) => Promise<void>;
  onCancel: () => void;
}) {
  const { jobs, entries, scheduleItems } = useStore();
  const today = localTodayISO();
  const [date, setDate] = useState(today);
  const [selected, setSelected] = useState<string | null>(null);
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const [activity, setActivity] = useState<ActivityType | undefined>();
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const activeJobs = jobs.filter((job) => ['accepted', 'booked', 'in-progress'].includes(job.status));
  const bookedIds = [...new Set(scheduleItems.filter((item) => item.type === 'job_booking' && item.date === date && !item.skipReasonKind && activeJobs.some((job) => job.id === item.jobId)).map((item) => item.jobId!))];
  const latest = entries.filter((entry) => entry.type === 'hours' && entry.workerKind !== 'helper' && (entry.workerKind ?? 'owner') === 'owner' && entry.jobId && activeJobs.some((job) => job.id === entry.jobId)).sort((a, b) => b.entryDate.localeCompare(a.entryDate))[0];
  // Multiple bookings need an explicit choice; never guess between them.
  const suggestion = bookedIds.length === 1 ? bookedIds[0] : bookedIds.length === 0 ? latest?.jobId ?? '' : '';
  const jobId = selected ?? suggestion;
  const total = Number(hours.trim().replace(/\s*(?:hours?|hrs?|h)$/i, ''));
  const draft: Draft = { type: 'hours', jobId: jobId || undefined, hours: total, activity, description: note.trim() || 'Hours worked', entryDate: date, gstApplies: false, workerKind: 'owner' };

  if (advanced) return <EntryForm lockType defaultType="hours" defaultValues={{ ...draft, hours: Number.isFinite(total) && total > 0 ? total : undefined }} onSave={async (entry) => onSaveMany([entry])} onSaveMany={onSaveMany} onCancel={() => setAdvanced(false)} />;

  async function save() {
    if (saving) return;
    setSaving(true); setError('');
    try { await onSaveMany([draft]); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save. Your hours are still here.'); }
    finally { setSaving(false); }
  }

  return <fieldset disabled={saving} className="min-w-0 space-y-4">
    <div><h2 className="text-lg font-semibold">Log your hours</h2><p className="text-xs text-muted-foreground">Your time today. Add detail only when you need it.</p></div>
    <div className="space-y-1.5"><p className="text-sm font-medium">Job</p><JobPicker jobs={jobs} entries={entries} value={jobId} onChange={setSelected} noJobLabel="Off-site / no job" />{selected === null && suggestion && <p className="text-xs text-muted-foreground">{bookedIds.length === 1 ? 'Suggested from the schedule' : 'Your last active job'} · change if needed</p>}</div>
    <label className="block text-sm font-medium" htmlFor="quick-hours">Hours<input id="quick-hours" autoFocus inputMode="decimal" placeholder="e.g. 6.5" value={hours} onChange={(e) => setHours(e.target.value)} className="mt-1.5 h-12 w-full rounded-xl border border-input bg-background px-3 text-xl tabular-nums" /></label>
    <div className="flex gap-2">{[2, 4, 6, 8].map((n) => <button key={n} type="button" aria-pressed={total === n} className="min-h-11 flex-1 rounded-lg border border-input text-sm font-medium" onClick={() => setHours(String(n))}>{n}h</button>)}</div>
    <label className="block text-sm font-medium" htmlFor="quick-hours-date">Date<input id="quick-hours-date" type="date" max={today} value={date} onChange={(e) => {setDate(e.target.value);setSelected(null);}} className="mt-1.5 h-11 w-full rounded-lg border border-input bg-background px-3" /></label>
    <details><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Activity and note (optional)</summary><div className="space-y-3 pt-2"><select aria-label="Activity" value={activity ?? ''} onChange={(e) => setActivity((e.target.value || undefined) as ActivityType | undefined)} className="h-11 w-full rounded-lg border border-input bg-background px-3"><option value="">Not specified</option>{['prep','painting','staining','primer','repair','cleanup','travel','quoting','admin'].map((value) => <option key={value} value={value}>{value[0].toUpperCase()+value.slice(1)}</option>)}</select><textarea aria-label="Note" placeholder="Anything worth remembering?" value={note} onChange={(e) => setNote(e.target.value)} className="min-h-20 w-full rounded-lg border border-input bg-background p-3 text-sm" /></div></details>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex gap-2"><Button variant="outline" className="min-h-11" onClick={onCancel}>Cancel</Button><Button className="min-h-11 flex-1" onClick={save} disabled={saving || !Number.isFinite(total) || total <= 0 || total > 24 || !date || date > today}>{saving ? 'Saving…' : 'Save hours'}</Button></div>
    <button type="button" className="min-h-11 w-full text-sm font-medium text-muted-foreground" onClick={() => setAdvanced(true)}>Log for the team or split activities</button>
  </fieldset>;
}
