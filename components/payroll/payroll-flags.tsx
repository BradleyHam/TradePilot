'use client';

/**
 * Payroll flags — the Home section that makes sure Suzie gets paid and
 * IRD gets its two follow-ups. Three flag types, all self-clearing:
 *
 *   1. "Pay {name}"      — a fortnight has ended with no pay run recorded.
 *                          Expands into a mark-paid form. Hours × rate
 *                          pre-fills gross; a matching filed pay pre-fills
 *                          PAYE and net. If there is no exact precedent,
 *                          gross stays anchored to hours × rate. Net and
 *                          PAYE are recorded from the actual pay record.
 *   2. "File payday info" — a pay run is recorded but the myIR employment
 *                          information isn't (due 2 working days after
 *                          pay day). One tap to clear.
 *   3. "Pay PAYE by the 20th" — pay days in month M need their PAYE
 *                          remitted by the 20th of M+1. Appears ~2 weeks
 *                          before the due date, goes red when overdue.
 *
 * Renders nothing when there are no employees or nothing is due — the
 * "no empty visualisations" rule. Owner-only data underneath (pay_runs
 * RLS), and Home itself is owner-only, so no extra gating needed here.
 */

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import {
  payrollConfig, completedPeriods, periodIsPaid, employeeHoursInPeriod,
  eiFilingDueDate, payeMonthsDue, currentPeriod, scheduledPaydayForPeriod,
  latestKnownDeductions,
  type PayPeriod,
} from '@/lib/payroll';
import type { BusinessMember, PayRun } from '@/lib/types';
import { formatEntryDate } from '@/lib/format-date';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Banknote, Landmark, FileCheck2, ChevronDown, CalendarClock } from 'lucide-react';

function todayISOLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtMoney(n: number): string {
  const hasCents = Math.abs(n - Math.round(n)) >= 0.005;
  return `$${n.toLocaleString('en-NZ', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  })}`;
}

function fmtPeriod(p: PayPeriod): string {
  return `${formatEntryDate(p.start)} – ${formatEntryDate(p.end)}`;
}

const inputCls = 'w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring';

export function PayrollFlags() {
  const { teamMembers, payRuns, settings, addPayRun, updatePayRun, correctPayRunPaidDate } = useStore();
  const todayISO = todayISOLocal();

  const employees = useMemo(
    () => teamMembers.filter((m) => m.role === 'employee'),
    [teamMembers],
  );

  const cfg = useMemo(() => payrollConfig(settings), [settings]);
  const activePeriod = useMemo(() => currentPeriod(cfg, todayISO), [cfg, todayISO]);

  // Fortnights that have ended with no pay run recorded, per employee.
  const duePeriods = useMemo(() => {
    const out: { member: BusinessMember; period: PayPeriod }[] = [];
    for (const member of employees) {
      for (const period of completedPeriods(cfg, todayISO)) {
        if (!periodIsPaid(payRuns, member.id, period)) out.push({ member, period });
      }
    }
    return out;
  }, [employees, cfg, payRuns, todayISO]);

  // Paid runs whose myIR employment information hasn't been filed.
  const eiDue = useMemo(
    () => payRuns.filter((p) => p.paid && !p.eiFiled),
    [payRuns],
  );

  // PAYE months owing — surfaced from ~2 weeks before the due date.
  const payeDue = useMemo(
    () => payeMonthsDue(payRuns).filter((m) => {
      const showFrom = `${m.dueDate.slice(0, 8)}06`; // ~the 6th of the due month
      return todayISO >= showFrom.slice(0, 10) || todayISO >= m.dueDate;
    }),
    [payRuns, todayISO],
  );

  if (employees.length === 0) return null;

  return (
    <section>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        Payroll
      </h2>
      <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
        {duePeriods.length === 0 && activePeriod && employees.map((member) => {
          const payday = scheduledPaydayForPeriod(cfg, activePeriod);
          return (
            <div key={`next:${member.id}`} className="flex items-center gap-3 px-4 py-3 min-h-[56px]">
              <div className="w-8 h-8 rounded-xl bg-violet-50 flex items-center justify-center shrink-0">
                <CalendarClock size={16} className="text-violet-600" strokeWidth={1.8} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  Next payday — {formatEntryDate(payday)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {member.displayName ?? 'Employee'} · current period {fmtPeriod(activePeriod)}
                </p>
              </div>
            </div>
          );
        })}
        {duePeriods.map(({ member, period }) => (
          <PayEmployeeFlag
            key={`${member.id}:${period.start}`}
            member={member}
            period={period}
            rate={cfg.wageRate}
            todayISO={todayISO}
            scheduledPayday={scheduledPaydayForPeriod(cfg, period)}
            previousPayRuns={payRuns}
            onSave={addPayRun}
          />
        ))}
        {eiDue.map((run) => (
          <div key={run.id} className="flex items-center gap-3 px-4 py-3 min-h-[56px]">
            <div className="w-8 h-8 rounded-xl bg-sky-50 flex items-center justify-center shrink-0">
              <FileCheck2 size={16} className="text-sky-600" strokeWidth={1.8} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                File payday info in myIR — {run.employeeName}
              </p>
              <p className="text-xs text-muted-foreground">
                Paid {run.paidDate ? formatEntryDate(run.paidDate) : '—'}
                {run.paidDate ? ` · due ${formatEntryDate(eiFilingDueDate(run.paidDate))}` : ''}
                {run.paye != null ? ` · PAYE ${fmtMoney(run.paye)}` : ''}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px] shrink-0"
              onClick={() => updatePayRun(run.id, { eiFiled: true })}
            >
              Filed it
            </Button>
          </div>
        ))}
        {payeDue.map((m) => {
          const overdue = todayISO > m.dueDate;
          return (
            <div key={m.monthKey} className="flex items-center gap-3 px-4 py-3 min-h-[56px]">
              <div className={cn(
                'w-8 h-8 rounded-xl flex items-center justify-center shrink-0',
                overdue ? 'bg-red-50' : 'bg-amber-50',
              )}>
                <Landmark size={16} className={overdue ? 'text-red-600' : 'text-amber-600'} strokeWidth={1.8} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {overdue ? 'OVERDUE — pay' : 'Pay'} PAYE to IRD by {formatEntryDate(m.dueDate)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {m.payeTotal != null
                    ? `${fmtMoney(m.payeTotal)} for ${m.runs.length} pay day${m.runs.length === 1 ? '' : 's'}`
                    : `${m.runs.length} pay day${m.runs.length === 1 ? '' : 's'} (${fmtMoney(m.grossTotal)} gross) — check myIR for the amount`}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="min-h-[44px] shrink-0"
                onClick={() => m.runs.forEach((r) => updatePayRun(r.id, { payePaid: true }))}
              >
                Paid
              </Button>
            </div>
          );
        })}
        {payRuns.length > 0 && <details className="px-4 py-2">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">Pay records · correct a date</summary>
          <div className="space-y-2 pb-2">
            {[...payRuns].sort((a, b) => (b.paidDate ?? '').localeCompare(a.paidDate ?? '')).slice(0, 6).map((run) => (
              <PayDateCorrection key={run.id} run={run} todayISO={todayISO} onSave={correctPayRunPaidDate} />
            ))}
          </div>
        </details>}
      </div>
    </section>
  );
}

function PayDateCorrection({ run, todayISO, onSave }: {
  run: PayRun;
  todayISO: string;
  onSave: (id: string, date: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(run.paidDate ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const validDate = date && date <= todayISO && !Number.isNaN(new Date(`${date}T12:00:00`).getTime());

  async function save() {
    if (!validDate || saving) return;
    setSaving(true);
    setError(undefined);
    const result = await onSave(run.id, date);
    setSaving(false);
    if (result.ok) setEditing(false);
    else setError(result.error ?? 'Could not save this date.');
  }

  return <div className="rounded-xl border border-border p-3">
    <div className="flex items-center justify-between gap-2">
      <p className="text-sm"><span className="font-medium">{run.employeeName}</span> · {fmtPeriod({ start: run.periodStart, end: run.periodEnd })}<br />
        <span className="text-muted-foreground">Paid {run.paidDate ? formatEntryDate(run.paidDate) : 'date unknown'} · {fmtMoney(run.gross)} gross</span>
      </p>
      <button type="button" className="min-h-11 shrink-0 px-2 text-sm font-semibold text-primary" onClick={() => { setDate(run.paidDate ?? ''); setError(undefined); setEditing((v) => !v); }}>{editing ? 'Cancel' : 'Edit date'}</button>
    </div>
    {editing && <div className="mt-3 space-y-2">
      <label className="block text-sm">Actual payment date
        <input type="date" value={date} max={todayISO} onChange={(e) => setDate(e.target.value)} className={inputCls} />
      </label>
      <p className="text-xs text-muted-foreground">Updates this pay record and its wages expense. Check myIR if payday information was already filed.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button className="min-h-11 w-full" disabled={!validDate || saving || date === run.paidDate} onClick={() => void save()}>{saving ? 'Saving…' : 'Save payment date'}</Button>
    </div>}
  </div>;
}

// ── One "Pay {name}" row with an inline mark-paid form ─────────────────────

function PayEmployeeFlag({
  member, period, rate, todayISO, scheduledPayday, previousPayRuns, onSave,
}: {
  member: BusinessMember;
  period: PayPeriod;
  rate: number;
  todayISO: string;
  scheduledPayday: string;
  previousPayRuns: PayRun[];
  onSave: (input: {
    memberId?: string;
    employeeName: string;
    periodStart: string;
    periodEnd: string;
    hours?: number;
    rate?: number;
    gross: number;
    paye?: number;
    net?: number;
    paidDate: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const { entries } = useStore();
  const name = member.displayName ?? 'Employee';

  const hours = useMemo(
    () => employeeHoursInPeriod(entries, member.userId, period),
    [entries, member.userId, period],
  );
  const suggestedGross = Math.round(hours.total * rate * 100) / 100;
  const initialDeductions = useMemo(
    () => latestKnownDeductions(previousPayRuns, member.id, suggestedGross),
    [previousPayRuns, member.id, suggestedGross],
  );
  const overdue = todayISO > scheduledPayday;
  const dueToday = todayISO === scheduledPayday;

  const [open, setOpen] = useState(false);
  const [paidDate, setPaidDate] = useState(todayISO);
  const [gross, setGross] = useState(String(suggestedGross || ''));
  const [paye, setPaye] = useState(initialDeductions ? String(initialDeductions.paye) : '');
  const [net, setNet] = useState(initialDeductions ? String(initialDeductions.net) : '');
  const [deductionSourceDate, setDeductionSourceDate] = useState(initialDeductions?.paidDate);
  const [paidHours, setPaidHours] = useState(String(hours.total || ''));
  const [paidRate, setPaidRate] = useState(String(rate));
  const [touched, setTouched] = useState({ paye: false, net: false });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const parseAmount = (s: string): number | undefined => {
    const cleaned = s.replace(/[$,\s]/g, '');
    if (!cleaned) return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const grossNum = parseAmount(gross);
  const hoursNum = parseAmount(paidHours);
  const rateNum = parseAmount(paidRate);
  const r2 = (n: number): string => String(Math.round(n * 100) / 100);

  // Only an explicit gross edit or hours/rate edit may change gross.
  // Never feed a derived deduction back into it while someone types net.
  const onGrossChange = (s: string) => {
    setGross(s);
    const g = parseAmount(s);
    const known = g != null ? latestKnownDeductions(previousPayRuns, member.id, g) : null;
    if (!touched.paye) setPaye(known ? String(known.paye) : '');
    if (!touched.net) setNet(known ? String(known.net) : '');
    setDeductionSourceDate(!touched.paye && !touched.net ? known?.paidDate : undefined);
  };
  const onHoursOrRateChange = (field: 'hours' | 'rate', value: string) => {
    if (field === 'hours') setPaidHours(value);
    else setPaidRate(value);
    const h = parseAmount(field === 'hours' ? value : paidHours);
    const r = parseAmount(field === 'rate' ? value : paidRate);
    onGrossChange(h != null && r != null ? r2(h * r) : '');
  };
  const onNetChange = (s: string) => {
    setNet(s);
    // A copied PAYE amount is no longer confirmed once actual net changes.
    if (!touched.paye) setPaye('');
    setDeductionSourceDate(undefined);
    setTouched((t) => ({ ...t, net: true }));
  };
  const onPayeChange = (s: string) => {
    setPaye(s);
    setDeductionSourceDate(undefined);
    setTouched((t) => ({ ...t, paye: true }));
  };

  const payeNum = parseAmount(paye);
  const netNum = parseAmount(net);
  const invalidAmount = [gross, net, paye, paidHours, paidRate].some((s) => s.trim() !== '' && parseAmount(s) == null);
  const exceedsGross = grossNum != null && ((netNum ?? 0) + (payeNum ?? 0) > grossNum + 0.02);
  const difference = grossNum != null && netNum != null ? Math.round((grossNum - netNum) * 100) / 100 : undefined;
  const otherDeductions = difference != null && payeNum != null ? Math.round((difference - payeNum) * 100) / 100 : undefined;
  const canSave = !!grossNum && !invalidAmount && !exceedsGross && !!paidDate && !saving;

  const save = async () => {
    if (!canSave || !grossNum) return;
    setSaveError(undefined);
    setSaving(true);
    const res = await onSave({
      memberId: member.id,
      employeeName: name,
      periodStart: period.start,
      periodEnd: period.end,
      hours: hoursNum,
      rate: rateNum,
      gross: grossNum,
      paye: parseAmount(paye),
      net: parseAmount(net),
      paidDate,
    });
    setSaving(false);
    // On success the period drops out of duePeriods and this row unmounts.
    if (!res.ok) { setOpen(true); setSaveError(res.error ?? 'Pay was not saved. Please retry.'); }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-accent transition-colors text-left"
      >
        <div className={cn(
          'w-8 h-8 rounded-xl flex items-center justify-center shrink-0',
          overdue ? 'bg-red-50' : 'bg-emerald-50',
        )}>
          <Banknote size={16} className={overdue ? 'text-red-600' : 'text-emerald-600'} strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {overdue ? 'OVERDUE — pay' : 'Pay'} {name}
            {' '}· {dueToday ? 'today' : `${overdue ? 'was due' : 'due'} ${formatEntryDate(scheduledPayday)}`}
          </p>
          <p className="text-xs text-muted-foreground">
            {fmtPeriod(period)} ·{' '}
            {hours.total > 0
              ? `${hours.total} hrs × $${rate} = ${fmtMoney(suggestedGross)} gross`
              : `No hours logged by ${name} this fortnight`}
            {hours.legacyHelper > 0
              ? ` · includes ${hours.legacyHelper} old helper hrs from your entries — check for double-ups`
              : ''}
          </p>
        </div>
        <ChevronDown
          size={16}
          className={cn('text-muted-foreground shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <fieldset disabled={saving} className="px-4 pb-4 pt-1 bg-muted/30 space-y-3">
          <p className="text-xs text-muted-foreground">{hours.total} hours logged for {fmtPeriod(period)}. Enter the hours this payment covers.</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-muted-foreground">Hours paid</span>
              <input type="text" inputMode="decimal" value={paidHours} onChange={(e) => onHoursOrRateChange('hours', e.target.value)} className={inputCls} />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Hourly rate ($)</span>
              <input type="text" inputMode="decimal" value={paidRate} onChange={(e) => onHoursOrRateChange('rate', e.target.value)} className={inputCls} />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Paid on</span>
              <input
                type="date"
                value={paidDate}
                max={todayISO}
                onChange={(e) => setPaidDate(e.target.value)}
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Net paid ($)</span>
              <input
                type="text"
                inputMode="decimal"
                value={net}
                onChange={(e) => onNetChange(e.target.value)}
                placeholder="What hit their account"
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">PAYE withheld</span>
              <input
                type="text"
                inputMode="decimal"
                value={paye}
                onChange={(e) => onPayeChange(e.target.value)}
                placeholder="From the IRD calculator"
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Gross ($) — hours × rate</span>
              <input
                type="text"
                inputMode="decimal"
                value={gross}
                onChange={(e) => onGrossChange(e.target.value)}
                placeholder={String(suggestedGross || '')}
                className={inputCls}
              />
            </label>
          </div>
          {hoursNum != null && Math.abs(hoursNum - hours.total) > 0.01 && (
            <p className="text-xs text-amber-700">Paying {hoursNum} hours; {hours.total} are logged in this period. Check the period and timesheets.</p>
          )}
          {(invalidAmount || exceedsGross) && <p role="alert" className="text-sm text-destructive">{invalidAmount ? 'Enter valid, non-negative amounts.' : 'Net pay plus PAYE is more than gross. Check these amounts before saving.'}</p>}
          {!exceedsGross && difference != null && payeNum == null && (
            <p className="text-xs text-muted-foreground">{fmtMoney(difference)} difference between gross and net. Enter PAYE from the pay record; this difference may include other deductions.</p>
          )}
          {!exceedsGross && otherDeductions != null && otherDeductions > 0.02 && (
            <p className="text-xs text-amber-700">{fmtMoney(otherDeductions)} remains after net pay and PAYE. Check any other deductions against the pay record.</p>
          )}
          {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
          {deductionSourceDate && grossNum != null && payeNum != null && netNum != null && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 dark:border-emerald-900 dark:bg-emerald-950/30">
              <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
                Transfer {fmtMoney(netNum)} · PAYE {fmtMoney(payeNum)}
              </p>
              <p className="text-xs text-emerald-700/80 dark:text-emerald-400/80">
                Filled from the latest filed pay with the same {fmtMoney(grossNum)} gross
                {' '}({formatEntryDate(deductionSourceDate)}). Review before paying.
              </p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            A matching filed pay fills net and PAYE automatically. Otherwise,
            enter net pay and PAYE from the pay record. Gross stays based on hours × rate; you can edit it for additional pay.
            Saves gross wages with no GST, then reminds you to file payday info and pay PAYE.
          </p>
          <Button
            className="w-full min-h-[44px]"
            disabled={!canSave}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : grossNum ? `Mark paid — ${fmtMoney(grossNum)} gross` : 'Enter hours and rate (or gross)'}
          </Button>
        </fieldset>
      )}
    </div>
  );
}
