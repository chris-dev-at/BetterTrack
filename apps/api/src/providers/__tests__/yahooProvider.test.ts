import type { AssetRef } from '@bettertrack/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { RequestQueue } from '../requestQueue';
import {
  type YahooChartParams,
  type YahooChartResult,
  type YahooClient,
  type YahooQuoteResult,
  type YahooSearchResult,
} from '../yahooClient';
import { createYahooProvider } from '../yahooProvider';

const REF: AssetRef = { providerId: 'yahoo', providerRef: 'AAPL' };
const FIXED_NOW = Date.parse('2026-06-22T12:00:00.000Z');

/** A stub Yahoo client; each method returns whatever the test wires up. */
function stubClient(overrides: Partial<YahooClient> = {}): YahooClient {
  return {
    search: overrides.search ?? (() => Promise.resolve({ quotes: [] })),
    quote: overrides.quote ?? (() => Promise.resolve({})),
    chart: overrides.chart ?? (() => Promise.resolve({ meta: { currency: 'USD' }, quotes: [] })),
  };
}

/** A queue that just counts how many calls flow through it (proves §5.2 routing). */
function countingQueue(): RequestQueue & { count: number } {
  const q = {
    count: 0,
    run<T>(fn: () => Promise<T>): Promise<T> {
      q.count += 1;
      return fn();
    },
  };
  return q;
}

describe('yahooProvider.getQuote (§5.2)', () => {
  it('maps a quote and derives a self-consistent day change', async () => {
    const client = stubClient({
      quote: () =>
        Promise.resolve<YahooQuoteResult>({
          symbol: 'AAPL',
          currency: 'USD',
          regularMarketPrice: 100,
          regularMarketPreviousClose: 99,
          regularMarketChangePercent: 999, // ignored — we derive from prices
          regularMarketTime: new Date('2026-06-22T09:30:00.000Z'),
        }),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });

    const quote = await provider.getQuote(REF);
    expect(quote.price).toBe(100);
    expect(quote.currency).toBe('USD');
    expect(quote.prevClose).toBe(99);
    expect(quote.dayChangePct).toBeCloseTo(1.0101, 4);
    expect(quote.asOf).toBe('2026-06-22T09:30:00.000Z');
  });

  it('scales pence (GBp) to pounds (GBP) on both price and prevClose', async () => {
    const client = stubClient({
      quote: () =>
        Promise.resolve<YahooQuoteResult>({
          symbol: 'BP.L',
          currency: 'GBp',
          regularMarketPrice: 12345,
          regularMarketPreviousClose: 12000,
        }),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });

    const quote = await provider.getQuote(REF);
    expect(quote.currency).toBe('GBP');
    expect(quote.price).toBeCloseTo(123.45, 6);
    expect(quote.prevClose).toBeCloseTo(120, 6);
    // Day change is scale-invariant: (123.45 - 120) / 120 * 100.
    expect(quote.dayChangePct).toBeCloseTo(2.875, 6);
  });

  it('falls back to Yahoo percent when prevClose is unavailable', async () => {
    const client = stubClient({
      quote: () =>
        Promise.resolve<YahooQuoteResult>({
          currency: 'USD',
          regularMarketPrice: 50,
          regularMarketChangePercent: -1.5,
        }),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });

    const quote = await provider.getQuote(REF);
    expect(quote.prevClose).toBeNull();
    expect(quote.dayChangePct).toBe(-1.5);
  });

  it('uses the clock for asOf when Yahoo omits the time', async () => {
    const client = stubClient({
      quote: () => Promise.resolve<YahooQuoteResult>({ currency: 'USD', regularMarketPrice: 10 }),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });
    const quote = await provider.getQuote(REF);
    expect(quote.asOf).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('throws when Yahoo returns no price', async () => {
    const client = stubClient({
      quote: () => Promise.resolve<YahooQuoteResult>({ currency: 'USD' }),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });
    await expect(provider.getQuote(REF)).rejects.toThrow(/no price/i);
  });
});

describe('yahooProvider.getHistory (§5.2)', () => {
  it('prefers adjusted close, falls back to raw close, skips nulls, scales pence', async () => {
    let captured: YahooChartParams | undefined;
    const client = stubClient({
      chart: (_symbol, params) => {
        captured = params;
        return Promise.resolve<YahooChartResult>({
          meta: { currency: 'GBp' },
          quotes: [
            { date: new Date('2026-06-18T00:00:00.000Z'), close: 10000, adjclose: 9900 },
            { date: new Date('2026-06-19T00:00:00.000Z'), close: 10100, adjclose: null },
            { date: new Date('2026-06-20T00:00:00.000Z'), close: null, adjclose: null },
          ],
        });
      },
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });

    const history = await provider.getHistory(REF, '1Y', '1d');
    expect(captured?.interval).toBe('1d');
    expect(history).toEqual([
      { time: '2026-06-18T00:00:00.000Z', close: 99 }, // adjclose 9900 * 0.01
      { time: '2026-06-19T00:00:00.000Z', close: 101 }, // raw close 10100 * 0.01
      // third candle dropped: both closes null
    ]);
  });

  it('passes the §5.3 interval through and windows period1 from the clock', async () => {
    let captured: YahooChartParams | undefined;
    const client = stubClient({
      chart: (_symbol, params) => {
        captured = params;
        return Promise.resolve<YahooChartResult>({ meta: { currency: 'USD' }, quotes: [] });
      },
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });

    await provider.getHistory(REF, '1D', '1m');
    expect(captured?.interval).toBe('1m');
    expect((captured?.period2 as Date).toISOString()).toBe(new Date(FIXED_NOW).toISOString());
    // 1D window starts a day before now.
    expect((captured?.period1 as Date).getTime()).toBe(FIXED_NOW - 24 * 60 * 60 * 1000);
  });

  it('returns an empty series when Yahoo has no candles', async () => {
    const provider = createYahooProvider({ client: stubClient(), now: () => FIXED_NOW });
    expect(await provider.getHistory(REF, '1Y', '1d')).toEqual([]);
  });
});

describe('yahooProvider.getMeta (§5.1)', () => {
  it('maps name, exchange, currency and type', async () => {
    const client = stubClient({
      quote: () =>
        Promise.resolve<YahooQuoteResult>({
          symbol: 'BAYN.DE',
          longName: 'Bayer AG',
          fullExchangeName: 'XETRA',
          exchange: 'GER',
          currency: 'EUR',
          quoteType: 'EQUITY',
        }),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });

    const meta = await provider.getMeta({ providerId: 'yahoo', providerRef: 'BAYN.DE' });
    expect(meta).toEqual({
      providerId: 'yahoo',
      providerRef: 'BAYN.DE',
      symbol: 'BAYN.DE',
      name: 'Bayer AG',
      exchange: 'XETRA',
      currency: 'EUR',
      type: 'stock',
    });
  });
});

describe('yahooProvider.search (§6.2)', () => {
  it('maps hits, drops non-Yahoo / symbol-less rows, derives currency', async () => {
    const client = stubClient({
      search: () =>
        Promise.resolve<YahooSearchResult>({
          quotes: [
            {
              symbol: 'BAYN.DE',
              shortname: 'BAYER AG',
              longname: 'Bayer Aktiengesellschaft',
              exchange: 'GER',
              exchDisp: 'XETRA',
              quoteType: 'EQUITY',
              isYahooFinance: true,
            },
            { symbol: 'EURUSD=X', exchange: 'CCY', quoteType: 'CURRENCY', isYahooFinance: true },
            { isYahooFinance: false }, // non-Yahoo company hit — dropped
            { symbol: '', quoteType: 'EQUITY', isYahooFinance: true }, // dropped
          ],
        }),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });

    const results = await provider.search('bayer');
    expect(results).toEqual([
      {
        providerId: 'yahoo',
        providerRef: 'BAYN.DE',
        symbol: 'BAYN.DE',
        name: 'Bayer Aktiengesellschaft',
        exchange: 'XETRA',
        type: 'stock',
        currency: 'EUR',
      },
      {
        providerId: 'yahoo',
        providerRef: 'EURUSD=X',
        symbol: 'EURUSD=X',
        name: 'EURUSD=X',
        exchange: 'CCY',
        type: 'fx',
        currency: 'USD',
      },
    ]);
  });

  it('short-circuits an empty query without calling upstream', async () => {
    const search = vi.fn(() => Promise.resolve<YahooSearchResult>({ quotes: [] }));
    const provider = createYahooProvider({ client: stubClient({ search }), now: () => FIXED_NOW });
    expect(await provider.search('   ')).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });
});

describe('yahooProvider routes every upstream call through the queue (§5.2)', () => {
  it('uses queue.run for search, quote, history and meta', async () => {
    const queue = countingQueue();
    const client = stubClient({
      search: () => Promise.resolve<YahooSearchResult>({ quotes: [] }),
      quote: () => Promise.resolve<YahooQuoteResult>({ currency: 'USD', regularMarketPrice: 1 }),
      chart: () => Promise.resolve<YahooChartResult>({ meta: { currency: 'USD' }, quotes: [] }),
    });
    const provider = createYahooProvider({ client, queue, now: () => FIXED_NOW });

    await provider.search('x');
    await provider.getQuote(REF);
    await provider.getHistory(REF, '1Y', '1d');
    await provider.getMeta(REF);

    expect(queue.count).toBe(4);
  });
});
