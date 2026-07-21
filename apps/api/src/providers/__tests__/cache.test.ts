import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  cacheKey,
  createMarketCache,
  freshCacheKey,
  loadLockKey,
  negativeCacheKey,
  staleCacheKey,
} from '../cache';
import { AssetNotFoundError } from '../errors';

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

describe('MarketCache.getOrLoad — hit/miss/coalesce', () => {
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

describe('MarketCache — serve-stale-while-revalidate (§5.3)', () => {
  it('serves an expired entry immediately marked stale while ONE background refresh runs', async () => {
    const cache = createMarketCache(redis);
    let calls = 0;
    await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => {
        calls += 1;
        return Promise.resolve({ price: 100 });
      },
    });

    // Simulate the fresh TTL expiring while the long-lived stale copy remains.
    await redis.del(freshCacheKey(KEY));

    const deferred = createDeferred<{ price: number }>();
    const slowLoader = () => {
      calls += 1;
      return deferred.promise;
    };

    // Three concurrent requests on the expired entry: all get the stale copy
    // immediately (no thundering herd), exactly one refresh goes upstream.
    const results = await Promise.all([
      cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader: slowLoader }),
      cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader: slowLoader }),
      cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader: slowLoader }),
    ]);
    for (const r of results) {
      expect(r).toMatchObject({ value: { price: 100 }, stale: true });
    }

    deferred.resolve({ price: 105 });
    await cache.settled();
    expect(calls).toBe(2); // initial load + exactly one background refresh

    // The refresh repopulated the fresh copy: next read is fresh, no load.
    const after = await cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader: slowLoader });
    expect(after).toMatchObject({ value: { price: 105 }, stale: false });
    expect(calls).toBe(2);
  });

  it('keeps serving stale (never errors) when the background refresh fails', async () => {
    const cache = createMarketCache(redis);
    await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => Promise.resolve({ price: 100 }),
    });
    await redis.del(freshCacheKey(KEY));

    const result = await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => Promise.reject(new Error('upstream down')),
    });
    expect(result).toMatchObject({ value: { price: 100 }, stale: true });

    // The failed refresh is swallowed; the stale copy is still served.
    await cache.settled();
    const again = await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => Promise.reject(new Error('upstream down')),
    });
    expect(again).toMatchObject({ value: { price: 100 }, stale: true });
    await cache.settled();
  });

  it('skips revalidation entirely while shouldRevalidate is false (TTL stretch)', async () => {
    const cache = createMarketCache(redis);
    let calls = 0;
    const loader = () => {
      calls += 1;
      return Promise.resolve({ price: calls });
    };
    await cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader });
    await redis.del(freshCacheKey(KEY));

    const result = await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader,
      shouldRevalidate: () => false,
    });
    await cache.settled();

    expect(result).toMatchObject({ value: { price: 1 }, stale: true });
    expect(calls).toBe(1); // no upstream attempt at all while the gate is closed
  });
});

describe('MarketCache — negative caching (§5.3)', () => {
  const isNotFound = (err: unknown) => err instanceof AssetNotFoundError;

  it('caches a not-found answer; repeated lookups make no further upstream calls', async () => {
    const cache = createMarketCache(redis);
    let calls = 0;
    const loader = () => {
      calls += 1;
      return Promise.reject(new AssetNotFoundError('unknown symbol "NOPE"'));
    };

    await expect(
      cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader, isNotFound }),
    ).rejects.toThrowError('unknown symbol "NOPE"');
    expect(calls).toBe(1);

    // The negative entry is in Redis with the §5.3 ~15 min window.
    const negTtl = await redis.ttl(negativeCacheKey(KEY));
    expect(negTtl).toBeGreaterThan(0);
    expect(negTtl).toBeLessThanOrEqual(15 * 60);

    // Within the window: same error, zero upstream calls.
    await expect(
      cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader, isNotFound }),
    ).rejects.toMatchObject({ name: 'AssetNotFoundError', fromNegativeCache: true });
    expect(calls).toBe(1);

    // Window over (entry dropped): the loader is consulted again.
    await redis.del(negativeCacheKey(KEY));
    await expect(
      cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader, isNotFound }),
    ).rejects.toThrowError();
    expect(calls).toBe(2);
  });

  it('does not negative-cache transient failures', async () => {
    const cache = createMarketCache(redis);
    let calls = 0;
    const loader = () => {
      calls += 1;
      return Promise.reject(new Error('timeout'));
    };

    await expect(
      cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader, isNotFound }),
    ).rejects.toThrowError('timeout');
    expect(await redis.exists(negativeCacheKey(KEY))).toBe(0);

    await expect(
      cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader, isNotFound }),
    ).rejects.toThrowError('timeout');
    expect(calls).toBe(2); // retried — transient errors must not stick
  });

  it('blocks background revalidation while a negative window is live', async () => {
    const cache = createMarketCache(redis);
    let calls = 0;
    const loader = () => {
      calls += 1;
      return Promise.resolve({ price: 1 });
    };
    await cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader });
    await redis.del(freshCacheKey(KEY));
    // A delisting: upstream said "gone" recently, stale copy still retained.
    await redis.set(negativeCacheKey(KEY), JSON.stringify({ message: 'gone', asOf: 1 }), 'EX', 900);

    const result = await cache.getOrLoad({ key: KEY, ttlSeconds: 60, loader });
    await cache.settled();

    expect(result).toMatchObject({ value: { price: 1 }, stale: true });
    expect(calls).toBe(1); // the negative window suppressed the refresh
  });
});

describe('MarketCache — cross-process coalescing (§5.3 Redis lock)', () => {
  it('a second process awaiting the same cold miss reuses the winner’s result', async () => {
    // Two cache instances over the shared mock store = two processes.
    const winner = createMarketCache(redis, { pollIntervalMs: 5 });
    const loser = createMarketCache(redis, { pollIntervalMs: 5 });

    const deferred = createDeferred<{ price: number }>();
    let winnerCalls = 0;
    let loserCalls = 0;

    const winnerResult = winner.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => {
        winnerCalls += 1;
        return deferred.promise;
      },
    });
    // Give the winner a beat to take the Redis lock before the loser arrives.
    await new Promise((r) => setTimeout(r, 5));
    expect(await redis.exists(loadLockKey(KEY))).toBe(1);

    const loserResult = loser.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => {
        loserCalls += 1;
        return Promise.resolve({ price: -1 });
      },
    });

    deferred.resolve({ price: 42 });
    expect(await winnerResult).toMatchObject({ value: { price: 42 }, stale: false });
    expect(await loserResult).toMatchObject({ value: { price: 42 }, stale: false });
    expect(winnerCalls).toBe(1);
    expect(loserCalls).toBe(0); // exactly one upstream fetch across both processes
  });

  it('a lock loser falls back to loading itself when the winner never produces a result', async () => {
    const cache = createMarketCache(redis, { lockTtlMs: 60, pollIntervalMs: 10 });
    // A dead process left a lock behind and will never write a value.
    await redis.set(loadLockKey(KEY), 'stale-lock-of-dead-process', 'PX', 10_000);

    let calls = 0;
    const result = await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => {
        calls += 1;
        return Promise.resolve({ price: 9 });
      },
    });

    expect(result).toMatchObject({ value: { price: 9 }, stale: false });
    expect(calls).toBe(1); // progress guaranteed despite the stuck lock
  });
});

describe('MarketCache — corrupt payload resilience (degrades, never a 5xx)', () => {
  it('treats a non-JSON fresh entry as a miss, reloads, and never throws', async () => {
    const cache = createMarketCache(redis);
    // A truncated/garbage Redis value must not surface as a server error.
    await redis.set(freshCacheKey(KEY), 'not-json{');

    let calls = 0;
    const result = await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => {
        calls += 1;
        return Promise.resolve({ price: 5 });
      },
    });
    expect(result).toMatchObject({ value: { price: 5 }, stale: false });
    expect(calls).toBe(1);

    // The fresh load overwrote the corrupt entry: the next read is a clean hit.
    const after = await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => {
        calls += 1;
        return Promise.resolve({ price: 9 });
      },
    });
    expect(after.value).toEqual({ price: 5 });
    expect(calls).toBe(1);
  });

  it('treats a JSON entry missing the required fields as a miss', async () => {
    const cache = createMarketCache(redis);
    // Valid JSON but not a StoredEntry (no `asOf`) — must not be served.
    await redis.set(freshCacheKey(KEY), JSON.stringify({ value: { price: 1 } }));

    let calls = 0;
    const result = await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => {
        calls += 1;
        return Promise.resolve({ price: 7 });
      },
    });
    expect(result.value).toEqual({ price: 7 });
    expect(calls).toBe(1);
  });
});

describe('MarketCache.prime (Live Mode, §6.3 V3-P7b)', () => {
  it('writes fresh + stale and clears any pre-existing negative entry', async () => {
    const cache = createMarketCache(redis);
    // A stale negative window from an earlier miss.
    await redis.set(negativeCacheKey(KEY), JSON.stringify({ message: 'gone', asOf: 1 }), 'EX', 900);

    const primed = await cache.prime({ key: KEY, ttlSeconds: 60 }, { price: 3 });
    expect(primed).toMatchObject({ value: { price: 3 }, stale: false });
    expect(typeof primed.asOf).toBe('number');

    // The negative answer is superseded by the primed value.
    expect(await redis.exists(negativeCacheKey(KEY))).toBe(0);
    const freshTtl = await redis.ttl(freshCacheKey(KEY));
    const staleTtl = await redis.ttl(staleCacheKey(KEY));
    expect(freshTtl).toBeGreaterThan(0);
    expect(staleTtl).toBeGreaterThan(freshTtl);

    // A subsequent read rides the primed entry — no loader call at all.
    let calls = 0;
    const hit = await cache.getOrLoad({
      key: KEY,
      ttlSeconds: 60,
      loader: () => {
        calls += 1;
        return Promise.resolve({ price: 99 });
      },
    });
    expect(hit).toMatchObject({ value: { price: 3 }, stale: false });
    expect(calls).toBe(0);
  });
});
