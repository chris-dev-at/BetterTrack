import type { AssetRef, CachedResult, Quote } from '@bettertrack/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { MarketDataService } from '../../../providers';
import { createMarketDataFxSource } from '../marketDataFxSource';

const FETCHED_AT = Date.parse('2026-06-20T10:00:00.000Z');

/** A `CachedResult<Quote>` whose price is the FX leg rate under test. */
function fxQuote(price: number): CachedResult<Quote> {
  return {
    value: {
      price,
      currency: 'EUR',
      prevClose: price,
      dayChangePct: 0,
      asOf: '2026-06-20T09:59:00.000Z',
    },
    stale: false,
    asOf: FETCHED_AT,
  };
}

/**
 * A `MarketDataService` whose `getQuote` resolves `EUR{CCY}=X` from a price map.
 * Only `getQuote` is exercised by the FX source; the rest throw if touched.
 */
function stubMarketData(prices: Record<string, number>): {
  service: MarketDataService;
  getQuote: ReturnType<typeof vi.fn>;
} {
  const getQuote = vi.fn((ref: AssetRef): Promise<CachedResult<Quote>> => {
    const price = prices[ref.providerRef];
    if (price === undefined) {
      return Promise.reject(new Error(`no stub price for ${ref.providerRef}`));
    }
    return Promise.resolve(fxQuote(price));
  });
  const unused = (name: string) => () => {
    throw new Error(`stub market data: ${name} should not be called`);
  };
  const service: MarketDataService = {
    getQuote,
    search: unused('search'),
    getHistory: unused('getHistory'),
    getMeta: unused('getMeta'),
    settled: async () => {},
  };
  return { service, getQuote };
}

describe('createMarketDataFxSource', () => {
  describe('getSpotRate', () => {
    it('to==EUR: fetches EUR{from}=X and returns 1/price', async () => {
      const { service, getQuote } = stubMarketData({ 'EURUSD=X': 1.1 });
      const source = createMarketDataFxSource(service);

      // USD→EUR: eurToRate=1 (EUR), eurFromRate=1.1 → 1/1.1 = "EUR per 1 USD".
      await expect(source.getSpotRate('USD', 'EUR')).resolves.toBeCloseTo(1 / 1.1, 12);
      expect(getQuote).toHaveBeenCalledTimes(1);
      expect(getQuote).toHaveBeenCalledWith({ providerId: 'yahoo', providerRef: 'EURUSD=X' });
    });

    it('from==EUR: fetches EUR{to}=X and returns the price directly', async () => {
      const { service, getQuote } = stubMarketData({ 'EURGBP=X': 0.85 });
      const source = createMarketDataFxSource(service);

      // EUR→GBP: eurFromRate=1, eurToRate=0.85 → 0.85 = "GBP per 1 EUR".
      await expect(source.getSpotRate('EUR', 'GBP')).resolves.toBe(0.85);
      expect(getQuote).toHaveBeenCalledTimes(1);
      expect(getQuote).toHaveBeenCalledWith({ providerId: 'yahoo', providerRef: 'EURGBP=X' });
    });

    it('cross rate: fetches both legs and returns eurTo/eurFrom', async () => {
      const { service, getQuote } = stubMarketData({ 'EURUSD=X': 1.1, 'EURGBP=X': 0.85 });
      const source = createMarketDataFxSource(service);

      // USD→GBP: 0.85 / 1.1 = "GBP per 1 USD".
      await expect(source.getSpotRate('USD', 'GBP')).resolves.toBeCloseTo(0.85 / 1.1, 12);
      expect(getQuote).toHaveBeenCalledTimes(2);
      expect(getQuote).toHaveBeenCalledWith({ providerId: 'yahoo', providerRef: 'EURUSD=X' });
      expect(getQuote).toHaveBeenCalledWith({ providerId: 'yahoo', providerRef: 'EURGBP=X' });
    });

    it('propagates the error when marketData.getQuote throws', async () => {
      const getQuote = vi.fn(() => Promise.reject(new Error('upstream down')));
      const service = {
        getQuote,
        search: vi.fn(),
        getHistory: vi.fn(),
        getMeta: vi.fn(),
      } as unknown as MarketDataService;
      const source = createMarketDataFxSource(service);

      await expect(source.getSpotRate('USD', 'GBP')).rejects.toThrowError(/upstream down/);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects a non-finite/non-positive leg price %s',
      async (bad) => {
        const { service } = stubMarketData({ 'EURUSD=X': bad });
        const source = createMarketDataFxSource(service);
        await expect(source.getSpotRate('USD', 'EUR')).rejects.toThrowError(/invalid rate/);
      },
    );
  });

  describe('getHistoricalRate', () => {
    it('throws a clear not-yet-supported error', () => {
      const { service } = stubMarketData({});
      const source = createMarketDataFxSource(service);
      expect(() => source.getHistoricalRate('USD', 'EUR', '2026-01-02')).toThrowError(
        /Historical FX rates not yet supported/,
      );
    });
  });
});
