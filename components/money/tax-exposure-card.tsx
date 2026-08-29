'use client';

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { estimateInvoiceBasisGst, estimateTax, taxYearOf } from '@/lib/tax-estimator';
import { payeMonthsDue } from '@/lib/payroll';
import { ChevronDown, CircleCheck, Info, Landmark, Receipt, TrendingDown, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

const fmt = (n: number, cents = false) => `$${n.toLocaleString('en-NZ', {
  minimumFractionDigits: cents ? 2 : 0,
  maximumFractionDigits: cents ? 2 : 0,
})}`;

interface ReconciledSnapshot {
  checkedAt: string;
  gstDueNow: number;
  incomeTaxDueNow: number;
  payeDueNow: number;
}

interface PendingGstClaim {
  label: string;
  amount: number;
  status?: string;
}

interface SupplierReserve {
  supplier: string;
  amount: number;
  status?: string;
}

function parseSnapshot(value?: string): ReconciledSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ReconciledSnapshot>;
    if (!parsed.checkedAt) return null;
    return {
      checkedAt: parsed.checkedAt,
      gstDueNow: Number(parsed.gstDueNow ?? 0),
      incomeTaxDueNow: Number(parsed.incomeTaxDueNow ?? 0),
      payeDueNow: Number(parsed.payeDueNow ?? 0),
    };
  } catch {
    return null;
  }
}

function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(`${iso}T12:00:00`));
}

function parseIdSet(value?: string): Set<string> {
  if (!value) return new Set();
  try {
    const ids = JSON.parse(value) as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function parsePendingGstClaims(value?: string): PendingGstClaim[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((claim) => {
      if (!claim || typeof claim !== 'object') return [];
      const candidate = claim as Partial<PendingGstClaim>;
      const amount = Number(candidate.amount ?? 0);
      if (!candidate.label || !Number.isFinite(amount) || amount <= 0) return [];
      return [{ label: candidate.label, amount, status: candidate.status }];
    });
  } catch {
    return [];
  }
}

function parseSupplierReserve(value?: string): SupplierReserve | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SupplierReserve>;
    const amount = Number(parsed.amount ?? 0);
    if (!parsed.supplier || !Number.isFinite(amount) || amount <= 0) return null;
    return { supplier: parsed.supplier, amount, status: parsed.status };
  } catch {
    return null;
  }
}

/** Keep assessed amounts already due separate from planning reserves. */
export function TaxExposureCard() {
  const { entries, invoices, payRuns, settings } = useStore();
  const [open, setOpen] = useState(false);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const snapshot = parseSnapshot(
    settings.find((setting) => setting.key === 'tax_reconciled_snapshot')?.value,
  );
  const capitalEntryIds = useMemo(
    () => parseIdSet(settings.find((setting) => setting.key === 'capital_entry_ids')?.value),
    [settings],
  );
  const pendingGstClaims = useMemo(
    () => parsePendingGstClaims(settings.find((setting) => setting.key === 'pending_gst_claims')?.value),
    [settings],
  );
  const supplierReserve = parseSupplierReserve(
    settings.find((setting) => setting.key === 'supplier_reserve')?.value,
  );

  const gst = estimateInvoiceBasisGst(entries, invoices, now);
  const incomeTax = estimateTax(entries, now, taxYearOf(now), undefined, capitalEntryIds);
  const paye = payeMonthsDue(payRuns);
  const overduePaye = paye.filter((month) => month.dueDate <= today);
  const futurePaye = paye.filter((month) => month.dueDate > today);
  const overduePayeTotal = overduePaye.reduce((sum, month) => sum + (month.payeTotal ?? 0), 0);
  const futurePayeTotal = futurePaye.reduce((sum, month) => sum + (month.payeTotal ?? 0), 0);

  const confirmedDueNow = snapshot
    ? snapshot.gstDueNow + snapshot.incomeTaxDueNow + Math.max(snapshot.payeDueNow, overduePayeTotal)
    : overduePayeTotal;
  const gstReserve = Math.max(0, gst.net);
  const pendingGstTotal = pendingGstClaims.reduce((sum, claim) => sum + claim.amount, 0);
  const gstAfterPendingClaims = Math.max(0, gstReserve - pendingGstTotal);
  const incomeTaxReserve = Math.max(0, incomeTax.incomeTax);
  const keepAside = gstReserve + futurePayeTotal + incomeTaxReserve;
  const totalNotFree = confirmedDueNow + keepAside + (supplierReserve?.amount ?? 0);

  return (
    <div className="bg-card border border-border/70 rounded-[1.5rem] overflow-hidden shadow-sm">
      <div className="px-5 pt-4 pb-3">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Tax position</p>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-emerald-700">
              <CircleCheck size={14} strokeWidth={2} />
              <p className="text-[10px] font-semibold uppercase tracking-wide">Due now</p>
            </div>
            <p className="mt-1 text-xl font-bold tabular-nums text-emerald-800">{fmt(confirmedDueNow, true)}</p>
            <p className="mt-0.5 text-[10px] leading-snug text-emerald-700">
              {snapshot ? `myIR checked ${formatShortDate(snapshot.checkedAt)}` : 'From overdue payroll records'}
            </p>
          </div>

          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-amber-700">
              <Landmark size={14} strokeWidth={2} />
              <p className="text-[10px] font-semibold uppercase tracking-wide">Keep aside</p>
            </div>
            <p className="mt-1 text-xl font-bold tabular-nums text-amber-900">{fmt(keepAside)}</p>
            <p className="mt-0.5 text-[10px] leading-snug text-amber-700">Open periods · planning reserve</p>
          </div>
        </div>
      </div>

      <button
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-12 w-full items-center justify-between border-t border-border/60 px-5 text-left transition-colors hover:bg-muted/30 active:bg-muted/50"
      >
        <span className="text-sm font-medium text-foreground">What makes up the reserve?</span>
        <ChevronDown size={18} className={cn('text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border bg-muted/20 px-4 py-4">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Open obligations</p>
            <ReserveRow
              icon={<Receipt size={14} className="text-orange-500" strokeWidth={1.8} />}
              label={`GST · ${gst.period.label}`}
              sublabel={`Invoice basis · due ${formatShortDate(gst.period.dueDate)}`}
              value={fmt(gstReserve)}
            />
            <ReserveRow
              icon={<Users size={14} className="text-violet-500" strokeWidth={1.8} />}
              label="PAYE"
              sublabel={futurePaye.length > 0 ? `Next due ${formatShortDate(futurePaye[0].dueDate)}` : 'Nothing awaiting payment'}
              value={fmt(futurePayeTotal, true)}
            />
            <ReserveRow
              icon={<TrendingDown size={14} className="text-blue-500" strokeWidth={1.8} />}
              label={`Income tax · ${incomeTax.taxYear.label}`}
              sublabel="Planning estimate, not an IRD assessment"
              value={fmt(incomeTaxReserve)}
            />
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">GST working</p>
            <Row label="GST on invoices + taxable sales" value={fmt(gst.output, true)} />
            <Row label="GST back on confirmed costs" value={`-${fmt(gst.input, true)}`} />
            <Row label="Keep aside for this return" value={fmt(gstReserve, true)} bold />
            {pendingGstTotal > 0 && (
              <div className="mt-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5">
                <Row label="Possible vehicle GST claims" value={`-${fmt(pendingGstTotal, true)}`} />
                <Row label="If seller records are accepted" value={fmt(gstAfterPendingClaims, true)} bold />
                <p className="mt-1 text-[10px] leading-relaxed text-blue-700">
                  Not deducted yet. Keep the full GST reserve until the private-sale records are complete.
                </p>
              </div>
            )}
          </div>

          {supplierReserve && (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Other cash reserved</p>
              <ReserveRow
                icon={<Receipt size={14} className="text-rose-500" strokeWidth={1.8} />}
                label={`${supplierReserve.supplier} bills`}
                sublabel={supplierReserve.status ?? 'Awaiting final supplier statement'}
                value={fmt(supplierReserve.amount, true)}
              />
              <Row label="Total not free to spend" value={fmt(totalNotFree, true)} bold />
            </div>
          )}

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Income-tax working</p>
            <Row label="Income received (ex GST)" value={fmt(incomeTax.income)} />
            <Row label="Logged costs incl Suzie's gross wages" value={`-${fmt(incomeTax.expensesLogged)}`} />
            <Row label="Other pro-rated deductions" value={`-${fmt(incomeTax.extraDeductions)}`} />
            <Row label="Estimated taxable profit" value={fmt(incomeTax.taxableProfit)} bold />
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
            <Info size={13} className="mt-0.5 shrink-0" strokeWidth={2} />
            <p className="text-[11px] leading-relaxed">
              “Due now” is the last reconciled myIR position. “Keep aside” moves with TradePilot.
              Vehicle depreciation and any late second-hand GST claims stay out until the records are confirmed.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ReserveRow({ icon, label, sublabel, value }: {
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  value: string;
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 py-1.5">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">{label}</p>
          <p className="text-[10px] leading-relaxed text-muted-foreground">{sublabel}</p>
        </div>
      </div>
      <p className="shrink-0 text-sm font-bold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className={cn('text-xs', bold ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
        {label}
      </span>
      <span className={cn('text-sm tabular-nums text-foreground', bold && 'font-bold')}>
        {value}
      </span>
    </div>
  );
}
