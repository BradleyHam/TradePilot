'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';

function money(amount: number): string {
  return amount.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' });
}

export function ClientQuoteResponse({
  token,
  amountInclGst,
  clientName,
  initiallyAccepted,
  acceptedBy,
}: {
  token: string;
  amountInclGst: number;
  clientName: string;
  initiallyAccepted: boolean;
  acceptedBy?: string;
}) {
  const [name, setName] = useState(clientName);
  const [approved, setApproved] = useState(initiallyAccepted);
  const [approvedBy, setApprovedBy] = useState(acceptedBy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    const cleanName = name.trim();
    if (cleanName.length < 2) {
      setError('Please type your name before approving.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/public/client/${token}/accept-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptedBy: cleanName }),
      });
      const payload = await response.json() as { ok?: boolean; acceptedBy?: string; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? 'Your approval was not saved.');
      setApprovedBy(payload.acceptedBy ?? cleanName);
      setApproved(true);
    } catch (approvalError) {
      setError((approvalError as Error)?.message ?? 'Your approval was not saved. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (approved) {
    return (
      <div className="rounded-3xl border border-green-200 bg-green-50 p-5 text-center text-green-950">
        <CheckCircle2 size={34} className="mx-auto text-green-700" />
        <h2 className="mt-3 text-xl font-bold">Quote approved</h2>
        <p className="mt-1 text-sm leading-relaxed">
          Thank you{approvedBy ? `, ${approvedBy.split(/\s+/)[0]}` : ''}. The agreed price is {money(amountInclGst)} including GST.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="rounded-2xl bg-orange-50 px-4 py-3 text-sm text-orange-950">
        <p className="flex items-center gap-2 font-semibold"><ShieldCheck size={17} /> Approve only when everything looks right</p>
        <p className="mt-1 text-xs leading-relaxed text-orange-900/80">
          This records your approval of the quote for {money(amountInclGst)} including GST. It can only be accepted once.
        </p>
      </div>

      <label htmlFor="client-approval-name" className="mb-1.5 mt-4 block text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
        Your name
      </label>
      <input
        id="client-approval-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoComplete="name"
        className="h-13 w-full rounded-2xl border border-slate-200 bg-white px-4 text-base outline-none focus:border-orange-400 focus:ring-4 focus:ring-orange-100"
        placeholder="Type your full name"
      />

      {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-800">{error}</p>}

      <button
        type="button"
        onClick={() => void approve()}
        disabled={busy}
        className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#f25a00] px-4 text-base font-bold text-white shadow-sm disabled:opacity-60"
      >
        {busy ? <Loader2 size={19} className="animate-spin" /> : <CheckCircle2 size={19} />}
        Approve quote · {money(amountInclGst)}
      </button>
    </div>
  );
}
