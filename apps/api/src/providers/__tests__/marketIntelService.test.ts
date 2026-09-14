import type { AssetProvider } from '../AssetProvider';
import type { AssetRef, DividendEvents, EarningsEvents, SplitEvents } from '@bettertrack/contracts';
import { earningsEventsSchema } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError } from '../../errors';
import { cacheKey, freshCacheKey, staleCacheKey } from '../cache';
import { CircuitOpenError } from '../circuitBreaker';
import { AssetNotFoundError, CapabilityUnavailableError } from '../errors';
import {
  createMarketDataService,
  intelCacheVariant,
  type MarketDataService,
} from '../marketDataService';
import { createProviderRegistry, providerCapabilities } from '../registry';

import { mapSplitEvents } from '../yahooMapping';
import { createDeferred, sampleHistory, sampleMeta, sampleQuote } from './fakeProvider';

const REF: AssetRef = { providerId: 'yahoo', providerRef: 'AAPL' };

const DIVIDENDS: DividendEvents = {
  currency: 'USD',
  history: [{ exDate: '2026-05-09T00:00:00.000Z', payDate: null, amount: 0.25, currency: 'USD' }],
  upcoming: [],
  forwardYield: 0.0044,
  trailingAmount: 0.98,
  trailingAmountBasis: 'trailing-12m',
};

/**
 * What a post-#1790 release produces: `periodEnd` (the fiscal period reported
 * on) travels beside `date` (the announcement date) on every row.
 */
const EARNINGS: EarningsEvents = {
  next: {
    date: '2026-07-31T00:00:00.000Z',
    periodEnd: null,
    epsEstimate: 1.42,
    epsActual: null,
    estimated: true,
  },
  recent: [
    {
      date: null,
      periodEnd: '2026-03-28T00:00:00.000Z',
      epsEstimate: 1.5,
      epsActual: 1.53,
      estimated: false,
    },
  ],
};

interface IntelProvider extends AssetProvider {
  readonly calls: { dividends: number; earnings: number };
}

/** A provider that implements the base methods plus (optionally) intel. */
function makeProvider(opts: {
  id?: string;
  withIntel?: boolean;
  dividends?: () => Promise<DividendEvents>;
}): IntelProvider {
  const calls = { dividends: 0, earnings: 0 };
  const base: AssetProvider = {
    id: opts.id ?? 'yahoo',
    search: () => Promise.resolve([]),
    getQuote: () => Promise.resolve(sampleQuote()),
    getHistory: () => Promise.resolve(sampleHistory()),
    getMeta: () => Promise.resolve(sampleMeta({ providerId: opts.id ?? 'yahoo' })),
  };
  if (!opts.withIntel) return { ...base, calls };
  const dividends = opts.dividends ?? (() => Promise.resolve(DIVIDENDS));
  return {
    ...base,
    calls,
    getDividendEvents: () => {
      calls.dividends += 1;
      return dividends();
    },
    getEarningsEvents: () => {
      calls.earnings += 1;
      return Promise.resolve(EARNINGS);
    },
    getNewsHeadlines: () => Promise.resolve([]),
    getSplitEvents: () => Promise.resolve({ history: [], upcoming: [] }),
  };
}

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

function serviceWith(provider: IntelProvider, breaker?: { failureThreshold?: number }) {
  const registry = createProviderRegistry([provider]);
  const service = createMarketDataService({ registry, redis, options: { breaker } });
  return { provider, service };
}

describe('providerCapabilities / registry.capabilitiesFor (§13.5 V5-P5)', () => {
  it('reports every capability an intel provider advertises', () => {
    const caps = providerCapabilities(makeProvider({ withIntel: true }));
    expect(caps).toEqual({ dividends: true, earnings: true, news: true, splits: true });
  });

  it('reports all-false for a provider that implements no intel method', () => {
    const caps = providerCapabilities(makeProvider({ withIntel: false }));
    expect(caps).toEqual({ dividends: false, earnings: false, news: false, splits: false });
  });

  it('the registry resolves capabilities by provider id', () => {
    const registry = createProviderRegistry([
      makeProvider({ id: 'yahoo', withIntel: true }),
      makeProvider({ id: 'stooq', withIntel: false }),
    ]);
    expect(registry.capabilitiesFor('yahoo').dividends).toBe(true);
    expect(registry.capabilitiesFor('stooq').dividends).toBe(false);
  });
});

describe('MarketDataService intel capability gating', () => {
  it('intelCapabilities reflects the asset provider', () => {
    const { service } = serviceWith(makeProvider({ withIntel: true }));
    expect(service.intelCapabilities(REF)).toEqual({
      dividends: true,
      earnings: true,
      news: true,
      splits: true,
    });
  });

  it('a capability-less provider yields unavailable, not an error (rejects clearly)', async () => {
    const { service } = serviceWith(makeProvider({ withIntel: false }));
    expect(service.intelCapabilities(REF).dividends).toBe(false);
    await expect(service.getDividendEvents(REF)).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });
});

describe('MarketDataService intel caching/coalescing/breaker', () => {
  it('a second call within the TTL is served from cache (one upstream fetch)', async () => {
    const { provider, service } = serviceWith(makeProvider({ withIntel: true }));

    const first = await service.getDividendEvents(REF);
    expect(first.stale).toBe(false);
    expect(first.value).toEqual(DIVIDENDS);

    const second = await service.getDividendEvents(REF);
    expect(second.value).toEqual(DIVIDENDS);
    // The cache absorbed the second read — the provider was only asked once.
    expect(provider.calls.dividends).toBe(1);
  });

  it('concurrent cold misses coalesce onto a single upstream fetch', async () => {
    const deferred = createDeferred<DividendEvents>();
    const { provider, service } = serviceWith(
      makeProvider({ withIntel: true, dividends: () => deferred.promise }),
    );

    const a = service.getDividendEvents(REF);
    const b = service.getDividendEvents(REF);
    deferred.resolve(DIVIDENDS);
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra.value).toEqual(DIVIDENDS);
    expect(rb.value).toEqual(DIVIDENDS);
    expect(provider.calls.dividends).toBe(1);
  });

  it('an open breaker short-circuits without hammering upstream (graceful empty)', async () => {
    const { provider, service } = serviceWith(
      makeProvider({
        withIntel: true,
        dividends: () => Promise.reject(new Error('upstream down')),
      }),
      { failureThreshold: 1 },
    );

    // First read fails and trips the breaker.
    await expect(service.getDividendEvents(REF)).rejects.toThrow();
    const afterTrip = provider.calls.dividends;

    // With the breaker open and nothing cached, the next read fails fast with a
    // CircuitOpenError and does NOT call the provider again — the read service
    // catches this and degrades to `available: false`.
    await expect(service.getDividendEvents(REF)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(provider.calls.dividends).toBe(afterTrip);
  });
});

describe('MarketDataService intel payload versioning (#1741)', () => {
  /** The key a release before the payload change wrote its dividends entry to. */
  const V1_KEY = cacheKey('yahoo', 'AAPL', 'intel', 'dividends');
  /** What that release stored: no `trailingAmountBasis` at all. */
  const V1_PAYLOAD = {
    currency: 'USD',
    history: DIVIDENDS.history,
    upcoming: [],
    forwardYield: 0.0044,
    trailingAmount: 0.98,
  };

  it('only the changed capabilities get a new variant; the rest keep their bare key', () => {
    expect(intelCacheVariant('dividends')).toBe('dividends@v2');
    // Bumping earnings (#1790, see below) must not move the other three: a shape
    // change to one payload may not evict the caches of the ones that did not
    // change.
    expect(intelCacheVariant('earnings')).toBe('earnings@v2');
    for (const capability of ['news', 'splits', 'fundamentals'] as const) {
      expect(intelCacheVariant(capability)).toBe(capability);
    }
  });

  it('an entry written before the payload change is never served — neither fresh nor stale', async () => {
    // Both copies present, exactly as they are the moment a deploy lands: the
    // fresh copy inside its 12 h window, the stale copy good for a week.
    const entry = JSON.stringify({ value: V1_PAYLOAD, asOf: Date.now() });
    await redis.set(freshCacheKey(V1_KEY), entry, 'EX', 12 * 60 * 60);
    await redis.set(staleCacheKey(V1_KEY), entry, 'EX', 7 * 24 * 60 * 60);

    const { provider, service } = serviceWith(makeProvider({ withIntel: true }));
    const result = await service.getDividendEvents(REF);

    // The v1 entry did not answer the read: the provider was asked, and what
    // came back carries the basis the projection refuses to do without.
    expect(provider.calls.dividends).toBe(1);
    expect(result.stale).toBe(false);
    expect(result.value.trailingAmountBasis).toBe('trailing-12m');
    expect(result.value).toEqual(DIVIDENDS);

    // The fresh payload was stored under the versioned key, and the v1 entry was
    // left alone to expire on its own TTL.
    const stored = await redis.get(
      freshCacheKey(cacheKey('yahoo', 'AAPL', 'intel', 'dividends@v2')),
    );
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? 'null')).toMatchObject({ value: DIVIDENDS });
  });
});

describe('MarketDataService intel payload versioning — earnings (#1790)', () => {
  /** The key the release before the payload change wrote its earnings entry to. */
  const V1_KEY = cacheKey('yahoo', 'AAPL', 'intel', 'earnings');
  /**
   * What that release stored: rows with no `periodEnd` at all. `periodEnd` is
   * REQUIRED (nullable, on a strict object), so this payload no longer parses —
   * and the read path reads a cached entry back verbatim, with no schema parse,
   * so it would reach the client and blank the asset page's earnings block.
   */
  const V1_PAYLOAD = {
    next: { date: '2026-01-30T00:00:00.000Z', epsEstimate: 1.1, epsActual: null, estimated: true },
    recent: [
      { date: '2025-10-30T00:00:00.000Z', epsEstimate: 1.0, epsActual: 1.05, estimated: false },
    ],
  };

  it('the v1 payload is exactly what the contract now refuses', () => {
    expect(earningsEventsSchema.safeParse(V1_PAYLOAD).success).toBe(false);
    expect(earningsEventsSchema.safeParse(EARNINGS).success).toBe(true);
  });

  it('an entry written before the payload change is never served — neither fresh nor stale', async () => {
    // Both copies present, exactly as they are the moment a deploy lands: the
    // fresh copy inside its 6 h window, the stale copy good for a week.
    const entry = JSON.stringify({ value: V1_PAYLOAD, asOf: Date.now() });
    await redis.set(freshCacheKey(V1_KEY), entry, 'EX', 6 * 60 * 60);
    await redis.set(staleCacheKey(V1_KEY), entry, 'EX', 7 * 24 * 60 * 60);

    const { provider, service } = serviceWith(makeProvider({ withIntel: true }));
    const result = await service.getEarningsEvents(REF);

    // The v1 entry did not answer the read: the provider was asked, and every row
    // that came back carries the `periodEnd` the client's parse requires.
    expect(provider.calls.earnings).toBe(1);
    expect(result.stale).toBe(false);
    expect(result.value).toEqual(EARNINGS);
    expect(earningsEventsSchema.safeParse(result.value).success).toBe(true);

    // The fresh payload was stored under the versioned key, and the v1 entry was
    // left alone to expire on its own TTL.
    const stored = await redis.get(
      freshCacheKey(cacheKey('yahoo', 'AAPL', 'intel', 'earnings@v2')),
    );
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? 'null')).toMatchObject({ value: EARNINGS });
    expect(await redis.get(freshCacheKey(V1_KEY))).toBe(entry);
  });
});

describe('MarketDataService intel — per-family graceful degradation (dividends/earnings/news/splits)', () => {
  type Family = {
    name: string;
    method: 'getDividendEvents' | 'getEarningsEvents' | 'getNewsHeadlines' | 'getSplitEvents';
    call: (s: MarketDataService) => Promise<unknown>;
  };

  const families: Family[] = [
    { name: 'dividends', method: 'getDividendEvents', call: (s) => s.getDividendEvents(REF) },
    { name: 'earnings', method: 'getEarningsEvents', call: (s) => s.getEarningsEvents(REF) },
    { name: 'news', method: 'getNewsHeadlines', call: (s) => s.getNewsHeadlines(REF) },
    { name: 'splits', method: 'getSplitEvents', call: (s) => s.getSplitEvents(REF) },
  ];

  it.each(families)(
    '$name: a capability-less provider rejects with CapabilityUnavailableError — never an ApiError 5xx',
    async ({ call }) => {
      const { service } = serviceWith(makeProvider({ withIntel: false }));
      try {
        await call(service);
        expect.unreachable('should have rejected');
      } catch (err) {
        // The read layer catches this and degrades to `available: false`; it is
        // deliberately NOT an ApiError, so it can never become a 500.
        expect(err).toBeInstanceOf(CapabilityUnavailableError);
        expect(err).not.toBeInstanceOf(ApiError);
      }
    },
  );

  it.each(families)(
    '$name: a provider error trips the shared breaker; the next read fails fast (degrade, no 5xx)',
    async ({ method, call }) => {
      const base = makeProvider({ withIntel: true });
      const provider = {
        ...base,
        [method]: () => Promise.reject(new Error('upstream down')),
      } as typeof base;
      const { service } = serviceWith(provider, { failureThreshold: 1 });

      // First read exhausts the breaker (one execute-level failure at threshold 1).
      await expect(call(service)).rejects.toThrow();
      // Breaker open, nothing cached → fast-fail with CircuitOpenError, no ApiError.
      await expect(call(service)).rejects.toBeInstanceOf(CircuitOpenError);
    },
  );

  it.each(families)(
    '$name: a not-found upstream is negative-cached and never retried within the window',
    async ({ method, call }) => {
      const base = makeProvider({ withIntel: true });
      let calls = 0;
      const provider = {
        ...base,
        [method]: () => {
          calls += 1;
          return Promise.reject(new AssetNotFoundError('unknown symbol'));
        },
      } as typeof base;
      const { service } = serviceWith(provider);

      await expect(call(service)).rejects.toBeInstanceOf(AssetNotFoundError);
      expect(calls).toBe(1); // definitive not-found — never retried

      await expect(call(service)).rejects.toMatchObject({ fromNegativeCache: true });
      expect(calls).toBe(1); // answered from the negative cache, no upstream call
    },
  );
});

describe('MarketDataService intel — announced (upcoming) splits (§13.5 V5-P5 arc d)', () => {
  // Yahoo is the only provider implementing splits today and it exposes only
  // PAST ones, so `mapSplitEvents` always returns `upcoming: []` — nothing in a
  // live deployment ever exercises the forward branch. The fixture below is
  // literally the row shape that mapper emits, promoted to `upcoming` as a
  // forward-capable provider would return it, so the branch is tested code
  // rather than dead code.
  const MAPPED = mapSplitEvents({
    meta: { currency: 'USD' },
    dividends: [],
    splits: [
      {
        date: new Date('2026-09-01T00:00:00.000Z'),
        numerator: 2,
        denominator: 1,
        splitRatio: '2:1',
      },
    ],
  });
  const ANNOUNCED: SplitEvents = { history: [], upcoming: MAPPED.history };

  it('the mapper-shaped upcoming row survives the keystone, cached read included', () => {
    expect(MAPPED.upcoming).toEqual([]); // the documented Yahoo limitation
    expect(ANNOUNCED.upcoming).toEqual([
      { date: '2026-09-01T00:00:00.000Z', numerator: 2, denominator: 1, ratio: '2:1' },
    ]);
  });

  it('serves an announced split unchanged, on the live read and from cache', async () => {
    const base = makeProvider({ withIntel: true });
    let calls = 0;
    const provider = {
      ...base,
      getSplitEvents: () => {
        calls += 1;
        return Promise.resolve(ANNOUNCED);
      },
    } as typeof base;
    const { service } = serviceWith(provider);

    const live = await service.getSplitEvents(REF);
    expect(live.value).toEqual(ANNOUNCED);

    // The cache round-trip (JSON in Redis) must not drop or reshape the
    // announced rows — that is where a "temporary" forward payload would die.
    const cached = await service.getSplitEvents(REF);
    expect(cached.value).toEqual(ANNOUNCED);
    expect(calls).toBe(1);
  });
});
