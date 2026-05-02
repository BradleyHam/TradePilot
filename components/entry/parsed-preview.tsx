'use client';

import { ParsedEntry, EntryType } from '@/lib/types';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DollarSign, Clock, MessageSquare, FileText, Receipt, AlertCircle, StickyNote,
  CheckCircle2, ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const TYPE_CONFIG: Record<EntryType, { label: string; icon: React.ElementType; color: string; bg: string }> = {
  expense:  { label: 'Expense',  icon: Receipt,       color: 'text-red-600',    bg: 'bg-red-50' },
  income:   { label: 'Income',   icon: DollarSign,    color: 'text-green-600',  bg: 'bg-green-50' },
  hours:    { label: 'Hours',    icon: Clock,         color: 'text-blue-600',   bg: 'bg-blue-50' },
  enquiry:  { label: 'Enquiry',  icon: MessageSquare, color: 'text-violet-600', bg: 'bg-violet-50' },
  quote:    { label: 'Quote',    icon: FileText,      color: 'text-amber-600',  bg: 'bg-amber-50' },
  bill:     { label: 'Bill Due', icon: AlertCircle,   color: 'text-orange-600', bg: 'bg-orange-50' },
  note:     { label: 'Note',     icon: StickyNote,    color: 'text-slate-600',  bg: 'bg-slate-50' },
};

interface ParsedPreviewProps {
  parsed: ParsedEntry;
  onConfirm: () => void;
  onEdit: () => void;
}

export function ParsedPreview({ parsed, onConfirm, onEdit }: ParsedPreviewProps) {
  const config = TYPE_CONFIG[parsed.type];
  const Icon = config.icon;

  return (
    <Card className="border-2 border-primary/20 shadow-sm">
      <CardContent className="p-4">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', config.bg)}>
            <Icon size={20} className={config.color} strokeWidth={1.8} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn('text-sm font-semibold', config.color)}>{config.label}</span>
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] px-1.5 py-0',
                  parsed.confidence === 'high'
                    ? 'border-green-300 text-green-600 bg-green-50'
                    : parsed.confidence === 'medium'
                    ? 'border-amber-300 text-amber-600 bg-amber-50'
                    : 'border-slate-300 text-slate-500 bg-slate-50'
                )}
              >
                {parsed.confidence === 'high' ? 'Looks good' : parsed.confidence === 'medium' ? 'Check it' : 'Low confidence'}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{parsed.description}</p>
          </div>
        </div>

        {/* Details */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          {parsed.amount !== undefined && (
            <DetailRow label="Amount" value={`$${parsed.amount.toLocaleString('en-NZ', { minimumFractionDigits: 2 })}`} />
          )}
          {parsed.hours !== undefined && (
            <DetailRow label="Hours" value={`${parsed.hours}h`} />
          )}
          {parsed.category && (
            <DetailRow label="Category" value={capitalize(parsed.category)} />
          )}
          {parsed.jobName && (
            <DetailRow label="Job" value={parsed.jobName} />
          )}
          {parsed.clientName && (
            <DetailRow label="Client" value={parsed.clientName} />
          )}
          {parsed.supplier && (
            <DetailRow label="Supplier" value={parsed.supplier} />
          )}
          <DetailRow
            label={parsed.entryDate ? 'Date · from text' : 'Date'}
            value={
              parsed.entryDate
                ? new Date(parsed.entryDate + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
                : new Date().toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
            }
          />
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 text-sm"
            onClick={onEdit}
          >
            Edit
            <ChevronRight size={14} className="ml-1" />
          </Button>
          <Button
            size="sm"
            className="flex-1 text-sm bg-primary"
            onClick={onConfirm}
          >
            <CheckCircle2 size={14} className="mr-1.5" />
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/60 rounded-lg px-3 py-2">
      <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-foreground truncate">{value}</p>
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
