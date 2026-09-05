import { describe, expect, test } from 'vitest';

import type { StandingOrder } from '@bettertrack/contracts';

import {
  FORECAST_HORIZON_MAX_YEARS,
  FORECAST_RETURN_MAX_PCT,
  FORECAST_RETURN_MIN_PCT,
  monthlyRateFromAnnualPct,
  normalizeStandingOrders,
  projectNetWorth,
  type ForecastInput,
  type ForecastStandingOrder,
} from './projection';

/** A minimal input; every field overridable per case. asOf day-of-month is 15. */
function makeInput(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    asOf: '2026-01-15',
    startingNetWorth: 1000,
    horizonYears: 1,
    annualReturnPct: 0,
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
    const off = projectNetWorth(makeInput({ startingNetWorth: 1000, annualReturnPct: 0 }));
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

  /** The orders the projection would actually carry, in a EUR-base run. */
  function normalizedEur(orders: StandingOrder[]) {
    return normalizeStandingOrders(orders, 'EUR').orders;
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

  test('excludes buy-asset orders (net-worth-neutral reallocations)', () => {
    const normalized = normalizedEur([
      order({ kind: 'buy-asset', assetId: '22222222-2222-2222-2222-222222222222', amount: 5 }),
    ]);
    expect(normalized).toHaveLength(0);
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
    const result = normalizeStandingOrders([order({ kind: 'cash-add', amount: 3000 })], 'CHF');

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
    );

    expect(result.orders).toEqual([]);
    expect(result.foreignCurrencies).toEqual(['USD']);
  });

  test('a foreign buy-asset order is dropped before it can block the factor', () => {
    // Buys are excluded as net-worth-neutral either way, and their currency is
    // the asset's — never the base. They must not make the factor unresolvable.
    const result = normalizeStandingOrders(
      [
        order({
          kind: 'buy-asset',
          assetId: '22222222-2222-2222-2222-222222222222',
          amount: 5,
          currency: 'USD',
        }),
        order({ kind: 'cash-add', amount: 250 }),
      ],
      'EUR',
    );

    expect(result.foreignCurrencies).toEqual([]);
    expect(result.orders).toMatchObject([{ amount: 250 }]);
  });

  test('a paused foreign order does not block the factor either', () => {
    const result = normalizeStandingOrders(
      [
        order({ kind: 'cash-add', amount: 3000, status: 'paused' }),
        order({ kind: 'cash-add', amount: 250, currency: 'CHF' }),
      ],
      'CHF',
    );

    expect(result.foreignCurrencies).toEqual([]);
    expect(result.orders).toMatchObject([{ amount: 250 }]);
  });
});

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
    const shape = { startingNetWorth: 50_000, monthlyDividend: 100, annualReturnPct: 7 };
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
