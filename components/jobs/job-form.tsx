'use client';

import { useState } from 'react';
import { Job, JobStatus } from '@/lib/types';
import { JOB_STATUSES } from '@/lib/mock-data';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

interface JobFormProps {
  defaultValues?: Partial<Job>;
  onSave: (data: Omit<Job, 'id' | 'businessId' | 'createdAt' | 'updatedAt'>) => void;
  onCancel: () => void;
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
    });
  }

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
        {label}
      </label>
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
