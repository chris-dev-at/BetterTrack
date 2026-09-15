import { describe, expect, it } from 'vitest';

import type { AssetRef, DividendEvents } from '@bettertrack/contracts';

import type {
  HeldAssetHolderRow,
  HeldPositionRow,
  MarketIntelRepository,
  WatchedAssetRow,
} from '../../../data/repositories/marketIntelRepository';
import { createStubMarketData, cachedIntel } from '../../../testing/marketDataStubs';
import { createCurrencyService, FxRateUnavailableError } from '../../currency/currencyService';
import type { CurrencyService } from '../../currency/currencyService';
import { createPortfolioMarketIntelService } from '../portfolioMarketIntelService';
import { MARKET_INTEL_ROLLUP_MAX_ASSETS } from '../rollupBudget';

/** Fixed clock inside the calendar fixtures' window. */
const NOW = Date.parse('2026-07-18T00:00:00.000Z');

/** A clock sitting BETWEEN the shared fixture's ex-date and its pay date. */
const GONE_EX_NOW = Date.parse('2026-08-12T00:00:00.000Z');

/**
 * A currency view stub honouring the §5.4 base parameter: `toBase` delegates to
 * `convert`, and `withBase` hands back the same conversion pinned to another
 * base, exactly as {@link CurrencyService.withBase} does.
 */
function stubCurrency(
  convert: (amount: number, from: string, to: string) => Promise<number>,
  base = 'EUR',
): Pick<CurrencyService, 'baseCurrency' | 'toBase' | 'withBase'> {
  const view = (baseCurrency: string): CurrencyService => ({
    baseCurrency,
    getRate: async () => {
      throw new Error('getRate is not part of the projection path');
    },
    convert,
    toBase: (amount, from) => convert(amount, from, baseCurrency),
    withBase: (next) => view(next),
  });
  return view(base);
}

/** A currency stub: USD→EUR at 0.9, everything else 1:1 (EUR path). */
const currency = stubCurrency(async (amount: number, from: string) =>
  from === 'USD' ? amount * 0.9 : amount,
);

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
    expect(result.yearlyTotalBase).toBe(38);
    expect(result.monthlyTotalBase).toBe(3.17); // round2(38 / 12)
    // Sorted by EUR income descending: B (20) before A (18).
    expect(result.holdings.map((h) => h.symbol)).toEqual(['BBB', 'AAA']);
    const a = result.holdings.find((h) => h.symbol === 'AAA')!;
    expect(a).toMatchObject({
      quantity: 10,
      annualPerShare: 2.0,
      currency: 'USD',
      annualIncomeBase: 18,
    });
    const b = result.holdings.find((h) => h.symbol === 'BBB')!;
    expect(b).toMatchObject({ annualIncomeBase: 20 });
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
      monthlyTotalBase: 0,
      yearlyTotalBase: 0,
      basis: null,
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
      monthlyTotalBase: 0,
      yearlyTotalBase: 0,
      basis: null,
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
    expect(result.yearlyTotalBase).toBe(18);
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
    expect(result.yearlyTotalBase).toBe(0);
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
      monthlyTotalBase: 0,
      yearlyTotalBase: 0,
      basis: null,
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
      currency: stubCurrency(async () => {
        throw new FxRateUnavailableError('USD', 'EUR', null, 'EURUSD=X is unavailable');
      }),
      enabled: true,
      now: () => NOW,
    });

    await expect(service.projectedIncome('user-1')).resolves.toEqual({
      available: false,
      currency: 'EUR',
      monthlyTotalBase: 0,
      yearlyTotalBase: 0,
      basis: null,
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
      currency: stubCurrency(async (amount: number, from: string) => {
        if (from === 'USD') {
          throw new FxRateUnavailableError('USD', 'EUR', null, 'EURUSD=X is unavailable');
        }
        successfulConversions.push(amount);
        return amount;
      }),
      enabled: true,
      now: () => NOW,
    });

    const result = await service.projectedIncome('user-1');

    expect(successfulConversions).toEqual([20]);
    expect(result).toEqual({
      available: false,
      currency: 'EUR',
      monthlyTotalBase: 0,
      yearlyTotalBase: 0,
      basis: null,
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
      currency: stubCurrency(async () => {
        throw new Error('Invalid currency code: "NOT-ISO"');
      }),
      enabled: true,
      now: () => NOW,
    });

    await expect(service.projectedIncome('user-1')).resolves.toEqual({
      available: false,
      currency: 'EUR',
      monthlyTotalBase: 0,
      yearlyTotalBase: 0,
      basis: null,
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

  it('drops an event whose only date is yesterday in the DISPLAY zone (#1827)', async () => {
    // 23:30 UTC is 01:30 the next day in Europe/Vienna — the zone every one of
    // these dates is rendered in (§7.1). Measured on the UTC day, the calendar
    // served a payout that went ex yesterday under "Upcoming dividends" for the
    // two hours after local midnight, every night.
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        AAA: makeDividends({
          currency: 'USD',
          upcoming: [
            {
              exDate: '2026-09-05T00:00:00.000Z',
              payDate: null,
              amount: 0.25,
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
      now: () => Date.parse('2026-09-05T23:30:00.000Z'),
    });

    expect((await service.dividendCalendar('user-1')).entries).toEqual([]);
  });

  it('keeps an event dated today in the display zone at that same instant', async () => {
    const marketData = createStubMarketData({
      dividends: dividendsByRef({
        AAA: makeDividends({
          currency: 'USD',
          upcoming: [
            {
              exDate: '2026-09-06T00:00:00.000Z',
              payDate: null,
              amount: 0.25,
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
      now: () => Date.parse('2026-09-05T23:30:00.000Z'),
    });

    expect((await service.dividendCalendar('user-1')).entries).toHaveLength(1);
  });
});

describe('portfolio roll-ups — provider fan-out budget (§5.3)', () => {
  /** A book of `count` held positions, symbols H000…, each paying 1.0/share. */
  const heldBook = (count: number) =>
    Array.from({ length: count }, (_, i) => {
      const suffix = String(i).padStart(3, '0');
      return held({
        assetId: `asset-h${suffix}`,
        providerId: 'yahoo',
        providerRef: `H${suffix}`,
        symbol: `H${suffix}`,
        name: `Held ${suffix}`,
        currency: 'EUR',
        quantity: 1,
      });
    });

  it('dividendCalendar caps the provider calls for a 200-asset book and says it truncated', async () => {
    const marketData = createStubMarketData({
      dividends: () =>
        cachedIntel(
          makeDividends({
            currency: 'EUR',
            upcoming: [
              {
                exDate: '2026-07-20T00:00:00.000Z',
                payDate: '2026-07-27T00:00:00.000Z',
                amount: 1,
                currency: 'EUR',
              },
            ],
          }),
        ),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({ held: heldBook(200) }),
      currency,
      enabled: true,
      now: () => NOW,
    });

    const result = await service.dividendCalendar('user-1');
    expect(marketData.calls.dividends).toBe(MARKET_INTEL_ROLLUP_MAX_ASSETS);
    expect(result.entries).toHaveLength(MARKET_INTEL_ROLLUP_MAX_ASSETS);
    expect(result.truncated).toBe(true);
    // Deterministic selection: the alphabetically first held symbols.
    expect(result.entries.map((e) => e.symbol).sort()).toEqual(
      heldBook(MARKET_INTEL_ROLLUP_MAX_ASSETS).map((row) => row.symbol),
    );
  });

  it('dividendCalendar keeps held positions over watch-only assets when it truncates', async () => {
    const fetched: string[] = [];
    const marketData = createStubMarketData({
      dividends: (ref: AssetRef) => {
        fetched.push(ref.providerRef);
        return cachedIntel(makeDividends({ currency: 'EUR' }));
      },
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      // One held row sorting LAST alphabetically, plus a full cap of watchlist.
      repo: stubRepo({
        held: [
          held({
            assetId: 'asset-zzz',
            providerRef: 'ZZZ',
            symbol: 'ZZZ',
            name: 'Held last alphabetically',
            currency: 'EUR',
          }),
        ],
        watched: Array.from({ length: MARKET_INTEL_ROLLUP_MAX_ASSETS }, (_, i) => {
          const suffix = String(i).padStart(3, '0');
          return watched({
            assetId: `asset-w${suffix}`,
            providerRef: `W${suffix}`,
            symbol: `W${suffix}`,
            name: `Watched ${suffix}`,
          });
        }),
      }),
      currency,
      enabled: true,
      now: () => NOW,
    });

    await service.dividendCalendar('user-1');
    expect(marketData.calls.dividends).toBe(MARKET_INTEL_ROLLUP_MAX_ASSETS);
    // The held asset survives even though its symbol sorts after every W###,
    // and the last watch-only row is the one dropped to make room for it.
    expect(fetched).toContain('ZZZ');
    expect(fetched).not.toContain(
      `W${String(MARKET_INTEL_ROLLUP_MAX_ASSETS - 1).padStart(3, '0')}`,
    );
  });

  it('projectedIncome refuses an over-cap book without spending any provider budget', async () => {
    const marketData = createStubMarketData({
      dividends: () => cachedIntel(makeDividends({ currency: 'EUR', trailingAmount: 1 })),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({ held: heldBook(200) }),
      currency,
      enabled: true,
      now: () => NOW,
    });

    // All-or-nothing (#1616): a book too large to cover can never produce a
    // publishable total, so it is refused before the fan-out, not after.
    await expect(service.projectedIncome('user-1')).resolves.toEqual({
      available: false,
      currency: 'EUR',
      monthlyTotalBase: 0,
      yearlyTotalBase: 0,
      basis: null,
      holdings: [],
      truncated: true,
    });
    expect(marketData.calls.dividends).toBe(0);
  });

  it('a book exactly at the cap still resolves completely, with no truncation marker', async () => {
    const marketData = createStubMarketData({
      dividends: () => cachedIntel(makeDividends({ currency: 'EUR', trailingAmount: 1 })),
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({ held: heldBook(MARKET_INTEL_ROLLUP_MAX_ASSETS) }),
      currency,
      enabled: true,
      now: () => NOW,
    });

    const result = await service.projectedIncome('user-1');
    expect(result.available).toBe(true);
    expect(result.truncated).toBeUndefined();
    expect(result.holdings).toHaveLength(MARKET_INTEL_ROLLUP_MAX_ASSETS);
    expect(result.yearlyTotalBase).toBe(MARKET_INTEL_ROLLUP_MAX_ASSETS);
  });

  it('an UNRESOLVED holding inside the cap still hides the projection, and is not "truncated"', async () => {
    // #1616's guarantee, kept distinguishable from the new cap refusal above.
    const marketData = createStubMarketData({
      dividends: (ref: AssetRef) => {
        if (ref.providerRef === 'H001') throw new Error('upstream 429');
        return cachedIntel(makeDividends({ currency: 'EUR', trailingAmount: 1 }));
      },
    });
    const service = createPortfolioMarketIntelService({
      marketData,
      repo: stubRepo({ held: heldBook(3) }),
      currency,
      enabled: true,
      now: () => NOW,
    });

    await expect(service.projectedIncome('user-1')).resolves.toEqual({
      available: false,
      currency: 'EUR',
      monthlyTotalBase: 0,
      yearlyTotalBase: 0,
      basis: null,
      holdings: [],
    });
  });
});

/** A minimal {@link DividendEvents} payload, overridable per field. */
function makeDividends(overrides: Partial<DividendEvents>): DividendEvents {
  const merged = {
    currency: 'USD',
    history: [],
    upcoming: [],
    forwardYield: null,
    trailingAmount: null,
    trailingAmountBasis: null,
    ...overrides,
  } satisfies DividendEvents;
  // Contract invariant: the basis is null exactly when the amount is. Derived
  // here so a fixture that names only an amount stays a VALID payload — but an
  // EXPLICIT basis (including an invariant-breaking null) always wins, so a test
  // can still hand the service a malformed payload on purpose.
  return {
    ...merged,
    trailingAmountBasis:
      'trailingAmountBasis' in overrides
        ? (overrides.trailingAmountBasis ?? null)
        : merged.trailingAmount == null
          ? null
          : 'trailing-12m',
  };
}

describe('projected dividend income — denomination (§5.4, #1741)', () => {
  /**
   * A real {@link createCurrencyService} over a counting rate source. Using the
   * genuine keystone (rather than a hand-stub) is what makes "converted exactly
   * once, through services/currency" assertable: `asked` records every pair the
   * projection ever needed, so a double conversion (`USD→EUR→CHF`) or a missed
   * one (an empty list beside a cross-currency holding) both fail the test.
   */
  function countingFx(rates: Record<string, number>) {
    const asked: string[] = [];
    const service = createCurrencyService({
      source: {
        getSpotRate: async (from: string, to: string) => {
          asked.push(`${from}>${to}`);
          const rate = rates[`${from}>${to}`];
          if (rate === undefined) {
            throw new FxRateUnavailableError(from, to, null, `no stub rate for ${from}>${to}`);
          }
          return rate;
        },
        getHistoricalRate: async () => {
          throw new Error('the projection converts at spot only');
        },
      },
    });
    return { asked, service };
  }

  /** One USD payer: 10 shares × 2.00 USD/share = 20.00 USD before conversion. */
  function usdPayerService(fx: ReturnType<typeof countingFx>['service']) {
    return createPortfolioMarketIntelService({
      marketData: createStubMarketData({
        dividends: dividendsByRef({
          AAA: makeDividends({ currency: 'USD', trailingAmount: 2.0 }),
        }),
      }),
      repo: stubRepo({ held: [held({ providerRef: 'AAA', currency: 'USD', quantity: 10 })] }),
      currency: fx,
      enabled: true,
      now: () => NOW,
    });
  }

  it('answers a USD-base caller in USD, at the stubbed rate', async () => {
    const { asked, service: fx } = countingFx({ 'USD>USD': 1, 'USD>EUR': 0.9 });
    const result = await usdPayerService(fx).projectedIncome('user-1', { baseCurrency: 'USD' });

    expect(result.currency).toBe('USD');
    // The dividend currency IS the base: an identity conversion, no rate asked.
    expect(result.yearlyTotalBase).toBe(20);
    expect(result.monthlyTotalBase).toBe(1.67); // round2(20 / 12)
    expect(result.holdings[0]).toMatchObject({ currency: 'USD', annualIncomeBase: 20 });
    expect(asked).toEqual([]);
  });

  it('answers a CHF-base caller in CHF, converting each holding exactly once', async () => {
    const { asked, service: fx } = countingFx({ 'USD>CHF': 0.9 });
    const result = await usdPayerService(fx).projectedIncome('user-1', { baseCurrency: 'CHF' });

    expect(result.currency).toBe('CHF');
    // 20.00 USD × 0.9 = 18.00 CHF — exact, not merely "not the EUR number".
    expect(result.yearlyTotalBase).toBe(18);
    expect(result.monthlyTotalBase).toBe(1.5);
    expect(result.holdings[0]).toMatchObject({
      currency: 'USD',
      annualPerShare: 2,
      annualIncomeBase: 18,
    });
    // Exactly one pair, straight from native to base: a relay through EUR would
    // read ['USD>EUR', 'EUR>CHF'], and a missed conversion would read [].
    expect(asked).toEqual(['USD>CHF']);
  });

  it('is a passthrough for a EUR-base caller — byte-identical to the un-based read', async () => {
    const { asked, service: fx } = countingFx({ 'USD>EUR': 0.9 });
    const service = createPortfolioMarketIntelService({
      marketData: createStubMarketData({
        dividends: dividendsByRef({
          AAA: makeDividends({ currency: 'USD', trailingAmount: 2.0 }),
          BBB: makeDividends({ currency: 'EUR', trailingAmount: 4.0 }),
        }),
      }),
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
      currency: fx,
      enabled: true,
      now: () => NOW,
    });

    const explicit = await service.projectedIncome('user-1', { baseCurrency: 'EUR' });
    const implicit = await service.projectedIncome('user-1');

    // The pre-#1741 numbers, unchanged: 18.00 + 20.00 = 38.00 €/yr.
    expect(explicit.currency).toBe('EUR');
    expect(explicit.yearlyTotalBase).toBe(38);
    expect(explicit.monthlyTotalBase).toBe(3.17);
    // Same bytes on the wire either way — the base is a passthrough, never a
    // re-rating of the default.
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(implicit));
    // Only the USD holding ever needed a rate, once per read.
    expect(asked).toEqual(['USD>EUR', 'USD>EUR']);
  });

  it('names the caller’s base on the unavailable shape too (gate off)', async () => {
    const { service: fx } = countingFx({});
    const service = createPortfolioMarketIntelService({
      marketData: createStubMarketData({
        dividends: dividendsByRef({ AAA: makeDividends({ trailingAmount: 2 }) }),
      }),
      repo: stubRepo({ held: [held({ providerRef: 'AAA' })] }),
      currency: fx,
      enabled: false,
      now: () => NOW,
    });

    await expect(service.projectedIncome('user-1', { baseCurrency: 'USD' })).resolves.toEqual({
      available: false,
      currency: 'USD',
      monthlyTotalBase: 0,
      yearlyTotalBase: 0,
      basis: null,
      holdings: [],
    });
  });

  it('carries the per-share basis onto each holding', async () => {
    const { service: fx } = countingFx({});
    const service = createPortfolioMarketIntelService({
      marketData: createStubMarketData({
        dividends: dividendsByRef({
          AAA: makeDividends({
            currency: 'EUR',
            trailingAmount: 2,
            trailingAmountBasis: 'forward-annualized',
          }),
        }),
      }),
      repo: stubRepo({ held: [held({ providerRef: 'AAA', currency: 'EUR', quantity: 10 })] }),
      currency: fx,
      enabled: true,
      now: () => NOW,
    });

    const result = await service.projectedIncome('user-1');
    expect(result.holdings[0]).toMatchObject({ annualPerShareBasis: 'forward-annualized' });
  });

  it('treats a per-share amount with no basis as a gap, not a trusted number', async () => {
    const { service: fx } = countingFx({});
    const service = createPortfolioMarketIntelService({
      marketData: createStubMarketData({
        dividends: dividendsByRef({
          // A payload that breaks the contract invariant: an amount nobody can
          // describe. The two bases differ by a large factor after a special
          // dividend, so it must not silently become twelve months of income.
          AAA: makeDividends({
            currency: 'EUR',
            trailingAmount: 2,
            trailingAmountBasis: null,
          }),
        }),
      }),
      repo: stubRepo({ held: [held({ providerRef: 'AAA', currency: 'EUR', quantity: 10 })] }),
      currency: fx,
      enabled: true,
      now: () => NOW,
    });

    await expect(service.projectedIncome('user-1')).resolves.toEqual({
      available: false,
      currency: 'EUR',
      monthlyTotalBase: 0,
      yearlyTotalBase: 0,
      basis: null,
      holdings: [],
    });
  });
});

describe('projected dividend income — the basis the total is made of (#1790)', () => {
  /** The projection over one EUR book, with no FX in the way. */
  function serviceFor(
    dividends: Record<string, DividendEvents>,
    quantities: Record<string, number>,
  ) {
    return createPortfolioMarketIntelService({
      marketData: createStubMarketData({ dividends: dividendsByRef(dividends) }),
      repo: stubRepo({
        held: Object.entries(quantities).map(([providerRef, quantity], i) =>
          held({
            assetId: `asset-${i}`,
            providerRef,
            symbol: providerRef,
            currency: 'EUR',
            quantity,
          }),
        ),
      }),
      currency,
      enabled: true,
      now: () => NOW,
    });
  }

  it('names the single basis every contributing holding shared', async () => {
    const service = serviceFor(
      {
        AAA: makeDividends({
          currency: 'EUR',
          trailingAmount: 2,
          trailingAmountBasis: 'forward-annualized',
        }),
      },
      { AAA: 10 },
    );
    const result = await service.projectedIncome('user-1');
    expect(result.yearlyTotalBase).toBe(20);
    expect(result.basis).toBe('forward-annualized');
  });

  it('publishes a special-inflated trailing figure WITH its basis, rather than as forward income', async () => {
    // The (b) scenario: 1,000 shares of a name that paid a $15 special beside
    // its $4.64 regular payout. The provider reports the realized TTM sum, so
    // the projection is ~4.2× the true forward figure — and for a year the
    // surfaces called it "projected dividend income" with nothing beside it.
    // The number is not re-picked (some providers give only this one); it is
    // published with what it is, and the UI renders that.
    const service = serviceFor(
      {
        SPCL: makeDividends({
          currency: 'EUR',
          trailingAmount: 19.64,
          trailingAmountBasis: 'trailing-12m',
        }),
      },
      { SPCL: 1000 },
    );
    const result = await service.projectedIncome('user-1');
    expect(result.yearlyTotalBase).toBe(19_640);
    expect(result.monthlyTotalBase).toBeCloseTo(1636.67, 2);
    expect(result.basis).toBe('trailing-12m');
  });

  it('calls a book that mixes the two bases mixed, and still totals it', async () => {
    // Providers populate whichever annual per-share field they have, so a real
    // book legitimately sums a realized TTM holding and a forward-annualized
    // one. Refusing the total would blank the figure for most books; presenting
    // it as one kind of number was the defect. It says "mixed".
    const service = serviceFor(
      {
        AAA: makeDividends({
          currency: 'EUR',
          trailingAmount: 2,
          trailingAmountBasis: 'trailing-12m',
        }),
        BBB: makeDividends({
          currency: 'EUR',
          trailingAmount: 1,
          trailingAmountBasis: 'forward-annualized',
        }),
      },
      { AAA: 10, BBB: 10 },
    );
    const result = await service.projectedIncome('user-1');
    expect(result.yearlyTotalBase).toBe(30);
    expect(result.basis).toBe('mixed');
    expect(result.holdings.map((h) => h.annualPerShareBasis).sort()).toEqual([
      'forward-annualized',
      'trailing-12m',
    ]);
  });

  it('names no basis when nothing contributed — an empty total describes nothing', async () => {
    const service = serviceFor({ AAA: makeDividends({ currency: 'EUR' }) }, { AAA: 10 });
    const result = await service.projectedIncome('user-1');
    expect(result.available).toBe(true);
    expect(result.yearlyTotalBase).toBe(0);
    expect(result.basis).toBeNull();
  });
});
