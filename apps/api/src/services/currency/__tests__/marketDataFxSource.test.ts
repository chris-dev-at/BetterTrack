import type { AssetRef, CachedResult, PricePoint, Quote } from '@bettertrack/contracts';
import { describe, expect, it, vi } from 'vitest';

import { STALE_TTL_SECONDS, type MarketDataService } from '../../../providers';
import { FxRateUnavailableError } from '../currencyService';
import { createMarketDataFxSource, FX_SPOT_MAX_AGE_MS } from '../marketDataFxSource';

const FETCHED_AT = Date.parse('2026-06-20T10:00:00.000Z');

/** Injected clock for the historical tests: Saturday 2026-06-20, midday UTC. */
const NOW = Date.parse('2026-06-20T12:00:00.000Z');

/**
 * A `CachedResult<Quote>` whose price is the FX leg rate under test. The outer
 * `asOf` is when the providers layer stored the copy — the spot bound
 * ({@link FX_SPOT_MAX_AGE_MS}) is measured against it, so it defaults to "just
 * fetched" on the wall clock these spot cases run against.
 */
function fxQuote(
  price: number,
  opts: { stale?: boolean; asOf?: number } = {},
): CachedResult<Quote> {
  const asOf = opts.asOf ?? Date.now();
  return {
    value: {
      price,
      currency: 'EUR',
      prevClose: price,
      dayChangePct: 0,
      asOf: new Date(asOf).toISOString(),
    },
    stale: opts.stale ?? false,
    asOf,
  };
}

/** Daily closes keyed by pair symbol, e.g. `{ 'EURUSD=X': { '2026-06-18': 1.15 } }`. */
type FxSeries = Record<string, Record<string, number>>;

function fxHistory(closes: Record<string, number>): CachedResult<PricePoint[]> {
  return {
    value: Object.entries(closes).map(([date, close]) => ({
      time: `${date}T00:00:00.000Z`,
      close,
    })),
    stale: false,
    asOf: FETCHED_AT,
  };
}

/**
 * A `MarketDataService` resolving `EUR{CCY}=X` quotes from a price map and
 * `EUR{CCY}=X` daily histories from a series map. Unconfigured methods throw.
 */
function stubMarketData(
  prices: Record<string, number> = {},
  series: FxSeries = {},
): {
  service: MarketDataService;
  getQuote: ReturnType<typeof vi.fn>;
  getHistory: ReturnType<typeof vi.fn>;
} {
  const getQuote = vi.fn((ref: AssetRef): Promise<CachedResult<Quote>> => {
    const price = prices[ref.providerRef];
    if (price === undefined) {
      return Promise.reject(new Error(`no stub price for ${ref.providerRef}`));
    }
    return Promise.resolve(fxQuote(price));
  });
  const getHistory = vi.fn((ref: AssetRef): Promise<CachedResult<PricePoint[]>> => {
    const closes = series[ref.providerRef];
    if (closes === undefined) {
      return Promise.reject(new Error(`no stub history for ${ref.providerRef}`));
    }
    return Promise.resolve(fxHistory(closes));
  });
  const unused = (name: string) => () => {
    throw new Error(`stub market data: ${name} should not be called`);
  };
  const service: MarketDataService = {
    isLocalProvider: () => false,
    getQuote,
    getHistory,
    // FX history is a rate series with no corporate actions, so the basis is
    // irrelevant here; the source only ever calls `getHistory`.
    getUnadjustedHistory: unused('getUnadjustedHistory'),
    search: unused('search'),
    getMeta: unused('getMeta'),
    pollQuote: unused('pollQuote'),
    intelCapabilities: () => ({
      dividends: false,
      earnings: false,
      news: false,
      splits: false,
    }),
    getDividendEvents: unused('getDividendEvents'),
    getEarningsEvents: unused('getEarningsEvents'),
    getNewsHeadlines: unused('getNewsHeadlines'),
    getSplitEvents: unused('getSplitEvents'),
    getFundamentals: unused('getFundamentals'),
    settled: async () => {},
    breakerStates: () => [],
    breakerSnapshots: () => [],
    failoverStatus: () => ({ chains: [], switches: [], attribution: [] }),
  };
  return { service, getQuote, getHistory };
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

    /**
     * The §5.3 staleness bound. Serve-stale is mandated and stays: what is
     * pinned here is that the `stale`/`asOf` the cache produces are actually
     * consumed, and that the ceiling on a spot rate's age is this layer's own
     * named constant rather than the providers layer's Redis retention.
     */
    describe('spot staleness bound (§5.3)', () => {
      /** Injected clock for the bound cases (the fixture stamps ages off it). */
      const BOUND_NOW = Date.parse('2026-06-20T12:00:00.000Z');
      const HOUR_MS = 60 * 60 * 1000;

      /** A source whose only leg, `EURUSD=X`, is the given cached quote. */
      function sourceWith(quote: CachedResult<Quote>) {
        const getQuote = vi.fn(() => Promise.resolve(quote));
        const service = {
          getQuote,
          getHistory: vi.fn(),
          search: vi.fn(),
          getMeta: vi.fn(),
        } as unknown as MarketDataService;
        return {
          source: createMarketDataFxSource(service, { now: () => BOUND_NOW }),
          getQuote,
        };
      }

      it('the bound is an explicit currency-layer policy, strictly tighter than STALE_TTL_SECONDS', () => {
        expect(FX_SPOT_MAX_AGE_MS).toBeGreaterThan(0);
        expect(FX_SPOT_MAX_AGE_MS).toBeLessThan(STALE_TTL_SECONDS * 1000);
      });

      it('serves a stale-marked quote inside the bound — serve-stale is preserved', async () => {
        const { source, getQuote } = sourceWith(
          fxQuote(1.1, { stale: true, asOf: BOUND_NOW - 47 * HOUR_MS }),
        );

        // USD→EUR still converts off the stale copy: §5.3 wants exactly this.
        await expect(source.getSpotRate('USD', 'EUR')).resolves.toBeCloseTo(1 / 1.1, 12);
        expect(getQuote).toHaveBeenCalledTimes(1);
      });

      it('serves a stale quote sitting exactly on the bound (the bound is inclusive)', async () => {
        const { source } = sourceWith(
          fxQuote(1.1, { stale: true, asOf: BOUND_NOW - FX_SPOT_MAX_AGE_MS }),
        );

        await expect(source.getSpotRate('USD', 'EUR')).resolves.toBeCloseTo(1 / 1.1, 12);
      });

      it('past the bound it fails typed (FxRateUnavailableError), never a silent number', async () => {
        const { source } = sourceWith(
          fxQuote(1.1, { stale: true, asOf: BOUND_NOW - FX_SPOT_MAX_AGE_MS - 1 }),
        );

        const err = await source.getSpotRate('USD', 'EUR').then(
          (rate) => rate,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(FxRateUnavailableError);
        const fxErr = err as FxRateUnavailableError;
        // Named at the leg the historical path names, and flagged as spot.
        expect(fxErr.from).toBe('EUR');
        expect(fxErr.to).toBe('USD');
        expect(fxErr.date).toBeNull();
        expect(fxErr.message).toMatch(/EURUSD=X/);
        expect(fxErr.message).toMatch(/72h spot bound/);
      });

      it('a week-old copy — the STALE_TTL_SECONDS ceiling the bound replaces — is refused', async () => {
        const { source } = sourceWith(
          fxQuote(1.1, { stale: true, asOf: BOUND_NOW - 7 * 24 * HOUR_MS }),
        );

        await expect(source.getSpotRate('USD', 'EUR')).rejects.toBeInstanceOf(
          FxRateUnavailableError,
        );
      });

      it('bounds the age whatever the cache marked: an ancient un-stale copy is refused too', async () => {
        const { source } = sourceWith(
          fxQuote(1.1, { stale: false, asOf: BOUND_NOW - 7 * 24 * HOUR_MS }),
        );

        await expect(source.getSpotRate('USD', 'EUR')).rejects.toBeInstanceOf(
          FxRateUnavailableError,
        );
      });

      it('the invalid-rate guard still runs first — a garbage price is a caller-visible Error', async () => {
        const { source } = sourceWith(
          fxQuote(0, { stale: true, asOf: BOUND_NOW - 30 * 24 * HOUR_MS }),
        );

        // Ordering matters: the pre-existing finite/>0 guard is unchanged and
        // keeps classifying garbage as a bug, not as a staleness degrade.
        const err = await source.getSpotRate('USD', 'EUR').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(FxRateUnavailableError);
        expect((err as Error).message).toMatch(/invalid rate/);
      });

      it('the EUR identity leg needs no quote, so it can never age out', async () => {
        const { source, getQuote } = sourceWith(
          fxQuote(1.1, { stale: true, asOf: BOUND_NOW - 30 * 24 * HOUR_MS }),
        );

        await expect(source.getSpotRate('EUR', 'EUR')).resolves.toBe(1);
        expect(getQuote).not.toHaveBeenCalled();
      });

      it('a cross rate is refused when either leg is past the bound', async () => {
        const fresh = fxQuote(1.1, { asOf: BOUND_NOW - HOUR_MS });
        const ancient = fxQuote(0.85, { stale: true, asOf: BOUND_NOW - 5 * 24 * HOUR_MS });
        const getQuote = vi.fn((ref: AssetRef) =>
          Promise.resolve(ref.providerRef === 'EURUSD=X' ? fresh : ancient),
        );
        const service = { getQuote } as unknown as MarketDataService;
        const source = createMarketDataFxSource(service, { now: () => BOUND_NOW });

        const err = await source.getSpotRate('USD', 'GBP').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(FxRateUnavailableError);
        expect((err as FxRateUnavailableError).to).toBe('GBP');
      });
    });
  });

  describe('getHistoricalRate', () => {
    const USD_SERIES = { '2026-06-12': 1.1, '2026-06-15': 1.12, '2026-06-18': 1.15 };

    it('to==EUR: returns 1/close of EUR{from}=X on the date, fetched as daily candles', async () => {
      const { service, getHistory } = stubMarketData({}, { 'EURUSD=X': USD_SERIES });
      const source = createMarketDataFxSource(service, { now: () => NOW });

      await expect(source.getHistoricalRate('USD', 'EUR', '2026-06-18')).resolves.toBeCloseTo(
        1 / 1.15,
        12,
      );
      expect(getHistory).toHaveBeenCalledTimes(1);
      // A date a few days back needs only the narrowest daily window.
      expect(getHistory).toHaveBeenCalledWith(
        { providerId: 'yahoo', providerRef: 'EURUSD=X' },
        '1M',
        '1d',
      );
    });

    it('from==EUR: returns the close directly', async () => {
      const { service } = stubMarketData({}, { 'EURUSD=X': USD_SERIES });
      const source = createMarketDataFxSource(service, { now: () => NOW });

      await expect(source.getHistoricalRate('EUR', 'USD', '2026-06-18')).resolves.toBe(1.15);
    });

    it('cross rate: both legs on the same date', async () => {
      const { service, getHistory } = stubMarketData(
        {},
        { 'EURUSD=X': USD_SERIES, 'EURGBP=X': { '2026-06-18': 0.85 } },
      );
      const source = createMarketDataFxSource(service, { now: () => NOW });

      // USD→GBP on 06-18: 0.85 / 1.15 = "GBP per 1 USD".
      await expect(source.getHistoricalRate('USD', 'GBP', '2026-06-18')).resolves.toBeCloseTo(
        0.85 / 1.15,
        12,
      );
      expect(getHistory).toHaveBeenCalledTimes(2);
    });

    it('falls back to the nearest prior close over a weekend/holiday gap', async () => {
      const { service } = stubMarketData({}, { 'EURUSD=X': USD_SERIES });
      const source = createMarketDataFxSource(service, { now: () => NOW });

      // 2026-06-14 is a Sunday; the nearest prior close is Friday 06-12.
      await expect(source.getHistoricalRate('EUR', 'USD', '2026-06-14')).resolves.toBe(1.1);
    });

    it('skips garbage closes (≤0 / non-finite) when falling back', async () => {
      const { service } = stubMarketData(
        {},
        { 'EURUSD=X': { '2026-06-17': 1.2, '2026-06-18': 0 } },
      );
      const source = createMarketDataFxSource(service, { now: () => NOW });

      // The 06-18 close is dropped as garbage, so 06-17 is the nearest usable one.
      await expect(source.getHistoricalRate('EUR', 'USD', '2026-06-18')).resolves.toBe(1.2);
    });

    it('fails typed when no close exists within the fallback window', async () => {
      const { service } = stubMarketData({}, { 'EURUSD=X': USD_SERIES });
      const source = createMarketDataFxSource(service, { now: () => NOW });

      // 2026-06-01 is >7 days before the series' first close (06-12).
      const err = await source.getHistoricalRate('EUR', 'USD', '2026-06-01').catch((e) => e);
      expect(err).toBeInstanceOf(FxRateUnavailableError);
      expect(err.to).toBe('USD');
      expect(err.date).toBe('2026-06-01');
    });

    it('fails typed (with cause) when the provider history is unreachable', async () => {
      const { service } = stubMarketData({}, {}); // no series → getHistory rejects
      const source = createMarketDataFxSource(service, { now: () => NOW });

      const err = await source.getHistoricalRate('USD', 'EUR', '2026-06-18').catch((e) => e);
      expect(err).toBeInstanceOf(FxRateUnavailableError);
      expect(err.cause).toBeInstanceOf(Error);
    });

    it('memoises the parsed series per currency (one fetch for many dates)', async () => {
      const { service, getHistory } = stubMarketData({}, { 'EURUSD=X': USD_SERIES });
      const source = createMarketDataFxSource(service, { now: () => NOW });

      await source.getHistoricalRate('USD', 'EUR', '2026-06-18');
      await source.getHistoricalRate('USD', 'EUR', '2026-06-15');
      await source.getHistoricalRate('USD', 'EUR', '2026-06-14');
      expect(getHistory).toHaveBeenCalledTimes(1);
    });

    it('widens the window for older dates and then serves recent dates from it', async () => {
      const series = { ...USD_SERIES, '2024-06-18': 1.05 };
      const { service, getHistory } = stubMarketData({}, { 'EURUSD=X': series });
      const source = createMarketDataFxSource(service, { now: () => NOW });

      await source.getHistoricalRate('EUR', 'USD', '2026-06-18'); // 1M window
      await expect(source.getHistoricalRate('EUR', 'USD', '2024-06-18')).resolves.toBe(1.05);
      expect(getHistory).toHaveBeenCalledTimes(2);
      expect(getHistory).toHaveBeenLastCalledWith(
        { providerId: 'yahoo', providerRef: 'EURUSD=X' },
        '5Y',
        '1d',
      );

      // The widened series covers narrow needs — no third fetch.
      await source.getHistoricalRate('EUR', 'USD', '2026-06-18');
      expect(getHistory).toHaveBeenCalledTimes(2);
    });

    it('does not memoise a failed fetch (next lookup retries)', async () => {
      let failFirst = true;
      const getHistory = vi.fn((): Promise<CachedResult<PricePoint[]>> => {
        if (failFirst) {
          failFirst = false;
          return Promise.reject(new Error('upstream down'));
        }
        return Promise.resolve(fxHistory(USD_SERIES));
      });
      const service = { getHistory } as unknown as MarketDataService;
      const source = createMarketDataFxSource(service, { now: () => NOW });

      await expect(source.getHistoricalRate('EUR', 'USD', '2026-06-18')).rejects.toBeInstanceOf(
        FxRateUnavailableError,
      );
      await expect(source.getHistoricalRate('EUR', 'USD', '2026-06-18')).resolves.toBe(1.15);
      expect(getHistory).toHaveBeenCalledTimes(2);
    });

    it('re-fetches once the memoised series passes its freshness TTL', async () => {
      let nowMs = NOW;
      const { service, getHistory } = stubMarketData({}, { 'EURUSD=X': USD_SERIES });
      const source = createMarketDataFxSource(service, { now: () => nowMs });

      await source.getHistoricalRate('EUR', 'USD', '2026-06-18');
      nowMs += 16 * 60 * 1000; // past the 1M-range freshness window (15 min)
      await source.getHistoricalRate('EUR', 'USD', '2026-06-18');
      expect(getHistory).toHaveBeenCalledTimes(2);
    });

    it('rejects a malformed date as a caller bug, before any fetch', async () => {
      const { service, getHistory } = stubMarketData({}, { 'EURUSD=X': USD_SERIES });
      const source = createMarketDataFxSource(service, { now: () => NOW });

      await expect(source.getHistoricalRate('USD', 'EUR', 'not-a-date')).rejects.toThrowError(
        /Invalid ISO date/,
      );
      expect(getHistory).not.toHaveBeenCalled();
    });
  });
});
