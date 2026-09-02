import { describe, expect, it } from 'vitest';

import type { AssetRef, DividendEvents } from '@bettertrack/contracts';

import type {
  HeldAssetHolderRow,
  HeldPositionRow,
  MarketIntelRepository,
  WatchedAssetRow,
} from '../../../data/repositories/marketIntelRepository';
import { createStubMarketData, cachedIntel } from '../../../testing/marketDataStubs';
import { FxRateUnavailableError } from '../../currency/currencyService';
import { createPortfolioMarketIntelService } from '../portfolioMarketIntelService';

/** Fixed clock inside the calendar fixtures' window. */
const NOW = Date.parse('2026-07-18T00:00:00.000Z');

/** A clock sitting BETWEEN the shared fixture's ex-date and its pay date. */
const GONE_EX_NOW = Date.parse('2026-08-12T00:00:00.000Z');

/** A currency stub: USD→EUR at 0.9, everything else 1:1 (EUR path). */
const currency = {
  convert: async (amount: number, from: string, _to: string) =>
    from === 'USD' ? amount * 0.9 : amount,
};

/** A repository stub returning fixed held + watched rows (the two reads the service uses). */
function stubRepo(opts: {
  held?: HeldPositionRow[];
  watched?: WatchedAssetRow[];
  holders?: HeldAssetHolderRow[];
}): Pick<
  MarketIntelRepository,
  'listHeldPositionsForUser' | 'listWatchlistAssetsForUser' | 'listHeldAssetHoldersAllUsers'
> {
  return {
    listHeldPositionsForUser: async () => opts.held ?? [],
    listWatchlistAssetsForUser: async () => opts.watched ?? [],
    listHeldAssetHoldersAllUsers: async () => opts.holders ?? [],
  };
}

function held(overrides: Partial<HeldPositionRow>): HeldPositionRow {
  return {
    assetId: 'asset-a',
    providerId: 'yahoo',
    providerRef: 'AAA',
    symbol: 'AAA',
    name: 'Asset A',
    currency: 'USD',
    quantity: 10,
    ...overrides,
  };
}

function watched(overrides: Partial<WatchedAssetRow>): WatchedAssetRow {
  return {
    assetId: 'asset-c',
    providerId: 'yahoo',
    providerRef: 'CCC',
    symbol: 'CCC',
    name: 'Asset C',
    currency: 'EUR',
    ...overrides,
  };
}

/** Per-ref dividend payloads, keyed by providerRef. */
function dividendsByRef(map: Record<string, DividendEvents>) {
  return (ref: AssetRef) => {
    const value = map[ref.providerRef];
    if (!value) throw new Error(`no dividends fixture for ${ref.providerRef}`);
    return cachedIntel(value);
  };
}

describe('portfolio projected dividend income (V5-P5)', () => {
  it('matches a hand-computed two-holding, two-currency fixture', async () => {
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        // 10 shares × 2.0 USD/share = 20 USD → ×0.9 = 18.00 EUR
        AAA: makeDividends({ currency: 'USD', trailingAmount: 2.0 }),
        // 5 shares × 4.0 EUR/share = 20.00 EUR
        BBB: makeDividends({ currency: 'EUR', trailingAmount: 4.0 }),
      }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({
        held: [
          held({ assetId: 'asset-a', providerRef: 'AAA', currency: 'USD', quantity: 10 }),
          held({
            assetId: 'asset-b',
            providerRef: 'BBB',
            symbol: 'BBB',
            name: 'Asset B',
            currency: 'EUR',
            quantity: 5,
          }),
        ],
      }),
      currency,
      enabled: true,
      now: () => NOW,
    });

    const result = await service.projectedIncome('user-1');

    expect(result.available).toBe(true);
    expect(result.currency).toBe('EUR');
    expect(result.yearlyTotalEur).toBe(38);
    expect(result.monthlyTotalEur).toBe(3.17); // round2(38 / 12)
    // Sorted by EUR income descending: B (20) before A (18).
    expect(result.holdings.map((h) => h.symbol)).toEqual(['BBB', 'AAA']);
    const a = result.holdings.find((h) => h.symbol === 'AAA')!;
    expect(a).toMatchObject({
      quantity: 10,
      annualPerShare: 2.0,
      currency: 'USD',
      annualIncomeEur: 18,
    });
    const b = result.holdings.find((h) => h.symbol === 'BBB')!;
    expect(b).toMatchObject({ annualIncomeEur: 20 });
  });

  it('is unavailable when one holding’s payload arrived half-filled', async () => {
    // The yahoo provider settles its chart + summary halves independently and
    // keeps the survivor; `trailingAmount` comes only from the summary half. BBB
    // demonstrably pays dividends (history + an upcoming event from the chart
    // half) but carries no per-share amount — that is a gap, not a zero, and a
    // €18 total must not be presented as this portfolio's complete income.
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        AAA: makeDividends({ currency: 'USD', trailingAmount: 2.0 }),
        BBB: makeDividends({
          currency: 'EUR',
          trailingAmount: null,
          history: [
            { exDate: '2026-02-07T00:00:00.000Z', payDate: null, amount: 0.5, currency: 'EUR' },
          ],
          upcoming: [
            {
              exDate: '2026-08-08T00:00:00.000Z',
              payDate: '2026-08-15T00:00:00.000Z',
              amount: null,
              currency: 'EUR',
            },
          ],
        }),
      }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({
        held: [
          held({ providerRef: 'AAA', currency: 'USD', quantity: 10 }),
          held({
            assetId: 'asset-b',
            providerRef: 'BBB',
            symbol: 'BBB',
            name: 'Asset B',
            currency: 'EUR',
            quantity: 5,
          }),
        ],
      }),
      currency,
      enabled: true,
      now: () => NOW,
    });

    await expect(service.projectedIncome('user-1')).resolves.toEqual({
      available: false,
      currency: 'EUR',
      monthlyTotalEur: 0,
      yearlyTotalEur: 0,
      holdings: [],
    });
  });

  it('is unavailable when one holding’s dividend fetch throws', async () => {
    const marketData = createStubMarketData({
      dividends: (ref: AssetRef) => {
        if (ref.providerRef === 'BBB') throw new Error('upstream 429');
        return cachedIntel(makeDividends({ currency: 'USD', trailingAmount: 2.0 }));
      },
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({
        held: [
          held({ providerRef: 'AAA', currency: 'USD', quantity: 10 }),
          held({
            assetId: 'asset-b',
            providerRef: 'BBB',
            symbol: 'BBB',
            name: 'Asset B',
            currency: 'EUR',
            quantity: 5,
          }),
        ],
      }),
      currency,
      enabled: true,
      now: () => NOW,
    });

    await expect(service.projectedIncome('user-1')).resolves.toEqual({
      available: false,
      currency: 'EUR',
      monthlyTotalEur: 0,
      yearlyTotalEur: 0,
      holdings: [],
    });
  });

  it('stays available when the only gap is a holding that pays no dividend at all', async () => {
    // Nothing in the payload — no history, no upcoming, no trailing amount — is
    // a resolved zero (a non-payer), not a half-failure. The dividend-paying
    // holding's income is still complete and must render.
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        AAA: makeDividends({ currency: 'USD', trailingAmount: 2.0 }),
        BBB: makeDividends({ currency: 'EUR', trailingAmount: null }),
      }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({
        held: [
          held({ providerRef: 'AAA', currency: 'USD', quantity: 10 }),
          held({
            assetId: 'asset-b',
            providerRef: 'BBB',
            symbol: 'BBB',
            name: 'Asset B',
            currency: 'EUR',
            quantity: 5,
          }),
        ],
      }),
      currency,
      enabled: true,
      now: () => NOW,
    });

    const result = await service.projectedIncome('user-1');

    expect(result.available).toBe(true);
    expect(result.yearlyTotalEur).toBe(18);
    expect(result.holdings.map((h) => h.symbol)).toEqual(['AAA']);
  });

  it('skips a holding with no known forward dividend', async () => {
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        AAA: makeDividends({ currency: 'USD', trailingAmount: null }),
      }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({ held: [held({ providerRef: 'AAA' })] }),
      currency,
      enabled: true,
      now: () => NOW,
    });

    const result = await service.projectedIncome('user-1');
    expect(result.holdings).toHaveLength(0);
    expect(result.yearlyTotalEur).toBe(0);
  });

  it('is unavailable + empty when the gate is off (invisible when unconfigured)', async () => {
    const marketData = createStubMarketData({
      dividends: dividendsByRef({ AAA: makeDividends({ trailingAmount: 2 }) }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({ held: [held({ providerRef: 'AAA' })] }),
      currency,
      enabled: false,
      now: () => NOW,
    });

    const result = await service.projectedIncome('user-1');
    expect(result).toEqual({
      available: false,
      currency: 'EUR',
      monthlyTotalEur: 0,
      yearlyTotalEur: 0,
      holdings: [],
    });
  });

  it('returns the unavailable projection when FX is unavailable instead of throwing', async () => {
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        AAA: makeDividends({ currency: 'USD', trailingAmount: 2 }),
      }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({ held: [held({ providerRef: 'AAA', quantity: 10 })] }),
      currency: {
        convert: async () => {
          throw new FxRateUnavailableError('USD', 'EUR', null, 'EURUSD=X is unavailable');
        },
      },
      enabled: true,
      now: () => NOW,
    });

    await expect(service.projectedIncome('user-1')).resolves.toEqual({
      available: false,
      currency: 'EUR',
      monthlyTotalEur: 0,
      yearlyTotalEur: 0,
      holdings: [],
    });
  });

  it('resolves other holdings before applying all-or-nothing FX degradation', async () => {
    const successfulConversions: number[] = [];
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        AAA: makeDividends({ currency: 'USD', trailingAmount: 2 }),
        BBB: makeDividends({ currency: 'EUR', trailingAmount: 4 }),
      }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({
        held: [
          held({ providerRef: 'AAA', quantity: 10 }),
          held({
            assetId: 'asset-b',
            providerRef: 'BBB',
            symbol: 'BBB',
            name: 'Asset B',
            currency: 'EUR',
            quantity: 5,
          }),
        ],
      }),
      currency: {
        convert: async (amount: number, from: string) => {
          if (from === 'USD') {
            throw new FxRateUnavailableError('USD', 'EUR', null, 'EURUSD=X is unavailable');
          }
          successfulConversions.push(amount);
          return amount;
        },
      },
      enabled: true,
      now: () => NOW,
    });

    const result = await service.projectedIncome('user-1');

    expect(successfulConversions).toEqual([20]);
    expect(result).toEqual({
      available: false,
      currency: 'EUR',
      monthlyTotalEur: 0,
      yearlyTotalEur: 0,
      holdings: [],
    });
  });

  it('returns the unavailable projection when a non-ISO dividend currency rejects conversion', async () => {
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        AAA: makeDividends({ currency: 'NOT-ISO', trailingAmount: 2 }),
      }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({ held: [held({ providerRef: 'AAA', quantity: 10 })] }),
      currency: {
        convert: async () => {
          throw new Error('Invalid currency code: "NOT-ISO"');
        },
      },
      enabled: true,
      now: () => NOW,
    });

    await expect(service.projectedIncome('user-1')).resolves.toEqual({
      available: false,
      currency: 'EUR',
      monthlyTotalEur: 0,
      yearlyTotalEur: 0,
      holdings: [],
    });
  });
});

describe('portfolio dividend calendar (V5-P5)', () => {
  it('lists upcoming ex/pay events for held + watchlist assets, chronologically', async () => {
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        AAA: makeDividends({
          currency: 'USD',
          upcoming: [
            {
              exDate: '2026-08-08T00:00:00.000Z',
              payDate: '2026-08-15T00:00:00.000Z',
              amount: 0.25,
              currency: 'USD',
            },
          ],
        }),
        CCC: makeDividends({
          currency: 'EUR',
          upcoming: [
            { exDate: '2026-07-25T00:00:00.000Z', payDate: null, amount: 1.1, currency: 'EUR' },
          ],
        }),
      }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({
        held: [held({ assetId: 'asset-a', providerRef: 'AAA' })],
        watched: [watched({ assetId: 'asset-c', providerRef: 'CCC' })],
      }),
      currency,
      enabled: true,
      now: () => NOW,
    });

    const result = await service.dividendCalendar('user-1');
    expect(result.available).toBe(true);
    // Chronological by earliest date: CCC (07-25) before AAA (08-08).
    expect(result.entries.map((e) => e.symbol)).toEqual(['CCC', 'AAA']);
    expect(result.entries[0]).toMatchObject({
      source: 'watchlist',
      assetId: 'asset-c',
      amount: 1.1,
    });
    expect(result.entries[1]).toMatchObject({ source: 'holding', assetId: 'asset-a' });
  });

  it('drops past events and assets without the dividends capability', async () => {
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        AAA: makeDividends({
          upcoming: [
            // Past — excluded.
            { exDate: '2026-01-01T00:00:00.000Z', payDate: null, amount: 0.1, currency: 'USD' },
            // Future — included.
            { exDate: '2026-09-01T00:00:00.000Z', payDate: null, amount: 0.2, currency: 'USD' },
          ],
        }),
      }),
      // AAA has dividends; the watchlisted NOCAP asset does not.
      intelCapabilities: (ref) => ({
        dividends: ref.providerRef === 'AAA',
        earnings: false,
        news: false,
        splits: false,
      }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({
        held: [held({ assetId: 'asset-a', providerRef: 'AAA' })],
        watched: [watched({ assetId: 'asset-x', providerRef: 'NOCAP', symbol: 'NOCAP' })],
      }),
      currency,
      enabled: true,
      now: () => NOW,
    });

    const result = await service.dividendCalendar('user-1');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ exDate: '2026-09-01T00:00:00.000Z' });
  });

  it('keeps an event that has gone ex but is not yet paid, and drops a fully past one', async () => {
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        AAA: makeDividends({
          currency: 'USD',
          upcoming: [
            // Gone ex four days ago, pays in three — the payout is still ahead
            // of the holder, so the calendar must keep it.
            {
              exDate: '2026-08-08T00:00:00.000Z',
              payDate: '2026-08-15T00:00:00.000Z',
              amount: 0.25,
              currency: 'USD',
            },
            // Ex AND pay behind us — nothing left to show.
            {
              exDate: '2026-07-01T00:00:00.000Z',
              payDate: '2026-07-10T00:00:00.000Z',
              amount: 0.24,
              currency: 'USD',
            },
          ],
        }),
      }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({ held: [held({ assetId: 'asset-a', providerRef: 'AAA' })] }),
      currency,
      enabled: true,
      now: () => GONE_EX_NOW,
    });

    const result = await service.dividendCalendar('user-1');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      assetId: 'asset-a',
      exDate: '2026-08-08T00:00:00.000Z',
      payDate: '2026-08-15T00:00:00.000Z',
    });
  });

  it('orders on the earliest still-future date, so a gone-ex event sorts on its pay date', async () => {
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        AAA: makeDividends({
          currency: 'USD',
          upcoming: [
            {
              exDate: '2026-08-08T00:00:00.000Z',
              payDate: '2026-08-15T00:00:00.000Z',
              amount: 0.25,
              currency: 'USD',
            },
          ],
        }),
        CCC: makeDividends({
          currency: 'EUR',
          upcoming: [
            { exDate: '2026-08-13T00:00:00.000Z', payDate: null, amount: 1.1, currency: 'EUR' },
          ],
        }),
      }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({
        held: [held({ assetId: 'asset-a', providerRef: 'AAA' })],
        watched: [watched({ assetId: 'asset-c', providerRef: 'CCC' })],
      }),
      currency,
      enabled: true,
      now: () => GONE_EX_NOW,
    });

    const result = await service.dividendCalendar('user-1');
    // AAA's ex-date (08-08) is the smaller literal but it is already behind us;
    // its operative date is the 08-15 payout, which falls AFTER CCC's 08-13.
    expect(result.entries.map((e) => e.symbol)).toEqual(['CCC', 'AAA']);
  });

  it('is unavailable + empty when the gate is off', async () => {
    const marketData = createStubMarketData({
      dividends: dividendsByRef({ AAA: makeDividends({}) }),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({ held: [held({ providerRef: 'AAA' })] }),
      currency,
      enabled: false,
      now: () => NOW,
    });

    expect(await service.dividendCalendar('user-1')).toEqual({ available: false, entries: [] });
  });
});

/** A minimal {@link DividendEvents} payload, overridable per field. */
function makeDividends(overrides: Partial<DividendEvents>): DividendEvents {
  return {
    currency: 'USD',
    history: [],
    upcoming: [],
    forwardYield: null,
    trailingAmount: null,
    ...overrides,
  };
}
