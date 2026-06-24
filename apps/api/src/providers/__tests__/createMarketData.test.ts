import type { AssetRef } from '@bettertrack/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import { createMarketData } from '../createMarketData';
import type { YahooClient, YahooQuoteResult } from '../yahooClient';

const YAHOO_REF: AssetRef = { providerId: 'yahoo', providerRef: 'AAPL' };

describe('createMarketData registers both providers (§5.1)', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createTestApp();
  });

  afterAll(async () => {
    await h.ctx.redis.quit?.();
  });

  it('exposes a registry resolving yahoo + manual by providerId', () => {
    const stub: YahooClient = {
      search: () => Promise.resolve({ quotes: [] }),
      quote: () => Promise.resolve({}),
      chart: () => Promise.resolve({ meta: { currency: 'USD' }, quotes: [] }),
    };
    const { registry } = createMarketData({ db: h.db, redis: h.ctx.redis, yahooClient: stub });

    expect(registry.has('yahoo')).toBe(true);
    expect(registry.has('manual')).toBe(true);
    expect(registry.for({ providerId: 'yahoo' }).id).toBe('yahoo');
    expect(registry.for({ providerId: 'manual' }).id).toBe('manual');
  });

  it('serves a Yahoo quote through the cache (one upstream call, then a hit)', async () => {
    await h.ctx.redis.flushall();
    const quote = vi.fn(
      (): Promise<YahooQuoteResult> =>
        Promise.resolve({ symbol: 'AAPL', currency: 'USD', regularMarketPrice: 187.5 }),
    );
    const stub: YahooClient = {
      search: () => Promise.resolve({ quotes: [] }),
      quote,
      chart: () => Promise.resolve({ meta: { currency: 'USD' }, quotes: [] }),
    };
    const { service } = createMarketData({ db: h.db, redis: h.ctx.redis, yahooClient: stub });

    const first = await service.getQuote(YAHOO_REF);
    expect(first.stale).toBe(false);
    expect(first.value.price).toBe(187.5);
    expect(first.value.currency).toBe('USD');

    // Second read is a cache hit — no further upstream call (§5.3).
    const second = await service.getQuote(YAHOO_REF);
    expect(second.value.price).toBe(187.5);
    expect(quote).toHaveBeenCalledTimes(1);
  });
});
