import type { AssetRef, CachedResult } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { cacheKey, freshCacheKey, negativeCacheKey, staleCacheKey } from '../cache';
import { CircuitOpenError } from '../circuitBreaker';
import { AssetNotFoundError } from '../errors';
import {
  createMarketDataService,
  defaultIntervalForRange,
  normalizeSearchQuery,
} from '../marketDataService';
import { createProviderRegistry } from '../registry';
import type { StooqClient } from '../stooqClient';
import { createStooqProvider } from '../stooqProvider';

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

describe('MarketDataService — history freshness is a function of range alone (§5.3)', () => {
  // The interval picks the cache *key* (each candle density gets its own entry);
  // it must never move the *window*. Overriding the interval is not a
  // workboard-only concern: `portfolioSnapshots` and `marketDataFxSource` both
  // ask for an explicit `1d` at ranges starting at `1M`, so widening the window
  // for daily candles would silently stale the portfolio value series and every
  // non-EUR conversion. Pinned here so it cannot be re-widened incidentally.
  it.each([
    ['1M', '1d', 15 * 60],
    ['1M', '30m', 15 * 60],
    ['1W', '1d', 5 * 60],
    ['MAX', '1d', 6 * 60 * 60],
  ] as const)('keeps %s@%s on its range window of %d s', async (range, interval, expected) => {
    const { service } = serviceWith();

    await service.getHistory(REF, range, interval);

    const ttl = await redis.ttl(
      freshCacheKey(cacheKey('fake', 'ACME', 'history', `${range}@${interval}`)),
    );
    expect(ttl).toBeGreaterThan(expected - 10);
    expect(ttl).toBeLessThanOrEqual(expected);
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

    expect(service.isLocalProvider(REF)).toBe(true);
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

describe('MarketDataService — provider failover (§13.5 V5-P1c)', () => {
  const QUOTE_KEY = cacheKey('fake', 'ACME', 'quote', 'spot');
  const FAILOVER = { byClass: {}, default: ['backup'] } as const;

  function failoverServiceWith(
    fakeControls: Parameters<typeof createFakeProvider>[1] = {},
    backupControls: Parameters<typeof createFakeProvider>[1] = {},
  ) {
    const primary = createFakeProvider('fake', fakeControls);
    const backup = createFakeProvider('backup', backupControls);
    const registry = createProviderRegistry([primary, backup]);
    const service = createMarketDataService({ registry, redis, options: { failover: FAILOVER } });
    return { primary, backup, service };
  }

  it('primary mocked dead ⇒ quotes keep flowing from the secondary', async () => {
    const { backup, service } = failoverServiceWith(
      { quote: () => Promise.reject(new Error('yahoo down')) },
      { quote: () => Promise.resolve(sampleQuote({ price: 222 })) },
    );

    const result = await service.getQuote(REF);
    expect(result.stale).toBe(false);
    expect(result.value.price).toBe(222); // served by the backup
    expect(backup.calls.quote).toBe(1);
  });

  it('cache key stays the ASSET provider, so a switch reuses the same entry (provider-agnostic)', async () => {
    const { service } = failoverServiceWith(
      { quote: () => Promise.reject(new Error('yahoo down')) },
      { quote: () => Promise.resolve(sampleQuote({ price: 222 })) },
    );

    await service.getQuote(REF);
    // Stored under the asset's own provider key — NOT the serving provider's —
    // so coalescing and serve-stale behave identically whichever source answers.
    expect(await redis.get(freshCacheKey(QUOTE_KEY))).not.toBeNull();
    expect(await redis.get(freshCacheKey(cacheKey('backup', 'ACME', 'quote', 'spot')))).toBeNull();
  });

  it('no double-fetch storm during a switch: concurrent misses coalesce to ONE secondary call', async () => {
    const deferred = createDeferred<ReturnType<typeof sampleQuote>>();
    const { backup, service } = failoverServiceWith(
      { quote: () => Promise.reject(new Error('yahoo down')) },
      { quote: () => deferred.promise },
    );

    const inflight = [service.getQuote(REF), service.getQuote(REF), service.getQuote(REF)];
    deferred.resolve(sampleQuote({ price: 222 }));
    const results = await Promise.all(inflight);

    expect(results.every((r) => r.value.price === 222)).toBe(true);
    expect(backup.calls.quote).toBe(1); // the serving provider fetched exactly once
  });

  it('serve-stale precedence: stale primary served instantly, refreshed in the background by the secondary; then the primary recovers', async () => {
    let primaryUp = true;
    const { service } = failoverServiceWith(
      {
        quote: () =>
          primaryUp
            ? Promise.resolve(sampleQuote({ price: 100 }))
            : Promise.reject(new Error('yahoo down')),
      },
      { quote: () => Promise.resolve(sampleQuote({ price: 222 })) },
    );

    // Warm the cache from the primary, then expire the fresh copy with it down.
    await service.getQuote(REF);
    await redis.del(freshCacheKey(QUOTE_KEY));
    primaryUp = false;

    // Stale-primary is served instantly (fast, no user-facing failover)...
    const stale = await service.getQuote(REF);
    expect(stale).toMatchObject({ stale: true, value: { price: 100 } });
    // ...while the background revalidation fails over to the secondary.
    await service.settled();
    const refreshed = await service.getQuote(REF);
    expect(refreshed).toMatchObject({ stale: false, value: { price: 222 } });

    // Primary recovers: expire again, and the next revalidation returns to it.
    await redis.del(freshCacheKey(QUOTE_KEY));
    primaryUp = true;
    await service.getQuote(REF); // serves stale (222) + background refresh
    await service.settled();
    const recovered = await service.getQuote(REF);
    expect(recovered.value.price).toBe(100); // traffic returned to the primary
  });

  it('surfaces failover attribution + switch events for the admin health surface', async () => {
    const { service } = failoverServiceWith(
      { quote: () => Promise.reject(new Error('yahoo down')) },
      { quote: () => Promise.resolve(sampleQuote({ price: 222 })) },
    );

    await service.getQuote(REF);
    const status = service.failoverStatus();
    expect(status.chains).toEqual([
      expect.objectContaining({ primaryId: 'fake', serving: 'backup' }),
    ]);
    expect(status.switches).toEqual([
      expect.objectContaining({ primaryId: 'fake', from: null, to: 'backup' }),
    ]);
    expect(status.attribution).toEqual([
      expect.objectContaining({ providerId: 'backup', serves: 1 }),
    ]);
  });

  it('regression: with no secondary configured, behaviour is byte-identical (no failover, empty status)', async () => {
    // No `failover` option ⇒ NO_FAILOVER: a primary not-found is negative-cached
    // exactly as today, and there is no attribution/switch to report.
    const provider = createFakeProvider('fake', {
      quote: () => Promise.reject(new AssetNotFoundError('unknown symbol')),
    });
    const { service } = serviceWith(provider);

    await expect(service.getQuote(REF)).rejects.toBeInstanceOf(AssetNotFoundError);
    expect(
      await redis.get(negativeCacheKey(cacheKey('fake', 'ACME', 'quote', 'spot'))),
    ).not.toBeNull();
    expect(service.failoverStatus()).toEqual({ chains: [], switches: [], attribution: [] });
  });

  it('regression: a SUCCESSFUL serve under NO_FAILOVER still reports empty status (no admin chrome)', async () => {
    // The primary actually serves here (unlike the not-found case above, where
    // nothing is attributed): with no secondary configured the failover surface
    // must STILL be empty, so the admin health panel renders no chrome on a
    // single-provider (shipped default) deploy — the anti-bloat invariant.
    const { provider, service } = serviceWith();

    const result = await service.getQuote(REF);
    expect(result.stale).toBe(false);
    expect(provider.calls.quote).toBe(1); // a real serve happened
    expect(service.failoverStatus()).toEqual({ chains: [], switches: [], attribution: [] });
  });
});

describe('MarketDataService — a not-found is breaker-neutral (§13.5 V5-P1c)', () => {
  /**
   * A portfolio holding several delisted tickers (or an import with unmapped
   * symbols) fans out concurrently over the same provider. Those 404s are
   * authoritative answers from a healthy upstream: they must not open the
   * breaker, which would degrade every *other* asset to stale for the cooldown
   * and report a provider outage that never happened.
   */
  it('five unknown symbols leave the breaker closed, and a healthy read still reaches upstream', async () => {
    const opens: unknown[] = [];
    const unknownRefs = ['DELISTED1', 'DELISTED2', 'DELISTED3', 'DELISTED4', 'DELISTED5'] as const;
    let known = false;
    const provider = createFakeProvider('fake', {
      quote: () =>
        known
          ? Promise.resolve(sampleQuote({ price: 42 }))
          : (Promise.reject(
              new AssetNotFoundError('No data found, symbol may be delisted'),
            ) as Promise<ReturnType<typeof sampleQuote>>),
    });
    const registry = createProviderRegistry([provider]);
    const service = createMarketDataService({
      registry,
      redis,
      // The real onOpen is wired to problems.captureProviderFailure (§13.5 V5-P2).
      options: { breaker: { failureThreshold: 5, onOpen: (err) => opens.push(err) } },
    });

    // Five DIFFERENT refs, so the negative cache absorbs none of them.
    for (const providerRef of unknownRefs) {
      await expect(service.getQuote({ providerId: 'fake', providerRef })).rejects.toBeInstanceOf(
        AssetNotFoundError,
      );
    }
    expect(service.breakerStates()).toEqual([{ providerId: 'fake', state: 'closed' }]);
    expect(opens).toEqual([]); // no admin Problems capture for unknown symbols

    // On the SAME service: a healthy ref still goes upstream instead of failing
    // fast with CircuitOpenError.
    known = true;
    expect((await service.getQuote(REF)).value.price).toBe(42);
    expect(provider.calls.quote).toBe(6); // 5 definitive (never retried) + the healthy read

    // The genuine not-founds are still negative-cached (§5.3, unchanged).
    expect(
      await redis.get(negativeCacheKey(cacheKey('fake', unknownRefs[0], 'quote', 'spot'))),
    ).not.toBeNull();
  });

  it('a 429 still trips immediately and five transient errors still open the breaker', async () => {
    const rateLimited = createFakeProvider('fake', {
      quote: () =>
        Promise.reject(Object.assign(new Error('HTTP 429'), { code: 429 })) as Promise<
          ReturnType<typeof sampleQuote>
        >,
    });
    const limitedService = createMarketDataService({
      registry: createProviderRegistry([rateLimited]),
      redis,
    });
    await expect(limitedService.getQuote(REF)).rejects.toThrowError('HTTP 429');
    expect(limitedService.breakerStates()).toEqual([{ providerId: 'fake', state: 'open' }]);

    const flaky = createFakeProvider('flaky', {
      quote: () =>
        Promise.reject(new Error('socket hang up')) as Promise<ReturnType<typeof sampleQuote>>,
    });
    const flakyService = createMarketDataService({
      registry: createProviderRegistry([flaky]),
      redis,
    });
    for (let i = 0; i < 5; i += 1) {
      await expect(
        flakyService.getQuote({ providerId: 'flaky', providerRef: `T${i}` }),
      ).rejects.toThrowError('socket hang up');
    }
    expect(flakyService.breakerStates()).toEqual([{ providerId: 'flaky', state: 'open' }]);
  });
});

describe('MarketDataService — an empty secondary history never poisons the cache (§13.5 V5-P1c)', () => {
  const AAPL: AssetRef = { providerId: 'yahoo', providerRef: 'AAPL' };
  const HISTORY_KEY = cacheKey('yahoo', 'AAPL', 'history', '1Y@1d');

  /** Yahoo blips transiently; Stooq maps the symbol but has no rows for it. */
  function stooqFailoverService() {
    const yahoo = createFakeProvider('yahoo', {
      history: () =>
        Promise.reject(new Error('yahoo history down')) as Promise<
          ReturnType<typeof sampleHistory>
        >,
    });
    const client: StooqClient = {
      quote: async () => ({
        symbol: 'AAPL.US',
        date: '2026-07-16',
        time: '22:00:04',
        close: 209.05,
      }),
      history: async () => [], // Stooq's "No data" body
    };
    const stooq = createStooqProvider({
      client,
      queueOptions: { minSpacingMs: 0 },
      now: () => Date.parse('2026-07-16T23:00:00Z'),
    });
    const registry = createProviderRegistry([yahoo, stooq]);
    const service = createMarketDataService({
      registry,
      redis,
      options: { failover: { byClass: {}, default: ['stooq'] } },
    });
    return { yahoo, service };
  }

  it('rejects with the PRIMARY error, writes no cache keys, and credits Stooq with no serve', async () => {
    const { service } = stooqFailoverService();

    await expect(service.getHistory(AAPL, '1Y')).rejects.toThrowError('yahoo history down');

    expect(await redis.get(freshCacheKey(HISTORY_KEY))).toBeNull();
    expect(await redis.get(staleCacheKey(HISTORY_KEY))).toBeNull();
    // The primary's error is transient, so it is not negative-cached either.
    expect(await redis.get(negativeCacheKey(HISTORY_KEY))).toBeNull();
    expect(service.failoverStatus().attribution).toEqual([]);
  });

  it("keeps the primary's last-known-good history: one blip does not blank the asset", async () => {
    const lastKnownGood = sampleHistory();
    await redis.set(
      staleCacheKey(HISTORY_KEY),
      JSON.stringify({ value: lastKnownGood, asOf: 1 }),
      'EX',
      7 * 24 * 3600,
    );
    const { service } = stooqFailoverService();

    // The stale copy is served instantly while the refresh fails over to Stooq.
    const served = await service.getHistory(AAPL, '1Y');
    expect(served).toMatchObject({ stale: true, value: lastKnownGood });
    await service.settled();

    expect(await redis.get(freshCacheKey(HISTORY_KEY))).toBeNull();
    expect(JSON.parse((await redis.get(staleCacheKey(HISTORY_KEY))) ?? '{}')).toMatchObject({
      value: lastKnownGood,
    });
    expect(service.failoverStatus().attribution).toEqual([]);
  });
});
