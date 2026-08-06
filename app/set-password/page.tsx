'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Hammer, Check } from 'lucide-react';

type Status = 'checking' | 'ready' | 'no-session' | 'saving' | 'done';

export default function SetPasswordPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The invite link carries a session in the URL; the Supabase client picks
  // it up automatically (detectSessionInUrl). We wait briefly for that.
  useEffect(() => {
    let settled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (settled) return;
      if (data.session) { settled = true; setStatus('ready'); }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (settled) return;
      if (session) { settled = true; setStatus('ready'); }
    });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; setStatus('no-session'); }
    }, 3000);
    return () => { sub.subscription.unsubscribe(); clearTimeout(timer); };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) { setError('Use at least 8 characters.'); return; }
    if (password !== confirm) { setError('The two passwords don’t match.'); return; }
    setStatus('saving');
    const { error: updErr } = await supabase.auth.updateUser({ password });
    if (updErr) { setError(updErr.message); setStatus('ready'); return; }
    setStatus('done');
    // Send everyone to the app home. Owners (e.g. a password reset) stay on
    // /entry; employees get bounced to /my/hours by RoleGuard. This keeps the
    // one page working for both the invite flow and forgot-password resets.
    setTimeout(() => router.replace('/entry'), 1200);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm bg-card border border-border rounded-2xl p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center">
            <Hammer size={18} className="text-primary-foreground" strokeWidth={2.2} />
          </div>
          <div>
            <p className="font-bold text-sm leading-none">TradePilot</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Lakeside Painting</p>
          </div>
        </div>

        {status === 'checking' && (
          <p className="text-sm text-muted-foreground py-4">Checking your invite…</p>
        )}

        {status === 'no-session' && (
          <div className="space-y-2">
            <h1 className="text-lg font-bold">Link expired</h1>
            <p className="text-sm text-muted-foreground">
              This invite link is invalid or has expired. Ask Brad to send you a new one.
            </p>
          </div>
        )}

        {status === 'done' && (
          <div className="space-y-2">
            <h1 className="text-lg font-bold flex items-center gap-1.5"><Check size={18} className="text-primary" /> All set</h1>
            <p className="text-sm text-muted-foreground">Taking you into the app…</p>
          </div>
        )}

        {(status === 'ready' || status === 'saving') && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <h1 className="text-lg font-bold">Set your password</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Pick a password to log in with from now on.</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">New password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                className="w-full min-h-[44px] rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full min-h-[44px] rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full min-h-[48px]" disabled={status === 'saving'}>
              {status === 'saving' ? 'Saving…' : 'Save password & continue'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
