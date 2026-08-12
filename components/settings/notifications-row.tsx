'use client';

// =============================================================
// Settings → Preferences → Notifications row (live toggle)
// =============================================================
//
// Replaces the old "Coming soon" placeholder. One tap turns push
// notifications on for THIS device: register the service worker →
// ask permission (must happen inside the tap handler — browsers
// reject permission prompts that aren't user-gestures) → subscribe →
// save to the server, which fires a confirmation push straight back.
// Tap again to turn off.
//
// iOS reality check, because Brad's phone is the target device: web
// push only exists for PWAs *installed to the Home Screen* (iOS
// 16.4+). Safari-in-browser reports no PushManager, so instead of a
// dead toggle we show "Add to Home Screen first" — the actual fix.
//
// Visually a clone of the page-local SettingRow (kept private there
// on purpose); duplicating 20 lines of markup beats exporting a
// one-page-old internal component and coupling to it.

import { useCallback, useEffect, useState } from 'react';
import { Bell, BellRing } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase/client';

type PushState =
  | 'checking'      // first render — probing current subscription
  | 'unsupported'   // browser has no push at all (or iOS not installed)
  | 'need-install'  // iOS Safari, not running as an installed PWA
  | 'denied'        // permission previously refused at the OS level
  | 'off'
  | 'on'
  | 'busy';         // a toggle is in flight

/** base64url VAPID public key → the Uint8Array subscribe() wants. */
function vapidKeyBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(b64 + pad);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function NotificationsRow() {
  const [state, setState] = useState<PushState>('checking');
  const [error, setError] = useState<string | null>(null);
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  useEffect(() => {
    (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !publicKey) {
        // iOS Safari outside an installed PWA has no PushManager —
        // that's the "install it first" case, not a hard unsupported.
        setState(isIos() && !isStandalone() ? 'need-install' : 'unsupported');
        return;
      }
      if (Notification.permission === 'denied') {
        setState('denied');
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setState(sub ? 'on' : 'off');
    })().catch(() => setState('unsupported'));
  }, [publicKey]);

  const enable = useCallback(async () => {
    setState('busy');
    setError(null);
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      // MUST stay inside the tap's call stack or Safari refuses.
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setState(perm === 'denied' ? 'denied' : 'off');
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyBytes(publicKey!) as BufferSource,
      });
      const json = sub.toJSON();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Not signed in.');
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          p256dh: json.keys?.p256dh,
          auth: json.keys?.auth,
          userAgent: navigator.userAgent,
        }),
      });
      const out = await res.json();
      if (!res.ok || !out.ok) throw new Error(out.error ?? `Save failed (${res.status}).`);
      setState('on');
    } catch (e) {
      // Loud failures — say what went wrong on screen, don't silently
      // revert (golden rule #1).
      setError(e instanceof Error ? e.message : 'Something went wrong turning notifications on.');
      setState('off');
    }
  }, [publicKey]);

  const disable = useCallback(async () => {
    setState('busy');
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (token) {
          // Best-effort: if this fails the server row goes stale and
          // the next send prunes it via 404/410 anyway.
          await fetch('/api/push/subscribe', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ endpoint }),
          }).catch(() => {});
        }
      }
      setState('off');
    } catch {
      setState('on');
      setError("Couldn't turn notifications off — try again.");
    }
  }, []);

  const onTap = () => {
    if (state === 'on') void disable();
    else if (state === 'off') void enable();
  };

  const valueText: Record<PushState, string> = {
    checking: 'Checking…',
    unsupported: 'Not supported in this browser',
    'need-install': 'Add TradePilot to your Home Screen first',
    denied: 'Blocked — allow TradePilot in iPhone Settings → Notifications',
    off: 'Off — tap to get reminders on this phone',
    on: 'On for this device',
    busy: 'Working…',
  };

  const Icon = state === 'on' ? BellRing : Bell;
  const tappable = state === 'on' || state === 'off';

  return (
    <button
      className="flex items-center gap-3 w-full py-3 px-4 hover:bg-muted/50 active:bg-muted transition-colors text-left disabled:opacity-60"
      onClick={onTap}
      disabled={!tappable}
    >
      <div className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center shrink-0">
        <Icon size={15} className="text-muted-foreground" strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">Notifications</p>
        <p className="text-xs text-muted-foreground mt-0.5">{error ?? valueText[state]}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {state === 'on' && <Badge variant="secondary" className="text-xs">On</Badge>}
        {state === 'off' && <Badge variant="secondary" className="text-xs">Off</Badge>}
      </div>
    </button>
  );
}
