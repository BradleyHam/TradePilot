import { Badge } from '@/components/ui/badge';
import { JobStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

const STATUS_CONFIG: Record<JobStatus, { label: string; className: string }> = {
  lead:         { label: 'Lead',        className: 'bg-slate-100 text-slate-700 border-slate-200' },
  quoted:       { label: 'Quoted',      className: 'bg-blue-50 text-blue-700 border-blue-200' },
  accepted:     { label: 'Accepted',    className: 'bg-violet-50 text-violet-700 border-violet-200' },
  booked:       { label: 'Booked',      className: 'bg-amber-50 text-amber-700 border-amber-200' },
  'in-progress':{ label: 'In Progress', className: 'bg-orange-50 text-orange-700 border-orange-200' },
  completed:    { label: 'Completed',   className: 'bg-green-50 text-green-700 border-green-200' },
  invoiced:     { label: 'Invoiced',    className: 'bg-teal-50 text-teal-700 border-teal-200' },
  paid:         { label: 'Paid',        className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  lost:         { label: 'Lost',        className: 'bg-red-50 text-red-500 border-red-200' },
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <Badge
      variant="outline"
      className={cn('text-xs font-medium border', config.className)}
    >
      {config.label}
    </Badge>
  );
}

export { STATUS_CONFIG };
