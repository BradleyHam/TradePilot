'use client';

import { useState } from 'react';
import { Job, JobStatus, WorkType, PrepLevel, LeadSource } from '@/lib/types';
import { SELECTABLE_WORK_TYPES, WORK_TYPE_LABELS, jobWorkTypes } from '@/lib/types';
import { JOB_STATUSES } from '@/lib/mock-data';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

// 'mixed' is absent by design — it's derived from picking more than one
// (see deriveWorkType in lib/types.ts), not something a user selects.
const WORK_TYPES: { value: WorkType; label: string }[] = SELECTABLE_WORK_TYPES.map(
  (value) => ({ value, label: WORK_TYPE_LABELS[value] }),
);

const PREP_LEVELS: { value: PrepLevel; label: string }[] = [
  { value: 'light',      label: 'Light'      },
  { value: 'medium',     label: 'Medium'     },
  { value: 'heavy',      label: 'Heavy'      },
  { value: 'full-strip', label: 'Full strip' },
];

const SOURCES: { value: LeadSource; label: string }[] = [
  { value: 'phone',    label: 'Phone'        },
  { value: 'referral', label: 'Referral'     },
  { value: 'website',  label: 'Website'      },
  { value: 'email',    label: 'Email'        },
  { value: 'gmb',      label: 'Google'       },
  { value: 'manual',   label: 'Other'        },
];

interface JobFormProps {
  defaultValues?: Partial<Job>;
  onSave: (data: Omit<Job, 'id' | 'businessId' | 'createdAt' | 'updatedAt'>) => void;
  onCancel: () => void;
  /**
   * 'lead' trims the form to what's relevant when an enquiry first comes in —
   * no quote amount, surface area, prep level, start date, or status picker
   * (you haven't quoted or scheduled yet). 'job' (default) shows everything.
   */
  variant?: 'job' | 'lead';
}

// Defined at module scope — NOT inside JobForm. If these were redeclared on
// each render, React would treat every keystroke as a fresh component and
// blow away input focus. (We hit exactly that bug; do not move them back.)
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
        {label}
      </label>
      {children}
    </div>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    />
  );
}

export function JobForm({ defaultValues, onSave, onCancel, variant = 'job' }: JobFormProps) {
  const isLead = variant === 'lead';
  const [name, setName] = useState(defaultValues?.name ?? '');
  const [clientName, setClientName] = useState(defaultValues?.clientName ?? '');
  const [clientPhone, setClientPhone] = useState(defaultValues?.clientPhone ?? '');
  const [clientEmail, setClientEmail] = useState(defaultValues?.clientEmail ?? '');
  const [location, setLocation] = useState(defaultValues?.location ?? '');
  const [status, setStatus] = useState<JobStatus>(defaultValues?.status ?? 'lead');
  const [estimatedValue, setEstimatedValue] = useState(defaultValues?.estimatedValue?.toString() ?? '');
  const [quoteAmount, setQuoteAmount] = useState(defaultValues?.quoteAmount?.toString() ?? '');
  const [startDate, setStartDate] = useState(defaultValues?.startDate ?? '');
  const [notes, setNotes] = useState(defaultValues?.notes ?? '');
  // Optional scope fields. Power the "estimating coach" data layer — the
  // values feed downstream insights ($/m² benchmarks, win-rate by work type).
  // Legacy 'mixed' rows carry no breakdown, so they start with nothing
  // selected rather than a chip that no longer exists.
  const [workTypes, setWorkTypes] = useState<Set<WorkType>>(
    () => new Set(
      defaultValues
        ? jobWorkTypes(defaultValues).filter((t) => t !== 'mixed')
        : [],
    ),
  );
  const [surfaceAreaM2, setSurfaceAreaM2] = useState(defaultValues?.surfaceAreaM2?.toString() ?? '');
  const [prepLevel, setPrepLevel] = useState<PrepLevel | ''>(defaultValues?.prepLevel ?? '');
  // Lead provenance — when the enquiry came in (drives the Leads per-week/month
  // trend) and where from (the source pill + by-source insights).
  const [leadDate, setLeadDate] = useState(defaultValues?.leadDate ?? '');
  const [source, setSource] = useState<LeadSource | ''>(defaultValues?.source ?? '');

  function handleSave() {
    if (!name.trim() || !clientName.trim()) return;
    onSave({
      name: name.trim(),
      clientName: clientName.trim(),
      clientPhone: clientPhone || undefined,
      clientEmail: clientEmail || undefined,
      location: location || undefined,
      status,
      estimatedValue: estimatedValue ? parseFloat(estimatedValue) : undefined,
      quoteAmount: quoteAmount ? parseFloat(quoteAmount) : undefined,
      startDate: startDate || undefined,
      leadDate: leadDate || undefined,
      source: source || undefined,
      notes: notes || undefined,
      // Set only — `workType` is derived downstream (store + jobToRow).
      workTypes: Array.from(workTypes),
      surfaceAreaM2: surfaceAreaM2 ? parseFloat(surfaceAreaM2) : undefined,
      prepLevel: prepLevel || undefined,
    });
  }

  return (
    <div className="space-y-3">
      <Field label="Job name *">
        <Input placeholder="e.g. Smith Exterior Repaint" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      {isLead ? (
        <Field label="Client name *">
          <Input placeholder="Full name" value={clientName} onChange={(e) => setClientName(e.target.value)} />
        </Field>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Client name *">
            <Input placeholder="Full name" value={clientName} onChange={(e) => setClientName(e.target.value)} />
          </Field>
          <Field label="Status">
            <Select value={status} onValueChange={(v) => setStatus(v as JobStatus)}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {JOB_STATUSES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">{s.replace('-', ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Phone">
          <Input type="tel" placeholder="021..." value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" placeholder="email@..." value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} />
        </Field>
      </div>

      <Field label="Location">
        <Input placeholder="Street address" value={location} onChange={(e) => setLocation(e.target.value)} />
      </Field>

      {/* Lead provenance — when it came in + where from. Especially useful
          for leads added by hand (phone / walk-in) so they slot into the
          Leads trend on the right week and carry a source. */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Lead came in">
          <Input type="date" value={leadDate} onChange={(e) => setLeadDate(e.target.value)} />
        </Field>
        <Field label="Source">
          <Select value={source || null} onValueChange={(v) => setSource((v ?? '') as LeadSource | '')}>
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder="Pick one">
                {(value) => {
                  if (!value) return 'Pick one';
                  return SOURCES.find((s) => s.value === value)?.label ?? 'Pick one';
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SOURCES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {/* Scope — drives downstream $/m² benchmarks and win-rate stats.
          All optional; tap-and-skip if you don't have the data yet. */}
      <div className={cn('grid gap-3', isLead ? 'grid-cols-1' : 'grid-cols-2')}>
        {/* Work type — chips, not a Select, because it's multi-select now:
            a job can be interior AND exterior. A dropdown can't express
            that without checkbox rows, and the chip row matches how the
            same field renders on the job detail sheet and the wrap-up. */}
        <Field label="Work type">
          <div className="flex flex-wrap gap-1.5">
            {WORK_TYPES.map((wt) => {
              const selected = workTypes.has(wt.value);
              return (
                <button
                  key={wt.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    setWorkTypes((prev) => {
                      const next = new Set(prev);
                      if (next.has(wt.value)) next.delete(wt.value);
                      else next.add(wt.value);
                      return next;
                    })
                  }
                  className={cn(
                    'px-3 min-h-[36px] rounded-full text-sm font-medium border transition-colors',
                    selected
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground border-border hover:border-primary/40',
                  )}
                >
                  {wt.label}
                </button>
              );
            })}
          </div>
        </Field>
        {!isLead && (
          <Field label="Prep level">
            <Select value={prepLevel || null} onValueChange={(v) => setPrepLevel((v ?? '') as PrepLevel | '')}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Pick one">
                  {(value) => {
                    if (!value) return 'Pick one';
                    return PREP_LEVELS.find((p) => p.value === value)?.label ?? 'Pick one';
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PREP_LEVELS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>

      {!isLead && (
        <Field label="Surface area (m²)">
          <Input
            type="number"
            inputMode="decimal"
            step="0.5"
            placeholder="e.g. 165"
            value={surfaceAreaM2}
            onChange={(e) => setSurfaceAreaM2(e.target.value)}
          />
        </Field>
      )}

      {isLead ? (
        <Field label="Estimated value ($)">
          <Input type="number" inputMode="numeric" placeholder="Rough ballpark, optional" value={estimatedValue} onChange={(e) => setEstimatedValue(e.target.value)} />
        </Field>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Estimated value ($)">
            <Input type="number" inputMode="numeric" placeholder="0" value={estimatedValue} onChange={(e) => setEstimatedValue(e.target.value)} />
          </Field>
          <Field label="Quote amount ($)">
            <Input type="number" inputMode="numeric" placeholder="0" value={quoteAmount} onChange={(e) => setQuoteAmount(e.target.value)} />
          </Field>
        </div>
      )}

      {!isLead && (
        <Field label="Start date">
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
      )}

      <Field label="Notes">
        <Textarea
          placeholder="Any notes about the job..."
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
          onClick={handleSave}
          disabled={!name.trim() || !clientName.trim()}
        >
          {isLead ? 'Save lead' : 'Save Job'}
        </Button>
      </div>
    </div>
  );
}
