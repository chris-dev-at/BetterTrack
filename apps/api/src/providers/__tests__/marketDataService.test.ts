import type { AssetRef, CachedResult } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { cacheKey, freshCacheKey } from '../cache';
import { CircuitOpenError } from '../circuitBreaker';
import { createMarketDataService, defaultIntervalForRange } from '../marketDataService';
import { createProviderRegistry } from '../registry';

import {
  createDeferred,
  createFakeProvider,
  sampleHistory,
  sampleMeta,
  sampleQuote,
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

  it('serves a stale quote marked stale:true when the upstream later fails', async () => {
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
});
