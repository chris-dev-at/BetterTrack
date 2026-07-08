import type { AssetRef, CachedResult } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { cacheKey, freshCacheKey, negativeCacheKey } from '../cache';
import { CircuitOpenError } from '../circuitBreaker';
import { AssetNotFoundError } from '../errors';
import {
  createMarketDataService,
  defaultIntervalForRange,
  normalizeSearchQuery,
} from '../marketDataService';
import { createProviderRegistry } from '../registry';

import {
  createDeferred,
  createFakeProvider,
  sampleHistory,
  sampleMeta,
  sampleQuote,
  type FakeProvider,
} from './fakeProvider';

const REF: AssetRef = { providerId: 'fake', providerRef: 'ACME' };

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  // ioredis-mock shares one in-memory store across instances; isolate each test.
  await redis.flushall();
});

function serviceWith(provider = createFakeProvider('fake')) {
  const registry = createProviderRegistry([provider]);
  const service = createMarketDataService({ registry, redis });
  return { provider, service };
}

describe('defaultIntervalForRange (§5.3)', () => {
  it.each([
    ['1D', '1m'],
    ['1W', '15m'],
    ['1M', '30m'],
    ['6M', '1d'],
    ['1Y', '1d'],
    ['5Y', '1wk'],
    ['MAX', '1mo'],
  ] as const)('maps %s → %s', (range, interval) => {
    expect(defaultIntervalForRange(range)).toBe(interval);
  });
});

describe('MarketDataService caching per method (hit/miss/coalesce)', () => {
  type Case = {
    name: string;
    call: (s: ReturnType<typeof serviceWith>['service']) => Promise<CachedResult<unknown>>;
    counter: 'quote' | 'history' | 'meta';
    key: string;
  };

  const cases: Case[] = [
    {
      name: 'getQuote',
      call: (s) => s.getQuote(REF),
      counter: 'quote',
      key: cacheKey('fake', 'ACME', 'quote', 'spot'),
    },
    {
      name: 'getHistory',
      call: (s) => s.getHistory(REF, '1Y'),
      counter: 'history',
      key: cacheKey('fake', 'ACME', 'history', '1Y@1d'),
    },
    {
      name: 'getMeta',
      call: (s) => s.getMeta(REF),
      counter: 'meta',
      key: cacheKey('fake', 'ACME', 'meta', 'default'),
    },
  ];

  it.each(cases)(
    '$name: miss loads, hit reuses, value is fresh',
    async ({ call, counter, key }) => {
      const { provider, service } = serviceWith();

      const miss = await call(service);
      expect(miss.stale).toBe(false);
      expect(provider.calls[counter]).toBe(1);
      expect(await redis.get(freshCacheKey(key))).not.toBeNull();

      const hit = await call(service);
      expect(hit.stale).toBe(false);
      expect(provider.calls[counter]).toBe(1); // served from cache
    },
  );

  it.each(cases)(
    '$name: concurrent misses coalesce to one upstream call',
    async ({ call, counter }) => {
      const deferred = createDeferred<unknown>();
      const provider = createFakeProvider('fake', {
        quote: () => deferred.promise as Promise<ReturnType<typeof sampleQuote>>,
        history: () => deferred.promise as Promise<ReturnType<typeof sampleHistory>>,
        meta: () => deferred.promise as Promise<ReturnType<typeof sampleMeta>>,
      });
      const { service } = serviceWith(provider);

      const inflight = [call(service), call(service), call(service)];
      deferred.resolve(
        counter === 'quote'
          ? sampleQuote()
          : counter === 'history'
            ? sampleHistory()
            : sampleMeta(),
      );
      await Promise.all(inflight);

      expect(provider.calls[counter]).toBe(1);
    },
  );
});

describe('MarketDataService resilience', () => {
  it('retries an upstream call exactly once before succeeding', async () => {
    let attempt = 0;
    const provider = createFakeProvider('fake', {
      quote: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new Error('transient'))
          : Promise.resolve(sampleQuote({ price: 123 }));
      },
    });
    const { service } = serviceWith(provider);

    const result = await service.getQuote(REF);
    expect(result.value.price).toBe(123);
    expect(provider.calls.quote).toBe(2); // retry-once
  });

  it('serves an expired quote immediately marked stale:true while the refresh fails in the background', async () => {
    let fail = false;
    const provider = createFakeProvider('fake', {
      quote: () =>
        fail ? Promise.reject(new Error('down')) : Promise.resolve(sampleQuote({ price: 200 })),
    });
    const { service } = serviceWith(provider);

    const fresh = await service.getQuote(REF);
    expect(fresh).toMatchObject({ stale: false, value: { price: 200 } });

    // Fresh TTL expires; upstream now down.
    await redis.del(freshCacheKey(cacheKey('fake', 'ACME', 'quote', 'spot')));
    fail = true;

    const stale = await service.getQuote(REF);
    expect(stale).toMatchObject({ stale: true, value: { price: 200 } });
    await service.settled(); // the failed background refresh never surfaces
  });

  it('serves the fresh value once the background refresh of an expired entry lands', async () => {
    let price = 200;
    const provider = createFakeProvider('fake', {
      quote: () => Promise.resolve(sampleQuote({ price })),
    });
    const { service } = serviceWith(provider);

    await service.getQuote(REF);
    await redis.del(freshCacheKey(cacheKey('fake', 'ACME', 'quote', 'spot')));
    price = 210;

    // Expired: old value served immediately, marked stale (§5.3).
    const stale = await service.getQuote(REF);
    expect(stale).toMatchObject({ stale: true, value: { price: 200 } });

    await service.settled();
    const refreshed = await service.getQuote(REF);
    expect(refreshed).toMatchObject({ stale: false, value: { price: 210 } });
    expect(provider.calls.quote).toBe(2); // initial + exactly one background refresh
  });

  it('opens the circuit breaker and fails fast after repeated failures', async () => {
    const provider = createFakeProvider('fake', {
      quote: () => Promise.reject(new Error('upstream down')),
    });
    const registry = createProviderRegistry([provider]);
    const service = createMarketDataService({
      registry,
      redis,
      options: { breaker: { failureThreshold: 1, openMs: 30_000 } },
    });

    // First call: both retry attempts fail → trips the breaker open.
    await expect(service.getQuote(REF)).rejects.toThrowError('upstream down');
    expect(provider.calls.quote).toBe(2);

    // Breaker now open → fails fast, the provider is not called again.
    await expect(service.getQuote(REF)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(provider.calls.quote).toBe(2);
  });
});

describe('MarketDataService — upstream 429 (§5.3)', () => {
  const rateLimited = () =>
    Promise.reject(Object.assign(new Error('HTTP 429'), { code: 429 })) as Promise<
      ReturnType<typeof sampleQuote>
    >;

  it('opens the breaker on a 429 and stretches TTLs: stale data served, no more upstream calls, never a 5xx', async () => {
    let limited = false;
    const provider = createFakeProvider('fake', {
      quote: () => (limited ? rateLimited() : Promise.resolve(sampleQuote({ price: 200 }))),
    });
    const { service } = serviceWith(provider);

    await service.getQuote(REF); // warm the cache (1 call)
    await redis.del(freshCacheKey(cacheKey('fake', 'ACME', 'quote', 'spot')));
    limited = true;

    // Expired entry: stale served immediately; the background refresh hits the
    // 429 exactly once (definitive — never retried) and trips the breaker.
    const first = await service.getQuote(REF);
    expect(first).toMatchObject({ stale: true, value: { price: 200 } });
    await service.settled();
    expect(provider.calls.quote).toBe(2);

    // Breaker open → TTL stretch: stale keeps being served with zero upstream
    // attempts and no error reaches the caller.
    const second = await service.getQuote(REF);
    expect(second).toMatchObject({ stale: true, value: { price: 200 } });
    await service.settled();
    expect(provider.calls.quote).toBe(2);
  });
});

describe('MarketDataService — negative caching (§5.3)', () => {
  it('negative-caches an unknown symbol; repeated lookups make no further upstream calls', async () => {
    const provider = createFakeProvider('fake', {
      quote: () => Promise.reject(new AssetNotFoundError('unknown symbol "ACME"')),
    });
    const { service } = serviceWith(provider);

    await expect(service.getQuote(REF)).rejects.toBeInstanceOf(AssetNotFoundError);
    expect(provider.calls.quote).toBe(1); // a definitive not-found is never retried

    const negTtl = await redis.ttl(negativeCacheKey(cacheKey('fake', 'ACME', 'quote', 'spot')));
    expect(negTtl).toBeGreaterThan(0);
    expect(negTtl).toBeLessThanOrEqual(15 * 60);

    // Within the window: same answer, zero upstream calls.
    await expect(service.getQuote(REF)).rejects.toMatchObject({
      name: 'AssetNotFoundError',
      fromNegativeCache: true,
    });
    expect(provider.calls.quote).toBe(1);
  });
});

describe('MarketDataService — local providers', () => {
  it('bypasses the TTL cache so a manual asset edit is visible immediately', async () => {
    let price = 100;
    const provider: FakeProvider = {
      ...createFakeProvider('fake', { quote: () => Promise.resolve(sampleQuote({ price })) }),
      local: true,
    };
    const { service } = serviceWith(provider);

    const first = await service.getQuote(REF);
    expect(first).toMatchObject({ stale: false, value: { price: 100 } });

    price = 110; // the user edits a value point
    const second = await service.getQuote(REF);
    expect(second).toMatchObject({ stale: false, value: { price: 110 } });
    expect(provider.calls.quote).toBe(2); // no 60 s TTL between reads
  });
});

describe('MarketDataService.search', () => {
  it('fans out across providers and merges results, skipping failing ones', async () => {
    const good = createFakeProvider('yahoo', {
      search: () =>
        Promise.resolve([
          {
            providerId: 'yahoo',
            providerRef: 'BAYN.DE',
            symbol: 'BAYN',
            name: 'Bayer',
            exchange: 'XETRA',
            type: 'stock',
            currency: 'EUR',
          },
        ]),
    });
    const bad = createFakeProvider('flaky', {
      search: () => Promise.reject(new Error('down')),
    });
    const registry = createProviderRegistry([good, bad]);
    const service = createMarketDataService({
      registry,
      redis,
      // No retry padding noise: breaker defaults are fine, one failure is tolerated.
      options: { timeoutMs: 1_000 },
    });

    const results = await service.search('bay');
    expect(results).toHaveLength(1);
    expect(results[0]?.symbol).toBe('BAYN');
  });

  it('normalizes queries to one canonical cache key (§5.3)', () => {
    expect(normalizeSearchQuery('  Bayer   AG ')).toBe('bayer ag');
  });

  it('caches provider search results by normalized query (§5.3, 24 h)', async () => {
    const { provider, service } = serviceWith();

    const first = await service.search('  Bayer   AG ');
    const second = await service.search('bayer ag'); // same normalized query
    expect(provider.calls.search).toBe(1); // served from the 24 h cache
    expect(second).toEqual(first);

    await service.search('siemens');
    expect(provider.calls.search).toBe(2); // a different query does go upstream
  });

  it('returns [] for a blank query without touching providers or cache', async () => {
    const { provider, service } = serviceWith();
    await expect(service.search('   ')).resolves.toEqual([]);
    expect(provider.calls.search).toBe(0);
  });

  it('does not cache local providers’ search results', async () => {
    const provider: FakeProvider = { ...createFakeProvider('fake'), local: true };
    const { service } = serviceWith(provider);

    await service.search('bay');
    await service.search('bay');
    expect(provider.calls.search).toBe(2); // local search is answered live each time
  });
});

describe('MarketDataService.pollQuote (Live Mode, §6.3 V3-P7b)', () => {
  it('always goes upstream — a fresh cached quote does not satisfy a live poll', async () => {
    const { provider, service } = serviceWith();

    await service.getQuote(REF); // warms the 60 s cache
    expect(provider.calls.quote).toBe(1);

    const polled = await service.pollQuote(REF);
    expect(polled.stale).toBe(false);
    expect(provider.calls.quote).toBe(2); // bypassed the freshness window
  });

  it('primes the regular quote cache: the 60 s path is then served without upstream', async () => {
    const { provider, service } = serviceWith();

    await service.pollQuote(REF);
    expect(provider.calls.quote).toBe(1);
    expect(
      await redis.get(freshCacheKey(cacheKey('fake', 'ACME', 'quote', 'spot'))),
    ).not.toBeNull();

    const viaCache = await service.getQuote(REF);
    expect(viaCache.stale).toBe(false);
    expect(provider.calls.quote).toBe(1); // rode the primed entry
  });

  it('a 429 trips the shared breaker; further polls throw CircuitOpenError with zero upstream calls', async () => {
    const provider = createFakeProvider('fake', {
      quote: () =>
        Promise.reject(Object.assign(new Error('HTTP 429'), { code: 429 })) as Promise<
          ReturnType<typeof sampleQuote>
        >,
    });
    const { service } = serviceWith(provider);

    await expect(service.pollQuote(REF)).rejects.toMatchObject({ code: 429 });
    expect(provider.calls.quote).toBe(1); // definitive — never retried

    await expect(service.pollQuote(REF)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(provider.calls.quote).toBe(1); // breaker open: no upstream attempt
  });

  it('serves local providers live with no cache involvement', async () => {
    const provider: FakeProvider = { ...createFakeProvider('fake'), local: true };
    const { service } = serviceWith(provider);

    await service.pollQuote(REF);
    await service.pollQuote(REF);
    expect(provider.calls.quote).toBe(2); // answered live each time
    expect(await redis.get(freshCacheKey(cacheKey('fake', 'ACME', 'quote', 'spot')))).toBeNull();
  });
});
