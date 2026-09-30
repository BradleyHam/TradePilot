'use client';

import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { useStore } from '@/lib/store';
import { hoursByWorker } from '@/lib/hours-attribution';
import type { Entry } from '@/lib/types';
import { Button } from '@/components/ui/button';

export function ClearDayHours({ date }: { date: string }) {
  const { entries, jobs, teamMembers, membership, role, clearJobDayHours } = useStore();
  const [review, setReview] = useState<{ jobId: string; rows: Entry[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const dayHours = entries.filter((e) => e.type === 'hours' && e.entryDate === date && e.jobId);
  const jobIds = [...new Set(dayHours.map((e) => e.jobId!))];
  if (role !== 'owner') return null;
  return (
    <div className="mt-3 space-y-2">
      {review ? (
        <div className="rounded-xl border border-red-200 p-3 space-y-3" role="group" aria-label="Confirm clearing hours">
          <p className="text-sm font-semibold">Clear this day’s hours for {jobs.find((j) => j.id === review.jobId)?.name ?? 'this job'}?</p>
          <p className="text-sm">{format(parseISO(date), 'EEEE, d MMMM yyyy')}</p>
          <p className="text-sm">{hoursByWorker(review.rows, teamMembers, membership?.userId).map((w) => `${w.label}: ${w.hours} h`).join(' · ')}</p>
          <p className="text-xs text-muted-foreground">Deletes {review.rows.length} hour records for everyone on this job that day, including zero-hour records. Bookings stay in place. This cannot be undone.</p>
          <div className="flex gap-2">
            <Button className="min-h-11 flex-1" variant="outline" disabled={busy} onClick={() => { setReview(null); setMessage(''); }}>Cancel</Button>
            <Button className="min-h-11 h-auto whitespace-normal flex-1 bg-red-600 hover:bg-red-700 text-white" disabled={busy} onClick={async () => {
              setBusy(true);
              setMessage('');
              const ok = await clearJobDayHours(review.jobId, date, review.rows.map((e) => e.id));
              setBusy(false);
              if (ok) { setReview(null); setMessage('Hours cleared. You can log the day again.'); }
              else setMessage('Could not clear these hours. Your records have been kept. Cancel and try again.');
            }}>{busy ? 'Clearing…' : 'Clear this day’s hours'}</Button>
          </div>
        </div>
      ) : jobIds.map((jobId) => (
        <Button key={jobId} variant="outline" className="min-h-11 h-auto w-full whitespace-normal text-red-600" onClick={() => {
          setMessage('');
          setReview({ jobId, rows: dayHours.filter((e) => e.jobId === jobId) });
        }}>Clear hours for this day · {jobs.find((j) => j.id === jobId)?.name ?? 'Job'}</Button>
      ))}
      {message && <p role="status" className="text-sm">{message}</p>}
    </div>
  );
}
