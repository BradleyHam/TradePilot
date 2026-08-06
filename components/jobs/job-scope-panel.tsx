'use client';

/**
 * JobScopePanel — "what this job includes / doesn't include", written for
 * whoever is ON SITE. Employees see it read-only on their Log Hours screen
 * and in their calendar; the owner can pull it out of the quote PDF with
 * one tap, edit it, or type it by hand.
 *
 * Why it exists: an employee can't see the quote (it's priced), so without
 * this they have no way to know where the job stops — and doing unpaid
 * extra work is a real cost. The exclusions half is the valuable half.
 *
 * Money safety: these lists live in `jobs_public`, so employees CAN read
 * them. The extractor is told never to emit prices, `stripMoney()` drops
 * any line that still looks like money, and nothing saves until the owner
 * has looked at it in the review state below.
 */

import { useState } from 'react';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { extractPdfText } from '@/lib/pdf/extract-text';
import { stripMoney } from '@/lib/scope-extractor';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { QuoteAttachment } from '@/lib/types';
import { ClipboardList, Check, X, Sparkles, Plus, Loader2, Pencil } from 'lucide-react';

export function JobScopePanel({
  jobId,
  /** The job's attachments — we look for a quote PDF to extract from. */
  attachments,
}: {
  jobId: string;
  attachments: QuoteAttachment[];
}) {
  const { jobs, role, updateJob } = useStore();
  const job = jobs.find((j) => j.id === jobId);

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Draft lists while editing / reviewing an extraction.
  const [included, setIncluded] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);

  if (!job) return null;

  const savedIncluded = job.scopeIncluded ?? [];
  const savedExcluded = job.scopeExcluded ?? [];
  const hasScope = savedIncluded.length > 0 || savedExcluded.length > 0;
  const isOwner = role === 'owner';

  // Employees get the read-only view and nothing else.
  if (!isOwner) {
    if (!hasScope) return null;
    return <ScopeLists included={savedIncluded} excluded={savedExcluded} />;
  }

  const quotePdf = attachments.find(
    (a) => a.kind === 'quote_pdf' || /\.pdf$/i.test(a.fileName ?? a.storagePath),
  );

  function beginEdit() {
    setIncluded(savedIncluded);
    setExcluded(savedExcluded);
    setError(null);
    setEditing(true);
  }

  /**
   * Download the quote PDF, pull its text out in the browser (same path
   * the invoice + mark-as-quoted flows use), and ask the server to split
   * it into inclusions/exclusions. Lands in the editor for review — it
   * never saves straight to the job.
   */
  async function extractFromQuote() {
    if (!quotePdf) return;
    setBusy(true);
    setError(null);
    try {
      const { data, error: dlErr } = await supabase.storage
        .from('quote-attachments')
        .download(quotePdf.storagePath);
      if (dlErr || !data) throw new Error('Could not open the quote PDF.');

      const file = new File([data], quotePdf.fileName ?? 'quote.pdf', { type: 'application/pdf' });
      const { text } = await extractPdfText(file);
      if (!text.trim()) {
        throw new Error('That PDF has no text layer to read — it may be a scan.');
      }

      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const res = await fetch('/api/parse-scope', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Could not read that quote.');

      setIncluded(json.scope.included ?? []);
      setExcluded(json.scope.excluded ?? []);
      setEditing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function save() {
    // Final money scrub — the owner may have typed a price in by hand.
    updateJob(jobId, {
      scopeIncluded: stripMoney(included),
      scopeExcluded: stripMoney(excluded),
    });
    setEditing(false);
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <ClipboardList size={13} /> Scope for the crew
        </p>
        {!editing && (
          <div className="flex gap-1.5">
            {quotePdf && (
              <Button variant="outline" size="sm" onClick={extractFromQuote} disabled={busy}>
                {busy
                  ? <><Loader2 size={13} className="animate-spin" /> Reading…</>
                  : <><Sparkles size={13} /> {hasScope ? 'Re-read quote' : 'Get from quote'}</>}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={beginEdit}>
              <Pencil size={13} /> {hasScope ? 'Edit' : 'Add'}
            </Button>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-destructive mb-1.5">{error}</p>}

      {editing ? (
        <div className="space-y-3">
          <EditableList
            label="Includes"
            tone="included"
            items={included}
            onChange={setIncluded}
          />
          <EditableList
            label="Does NOT include"
            tone="excluded"
            items={excluded}
            onChange={setExcluded}
          />
          <p className="text-[11px] text-muted-foreground">
            Your crew can read this — keep prices out of it.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1 h-11" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button className="flex-1 h-11" onClick={save}>Save scope</Button>
          </div>
        </div>
      ) : hasScope ? (
        <ScopeLists included={savedIncluded} excluded={savedExcluded} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {quotePdf
            ? 'Nothing yet — tap “Get from quote” and I’ll pull the inclusions and exclusions out of the quote PDF for you to check.'
            : 'Nothing yet. Add what the job covers so whoever’s on site knows where it stops.'}
        </p>
      )}
    </div>
  );
}

/** Read-only display, shared by the owner view and the employee view. */
export function ScopeLists({
  included,
  excluded,
}: {
  included: string[];
  excluded: string[];
}) {
  if (included.length === 0 && excluded.length === 0) return null;
  return (
    <div className="space-y-2.5">
      {included.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-green-700 uppercase tracking-wide mb-1">Includes</p>
          <ul className="space-y-1">
            {included.map((line, i) => (
              <li key={i} className="text-sm flex gap-1.5">
                <Check size={14} className="text-green-600 shrink-0 mt-0.5" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {excluded.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-red-700 uppercase tracking-wide mb-1">Does NOT include</p>
          <ul className="space-y-1">
            {excluded.map((line, i) => (
              <li key={i} className="text-sm flex gap-1.5">
                <X size={14} className="text-red-500 shrink-0 mt-0.5" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EditableList({
  label,
  tone,
  items,
  onChange,
}: {
  label: string;
  tone: 'included' | 'excluded';
  items: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div>
      <p className={cn(
        'text-[11px] font-semibold uppercase tracking-wide mb-1',
        tone === 'included' ? 'text-green-700' : 'text-red-700',
      )}>
        {label}
      </p>
      <div className="space-y-1.5">
        {items.map((line, i) => (
          <div key={i} className="flex gap-1.5">
            <input
              value={line}
              onChange={(e) => onChange(items.map((v, idx) => (idx === i ? e.target.value : v)))}
              className="flex-1 min-h-[40px] rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus:border-primary"
            />
            <button
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              className="text-muted-foreground hover:text-destructive px-2"
              aria-label="Remove line"
            >
              <X size={15} />
            </button>
          </div>
        ))}
        <button
          onClick={() => onChange([...items, ''])}
          className="text-xs text-primary font-medium flex items-center gap-1 min-h-[36px]"
        >
          <Plus size={13} /> Add line
        </button>
      </div>
    </div>
  );
}
