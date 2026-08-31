'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from 'lucide-react';

type SettledStatus = 'ready' | 'approved' | 'declined';

function money(amount: number): string {
  return amount.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' });
}

export function VariationResponse({
  token,
  initialStatus,
  amountInclGst,
}: {
  token: string;
  initialStatus: SettledStatus;
  amountInclGst: number;
}) {
  const [status, setStatus] = useState<SettledStatus>(initialStatus);
  const [busy, setBusy] = useState<'approved' | 'declined' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(response: 'approved' | 'declined') {
    setBusy(response);
    setError(null);
    try {
      const result = await fetch(`/api/public/variations/${token}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      });
      const payload = await result.json() as { ok?: boolean; status?: SettledStatus; error?: string };
      if (!result.ok || !payload.ok) throw new Error(payload.error ?? 'Your response was not saved.');
      setStatus(payload.status === 'declined' ? 'declined' : 'approved');
    } catch (responseError) {
      setError((responseError as Error)?.message ?? 'Your response was not saved. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  if (status === 'approved') {
    return (
      <div className="rounded-3xl border border-green-200 bg-green-50 p-5 text-center text-green-950">
        <CheckCircle2 size={34} className="mx-auto text-green-700" />
        <h2 className="mt-3 text-xl font-bold">Approved, thank you</h2>
        <p className="mt-1 text-sm leading-relaxed">The extra {money(amountInclGst)} incl GST has been added to the agreed job price.</p>
      </div>
    );
  }

  if (status === 'declined') {
    return (
      <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-center text-slate-900">
        <XCircle size={34} className="mx-auto text-slate-600" />
        <h2 className="mt-3 text-xl font-bold">Not approved</h2>
        <p className="mt-1 text-sm leading-relaxed">No extra charge has been added. Lakeside Painting can talk through another option with you.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="rounded-2xl bg-orange-50 px-4 py-3 text-sm text-orange-950">
        <p className="flex items-center gap-2 font-semibold"><ShieldCheck size={17} /> Nothing changes until you approve</p>
        <p className="mt-1 text-xs leading-relaxed text-orange-900/80">Approving adds {money(amountInclGst)} incl GST to the agreed price for this job.</p>
      </div>

      {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-800">{error}</p>}

      <div className="mt-4 space-y-2">
        <button
          type="button"
          onClick={() => respond('approved')}
          disabled={busy != null}
          className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#f25a00] px-4 text-base font-bold text-white shadow-sm disabled:opacity-60"
        >
          {busy === 'approved' ? <Loader2 size={19} className="animate-spin" /> : <CheckCircle2 size={19} />}
          Approve extra work · {money(amountInclGst)}
        </button>
        <button
          type="button"
          onClick={() => respond('declined')}
          disabled={busy != null}
          className="min-h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-600 disabled:opacity-60"
        >
          {busy === 'declined' ? 'Saving…' : 'Don’t approve this'}
        </button>
      </div>
    </div>
  );
}
