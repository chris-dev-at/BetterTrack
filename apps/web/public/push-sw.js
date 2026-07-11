/*
 * BetterTrack push service worker (#368/#350). Push + notification-click ONLY —
 * no fetch handler, so it never intercepts app traffic (the offline PWA shell
 * is a separate arc, #350). The payload mirrors the FCM data message: canonical
 * notification `type`, title, body and deep-link ids.
 */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'BetterTrack', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'BetterTrack';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/BT_AppIcon.png',
      badge: '/BT_AppIcon.png',
      tag: payload.type || 'bettertrack',
      data: payload,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // Deep-link by canonical type; anything unknown lands on the app root.
  let path = '/';
  if (data.type === 'chat.message' && data.data && data.data.conversationId) {
    path = '/social/chat/c/' + data.data.conversationId;
  } else if (data.type === 'alert.triggered' && data.data && data.data.assetId) {
    path = '/assets/' + data.data.assetId;
  } else if (data.type === 'friend.request' || data.type === 'friend.accepted') {
    path = '/social';
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(path);
          return client.focus();
        }
      }
      return self.clients.openWindow(path);
    }),
  );
});
