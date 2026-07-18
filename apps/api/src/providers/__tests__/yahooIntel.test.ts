import type { AssetRef } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type { RequestQueue } from '../requestQueue';
import type {
  YahooChartEventsResult,
  YahooClient,
  YahooNewsResult,
  YahooQuoteSummaryResult,
} from '../yahooClient';
import { createYahooProvider } from '../yahooProvider';

const REF: AssetRef = { providerId: 'yahoo', providerRef: 'AAPL' };
const FIXED_NOW = Date.parse('2026-06-22T12:00:00.000Z');

/** A stub Yahoo client whose intel methods return whatever a test wires up. */
function stubClient(overrides: Partial<YahooClient> = {}): YahooClient {
  return {
    search: overrides.search ?? (() => Promise.resolve({ quotes: [] })),
    quote: overrides.quote ?? (() => Promise.resolve({})),
    chart: overrides.chart ?? (() => Promise.resolve({ meta: { currency: 'USD' }, quotes: [] })),
    chartEvents:
      overrides.chartEvents ??
      (() => Promise.resolve({ meta: { currency: 'USD' }, dividends: [], splits: [] })),
    quoteSummary: overrides.quoteSummary ?? (() => Promise.resolve({})),
    searchNews: overrides.searchNews ?? (() => Promise.resolve({ news: [] })),
  };
}

/** A queue that counts how many upstream calls flow through it (proves §5.2 routing). */
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

describe('yahooProvider.getDividendEvents (§13.5 V5-P5)', () => {
  it('maps history, scales a minor unit (GBp→GBP), and folds in the calendar + yield', async () => {
    const client = stubClient({
      chartEvents: () =>
        Promise.resolve<YahooChartEventsResult>({
          meta: { currency: 'GBp' },
          dividends: [
            { amount: 25, date: new Date('2026-05-09T00:00:00.000Z') },
            { amount: 24, date: new Date('2026-02-07T00:00:00.000Z') },
          ],
          splits: [],
        }),
      quoteSummary: () =>
        Promise.resolve<YahooQuoteSummaryResult>({
          calendarEvents: {
            exDividendDate: new Date('2026-08-08T00:00:00.000Z'),
            dividendDate: new Date('2026-08-15T00:00:00.000Z'),
          },
          summaryDetail: {
            currency: 'GBp',
            dividendYield: 0.0044,
            trailingAnnualDividendRate: 98,
          },
        }),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });

    const result = await provider.getDividendEvents!(REF);
    expect(result.currency).toBe('GBP');
    // Ascending by ex-date, amounts scaled out of pence.
    expect(result.history).toEqual([
      { exDate: '2026-02-07T00:00:00.000Z', payDate: null, amount: 0.24, currency: 'GBP' },
      { exDate: '2026-05-09T00:00:00.000Z', payDate: null, amount: 0.25, currency: 'GBP' },
    ]);
    expect(result.upcoming).toEqual([
      {
        exDate: '2026-08-08T00:00:00.000Z',
        payDate: '2026-08-15T00:00:00.000Z',
        amount: null,
        currency: 'GBP',
      },
    ]);
    expect(result.forwardYield).toBe(0.0044);
    expect(result.trailingAmount).toBeCloseTo(0.98, 6);
  });

  it('still returns history when the calendar/detail call fails (partial degrade)', async () => {
    const client = stubClient({
      chartEvents: () =>
        Promise.resolve<YahooChartEventsResult>({
          meta: { currency: 'USD' },
          dividends: [{ amount: 0.25, date: new Date('2026-05-09T00:00:00.000Z') }],
          splits: [],
        }),
      quoteSummary: () => Promise.reject(new Error('quoteSummary down')),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });

    const result = await provider.getDividendEvents!(REF);
    expect(result.history).toHaveLength(1);
    expect(result.upcoming).toEqual([]);
    expect(result.forwardYield).toBeNull();
  });

  it('throws only when BOTH calls fail (so the breaker/degrade path engages)', async () => {
    const client = stubClient({
      chartEvents: () => Promise.reject(new Error('chart down')),
      quoteSummary: () => Promise.reject(new Error('summary down')),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });
    await expect(provider.getDividendEvents!(REF)).rejects.toThrow(/chart down/);
  });
});

describe('yahooProvider.getEarningsEvents (§13.5 V5-P5)', () => {
  it('maps the next (estimated) date and recent reported quarters', async () => {
    const client = stubClient({
      quoteSummary: () =>
        Promise.resolve<YahooQuoteSummaryResult>({
          calendarEvents: {
            earnings: {
              earningsDate: [new Date('2026-07-30T00:00:00.000Z')],
              isEarningsDateEstimate: true,
              earningsAverage: 1.42,
            },
          },
          earningsHistory: {
            history: [
              {
                epsActual: 1.53,
                epsEstimate: 1.5,
                quarter: new Date('2026-04-30T00:00:00.000Z'),
              },
            ],
          },
        }),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });

    const result = await provider.getEarningsEvents!(REF);
    expect(result.next).toEqual({
      date: '2026-07-30T00:00:00.000Z',
      epsEstimate: 1.42,
      epsActual: null,
      estimated: true,
    });
    expect(result.recent).toEqual([
      {
        date: '2026-04-30T00:00:00.000Z',
        epsEstimate: 1.5,
        epsActual: 1.53,
        estimated: false,
      },
    ]);
  });

  it('returns a null next when Yahoo has no upcoming earnings date', async () => {
    const provider = createYahooProvider({ client: stubClient(), now: () => FIXED_NOW });
    const result = await provider.getEarningsEvents!(REF);
    expect(result.next).toBeNull();
    expect(result.recent).toEqual([]);
  });
});

describe('yahooProvider.getNewsHeadlines (§13.5 V5-P5)', () => {
  it('maps headlines and drops rows missing a title or a usable URL', async () => {
    const client = stubClient({
      searchNews: () =>
        Promise.resolve<YahooNewsResult>({
          news: [
            {
              uuid: 'n1',
              title: 'Apple beats expectations',
              publisher: 'Reuters',
              link: 'https://example.com/a',
              providerPublishTime: new Date('2026-06-20T08:00:00.000Z'),
            },
            { uuid: 'n2', title: '', link: 'https://example.com/b' }, // no title — dropped
            { uuid: 'n3', title: 'No link here', link: '' }, // no url — dropped
            { uuid: 'n4', title: 'Bad scheme', link: 'ftp://example.com/c' }, // non-http — dropped
          ],
        }),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });

    const headlines = await provider.getNewsHeadlines!(REF);
    expect(headlines).toEqual([
      {
        id: 'n1',
        title: 'Apple beats expectations',
        publisher: 'Reuters',
        url: 'https://example.com/a',
        publishedAt: '2026-06-20T08:00:00.000Z',
      },
    ]);
  });
});

describe('yahooProvider.getSplitEvents (§13.5 V5-P5)', () => {
  it('maps past splits ascending and drops invalid ratios', async () => {
    const client = stubClient({
      chartEvents: () =>
        Promise.resolve<YahooChartEventsResult>({
          meta: { currency: 'USD' },
          dividends: [],
          splits: [
            {
              date: new Date('2020-08-31T00:00:00.000Z'),
              numerator: 4,
              denominator: 1,
              splitRatio: '4:1',
            },
            {
              date: new Date('2014-06-09T00:00:00.000Z'),
              numerator: 7,
              denominator: 1,
              splitRatio: '7:1',
            },
            { date: new Date('2000-01-01T00:00:00.000Z'), numerator: 0, denominator: 1 }, // dropped
          ],
        }),
    });
    const provider = createYahooProvider({ client, now: () => FIXED_NOW });

    const result = await provider.getSplitEvents!(REF);
    expect(result.upcoming).toEqual([]);
    expect(result.history).toEqual([
      { date: '2014-06-09T00:00:00.000Z', numerator: 7, denominator: 1, ratio: '7:1' },
      { date: '2020-08-31T00:00:00.000Z', numerator: 4, denominator: 1, ratio: '4:1' },
    ]);
  });
});

describe('yahoo intel routes every upstream call through the queue (§5.2)', () => {
  it('dividends uses two calls (chart + summary); earnings/news/splits one each', async () => {
    const queue = countingQueue();
    const provider = createYahooProvider({ client: stubClient(), queue, now: () => FIXED_NOW });

    await provider.getDividendEvents!(REF);
    expect(queue.count).toBe(2);

    await provider.getEarningsEvents!(REF);
    await provider.getNewsHeadlines!(REF);
    await provider.getSplitEvents!(REF);
    expect(queue.count).toBe(5);
  });
});
