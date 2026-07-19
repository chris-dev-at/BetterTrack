import { describe, expect, test } from 'vitest';

import type { StandingOrder } from '@bettertrack/contracts';

import {
  FORECAST_HORIZON_MAX_YEARS,
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
    startingNetWorthEur: 1000,
    horizonYears: 1,
    annualReturnPct: 0,
    standingOrders: [],
    monthlyDividendEur: 0,
    whatIfPlans: [],
    ...overrides,
  };
}

/** A monthly cash-add flow (+EUR), open-ended, anchored on the 1st, from 2020. */
function monthlyFlow(
  amountEur: number,
  over: Partial<ForecastStandingOrder> = {},
): ForecastStandingOrder {
  return {
    amountEur,
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
    const result = projectNetWorth(makeInput({ startingNetWorthEur: 1000 }));
    expect(result.base.every((p) => p.value === 1000)).toBe(true);
  });

  test('pure lump growth: €1,000 at 10 %/yr reads €1,100 / €1,210 at 12 / 24 months', () => {
    const result = projectNetWorth(
      makeInput({ startingNetWorthEur: 1000, annualReturnPct: 10, horizonYears: 2 }),
    );
    expect(result.base[12]!.value).toBe(1100);
    expect(result.base[24]!.value).toBe(1210);
  });

  test('zero-growth monthly contribution accumulates linearly', () => {
    // +100/mo for 12 months on a €1,000 base with no growth ⇒ €2,200.
    const result = projectNetWorth(
      makeInput({ startingNetWorthEur: 1000, standingOrders: [monthlyFlow(100)] }),
    );
    expect(result.base[6]!.value).toBe(1600);
    expect(last(result.base)).toBe(2200);
  });

  test('standing orders + dividends stack as monthly flows', () => {
    // +200/mo order and +50/mo dividend on €1,000, no growth ⇒ €1,000 + 12·250.
    const result = projectNetWorth(
      makeInput({
        startingNetWorthEur: 1000,
        standingOrders: [monthlyFlow(200)],
        monthlyDividendEur: 50,
      }),
    );
    expect(last(result.base)).toBe(4000);
  });

  test('a cash-deduct flow subtracts from net worth', () => {
    const result = projectNetWorth(
      makeInput({ startingNetWorthEur: 5000, standingOrders: [monthlyFlow(-100)] }),
    );
    expect(last(result.base)).toBe(3800); // 5000 − 12·100
  });
});

describe('projectNetWorth — factor toggling (base line responds)', () => {
  test('return factor on vs off', () => {
    const on = projectNetWorth(makeInput({ startingNetWorthEur: 1000, annualReturnPct: 10 }));
    const off = projectNetWorth(makeInput({ startingNetWorthEur: 1000, annualReturnPct: 0 }));
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
    const withDiv = projectNetWorth(makeInput({ monthlyDividendEur: 50 }));
    const without = projectNetWorth(makeInput({ monthlyDividendEur: 0 }));
    expect(last(withDiv.base)).toBe(1600);
    expect(last(without.base)).toBe(1000);
  });
});

describe('projectNetWorth — standing orders honor cadence & dates', () => {
  test('monthly order stops contributing after its end date', () => {
    // Ends 2026-04-10; anchor-1 occurrences fire Feb, Mar, Apr, then stop.
    const result = projectNetWorth(
      makeInput({
        startingNetWorthEur: 0,
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
        startingNetWorthEur: 0,
        standingOrders: [monthlyFlow(100, { anchorDay: 1, endDate: '2026-04-01' })],
      }),
    );
    expect(last(result.base)).toBe(300); // Feb, Mar, Apr fire on the 1st
  });

  test('a future start date defers the first contribution', () => {
    // Starts 2026-06-15, anchor 20 ⇒ first fire in June (the 20th), 8 months left.
    const result = projectNetWorth(
      makeInput({
        startingNetWorthEur: 0,
        standingOrders: [monthlyFlow(100, { anchorDay: 20, startDate: '2026-06-15' })],
      }),
    );
    expect(result.base[4]!.value).toBe(0); // May: before start
    expect(last(result.base)).toBe(800); // Jun..Jan = 8 fires
  });

  test('daily cadence contributes once per active day of the month', () => {
    const result = projectNetWorth(
      makeInput({
        startingNetWorthEur: 0,
        standingOrders: [
          {
            amountEur: 10,
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
        startingNetWorthEur: 0,
        standingOrders: [
          {
            amountEur: 10,
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
          { id: 'p1', label: 'S&P 500', monthlyContributionEur: 100, annualReturnPct: null },
          { id: 'p2', label: 'Bonds', monthlyContributionEur: 50, annualReturnPct: null },
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
        whatIfPlans: [{ id: 'p', label: 'Plan', monthlyContributionEur: 100, annualReturnPct: 0 }],
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
        startingNetWorthEur: 1000,
        annualReturnPct: 10,
        whatIfPlans: [{ id: 'p', label: 'Flat', monthlyContributionEur: 100, annualReturnPct: 0 }],
      }),
    );
    expect(last(result.base)).toBe(1100);
    expect(last(result.overlays[0]!.points)).toBe(2300); // 1100 + 1200
  });

  test('a plan with no own return uses the base return for its accumulation', () => {
    const base = projectNetWorth(makeInput({ startingNetWorthEur: 0, annualReturnPct: 10 }));
    const withPlan = projectNetWorth(
      makeInput({
        startingNetWorthEur: 0,
        annualReturnPct: 10,
        whatIfPlans: [
          { id: 'p', label: 'Plan', monthlyContributionEur: 100, annualReturnPct: null },
        ],
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

  test('maps cash-add to a positive flow and cash-deduct to a negative flow', () => {
    const normalized = normalizeStandingOrders([
      order({ kind: 'cash-add', amount: 200 }),
      order({ kind: 'cash-deduct', amount: 30 }),
    ]);
    expect(normalized.map((o) => o.amountEur)).toEqual([200, -30]);
  });

  test('excludes paused orders', () => {
    const normalized = normalizeStandingOrders([
      order({ kind: 'cash-add', status: 'paused' }),
      order({ kind: 'cash-add', status: 'active', amount: 40 }),
    ]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.amountEur).toBe(40);
  });

  test('excludes buy-asset orders (net-worth-neutral reallocations)', () => {
    const normalized = normalizeStandingOrders([
      order({ kind: 'buy-asset', assetId: '22222222-2222-2222-2222-222222222222', amount: 5 }),
    ]);
    expect(normalized).toHaveLength(0);
  });

  test('carries cadence, anchor and the date window through', () => {
    const [normalized] = normalizeStandingOrders([
      order({ cadence: 'monthly', anchorDay: 15, startDate: '2026-03-01', endDate: '2027-03-01' }),
    ]);
    expect(normalized).toMatchObject({
      cadence: 'monthly',
      anchorDay: 15,
      startDate: '2026-03-01',
      endDate: '2027-03-01',
    });
  });
});
