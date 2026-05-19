'use client';

import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { MonthlyData } from '@/lib/types';

interface RevenueChartProps {
  data: MonthlyData[];
  /**
   * Optional control slot rendered next to the title (e.g. a range
   * selector). Lets the chart card host its own time-window control
   * independent of the page's main timeframe filter.
   */
  rangeControl?: React.ReactNode;
}

export function RevenueChart({ data, rangeControl }: RevenueChartProps) {
  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-center justify-between mb-4 gap-2">
        <p className="text-sm font-semibold text-foreground">Revenue vs Expenses</p>
        {rangeControl}
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} barSize={14} barGap={4}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="month"
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
            width={38}
          />
          <Tooltip
            formatter={(value, name) => [
              typeof value === 'number' ? `$${value.toLocaleString('en-NZ')}` : String(value),
              name === 'revenue' ? 'Revenue' : 'Expenses',
            ]}
            contentStyle={{
              borderRadius: 12,
              border: '1px solid var(--border)',
              fontSize: 12,
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            formatter={(v) => (v === 'revenue' ? 'Revenue' : 'Expenses')}
          />
          <Bar dataKey="revenue" fill="var(--chart-3)" radius={[4, 4, 0, 0]} name="revenue" />
          <Bar dataKey="expenses" fill="var(--chart-5)" radius={[4, 4, 0, 0]} name="expenses" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
