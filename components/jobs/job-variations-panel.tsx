'use client';

import { useMemo, useState } from 'react';
import type { Job, JobVariation } from '@/lib/types';
import { useStore } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Check, CheckCircle2, Copy, ExternalLink, Plus, ShieldCheck, XCircle } from 'lucide-react';
import { VariationAction } from './variation-action';

function money(amount: number): string {
  return amount.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' });
}

const STATUS: Record<JobVariation['status'], { label: string; className: string; icon: typeof CheckCircle2 }> = {
  draft: { label: 'Draft', className: 'bg-muted text-muted-foreground', icon: ShieldCheck },
  ready: { label: 'Awaiting approval', className: 'bg-blue-50 text-blue-800', icon: ShieldCheck },
  approved: { label: 'Approved', className: 'bg-green-50 text-green-800', icon: CheckCircle2 },
  declined: { label: 'Declined', className: 'bg-red-50 text-red-800', icon: XCircle },
  cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground', icon: XCircle },
};

/** Owner-only job history plus the manual entry point for extra work. */
export function JobVariationsPanel({ job }: { job: Job }) {
  const { role, jobVariations, shiftPhotos } = useStore();
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const variations = useMemo(
    () => jobVariations
      .filter((variation) => variation.jobId === job.id && variation.status !== 'cancelled')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [jobVariations, job.id],
  );
  const candidatePhotos = useMemo(
    () => shiftPhotos
      .filter((photo) => photo.jobId === job.id)
      .sort((a, b) => b.takenOn.localeCompare(a.takenOn) || b.createdAt.localeCompare(a.createdAt))
      .slice(0, 6),
    [shiftPhotos, job.id],
  );

  if (role !== 'owner') return null;

  async function copyLink(variation: JobVariation) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/variation/${variation.approvalToken}`);
      setCopiedId(variation.id);
    } catch {
      setCopiedId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Variations</p>
          <p className="mt-0.5 text-sm text-muted-foreground">Extra work with client approval</p>
        </div>
        <Button variant="outline" size="sm" className="min-h-11 shrink-0" onClick={() => setCreating(true)}>
          <Plus size={16} /> Add
        </Button>
      </div>

      {variations.length > 0 ? (
        <div className="mt-3 space-y-2">
          {variations.map((variation) => {
            const meta = STATUS[variation.status];
            const StatusIcon = meta.icon;
            return (
              <div key={variation.id} className="rounded-xl border border-border bg-muted/25 px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{variation.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      +{money(variation.amountExGst * 1.15)} incl GST
                    </p>
                  </div>
                  <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold', meta.className)}>
                    <StatusIcon size={12} /> {meta.label}
                  </span>
                </div>
                {variation.description && (
                  <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{variation.description}</p>
                )}
                <div className="mt-2 flex gap-2">
                  {variation.status === 'ready' && (
                    <button
                      type="button"
                      onClick={() => copyLink(variation)}
                      className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-input bg-background px-3 text-xs font-semibold"
                    >
                      {copiedId === variation.id ? <Check size={15} /> : <Copy size={15} />}
                      {copiedId === variation.id ? 'Link copied' : 'Copy client link'}
                    </button>
                  )}
                  <a
                    href={`/variation/${variation.approvalToken}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-input bg-background px-3 text-xs font-semibold"
                  >
                    <ExternalLink size={15} /> View
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-input bg-muted/20 px-3 text-sm font-medium text-muted-foreground"
        >
          <Plus size={16} /> Add unexpected work before doing it
        </button>
      )}

      {creating && (
        <VariationAction
          key={`${job.id}-${creating}`}
          job={job}
          photos={candidatePhotos}
          open
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
