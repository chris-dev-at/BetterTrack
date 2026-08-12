import { describe, expect, it } from 'vitest';

import {
  PORTFOLIO_HISTORY_INTERVALS,
  PORTFOLIO_HISTORY_RANGES,
  portfolioHistoryQuerySchema,
  type PortfolioHistoryInterval,
  type PortfolioHistoryRange,
  type PortfolioHistoryResolvedInterval,
} from '@bettertrack/contracts';

import {
  buildIntradayEurValuePoints,
  resolveHistoryInterval,
  TARGET_POINTS,
  type IntradayCandle,
} from '../portfolioIntraday';

/**
 * Client-selectable series interval (IN3, board #76 item 2): resolution of the
 * requested interval against each range, the finest-fit coarsening rule, the
 * point-budget and UTC-day-divisor invariants every resolved grid must hold,
 * and the pure builder honoring an explicit grid step. The IO plumbing (fetch
 * interval per asset, response echo) is covered end-to-end in
 * `apps/api/src/__tests__/portfolioHistoryInterval.test.ts`.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const Y = '2026-06-15'; // yesterday
const T = '2026-06-16'; // today
const NOW_MS = Date.parse(`${T}T22:00:00.000Z`);

/** `count` candles on `day` from 08:00 UTC at `stepMs` spacing, priced by `price(i)`. */
function candlesForDay(
  day: string,
  count: number,
  stepMs: number,
  price: (i: number) => number,
): IntradayCandle[] {
  const base = Date.parse(`${day}T08:00:00.000Z`);
  return Array.from({ length: count }, (_, i) => ({ atMs: base + i * stepMs, price: price(i) }));
}

/**
 * The full auto-resolution + finest-fit table (IN3). One row per (range,
 * request) pair — exhaustive over both enums, so a new range or interval value
 * fails here until the table says what it resolves to.
 */
const RESOLUTION: Record<
  PortfolioHistoryRange,
  Record<PortfolioHistoryInterval, PortfolioHistoryResolvedInterval>
> = {
  // 1D serves 5m..1h; auto is the NEW 5-minute grid (the owner's "more 1D
  // detail"); '1m' exceeds the budget (1440 worst-case buckets) → finest fit 5m.
  '1D': { auto: '5m', '1m': '5m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1d': '1d' },
  // 1W serves only the hourly grid (30m → 336 worst-case buckets busts the
  // budget); auto unchanged.
  '1W': { auto: '1h', '1m': '1h', '5m': '1h', '15m': '1h', '30m': '1h', '1h': '1h', '1d': '1d' },
  // 1M serves only its established 144-minute budget grid; auto unchanged.
  '1M': {
    auto: '144m',
    '1m': '144m',
    '5m': '144m',
    '15m': '144m',
    '30m': '144m',
    '1h': '144m',
    '1d': '1d',
  },
  // No sub-daily data exists at these spans: everything is the daily grid.
  '6M': { auto: '1d', '1m': '1d', '5m': '1d', '15m': '1d', '30m': '1d', '1h': '1d', '1d': '1d' },
  '1Y': { auto: '1d', '1m': '1d', '5m': '1d', '15m': '1d', '30m': '1d', '1h': '1d', '1d': '1d' },
  '5Y': { auto: '1d', '1m': '1d', '5m': '1d', '15m': '1d', '30m': '1d', '1h': '1d', '1d': '1d' },
  MAX: { auto: '1d', '1m': '1d', '5m': '1d', '15m': '1d', '30m': '1d', '1h': '1d', '1d': '1d' },
};

/** Worst-case span (whole days) a range's sub-daily grid must cover. */
const SPAN_DAYS: Partial<Record<PortfolioHistoryRange, number>> = { '1D': 1, '1W': 7, '1M': 31 };

/** Provider fetch interval → its native candle spacing in ms. */
const FETCH_SPACING_MS: Record<string, number> = {
  '1m': 1 * MIN,
  '15m': 15 * MIN,
  '30m': 30 * MIN,
};

describe('resolveHistoryInterval — the IN3 resolution table', () => {
  const pairs = PORTFOLIO_HISTORY_RANGES.flatMap((range) =>
    PORTFOLIO_HISTORY_INTERVALS.map((requested) => [range, requested] as const),
  );

  it.each(pairs)('%s × %s resolves per the table', (range, requested) => {
    const resolved = resolveHistoryInterval(range, requested);
    expect(resolved.interval).toBe(RESOLUTION[range][requested]);
    // `1d` ⇔ no sub-daily grid to build; every sub-daily resolution carries one.
    if (resolved.interval === '1d') expect(resolved.grid).toBeUndefined();
    else expect(resolved.grid).toBeDefined();
  });

  it('auto = the finer 5-minute 1D grid fetched from 1-minute candles; other ranges unchanged', () => {
    expect(resolveHistoryInterval('1D', 'auto')).toEqual({
      interval: '5m',
      grid: { stepMs: 5 * MIN, fetchInterval: '1m', fetchRange: '1D' },
    });
    expect(resolveHistoryInterval('1W', 'auto')).toEqual({
      interval: '1h',
      grid: { stepMs: 60 * MIN, fetchInterval: '30m', fetchRange: '1W' },
    });
    expect(resolveHistoryInterval('1M', 'auto')).toEqual({
      interval: '144m',
      grid: { stepMs: 144 * MIN, fetchInterval: '30m', fetchRange: '1M' },
    });
    for (const range of ['6M', '1Y', '5Y', 'MAX'] as const) {
      expect(resolveHistoryInterval(range, 'auto')).toEqual({ interval: '1d' });
    }
  });

  it('honors an explicit servable interval exactly (no silent re-coarsening)', () => {
    expect(resolveHistoryInterval('1D', '15m').grid).toEqual({
      stepMs: 15 * MIN,
      fetchInterval: '15m',
      fetchRange: '1D',
    });
    expect(resolveHistoryInterval('1D', '30m').grid?.stepMs).toBe(30 * MIN);
    expect(resolveHistoryInterval('1D', '1h').grid?.stepMs).toBe(60 * MIN);
    expect(resolveHistoryInterval('1W', '1h').grid?.stepMs).toBe(60 * MIN);
  });

  it.each(pairs)(
    '%s × %s: the grid step divides the 1440-minute UTC day (IN2/#1121)',
    (range, requested) => {
      const { grid } = resolveHistoryInterval(range, requested);
      if (grid) expect(DAY % grid.stepMs).toBe(0);
    },
  );

  it.each(pairs)(
    '%s × %s: the worst-case bucket count stays inside the budget band',
    (range, requested) => {
      const { grid } = resolveHistoryInterval(range, requested);
      if (!grid) return; // the daily grid is bounded by the daily path's own budget
      const spanDays = SPAN_DAYS[range]!;
      const worstCase = (spanDays * DAY) / grid.stepMs;
      // ≤ 350: the documented TARGET_POINTS band ceiling (the 1M grid's 31-day
      // worst case is 310 by design; every other grid sits under TARGET_POINTS).
      expect(worstCase).toBeLessThanOrEqual(350);
      if (grid.stepMs !== 144 * MIN) expect(worstCase).toBeLessThanOrEqual(TARGET_POINTS);
    },
  );

  it.each(pairs)(
    '%s × %s: candles are fetched at least as fine as the grid',
    (range, requested) => {
      const { grid } = resolveHistoryInterval(range, requested);
      if (!grid) return;
      const spacing = FETCH_SPACING_MS[grid.fetchInterval];
      expect(spacing).toBeDefined(); // sub-daily grids only ever fetch 1m/15m/30m
      expect(spacing!).toBeLessThanOrEqual(grid.stepMs);
      // The candle window is the range's own §5.3 window (1M spans the month).
      expect(grid.fetchRange).toBe(range);
    },
  );

  it('never resolves finer than requested — coarsening only', () => {
    const stepMinutes: Record<Exclude<PortfolioHistoryInterval, 'auto'>, number> = {
      '1m': 1,
      '5m': 5,
      '15m': 15,
      '30m': 30,
      '1h': 60,
      '1d': 1440,
    };
    const resolvedMinutes: Record<PortfolioHistoryResolvedInterval, number> = {
      '5m': 5,
      '15m': 15,
      '30m': 30,
      '1h': 60,
      '144m': 144,
      '1d': 1440,
    };
    for (const range of PORTFOLIO_HISTORY_RANGES) {
      for (const requested of PORTFOLIO_HISTORY_INTERVALS) {
        if (requested === 'auto') continue;
        const resolved = resolveHistoryInterval(range, requested);
        expect(resolvedMinutes[resolved.interval]).toBeGreaterThanOrEqual(stepMinutes[requested]);
      }
    }
  });
});

describe('query schema — interval parsing (IN3)', () => {
  it('defaults to auto and accepts every enum value', () => {
    expect(portfolioHistoryQuerySchema.parse({ range: '1D' }).interval).toBe('auto');
    for (const interval of PORTFOLIO_HISTORY_INTERVALS) {
      expect(portfolioHistoryQuerySchema.parse({ range: '1D', interval }).interval).toBe(interval);
    }
  });

  it('stays strict: unknown params and unknown interval values reject', () => {
    expect(portfolioHistoryQuerySchema.safeParse({ range: '1D', interval: '7m' }).success).toBe(
      false,
    );
    expect(portfolioHistoryQuerySchema.safeParse({ range: '1D', granularity: '5m' }).success).toBe(
      false,
    );
  });
});

describe('buildIntradayEurValuePoints — explicit grid step (IN3)', () => {
  it('quantizes onto the supplied 5-minute grid; omitted stepMs keeps the 15-minute 1D fallback', () => {
    const base = {
      range: '1D' as const,
      cutoffDay: T,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([[T, 100]]),
      perAssetEurByDay: new Map([['a', new Map([[T, 100]])]]),
      candlesByAsset: new Map([['a', [{ atMs: Date.parse(`${T}T10:07:00.000Z`), price: 100 }]]]),
    };
    // 10:07 floors to 10:05 on the 5-minute grid …
    expect(buildIntradayEurValuePoints({ ...base, stepMs: 5 * MIN }).map((p) => p.timeMs)).toEqual([
      Date.parse(`${T}T10:05:00.000Z`),
    ]);
    // … and to 10:00 on the legacy 15-minute fallback (the pre-IN3 behaviour,
    // still served for explicit `interval=15m` requests).
    expect(buildIntradayEurValuePoints(base).map((p) => p.timeMs)).toEqual([
      Date.parse(`${T}T10:00:00.000Z`),
    ]);
  });

  it('a 13-hour trading day of 1-minute candles yields exactly 156 five-minute buckets within budget', () => {
    // 08:00 … 20:59 — the "~156 points over a trading day" the owner asked for.
    const candles = candlesForDay(T, 13 * 60, 1 * MIN, (i) => 100 + i * 0.01);
    const points = buildIntradayEurValuePoints({
      range: '1D',
      stepMs: 5 * MIN,
      cutoffDay: T,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([[T, 1000]]),
      perAssetEurByDay: new Map([['a', new Map([[T, 1000]])]]),
      candlesByAsset: new Map([['a', candles]]),
    });
    expect(points).toHaveLength((13 * 60) / 5); // 156, pinned
    expect(points.length).toBeLessThanOrEqual(TARGET_POINTS);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!.timeMs - points[i - 1]!.timeMs).toBe(5 * MIN);
    }
  });

  it('keeps the closing seam exact on the 5-minute grid and agrees with the 15-minute grid on shared marks', () => {
    // Hourly candles are aligned to BOTH grids, so refining the step must not
    // move a single value: same buckets, same numbers, same exact seam.
    const candles = candlesForDay(T, 9, 60 * MIN, (i) => 100 + i); // 08:00 … 16:00, refClose 108
    const build = (stepMs?: number) =>
      buildIntradayEurValuePoints({
        range: '1D',
        ...(stepMs !== undefined ? { stepMs } : {}),
        cutoffDay: Y,
        asOfDay: T,
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

    const fine = build(5 * MIN);
    expect(fine).toEqual(build()); // grid refinement is value-preserving here
    // Closing-seam equivalence: the last bucket IS the fresh daily value.
    expect(fine[fine.length - 1]!.valueEur).toBeCloseTo(1080, 9);
    // Prior-close anchor: yesterday keeps its single daily point.
    expect(fine[0]).toEqual({ date: Y, timeMs: Date.parse(`${Y}T23:59:59.999Z`), valueEur: 1000 });
  });

  it('steps a 14:00 trade with a 13:55 leading edge on the 5-minute grid, seam still exact (#1120 on IN3)', () => {
    // The I1 story on the finer grid: 1100 cash all morning, buy 10 @ 110 at
    // 14:00 paid from cash, close 115 ⇒ V_a(T) = 1150. The leading-edge mark
    // travels with the step (bucket − stepMs = 13:55, not 13:45).
    const prices = [107, 108, 109, 108, 110, 109, 110, 112, 113, 114, 114, 115, 115];
    const candles = candlesForDay(T, 13, 60 * MIN, (i) => prices[i]!); // 08:00 … 20:00, 14:00 = 110
    const at = (hm: string): number => Date.parse(`${T}T${hm}:00.000Z`);
    const points = buildIntradayEurValuePoints({
      range: '1D',
      stepMs: 5 * MIN,
      cutoffDay: T,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([[T, 1150]]),
      perAssetEurByDay: new Map([['a', new Map([[T, 1150]])]]),
      candlesByAsset: new Map([['a', candles]]),
      unitsByAsset: new Map([
        ['a', { initialUnits: 0, steps: [{ atMs: at('14:00'), units: 10 }] }],
      ]),
      cashEvents: [{ atMs: at('14:00'), amountEur: -1100 }],
    });

    // 13 candle buckets + the trade's 5-minute leading edge at 13:55.
    expect(points.map((p) => p.timeMs)).toContain(at('13:55'));
    expect(points.map((p) => p.timeMs)).not.toContain(at('13:45'));
    // Pre-trade flat at the untouched cash; the buy lands at its own bucket.
    for (const p of points.filter((p) => p.timeMs < at('14:00'))) {
      expect(p.valueEur).toBeCloseTo(1100, 9);
    }
    expect(points.find((p) => p.timeMs === at('14:00'))!.valueEur).toBeCloseTo(1100, 9);
    // Closing seam exact on the fine grid too.
    expect(points[points.length - 1]!.valueEur).toBeCloseTo(1150, 9);
  });

  it('anchors pre-open and candle-less buckets to the prior close on the 5-minute grid (#1120/I2+I3)', () => {
    // EU leg flat 2000 all day; US leg (V(Y)=1000, V(T)=1100, refClose 110)
    // opens 14:30 with first candle 108; candle-less leg c gains at its close.
    const eu = candlesForDay(T, 9, 60 * MIN, () => 200); // 08:00 … 16:00
    const us = Array.from({ length: 12 }, (_, i) => ({
      atMs: Date.parse(`${T}T14:30:00.000Z`) + i * 30 * MIN,
      price: [108, 108.5, 109, 109, 109.5, 109.5, 110, 110, 110, 110, 110, 110][i]!,
    }));
    const points = buildIntradayEurValuePoints({
      range: '1D',
      stepMs: 5 * MIN,
      cutoffDay: Y,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([
        [Y, 3500],
        [T, 3650],
      ]),
      perAssetEurByDay: new Map([
        [
          'e',
          new Map([
            [Y, 2000],
            [T, 2000],
          ]),
        ],
        [
          'u',
          new Map([
            [Y, 1000],
            [T, 1100],
          ]),
        ],
        [
          'c',
          new Map([
            [Y, 500],
            [T, 550],
          ]),
        ],
      ]),
      candlesByAsset: new Map([
        ['e', eu],
        ['u', us],
      ]),
    });

    const usOpen = Date.parse(`${T}T14:30:00.000Z`);
    // Every pre-open bucket: EU flat + US at PRIOR close + c at PRIOR close.
    const preOpen = points.filter((p) => p.date === T && p.timeMs < usOpen);
    expect(preOpen.length).toBeGreaterThan(0);
    for (const p of preOpen) expect(p.valueEur).toBeCloseTo(2000 + 1000 + 500, 9);
    // The overnight gap lands AT the US open bucket, c still at prior close.
    expect(points.find((p) => p.timeMs === usOpen)!.valueEur).toBeCloseTo(
      2000 + (1100 * 108) / 110 + 500,
      9,
    );
    // The candle-less leg's day move lands at the closing seam, which is exact.
    expect(points[points.length - 1]!.valueEur).toBeCloseTo(3650, 9);
  });
});
