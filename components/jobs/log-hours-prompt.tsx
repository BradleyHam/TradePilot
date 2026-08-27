'use client';

import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useStore } from '@/lib/store';
import { WORKER_KIND_LABELS } from '@/lib/worker-rates';
import type { Entry, Invoice, WorkerKind } from '@/lib/types';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── "You got paid — but where did the hours go?" ───────────────────────────
//
// Fires right after an invoice is marked paid on a job that has ZERO hours
// logged. Without hours, the $/h maths can't exist: jobStats returns
// expectedHourlyRate = null, the gauge hides, and the job never tells Brad
// whether it was worth doing. Payday is the last natural moment to catch
// that — after this the job is closed out and nobody comes back to it.
//
// Design rules honoured here:
// - NON-BLOCKING. Mark-paid has already happened by the time this opens.
//   Dismissing (swipe down / "Not now") costs nothing and loses nothing.
// - One screen, one save. Hours + who + date. Activity is deliberately
//   omitted — this is a backfill of the job's total, not a diary entry.
// - Anti-nag: callers use `shouldPromptForHours()`, which never fires for
//   deposit invoices (a deposit is normally paid BEFORE the work starts,
//   so zero hours is the correct state, not a gap).

/**
 * Should marking this invoice paid trigger the hours prompt?
 *
 * True only when:
 * - the invoice is attached to a job, AND
 * - that job has no (non-draft) hours entries at all, AND
 * - the invoice isn't a deposit — deposits get paid before brushes touch
 *   the wall, so "no hours yet" is expected there, and prompting would
 *   train the user to dismiss the prompt (then the useful ones die too).
 */
export function shouldPromptForHours(
  invoice: Pick<Invoice, 'jobId' | 'kind'> | undefined,
  entries: Entry[],
): boolean {
  if (!invoice?.jobId) return false;
  if (invoice.kind === 'deposit') return false;
  return !entries.some(
    (e) => e.jobId === invoice.jobId && e.type === 'hours' && !e.isDraft,
  );
}

interface LogHoursPromptProps {
  /** Job to log hours against. Null = sheet closed. */
  jobId: string | null;
  onClose: () => void;
}

/**
 * Bottom sheet: "Nice — that's paid. How many hours went into it?"
 * Saving creates a single hours entry on the job (same shape as
 * LogHoursBar / the Entry form), which immediately lights up the
 * hourly-rate gauge and the Hours tile.
 *
 * Self-contained: reads addEntry/businessId/jobs from the store so the
 * three call sites (invoice row, invoice form, Home flag) stay one-liners.
 */
export function LogHoursPrompt({ jobId, onClose }: LogHoursPromptProps) {
  return (
    <Sheet open={jobId !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* key={jobId} remounts the form per job, so field state always starts
          fresh — no reset-on-open effect needed (react-hooks/set-state-in-effect). */}
      {jobId !== null && <PromptForm key={jobId} jobId={jobId} onClose={onClose} />}
    </Sheet>
  );
}

function PromptForm({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { jobs, addEntry, businessId } = useStore();
  const job = jobs.find((j) => j.id === jobId);

  const [hoursStr, setHoursStr] = useState('');
  const [workerKind, setWorkerKind] = useState<WorkerKind>('owner');
  // Who the non-owner worker actually was. Optional, and only sent when
  // filled in — same field as the entry form's "Someone else" path.
  const [workerName, setWorkerName] = useState('');
  // What they cost per hour, ex-GST. Optional — blank means the hours cost
  // the job nothing, which beats guessing. See lib/labour-accrual.ts.
  const [costRate, setCostRate] = useState('');
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));

  const hoursNum = parseFloat(hoursStr);
  const canSave = !Number.isNaN(hoursNum) && hoursNum > 0;

  function handleSave() {
    if (!canSave || !job) return;
    addEntry({
      id: `ent_${Date.now()}`,
      businessId: businessId ?? '',
      jobId: job.id,
      type: 'hours',
      hours: hoursNum,
      workerKind,
      workerName: (workerKind !== 'owner' && workerName.trim()) ? workerName.trim() : undefined,
      workerCostRate: (workerKind !== 'owner' && parseFloat(costRate) > 0) ? parseFloat(costRate) : undefined,
      description: `Hours on ${job.name}`,
      entryDate,
      gstApplies: false,
      createdAt: new Date().toISOString(),
    });
    onClose();
  }

  return (
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Clock size={18} strokeWidth={2} className="text-blue-500" />
            No hours on this job yet
          </SheetTitle>
          <p className="text-sm text-muted-foreground">
            {job ? `${job.name} just got paid, ` : 'This job just got paid, '}
            but with no hours logged it can&apos;t show what you earned per hour.
            A rough total is fine.
          </p>
        </SheetHeader>

        <div className="mt-4 space-y-3">
          <div className="flex items-end gap-3">
            <div className="flex-1 min-w-0">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
                Total hours
              </label>
              <input
                type="number"
                inputMode="decimal"
                step="0.5"
                min={0}
                autoFocus
                value={hoursStr}
                onChange={(e) => setHoursStr(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSave(); } }}
                placeholder="0"
                className="w-full h-11 px-3 rounded-lg border border-input bg-background text-base font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex-1 min-w-0">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
                Who
              </label>
              <select
                value={workerKind}
                onChange={(e) => setWorkerKind(e.target.value as WorkerKind)}
                className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {(Object.keys(WORKER_KIND_LABELS) as WorkerKind[]).map((k) => (
                  <option key={k} value={k}>{WORKER_KIND_LABELS[k]}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Name for a non-owner tier — a subbie or one-off helper. Optional,
              but it's what stops the row reading "Subcontractor · 8h" with no
              way to remember which sub. */}
          {workerKind !== 'owner' && (
            <div>
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
                {workerKind === 'subcontractor' ? 'Subcontractor' : 'Their name'} (optional)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={workerName}
                  onChange={(e) => setWorkerName(e.target.value)}
                  placeholder={workerKind === 'subcontractor' ? "e.g. Dave, or Dave's Plastering" : 'e.g. Dave'}
                  className="flex-1 min-w-0 h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.5"
                  min={0}
                  value={costRate}
                  onChange={(e) => setCostRate(e.target.value)}
                  placeholder="$/h"
                  className="w-20 shrink-0 h-11 px-3 rounded-lg border border-input bg-background text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
                  aria-label="Their rate, $ per hour ex-GST"
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
                Rate is ex-GST, and optional — with one, these hours count as a
                cost on the job from the day they were worked.
              </p>
            </div>
          )}

          <div>
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
              Date (roughly when the work happened)
            </label>
            <input
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Same payroll trap as the Entry form: an employee-tier row logged
              here carries no loggedByUserId, so payroll never sees it. */}
          {workerKind !== 'owner' && workerKind !== 'subcontractor' && (
            <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-snug">
              If this is someone on payroll (e.g. Suzie), their hours should be
              logged from their own login — hours added here don&apos;t reach payroll.
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="h-11 px-4 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              Not now
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className={cn(
                'h-11 px-5 rounded-xl text-sm font-semibold transition-colors',
                canSave
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95'
                  : 'bg-muted text-muted-foreground cursor-not-allowed',
              )}
            >
              Save hours
            </button>
          </div>
        </div>
      </SheetContent>
  );
}
