/*
 * BetterTrack's single root-scoped service worker. It owns the deliberately
 * small offline shell and the existing web-push handlers; registering another
 * worker at this scope would replace it and risk dropping push subscriptions.
 */

const CACHE_PREFIX = 'bettertrack-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const OFFLINE_URL = '/offline.html';
const HASHED_ASSET_PATH = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_URL)),
      self.skipWaiting(),
    ]),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
  }
  return response;
}

async function navigationNetworkFirst(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const fallback = await cache.match(OFFLINE_URL);
    if (fallback) return fallback;
    return new Response('BetterTrack · Offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // API traffic is intentionally left entirely to the browser. In particular,
  // do not call respondWith(fetch(...)): the worker must never own, cache, or
  // synthesize an authenticated API response.
  if (url.origin !== self.location.origin || isApiPath(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationNetworkFirst(request));
    return;
  }

  if (HASHED_ASSET_PATH.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

/*
 * Existing FCM/web-push behavior from push-sw.js (#368). The payload mirrors
 * the FCM data message: canonical notification type, title, body and deep-link
 * ids. Keep this in the app-shell worker because only one worker may own '/'.
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
