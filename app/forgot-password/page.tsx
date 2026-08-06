'use client';

import { useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Hammer, Check, ArrowLeft } from 'lucide-react';

type Status = 'idle' | 'sending' | 'sent';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus('sending');
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
      { redirectTo: `${window.location.origin}/set-password` },
    );
    if (resetError) {
      setError(resetError.message);
      setStatus('idle');
      return;
    }
    // Always show success even if the email isn't registered — don't leak
    // which addresses have accounts.
    setStatus('sent');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Brand */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center">
            <Hammer size={26} className="text-primary-foreground" strokeWidth={1.8} />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold text-foreground">Reset password</h1>
            <p className="text-sm text-muted-foreground mt-1">
              We&apos;ll email you a link to set a new one.
            </p>
          </div>
        </div>

        {status === 'sent' ? (
          <div className="bg-card border border-border rounded-2xl p-5 space-y-3">
            <h2 className="text-base font-semibold flex items-center gap-1.5">
              <Check size={18} className="text-primary" /> Check your email
            </h2>
            <p className="text-sm text-muted-foreground">
              If an account exists for <span className="font-medium text-foreground">{email.trim()}</span>,
              a reset link is on its way. Open it on this device and you&apos;ll be taken
              straight to a page to set a new password.
            </p>
            <p className="text-xs text-muted-foreground">
              Didn&apos;t get it? Check spam, or{' '}
              <button
                type="button"
                onClick={() => setStatus('idle')}
                className="underline underline-offset-2 hover:text-foreground"
              >
                try again
              </button>
              .
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3 bg-card border border-border rounded-2xl p-5">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                Email
              </label>
              <input
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <Button
              type="submit"
              className="w-full bg-primary h-11 text-base font-semibold"
              disabled={status === 'sending'}
            >
              {status === 'sending' ? 'Sending…' : 'Send reset link'}
            </Button>
          </form>
        )}

        <Link
          href="/login"
          className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={15} /> Back to sign in
        </Link>
      </div>
    </div>
  );
}
