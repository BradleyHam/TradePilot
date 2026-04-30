'use client';

import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
} from 'recharts';
import { CategoryData } from '@/lib/types';

const COLORS = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)',
  'var(--chart-4)', 'var(--chart-5)', '#8b5cf6', '#06b6d4', '#f59e0b',
];

interface ExpenseChartProps {
  data: CategoryData[];
}

export function ExpenseChart({ data }: ExpenseChartProps) {
  const total = data.reduce((s, d) => s + d.amount, 0);

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <p className="text-sm font-semibold text-foreground mb-1">Expenses by category</p>
      <p className="text-xs text-muted-foreground mb-4">
        Total: ${total.toLocaleString('en-NZ')}
      </p>
      <div className="space-y-2">
        {data.map((item, i) => (
          <div key={item.category} className="flex items-center gap-3">
            <div
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ background: COLORS[i % COLORS.length] }}
            />
            <div className="flex-1 flex items-center justify-between gap-2 min-w-0">
              <span className="text-sm text-foreground capitalize truncate">{item.category}</span>
              <div className="flex items-center gap-2 shrink-0">
                <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(item.amount / total) * 100}%`,
                      background: COLORS[i % COLORS.length],
                    }}
                  />
                </div>
                <span className="text-sm font-medium text-foreground w-16 text-right">
                  ${item.amount.toLocaleString('en-NZ')}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
