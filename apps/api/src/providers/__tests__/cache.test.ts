import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { cacheKey, createMarketCache, freshCacheKey, staleCacheKey } from '../cache';

import { createDeferred } from './fakeProvider';

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  // ioredis-mock shares one in-memory store across instances; isolate each test.
  await redis.flushall();
});

const KEY = cacheKey('yahoo', 'BAYN.DE', 'quote', 'spot');

describe('cacheKey', () => {
  it('follows the {providerId}:{providerRef}:{kind}:{variant} format (§5.3)', () => {
    expect(cacheKey('yahoo', 'BAYN.DE', 'history', '1Y@1d')).toBe('yahoo:BAYN.DE:history:1Y@1d');
  });
});

describe('MarketCache.getOrLoad', () => {
  it('loads on a miss, then serves a cached hit without calling the loader again', async () => {
    const cache = createMarketCache(redis);
    let calls = 0;
    const loader = () => {
      calls += 1;
      return Promise.resolve({ price: calls });
    };

    const miss = await cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader });
    expect(miss).toMatchObject({ value: { price: 1 }, stale: false });
    expect(typeof miss.asOf).toBe('number');

    const hit = await cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader });
    expect(hit).toMatchObject({ value: { price: 1 }, stale: false });
    expect(calls).toBe(1); // served from cache, no second load
  });

  it('coalesces concurrent misses into a single loader call', async () => {
    const cache = createMarketCache(redis);
    const deferred = createDeferred<{ price: number }>();
    let calls = 0;
    const loader = () => {
      calls += 1;
      return deferred.promise;
    };

    const inflight = [
      cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader }),
      cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader }),
      cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader }),
    ];
    deferred.resolve({ price: 7 });
    const results = await Promise.all(inflight);

    expect(calls).toBe(1); // exactly one upstream fetch for three concurrent misses
    for (const r of results) {
      expect(r).toMatchObject({ value: { price: 7 }, stale: false });
    }

    // Once settled the inflight slot is cleared and the cached value is reused.
    const after = await cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader });
    expect(after.value).toEqual({ price: 7 });
    expect(calls).toBe(1);
  });

  it('serves the stale copy marked stale:true when the loader fails after expiry', async () => {
    const cache = createMarketCache(redis);

    await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => Promise.resolve({ price: 100 }),
    });

    // Simulate the fresh TTL expiring while the long-lived stale copy remains.
    await redis.del(freshCacheKey(KEY));
    expect(await redis.get(staleCacheKey(KEY))).not.toBeNull();

    const result = await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => Promise.reject(new Error('upstream down')),
    });

    expect(result).toMatchObject({ value: { price: 100 }, stale: true });
  });

  it('propagates the error when the loader fails and there is no stale copy', async () => {
    const cache = createMarketCache(redis);
    await expect(
      cache.getOrLoad({
        key: KEY,
        ttlSeconds: 60,
        loader: () => Promise.reject(new Error('cold cache, upstream down')),
      }),
    ).rejects.toThrowError('cold cache, upstream down');
  });

  it('honours the §5.3 fresh TTL and a longer stale retention', async () => {
    const cache = createMarketCache(redis);
    await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      staleTtlSeconds: 3_600,
      loader: () => Promise.resolve({ price: 1 }),
    });

    const freshTtl = await redis.ttl(freshCacheKey(KEY));
    const staleTtl = await redis.ttl(staleCacheKey(KEY));
    expect(freshTtl).toBeGreaterThan(0);
    expect(freshTtl).toBeLessThanOrEqual(60);
    expect(staleTtl).toBeGreaterThan(freshTtl);
  });
});
