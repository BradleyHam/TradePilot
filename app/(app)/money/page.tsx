'use client';

import { useMemo } from 'react';
import { useStore } from '@/lib/store';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/money/stat-card';
import { RevenueChart } from '@/components/money/revenue-chart';
import { ExpenseChart } from '@/components/money/expense-chart';
import { TransactionList } from '@/components/money/transaction-list';
import { TaxExposureCard } from '@/components/money/tax-exposure-card';
import { MonthlyData, CategoryData } from '@/lib/types';
import {
  TrendingUp, TrendingDown, Receipt, Clock, AlertCircle, FileText,
  Briefcase, DollarSign,
} from 'lucide-react';
import { format, parseISO, startOfMonth, isSameMonth } from 'date-fns';

export default function MoneyPage() {
  const { entries, jobs } = useStore();
  const now = new Date();

  const thisMonthEntries = useMemo(
    () => entries.filter((e) => isSameMonth(parseISO(e.entryDate), now)),
    [entries]
  );

  const revenue = useMemo(
    () => thisMonthEntries.filter((e) => e.type === 'income').reduce((s, e) => s + (e.amount ?? 0), 0),
    [thisMonthEntries]
  );
  const expenses = useMemo(
    () => thisMonthEntries.filter((e) => e.type === 'expense').reduce((s, e) => s + (e.amount ?? 0), 0),
    [thisMonthEntries]
  );
  const profit = revenue - expenses;

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

  const totalHoursThisMonth = useMemo(
    () => thisMonthEntries.filter((e) => e.type === 'hours').reduce((s, e) => s + (e.hours ?? 0), 0),
    [thisMonthEntries]
  );
  const avgHourlyReturn = totalHoursThisMonth > 0 ? revenue / totalHoursThisMonth : 0;

  // Monthly chart data (last 3 months)
  const monthlyData: MonthlyData[] = useMemo(() => {
    const months = [
      new Date(now.getFullYear(), now.getMonth() - 2, 1),
      new Date(now.getFullYear(), now.getMonth() - 1, 1),
      new Date(now.getFullYear(), now.getMonth(), 1),
    ];
    return months.map((month) => {
      const monthEntries = entries.filter((e) => isSameMonth(parseISO(e.entryDate), month));
      return {
        month: format(month, 'MMM'),
        revenue: monthEntries.filter((e) => e.type === 'income').reduce((s, e) => s + (e.amount ?? 0), 0),
        expenses: monthEntries.filter((e) => e.type === 'expense').reduce((s, e) => s + (e.amount ?? 0), 0),
      };
    });
  }, [entries]);

  // Expense breakdown (all time)
  const expenseByCategory: CategoryData[] = useMemo(() => {
    const map: Record<string, number> = {};
    entries
      .filter((e) => e.type === 'expense' && e.category)
      .forEach((e) => {
        const cat = e.category!;
        map[cat] = (map[cat] ?? 0) + (e.amount ?? 0);
      });
    return Object.entries(map)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [entries]);

  const fmt = (n: number) => `$${n.toLocaleString('en-NZ')}`;

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Money"
        subtitle={format(now, 'MMMM yyyy')}
      />

      <div className="px-4 md:px-6 pb-6 space-y-3">
        {/* Top stats grid */}
        <div className="grid grid-cols-2 gap-2.5">
          <StatCard
            label="Revenue this month"
            value={fmt(revenue)}
            icon={TrendingUp}
            accent="green"
          />
          <StatCard
            label="Expenses this month"
            value={fmt(expenses)}
            icon={Receipt}
            accent="red"
          />
          <StatCard
            label="Estimated profit"
            value={fmt(profit)}
            icon={DollarSign}
            accent={profit >= 0 ? 'green' : 'red'}
            subvalue={totalHoursThisMonth > 0 ? `${totalHoursThisMonth}h worked` : undefined}
          />
          <StatCard
            label="Avg hourly return"
            value={avgHourlyReturn > 0 ? `$${avgHourlyReturn.toFixed(0)}/h` : '—'}
            icon={Clock}
            accent="blue"
          />
        </div>

        {/* Secondary stats */}
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

        {/* Tax exposure — glanceable estimate of GST + income tax for the year */}
        <TaxExposureCard />

        {/* Charts */}
        <RevenueChart data={monthlyData} />
        {expenseByCategory.length > 0 && <ExpenseChart data={expenseByCategory} />}

        {/* Pipeline by status */}
        <PipelineBreakdown jobs={jobs} />

        {/* Transactions — for spot-checking and duplicate hunting */}
        <TransactionList />
      </div>
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
