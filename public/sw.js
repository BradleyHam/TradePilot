// =============================================================
// TradePilot service worker — push notifications only
// =============================================================
//
// Deliberately does NOT cache or intercept fetches: the app's offline
// story is a separate problem, and a stale-cache bug in a money app is
// worse than no offline support. This file exists so the browser has
// somewhere to deliver pushes when the app is closed.
//
// Payload contract (must match PushPayload in lib/web-push.ts):
//   { title, body?, url?, tag? }
//
// iOS note: every push MUST show a notification (userVisibleOnly) —
// silently swallowing one gets the subscription throttled/revoked.

self.addEventListener('install', () => {
  // Activate immediately so the first subscribe doesn't wait for a
  // page reload.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload (shouldn't happen — our sender always sends
    // JSON) → still show something rather than nothing.
    data = { title: 'TradePilot', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'TradePilot';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || undefined,
      data: { url: data.url || '/home' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/home';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Reuse an open window when there is one (the installed PWA),
      // navigating it to the deep link; otherwise open fresh.
      for (const client of wins) {
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) {
            try { await client.navigate(url); } catch { /* cross-origin or gone */ }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
