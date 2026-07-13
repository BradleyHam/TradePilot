'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { rowToBusinessMember } from '@/lib/supabase/mappers';
import type { BusinessMember, WorkerKind } from '@/lib/types';
import { UserPlus, Trash2, Check, RefreshCw, Shield } from 'lucide-react';

const WORKER_KINDS: { value: WorkerKind; label: string }[] = [
  { value: 'helper', label: 'Helper (prep, sanding, masking)' },
  { value: 'apprentice', label: 'Apprentice' },
  { value: 'experienced', label: 'Experienced painter' },
  { value: 'subcontractor', label: 'Subcontractor' },
];

function genPassword() {
  // Readable temp password: word-ish + digits. Brad hands it to the
  // employee; not meant to be permanent.
  const words = ['paint', 'roller', 'brush', 'ladder', 'primer', 'tape', 'gloss', 'satin'];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${w}-${n}-${['red', 'blue', 'gold', 'teal'][Math.floor(Math.random() * 4)]}`;
}

export default function TeamPage() {
  const [members, setMembers] = useState<BusinessMember[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(genPassword());
  const [workerKind, setWorkerKind] = useState<WorkerKind>('helper');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; email: string; password: string } | null>(null);

  const loadMembers = useCallback(async () => {
    // Owner can read all memberships in their business (RLS policy). We
    // don't flip a loading flag synchronously here (the initial state is
    // already `true`) so this stays safe to call from an effect.
    const { data, error: err } = await supabase
      .from('business_members')
      .select('*')
      .order('created_at', { ascending: true });
    if (!err && data) setMembers(data.map(rowToBusinessMember));
    setLoadingList(false);
  }, []);

  // Initial load. Inlined (rather than calling loadMembers) so all setState
  // happens after an await — no synchronous state writes in the effect body.
  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error: err } = await supabase
        .from('business_members')
        .select('*')
        .order('created_at', { ascending: true });
      if (!active) return;
      if (!err && data) setMembers(data.map(rowToBusinessMember));
      setLoadingList(false);
    })();
    return () => { active = false; };
  }, []);

  async function authHeader(): Promise<Record<string, string>> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
  }

  async function handleAdd() {
    setError(null);
    setCreated(null);
    if (!name.trim() || !email.trim() || password.length < 8) {
      setError('Fill in name, a valid email, and a password of at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/employees', {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ email, password, displayName: name, workerKind }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Something went wrong.');
      } else {
        setCreated({ name: name.trim(), email: email.trim().toLowerCase(), password });
        setName(''); setEmail(''); setPassword(genPassword()); setWorkerKind('helper');
        loadMembers();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove(m: BusinessMember) {
    if (!confirm(`Remove ${m.displayName ?? 'this person'}? They'll lose access immediately. Their logged hours stay on the jobs.`)) return;
    const res = await fetch('/api/employees', {
      method: 'DELETE',
      headers: await authHeader(),
      body: JSON.stringify({ userId: m.userId }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) { setError(json.error ?? 'Failed to remove.'); return; }
    loadMembers();
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader title="Team" />

      <div className="px-4 md:px-6 pb-10 max-w-xl w-full mx-auto space-y-5">
        {/* Current team */}
        <div className="bg-card border border-border rounded-2xl overflow-hidden">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-4 py-3 border-b border-border">
            Team
          </p>
          {loadingList ? (
            <p className="text-sm text-muted-foreground px-4 py-4">Loading…</p>
          ) : (
            <div className="divide-y divide-border">
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                    {m.role === 'owner'
                      ? <Shield size={16} className="text-primary" />
                      : <span className="text-sm font-semibold">{(m.displayName ?? '?').charAt(0)}</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{m.displayName ?? '—'}</p>
                    <p className="text-xs text-muted-foreground capitalize">
                      {m.role}{m.workerKind && m.role !== 'owner' ? ` · ${m.workerKind}` : ''}
                    </p>
                  </div>
                  {m.role === 'owner'
                    ? <Badge variant="secondary" className="text-xs">You</Badge>
                    : (
                      <button onClick={() => handleRemove(m)} className="text-muted-foreground hover:text-destructive p-2" aria-label="Remove">
                        <Trash2 size={16} />
                      </button>
                    )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Success card with credentials to hand over */}
        {created && (
          <div className="rounded-2xl border border-primary/40 bg-primary/5 p-4 space-y-2">
            <p className="text-sm font-semibold flex items-center gap-1.5"><Check size={16} className="text-primary" /> {created.name} can now log in</p>
            <p className="text-xs text-muted-foreground">Give them these details (they log in at the same web address):</p>
            <div className="rounded-xl bg-card border border-border p-3 text-sm font-mono">
              <p>Email: {created.email}</p>
              <p>Password: {created.password}</p>
            </div>
            <p className="text-[11px] text-muted-foreground">They&apos;ll only see Log Hours + Schedule — never any money.</p>
          </div>
        )}

        {/* Add employee */}
        <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
          <p className="text-sm font-semibold flex items-center gap-1.5"><UserPlus size={16} className="text-primary" /> Add employee</p>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Suzie"
              className="w-full min-h-[44px] rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary" />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">Email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="suzie@example.com"
              className="w-full min-h-[44px] rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary" />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">Temporary password</label>
            <div className="flex gap-2">
              <input value={password} onChange={(e) => setPassword(e.target.value)}
                className="flex-1 min-h-[44px] rounded-xl border border-border bg-background px-3 text-sm font-mono outline-none focus:border-primary" />
              <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => setPassword(genPassword())}>
                <RefreshCw size={14} /> New
              </Button>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">Role on jobs</label>
            <div className="flex flex-wrap gap-2">
              {WORKER_KINDS.map((wk) => (
                <button key={wk.value} onClick={() => setWorkerKind(wk.value)}
                  className={cn('min-h-[40px] px-3 rounded-full border text-xs transition-colors',
                    workerKind === wk.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border text-muted-foreground')}>
                  {wk.label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button className="w-full min-h-[48px]" disabled={submitting} onClick={handleAdd}>
            {submitting ? 'Creating…' : 'Create login'}
          </Button>
        </div>
      </div>
    </div>
  );
}
