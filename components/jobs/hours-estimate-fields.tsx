'use client';

import { useId } from 'react';
import { hoursEstimateDraft, LABOUR_ESTIMATE_ROLES, parseHoursEstimate, type HoursEstimateDraft } from '@/lib/job-hours-estimate';
import { cn } from '@/lib/utils';

export function HoursEstimateFields({ value, onChange }: {
  value: HoursEstimateDraft;
  onChange: (next: HoursEstimateDraft) => void;
}) {
  const id = useId();
  const parsed = parseHoursEstimate(value);
  const inputClass = 'h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
  function setSplit(split: boolean) {
    if (split === value.split) return;
    // Preserve the total when switching modes. A total-only estimate has no
    // known allocation: leave the role inputs empty instead of inventing one.
    onChange({ ...value, split, total: !split && parsed.value ? String(parsed.value.total) : value.total });
  }
  function roleInput(key: typeof LABOUR_ESTIMATE_ROLES[number]['key'], label: string) {
    return (
      <label key={key} htmlFor={`${id}-${key}`} className="block min-w-0 text-xs font-medium">
        {label}
        <input id={`${id}-${key}`} inputMode="decimal" placeholder="Hours" value={value.roles[key]}
          onChange={(e) => onChange({ ...value, roles: { ...value.roles, [key]: e.target.value } })}
          className={cn(inputClass, 'mt-1.5')} aria-describedby={`${id}-help`} />
      </label>
    );
  }
  return (
    <fieldset className="min-w-0 space-y-3 rounded-xl border border-border p-3">
      <legend className="px-1 text-sm font-semibold">Estimated hours <span className="font-normal text-muted-foreground">(optional)</span></legend>
      <div className="grid grid-cols-2 gap-2">
        {[{ split: false, label: 'Total only' }, { split: true, label: 'Split by role' }].map((mode) => (
          <button key={mode.label} type="button" aria-pressed={value.split === mode.split}
            onClick={() => setSplit(mode.split)}
            className={cn('min-h-11 rounded-lg border px-3 text-sm font-medium', value.split === mode.split ? 'border-primary bg-primary/10 text-primary' : 'border-input text-muted-foreground')}>
            {mode.label}
          </button>
        ))}
      </div>
      {value.split ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            {LABOUR_ESTIMATE_ROLES.slice(0, 2).map(({ key, label }) => roleInput(key, label))}
          </div>
          <details open={value.roles.apprentice !== '' || value.roles.subcontractor !== '' ? true : undefined}>
            <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-muted-foreground">Other roles</summary>
            <div className="grid grid-cols-2 gap-3">
              {LABOUR_ESTIMATE_ROLES.slice(2).map(({ key, label }) => roleInput(key, label))}
            </div>
          </details>
          <p className="text-sm font-semibold tabular-nums">Total: {parsed.value?.total ?? 0} hours</p>
          {!parsed.value?.byRole && value.total && <p className="text-xs text-muted-foreground">Your total is kept until you enter a role split.</p>}
        </>
      ) : (
        <label htmlFor={`${id}-total`} className="block text-xs font-medium">
          Total person-hours
          <input id={`${id}-total`} inputMode="decimal" placeholder="e.g. 24" value={value.total}
            onChange={(e) => onChange({ ...hoursEstimateDraft(), total: e.target.value })}
            className={cn(inputClass, 'mt-1.5')} aria-describedby={`${id}-help`} />
        </label>
      )}
      <p id={`${id}-help`} className="text-xs leading-relaxed text-muted-foreground">
        12 hours painter + 12 hours brush hand = 24 hours total. Your own time counts as experienced painter.
      </p>
      {parsed.error && <p role="alert" className="text-xs text-destructive">{parsed.error}</p>}
      {(value.total || Object.values(value.roles).some(Boolean)) && <button type="button" className="min-h-11 px-2 text-xs font-medium text-muted-foreground" onClick={() => onChange(hoursEstimateDraft())}>Clear estimate</button>}
    </fieldset>
  );
}
