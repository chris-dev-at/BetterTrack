import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./assetApi', () => ({
  getAssetQuote: vi.fn(),
  getAssetDailyCloses: vi.fn(),
}));
vi.mock('./searchApi', () => ({ searchAssets: vi.fn() }));
vi.mock('./portfolioApi', () => ({
  getPortfolio: vi.fn(),
  getPortfolioHistory: vi.fn(),
}));

import { getAssetDailyCloses, getAssetQuote } from './assetApi';
import { createBetterTrackMarketDataSource, MarketDataSourceError } from './marketDataSource';
import * as portfolioApi from './portfolioApi';
import { searchAssets } from './searchApi';

const FX_ID = '018f0000-0000-7000-8000-000000000301';
const NOW = Date.parse('2026-07-27T12:00:00.000Z');

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  vi.resetAllMocks();
});

describe('BetterTrack public market-data source', () => {
  it('uses only public asset/search endpoints and preserves freshness watermarks', async () => {
    vi.mocked(getAssetQuote).mockResolvedValue({
      quote: {
        price: 42,
        currency: 'EUR',
        prevClose: 40,
        asOf: '2026-07-27T11:00:00.000Z',
      },
      stale: true,
      asOf: '2026-07-27T11:00:00.000Z',
    });
    vi.mocked(getAssetDailyCloses).mockResolvedValue({
      points: [
        { time: '2026-07-10T20:00:00.000Z', close: 30 },
        { time: '2026-07-27T20:00:00.000Z', close: 42 },
      ],
      stale: false,
      asOf: '2026-07-27T20:00:00.000Z',
    });
    vi.mocked(searchAssets).mockResolvedValue({ results: [], enriching: true });
    const source = createBetterTrackMarketDataSource({ now: () => NOW });

    await expect(source.quote(FX_ID)).resolves.toMatchObject({
      value: { price: 42, currency: 'EUR' },
      stale: true,
      asOf: '2026-07-27T11:00:00.000Z',
    });
    await expect(source.history(FX_ID, '1W')).resolves.toMatchObject({
      value: [{ time: '2026-07-27T20:00:00.000Z', close: 42 }],
      stale: false,
    });
    await expect(source.search('asset')).resolves.toMatchObject({
      value: [],
      stale: true,
    });
    expect(getAssetDailyCloses).toHaveBeenCalledWith(FX_ID, undefined);
    expect(portfolioApi.getPortfolio).not.toHaveBeenCalled();
    expect(portfolioApi.getPortfolioHistory).not.toHaveBeenCalled();
  });

  it('changes the history watermark when an older close is corrected', async () => {
    vi.mocked(getAssetDailyCloses).mockResolvedValue({
      points: [
        { time: '2026-07-20T20:00:00.000Z', close: 30 },
        { time: '2026-07-27T20:00:00.000Z', close: 42 },
      ],
      stale: false,
      asOf: '2026-07-27T20:00:00.000Z',
    });
    const source = createBetterTrackMarketDataSource({ now: () => NOW });
    const first = await source.history(FX_ID, 'MAX');

    vi.mocked(getAssetDailyCloses).mockResolvedValue({
      points: [
        { time: '2026-07-20T20:00:00.000Z', close: 31 },
        { time: '2026-07-27T20:00:00.000Z', close: 42 },
      ],
      stale: false,
      asOf: '2026-07-27T20:00:00.000Z',
    });
    const corrected = await source.history(FX_ID, 'MAX');

    expect(corrected.watermark).not.toBe(first.watermark);
  });

  it('resolves spot and historical FX through exact Yahoo catalog pairs', async () => {
    vi.mocked(searchAssets).mockImplementation(async (query) => ({
      results: [
        {
          id: FX_ID,
          providerId: 'yahoo',
          providerRef: query,
          symbol: query,
          name: query,
          exchange: null,
          type: 'fx',
          currency: query.includes('USD') ? 'USD' : 'GBP',
          isCustom: false,
        },
      ],
    }));
    vi.mocked(getAssetQuote).mockResolvedValue({
      quote: {
        price: 1.1,
        currency: 'USD',
        asOf: '2026-07-27T11:00:00.000Z',
      },
      stale: false,
      asOf: '2026-07-27T11:00:00.000Z',
    });
    vi.mocked(getAssetDailyCloses).mockResolvedValue({
      points: [{ time: '2026-07-25T20:00:00.000Z', close: 1.2 }],
      stale: true,
      asOf: '2026-07-25T20:00:00.000Z',
    });
    const source = createBetterTrackMarketDataSource({ now: () => NOW });

    await expect(source.fx('usd', 'EUR')).resolves.toMatchObject({
      value: 1 / 1.1,
      from: 'USD',
      to: 'EUR',
      date: null,
      stale: false,
    });
    await expect(source.fx('USD', 'EUR', '2026-07-27')).resolves.toMatchObject({
      value: 1 / 1.2,
      from: 'USD',
      to: 'EUR',
      date: '2026-07-27',
      stale: true,
    });
    expect(searchAssets).toHaveBeenCalledTimes(1);
    expect(searchAssets).toHaveBeenCalledWith('EURUSD=X', undefined);
  });

  it('keeps invalid provider values distinct from transport unavailability', async () => {
    vi.mocked(getAssetQuote).mockResolvedValue({
      quote: {
        price: 0,
        currency: 'EUR',
        asOf: '2026-07-27T11:00:00.000Z',
      },
      stale: false,
      asOf: '2026-07-27T11:00:00.000Z',
    });
    const source = createBetterTrackMarketDataSource({ now: () => NOW });

    const invalid = await capture(() => source.quote(FX_ID));
    expect(invalid).toBeInstanceOf(MarketDataSourceError);
    expect(invalid).toMatchObject({ code: 'MARKET_DATA_INVALID' });

    vi.mocked(getAssetQuote).mockRejectedValue(new TypeError('offline'));
    const unavailable = await capture(() => source.quote(FX_ID));
    expect(unavailable).toMatchObject({ code: 'MARKET_DATA_UNAVAILABLE' });

    await expect(source.fx('US', 'EUR')).rejects.toMatchObject({
      code: 'MARKET_DATA_UNSUPPORTED',
    });

    vi.mocked(getAssetQuote).mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );
    await expect(source.quote(FX_ID)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

async function capture(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    throw new Error('Expected rejection.');
  } catch (cause) {
    return cause;
  }
}
