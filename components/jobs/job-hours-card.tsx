'use client';

import { useState } from 'react';
import { localTodayISO } from '@/lib/format-date';
import { latestProgressAt } from '@/lib/job-progress';
import type { Entry, Job, JobProgressSnapshot } from '@/lib/types';
import { actualHoursByRole, compareJobHours, hoursEstimateDraft, LABOUR_ESTIMATE_ROLES, parseHoursEstimate } from '@/lib/job-hours-estimate';
import { HoursEstimateFields } from './hours-estimate-fields';
import { Button } from '@/components/ui/button';

const hours = (n: number) => n.toLocaleString('en-NZ', { maximumFractionDigits: 2 });

export function JobHoursCard({ job, entries, snapshots = [], onEditWorkLeft, onSave }: {
  job: Job;
  entries: Entry[];
  snapshots?: JobProgressSnapshot[];
  onEditWorkLeft?: () => void;
  onSave: (estimate: Job['hoursEstimate']) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => hoursEstimateDraft(job.hoursEstimate));
  const estimate = job.hoursEstimate;
  const actual = actualHoursByRole(entries, job.id);
  const snapshot = latestProgressAt(snapshots, job.id, localTodayISO());
  const complete = ['completed', 'paid'].includes(job.status) || snapshot?.state === 'complete';
  const remaining = snapshot && !complete ? Math.max(0, snapshot.remainingPersonHours - Math.max(0, actual.total - snapshot.actualPersonHours)) : undefined;
  const needsUpdate = !!snapshot && !complete && remaining === 0;
  const comparisonStats = estimate ? compareJobHours(estimate.total, actual.total, needsUpdate ? undefined : remaining, complete) : null;
  const parsed = parseHoursEstimate(draft);
  function edit() {
    setDraft(hoursEstimateDraft(job.hoursEstimate));
    setEditing(true);
  }
  if (editing) return (
    <fieldset disabled={saving} className="min-w-0 space-y-3">
      <HoursEstimateFields value={draft} onChange={setDraft} />
      <p className="text-xs text-muted-foreground">This is the estimate you will compare the finished job against. Updating work left keeps it unchanged.</p>
      <div className="flex gap-2">
        <Button className="min-h-11 flex-1" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
        <Button className="min-h-11 flex-1" disabled={saving || !!parsed.error} onClick={async () => {
          if (parsed.error || saving) return;
          setSaving(true); setSaveError('');
          try {
            if (await onSave(parsed.value)) setEditing(false);
            else setSaveError('Estimate was not saved. Your changes are still here; please retry.');
          } catch { setSaveError('Could not save. Please retry.'); }
          finally { setSaving(false); }
        }}>{saving ? 'Saving…' : 'Save estimate'}</Button>
      </div>
      {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
    </fieldset>
  );
  if (!estimate) return (
    <button type="button" onClick={edit} className="min-h-11 w-full rounded-xl border border-dashed border-border px-4 py-3 text-left text-sm font-medium">
      + Add estimated hours
    </button>
  );

  const difference = Math.round((actual.total - estimate.total) * 100) / 100;
  const comparison = actual.total === 0
    ? 'No hours logged yet'
    : difference > 0
      ? `${hours(difference)}h over estimate${complete ? '' : ' so far'}`
      : complete
        ? difference === 0 ? 'Finished on estimate' : `${hours(-difference)}h under estimate`
        : difference === 0 ? 'Estimated hours used up' : `${hours(-difference)}h of estimate unused`;

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Hours budget</h3>
        <button type="button" onClick={edit} className="min-h-11 px-3 text-sm font-medium text-primary">Edit estimate</button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><p className="text-xs text-muted-foreground">Original estimate</p><p className="text-2xl font-semibold tabular-nums">{hours(estimate.total)}<span className="ml-1 text-sm font-normal">h</span></p></div>
        <div><p className="text-xs text-muted-foreground">{complete ? 'Actually logged' : 'Logged so far'}</p><p className="text-2xl font-semibold tabular-nums">{hours(actual.total)}<span className="ml-1 text-sm font-normal">h</span></p></div>
      </div>
      <p className={`text-sm font-medium ${difference > 0 ? 'text-amber-700' : 'text-foreground'}`}>{comparison}</p>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Hours budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, comparisonStats?.usedPercent ?? 0)} aria-valuetext={`${comparisonStats?.usedPercent}% of hours budget used`}><div className={`h-full ${difference > 0 ? 'bg-amber-500' : 'bg-primary'}`} style={{ width: `${Math.min(100, comparisonStats?.usedPercent ?? 0)}%` }} /></div>
      {!complete && <div className="rounded-lg bg-muted/50 p-3 text-sm">
        {comparisonStats?.forecast != null ? <><p className="font-semibold">Forecast finish: {hours(comparisonStats.forecast)}h</p><p className="mt-1 text-muted-foreground">{comparisonStats.forecastDelta! > 0 ? `${hours(comparisonStats.forecastDelta!)}h over original estimate` : comparisonStats.forecastDelta === 0 ? 'On the original estimate' : `${hours(-comparisonStats.forecastDelta!)}h under original estimate`} · based on work left checked {snapshot?.asOfDate}</p></> : <p className="text-muted-foreground">{needsUpdate ? 'The last work-left estimate is used up. Check what remains.' : 'Add work left to forecast the finish.'}</p>}
        {onEditWorkLeft && <button type="button" onClick={onEditWorkLeft} className="min-h-11 text-sm font-semibold text-primary">{snapshot ? 'Update work left' : 'Add work left'}</button>}
      </div>}
      {estimate.byRole && (
        <details><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Compare by role</summary><table className="w-full text-xs">
          <thead><tr className="text-muted-foreground"><th scope="col" className="pb-2 text-left font-normal">Role</th><th scope="col" className="pb-2 text-right font-normal">Est.</th><th scope="col" className="pb-2 text-right font-normal">Actual</th><th scope="col" className="pb-2 text-right font-normal">+/−</th></tr></thead>
          <tbody>{LABOUR_ESTIMATE_ROLES.filter(({ key }) => (estimate.byRole?.[key] ?? 0) > 0 || actual.byRole[key] > 0).map(({ key, label }) => {
            const planned = estimate.byRole?.[key] ?? 0;
            const delta = Math.round((actual.byRole[key] - planned) * 100) / 100;
            return <tr key={key} className="border-t border-border"><th scope="row" className="py-2 pr-2 text-left font-medium">{label}</th><td className="py-2 text-right tabular-nums">{hours(planned)}h</td><td className="py-2 text-right tabular-nums">{hours(actual.byRole[key])}h</td><td className="py-2 pl-2 text-right tabular-nums">{delta > 0 ? '+' : ''}{hours(delta)}h</td></tr>;
          })}</tbody>
        </table></details>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">Total person-hours from time entries, including your own. {complete ? 'Check everyone has logged their time before judging the result.' : 'Unused hours are budget remaining, not a forecast of work left.'}</p>
      {actual.legacyHelper > 0 && <p className="text-xs text-amber-700">Includes {hours(actual.legacyHelper)}h from older helper entries. Check these weren&apos;t also logged separately.</p>}
    </section>
  );
}
