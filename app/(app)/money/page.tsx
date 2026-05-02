'use client';

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/money/stat-card';
import { RevenueChart } from '@/components/money/revenue-chart';
import { ExpenseChart } from '@/components/money/expense-chart';
import { TransactionList } from '@/components/money/transaction-list';
import { TaxExposureCard } from '@/components/money/tax-exposure-card';
import {
  TimeframeSelector,
  type Timeframe, type TimeframeKind,
  smartDefault, frameFor,
} from '@/components/money/timeframe-selector';
import {
  earnedIncomeInWindow, cashIncomeInWindow, earnedIncomeByMonth,
} from '@/lib/income-allocator';
import { MonthlyData, CategoryData } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, Receipt, Clock, AlertCircle, FileText,
  Briefcase, DollarSign,
} from 'lucide-react';
import { format, parseISO, isSameMonth, addMonths, startOfMonth, differenceInCalendarMonths } from 'date-fns';

export default function MoneyPage() {
  const { entries, jobs } = useStore();
  const now = new Date();

  // Default selection: this month if data exists, else last month.
  const [kind, setKind] = useState<TimeframeKind>(() =>
    smartDefault(entries.map((e) => e.entryDate), now),
  );
  const [customFrame, setCustomFrame] = useState<Timeframe | null>(null);
  const frame = frameFor(kind, customFrame, now);

  // Cash vs Earned basis — defaults to Earned because that answers "did I
  // actually have a good month" rather than "what hit the bank account".
  const [basis, setBasis] = useState<'cash' | 'earned'>('earned');

  // Entries that fall inside the selected window.
  const windowEntries = useMemo(
    () => entries.filter((e) => e.entryDate >= frame.start && e.entryDate <= frame.end),
    [entries, frame.start, frame.end],
  );

  // ── KPIs (timeframe-bound) ─────────────────────────────────────────────────
  // Cash income — money that actually landed in the window.
  const cashRevenue = useMemo(
    () => cashIncomeInWindow(entries, frame.start, frame.end),
    [entries, frame.start, frame.end],
  );
  // Earned income — for each completed/invoiced/paid job, allocate its quote
  // amount across months by hours-share, then sum the months in the window.
  const earnedRevenue = useMemo(
    () => earnedIncomeInWindow(jobs, entries, frame.start, frame.end),
    [jobs, entries, frame.start, frame.end],
  );
  const revenue = basis === 'earned' ? earnedRevenue : cashRevenue;

  const expenses = useMemo(
    () => windowEntries.filter((e) => e.type === 'expense').reduce((s, e) => s + (e.amount ?? 0), 0),
    [windowEntries],
  );
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
    .filter((e) => e.type === 'bill' && e.dueDate && new Date(e.dueDate) >= now)
    .reduce((s, e) => s + (e.amount ?? 0), 0);
  const pipelineValue = jobs
    .filter((j) => !['paid', 'lost'].includes(j.status))
    .reduce((s, j) => s + (j.quoteAmount ?? j.estimatedValue ?? 0), 0);

  // ── Charts ─────────────────────────────────────────────────────────────────
  // Revenue vs Expenses chart: one bar per month in the selected window
  // (capped at 12 to keep it readable).
  const monthlyData: MonthlyData[] = useMemo(() => {
    const startMonth = startOfMonth(parseISO(frame.start));
    const endMonth = startOfMonth(parseISO(frame.end));
    const months: Date[] = [];
    let cursor = startMonth;
    while (cursor <= endMonth && months.length < 12) {
      months.push(cursor);
      cursor = addMonths(cursor, 1);
    }
    // If the window only spans one month, also pull in the previous two so
    // the chart isn't a lonely bar on its own.
    if (months.length === 1) {
      months.unshift(addMonths(months[0], -1));
      months.unshift(addMonths(months[0], -1));
    }
    // For earned basis we need the YYYY-MM keys to ask the allocator.
    const monthKeys = months.map((m) => format(m, 'yyyy-MM'));
    const earnedByMonth = basis === 'earned'
      ? earnedIncomeByMonth(jobs, entries, monthKeys)
      : null;

    return months.map((m, i) => {
      const monthEntries = entries.filter((e) => isSameMonth(parseISO(e.entryDate), m));
      const cashRev = monthEntries
        .filter((e) => e.type === 'income')
        .reduce((s, e) => s + (e.amount ?? 0), 0);
      const earnedRev = earnedByMonth?.get(monthKeys[i]) ?? 0;
      return {
        month: format(m, 'MMM'),
        revenue: basis === 'earned' ? earnedRev : cashRev,
        expenses: monthEntries.filter((e) => e.type === 'expense').reduce((s, e) => s + (e.amount ?? 0), 0),
      };
    });
  }, [entries, jobs, frame.start, frame.end, basis]);

  // Expense breakdown for the selected window.
  const expenseByCategory: CategoryData[] = useMemo(() => {
    const map: Record<string, number> = {};
    windowEntries
      .filter((e) => e.type === 'expense' && e.category)
      .forEach((e) => {
        const cat = e.category!;
        map[cat] = (map[cat] ?? 0) + (e.amount ?? 0);
      });
    return Object.entries(map)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [windowEntries]);

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

      <div className="px-4 md:px-6 pb-6 space-y-3">
        {/* Timeframe filter */}
        <TimeframeSelector
          kind={kind}
          custom={customFrame}
          onChange={(k, c) => { setKind(k); setCustomFrame(c); }}
        />

        {/* Cash vs Earned basis toggle */}
        <div className="flex items-center gap-2">
          <div className="inline-flex bg-muted rounded-lg p-0.5">
            <button
              onClick={() => setBasis('earned')}
              className={cn(
                'px-3 h-8 rounded-md text-xs font-medium transition-colors',
                basis === 'earned'
                  ? 'bg-card shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Earned
            </button>
            <button
              onClick={() => setBasis('cash')}
              className={cn(
                'px-3 h-8 rounded-md text-xs font-medium transition-colors',
                basis === 'cash'
                  ? 'bg-card shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Cash
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground italic flex-1">
            {basis === 'earned'
              ? 'Income split across months by hours worked. Pending jobs excluded.'
              : 'Income on the date payment hit the bank.'}
          </p>
        </div>

        {/* Top stats grid — bound to the selected window */}
        <div className="grid grid-cols-2 gap-2.5">
          <StatCard
            label={`Revenue ${periodLabel}`}
            value={fmt(revenue)}
            icon={TrendingUp}
            accent="green"
            subvalue={basis === 'earned' && cashRevenue !== earnedRevenue
              ? `Cash received: ${fmt(cashRevenue)}`
              : undefined}
          />
          <StatCard
            label={`Expenses ${periodLabel}`}
            value={fmt(expenses)}
            icon={Receipt}
            accent="red"
          />
          <StatCard
            label="Estimated profit"
            value={fmt(profit)}
            icon={DollarSign}
            accent={profit >= 0 ? 'green' : 'red'}
            subvalue={totalHoursInWindow > 0 ? `${totalHoursInWindow}h worked` : undefined}
          />
          <StatCard
            label="Avg hourly return"
            value={avgHourlyReturn > 0 ? `$${avgHourlyReturn.toFixed(0)}/h` : '—'}
            icon={Clock}
            accent="blue"
          />
        </div>

        {/* Secondary stats — state of the business, NOT period-bound */}
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
            subvalue={`${jobs.filter((j) => !['paid', 'lost'].includes(j.status)).length} active jobs`}
          />
        </div>

        {/* Tax exposure — independent annual scope */}
        <TaxExposureCard />

        {/* Reconcile entry point */}
        <ReconcileEntryCard />

        {/* Charts — adapt to the selected window */}
        <RevenueChart data={monthlyData} />
        {expenseByCategory.length > 0 && <ExpenseChart data={expenseByCategory} />}

        {/* Pipeline — state of business, not period-bound */}
        <PipelineBreakdown jobs={jobs} />

        {/* Transactions — has its own internal 30-day window + filters */}
        <TransactionList />
      </div>
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
