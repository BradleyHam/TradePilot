'use client';

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/money/stat-card';
import { RevenueChart } from '@/components/money/revenue-chart';
import { ExpenseChart } from '@/components/money/expense-chart';
import { TransactionList } from '@/components/money/transaction-list';
import { TaxExposureCard } from '@/components/money/tax-exposure-card';
import { TaxPaidCard } from '@/components/money/tax-paid-card';
import {
  TimeframeSelector,
  type Timeframe, type TimeframeKind,
  smartDefault, frameFor,
} from '@/components/money/timeframe-selector';
import {
  earnedIncomeInWindow, cashIncomeExGstInWindow, earnedIncomeByMonth,
  expensesInWindow, incurredExpenseBreakdown, incurredExpensesInWindow,
} from '@/lib/income-allocator';
import { unbilledLabourInWindow } from '@/lib/labour-accrual';
import { MonthlyData, CategoryData } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  TrendingDown, AlertCircle, FileText,
  Briefcase, ChevronDown,
} from 'lucide-react';
import { format, parseISO, addMonths, startOfMonth, endOfMonth, differenceInCalendarMonths } from 'date-fns';

export default function MoneyPage() {
  const { entries, jobs } = useStore();
  const now = useMemo(() => new Date(), []);

  // Default selection: this month if data exists, else last month.
  const [kind, setKind] = useState<TimeframeKind>(() =>
    smartDefault(entries.map((e) => e.entryDate), now),
  );
  const [customFrame, setCustomFrame] = useState<Timeframe | null>(null);
  const frame = frameFor(kind, customFrame, now);

  // Cash vs Earned basis — defaults to Earned because that answers "did I
  // actually have a good month" rather than "what hit the bank account".
  const [basis, setBasis] = useState<'cash' | 'earned'>('earned');
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Revenue vs Expenses chart range — independent of the main timeframe
  // filter so the chart can show a wider trend window (12M default)
  // while the KPIs above stay focused on the active month/quarter.
  // 'all' walks back to the earliest entry; cap at 36 months for the
  // chart's readability.
  type ChartRange = '3M' | '6M' | '12M' | 'all';
  const [chartRange, setChartRange] = useState<ChartRange>('12M');

  // Entries that fall inside the selected window.
  const windowEntries = useMemo(
    () => entries.filter((e) => e.entryDate >= frame.start && e.entryDate <= frame.end),
    [entries, frame.start, frame.end],
  );

  // ── KPIs (timeframe-bound) ─────────────────────────────────────────────────
  // Cash income — money that actually landed in the window, EX-GST (the
  // GST slice is the IRD's, not revenue — golden rule: all math ex-GST).
  const cashRevenue = useMemo(
    () => cashIncomeExGstInWindow(entries, frame.start, frame.end),
    [entries, frame.start, frame.end],
  );
  // Earned income — for each completed/invoiced/paid job, allocate its quote
  // amount across months by hours-share, then sum the months in the window.
  const earnedRevenue = useMemo(
    () => earnedIncomeInWindow(jobs, entries, frame.start, frame.end),
    [jobs, entries, frame.start, frame.end],
  );
  const revenue = basis === 'earned' ? earnedRevenue : cashRevenue;

  // Expenses, ex-GST. Two versions, matching the two bases — otherwise
  // profit compares earned revenue against cash costs and flatters every
  // month with an unpaid bill or an un-invoiced sub in it.
  //
  // Cash: expense entries by date + PAID bills by paidDate. Payments
  // basis, same as the GST return and the tax estimate.
  const cashExpenses = useMemo(
    () => expensesInWindow(entries, frame.start, frame.end),
    [entries, frame.start, frame.end],
  );
  // Earned: costs when INCURRED — bills from their bill date paid or not,
  // plus sub/helper hours nobody has invoiced yet. Management figure; it
  // never reaches GST or income tax.
  const incurred = useMemo(
    () => incurredExpenseBreakdown(entries, frame.start, frame.end),
    [entries, frame.start, frame.end],
  );
  const expenses = basis === 'earned' ? incurred.total : cashExpenses;
  // What part of the earned-basis number hasn't left the bank yet — the
  // line that explains an Expenses card bigger than the Cash view.
  const notYetPaid = incurred.billedUnpaid + incurred.unbilledLabour;
  const profit = revenue - expenses;
  const totalHoursInWindow = useMemo(
    () => windowEntries.filter((e) => e.type === 'hours').reduce((s, e) => s + (e.hours ?? 0), 0),
    [windowEntries],
  );
  const avgHourlyReturn = totalHoursInWindow > 0 ? revenue / totalHoursInWindow : 0;

  // ── State-of-business stats (NOT timeframe-bound) ─────────────────────────
  const unpaidInvoices = jobs
    .filter((j) => j.status === 'invoiced')
    .reduce((s, j) => s + (j.invoiceAmount ?? j.quoteAmount ?? 0), 0);
  const awaitingQuotes = jobs.filter((j) => j.status === 'quoted').length;
  const upcomingBills = entries
    // Exclude drafts: they're shown separately on Home as "Bills to confirm"
    // and don't represent real upcoming obligations until Brad confirms.
    .filter((e) => e.type === 'bill' && !e.isDraft && e.dueDate && new Date(e.dueDate) >= now)
    .reduce((s, e) => s + (e.amount ?? 0), 0);
  const pipelineValue = jobs
    .filter((j) => !['paid', 'lost', 'declined'].includes(j.status))
    .reduce((s, j) => s + (j.quoteAmount ?? j.estimatedValue ?? 0), 0);

  // ── Charts ─────────────────────────────────────────────────────────────────
  // Revenue vs Expenses chart: one bar per month over the chart range.
  // Independent of the page's main timeframe so trends across many months
  // are visible while the KPI cards above stay focused on the active
  // window. Capped at 36 months even on 'all' for readability.
  const monthlyData: MonthlyData[] = useMemo(() => {
    const monthsBack = chartRange === '3M' ? 3
      : chartRange === '6M' ? 6
      : chartRange === '12M' ? 12
      : 36; // 'all' — capped so we don't render a 60-bar wall

    const endMonth = startOfMonth(now);
    // For 'all', walk back to the earliest entry but never past the cap.
    let firstMonth = startOfMonth(addMonths(endMonth, -(monthsBack - 1)));
    if (chartRange === 'all' && entries.length > 0) {
      const earliestEntry = entries
        .map((e) => parseISO(e.entryDate))
        .reduce((min, d) => (d < min ? d : min), parseISO(entries[0].entryDate));
      const earliestMonth = startOfMonth(earliestEntry);
      // Pick the later of the two so we don't go beyond the cap.
      if (earliestMonth > firstMonth) firstMonth = earliestMonth;
    }

    const months: Date[] = [];
    let cursor = firstMonth;
    while (cursor <= endMonth) {
      months.push(cursor);
      cursor = addMonths(cursor, 1);
    }
    // Defensive: if the window somehow has zero months (shouldn't happen),
    // pad to a single bar to avoid an empty chart looking broken.
    if (months.length === 0) months.push(endMonth);

    // For earned basis we need the YYYY-MM keys to ask the allocator.
    const monthKeys = months.map((m) => format(m, 'yyyy-MM'));
    const earnedByMonth = basis === 'earned'
      ? earnedIncomeByMonth(jobs, entries, monthKeys)
      : null;

    return months.map((m, i) => {
      // Ex-GST + paid bills, same semantics as the KPI cards — the chart
      // and the cards must never tell two different profit stories.
      const mStart = format(m, 'yyyy-MM-dd');
      const mEnd = format(endOfMonth(m), 'yyyy-MM-dd');
      const cashRev = cashIncomeExGstInWindow(entries, mStart, mEnd);
      const earnedRev = earnedByMonth?.get(monthKeys[i]) ?? 0;
      return {
        month: format(m, 'MMM'),
        revenue: basis === 'earned' ? earnedRev : cashRev,
        // Costs follow the same basis as the bars they sit against.
        expenses: basis === 'earned'
          ? incurredExpensesInWindow(entries, mStart, mEnd)
          : expensesInWindow(entries, mStart, mEnd),
      };
    });
  }, [entries, jobs, chartRange, basis, now]);

  // Expense breakdown for the selected window — same population as the
  // Expenses KPI (ex-GST; expense entries by entryDate + PAID bills by
  // paidDate) so the bars sum to the card. Uncategorised rows (most
  // supplier bills) land in 'other' rather than vanishing.
  const expenseByCategory: CategoryData[] = useMemo(() => {
    const exGst = (e: (typeof entries)[number]) => {
      if (e.amountExGst != null) return e.amountExGst;
      if (e.amount == null) return 0;
      return e.gstApplies ? e.amount / 1.15 : e.amount;
    };
    const map: Record<string, number> = {};
    for (const e of entries) {
      if (e.isDraft) continue;
      let inWindow = false;
      if (e.type === 'expense') {
        inWindow = e.entryDate >= frame.start && e.entryDate <= frame.end;
      } else if (e.type === 'bill') {
        // Earned basis dates a bill by the bill itself; cash basis waits
        // for the payment. Same rule as the Expenses card, so the bars
        // always sum to it.
        inWindow = basis === 'earned'
          ? e.entryDate >= frame.start && e.entryDate <= frame.end
          : !!e.paid && !!e.paidDate && e.paidDate >= frame.start && e.paidDate <= frame.end;
      }
      if (!inWindow) continue;
      const cat = e.category ?? 'other';
      map[cat] = (map[cat] ?? 0) + exGst(e);
    }
    // Sub / helper hours nobody has invoiced yet are a labour cost — on the
    // earned basis they belong in the breakdown like any other.
    if (basis === 'earned') {
      const labour = unbilledLabourInWindow(entries, frame.start, frame.end);
      if (labour > 0) map.labour = (map.labour ?? 0) + labour;
    }
    return Object.entries(map)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [entries, frame.start, frame.end, basis]);

  const fmt = (n: number) => `$${n.toLocaleString('en-NZ')}`;

  // Headings adapt to the selected window so labels never lie.
  const isMultiMonth = differenceInCalendarMonths(parseISO(frame.end), parseISO(frame.start)) >= 1;
  const periodLabel = isMultiMonth ? 'in period' : 'this month';

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Money"
        subtitle={frame.label}
      />

      <div className="px-4 md:px-6 pb-6 space-y-4">
        <TimeframeSelector
          kind={kind}
          custom={customFrame}
          onChange={(k, c) => { setKind(k); setCustomFrame(c); }}
        />

        <MoneySnapshot
          periodLabel={periodLabel}
          basis={basis}
          revenue={revenue}
          expenses={expenses}
          profit={profit}
          cashRevenue={cashRevenue}
          earnedRevenue={earnedRevenue}
          notYetPaid={notYetPaid}
          totalHours={totalHoursInWindow}
          avgHourlyReturn={avgHourlyReturn}
          fmt={fmt}
        />

        {/* Annual tax sits beside the period snapshot, but keeps its own
            tax-year scope and conservative estimator. */}
        <TaxExposureCard />

        <button
          type="button"
          aria-expanded={detailsOpen}
          aria-controls="money-detail"
          onClick={() => setDetailsOpen((open) => !open)}
          className="w-full min-h-12 rounded-2xl border border-border/70 bg-card px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted/30 active:bg-muted/50"
        >
          <span className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-sm font-semibold text-foreground">More money detail</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                {basis === 'earned' ? 'Earned view' : 'Cash view'} · charts, bills and transactions
              </span>
            </span>
            <ChevronDown
              size={18}
              className={cn('shrink-0 text-muted-foreground transition-transform', detailsOpen && 'rotate-180')}
            />
          </span>
        </button>

        {detailsOpen && (
          <div id="money-detail" className="space-y-3 animate-in fade-in-0 slide-in-from-top-1 duration-200">
            <section className="rounded-2xl bg-muted/45 p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">How to view the month</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {basis === 'earned'
                      ? 'Work is counted when it was earned, including costs not paid yet.'
                      : 'Only money that actually moved in or out is counted.'}
                  </p>
                </div>
                <div className="inline-flex shrink-0 rounded-xl bg-background p-1 ring-1 ring-border/70">
                  <button
                    type="button"
                    onClick={() => setBasis('earned')}
                    className={cn(
                      'min-h-11 rounded-lg px-3 text-xs font-semibold transition-colors',
                      basis === 'earned'
                        ? 'bg-foreground text-background shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    Earned
                  </button>
                  <button
                    type="button"
                    onClick={() => setBasis('cash')}
                    className={cn(
                      'min-h-11 rounded-lg px-3 text-xs font-semibold transition-colors',
                      basis === 'cash'
                        ? 'bg-foreground text-background shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    Cash
                  </button>
                </div>
              </div>
            </section>

            {/* State of the business — useful, but not part of the selected
                month's made / spent / left story. */}
            <div className="grid grid-cols-2 gap-2.5">
              <StatCard
                label="Unpaid invoices"
                value={unpaidInvoices > 0 ? fmt(unpaidInvoices) : '—'}
                icon={AlertCircle}
                accent={unpaidInvoices > 0 ? 'amber' : 'default'}
                subvalue={unpaidInvoices > 0 ? 'Awaiting payment' : 'All clear'}
              />
              <StatCard
                label="Quotes awaiting"
                value={awaitingQuotes > 0 ? `${awaitingQuotes} quote${awaitingQuotes > 1 ? 's' : ''}` : '—'}
                icon={FileText}
                accent={awaitingQuotes > 0 ? 'violet' : 'default'}
              />
              <StatCard
                label="Upcoming bills"
                value={upcomingBills > 0 ? fmt(upcomingBills) : '—'}
                icon={TrendingDown}
                accent={upcomingBills > 0 ? 'red' : 'default'}
              />
              <StatCard
                label="Pipeline value"
                value={fmt(pipelineValue)}
                icon={Briefcase}
                accent="blue"
                subvalue={`${jobs.filter((j) => !['paid', 'lost', 'declined'].includes(j.status)).length} active jobs`}
              />
            </div>

            <TaxPaidCard />
            <ReconcileEntryCard />
            <BillsEntryCard />

            <RevenueChart
              data={monthlyData}
              rangeControl={
                <ChartRangeToggle value={chartRange} onChange={setChartRange} />
              }
            />
            {expenseByCategory.length > 0 && <ExpenseChart data={expenseByCategory} />}
            {jobs.length > 0 && <PipelineBreakdown jobs={jobs} />}
            <TransactionList />
          </div>
        )}
      </div>
    </div>
  );
}

function MoneySnapshot({
  periodLabel,
  basis,
  revenue,
  expenses,
  profit,
  cashRevenue,
  earnedRevenue,
  notYetPaid,
  totalHours,
  avgHourlyReturn,
  fmt,
}: {
  periodLabel: string;
  basis: 'cash' | 'earned';
  revenue: number;
  expenses: number;
  profit: number;
  cashRevenue: number;
  earnedRevenue: number;
  notYetPaid: number;
  totalHours: number;
  avgHourlyReturn: number;
  fmt: (value: number) => string;
}) {
  return (
    <section className="overflow-hidden rounded-[1.5rem] bg-slate-950 text-white shadow-sm">
      <div className="p-5 pb-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/55">
            Left after costs
          </p>
          <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/75">
            {basis === 'earned' ? 'Earned view' : 'Cash view'}
          </span>
        </div>
        <p className={cn(
          'mt-2 text-[2.35rem] font-bold leading-none tracking-[-0.045em] tabular-nums',
          profit < 0 ? 'text-red-300' : 'text-white',
        )}>
          {fmt(profit)}
        </p>
        <p className="mt-2 text-sm text-white/60">
          {totalHours > 0
            ? `${totalHours.toLocaleString('en-NZ')}h logged · ${avgHourlyReturn > 0 ? `$${avgHourlyReturn.toFixed(0)}/h average return` : 'no hourly return yet'}`
            : `For ${periodLabel}`}
        </p>
      </div>

      <div className="grid grid-cols-2 border-t border-white/10 bg-white/[0.04]">
        <div className="min-w-0 border-r border-white/10 px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-white/50">Made {periodLabel}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-white">{fmt(revenue)}</p>
          {basis === 'earned' && cashRevenue !== earnedRevenue && (
            <p className="mt-1 truncate text-[11px] text-white/50">{fmt(cashRevenue)} received</p>
          )}
        </div>
        <div className="min-w-0 px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-white/50">Costs {periodLabel}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-white">{fmt(expenses)}</p>
          {basis === 'earned' && notYetPaid > 0 && (
            <p className="mt-1 truncate text-[11px] text-white/50">{fmt(notYetPaid)} not paid yet</p>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Compact range toggle for the Revenue vs Expenses chart. Sits in the
 * chart card's header. 3M / 6M / 12M / All — chart-only, doesn't
 * affect the main page timeframe filter.
 */
function ChartRangeToggle({
  value, onChange,
}: {
  value: '3M' | '6M' | '12M' | 'all';
  onChange: (next: '3M' | '6M' | '12M' | 'all') => void;
}) {
  const options: { label: string; value: '3M' | '6M' | '12M' | 'all' }[] = [
    { label: '3M',  value: '3M' },
    { label: '6M',  value: '6M' },
    { label: '12M', value: '12M' },
    { label: 'All', value: 'all' },
  ];
  return (
    <div className="inline-flex rounded-lg border border-border bg-muted/30 p-0.5">
      {options.map(({ label, value: v }) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            'min-h-11 px-2 text-[11px] font-medium rounded-md transition-colors',
            value === v
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ReconcileEntryCard() {
  const { bankTransactions } = useStore();
  const pending = bankTransactions.filter((t) => t.status === 'unreconciled').length;

  return (
    <a
      href="/reconcile"
      className="block bg-card border border-border rounded-2xl p-4 hover:bg-muted/30 active:bg-muted/50 transition-colors"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">Bank reconcile</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {pending > 0
              ? `${pending} bank transaction${pending !== 1 ? 's' : ''} waiting`
              : 'Drop in a BNZ CSV to reconcile transactions'}
          </p>
        </div>
        {pending > 0 && (
          <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold tabular-nums">
            {pending}
          </span>
        )}
      </div>
    </a>
  );
}

function BillsEntryCard() {
  const { entries } = useStore();
  // Confirmed bills not yet tied to a bank payment — the ones to reconcile.
  const toReconcile = entries.filter(
    (e) => e.type === 'bill' && !e.isDraft && !e.paid && !e.bankTransactionId && (e.amount ?? 0) > 0,
  );
  // Draft bills (uploads / email / backfill) still awaiting confirmation.
  const toConfirm = entries.filter((e) => e.type === 'bill' && e.isDraft);
  const reconcileTotal = toReconcile.reduce((s, e) => s + (e.amount ?? 0), 0);
  const fmtNZ = (n: number) => `$${n.toLocaleString('en-NZ')}`;

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <a
        href="/reconcile"
        className="block p-4 hover:bg-muted/30 active:bg-muted/50 transition-colors"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">Bills to reconcile</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {toReconcile.length > 0
                ? `${toReconcile.length} confirmed bill${toReconcile.length !== 1 ? 's' : ''} to match to a payment · ${fmtNZ(reconcileTotal)}`
                : 'All confirmed bills are matched to payments'}
            </p>
          </div>
          {toReconcile.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold tabular-nums">
              {toReconcile.length}
            </span>
          )}
        </div>
      </a>
      {toConfirm.length > 0 && (
        <a
          href="/home"
          className="block px-4 py-2.5 border-t border-border hover:bg-muted/30 active:bg-muted/50 transition-colors"
        >
          <p className="text-[11px] text-muted-foreground">
            <span className="font-semibold text-foreground">{toConfirm.length}</span>
            {' '}bill{toConfirm.length !== 1 ? 's' : ''} also waiting to confirm →
          </p>
        </a>
      )}
    </div>
  );
}

function PipelineBreakdown({ jobs }: { jobs: ReturnType<typeof useStore>['jobs'] }) {
  const statusGroups = [
    { label: 'Leads', statuses: ['lead'] as const },
    { label: 'Quoted', statuses: ['quoted', 'accepted'] as const },
    { label: 'Booked', statuses: ['booked', 'in-progress'] as const },
    { label: 'Completed', statuses: ['completed', 'invoiced'] as const },
    { label: 'Paid', statuses: ['paid'] as const },
  ];

  const total = jobs.reduce((s, j) => s + (j.quoteAmount ?? j.estimatedValue ?? 0), 0);

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <p className="text-sm font-semibold text-foreground mb-4">Pipeline by stage</p>
      <div className="space-y-3">
        {statusGroups.map(({ label, statuses }) => {
          const groupJobs = jobs.filter((j) => ([...statuses] as string[]).includes(j.status));
          const value = groupJobs.reduce((s, j) => s + (j.quoteAmount ?? j.estimatedValue ?? 0), 0);
          const pct = total > 0 ? (value / total) * 100 : 0;
          return (
            <div key={label} className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground w-20 shrink-0">{label}</span>
              <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="text-right shrink-0 w-24">
                <p className="text-sm font-medium text-foreground">
                  ${value.toLocaleString('en-NZ')}
                </p>
                <p className="text-[10px] text-muted-foreground">{groupJobs.length} job{groupJobs.length !== 1 ? 's' : ''}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
