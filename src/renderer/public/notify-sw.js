// Notifications only. This worker never intercepts requests or stores screen data.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const link = event.notification.data?.link;
  if (typeof link !== 'string' || !link.startsWith('/') || link.startsWith('//') || link.includes('\\')) return;
  const target = new URL(link, self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (client) {
      await client.focus();
      client.postMessage({ type: 'wook:navigate', link });
    } else await self.clients.openWindow(link);
  })());
});
