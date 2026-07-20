import { describe, expect, it } from 'vitest';

import type { FlowPoint, ValuePoint } from '../../../domain/holdings';
import {
  buildIntradayEurValuePoints,
  downsampledIndices,
  intradayFetchRange,
  intradayIntervalFor,
  intradayPerformancePoints,
  intradayStepMs,
  isDownsampledRange,
  isIntradayRange,
  TARGET_POINTS,
  type IntradayCandle,
  type IntradayValuePoint,
} from '../portfolioIntraday';

/**
 * Pure math for the intraday portfolio curve (issue #556): value assembly by
 * per-asset intraday ratio anchored to the daily snapshot, and the daily-TWR-
 * anchored performance curve. The IO (provider fetch, ring reuse, fx
 * re-denomination) lives in the portfolio service; here we drive the algorithm
 * directly with fixture candles.
 */

const Y = '2026-06-15'; // yesterday
const T = '2026-06-16'; // today
const NOW_MS = Date.parse(`${T}T20:00:00.000Z`);
const MIN = 60_000;

/** `count` candles on `day` from 09:00 UTC at `stepMs` spacing, priced by `price(i)`. */
function candlesForDay(
  day: string,
  count: number,
  stepMs: number,
  price: (i: number) => number,
): IntradayCandle[] {
  const base = Date.parse(`${day}T09:00:00.000Z`);
  return Array.from({ length: count }, (_, i) => ({ atMs: base + i * stepMs, price: price(i) }));
}

describe('point-budget range routing + config', () => {
  it('routes 1D/1W/1M through the intraday curve and 6M/1Y/5Y through the daily downsample', () => {
    for (const r of ['1D', '1W', '1M'] as const) {
      expect(isIntradayRange(r)).toBe(true);
      expect(isDownsampledRange(r)).toBe(false);
    }
    for (const r of ['6M', '1Y', '5Y'] as const) {
      expect(isDownsampledRange(r)).toBe(true);
      expect(isIntradayRange(r)).toBe(false);
    }
    // MAX is neither: full daily since-inception curve.
    expect(isIntradayRange('MAX')).toBe(false);
    expect(isDownsampledRange('MAX')).toBe(false);
  });

  it('keeps 1D/1W fine (owner-approved) and coarsens 1M to the point budget', () => {
    expect(intradayIntervalFor('1D')).toBe('15m');
    expect(intradayStepMs('1D')).toBe(15 * MIN);
    expect(intradayFetchRange('1D')).toBe('1D');

    expect(intradayIntervalFor('1W')).toBe('30m');
    expect(intradayStepMs('1W')).toBe(60 * MIN);
    expect(intradayFetchRange('1W')).toBe('1W');

    // 1M keeps 30-minute candles but a budget-sized grid ≈ 31-day span / TARGET
    // (a few hours) — NOT the 30-minute fetch granularity.
    expect(intradayIntervalFor('1M')).toBe('30m');
    expect(intradayFetchRange('1M')).toBe('1M');
    const expected1MStep = Math.round((31 * 24 * 60) / TARGET_POINTS) * MIN;
    expect(intradayStepMs('1M')).toBe(expected1MStep);
    // Coarser than the hourly 1W grid and the 30-minute fetch, finer than a day.
    expect(intradayStepMs('1M')).toBeGreaterThan(intradayStepMs('1W'));
    expect(intradayStepMs('1M')).toBeGreaterThan(30 * MIN);
    expect(intradayStepMs('1M')).toBeLessThan(24 * 60 * MIN);
  });
});

describe('downsampledIndices — daily thinning to the point budget', () => {
  it('returns every index unchanged when the series is already within budget', () => {
    expect(downsampledIndices(0, TARGET_POINTS)).toEqual([]);
    expect(downsampledIndices(5, TARGET_POINTS)).toEqual([0, 1, 2, 3, 4]);
    expect(downsampledIndices(TARGET_POINTS, TARGET_POINTS)).toHaveLength(TARGET_POINTS);
  });

  it('thins a long series to ≤ target: every k-th index, endpoints kept, ascending', () => {
    const n = 1830; // ~5 years of daily points
    const idx = downsampledIndices(n, TARGET_POINTS);
    expect(idx.length).toBeLessThanOrEqual(TARGET_POINTS + 1);
    expect(idx[0]).toBe(0); // window start kept (re-bases to 0 %)
    expect(idx[idx.length - 1]).toBe(n - 1); // today kept (fresh value)
    const k = Math.ceil(n / TARGET_POINTS);
    for (let i = 1; i < idx.length; i += 1) expect(idx[i]!).toBeGreaterThan(idx[i - 1]!);
    // Interior stride is exactly k (only the forced-last step may be shorter).
    for (let i = 1; i < idx.length - 1; i += 1) expect(idx[i]! - idx[i - 1]!).toBe(k);
    // A 5-year daily chart no longer plots ~1830 points.
    expect(idx.length).toBeLessThan(n / 5);
  });
});

describe('buildIntradayEurValuePoints — density & anchoring', () => {
  it('renders a dense (≥20) 1D curve whose last point equals the fresh daily value', () => {
    // One EUR asset worth 1080 today (scale 10 = units·fx, native refClose 108).
    const candles = candlesForDay(T, 26, 15 * MIN, (i) => 100 + i * 0.32); // 100 → 108
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: Y,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([
        [Y, 1000],
        [T, 1080],
      ]),
      perAssetEurByDay: new Map([
        [
          'a',
          new Map([
            [Y, 1000],
            [T, 1080],
          ]),
        ],
      ]),
      candlesByAsset: new Map([['a', candles]]),
    });

    // 26 intraday buckets on T + 1 daily-fallback point for Y (no candles).
    expect(points.length).toBe(27);
    expect(points.length).toBeGreaterThanOrEqual(20);
    // Ascending, all finite, all in-window.
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!.timeMs).toBeGreaterThan(points[i - 1]!.timeMs);
      expect(Number.isFinite(points[i]!.valueEur)).toBe(true);
    }
    // Yesterday carries its single daily point (the intraday↔daily boundary).
    expect(points[0]!.date).toBe(Y);
    expect(points[0]!.valueEur).toBeCloseTo(1000, 9);
    // The last point stitches to the fresh daily "today" value exactly (ratio 1
    // at the reference close) — no gap, no double-count.
    const last = points[points.length - 1]!;
    expect(last.date).toBe(T);
    expect(last.valueEur).toBeCloseTo(1080, 9);
    // A mid candle (native 100 = first) values at scale·price = 10·100 = 1000.
    const firstToday = points.find((p) => p.date === T)!;
    expect(firstToday.valueEur).toBeCloseTo(1000, 9);
  });

  it('carries an asset with no intraday history forward, keeping the curve complete', () => {
    // Market asset 'm' (1000, refClose 110) + custom asset 'c' (500, no candles).
    const candles = candlesForDay(T, 3, 15 * MIN, (i) => [100, 105, 110][i]!);
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: T, // window = today only, keep the case tight
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([[T, 1500]]),
      perAssetEurByDay: new Map([
        ['m', new Map([[T, 1000]])],
        ['c', new Map([[T, 500]])],
      ]),
      candlesByAsset: new Map([['m', candles]]),
    });

    expect(points.length).toBe(3);
    // Every point includes the custom asset's flat 500 (carry-forward) + market.
    expect(points[0]!.valueEur).toBeCloseTo(1000 * (100 / 110) + 500, 9);
    expect(points[1]!.valueEur).toBeCloseTo(1000 * (105 / 110) + 500, 9);
    // Close stitches to the daily net worth exactly.
    expect(points[2]!.valueEur).toBeCloseTo(1500, 9);
  });

  it('degrades to the daily slice (one point per day) when no asset has intraday data', () => {
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: Y,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([
        [Y, 1000],
        [T, 1080],
      ]),
      perAssetEurByDay: new Map([
        [
          'a',
          new Map([
            [Y, 1000],
            [T, 1080],
          ]),
        ],
      ]),
      candlesByAsset: new Map(), // provider returned nothing for any asset
    });
    expect(points.map((p) => [p.date, p.valueEur])).toEqual([
      [Y, 1000],
      [T, 1080],
    ]);
  });

  it('densifies a 1M window sub-daily on the covered day; older days stay daily', () => {
    // 1M carries candles only inside the recent window: the covered day gets a
    // sub-daily curve on the budget grid (a few points, NOT one per 30-minute
    // candle), older in-window days keep their single daily point, and the tail
    // stitches to the fresh daily "today" value.
    const D1 = '2026-06-13';
    const D2 = '2026-06-14';
    // A full trading day of 30-minute candles on T (09:00–18:30), refClose 103.8.
    const candles = candlesForDay(T, 20, 30 * MIN, (i) => 100 + i * 0.2);
    const points = buildIntradayEurValuePoints({
      range: '1M',
      cutoffDay: D1,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([
        [D1, 100],
        [D2, 102],
        [Y, 103],
        [T, 103.8],
      ]),
      perAssetEurByDay: new Map([
        [
          'a',
          new Map([
            [D1, 100],
            [D2, 102],
            [Y, 103],
            [T, 103.8],
          ]),
        ],
      ]),
      candlesByAsset: new Map([['a', candles]]),
    });

    // Older days (no candles) contribute exactly their daily value, one point each.
    const older = points.filter((p) => p.date !== T);
    expect(older.map((p) => [p.date, p.valueEur])).toEqual([
      [D1, 100],
      [D2, 102],
      [Y, 103],
    ]);
    // The covered day is genuinely sub-daily but coarsened to the budget grid —
    // more than one point, far fewer than the 20 raw candles.
    const todayPts = points.filter((p) => p.date === T);
    expect(todayPts.length).toBeGreaterThan(1);
    expect(todayPts.length).toBeLessThan(candles.length);
    // Tail stitches to the fresh daily "today" value; curve is ordered & finite.
    expect(points[points.length - 1]!.valueEur).toBeCloseTo(103.8, 9);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!.timeMs).toBeGreaterThan(points[i - 1]!.timeMs);
      expect(Number.isFinite(points[i]!.valueEur)).toBe(true);
    }
  });

  it('quantizes 1W 30-minute candles onto an hourly grid', () => {
    // Candles at 09:00, 09:30, 10:00, 10:30, 11:00 → hourly buckets 9/10/11.
    const candles = candlesForDay(T, 5, 30 * MIN, (i) => 100 + i); // 100..104, refClose 104
    const points = buildIntradayEurValuePoints({
      range: '1W',
      cutoffDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([[T, 104]]),
      perAssetEurByDay: new Map([['a', new Map([[T, 104]])]]), // scale 1 (units·fx = 1)
      candlesByAsset: new Map([['a', candles]]),
    });
    // Three hourly buckets, each taking the last candle within the hour.
    expect(points.length).toBe(3);
    expect(points.map((p) => p.valueEur.toFixed(4))).toEqual([
      (101).toFixed(4), // 09:00 bucket → last <10:00 is 09:30 (native 101)
      (103).toFixed(4), // 10:00 bucket → last <11:00 is 10:30 (native 103)
      (104).toFixed(4), // 11:00 bucket → 11:00 (native 104), also refClose
    ]);
  });
});

describe('intradayPerformancePoints — daily-TWR anchored', () => {
  const dailyBase: ValuePoint[] = [
    { date: Y, valueEur: 1000 },
    { date: T, valueEur: 1080 },
  ];

  it('telescopes to the daily TWR at close and re-bases the window to 0 %', () => {
    const intraday: IntradayValuePoint[] = [
      { date: T, timeMs: Date.parse(`${T}T09:00:00Z`), valueEur: 1000 },
      { date: T, timeMs: Date.parse(`${T}T12:00:00Z`), valueEur: 1040 },
      { date: T, timeMs: Date.parse(`${T}T16:00:00Z`), valueEur: 1080 },
    ];
    const perf = intradayPerformancePoints({
      intradayPoints: intraday,
      dailyBasePoints: dailyBase,
      flowsBase: [],
    });
    expect(perf.map((p) => Number(p.pct.toFixed(6)))).toEqual([0, 4, 8]);
    // Close matches the daily TWR for today (1080/1000 − 1 = 8 %).
    expect(perf[perf.length - 1]!.pct).toBeCloseTo(8, 9);
  });

  it('neutralizes a same-day deposit — the % curve does not jump', () => {
    // Holdings flat at 1000; a 500 deposit lifts net worth to 1500 with no move.
    const daily: ValuePoint[] = [
      { date: Y, valueEur: 1000 },
      { date: T, valueEur: 1500 },
    ];
    const flows: FlowPoint[] = [{ date: T, flowEur: 500 }];
    const intraday: IntradayValuePoint[] = [
      { date: T, timeMs: Date.parse(`${T}T10:00:00Z`), valueEur: 1500 },
      { date: T, timeMs: Date.parse(`${T}T15:00:00Z`), valueEur: 1500 },
    ];
    const perf = intradayPerformancePoints({
      intradayPoints: intraday,
      dailyBasePoints: daily,
      flowsBase: flows,
    });
    for (const p of perf) expect(p.pct).toBeCloseTo(0, 9);
  });

  it('returns nothing for an empty input', () => {
    expect(
      intradayPerformancePoints({ intradayPoints: [], dailyBasePoints: dailyBase, flowsBase: [] }),
    ).toEqual([]);
  });
});
