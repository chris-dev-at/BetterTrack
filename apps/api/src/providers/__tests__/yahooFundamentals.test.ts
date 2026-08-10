import type { AssetRef } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type { RequestQueue } from '../requestQueue';
import type { YahooClient, YahooQuoteSummaryResult } from '../yahooClient';
import { createYahooProvider } from '../yahooProvider';

/**
 * Provider-level mapping for the fundamentals arc (INTEL1, board #76). A fixtured
 * `quoteSummary` response is mapped through `getFundamentals` into the
 * {@link import('@bettertrack/contracts').AssetFundamentals} contract — proving
 * the statement histories merge by period-end date, order most-recent-first,
 * derive free cash flow, and populate the snapshot ratios + reporting currency.
 */

const REF: AssetRef = { providerId: 'yahoo', providerRef: 'AAPL' };
const FIXED_NOW = Date.parse('2026-06-22T12:00:00.000Z');

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

/** A full fundamentals fixture: two annual periods (deliberately oldest-first) + one quarter. */
function fundamentalsSummary(): YahooQuoteSummaryResult {
  return {
    financialData: {
      financialCurrency: 'USD',
      profitMargins: 0.24,
      returnOnEquity: 1.47,
      debtToEquity: 145,
    },
    defaultKeyStatistics: { trailingEps: 6.12, forwardEps: 7.3, priceToBook: 48.2 },
    summaryDetail: {
      currency: 'USD',
      marketCap: 3_100_000_000_000,
      trailingPE: 32.4,
      forwardPE: 29.1,
    },
    incomeStatementHistory: {
      // Oldest first on purpose — the mapper must return most-recent-first.
      incomeStatementHistory: [
        {
          endDate: new Date('2023-09-30T00:00:00.000Z'),
          totalRevenue: 383_285_000_000,
          grossProfit: 169_148_000_000,
          operatingIncome: 114_301_000_000,
          netIncome: 96_995_000_000,
        },
        {
          endDate: new Date('2024-09-28T00:00:00.000Z'),
          totalRevenue: 391_035_000_000,
          grossProfit: 180_683_000_000,
          operatingIncome: 123_216_000_000,
          netIncome: 93_736_000_000,
        },
      ],
    },
    balanceSheetHistory: {
      balanceSheetStatements: [
        {
          endDate: new Date('2024-09-28T00:00:00.000Z'),
          totalAssets: 364_980_000_000,
          totalLiab: 308_030_000_000,
          totalStockholderEquity: 56_950_000_000,
        },
      ],
    },
    cashflowStatementHistory: {
      cashflowStatements: [
        {
          endDate: new Date('2024-09-28T00:00:00.000Z'),
          totalCashFromOperatingActivities: 118_254_000_000,
          capitalExpenditures: -9_447_000_000, // Yahoo reports capex as a negative outflow.
        },
      ],
    },
    incomeStatementHistoryQuarterly: {
      incomeStatementHistory: [
        {
          endDate: new Date('2026-03-28T00:00:00.000Z'),
          totalRevenue: 90_753_000_000,
          grossProfit: 40_000_000_000,
          operatingIncome: 27_000_000_000,
          netIncome: 23_636_000_000,
        },
      ],
    },
  };
}

describe('yahooProvider.getFundamentals (arc f / INTEL1)', () => {
  it('maps both granularities, merges statements by end-date, and orders most-recent-first', async () => {
    const provider = createYahooProvider({
      client: stubClient({ quoteSummary: () => Promise.resolve(fundamentalsSummary()) }),
      now: () => FIXED_NOW,
    });

    const result = await provider.getFundamentals!(REF);
    expect(result.currency).toBe('USD');

    // Annual: most-recent-first (2024 before 2023), income+balance+cashflow merged.
    expect(result.annual).toHaveLength(2);
    const [fy2024, fy2023] = result.annual;
    expect(fy2024).toMatchObject({
      fiscalPeriod: 'FY',
      fiscalYear: 2024,
      endDate: '2024-09-28T00:00:00.000Z',
      reportDate: null,
      revenue: 391_035_000_000,
      grossProfit: 180_683_000_000,
      operatingIncome: 123_216_000_000,
      netIncome: 93_736_000_000,
      eps: null,
      totalAssets: 364_980_000_000,
      totalLiabilities: 308_030_000_000,
      totalEquity: 56_950_000_000,
      operatingCashFlow: 118_254_000_000,
      // freeCashFlow = operating + capex (capex negative).
      freeCashFlow: 118_254_000_000 - 9_447_000_000,
    });
    // 2023 has income only — balance/cashflow stay null (no fabricated zeros).
    expect(fy2023).toMatchObject({
      fiscalYear: 2023,
      revenue: 383_285_000_000,
      totalAssets: null,
      operatingCashFlow: null,
      freeCashFlow: null,
    });

    // Quarterly: fiscalPeriod derived from the period-end month (March → Q1).
    expect(result.quarterly).toHaveLength(1);
    expect(result.quarterly[0]).toMatchObject({
      fiscalPeriod: 'Q1',
      fiscalYear: 2026,
      endDate: '2026-03-28T00:00:00.000Z',
      revenue: 90_753_000_000,
      netIncome: 23_636_000_000,
    });
  });

  it('maps snapshot ratios from summaryDetail + financialData + defaultKeyStatistics', async () => {
    const provider = createYahooProvider({
      client: stubClient({ quoteSummary: () => Promise.resolve(fundamentalsSummary()) }),
      now: () => FIXED_NOW,
    });

    const { ratios } = await provider.getFundamentals!(REF);
    expect(ratios).toEqual({
      marketCap: 3_100_000_000_000,
      trailingPe: 32.4,
      forwardPe: 29.1,
      priceToBook: 48.2,
      profitMargin: 0.24,
      returnOnEquity: 1.47,
      debtToEquity: 145,
      trailingEps: 6.12,
      forwardEps: 7.3,
    });
  });

  it('degrades to empty periods + all-null ratios + null currency when Yahoo returns nothing', async () => {
    const provider = createYahooProvider({
      client: stubClient({ quoteSummary: () => Promise.resolve({}) }),
      now: () => FIXED_NOW,
    });

    const result = await provider.getFundamentals!(REF);
    expect(result).toEqual({
      currency: null,
      annual: [],
      quarterly: [],
      ratios: {
        marketCap: null,
        trailingPe: null,
        forwardPe: null,
        priceToBook: null,
        profitMargin: null,
        returnOnEquity: null,
        debtToEquity: null,
        trailingEps: null,
        forwardEps: null,
      },
    });
  });

  it('routes the single quoteSummary fetch through the queue (§5.2)', async () => {
    const queue = countingQueue();
    const provider = createYahooProvider({
      client: stubClient({ quoteSummary: () => Promise.resolve(fundamentalsSummary()) }),
      queue,
      now: () => FIXED_NOW,
    });

    await provider.getFundamentals!(REF);
    expect(queue.count).toBe(1);
  });
});
