import { describe, expect, it } from 'vitest';

import {
  computeContributions,
  computeSeriesStats,
  deflateSeries,
  toPerformanceSeries,
  type ContributionInput,
  type SeriesStats,
  type StatSeriesPoint,
} from '../seriesStats';

// --- Helpers ---------------------------------------------------------------

/** A frozen series point — mutation by the implementation would throw. */
function pt(date: string, value: number): StatSeriesPoint {
  return Object.freeze({ date, value });
}

/** What every degenerate series must produce (the guarded defaults). */
const ZEROED: SeriesStats = {
  totalReturnPct: 0,
  cagrPct: null,
  maxDrawdownPct: 0,
  bestDay: null,
  worstDay: null,
};

// ---------------------------------------------------------------------------
// computeSeriesStats — hand-computed fixtures
// ---------------------------------------------------------------------------

describe('computeSeriesStats — hand-computed fixtures', () => {
  it('flat series (five days at 100): everything zero, ties resolve to the first day', () => {
    const stats = computeSeriesStats([
      pt('2024-01-01', 100),
      pt('2024-01-02', 100),
      pt('2024-01-03', 100),
      pt('2024-01-04', 100),
      pt('2024-01-05', 100),
    ]);

    expect(stats.totalReturnPct).toBeCloseTo(0, 12);
    expect(stats.maxDrawdownPct).toBeCloseTo(0, 12);
    // years > 0, ratio 1 → CAGR is 0, not null.
    expect(stats.cagrPct ?? Number.NaN).toBeCloseTo(0, 12);
    // All daily returns are exactly 0 → strict >/< keeps the FIRST occurrence.
    expect(stats.bestDay?.date).toBe('2024-01-02');
    expect(stats.bestDay?.returnPct ?? Number.NaN).toBeCloseTo(0, 12);
    expect(stats.worstDay?.date).toBe('2024-01-02');
    expect(stats.worstDay?.returnPct ?? Number.NaN).toBeCloseTo(0, 12);
  });

  it('monotonic-up series (100, 110, 121): +21 % total, zero drawdown, both days +10 %', () => {
    const stats = computeSeriesStats([
      pt('2024-01-01', 100),
      pt('2024-01-02', 110),
      pt('2024-01-03', 121),
    ]);

    expect(stats.totalReturnPct).toBeCloseTo(21, 9);
    expect(stats.maxDrawdownPct).toBeCloseTo(0, 12);
    expect(stats.cagrPct).not.toBeNull();
    expect(stats.cagrPct ?? Number.NaN).toBeGreaterThan(0);
    // 110/100 and 121/110 both have the exact real quotient 1.1, so they round
    // to the identical double → a tie → first occurrence wins (day 2).
    expect(stats.bestDay?.returnPct ?? Number.NaN).toBeCloseTo(10, 9);
    expect(stats.bestDay?.date).toBe('2024-01-02');
    expect(stats.worstDay?.returnPct ?? Number.NaN).toBeCloseTo(10, 9);
    expect(stats.worstDay?.date).toBe('2024-01-02');
  });

  it('drawdown-then-recover (100, 80, 100): 0 % total, −20 % drawdown, +25 %/−20 % days', () => {
    const stats = computeSeriesStats([
      pt('2024-01-01', 100),
      pt('2024-01-02', 80),
      pt('2024-01-03', 100),
    ]);

    expect(stats.totalReturnPct).toBeCloseTo(0, 12);
    expect(stats.cagrPct ?? Number.NaN).toBeCloseTo(0, 12);
    expect(stats.maxDrawdownPct).toBeCloseTo(-20, 9);
    expect(stats.bestDay?.date).toBe('2024-01-03'); // 100/80 − 1 = +25 %
    expect(stats.bestDay?.returnPct ?? Number.NaN).toBeCloseTo(25, 12);
    expect(stats.worstDay?.date).toBe('2024-01-02'); // 80/100 − 1 = −20 %
    expect(stats.worstDay?.returnPct ?? Number.NaN).toBeCloseTo(-20, 9);
  });

  it('CAGR over exactly 4 years (1461 days incl. one leap day): 100 → 146.41 ≈ 10 %/yr', () => {
    // 2020-01-01 → 2024-01-01 is 1461 days = 4 · 365.25, so years === 4 exactly
    // and 1.4641^(1/4) − 1 = 10 %.
    const stats = computeSeriesStats([pt('2020-01-01', 100), pt('2024-01-01', 146.41)]);

    expect(stats.totalReturnPct).toBeCloseTo(46.41, 9);
    expect(stats.cagrPct ?? Number.NaN).toBeCloseTo(10, 9);
  });
});

describe('computeSeriesStats — guards & degenerate series', () => {
  it.each<[string, StatSeriesPoint[]]>([
    ['empty series', []],
    ['zero first value', [pt('2024-01-01', 0), pt('2024-01-02', 50)]],
    ['negative first value', [pt('2024-01-01', -5), pt('2024-01-02', 50)]],
  ])('%s → zeroed defaults with null CAGR/best/worst', (_label, series) => {
    expect(computeSeriesStats(series)).toEqual(ZEROED);
  });

  it('single-point series: zero returns via the normal path, cagr/best/worst null', () => {
    expect(computeSeriesStats([pt('2024-01-01', 100)])).toEqual(ZEROED);
  });

  it('skips the daily return over a non-positive PREVIOUS value mid-series', () => {
    // Day 2 (100 → 0, prev positive) is a valid −100 % return; day 3 (0 → 50)
    // has no meaningful ratio base and must be skipped, not divided.
    const stats = computeSeriesStats([
      pt('2024-01-01', 100),
      pt('2024-01-02', 0),
      pt('2024-01-03', 50),
    ]);

    expect(stats.totalReturnPct).toBeCloseTo(-50, 12);
    expect(stats.maxDrawdownPct).toBeCloseTo(-100, 12);
    expect(stats.bestDay).toEqual({ date: '2024-01-02', returnPct: -100 });
    expect(stats.worstDay).toEqual({ date: '2024-01-02', returnPct: -100 });
  });

  it('skips the daily return over a NEGATIVE previous value as well', () => {
    const stats = computeSeriesStats([
      pt('2024-01-01', 100),
      pt('2024-01-02', -50),
      pt('2024-01-03', 25),
    ]);

    // Only day 2 (100 → −50 = −150 %) yields a return; day 3's base is ≤ 0.
    expect(stats.bestDay).toEqual({ date: '2024-01-02', returnPct: -150 });
    expect(stats.worstDay).toEqual({ date: '2024-01-02', returnPct: -150 });
  });
});

// ---------------------------------------------------------------------------
// toPerformanceSeries
// ---------------------------------------------------------------------------

describe('toPerformanceSeries', () => {
  it('rebases to cumulative % from the first point (first point exactly 0)', () => {
    const perf = toPerformanceSeries([
      pt('2024-01-01', 100),
      pt('2024-01-02', 110),
      pt('2024-01-03', 95),
    ]);

    expect(perf).toHaveLength(3);
    expect(perf[0]).toEqual({ date: '2024-01-01', pct: 0 });
    expect(perf[0]?.pct).toBe(0); // exactly zero, not merely close
    expect(perf[1]?.date).toBe('2024-01-02');
    expect(perf[1]?.pct ?? Number.NaN).toBeCloseTo(10, 9);
    expect(perf[2]?.date).toBe('2024-01-03');
    expect(perf[2]?.pct ?? Number.NaN).toBeCloseTo(-5, 9);
  });

  it('returns [] for an empty series', () => {
    expect(toPerformanceSeries([])).toEqual([]);
  });

  it.each<[string, StatSeriesPoint[]]>([
    ['zero base', [pt('2024-01-01', 0), pt('2024-01-02', 50)]],
    ['negative base', [pt('2024-01-01', -10), pt('2024-01-02', 5)]],
  ])('%s → every point emitted as 0 % (guarded division)', (_label, series) => {
    expect(toPerformanceSeries(series)).toEqual([
      { date: '2024-01-01', pct: 0 },
      { date: '2024-01-02', pct: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// deflateSeries — flat rate
// ---------------------------------------------------------------------------

describe('deflateSeries — flat rate (V3-P9 required test: a custom 10 %/yr inflation rate bends a flat nominal curve downward)', () => {
  const flatNominal: readonly StatSeriesPoint[] = Object.freeze([
    pt('2024-01-01', 1000),
    pt('2024-07-01', 1000),
    pt('2025-01-01', 1000),
    pt('2025-07-01', 1000),
    pt('2026-01-01', 1000),
  ]);

  it('slopes a flat nominal series downward at 10 %/yr over ~2 years', () => {
    const real = deflateSeries(flatNominal, { kind: 'flat', pctPerYear: 10 });

    expect(real).toHaveLength(5);
    // Base = first point: real terms are expressed in start-date money.
    expect(real[0]?.value).toBe(1000);
    // Monotonically non-increasing all the way down …
    for (let i = 1; i < real.length; i += 1) {
      expect(real[i]?.value ?? Number.NaN).toBeLessThanOrEqual(real[i - 1]?.value ?? Number.NaN);
    }
    // … and the end is STRICTLY below the start: the flat curve visibly bends down.
    const last = real[real.length - 1]?.value ?? Number.NaN;
    expect(last).toBeLessThan(1000);
    // 2024-01-01 → 2026-01-01 is 731 days (2024 is a leap year), so
    // last = 1000 · 1.1^(−731/365.25) ≈ 826.34 (a ~17.4 % purchasing-power loss).
    expect(last).toBeCloseTo(1000 * 1.1 ** -(731 / 365.25), 8);
    expect(last).toBeCloseTo(826.34, 1);
    // Dates preserved, input untouched.
    expect(real.map((p) => p.date)).toEqual(flatNominal.map((p) => p.date));
    expect(flatNominal.every((p) => p.value === 1000)).toBe(true);
  });

  it('a 0 %/yr rate is the identity (values unchanged, fresh array)', () => {
    const real = deflateSeries(flatNominal, { kind: 'flat', pctPerYear: 0 });

    expect(real).toEqual(flatNominal.map((p) => ({ date: p.date, value: p.value })));
    expect(real).not.toBe(flatNominal);
  });

  it('returns [] for an empty series', () => {
    expect(deflateSeries([], { kind: 'flat', pctPerYear: 10 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deflateSeries — monthly index
// ---------------------------------------------------------------------------

describe('deflateSeries — monthly index (HICP/CPI mode)', () => {
  // Deliberately unsorted; frozen so an in-place sort would throw.
  const monthly = Object.freeze([
    Object.freeze({ month: '2024-02', value: 101 }),
    Object.freeze({ month: '2024-04', value: 103 }),
    Object.freeze({ month: '2024-01', value: 100 }),
  ]);

  it('deflates a flat nominal series downward, with carry-forward and earliest-entry floor', () => {
    const series = [
      pt('2023-12-15', 500), // before the earliest entry → floors to the 2024-01 level (100)
      pt('2024-01-15', 500), // exact month match (100)
      pt('2024-02-15', 500), // exact month match (101)
      pt('2024-03-15', 500), // no 2024-03 entry → carries 2024-02 forward (101)
      pt('2024-05-15', 500), // no 2024-05 entry → carries 2024-04 forward (103)
    ];
    const real = deflateSeries(series, { kind: 'index', monthly });

    // Base = first point, so real[0] is the nominal value exactly.
    expect(real[0]?.value).toBe(500);
    expect(real[1]?.value ?? Number.NaN).toBeCloseTo(500, 12); // 500 · 100/100
    expect(real[2]?.value ?? Number.NaN).toBeCloseTo(50000 / 101, 9); // ≈ 495.05
    expect(real[3]?.value ?? Number.NaN).toBeCloseTo(50000 / 101, 9); // carry-forward
    expect(real[4]?.value ?? Number.NaN).toBeCloseTo(50000 / 103, 9); // ≈ 485.44
    // A rising index only ever pushes the flat curve down.
    for (let i = 1; i < real.length; i += 1) {
      expect(real[i]?.value ?? Number.NaN).toBeLessThanOrEqual(real[i - 1]?.value ?? Number.NaN);
    }
    expect(real.map((p) => p.date)).toEqual(series.map((p) => p.date));
  });

  it('an empty monthly index returns the series unchanged, as a fresh copy', () => {
    const series = [pt('2024-01-01', 100), pt('2024-02-01', 120)];
    const real = deflateSeries(series, { kind: 'index', monthly: [] });

    expect(real).toEqual([
      { date: '2024-01-01', value: 100 },
      { date: '2024-02-01', value: 120 },
    ]);
    expect(real).not.toBe(series);
    expect(real[0]).not.toBe(series[0]);
  });

  it('returns [] for an empty series', () => {
    expect(deflateSeries([], { kind: 'index', monthly })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeContributions
// ---------------------------------------------------------------------------

describe('computeContributions', () => {
  const inputs: ContributionInput[] = [
    { assetId: 'a', startValue: 1000, endValue: 1200, currentValue: 1300 },
    { assetId: 'b', startValue: 500, endValue: 450, currentValue: 480 },
    { assetId: 'c', startValue: 250, endValue: 300, currentValue: 0 },
  ];
  const totalStart = 1000 + 500 + 250; // 1750
  const totalEnd = 1200 + 450 + 300; // 1950
  const totalCurrent = 1300 + 480 + 0; // 1780

  it('rows sum to the filtered total return and weights sum to 1, order preserved', () => {
    const rows = computeContributions(inputs);

    expect(rows.map((r) => r.assetId)).toEqual(['a', 'b', 'c']);
    const contributionSum = rows.reduce((s, r) => s + r.contributionPct, 0);
    expect(contributionSum).toBeCloseTo((totalEnd / totalStart - 1) * 100, 9);
    const weightSum = rows.reduce((s, r) => s + r.weight, 0);
    expect(weightSum).toBeCloseTo(1, 12);
  });

  it('computes each row against the COMMON totals (hand-computed)', () => {
    const rows = computeContributions(inputs);

    expect(rows[0]?.weight ?? Number.NaN).toBeCloseTo(1300 / totalCurrent, 12);
    expect(rows[0]?.contributionPct ?? Number.NaN).toBeCloseTo((200 / totalStart) * 100, 12); // ≈ +11.43
    expect(rows[1]?.weight ?? Number.NaN).toBeCloseTo(480 / totalCurrent, 12);
    expect(rows[1]?.contributionPct ?? Number.NaN).toBeCloseTo((-50 / totalStart) * 100, 12); // ≈ −2.86
    expect(rows[2]?.weight).toBe(0); // sold out: no current value, exact zero
    expect(rows[2]?.contributionPct ?? Number.NaN).toBeCloseTo((50 / totalStart) * 100, 12); // ≈ +2.86
  });

  it('returns [] for empty input', () => {
    expect(computeContributions([])).toEqual([]);
  });

  it('zero current total → all weights 0 (contributions still computed)', () => {
    const rows = computeContributions([
      { assetId: 'a', startValue: 100, endValue: 150, currentValue: 0 },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.weight).toBe(0);
    expect(rows[0]?.contributionPct ?? Number.NaN).toBeCloseTo(50, 12);
  });

  it('start total within ±1e-9 of zero → contributions 0 (guarded division)', () => {
    const rows = computeContributions([
      { assetId: 'a', startValue: 100, endValue: 150, currentValue: 50 },
      { assetId: 'b', startValue: -100, endValue: -100, currentValue: 50 },
    ]);

    expect(rows.map((r) => r.contributionPct)).toEqual([0, 0]);
    expect(rows.map((r) => r.weight)).toEqual([0.5, 0.5]);
  });
});
