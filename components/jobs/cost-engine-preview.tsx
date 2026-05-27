'use client';

/**
 * Cost Engine Preview — shows the Resene PD-anchored cost estimate for
 * a quote that has structured scope_zones populated, side-by-side with
 * what Brad actually quoted (and what got invoiced + paid, if known).
 *
 * Hidden when no quote on this job has scope_zones — keeps the
 * JobDetailSheet clean for the legacy/imported jobs that don't yet
 * have structured data (per the golden "no empty visualisations" rule).
 *
 * ## What this card tells the user
 *
 *  - **Suggested ex-GST**: what PD says the job should cost, inflated
 *    to the quoting year and adjusted for access level.
 *  - **Brad's quote**: what they actually quoted (from the quote row).
 *  - **Delta**: % difference between Brad and PD. Coloured to flag
 *    "you left money on the table" (+) vs "good margin" (-).
 *  - **Implied $/hr at outcome**: actual $ paid ÷ actual hours, so
 *    Brad can see whether the job's $/hr beat the PD's loaded floor
 *    (~$70/hr in 2026).
 *  - **Audit trail**: expandable list of every line — surface, qty,
 *    rate, PD page reference, inflation factor, access uplift. So
 *    Brad can verify every dollar.
 */

import { useMemo, useState } from 'react';
import type { Job, Quote } from '@/lib/types';
import { Separator } from '@/components/ui/separator';
import { Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import {
  estimateCost,
  compareEstimateToActual,
  type ScopeZone,
  type CostEstimate,
} from '@/lib/pricing/cost-engine';
import { jobStats } from '@/lib/job-stats';
import type { Entry, Invoice } from '@/lib/types';

interface CostEnginePreviewProps {
  job: Job;
  quotes: Quote[];
  entries: Entry[];
  invoices: Invoice[];
}

const fmt$ = (n: number): string =>
  `$${Math.round(n).toLocaleString('en-NZ')}`;

const fmtPct = (n: number): string =>
  `${n > 0 ? '+' : ''}${(n * 100).toFixed(0)}%`;

export function CostEnginePreview({
  job, quotes, entries, invoices,
}: CostEnginePreviewProps) {
  const [open, setOpen] = useState(false);

  // Find the most relevant quote — the latest one with scope_zones data.
  // Multiple quotes per job is rare but possible (revisions, alternates).
  const scopedQuote = useMemo<Quote | undefined>(() => {
    const eligible = quotes
      .filter((q) => q.jobId === job.id)
      .filter((q) => Array.isArray(q.scopeZones) && (q.scopeZones?.length ?? 0) > 0)
      .sort((a, b) => {
        const ad = a.dateSent ?? a.createdAt;
        const bd = b.dateSent ?? b.createdAt;
        return bd.localeCompare(ad);
      });
    return eligible[0];
  }, [job.id, quotes]);

  // Run the engine. Guarded against bad data — if a zone is missing its
  // measurement we surface the error rather than blowing up the sheet.
  const estimate = useMemo<{ ok: true; value: CostEstimate } | { ok: false; error: string } | null>(() => {
    if (!scopedQuote) return null;
    const zones = scopedQuote.scopeZones as ScopeZone[] | undefined;
    if (!zones || zones.length === 0) return null;
    try {
      const yearForEstimate = scopedQuote.dateSent
        ? new Date(scopedQuote.dateSent).getFullYear()
        : new Date().getFullYear();
      const value = estimateCost(zones, { quotingYear: yearForEstimate });
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [scopedQuote]);

  if (!scopedQuote || !estimate) return null;

  // Calibration delta — only meaningful once we have actuals. Pull from
  // jobStats for the live numbers (handles ex-GST consistently per
  // AGENTS.md). All amounts ex-GST so they're directly comparable.
  const stats = jobStats(job, entries, invoices);
  const quotedExGst   = scopedQuote.baseAmountExGst ?? job.quoteAmount ?? 0;
  const paidExGst     = stats.totalIncome > 0 ? stats.totalIncome : (stats.expectedIncome ?? 0);
  const actualHours   = stats.totalHours;
  const haveActuals   = quotedExGst > 0 && actualHours > 0;

  const calibration = estimate.ok && haveActuals
    ? compareEstimateToActual(estimate.value, {
        quotedExGst, paidExGst, actualHours,
      })
    : null;

  // Delta colour: red when Brad significantly under-quoted vs PD
  // (left money on the table), green when above PD (good margin).
  let deltaColor = 'text-muted-foreground';
  if (calibration) {
    if (calibration.estimateVsQuotePct >  0.10) deltaColor = 'text-amber-600';   // under-quoted
    if (calibration.estimateVsQuotePct < -0.05) deltaColor = 'text-green-700';   // above PD
  }

  return (
    <>
      <Separator />
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-violet-600" />
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Cost engine (Resene PD)
          </p>
          {!estimate.ok && (
            <span className="text-[10px] text-red-600 ml-auto">scope error</span>
          )}
        </div>

        {!estimate.ok ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
            Couldn&apos;t price this scope: {estimate.error}
          </div>
        ) : (
          <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-3 space-y-2.5">
            {/* Headline numbers */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  PD suggests (ex-GST)
                </p>
                <p className="text-lg font-bold text-foreground tabular-nums">
                  {fmt$(estimate.value.totalExGst)}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {fmt$(estimate.value.totalInclGst)} incl. GST
                </p>
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  You quoted (ex-GST)
                </p>
                <p className="text-lg font-bold text-foreground tabular-nums">
                  {quotedExGst > 0 ? fmt$(quotedExGst) : '—'}
                </p>
                {calibration && (
                  <p className={`text-[11px] font-medium ${deltaColor}`}>
                    {fmtPct(-calibration.estimateVsQuotePct)} vs PD
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1 border-t border-violet-200/60">
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Est. hours
                </p>
                <p className="text-sm font-semibold text-foreground tabular-nums">
                  {estimate.value.estimatedHours}h
                </p>
                {actualHours > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    actual: {Math.round(actualHours)}h
                  </p>
                )}
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Implied $/hr
                </p>
                <p className="text-sm font-semibold text-foreground tabular-nums">
                  ${Math.round(estimate.value.impliedHourlyRate)}/h
                </p>
                {calibration && (
                  <p className="text-[11px] text-muted-foreground">
                    actual: ${Math.round(calibration.actualHourlyRate)}/h
                  </p>
                )}
              </div>
            </div>

            {/* Calibration takeaway */}
            {calibration && (
              <div className={`text-[12px] leading-snug px-2 py-1.5 rounded-lg bg-white/60 border ${
                calibration.estimateVsQuotePct > 0.10
                  ? 'border-amber-200 text-amber-900'
                  : calibration.estimateVsQuotePct < -0.05
                    ? 'border-green-200 text-green-900'
                    : 'border-violet-200 text-violet-900'
              }`}>
                {calibration.takeaway}
              </div>
            )}

            {/* Audit trail */}
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="w-full flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground py-1"
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <span>{open ? 'Hide' : 'Show'} line breakdown · {estimate.value.lineItems.length} zone{estimate.value.lineItems.length === 1 ? '' : 's'} · PD 11th ed × {estimate.value.meta.inflationFactor.toFixed(2)} inflation</span>
            </button>

            {open && (
              <ul className="space-y-1.5 pt-1">
                {estimate.value.lineItems.map((li, i) => (
                  <li key={i} className="rounded-lg bg-white/70 border border-violet-100 px-2.5 py-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-medium text-foreground truncate">{li.zoneName}</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
                          {li.rate.label} <span className="text-violet-700 font-medium">[{li.rate.pdRef}]</span>
                        </p>
                        <p className="text-[10px] text-muted-foreground/80 mt-0.5 font-mono">
                          {li.explanation}
                        </p>
                      </div>
                      <span className="text-[12px] font-semibold tabular-nums shrink-0">
                        {fmt$(li.adjustedSubtotalExGst)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </>
  );
}
