import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: string;
  subvalue?: string;
  icon: LucideIcon;
  trend?: 'up' | 'down' | 'neutral';
  trendLabel?: string;
  accent?: 'green' | 'red' | 'blue' | 'amber' | 'violet' | 'default';
}

const ACCENT_STYLES = {
  green:   { icon: 'text-green-600 bg-green-50',  value: 'text-green-700' },
  red:     { icon: 'text-red-500 bg-red-50',      value: 'text-red-600' },
  blue:    { icon: 'text-blue-600 bg-blue-50',    value: 'text-blue-700' },
  amber:   { icon: 'text-amber-600 bg-amber-50',  value: 'text-amber-700' },
  violet:  { icon: 'text-violet-600 bg-violet-50',value: 'text-violet-700' },
  default: { icon: 'text-primary bg-primary/10',  value: 'text-foreground' },
};

export function StatCard({ label, value, subvalue, icon: Icon, trend, trendLabel, accent = 'default' }: StatCardProps) {
  const styles = ACCENT_STYLES[accent];
  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-start justify-between gap-2 mb-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide leading-tight">{label}</p>
        <div className={cn('w-8 h-8 rounded-xl flex items-center justify-center shrink-0', styles.icon)}>
          <Icon size={16} strokeWidth={1.8} />
        </div>
      </div>
      <p className={cn('text-2xl font-bold tracking-tight', styles.value)}>{value}</p>
      {subvalue && <p className="text-xs text-muted-foreground mt-1">{subvalue}</p>}
      {trendLabel && (
        <p className={cn(
          'text-xs font-medium mt-1.5',
          trend === 'up' ? 'text-green-600' : trend === 'down' ? 'text-red-500' : 'text-muted-foreground'
        )}>
          {trendLabel}
        </p>
      )}
    </div>
  );
}
