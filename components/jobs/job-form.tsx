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

const NZ_GST_RATE = 0.15;

/**
 * Digits + one decimal point. Strips $, commas, minus signs and `e`
 * notation that a bare number input would happily accept. Same
 * sanitiser as the quote catch-up sheet — money fields should behave
 * identically wherever they appear.
 */
function sanitizeAmount(raw: string): string {
  let s = raw.replace(/[^\d.]/g, '');
  const firstDot = s.indexOf('.');
  if (firstDot !== -1) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
  }
  return s;
}

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
    <div className="min-w-0">
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
      className="min-w-0 max-w-full w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
  // Which way the typed quote figure is quoted. job.quoteAmount is
  // stored EX-GST (every money calc in the app is ex-GST) but a number
  // remembered from a conversation is usually the incl-GST one the
  // customer heard. Silently assuming ex-GST is the Aubrey Road / J16
  // bug class — same explicit chips as the quote catch-up sheet.
  // Defaults to 'ex': an existing stored amount round-trips unchanged.
  const [quoteBasis, setQuoteBasis] = useState<'ex' | 'incl'>('ex');
  const [startDate, setStartDate] = useState(defaultValues?.startDate ?? '');
  // Gut time estimate — working days on the tools × who's on it.
  // Captured at the wrap-up normally; editable here so a stale or
  // missing estimate can be fixed without re-running the wrap-up.
  const [daysEstimate, setDaysEstimate] = useState(defaultValues?.daysEstimate?.toString() ?? '');
  const [crewSize, setCrewSize] = useState(defaultValues?.crewSize?.toString() ?? '');
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
      // Convert to the stored ex-GST convention per the basis chips.
      quoteAmount: quoteAmount
        ? (quoteBasis === 'incl'
            ? Math.round((parseFloat(quoteAmount) / (1 + NZ_GST_RATE)) * 100) / 100
            : parseFloat(quoteAmount))
        : undefined,
      daysEstimate: daysEstimate ? Math.abs(parseFloat(daysEstimate)) : undefined,
      crewSize: crewSize
        ? Math.min(Math.max(Math.abs(parseInt(crewSize, 10)) || 1, 1), 6)
        : undefined,
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

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
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
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
        <Field label="Lead came in">
          <Input type="date" value={leadDate} onChange={(e) => setLeadDate(e.target.value)} />
        </Field>
        <Field label="Source">
          <Select value={source || null} onValueChange={(v) => setSource((v ?? '') as LeadSource | '')}>
            <SelectTrigger className="min-w-0 w-full h-9 text-sm">
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
          <Input
            type="text"
            inputMode="decimal"
            placeholder="Rough ballpark, optional"
            value={estimatedValue}
            onChange={(e) => setEstimatedValue(sanitizeAmount(e.target.value))}
          />
        </Field>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            {/* Two money fields side by side used to share placeholder
                "0" with nothing explaining the difference — hints below
                each keep them from being filled interchangeably. */}
            <Field label="Estimated value ($)">
              <Input
                type="text"
                inputMode="decimal"
                placeholder="Rough ballpark"
                value={estimatedValue}
                onChange={(e) => setEstimatedValue(sanitizeAmount(e.target.value))}
              />
              <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
                Your guess before quoting.
              </p>
            </Field>
            <Field label="Quote amount ($)">
              <Input
                type="text"
                inputMode="decimal"
                placeholder="As on the quote"
                value={quoteAmount}
                onChange={(e) => setQuoteAmount(sanitizeAmount(e.target.value))}
              />
              <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
                The number you sent.
              </p>
            </Field>
          </div>
          {/* GST basis — only shown once there's a figure to convert.
              Wrong basis silently throws profit, $/h and the tax
              estimate out by 15%. */}
          {quoteAmount && (
            <div>
              <div className="flex gap-1">
                {([
                  { v: 'ex' as const, label: '+ GST' },
                  { v: 'incl' as const, label: 'incl GST' },
                ]).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setQuoteBasis(o.v)}
                    aria-pressed={quoteBasis === o.v}
                    className={cn(
                      'flex-1 h-10 rounded-lg border text-xs font-medium transition-colors',
                      quoteBasis === o.v
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-input text-muted-foreground',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {Number.isFinite(parseFloat(quoteAmount)) && parseFloat(quoteAmount) > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Quote saves as $
                  {(quoteBasis === 'incl'
                    ? Math.round((parseFloat(quoteAmount) / (1 + NZ_GST_RATE)) * 100) / 100
                    : parseFloat(quoteAmount)
                  ).toLocaleString('en-NZ')}{' '}
                  ex GST
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* Gut time estimate — working days on the tools + who's on it.
          days × crew = person-days, which is what the quote AI prices
          labour from. Normally captured at the site-visit wrap-up;
          editable here so it can be fixed later without re-wrapping. */}
      {!isLead && (
        <div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Days estimate">
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.5"
                placeholder="e.g. 4"
                value={daysEstimate}
                onChange={(e) => setDaysEstimate(e.target.value)}
              />
            </Field>
            <Field label="Crew size">
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={6}
                step="1"
                placeholder="1 = solo"
                value={crewSize}
                onChange={(e) => setCrewSize(e.target.value)}
              />
            </Field>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
            Working days on the tools with that crew — not calendar days, no
            rain padding.
          </p>
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
