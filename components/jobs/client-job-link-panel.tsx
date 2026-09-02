'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ClientJobLink, Job } from '@/lib/types';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  Check, CheckCircle2, Copy, ExternalLink, Eye, Image as ImageIcon,
  Link2, Loader2, Power, RefreshCw, Share2, ShieldCheck,
} from 'lucide-react';

function portalUrl(token: string): string {
  return `${window.location.origin}/client/${token}`;
}

function when(iso?: string): string {
  if (!iso) return 'Not yet';
  return new Date(iso).toLocaleString('en-NZ', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
}

const ACTIVITY_LABEL: Record<NonNullable<ClientJobLink['lastActivityKind']>, string> = {
  viewed: 'Client page opened',
  'quote-approved': 'Quote approved',
  'variation-approved': 'Extra work approved',
  'variation-declined': 'Extra work declined',
};

/**
 * The owner-side control for a job's single reusable client page. Nothing is
 * sent automatically: opening creates the private URL, then Share/Copy is a
 * separate deliberate action.
 */
export function ClientJobLinkPanel({ job }: { job: Job }) {
  const {
    role, clientJobLinks, ensureClientJobLink, updateClientJobLink,
    shiftPhotos, updateShiftPhoto, refresh, getQuoteTemplate,
  } = useStore();
  const [open, setOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const businessName = getQuoteTemplate()?.header.businessName || 'Lakeside Painting';

  const link = clientJobLinks.find((item) => item.jobId === job.id);
  const photos = useMemo(
    () => shiftPhotos
      .filter((photo) => photo.jobId === job.id)
      .sort((a, b) => b.takenOn.localeCompare(a.takenOn) || b.createdAt.localeCompare(a.createdAt))
      .slice(0, 18),
    [job.id, shiftPhotos],
  );

  const pathsKey = photos.map((photo) => photo.storagePath).join('|');
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open || !pathsKey) return;
    let cancelled = false;
    const paths = pathsKey.split('|');
    supabase.storage.from('shift-photos').createSignedUrls(paths, 3600).then(({ data, error: signError }) => {
      if (cancelled || signError || !data) return;
      const next: Record<string, string> = {};
      for (const row of data) if (row.path && row.signedUrl) next[row.path] = row.signedUrl;
      setUrls(next);
    });
    return () => { cancelled = true; };
  }, [open, pathsKey]);

  if (role !== 'owner') return null;
  if ((job.status === 'lost' || job.status === 'declined') && !link) return null;

  async function openPortalControls() {
    setOpen(true);
    setError(null);
    setCopied(false);
    if (link) return;
    setPreparing(true);
    const created = await ensureClientJobLink(job.id);
    setPreparing(false);
    if (!created) setError('The private link was not created. Check the message on screen and try again.');
  }

  async function copyLink() {
    if (!link) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(portalUrl(link.accessToken));
      setCopied(true);
    } catch {
      setError('Could not copy the link. Use Share instead.');
    }
  }

  async function shareLink() {
    if (!link || !link.enabled) return;
    const url = portalUrl(link.accessToken);
    if (!navigator.share) {
      await copyLink();
      return;
    }
    try {
      await navigator.share({
        title: `${job.name} · ${businessName}`,
        text: `Here is the private job page for ${job.name}.`,
        url,
      });
    } catch (shareError) {
      if ((shareError as Error)?.name !== 'AbortError') setError('Could not open sharing. You can copy the link instead.');
    }
  }

  async function toggleEnabled() {
    if (!link || switching) return;
    setSwitching(true);
    setError(null);
    const result = await updateClientJobLink(link.id, { enabled: !link.enabled });
    setSwitching(false);
    if (!result.ok) setError(result.error ?? 'Could not update the link.');
  }

  async function refreshActivity() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  const selectedCount = photos.filter((photo) => photo.clientVisible).length;
  const lastActivity = link?.lastActivityKind
    ? ACTIVITY_LABEL[link.lastActivityKind]
    : null;

  return (
    <>
      <button
        type="button"
        onClick={() => void openPortalControls()}
        className="flex min-h-14 w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted/30"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-primary">
          <Link2 size={19} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">Client job link</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {!link
              ? 'One private page for the quote, dates, invoices and photos'
              : !link.enabled
                ? 'Link is turned off'
                : lastActivity
                  ? `${lastActivity} · ${when(link.lastActivityAt)}`
                  : 'Ready to share · nothing sent automatically'}
          </span>
        </span>
        {link?.quoteAcceptedAt ? (
          <CheckCircle2 size={19} className="shrink-0 text-green-600" />
        ) : (
          <Share2 size={18} className="shrink-0 text-muted-foreground" />
        )}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[92dvh] overflow-hidden rounded-t-3xl p-0" showCloseButton={false}>
          <SheetHeader className="shrink-0 border-b border-border px-5 py-4 text-left">
            <SheetTitle>Client job link</SheetTitle>
            <p className="text-sm text-muted-foreground">A private, always-current page for {job.clientName || 'this client'}.</p>
          </SheetHeader>

          <div className="max-h-[calc(92dvh-88px)] space-y-5 overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
            {preparing && (
              <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={18} className="animate-spin" /> Creating the private page…
              </div>
            )}

            {!preparing && link && (
              <>
                <div className={cn(
                  'rounded-2xl border p-4',
                  link.enabled ? 'border-green-200 bg-green-50/70' : 'border-amber-200 bg-amber-50/70',
                )}>
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    {link.enabled ? <ShieldCheck size={18} className="text-green-700" /> : <Power size={18} className="text-amber-700" />}
                    {link.enabled ? 'Private link is active' : 'Private link is turned off'}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {link.enabled
                      ? 'Only someone with this unguessable link can open it. Nothing is sent until you tap Share.'
                      : 'The old URL shows nothing while the link is off. You can turn it back on anytime.'}
                  </p>
                </div>

                <div className="space-y-2">
                  <Button className="h-13 w-full text-base" onClick={() => void shareLink()} disabled={!link.enabled}>
                    <Share2 size={18} /> Share with client
                  </Button>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="outline" className="h-12" onClick={() => void copyLink()} disabled={!link.enabled}>
                      {copied ? <Check size={17} /> : <Copy size={17} />}
                      {copied ? 'Copied' : 'Copy link'}
                    </Button>
                    <Button
                      variant="outline"
                      className="h-12"
                      render={<a href={`/client/${link.accessToken}`} target="_blank" rel="noopener noreferrer" />}
                      disabled={!link.enabled}
                    >
                      <ExternalLink size={17} /> Preview
                    </Button>
                  </div>
                </div>

                <div className="rounded-2xl border border-border bg-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Client activity</p>
                      <p className="mt-0.5 text-sm font-medium">
                        {lastActivity ? lastActivity : 'No activity yet'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshActivity()}
                      disabled={refreshing}
                      className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-input bg-background"
                      aria-label="Refresh client activity"
                    >
                      <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-xl bg-muted/40 p-3">
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Eye size={13} /> Page opened</p>
                      <p className="mt-1 font-semibold">{link.viewCount} time{link.viewCount === 1 ? '' : 's'}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{when(link.lastViewedAt)}</p>
                    </div>
                    <div className="rounded-xl bg-muted/40 p-3">
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><CheckCircle2 size={13} /> Quote</p>
                      <p className="mt-1 font-semibold">{link.quoteAcceptedAt ? 'Approved' : 'Not approved'}</p>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {link.quoteAcceptedAt ? `${link.quoteAcceptedBy ?? 'Client'} · ${when(link.quoteAcceptedAt)}` : 'Waiting for client'}
                      </p>
                    </div>
                  </div>
                </div>

                {photos.length > 0 && (
                  <div>
                    <div className="mb-2 flex items-end justify-between gap-3">
                      <div>
                        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          <ImageIcon size={14} /> Client photos
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">Tap only the photos you are happy to share.</p>
                      </div>
                      <span className="shrink-0 text-xs font-medium text-muted-foreground">{selectedCount} shown</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {photos.map((photo) => (
                        <button
                          key={photo.id}
                          type="button"
                          onClick={() => updateShiftPhoto(photo.id, { clientVisible: !photo.clientVisible })}
                          aria-pressed={photo.clientVisible}
                          className={cn(
                            'relative aspect-square min-h-20 overflow-hidden rounded-xl border-2 bg-muted',
                            photo.clientVisible ? 'border-primary' : 'border-transparent opacity-60',
                          )}
                        >
                          {urls[photo.storagePath] ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={urls[photo.storagePath]} alt="Job progress" className="h-full w-full object-cover" />
                          ) : <span className="block h-full w-full animate-pulse" />}
                          {photo.clientVisible && (
                            <span className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <Check size={15} />
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => void toggleEnabled()}
                  disabled={switching}
                  className={cn(
                    'flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border px-4 text-sm font-semibold',
                    link.enabled
                      ? 'border-red-200 bg-white text-red-700'
                      : 'border-green-200 bg-green-50 text-green-800',
                  )}
                >
                  {switching ? <Loader2 size={17} className="animate-spin" /> : <Power size={17} />}
                  {link.enabled ? 'Turn client link off' : 'Turn client link back on'}
                </button>
              </>
            )}

            {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">{error}</p>}
            <Button variant="ghost" className="h-11 w-full" onClick={() => setOpen(false)}>Done</Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
