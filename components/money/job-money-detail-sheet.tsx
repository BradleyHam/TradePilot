'use client';

import { useMemo, useState, type ElementType } from 'react';
import { format, parseISO } from 'date-fns';
import { useStore } from '@/lib/store';
import { entryExGst, jobStats } from '@/lib/job-stats';
import { payrollConfig } from '@/lib/payroll';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { Entry, Material } from '@/lib/types';
import { ArrowDownLeft, ChevronDown, Clock3, Package, Receipt, TrendingUp, WalletCards } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WorkProgressCard } from '@/components/jobs/work-progress-card';

interface JobMoneyDetailSheetProps {
  jobId: string | null;
  open: boolean;
  onClose: () => void;
  asOfDate: string;
  onEditProgress: (jobId: string) => void;
}

function money(value: number): string {
  return value.toLocaleString('en-NZ', {
    style: 'currency',
    currency: 'NZD',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function shortDate(value: string): string {
  return format(parseISO(value), 'd MMM yyyy');
}

function costTitle(entry: Entry): string {
  return entry.description || entry.company || entry.supplier || 'Expense';
}

function materialTitle(material: Material): string {
  return [material.brand, material.productName].filter(Boolean).join(' · ')
    || material.productType?.replaceAll('_', ' ')
    || 'Material used';
}

export function JobMoneyDetailSheet({
  jobId,
  open,
  onClose,
  asOfDate,
  onEditProgress,
}: JobMoneyDetailSheetProps) {
  const {
    jobs, entries, materials, settings, teamMembers,
    jobProgressSnapshots, jobProgressPeople,
  } = useStore();
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const job = jobs.find((candidate) => candidate.id === jobId);
  const wageRate = payrollConfig(settings).wageRate;
  const ownerUserId = teamMembers.find((member) => member.role === 'owner')?.userId;

  const stats = useMemo(
    () => job ? jobStats(job, entries, materials, { wageRate, ownerUserId }) : null,
    [job, entries, materials, wageRate, ownerUserId],
  );

  const incomeRows = useMemo(
    () => entries
      .filter((entry) => entry.jobId === jobId && entry.type === 'income')
      .sort((a, b) => b.entryDate.localeCompare(a.entryDate)),
    [entries, jobId],
  );

  const directCostRows = useMemo(
    () => entries
      .filter((entry) =>
        entry.jobId === jobId
        && !entry.isDraft
        && (entry.type === 'expense' || entry.type === 'bill'),
      )
      .sort((a, b) => b.entryDate.localeCompare(a.entryDate)),
    [entries, jobId],
  );

  const jobMaterialRows = useMemo(
    () => materials
      .filter((material) => {
        if (material.jobId !== jobId) return false;
        if (!material.entryId) return true;
        return !entries.some((entry) => entry.id === material.entryId && entry.isDraft);
      })
      .sort((a, b) => (b.usedOn ?? b.createdAt).localeCompare(a.usedOn ?? a.createdAt)),
    [materials, entries, jobId],
  );

  if (!job || !stats) return null;

  const stillToReceive = Math.max(0, stats.expectedIncome - stats.totalIncome);
  const status = job.status.replaceAll('-', ' ');
  const labourBillIds = new Set(
    entries
      .filter((entry) => entry.jobId === jobId && entry.type === 'hours')
      .map((entry) => entry.labourBillEntryId)
      .filter((id): id is string => Boolean(id)),
  );
  const materialSourceIds = new Set(
    jobMaterialRows.map((material) => material.entryId).filter((id): id is string => Boolean(id)),
  );
  const materialSourceGroupIds = new Set(
    entries
      .filter((entry) => materialSourceIds.has(entry.id) && entry.billGroupId)
      .map((entry) => entry.billGroupId as string),
  );
  const otherCostRows = directCostRows.filter((entry) => {
    if (labourBillIds.has(entry.id)) return false;
    if (materialSourceIds.has(entry.id)) return false;
    return !entry.billGroupId || !materialSourceGroupIds.has(entry.billGroupId);
  });
  const explainedMaterialCost = jobMaterialRows.reduce((sum, material) => sum + (material.cost ?? 0), 0)
    + otherCostRows.reduce((sum, entry) => sum + entryExGst(entry), 0);
  const unitemisedRemainder = Math.max(0, stats.materialsCost - explainedMaterialCost);

  return (
    <Sheet open={open} onOpenChange={(next) => {
      if (!next) {
        setMaterialsOpen(false);
        onClose();
      }
    }}>
      <SheetContent side="bottom" className="rounded-t-3xl p-0 [--desktop-sheet-w:42rem]">
        <div className="flex max-h-[90dvh] flex-col overflow-hidden md:h-full md:max-h-none">
          <SheetHeader className="shrink-0 border-b border-border px-5 pb-4 pt-5 pr-14 text-left">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Job money breakdown
            </p>
            <SheetTitle className="mt-1 text-lg font-bold leading-tight">{job.name}</SheetTitle>
            <p className="mt-1 capitalize text-xs text-muted-foreground">
              {status} · all figures ex GST
            </p>
          </SheetHeader>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-10">
            <section className="overflow-hidden rounded-2xl bg-slate-950 text-white">
              <div className="px-5 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/55">
                  Expected left after costs
                </p>
                <p className={cn(
                  'mt-1.5 text-3xl font-bold tracking-tight tabular-nums',
                  stats.expectedProfit < 0 && 'text-red-300',
                )}>
                  {money(stats.expectedProfit)}
                </p>
              </div>
              <div className="grid grid-cols-3 border-t border-white/10 bg-white/[0.04]">
                <DarkCell label="Income" value={money(stats.expectedIncome)} />
                <DarkCell label="Costs" value={money(stats.totalExpenses)} bordered />
                <DarkCell label="Received" value={money(stats.totalIncome)} bordered />
              </div>
            </section>

            {(job.status === 'in-progress'
              || jobProgressSnapshots.some((snapshot) => snapshot.jobId === job.id)) && (
              <WorkProgressCard
                job={job}
                entries={entries}
                snapshots={jobProgressSnapshots}
                people={jobProgressPeople}
                asOfDate={asOfDate}
                onEdit={() => onEditProgress(job.id)}
              />
            )}

            <section className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center gap-2">
                <TrendingUp size={16} className="text-emerald-600" />
                <h3 className="text-sm font-semibold text-foreground">Income</h3>
              </div>
              <div className="mt-3 divide-y divide-border">
                <SummaryRow
                  label={stats.expectedIsConfident ? 'Agreed / invoiced job value' : 'Estimated job value'}
                  value={money(stats.expectedIncome)}
                />
                <SummaryRow label="Payments received" value={money(stats.totalIncome)} />
                <SummaryRow
                  label="Still to receive"
                  value={money(stillToReceive)}
                  muted={stillToReceive === 0}
                  strong={stillToReceive > 0}
                />
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center gap-2">
                <Receipt size={16} className="text-amber-600" />
                <h3 className="text-sm font-semibold text-foreground">Costs</h3>
              </div>
              <div className="mt-3 divide-y divide-border">
                <MaterialCostBreakdown
                  total={stats.materialsCost}
                  materials={jobMaterialRows}
                  otherCosts={otherCostRows}
                  unitemisedRemainder={unitemisedRemainder}
                  open={materialsOpen}
                  onToggle={() => setMaterialsOpen((value) => !value)}
                />
                <SummaryRow label="Employee wages" value={money(stats.payrollLabourCost)} />
                <SummaryRow label="Subs and helpers" value={money(stats.contractorLabourCost)} />
                <SummaryRow label="Total job costs" value={money(stats.totalExpenses)} strong />
              </div>
            </section>

            <section className="grid grid-cols-2 gap-3">
              <InfoTile
                icon={Clock3}
                label="Time logged"
                value={`${stats.totalHours.toLocaleString('en-NZ')}h`}
                note={`${stats.ownerHours.toLocaleString('en-NZ')}h yours · ${stats.crewHours.toLocaleString('en-NZ')}h crew`}
              />
              <InfoTile
                icon={WalletCards}
                label="Your return"
                value={stats.ownerRate == null ? '—' : `${money(stats.ownerRate)}/h`}
                note="After everybody else is paid"
              />
            </section>

            <MoneyEntries
              title="Payments received"
              icon={ArrowDownLeft}
              empty="No payments have been recorded against this job yet."
              rows={incomeRows.map((entry) => ({
                id: entry.id,
                title: entry.description || 'Payment received',
                detail: shortDate(entry.entryDate),
                value: money(entryExGst(entry)),
              }))}
              positive
            />

            <MoneyEntries
              title="Bills and expenses"
              icon={Receipt}
              empty="No supplier expenses have been recorded against this job yet."
              rows={directCostRows.map((entry) => ({
                  id: entry.id,
                  title: costTitle(entry),
                  detail: `${shortDate(entry.entryDate)}${entry.supplier || entry.company ? ` · ${entry.supplier ?? entry.company}` : ''}`,
                  value: money(entryExGst(entry)),
                }))}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MaterialCostBreakdown({
  total,
  materials,
  otherCosts,
  unitemisedRemainder,
  open,
  onToggle,
}: {
  total: number;
  materials: Material[];
  otherCosts: Entry[];
  unitemisedRemainder: number;
  open: boolean;
  onToggle: () => void;
}) {
  const remainderIsMaterial = unitemisedRemainder > 0.02;
  const detailCount = materials.length + otherCosts.length + (remainderIsMaterial ? 1 : 0);
  const otherDetailCount = otherCosts.length + (remainderIsMaterial ? 1 : 0);
  const detailSummary = materials.length > 0
    ? `${materials.length} material ${materials.length === 1 ? 'line' : 'lines'}${otherDetailCount > 0 ? ` · ${otherDetailCount} other` : ''} · tap for details`
    : otherDetailCount > 0
      ? `${otherDetailCount} unitemised ${otherDetailCount === 1 ? 'cost' : 'costs'} · tap for details`
      : 'Nothing itemised yet';

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="job-material-cost-breakdown"
        onClick={onToggle}
        className="flex min-h-14 w-full items-center justify-between gap-3 py-2.5 text-left first:pt-0"
      >
        <span className="min-w-0">
          <span className="block text-sm text-foreground">Materials and other</span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            {detailSummary}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-sm tabular-nums text-foreground">{money(total)}</span>
          <ChevronDown
            size={16}
            className={cn('text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        </span>
      </button>

      {open && (
        <div id="job-material-cost-breakdown" className="mb-2 rounded-xl bg-muted/35 px-3 py-3">
          {materials.length > 0 ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Materials used
              </p>
              <div className="mt-1.5 divide-y divide-border/70">
                {materials.map((material) => (
                  <MaterialDetailRow key={material.id} material={material} />
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              No individual materials were logged. The costs below were only recorded as bills or expenses.
            </p>
          )}

          {(otherCosts.length > 0 || remainderIsMaterial) && (
            <div className={cn(materials.length > 0 && 'mt-3 border-t border-border/70 pt-3')}>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Other or unitemised costs
              </p>
              <div className="mt-1.5 divide-y divide-border/70">
                {otherCosts.map((entry) => (
                  <div key={entry.id} className="flex min-h-12 items-start justify-between gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug text-foreground">{costTitle(entry)}</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                        {[entry.supplier ?? entry.company, entry.category?.replaceAll('_', ' '), shortDate(entry.entryDate)]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                      {money(entryExGst(entry))}
                    </p>
                  </div>
                ))}
                {remainderIsMaterial && (
                  <div className="flex min-h-12 items-start justify-between gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-foreground">Unitemised balance</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                        Delivery, fees, rounding, or bill lines without descriptions
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                      {money(unitemisedRemainder)}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {detailCount === 0 && (
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Add material line items when confirming a supplier bill to see what was actually used here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function MaterialDetailRow({ material }: { material: Material }) {
  const quantity = material.quantity == null
    ? null
    : `Qty ${material.quantity.toLocaleString('en-NZ')}${material.unit ? ` ${material.unit}` : ''}`;
  const attributes = [
    quantity,
    material.color ? `Colour: ${material.color}` : null,
    material.finish?.replaceAll('_', ' '),
    material.area,
  ].filter((value): value is string => Boolean(value));
  const source = material.source === 'overhead'
    ? 'Used from stock'
    : material.supplier || 'From supplier bill';
  const usedOn = shortDate(material.usedOn ?? material.createdAt);

  return (
    <div className="flex min-h-14 items-start gap-2.5 py-2.5">
      <Package size={15} className="mt-0.5 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug text-foreground">{materialTitle(material)}</p>
        {attributes.length > 0 && (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {attributes.join(' · ')}
          </p>
        )}
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {source} · {usedOn}
        </p>
        {material.notes && (
          <p className="mt-1 text-[11px] leading-snug text-foreground/70">{material.notes}</p>
        )}
      </div>
      <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
        {material.cost == null ? '—' : money(material.cost)}
      </p>
    </div>
  );
}

function DarkCell({ label, value, bordered = false }: { label: string; value: string; bordered?: boolean }) {
  return (
    <div className={cn('min-w-0 px-3 py-3.5', bordered && 'border-l border-white/10')}>
      <p className="text-[9px] font-semibold uppercase tracking-wide text-white/45">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold tabular-nums text-white">{value}</p>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  strong = false,
  muted = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn(
        'shrink-0 text-sm tabular-nums text-foreground',
        strong && 'font-bold',
        muted && 'text-muted-foreground',
      )}>
        {value}
      </span>
    </div>
  );
}

function InfoTile({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: ElementType;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-border bg-card p-3.5">
      <Icon size={16} className="text-primary" />
      <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-lg font-bold tabular-nums text-foreground">{value}</p>
      <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{note}</p>
    </div>
  );
}

interface MoneyEntryRow {
  id: string;
  title: string;
  detail: string;
  value: string;
}

function MoneyEntries({
  title,
  icon: Icon,
  empty,
  rows,
  positive = false,
}: {
  title: string;
  icon: ElementType;
  empty: string;
  rows: MoneyEntryRow[];
  positive?: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <Icon size={16} className={positive ? 'text-emerald-600' : 'text-amber-600'} />
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">{empty}</p>
      ) : (
        <div className="divide-y divide-border">
          {rows.map((row) => (
            <div key={row.id} className="flex min-h-14 items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{row.title}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.detail}</p>
              </div>
              <p className={cn(
                'shrink-0 text-sm font-semibold tabular-nums text-foreground',
                positive && 'text-emerald-700',
              )}>
                {row.value}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
