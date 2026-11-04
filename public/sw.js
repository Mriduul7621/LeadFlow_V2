/**
 * sw.js — LeadFlow service worker (Web Push reminders only).
 * ------------------------------------------------------------------
 * Deliberately minimal: this worker exists so agents who opt in can
 * receive the free daily follow-up reminder push ("আজ Xটি follow-up
 * due, Yটি overdue"). It does NOT cache app assets and does NOT
 * intercept fetches, so it cannot affect how the app loads or works
 * offline. Registered from src/main.tsx on the web only (never inside
 * the Capacitor native shell).
 */

self.addEventListener('install', () => {
  // Take over immediately; there is no cache to migrate.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = { body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'LeadFlow — ফলো-আপ রিমাইন্ডার';
  const options = {
    body: payload.body || '',
    icon: '/android-chrome-192x192.png',
    badge: '/android-chrome-192x192.png',
    data: { url: payload.url || '/workbench' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/workbench';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus an already-open LeadFlow tab and take it to the target.
      for (const client of windowClients) {
        if ('focus' in client) {
          return client.focus().then((focused) => {
            if (focused && 'navigate' in focused) return focused.navigate(targetUrl);
            return undefined;
          });
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return undefined;
    }),
  );
});
