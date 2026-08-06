'use client';

/**
 * Payroll flags — the Home section that makes sure Suzie gets paid and
 * IRD gets its two follow-ups. Three flag types, all self-clearing:
 *
 *   1. "Pay {name}"      — a fortnight has ended with no pay run recorded.
 *                          Expands into a mark-paid form: hours × rate
 *                          pre-filled from her logged time, gross editable,
 *                          optional PAYE/net from the IRD calculator.
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
  eiFilingDueDate, payeMonthsDue,
  type PayPeriod,
} from '@/lib/payroll';
import type { BusinessMember } from '@/lib/types';
import { formatEntryDate } from '@/lib/format-date';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Banknote, Landmark, FileCheck2, ChevronDown } from 'lucide-react';

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
  const { teamMembers, payRuns, settings, addPayRun, updatePayRun } = useStore();
  const todayISO = todayISOLocal();

  const employees = useMemo(
    () => teamMembers.filter((m) => m.role === 'employee'),
    [teamMembers],
  );

  const cfg = useMemo(() => payrollConfig(settings), [settings]);

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
  if (duePeriods.length === 0 && eiDue.length === 0 && payeDue.length === 0) return null;

  return (
    <section>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        Payroll
      </h2>
      <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
        {duePeriods.map(({ member, period }) => (
          <PayEmployeeFlag
            key={`${member.id}:${period.start}`}
            member={member}
            period={period}
            rate={cfg.wageRate}
            todayISO={todayISO}
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
      </div>
    </section>
  );
}

// ── One "Pay {name}" row with an inline mark-paid form ─────────────────────

function PayEmployeeFlag({
  member, period, rate, todayISO, onSave,
}: {
  member: BusinessMember;
  period: PayPeriod;
  rate: number;
  todayISO: string;
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

  const [open, setOpen] = useState(false);
  const [paidDate, setPaidDate] = useState(todayISO);
  const [gross, setGross] = useState(String(suggestedGross || ''));
  const [paye, setPaye] = useState('');
  const [net, setNet] = useState('');
  const [saving, setSaving] = useState(false);

  // Forgive "$1,487.50" / "1487.5" / " 1487 " — the tired-painter rule.
  const parseAmount = (s: string): number | undefined => {
    const n = Number(s.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const grossNum = parseAmount(gross);

  const save = async () => {
    if (!grossNum || saving) return;
    setSaving(true);
    const res = await onSave({
      memberId: member.id,
      employeeName: name,
      periodStart: period.start,
      periodEnd: period.end,
      hours: hours.total || undefined,
      rate,
      gross: grossNum,
      paye: parseAmount(paye),
      net: parseAmount(net),
      paidDate,
    });
    setSaving(false);
    // On success the period drops out of duePeriods and this row unmounts.
    if (!res.ok) setOpen(true);
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-accent transition-colors text-left"
      >
        <div className="w-8 h-8 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0">
          <Banknote size={16} className="text-emerald-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            Pay {name} — {fmtPeriod(period)}
          </p>
          <p className="text-xs text-muted-foreground">
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
        <div className="px-4 pb-4 pt-1 bg-muted/30 space-y-3">
          <div className="grid grid-cols-2 gap-3">
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
              <span className="text-xs text-muted-foreground">Gross ($)</span>
              <input
                type="text"
                inputMode="decimal"
                value={gross}
                onChange={(e) => setGross(e.target.value)}
                placeholder={String(suggestedGross || '')}
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">PAYE withheld (optional)</span>
              <input
                type="text"
                inputMode="decimal"
                value={paye}
                onChange={(e) => setPaye(e.target.value)}
                placeholder="From the IRD calculator"
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Net paid (optional)</span>
              <input
                type="text"
                inputMode="decimal"
                value={net}
                onChange={(e) => setNet(e.target.value)}
                placeholder="What hit her account"
                className={inputCls}
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Saves the gross as a wages expense (no GST) on the pay date, then
            reminds you to file payday info and pay the PAYE.
          </p>
          <Button
            className="w-full min-h-[44px]"
            disabled={!grossNum || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : grossNum ? `Mark paid — ${fmtMoney(grossNum)} gross` : 'Enter the gross amount'}
          </Button>
        </div>
      )}
    </div>
  );
}
