import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const workerSource = readFileSync(resolve(process.cwd(), 'public/service-worker.js'), 'utf8');
const offlineSource = readFileSync(resolve(process.cwd(), 'public/offline.html'), 'utf8');

type WorkerHandler = (event: Record<string, unknown>) => void;

function workerHarness() {
  const listeners = new Map<string, WorkerHandler>();
  const cache = {
    add: vi.fn(async () => undefined),
    match: vi.fn(async (_request: unknown): Promise<unknown> => undefined),
    put: vi.fn(async () => undefined),
  };
  const cacheStorage = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => [] as string[]),
    delete: vi.fn(async () => true),
  };
  const fetchRequest = vi.fn(async (): Promise<unknown> => undefined);
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

  runInNewContext(workerSource, {
    self: workerSelf,
    caches: cacheStorage,
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
    cacheStorage,
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
    cache.match.mockImplementation(async (request: unknown) =>
      request === '/offline.html' ? offlineResponse : undefined,
    );
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
    const { cache, claim, handler, skipWaiting } = workerHarness();
    const installWaitUntil = vi.fn();
    handler('install')({ waitUntil: installWaitUntil });
    await expect(responsePromise(installWaitUntil)).resolves.toEqual([undefined, undefined]);
    expect(cache.add).toHaveBeenCalledWith('/offline.html');
    expect(skipWaiting).toHaveBeenCalledOnce();

    const activateWaitUntil = vi.fn();
    handler('activate')({ waitUntil: activateWaitUntil });
    await responsePromise(activateWaitUntil);
    expect(claim).toHaveBeenCalledOnce();
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
