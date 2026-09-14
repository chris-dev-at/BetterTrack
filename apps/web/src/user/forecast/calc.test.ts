import { describe, expect, test } from 'vitest';

import {
  compoundInterest,
  dividendPlan,
  savingsPlanContribution,
  savingsPlanYears,
  withdrawalHorizon,
  withdrawalRate,
  FORECAST_CALC_MAX_YEARS,
} from './calc';
import { projectNetWorth } from './projection';

// Hand-computed fixtures for the four V5-P6b calculators. Every case ties an
// input tuple to a value derived on paper (formula + closed-form arithmetic),
// so a regression in the pure functions surfaces as a specific fixture failure.

describe('compoundInterest', () => {
  test('no contributions, annual compounding — pure geometric growth', () => {
    // 1000 · 1.05^10  =  1000 · 1.6288946267774414  =  1628.894626777…
    const result = compoundInterest({
      principal: 1000,
      monthlyContribution: 0,
      ratePctPerYear: 5,
      years: 10,
      compoundingPerYear: 1,
    });
    expect(result.finalBalance).toBeCloseTo(1628.894626777, 6);
    expect(result.totalContributions).toBe(1000);
    expect(result.totalInterest).toBeCloseTo(628.894626777, 6);
  });

  test('zero rate — linear accumulation (P + 12·years·monthlyContribution)', () => {
    const result = compoundInterest({
      principal: 100,
      monthlyContribution: 50,
      ratePctPerYear: 0,
      years: 5,
      compoundingPerYear: 12,
    });
    // 100 + 50·60 = 3100
    expect(result.finalBalance).toBe(3100);
    expect(result.totalContributions).toBe(3100);
    expect(result.totalInterest).toBe(0);
  });

  test('pure ordinary-annuity, monthly compounding — 6 %/yr, 5 yr, 100/mo', () => {
    // rp = 1.06^(1/12) − 1 = 0.00486755…, N = 60, (1 + rp)^60 = 1.06^5 = 1.33822558
    // FV = 100 · ((1 + rp)^60 − 1)/rp ≈ 6948.579 (money precision, 2 dp).
    // Under the superseded nominal reading (6/1200) this was 6977.003 — the same
    // 6 %/yr silently compounded as 6.168 % effective (#1892).
    const result = compoundInterest({
      principal: 0,
      monthlyContribution: 100,
      ratePctPerYear: 6,
      years: 5,
      compoundingPerYear: 12,
    });
    expect(result.finalBalance).toBeCloseTo(6948.579, 2);
    expect(result.totalContributions).toBe(6000);
    expect(result.totalInterest).toBeCloseTo(948.579, 2);
  });

  test('mixed principal + monthly contribution, monthly compounding — 7 %/yr, 20 yr', () => {
    // rp = 1.07^(1/12) − 1, N = 240, (1 + rp)^240 = 1.07^20 = 3.86968446
    // FV = 5000·3.86968446 + 250·(3.86968446 − 1)/rp ≈ 146232.52 (2 dp)
    const result = compoundInterest({
      principal: 5000,
      monthlyContribution: 250,
      ratePctPerYear: 7,
      years: 20,
      compoundingPerYear: 12,
    });
    expect(result.finalBalance).toBeCloseTo(146232.52, 2);
    expect(result.totalContributions).toBe(65000);
    expect(result.totalInterest).toBeCloseTo(81232.52, 2);
  });

  test('quarterly compounding rescales the monthly contribution to per-period', () => {
    // n = 4, so per-period contribution = 100 · 12/4 = 300 four times a year.
    // rp = 1.05^(1/4) − 1 = 0.01227223…, N = 40, (1 + rp)^40 = 1.05^10 = 1.62889463
    // FV = 300 · ((1 + rp)^40 − 1) / rp ≈ 15373.60 (money precision, 2 dp)
    const result = compoundInterest({
      principal: 0,
      monthlyContribution: 100,
      ratePctPerYear: 5,
      years: 10,
      compoundingPerYear: 4,
    });
    expect(result.finalBalance).toBeCloseTo(15373.6, 2);
    expect(result.totalContributions).toBe(12000);
  });

  test('a negative horizon collapses to "no time passed", never below the principal', () => {
    // Unfloored this discounted instead of compounding: 10 000 / 250 €/mo / 5 %
    // at years = −1 reported a 6588.80 balance against 7000 contributed.
    const result = compoundInterest({
      principal: 10000,
      monthlyContribution: 250,
      ratePctPerYear: 5,
      years: -1,
      compoundingPerYear: 12,
    });
    expect(result.finalBalance).toBe(10000);
    expect(result.totalContributions).toBe(10000);
    expect(result.totalInterest).toBe(0);
    expect(result.finalBalance).toBeGreaterThanOrEqual(10000);
  });
});

describe('savingsPlanContribution', () => {
  test('normal solve — 15528.226/… over 10 yr @ 5 %/yr monthly ⇒ ~100 €/mo', () => {
    // Uses the compoundInterest formula's own terminal value as the target, so
    // the inverse must land back on 100 €/mo.
    const target = compoundInterest({
      principal: 0,
      monthlyContribution: 100,
      ratePctPerYear: 5,
      years: 10,
      compoundingPerYear: 12,
    }).finalBalance;
    const result = savingsPlanContribution({
      target,
      principal: 0,
      ratePctPerYear: 5,
      years: 10,
      compoundingPerYear: 12,
    });
    expect(result.feasible).toBe(true);
    expect(result.monthlyContribution).toBeCloseTo(100, 8);
  });

  test('zero rate — linear solve', () => {
    // (3100 − 100) / (12·5·1) = 50 €/mo
    const result = savingsPlanContribution({
      target: 3100,
      principal: 100,
      ratePctPerYear: 0,
      years: 5,
      compoundingPerYear: 12,
    });
    expect(result.feasible).toBe(true);
    expect(result.monthlyContribution).toBeCloseTo(50, 10);
  });

  test('principal already above target — zero contribution, still feasible', () => {
    const result = savingsPlanContribution({
      target: 500,
      principal: 1000,
      ratePctPerYear: 5,
      years: 3,
      compoundingPerYear: 12,
    });
    expect(result.feasible).toBe(true);
    expect(result.monthlyContribution).toBe(0);
  });

  test('growth alone lifts principal above target — zero contribution needed', () => {
    // 1000 · 1.05^10 ≈ 1628.89 > 1500, so no monthly contribution is required.
    const result = savingsPlanContribution({
      target: 1500,
      principal: 1000,
      ratePctPerYear: 5,
      years: 10,
      compoundingPerYear: 1,
    });
    expect(result.feasible).toBe(true);
    expect(result.monthlyContribution).toBe(0);
  });

  test('a negative horizon reads as the zero-horizon answer', () => {
    const negative = savingsPlanContribution({
      target: 5000,
      principal: 1000,
      ratePctPerYear: 5,
      years: -3,
      compoundingPerYear: 12,
    });
    expect(negative).toEqual(
      savingsPlanContribution({
        target: 5000,
        principal: 1000,
        ratePctPerYear: 5,
        years: 0,
        compoundingPerYear: 12,
      }),
    );
    expect(negative.monthlyContribution).toBe(0);
    expect(negative.feasible).toBe(false);
  });
});

describe('savingsPlanYears', () => {
  test('normal solve — 1000 → 1628.89 @ 5 %/yr annual = 10 yr', () => {
    // (1.05)^N = 1.62889… ⇒ N = 10 exactly.
    const result = savingsPlanYears({
      target: 1628.894626777,
      principal: 1000,
      monthlyContribution: 0,
      ratePctPerYear: 5,
      compoundingPerYear: 1,
    });
    expect(result.feasible).toBe(true);
    expect(result.years).not.toBeNull();
    expect(result.years!).toBeCloseTo(10, 6);
  });

  test('zero rate + zero contribution + target above principal — unattainable', () => {
    const result = savingsPlanYears({
      target: 10000,
      principal: 100,
      monthlyContribution: 0,
      ratePctPerYear: 0,
      compoundingPerYear: 12,
    });
    expect(result.feasible).toBe(false);
    expect(result.years).toBeNull();
  });

  test('zero rate + positive monthly contribution — linear months / n years', () => {
    // (10000 − 1000) / (100·12/1) per year = 9 000 / 1200 = 7.5 yr
    const result = savingsPlanYears({
      target: 10000,
      principal: 1000,
      monthlyContribution: 100,
      ratePctPerYear: 0,
      compoundingPerYear: 1,
    });
    expect(result.feasible).toBe(true);
    expect(result.years).toBeCloseTo(7.5, 10);
  });

  test('principal already meets target — zero years', () => {
    const result = savingsPlanYears({
      target: 500,
      principal: 500,
      monthlyContribution: 100,
      ratePctPerYear: 5,
      compoundingPerYear: 12,
    });
    expect(result.years).toBe(0);
    expect(result.feasible).toBe(true);
  });
});

describe('dividendPlan', () => {
  test('standard case — 10 000 @ 3 %/yr, growing 5 %/yr, 5 yr', () => {
    // Year 1: 300
    // Year 2: 300·1.05 = 315
    // Year 3: 315·1.05 = 330.75
    // Year 4: 330.75·1.05 = 347.2875
    // Year 5: 347.2875·1.05 = 364.651875
    // Sum: 1657.689375
    // Yield on cost in the FINAL year of the stream = that year's payment over
    // cost: 364.651875 / 10 000 = 3.64651875 % — equivalently 3·1.05^4, since
    // year 1 is seeded ungrown. (Superseded fixture: 3·1.05^5 = 3.8288…, which
    // is a sixth year the projection never pays.)
    const result = dividendPlan({
      positionValue: 10000,
      yieldPctPerYear: 3,
      growthPctPerYear: 5,
      years: 5,
    });
    expect(result.yearlyDividends).toHaveLength(5);
    expect(result.yearlyDividends[0]).toBeCloseTo(300, 10);
    expect(result.yearlyDividends[1]).toBeCloseTo(315, 10);
    expect(result.yearlyDividends[2]).toBeCloseTo(330.75, 10);
    expect(result.yearlyDividends[3]).toBeCloseTo(347.2875, 10);
    expect(result.yearlyDividends[4]).toBeCloseTo(364.651875, 10);
    expect(result.totalDividends).toBeCloseTo(1657.689375, 8);
    expect(result.yieldOnCostFinalPct).toBeCloseTo(3.64651875, 8);
  });

  test('yield on cost reads the final payment of its own stream, not one year past it', () => {
    // The card renders "Year 1 dividend" off `yearlyDividends[0]` and
    // "Yield on cost, final year" off `yieldOnCostFinalPct`; the two sit in one
    // stat row and must share a convention.
    for (const years of [1, 2, 3, 5, 10, 30]) {
      const result = dividendPlan({
        positionValue: 10000,
        yieldPctPerYear: 3,
        growthPctPerYear: 5,
        years,
      });
      const finalPayment = result.yearlyDividends[result.yearlyDividends.length - 1]!;
      expect(result.yieldOnCostFinalPct).toBeCloseTo((finalPayment / 10000) * 100, 10);
    }
  });

  test('single year — the one €300 payment is 3,00 % on cost, not 3,15 %', () => {
    const result = dividendPlan({
      positionValue: 10000,
      yieldPctPerYear: 3,
      growthPctPerYear: 5,
      years: 1,
    });
    expect(result.yearlyDividends).toEqual([300]);
    expect(result.totalDividends).toBeCloseTo(300, 10);
    expect(result.yieldOnCostFinalPct).toBeCloseTo(3, 10);
  });

  test('ten years — 3·1.05^9 = 4.6540 %, not the 3·1.05^10 = 4.8867 % of the year after', () => {
    const result = dividendPlan({
      positionValue: 10000,
      yieldPctPerYear: 3,
      growthPctPerYear: 5,
      years: 10,
    });
    // Year 10 pays 300·1.05^9 = 465.3984649…
    expect(result.yearlyDividends[9]).toBeCloseTo(465.3984649, 6);
    expect(result.yieldOnCostFinalPct).toBeCloseTo(4.653984649, 8);
    expect(Number(result.yieldOnCostFinalPct.toFixed(2))).toBe(4.65);
  });

  test('an absurd horizon is bounded instead of allocating one element per year', () => {
    const result = dividendPlan({
      positionValue: 10000,
      yieldPctPerYear: 3,
      growthPctPerYear: 5,
      years: 1_000_000_000,
    });
    expect(result.yearlyDividends).toHaveLength(FORECAST_CALC_MAX_YEARS);
    // Nothing overflows to Infinity/NaN, so no stat degrades to an em-dash.
    expect(Number.isFinite(result.totalDividends)).toBe(true);
    expect(Number.isFinite(result.yieldOnCostFinalPct)).toBe(true);
    expect(result.yieldOnCostFinalPct).toBeCloseTo(
      3 * Math.pow(1.05, FORECAST_CALC_MAX_YEARS - 1),
      8,
    );
  });

  test('a negative or non-finite horizon pays nothing and keeps the current yield', () => {
    for (const years of [-1, -1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = dividendPlan({
        positionValue: 10000,
        yieldPctPerYear: 3,
        growthPctPerYear: 5,
        years,
      });
      expect(result.yearlyDividends).toEqual([]);
      expect(result.totalDividends).toBe(0);
      expect(result.yieldOnCostFinalPct).toBe(3);
    }
  });

  test('zero growth — flat annuity of positionValue·yield/100', () => {
    const result = dividendPlan({
      positionValue: 10000,
      yieldPctPerYear: 3,
      growthPctPerYear: 0,
      years: 5,
    });
    expect(result.yearlyDividends).toEqual([300, 300, 300, 300, 300]);
    expect(result.totalDividends).toBe(1500);
    expect(result.yieldOnCostFinalPct).toBe(3);
  });

  test('zero years — no payouts, YOC stays at the current yield', () => {
    const result = dividendPlan({
      positionValue: 5000,
      yieldPctPerYear: 4,
      growthPctPerYear: 5,
      years: 0,
    });
    expect(result.yearlyDividends).toEqual([]);
    expect(result.totalDividends).toBe(0);
    expect(result.yieldOnCostFinalPct).toBe(4);
  });
});

describe('withdrawalHorizon', () => {
  test('depletion case — 100 000 balance, 1 000 €/mo, 5 %/yr', () => {
    // rm = 1.05^(1/12) − 1 = 0.00407412…
    // monthly interest = 100 000 · rm = 407.4124 → 1000 > 407.41, depletes.
    // N = ln(1000 / (1000 − 100 000·rm)) / ln(1 + rm)
    //   = ln(1000 / 592.5876…) / ln(1.00407412…)
    //   ≈ 128.6956 months
    const result = withdrawalHorizon({
      balance: 100000,
      monthlyWithdrawal: 1000,
      annualReturnPct: 5,
    });
    expect(result.sustainable).toBe(false);
    expect(result.months).not.toBeNull();
    expect(result.months!).toBeCloseTo(128.6956, 3);
  });

  test('sustainable — withdrawal ≤ balance·rm, never depletes', () => {
    // Monthly interest at 5 %/yr on 100 000 = 407.41 — 400 is under it.
    const result = withdrawalHorizon({
      balance: 100000,
      monthlyWithdrawal: 400,
      annualReturnPct: 5,
    });
    expect(result.sustainable).toBe(true);
    expect(result.months).toBeNull();
  });

  test('zero return — depletion at B/W', () => {
    const result = withdrawalHorizon({
      balance: 1000,
      monthlyWithdrawal: 100,
      annualReturnPct: 0,
    });
    expect(result.sustainable).toBe(false);
    expect(result.months).toBe(10);
  });

  test('zero withdrawal — sustainable (trivially)', () => {
    const result = withdrawalHorizon({
      balance: 100000,
      monthlyWithdrawal: 0,
      annualReturnPct: 5,
    });
    expect(result.sustainable).toBe(true);
    expect(result.months).toBeNull();
  });
});

describe('withdrawalRate', () => {
  test('20-year drawdown, 100 000 balance, 5 %/yr', () => {
    // rm = 1.05^(1/12) − 1 ≈ 0.004074124, N = 240
    // (1 + rm)^240 = 1.05^20 ≈ 2.6532977 → W ≈ 653.836 …
    const result = withdrawalRate({
      balance: 100000,
      months: 240,
      annualReturnPct: 5,
    });
    expect(result.monthlyWithdrawal).toBeCloseTo(653.8365, 3);
  });

  test('zero return — even split, B/N', () => {
    const result = withdrawalRate({
      balance: 1200,
      months: 12,
      annualReturnPct: 0,
    });
    expect(result.monthlyWithdrawal).toBe(100);
  });

  test('zero horizon — zero withdrawal (no drawdown possible)', () => {
    const result = withdrawalRate({
      balance: 100,
      months: 0,
      annualReturnPct: 5,
    });
    expect(result.monthlyWithdrawal).toBe(0);
  });
});

// ─── Rate bounds (#1662) ─────────────────────────────────────────────────────
//
// Every solver clamps its percent-per-year inputs to the projection's own range
// (`FORECAST_RETURN_MIN_PCT`..`FORECAST_RETURN_MAX_PCT`) before any power or
// logarithm touches them. Below −100 %/yr `1 + r` turns negative, which used to
// produce `NaN` (a fractional power / a logarithm of a negative number), a
// negative final balance from a positive principal, or a dividend stream that
// flips sign every year. The fields are bare number inputs outside any form, so
// their `min`/`max` validate nothing on their own — these cases are what makes
// the bound real.

/** The absurd rates a user can type into an unbounded field. */
const ABSURD_RATES = [-1_000_000, -2000, -200, -100, 1_000_000];

/** Every numeric field of a result is finite; `null` (an explicit "no answer") passes. */
function expectFiniteOrNull(result: object) {
  for (const [key, value] of Object.entries(result)) {
    if (value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) expect(Number.isFinite(item), `${key} item ${item}`).toBe(true);
      continue;
    }
    if (typeof value !== 'number') continue;
    expect(Number.isFinite(value), `${key} = ${value}`).toBe(true);
  }
}

describe('rate bounds', () => {
  test.each(ABSURD_RATES)('compoundInterest stays finite at %d %%/yr', (rate) => {
    expectFiniteOrNull(
      compoundInterest({
        principal: 10000,
        monthlyContribution: 250,
        ratePctPerYear: rate,
        // A fractional horizon is what turned `Math.pow(1 + rp, N)` into `NaN`
        // once `1 + rp` was negative.
        years: 5.5,
        compoundingPerYear: 1,
      }),
    );
  });

  test.each(ABSURD_RATES)(
    'compoundInterest never reports less than nothing at %d %%/yr',
    (rate) => {
      // A non-negative principal plus non-negative contributions cannot end
      // below zero, whatever the loss: at the −100 %/yr floor the balance is the
      // contributions that arrived after the wipeout, never a negative figure.
      const result = compoundInterest({
        principal: 10000,
        monthlyContribution: 250,
        ratePctPerYear: rate,
        years: 3,
        compoundingPerYear: 1,
      });
      expect(result.finalBalance).toBeGreaterThanOrEqual(0);
    },
  );

  test.each(ABSURD_RATES)('savingsPlanContribution stays finite at %d %%/yr', (rate) => {
    const result = savingsPlanContribution({
      target: 100000,
      principal: 10000,
      ratePctPerYear: rate,
      years: 15,
      compoundingPerYear: 12,
    });
    expectFiniteOrNull(result);
    expect(result.monthlyContribution).toBeGreaterThanOrEqual(0);
  });

  test.each(ABSURD_RATES)('savingsPlanYears stays finite or null at %d %%/yr', (rate) => {
    const result = savingsPlanYears({
      target: 100000,
      principal: 10000,
      monthlyContribution: 250,
      ratePctPerYear: rate,
      compoundingPerYear: 12,
    });
    expectFiniteOrNull(result);
    if (result.years !== null) expect(result.years).toBeGreaterThanOrEqual(0);
  });

  test('savingsPlanYears reports no horizon at a total annual wipeout', () => {
    // −100 %/yr compounded once a year leaves no growth base at all
    // (`log(1 + rp)` is −∞), so no horizon reaches the target.
    expect(
      savingsPlanYears({
        target: 100000,
        principal: 10000,
        monthlyContribution: 250,
        ratePctPerYear: -100,
        compoundingPerYear: 1,
      }),
    ).toEqual({ years: null, feasible: false });
  });

  test.each(ABSURD_RATES)('dividendPlan stays finite at %d %%/yr on both rates', (rate) => {
    expectFiniteOrNull(
      dividendPlan({
        positionValue: 10000,
        yieldPctPerYear: rate,
        growthPctPerYear: rate,
        years: 10,
      }),
    );
  });

  test.each(ABSURD_RATES)('dividendPlan never flips the stream sign at %d %%/yr growth', (rate) => {
    const result = dividendPlan({
      positionValue: 10000,
      yieldPctPerYear: 3,
      growthPctPerYear: rate,
      years: 10,
    });
    // A positive position paying a positive yield: at the clamped floor `1 + g`
    // is 0, so the stream shrinks to zero rather than alternating ±10^n.
    for (const dividend of result.yearlyDividends) expect(dividend).toBeGreaterThanOrEqual(0);
    expect(result.yieldOnCostFinalPct).toBeGreaterThanOrEqual(0);
  });

  test.each(ABSURD_RATES)('withdrawalHorizon stays finite or null at %d %%/yr', (rate) => {
    const result = withdrawalHorizon({
      balance: 100000,
      monthlyWithdrawal: 500,
      annualReturnPct: rate,
    });
    expectFiniteOrNull(result);
    if (result.months !== null) expect(result.months).toBeGreaterThanOrEqual(0);
  });

  test('withdrawalHorizon: the -2000 %/yr case that rendered "≈ NaN months"', () => {
    const result = withdrawalHorizon({
      balance: 100000,
      monthlyWithdrawal: 500,
      annualReturnPct: -2000,
    });
    expect(Number.isNaN(result.months)).toBe(false);
    // Clamped to −100 %/yr, which under the tab's effective convention is a
    // TOTAL wipeout in the first month (rm = 1.00^(1/12) − 1 = −1), not a
    // −8.3 %/month drift: the balance is gone before a withdrawal can be taken.
    expect(result).toEqual(
      withdrawalHorizon({ balance: 100000, monthlyWithdrawal: 500, annualReturnPct: -100 }),
    );
    expect(result.months).toBe(0);
    expect(result.sustainable).toBe(false);
  });

  test.each(ABSURD_RATES)('withdrawalRate stays finite at %d %%/yr', (rate) => {
    const result = withdrawalRate({ balance: 100000, months: 240, annualReturnPct: rate });
    expectFiniteOrNull(result);
    expect(result.monthlyWithdrawal).toBeGreaterThanOrEqual(0);
  });

  test('an in-range rate is untouched by the clamp', () => {
    // The bound may not move any answer a real user gets: the fixture above
    // still holds verbatim.
    expect(
      withdrawalRate({ balance: 100000, months: 240, annualReturnPct: 5 }).monthlyWithdrawal,
    ).toBeCloseTo(653.8365, 3);
    expect(
      compoundInterest({
        principal: 1000,
        monthlyContribution: 0,
        ratePctPerYear: 5,
        years: 10,
        compoundingPerYear: 1,
      }).finalBalance,
    ).toBeCloseTo(1628.894626777, 6);
  });
});

// ─── One rate convention across the tab (#1892) ──────────────────────────────
//
// The projection compounds an annual rate geometrically while these solvers
// divided it nominally, so the SAME percentage answered two different questions
// on one page — and "Prefill from portfolio" pushed one figure (a CAGR, i.e. an
// effective rate by definition) into both. The vector below is the issue's:
// €100,000 at 8 %/yr for 20 years with no contributions.

describe('rate convention', () => {
  const PRINCIPAL = 100_000;
  const RATE_PCT = 8;
  const YEARS = 20;
  /** 100 000 · 1.08^20 — the compound-growth answer, by hand. */
  const EXPECTED = PRINCIPAL * Math.pow(1 + RATE_PCT / 100, YEARS);

  /** The projection's answer for the same lump sum, factors otherwise off. */
  function projected(): number {
    const result = projectNetWorth({
      asOf: '2026-01-01',
      startingNetWorth: PRINCIPAL,
      horizonYears: YEARS,
      annualReturnPct: RATE_PCT,
      standingOrders: [],
      monthlyDividend: 0,
      whatIfPlans: [],
    });
    return result.base[result.base.length - 1]!.value;
  }

  test('one annual percentage, one final balance — projection and calculator agree', () => {
    expect(EXPECTED).toBeCloseTo(466_095.71, 2);
    expect(projected()).toBeCloseTo(EXPECTED, 2);
    for (const compoundingPerYear of [1, 2, 4, 12, 365]) {
      const card = compoundInterest({
        principal: PRINCIPAL,
        monthlyContribution: 0,
        ratePctPerYear: RATE_PCT,
        years: YEARS,
        compoundingPerYear,
      });
      // The compounding knob sets the schedule, not the yield: an effective
      // annual rate reaches the same lump-sum balance at every n. The nominal
      // reading answered 492 680 at n = 12 — 5,7 % above the projection.
      expect(card.finalBalance).toBeCloseTo(EXPECTED, 6);
    }
  });

  test('the sampled CAGR is spent as the effective rate it is', () => {
    // What "Prefill from my portfolio" hands the cards: an annualised
    // time-weighted return. Re-compounding it 12×/yr made it 8.30 % effective.
    const nominalReading = PRINCIPAL * Math.pow(1 + RATE_PCT / 100 / 12, 12 * YEARS);
    expect(nominalReading).toBeCloseTo(492_680.28, 2);
    expect(nominalReading / EXPECTED).toBeGreaterThan(1.05);
    expect(
      compoundInterest({
        principal: PRINCIPAL,
        monthlyContribution: 0,
        ratePctPerYear: RATE_PCT,
        years: YEARS,
        compoundingPerYear: 12,
      }).finalBalance,
    ).not.toBeCloseTo(nominalReading, 2);
  });
});
