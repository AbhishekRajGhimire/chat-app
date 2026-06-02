// Rojin custom service worker: wraps Angular's ngsw (offline caching + push
// plumbing) and adds focus-aware push display + click-to-open. We register
// THIS file instead of ngsw-worker.js. Backend push payloads have NO top-level
// `notification` key, so ngsw shows nothing — we show it here, suppressing the
// banner when a Rojin window is already focused (the message arrives live).
importScripts('./ngsw-worker.js');

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch (e) { /* ignore non-JSON */ }
  if (!data || !data.title) return;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const focusedHere = wins.some((c) => c.focused);
    if (focusedHere) return; // user is actively in the app; they'll see it live
    await self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.conversationKey || undefined,
      renotify: true,
      data,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const payload = event.notification.data || {};
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      await wins[0].focus();
      wins[0].postMessage({ type: 'open-conversation', data: payload });
    } else {
      await self.clients.openWindow('/');
    }
  })());
});
