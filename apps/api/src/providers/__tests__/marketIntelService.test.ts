import type { AssetProvider } from '../AssetProvider';
import type { AssetRef, DividendEvents } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { CircuitOpenError } from '../circuitBreaker';
import { CapabilityUnavailableError } from '../errors';
import { createMarketDataService } from '../marketDataService';
import { createProviderRegistry, providerCapabilities } from '../registry';

import { createDeferred, sampleHistory, sampleMeta, sampleQuote } from './fakeProvider';

const REF: AssetRef = { providerId: 'yahoo', providerRef: 'AAPL' };

const DIVIDENDS: DividendEvents = {
  currency: 'USD',
  history: [{ exDate: '2026-05-09T00:00:00.000Z', payDate: null, amount: 0.25, currency: 'USD' }],
  upcoming: [],
  forwardYield: 0.0044,
  trailingAmount: 0.98,
};

interface IntelProvider extends AssetProvider {
  readonly calls: { dividends: number };
}

/** A provider that implements the base methods plus (optionally) intel. */
function makeProvider(opts: {
  id?: string;
  withIntel?: boolean;
  dividends?: () => Promise<DividendEvents>;
}): IntelProvider {
  const calls = { dividends: 0 };
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
    getEarningsEvents: () => Promise.resolve({ next: null, recent: [] }),
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
