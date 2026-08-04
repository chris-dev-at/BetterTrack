import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const workerSource = readFileSync(resolve(process.cwd(), 'public/service-worker.js'), 'utf8');
const offlineSource = readFileSync(resolve(process.cwd(), 'public/offline.html'), 'utf8');
const BUILD_HASH_TOKEN = '__BETTERTRACK_BUILD_HASH__';

type WorkerHandler = (event: Record<string, unknown>) => void;

function cacheKey(request: unknown): string {
  if (typeof request === 'string') return request;
  if (request && typeof request === 'object' && 'url' in request) {
    const { url } = request as { url?: unknown };
    if (typeof url === 'string') return url;
  }
  return String(request);
}

function cacheStorageHarness() {
  const stores = new Map<
    string,
    {
      entries: Map<string, unknown>;
      match: ReturnType<typeof vi.fn>;
      put: ReturnType<typeof vi.fn>;
    }
  >();

  function cacheFor(name: string) {
    let cache = stores.get(name);
    if (!cache) {
      const entries = new Map<string, unknown>();
      cache = {
        entries,
        match: vi.fn(async (request: unknown) => entries.get(cacheKey(request))),
        put: vi.fn(async (request: unknown, response: unknown) => {
          entries.set(cacheKey(request), response);
        }),
      };
      stores.set(name, cache);
    }
    return cache;
  }

  const api = {
    open: vi.fn(async (name: string) => cacheFor(name)),
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
  };

  return { api, cacheFor, stores };
}

interface WorkerHarnessOptions {
  buildHash?: string;
  cacheStorage?: ReturnType<typeof cacheStorageHarness>;
  fetchImplementation?: (request: unknown, init?: unknown) => unknown | Promise<unknown>;
}

function workerHarness(options: WorkerHarnessOptions = {}) {
  const buildHash = options.buildHash ?? 'current-build';
  const listeners = new Map<string, WorkerHandler>();
  const cacheStorage = options.cacheStorage ?? cacheStorageHarness();
  const cache = cacheStorage.cacheFor(`bettertrack-pwa-${buildHash}`);
  const defaultNetworkResponse = {
    clone: () => ({ source: 'network-clone' }),
    ok: true,
    status: 200,
    type: 'basic',
  };
  const fetchRequest = vi.fn(
    options.fetchImplementation ?? (async (): Promise<unknown> => defaultNetworkResponse),
  );
  const showNotification = vi.fn(async () => undefined);
  const skipWaiting = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const matchAll = vi.fn(async (): Promise<unknown[]> => []);
  const openWindow = vi.fn(async () => undefined);
  const workerSelf = {
    location: { origin: 'https://bettertrack.test' },
    registration: { showNotification },
    clients: { claim, matchAll, openWindow },
    skipWaiting,
    addEventListener(type: string, handler: WorkerHandler) {
      listeners.set(type, handler);
    },
  };

  class TestResponse {
    constructor(
      readonly body: string,
      readonly init: Record<string, unknown>,
    ) {}
  }

  runInNewContext(workerSource.replaceAll(BUILD_HASH_TOKEN, buildHash), {
    self: workerSelf,
    caches: cacheStorage.api,
    fetch: fetchRequest,
    URL,
    Response: TestResponse,
  });

  function handler(type: string): WorkerHandler {
    const registered = listeners.get(type);
    if (!registered) throw new Error(`Missing ${type} worker handler`);
    return registered;
  }

  return {
    cache,
    cacheStorage: cacheStorage.api,
    claim,
    fetchRequest,
    handler,
    matchAll,
    openWindow,
    showNotification,
    skipWaiting,
  };
}

function responsePromise(respondWith: ReturnType<typeof vi.fn>): Promise<unknown> {
  const response = respondWith.mock.calls[0]?.[0];
  if (
    !response ||
    typeof response !== 'object' ||
    !('then' in response) ||
    typeof response.then !== 'function'
  ) {
    throw new Error('Worker did not provide a response promise');
  }
  return Promise.resolve(response);
}

describe('unified app service worker', () => {
  it.each(['/api', '/api/portfolios', '/api/portfolios?limit=10'])(
    'leaves %s entirely outside service-worker fetch handling',
    (path) => {
      const { cacheStorage, fetchRequest, handler } = workerHarness();
      const respondWith = vi.fn();

      handler('fetch')({
        request: {
          method: 'GET',
          mode: 'navigate',
          url: `https://bettertrack.test${path}`,
        },
        respondWith,
      });

      expect(respondWith).not.toHaveBeenCalled();
      expect(fetchRequest).not.toHaveBeenCalled();
      expect(cacheStorage.open).not.toHaveBeenCalled();
    },
  );

  it('uses cache-first only for hashed same-origin build assets', async () => {
    const { cache, fetchRequest, handler } = workerHarness();
    const clone = {};
    const networkResponse = {
      clone: vi.fn(() => clone),
      ok: true,
      type: 'basic',
    };
    fetchRequest.mockResolvedValue(networkResponse);
    const request = {
      method: 'GET',
      mode: 'cors',
      url: 'https://bettertrack.test/assets/index-AbCdEf12.js',
    };
    const respondWith = vi.fn();

    handler('fetch')({ request, respondWith });

    await expect(responsePromise(respondWith)).resolves.toBe(networkResponse);
    expect(cache.match).toHaveBeenCalledWith(request);
    expect(cache.put).toHaveBeenCalledWith(request, clone);
  });

  it('serves the branded fallback when a navigation loses the network', async () => {
    const { cache, fetchRequest, handler } = workerHarness();
    const offlineResponse = { source: 'offline-shell' };
    fetchRequest.mockRejectedValue(new Error('network unavailable'));
    cache.entries.set('/offline.html', offlineResponse);
    const respondWith = vi.fn();

    handler('fetch')({
      request: {
        method: 'GET',
        mode: 'navigate',
        url: 'https://bettertrack.test/portfolio',
      },
      respondWith,
    });

    await expect(responsePromise(respondWith)).resolves.toBe(offlineResponse);
    expect(offlineSource).toContain('Better<span>Track</span>');
    expect(offlineSource).toContain('Verbinde dich erneut');
  });

  it('installs the fallback, activates immediately, and claims open clients', async () => {
    const { cache, claim, fetchRequest, handler, skipWaiting } = workerHarness();
    const installWaitUntil = vi.fn();
    handler('install')({ waitUntil: installWaitUntil });
    await expect(responsePromise(installWaitUntil)).resolves.toEqual([undefined, undefined]);
    expect(fetchRequest).toHaveBeenCalledWith('/offline.html', { cache: 'reload' });
    expect(cache.put).toHaveBeenCalledWith('/offline.html', expect.objectContaining({ ok: true }));
    expect(skipWaiting).toHaveBeenCalledOnce();

    const activateWaitUntil = vi.fn();
    handler('activate')({ waitUntil: activateWaitUntil });
    await responsePromise(activateWaitUntil);
    expect(claim).toHaveBeenCalledOnce();
  });

  it('reclaims prior-deploy bundles and installs the edited offline shell', async () => {
    const sharedCacheStorage = cacheStorageHarness();
    const oldOffline = { body: 'offline-v1', ok: true, status: 200 };
    const newOffline = { body: 'offline-v2', ok: true, status: 200 };
    const oldAssetUrl = 'https://bettertrack.test/assets/index-OldHash12.js';
    const newAssetUrl = 'https://bettertrack.test/assets/index-NewHash34.js';
    const assetResponse = (deployment: string) => ({
      clone: () => ({ deployment }),
      ok: true,
      status: 200,
      type: 'basic',
    });

    const first = workerHarness({
      buildHash: 'deploy-one',
      cacheStorage: sharedCacheStorage,
      fetchImplementation: async (request) =>
        request === '/offline.html' ? oldOffline : assetResponse('one'),
    });
    const firstInstall = vi.fn();
    first.handler('install')({ waitUntil: firstInstall });
    await responsePromise(firstInstall);
    const firstAssetResponse = vi.fn();
    first.handler('fetch')({
      request: { method: 'GET', mode: 'cors', url: oldAssetUrl },
      respondWith: firstAssetResponse,
    });
    await responsePromise(firstAssetResponse);

    const second = workerHarness({
      buildHash: 'deploy-two',
      cacheStorage: sharedCacheStorage,
      fetchImplementation: async (request) =>
        request === '/offline.html' ? newOffline : assetResponse('two'),
    });
    const secondInstall = vi.fn();
    second.handler('install')({ waitUntil: secondInstall });
    await responsePromise(secondInstall);
    const secondActivate = vi.fn();
    second.handler('activate')({ waitUntil: secondActivate });
    await responsePromise(secondActivate);
    const secondAssetResponse = vi.fn();
    second.handler('fetch')({
      request: { method: 'GET', mode: 'cors', url: newAssetUrl },
      respondWith: secondAssetResponse,
    });
    await responsePromise(secondAssetResponse);

    expect([...sharedCacheStorage.stores.keys()]).toEqual(['bettertrack-pwa-deploy-two']);
    const currentEntries = sharedCacheStorage.cacheFor('bettertrack-pwa-deploy-two').entries;
    expect(currentEntries.has(oldAssetUrl)).toBe(false);
    expect(currentEntries.has(newAssetUrl)).toBe(true);

    second.fetchRequest.mockRejectedValueOnce(new Error('network unavailable'));
    const offlineNavigation = vi.fn();
    second.handler('fetch')({
      request: {
        method: 'GET',
        mode: 'navigate',
        url: 'https://bettertrack.test/portfolio',
      },
      respondWith: offlineNavigation,
    });
    await expect(responsePromise(offlineNavigation)).resolves.toBe(newOffline);
  });

  it('preserves the existing FCM data-message notification behavior', async () => {
    const { handler, showNotification } = workerHarness();
    const payload = {
      body: 'Price threshold reached',
      data: { assetId: 'asset-1' },
      title: 'BetterTrack alert',
      type: 'alert.triggered',
    };
    const waitUntil = vi.fn();

    handler('push')({
      data: { json: () => payload, text: () => '' },
      waitUntil,
    });

    await responsePromise(waitUntil);
    expect(showNotification).toHaveBeenCalledWith('BetterTrack alert', {
      badge: '/BT_AppIcon.png',
      body: 'Price threshold reached',
      data: payload,
      icon: '/BT_AppIcon.png',
      tag: 'alert.triggered',
    });
  });

  it('preserves notification deep links in the unified worker', async () => {
    const { handler, matchAll } = workerHarness();
    const navigate = vi.fn();
    const focus = vi.fn(async () => undefined);
    matchAll.mockResolvedValue([{ focus, navigate }]);
    const close = vi.fn();
    const waitUntil = vi.fn();

    handler('notificationclick')({
      notification: {
        close,
        data: { data: { assetId: 'asset-1' }, type: 'alert.triggered' },
      },
      waitUntil,
    });

    await responsePromise(waitUntil);
    expect(close).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/assets/asset-1');
    expect(focus).toHaveBeenCalledOnce();
  });
});
