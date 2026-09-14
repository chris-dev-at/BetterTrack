import { describe, expect, test } from 'vitest';

import type { StandingOrder, StandingOrderKind, VaultEntity } from '@bettertrack/contracts';

import { standingOrderRowKind } from '../vault/vaultPortfolioStore';
import {
  FORECAST_HORIZON_MAX_YEARS,
  FORECAST_RETURN_MAX_PCT,
  FORECAST_RETURN_MIN_PCT,
  monthlyRateFromAnnualPct,
  normalizeStandingOrders,
  projectNetWorth,
  returnFactorContainsDistributions,
  type ForecastAssetPrice,
  type ForecastInput,
  type ForecastStandingOrder,
} from './projection';

/**
 * A minimal input; every field overridable per case. asOf day-of-month is 15.
 * `annualReturnPct: null` is the return factor OFF — the state the tab hands the
 * engine when the user unticks it, and the only one in which projected dividend
 * income is a flow of its own (#1892).
 */
function makeInput(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    asOf: '2026-01-15',
    startingNetWorth: 1000,
    horizonYears: 1,
    annualReturnPct: null,
    standingOrders: [],
    monthlyDividend: 0,
    whatIfPlans: [],
    ...overrides,
  };
}

/** A monthly cash-add flow (+EUR), open-ended, anchored on the 1st, from 2020. */
function monthlyFlow(
  amount: number,
  over: Partial<ForecastStandingOrder> = {},
): ForecastStandingOrder {
  return {
    amount,
    cadence: 'monthly',
    anchorDay: 1,
    startDate: '2020-01-01',
    endDate: null,
    ...over,
  };
}

const last = (points: ReadonlyArray<{ value: number }>): number => points[points.length - 1]!.value;

describe('monthlyRateFromAnnualPct', () => {
  test('0 %/yr maps to a 0 monthly rate', () => {
    expect(monthlyRateFromAnnualPct(0)).toBe(0);
  });

  test('twelve monthly compounds reproduce the annual return', () => {
    const r = monthlyRateFromAnnualPct(10);
    expect(Math.pow(1 + r, 12)).toBeCloseTo(1.1, 10);
  });

  test.each([-200, -1_000_000])('clamps %d %%/yr to a finite monthly rate', (annualPct) => {
    expect(monthlyRateFromAnnualPct(annualPct)).toBe(-1);
  });

  test('preserves the -100 %/yr monthly rate', () => {
    expect(monthlyRateFromAnnualPct(FORECAST_RETURN_MIN_PCT)).toBe(-1);
  });
});

describe('projectNetWorth — shape & dates', () => {
  test('emits 12·years + 1 monthly points anchored to the first of each month', () => {
    const result = projectNetWorth(makeInput({ horizonYears: 1 }));
    expect(result.base).toHaveLength(13);
    expect(result.base[0]).toEqual({ date: '2026-01-01', value: 1000 });
    expect(result.base[1]!.date).toBe('2026-02-01');
    expect(result.base[12]!.date).toBe('2027-01-01');
  });

  test('clamps the horizon into [1, 30] years', () => {
    expect(projectNetWorth(makeInput({ horizonYears: 0 })).base).toHaveLength(13);
    expect(projectNetWorth(makeInput({ horizonYears: 100 })).base).toHaveLength(
      FORECAST_HORIZON_MAX_YEARS * 12 + 1,
    );
  });
});

describe('projectNetWorth — hand-computed fixtures (the gate criterion)', () => {
  test('flat balance when every factor is off', () => {
    const result = projectNetWorth(makeInput({ startingNetWorth: 1000 }));
    expect(result.base.every((p) => p.value === 1000)).toBe(true);
  });

  test('pure lump growth: €1,000 at 10 %/yr reads €1,100 / €1,210 at 12 / 24 months', () => {
    const result = projectNetWorth(
      makeInput({ startingNetWorth: 1000, annualReturnPct: 10, horizonYears: 2 }),
    );
    expect(result.base[12]!.value).toBe(1100);
    expect(result.base[24]!.value).toBe(1210);
  });

  test('zero-growth monthly contribution accumulates linearly', () => {
    // +100/mo for 12 months on a €1,000 base with no growth ⇒ €2,200.
    const result = projectNetWorth(
      makeInput({ startingNetWorth: 1000, standingOrders: [monthlyFlow(100)] }),
    );
    expect(result.base[6]!.value).toBe(1600);
    expect(last(result.base)).toBe(2200);
  });

  test('standing orders + dividends stack as monthly flows', () => {
    // +200/mo order and +50/mo dividend on €1,000, no growth ⇒ €1,000 + 12·250.
    const result = projectNetWorth(
      makeInput({
        startingNetWorth: 1000,
        standingOrders: [monthlyFlow(200)],
        monthlyDividend: 50,
      }),
    );
    expect(last(result.base)).toBe(4000);
  });

  test('a cash-deduct flow subtracts from net worth', () => {
    const result = projectNetWorth(
      makeInput({ startingNetWorth: 5000, standingOrders: [monthlyFlow(-100)] }),
    );
    expect(last(result.base)).toBe(3800); // 5000 − 12·100
  });
});

describe('projectNetWorth — factor toggling (base line responds)', () => {
  test('return factor on vs off', () => {
    const on = projectNetWorth(makeInput({ startingNetWorth: 1000, annualReturnPct: 10 }));
    const off = projectNetWorth(makeInput({ startingNetWorth: 1000, annualReturnPct: null }));
    expect(last(on.base)).toBe(1100);
    expect(last(off.base)).toBe(1000);
  });

  test('standing-orders factor on vs off', () => {
    const withOrders = projectNetWorth(makeInput({ standingOrders: [monthlyFlow(100)] }));
    const without = projectNetWorth(makeInput({ standingOrders: [] }));
    expect(last(withOrders.base)).toBe(2200);
    expect(last(without.base)).toBe(1000);
  });

  test('dividend factor on vs off', () => {
    const withDiv = projectNetWorth(makeInput({ monthlyDividend: 50 }));
    const without = projectNetWorth(makeInput({ monthlyDividend: 0 }));
    expect(last(withDiv.base)).toBe(1600);
    expect(last(without.base)).toBe(1000);
  });

  test.each([-1_000_000, -200, FORECAST_RETURN_MIN_PCT, 0, 10, FORECAST_RETURN_MAX_PCT, 1_000_000])(
    'never emits NaN for a finite %d %%/yr return input',
    (annualReturnPct) => {
      const result = projectNetWorth(
        makeInput({
          annualReturnPct,
          whatIfPlans: [
            {
              id: 'own-return',
              label: 'Own return',
              monthlyContribution: 100,
              annualReturnPct,
            },
          ],
        }),
      );

      expect(result.base.every((point) => Number.isFinite(point.value))).toBe(true);
      expect(
        result.overlays.every((overlay) =>
          overlay.points.every((point) => Number.isFinite(point.value)),
        ),
      ).toBe(true);
      expect(
        [result.base.at(-1)!.value, result.overlays[0]!.points.at(-1)!.value].every(
          Number.isFinite,
        ),
      ).toBe(true);
    },
  );
});

describe('projectNetWorth — standing orders honor cadence & dates', () => {
  test('monthly order stops contributing after its end date', () => {
    // Ends 2026-04-10; anchor-1 occurrences fire Feb, Mar, Apr, then stop.
    const result = projectNetWorth(
      makeInput({
        startingNetWorth: 0,
        standingOrders: [monthlyFlow(100, { endDate: '2026-04-10' })],
      }),
    );
    expect(result.base[3]!.value).toBe(300); // Feb+Mar+Apr
    expect(result.base[4]!.value).toBe(300); // May: no more
    expect(last(result.base)).toBe(300);
  });

  test('end date on the occurrence day is inclusive', () => {
    const result = projectNetWorth(
      makeInput({
        startingNetWorth: 0,
        standingOrders: [monthlyFlow(100, { anchorDay: 1, endDate: '2026-04-01' })],
      }),
    );
    expect(last(result.base)).toBe(300); // Feb, Mar, Apr fire on the 1st
  });

  test('a future start date defers the first contribution', () => {
    // Starts 2026-06-15, anchor 20 ⇒ first fire in June (the 20th), 8 months left.
    const result = projectNetWorth(
      makeInput({
        startingNetWorth: 0,
        standingOrders: [monthlyFlow(100, { anchorDay: 20, startDate: '2026-06-15' })],
      }),
    );
    expect(result.base[4]!.value).toBe(0); // May: before start
    expect(last(result.base)).toBe(800); // Jun..Jan = 8 fires
  });

  test('daily cadence contributes once per active day of the month', () => {
    const result = projectNetWorth(
      makeInput({
        startingNetWorth: 0,
        standingOrders: [
          {
            amount: 10,
            cadence: 'daily',
            anchorDay: null,
            startDate: '2020-01-01',
            endDate: null,
          },
        ],
      }),
    );
    expect(result.base[1]!.value).toBe(280); // Feb 2026: 28 days · 10
    expect(result.base[2]!.value).toBe(590); // + Mar: 31 days · 10
  });

  test('daily cadence intersects its window with the month', () => {
    const result = projectNetWorth(
      makeInput({
        startingNetWorth: 0,
        standingOrders: [
          {
            amount: 10,
            cadence: 'daily',
            anchorDay: null,
            startDate: '2020-01-01',
            endDate: '2026-02-10',
          },
        ],
      }),
    );
    expect(result.base[1]!.value).toBe(100); // Feb 1..10 = 10 days
    expect(result.base[2]!.value).toBe(100); // Mar: window already ended
  });
});

describe('projectNetWorth — what-if overlays', () => {
  test('each plan renders as its own overlay series preserving id + label', () => {
    const result = projectNetWorth(
      makeInput({
        whatIfPlans: [
          { id: 'p1', label: 'S&P 500', monthlyContribution: 100, annualReturnPct: null },
          { id: 'p2', label: 'Bonds', monthlyContribution: 50, annualReturnPct: null },
        ],
      }),
    );
    expect(result.overlays.map((o) => o.id)).toEqual(['p1', 'p2']);
    expect(result.overlays[0]!.label).toBe('S&P 500');
    expect(result.overlays).toHaveLength(2);
  });

  test('an overlay is exactly the base plus the plan accumulation', () => {
    // No base growth/flows ⇒ base is flat 1000; +100/mo at 0 % ⇒ +1,200 at 12 mo.
    const result = projectNetWorth(
      makeInput({
        whatIfPlans: [{ id: 'p', label: 'Plan', monthlyContribution: 100, annualReturnPct: 0 }],
      }),
    );
    const overlay = result.overlays[0]!;
    expect(overlay.points[0]!.value).toBe(1000); // starts at the base
    expect(last(overlay.points)).toBe(2200); // 1000 + 12·100
  });

  test("a plan's own return overrides the base return", () => {
    // Base at 10 % ⇒ 1100 at 12 mo; plan pinned to 0 % ⇒ +1,200 accumulation.
    const result = projectNetWorth(
      makeInput({
        startingNetWorth: 1000,
        annualReturnPct: 10,
        whatIfPlans: [{ id: 'p', label: 'Flat', monthlyContribution: 100, annualReturnPct: 0 }],
      }),
    );
    expect(last(result.base)).toBe(1100);
    expect(last(result.overlays[0]!.points)).toBe(2300); // 1100 + 1200
  });

  test('a plan with no own return uses the base return for its accumulation', () => {
    const base = projectNetWorth(makeInput({ startingNetWorth: 0, annualReturnPct: 10 }));
    const withPlan = projectNetWorth(
      makeInput({
        startingNetWorth: 0,
        annualReturnPct: 10,
        whatIfPlans: [{ id: 'p', label: 'Plan', monthlyContribution: 100, annualReturnPct: null }],
      }),
    );
    // Base contributes nothing (starts at 0); the overlay is the plan's own FV.
    expect(last(base.base)).toBe(0);
    expect(last(withPlan.overlays[0]!.points)).toBeGreaterThan(1200); // 12·100 plus growth
  });
});

describe('normalizeStandingOrders', () => {
  function order(over: Partial<StandingOrder>): StandingOrder {
    return {
      id: '00000000-0000-0000-0000-000000000000',
      portfolioId: '11111111-1111-1111-1111-111111111111',
      kind: 'cash-add',
      assetId: null,
      assetSymbol: null,
      assetName: null,
      amount: 100,
      currency: 'EUR',
      label: null,
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-01-01',
      endDate: null,
      status: 'active',
      lastRunAt: null,
      lastPeriodKey: null,
      nextRunDate: '2026-02-01',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    };
  }

  /** Unit prices as the caller's portfolio read states them (EUR unless said). */
  function prices(
    entries: Record<string, { price: number; currency?: string }>,
  ): Map<string, ForecastAssetPrice> {
    return new Map(
      Object.entries(entries).map(([assetId, quote]) => [
        assetId,
        { price: quote.price, currency: quote.currency ?? 'EUR' },
      ]),
    );
  }

  const NO_PRICES: Map<string, ForecastAssetPrice> = new Map();

  /** The orders the projection would actually carry, in a EUR-base run. */
  function normalizedEur(
    orders: StandingOrder[],
    assetPrices: Map<string, ForecastAssetPrice> = NO_PRICES,
  ) {
    return normalizeStandingOrders(orders, 'EUR', assetPrices).orders;
  }

  test('maps cash-add to a positive flow and cash-deduct to a negative flow', () => {
    const normalized = normalizedEur([
      order({ kind: 'cash-add', amount: 200 }),
      order({ kind: 'cash-deduct', amount: 30 }),
    ]);
    expect(normalized.map((o) => o.amount)).toEqual([200, -30]);
  });

  test('excludes paused orders', () => {
    const normalized = normalizedEur([
      order({ kind: 'cash-add', status: 'paused' }),
      order({ kind: 'cash-add', status: 'active', amount: 40 }),
    ]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.amount).toBe(40);
  });

  test('excludes archive-suspended orders while leaving unflagged active orders unchanged', () => {
    const active = order({ kind: 'cash-add', amount: 40 });

    expect(normalizedEur([active])).toMatchObject([{ amount: 40 }]);
    expect(normalizedEur([{ ...active, suspendedByArchive: true }])).toEqual([]);
  });

  // ── A recurring buy is money the engine books (#1892) ─────────────────────
  //
  // Replaces `excludes buy-asset orders (net-worth-neutral reallocations)`: the
  // premise it pinned — that a buy reallocates cash the book already holds — is
  // contradicted by both booking engines, which write the BUY with no cash leg
  // at all. `amount` is a share QUANTITY for this kind, so the flow is
  // quantity × unit price.

  const BUY_ASSET_ID = '22222222-2222-2222-2222-222222222222';

  function buyOrder(over: Partial<StandingOrder> = {}): StandingOrder {
    return order({
      kind: 'buy-asset',
      assetId: BUY_ASSET_ID,
      assetSymbol: 'VWCE',
      assetName: 'Vanguard FTSE All-World',
      amount: 5,
      ...over,
    });
  }

  test('prices a buy-asset order into the money its booking records', () => {
    const normalized = normalizedEur([buyOrder()], prices({ [BUY_ASSET_ID]: { price: 120 } }));
    expect(normalized).toMatchObject([{ amount: 600 }]);
  });

  test('a buy-asset order carries its own schedule, like any other', () => {
    const [normalized] = normalizedEur(
      [
        buyOrder({
          cadence: 'monthly',
          anchorDay: 3,
          startDate: '2026-02-01',
          endDate: '2027-02-01',
        }),
      ],
      prices({ [BUY_ASSET_ID]: { price: 10 } }),
    );
    expect(normalized).toMatchObject({
      amount: 50,
      cadence: 'monthly',
      anchorDay: 3,
      startDate: '2026-02-01',
      endDate: '2027-02-01',
    });
  });

  test('the projection values a buy exactly as the booking engines record it', () => {
    // The two contracts, pinned against each other. The server's
    // `standingOrderService.bookRow` inserts the BUY with an explicitly empty
    // `cashMovements: []`, and the vault twin takes the same branch — its
    // `standingOrderRowKind` is the rule both engines book by. Net worth is
    // `marketValue + cash`, so a booking with no cash leg moves it by the
    // purchase value and by nothing else; that is the flow below.
    function orderEntity(kind: StandingOrderKind): VaultEntity {
      return {
        id: '44444444-4444-4444-4444-444444444444',
        rev: 1,
        editedAt: '2026-01-01T00:00:00.000Z',
        editedBy: '55555555-5555-5555-5555-555555555555',
        deletedAt: null,
        data: { kind },
      };
    }

    expect(standingOrderRowKind(orderEntity('buy-asset'))).toBe('transaction');
    expect(standingOrderRowKind(orderEntity('cash-add'))).toBe('cashMovement');
    expect(standingOrderRowKind(orderEntity('cash-deduct'))).toBe('cashMovement');

    const [flow] = normalizedEur(
      [buyOrder({ amount: 4 })],
      prices({ [BUY_ASSET_ID]: { price: 25 } }),
    );
    expect(flow!.amount).toBe(4 * 25);
  });

  test('an unpriced buy-asset order refuses the factor and names its asset', () => {
    // All-or-nothing, like a foreign order: a buy books money the schedule will
    // really spend, so dropping the one that cannot be priced would draw a
    // quietly smaller curve with nothing to explain it.
    const result = normalizeStandingOrders(
      [buyOrder(), order({ kind: 'cash-add', amount: 250 })],
      'EUR',
      NO_PRICES,
    );

    expect(result.orders).toEqual([]);
    expect(result.unpricedAssets).toEqual(['VWCE']);
    expect(result.foreignCurrencies).toEqual([]);
  });

  test('a zero or non-finite price is no price at all', () => {
    for (const price of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = normalizeStandingOrders(
        [buyOrder()],
        'EUR',
        prices({ [BUY_ASSET_ID]: { price } }),
      );
      expect(result.orders).toEqual([]);
      expect(result.unpricedAssets).toEqual(['VWCE']);
    }
  });

  test('a paused buy-asset order needs no price at all', () => {
    const result = normalizeStandingOrders(
      [buyOrder({ status: 'paused' }), order({ kind: 'cash-add', amount: 250 })],
      'EUR',
      NO_PRICES,
    );

    expect(result.unpricedAssets).toEqual([]);
    expect(result.orders).toMatchObject([{ amount: 250 }]);
  });

  test('carries cadence, anchor and the date window through', () => {
    const [normalized] = normalizedEur([
      order({ cadence: 'monthly', anchorDay: 15, startDate: '2026-03-01', endDate: '2027-03-01' }),
    ]);
    expect(normalized).toMatchObject({
      cadence: 'monthly',
      anchorDay: 15,
      startDate: '2026-03-01',
      endDate: '2027-03-01',
    });
  });

  // ── Denomination (#1759) ──────────────────────────────────────────────────
  //
  // A cash order's `amount` is a EUR magnitude by contract, while the balance it
  // would join is in the user's base. The engine converts nothing, so the
  // mismatch has to be refused here — not summed 1:1 into a CHF curve.

  test('refuses an order denominated in anything but the run’s base', () => {
    const result = normalizeStandingOrders(
      [order({ kind: 'cash-add', amount: 3000 })],
      'CHF',
      NO_PRICES,
    );

    expect(result.orders).toEqual([]);
    expect(result.foreignCurrencies).toEqual(['EUR']);
  });

  test('a single foreign order takes the whole factor with it, deduped and sorted', () => {
    // All-or-nothing, like the dividend total (#1616): projecting the matching
    // subset would draw a quietly smaller curve with nothing to explain it.
    const result = normalizeStandingOrders(
      [
        order({ kind: 'cash-add', amount: 100, currency: 'USD' }),
        order({ kind: 'cash-add', amount: 3000 }),
        order({ kind: 'cash-deduct', amount: 20, currency: 'USD' }),
      ],
      'EUR',
      NO_PRICES,
    );

    expect(result.orders).toEqual([]);
    expect(result.foreignCurrencies).toEqual(['USD']);
  });

  test('a foreign buy-asset order takes the same refusal path as a cash one', () => {
    // A buy's currency is the ASSET's, and its price is quoted in that same
    // currency — so once the buy is real money on the curve (#1892) it joins the
    // one gate that keeps the run single-denomination rather than getting a
    // second one of its own.
    const result = normalizeStandingOrders(
      [
        order({
          kind: 'buy-asset',
          assetId: '22222222-2222-2222-2222-222222222222',
          assetSymbol: 'AAPL',
          amount: 5,
          currency: 'USD',
        }),
        order({ kind: 'cash-add', amount: 250 }),
      ],
      'EUR',
      new Map([['22222222-2222-2222-2222-222222222222', { price: 180, currency: 'USD' }]]),
    );

    expect(result.foreignCurrencies).toEqual(['USD']);
    expect(result.unpricedAssets).toEqual([]);
    expect(result.orders).toEqual([]);
  });

  test('a base-matching order priced in another currency is refused too', () => {
    // The price is the operand that would join the balance. An order stamped EUR
    // whose quote answers in USD would multiply a EUR quantity by a USD price.
    const result = normalizeStandingOrders(
      [order({ kind: 'buy-asset', assetId: BUY_ASSET_ID, assetSymbol: 'VWCE', amount: 5 })],
      'EUR',
      prices({ [BUY_ASSET_ID]: { price: 120, currency: 'USD' } }),
    );

    expect(result.foreignCurrencies).toEqual(['USD']);
    expect(result.orders).toEqual([]);
  });

  test('a paused foreign order does not block the factor either', () => {
    const result = normalizeStandingOrders(
      [
        order({ kind: 'cash-add', amount: 3000, status: 'paused' }),
        order({ kind: 'cash-add', amount: 250, currency: 'CHF' }),
      ],
      'CHF',
      NO_PRICES,
    );

    expect(result.foreignCurrencies).toEqual([]);
    expect(result.orders).toMatchObject([{ amount: 250 }]);
  });
});

// ---------------------------------------------------------------------------
// A recurring buy is money the engine books (#1892)
//
// The engine used to exclude `buy-asset` orders on the premise that a buy
// reallocates cash the book already owns. Nothing debits that cash: both
// booking engines write the BUY with an empty cash leg, so recorded net worth
// (`marketValue + cash`) rises by the full purchase value. A €500/month plan
// therefore has to move the curve — it projected €0.

describe('projectNetWorth — a recurring buy moves the curve (#1892)', () => {
  /** A monthly buy of 5 units at €100 — €500 of cost per occurrence. */
  const monthlyBuy: ForecastStandingOrder[] = [
    {
      amount: 5 * 100,
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2020-01-01',
      endDate: null,
    },
  ];

  test('an active monthly buy lifts the curve by what the scheduler will book', () => {
    const withOrders = projectNetWorth(
      makeInput({ startingNetWorth: 10_000, standingOrders: monthlyBuy }),
    );
    // The same input with the orders factor off — the toggle's other position.
    const without = projectNetWorth(makeInput({ startingNetWorth: 10_000, standingOrders: [] }));

    expect(last(withOrders.base) - last(without.base)).toBe(12 * 500);
    expect(last(withOrders.base)).toBeGreaterThan(last(without.base));
  });

  test('over the tab’s default horizon it is the six-figure plan, not €0', () => {
    // 20 years of €500/month at 6 %/yr: the cost alone is €120,000, and the
    // excluded version projected exactly the bare starting balance. Ordinary
    // annuity at the monthly equivalent rm = 1.06^(1/12) − 1 = 0.00486755…:
    // 500 · ((1 + rm)^240 − 1)/rm = 500 · (1.06^20 − 1)/rm = 226 719.32.
    const projected = projectNetWorth(
      makeInput({
        asOf: '2026-01-01',
        startingNetWorth: 0,
        horizonYears: 20,
        annualReturnPct: 6,
        standingOrders: monthlyBuy,
      }),
    );
    expect(last(projected.base)).toBeGreaterThan(120_000);
    expect(last(projected.base)).toBeCloseTo(226_719.32, 2);
  });
});

// ---------------------------------------------------------------------------
// Factor composition: the return already contains the distributions (#1892)
//
// The base rate is sampled from the portfolio's own TWR, and a `dividend` is
// internal to that curve by design (packages/domain cashLedger). Adding the
// projected income on top of it counted the same euro twice — in the state both
// factors ship ON.

describe('projectNetWorth — return × dividend composition (#1892)', () => {
  const INCOME = 250;
  const factors = { startingNetWorth: 100_000, horizonYears: 20, monthlyDividend: INCOME };

  const returnOnDividendOn = projectNetWorth(makeInput({ ...factors, annualReturnPct: 7 }));
  const returnOnDividendOff = projectNetWorth(
    makeInput({ ...factors, annualReturnPct: 7, monthlyDividend: 0 }),
  );
  const returnOffDividendOn = projectNetWorth(makeInput({ ...factors, annualReturnPct: null }));

  test('the rule has one owner, and it is not "the rate is zero"', () => {
    expect(returnFactorContainsDistributions(null)).toBe(false);
    expect(returnFactorContainsDistributions(7)).toBe(true);
    // A 0 %/yr TOTAL return is an assumption about the market, not the absence
    // of one: the distributions are inside it, offset by price decline.
    expect(returnFactorContainsDistributions(0)).toBe(true);
    expect(last(projectNetWorth(makeInput({ ...factors, annualReturnPct: 0 })).base)).toBe(100_000);
  });

  test('income the return already carries is not added a second time', () => {
    expect(last(returnOnDividendOn.base)).toBe(last(returnOnDividendOff.base));
  });

  test('without a return assumption the income is the only thing on the curve', () => {
    expect(last(returnOffDividendOn.base)).toBe(100_000 + 240 * INCOME);
  });

  test('the combined default state is not the income counted twice', () => {
    // What the additive composition produced: the whole TWR curve PLUS the same
    // income compounded on top of it — ~32 % high on this book.
    const doubleCounted = last(returnOnDividendOff.base) + accumulate(INCOME, 7, 240);
    expect(last(returnOnDividendOn.base)).toBeLessThan(doubleCounted);
    expect(doubleCounted / last(returnOnDividendOn.base)).toBeGreaterThan(1.3);
    // And it is not the other overcorrection either — the income is still in
    // there, inside the rate that was measured with it.
    expect(last(returnOnDividendOn.base)).toBeGreaterThan(100_000);
  });
});

/** Ordinary-annuity accumulation of `monthly` at `annualPct` over `months`. */
function accumulate(monthly: number, annualPct: number, months: number): number {
  const rate = monthlyRateFromAnnualPct(annualPct);
  let balance = 0;
  for (let step = 0; step < months; step++) balance = balance * (1 + rate) + monthly;
  return balance;
}

// ---------------------------------------------------------------------------
// Denomination (#1741)
//
// The projected dividend income used to arrive pinned to EUR while the starting
// balance was in the user's base, so a USD/CHF/GBP user's curve summed two
// currencies and rendered the total with one symbol. The engine's contract is
// now explicit: it converts nothing, so whatever ONE denomination the caller
// hands it comes back out — the dividend factor lands in the balance 1:1.

describe('projectNetWorth — denomination (#1741)', () => {
  test('the dividend factor enters the balance in the starting balance’s own units', () => {
    // A USD-base account: $50,000 today and a $100/month projected dividend from
    // a USD-denominated projection. No growth, so a year adds exactly 12 × 100
    // of the SAME unit — a EUR figure smuggled in here would land as some other
    // number entirely.
    const usd = projectNetWorth(
      makeInput({ startingNetWorth: 50_000, monthlyDividend: 100, horizonYears: 1 }),
    );
    expect(last(usd.base)).toBe(51_200);
    expect(last(usd.base) - 50_000).toBe(12 * 100);
  });

  test('is currency-agnostic: identical inputs project identically in any base', () => {
    // The engine holds no rate and no currency, so the ONLY way a base can reach
    // the curve is through the caller's inputs. Pinning that keeps the mixing
    // bug where it can be caught — at the boundary that resolves the factors.
    // No return assumption, so the projected income really is a flow here
    // (#1892) — with one in play the curve already carries it.
    const shape = { startingNetWorth: 50_000, monthlyDividend: 100, annualReturnPct: null };
    const asUsd = projectNetWorth(makeInput(shape));
    const asEur = projectNetWorth(makeInput(shape));
    expect(asUsd.base).toEqual(asEur.base);
  });
});

// ---------------------------------------------------------------------------
// The return factor is a return (#1759)
//
// The section used to sample the CAGR of the portfolio's VALUE series, which
// rises with every contribution the user made — and then handed it to this
// engine, which compounds it on top of the standing orders that made those same
// contributions. The module note argues the engine avoids exactly that
// double-count by excluding `buy-asset` orders; the return factor let it back in.
// ---------------------------------------------------------------------------

describe('projectNetWorth — a contribution-inflated rate is not a return (#1759)', () => {
  // The issue's saver, five years on: €10,000 grown to ≈ €48,294 at a true
  // 6 %/yr while paying in €500/month (€30,000 of their own money). The value
  // curve reads that as ≈ 37 %/yr — see packages/domain's seriesStats fixture.
  const SAVER_NET_WORTH = 48_294.26;
  const TRUE_RETURN_PCT = 6;
  const VALUE_CURVE_CAGR_PCT = 37.02;

  function saverProjection(annualReturnPct: number) {
    return projectNetWorth({
      asOf: '2026-01-01',
      startingNetWorth: SAVER_NET_WORTH,
      horizonYears: 20, // the Forecast's default horizon
      annualReturnPct,
      standingOrders: [
        {
          amount: 500,
          cadence: 'monthly',
          anchorDay: 1,
          startDate: '2021-01-01',
          endDate: null,
        },
      ],
      monthlyDividend: 0,
      whatIfPlans: [],
    });
  }

  test('the combined default factors project a number a person could reach', () => {
    // €48,294 plus €500/month for twenty years at 6 %/yr.
    expect(last(saverProjection(TRUE_RETURN_PCT).base)).toBeCloseTo(381_605.55, 2);
  });

  test('the old sampled rate compounded the contributions a second time', () => {
    // Same orders, same horizon, only the rate differs: the value curve's CAGR
    // turns the same portfolio into tens of millions, because the €30,000 the
    // user paid in is inside the rate AND inside the orders.
    const inflated = last(saverProjection(VALUE_CURVE_CAGR_PCT).base);
    expect(inflated).toBeGreaterThan(20_000_000);
    expect(last(saverProjection(TRUE_RETURN_PCT).base)).toBeLessThan(inflated / 50);
  });
});
