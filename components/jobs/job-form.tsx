'use client';

import { useState } from 'react';
import { Job, JobStatus, WorkType, PrepLevel } from '@/lib/types';
import { JOB_STATUSES } from '@/lib/mock-data';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const WORK_TYPES: { value: WorkType; label: string }[] = [
  { value: 'interior',   label: 'Interior'   },
  { value: 'exterior',   label: 'Exterior'   },
  { value: 'cedar',      label: 'Cedar'      },
  { value: 'wallpaper',  label: 'Wallpaper'  },
  { value: 'roof',       label: 'Roof'       },
  { value: 'mixed',      label: 'Mixed'      },
];

const PREP_LEVELS: { value: PrepLevel; label: string }[] = [
  { value: 'light',      label: 'Light'      },
  { value: 'medium',     label: 'Medium'     },
  { value: 'heavy',      label: 'Heavy'      },
  { value: 'full-strip', label: 'Full strip' },
];

interface JobFormProps {
  defaultValues?: Partial<Job>;
  onSave: (data: Omit<Job, 'id' | 'businessId' | 'createdAt' | 'updatedAt'>) => void;
  onCancel: () => void;
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

export function JobForm({ defaultValues, onSave, onCancel }: JobFormProps) {
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
  const [workType, setWorkType] = useState<WorkType | ''>(defaultValues?.workType ?? '');
  const [surfaceAreaM2, setSurfaceAreaM2] = useState(defaultValues?.surfaceAreaM2?.toString() ?? '');
  const [prepLevel, setPrepLevel] = useState<PrepLevel | ''>(defaultValues?.prepLevel ?? '');

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
      notes: notes || undefined,
      workType: workType || undefined,
      surfaceAreaM2: surfaceAreaM2 ? parseFloat(surfaceAreaM2) : undefined,
      prepLevel: prepLevel || undefined,
    });
  }

  return (
    <div className="space-y-3">
      <Field label="Job name *">
        <Input placeholder="e.g. Smith Exterior Repaint" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

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

      {/* Scope — drives downstream $/m² benchmarks and win-rate stats.
          All optional; tap-and-skip if you don't have the data yet. */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Work type">
          {/*
            base-ui treats `value={undefined}` as uncontrolled. If we then
            switch to a real string after selection, it warns about flipping
            uncontrolled → controlled. Use `null` for the empty state so the
            Select stays controlled the whole time, and render the label
            ourselves so SelectValue doesn't show the raw enum.
          */}
          <Select value={workType || null} onValueChange={(v) => setWorkType((v ?? '') as WorkType | '')}>
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder="Pick one">
                {(value) => {
                  if (!value) return 'Pick one';
                  return WORK_TYPES.find((wt) => wt.value === value)?.label ?? 'Pick one';
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {WORK_TYPES.map((wt) => (
                <SelectItem key={wt.value} value={wt.value}>{wt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
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
      </div>

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

      <div className="grid grid-cols-2 gap-3">
        <Field label="Estimated value ($)">
          <Input type="number" inputMode="numeric" placeholder="0" value={estimatedValue} onChange={(e) => setEstimatedValue(e.target.value)} />
        </Field>
        <Field label="Quote amount ($)">
          <Input type="number" inputMode="numeric" placeholder="0" value={quoteAmount} onChange={(e) => setQuoteAmount(e.target.value)} />
        </Field>
      </div>

      <Field label="Start date">
        <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      </Field>

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
          Save Job
        </Button>
      </div>
    </div>
  );
}
