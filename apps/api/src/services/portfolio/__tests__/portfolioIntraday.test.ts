import { describe, expect, it } from 'vitest';

import { QTY_EPSILON, type FlowPoint, type ValuePoint } from '../../../domain/holdings';
import {
  anchorlessAssetDays,
  assetDayKey,
  buildIntradayEurValuePoints,
  downsampledIndices,
  intradayFetchRange,
  intradayIntervalFor,
  intradayPerformancePoints,
  intradayStepMs,
  INTRADAY_PORTFOLIO_RANGES,
  isDownsampledRange,
  isIntradayRange,
  TARGET_POINTS,
  unitsTimelineFromTrades,
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
const DAY = 24 * 60 * MIN;

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

interface LegacyAssetFixture {
  dailyValue: number;
  candles: readonly IntradayCandle[];
}

function legacyPriceForBucket(
  candles: readonly IntradayCandle[],
  bucket: number,
  stepMs: number,
): number {
  const cutoff = bucket + stepMs;
  let chosen: number | undefined;
  for (const candle of candles) {
    if (candle.atMs < cutoff) chosen = candle.price;
    else break;
  }
  return chosen ?? candles[0]!.price;
}

function legacyDayPoints(
  day: string,
  stepMs: number,
  cash: number,
  flatAssetValue: number,
  assets: readonly LegacyAssetFixture[],
): IntradayValuePoint[] {
  const buckets = [
    ...new Set(
      assets.flatMap((asset) =>
        asset.candles.map((candle) => Math.floor(candle.atMs / stepMs) * stepMs),
      ),
    ),
  ].sort((a, b) => a - b);

  return buckets.map((bucket) => {
    let valueEur = cash;
    for (const asset of assets) {
      const refClose = asset.candles[asset.candles.length - 1]!.price;
      const price = legacyPriceForBucket(asset.candles, bucket, stepMs);
      valueEur += refClose === 0 ? asset.dailyValue : (asset.dailyValue * price) / refClose;
    }
    valueEur += flatAssetValue;
    return { date: day, timeMs: bucket, valueEur };
  });
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
    expect(intradayStepMs('1M')).toBe(144 * MIN);
    expect((31 * DAY) / intradayStepMs('1M')).toBeLessThan(350);
    // Coarser than the hourly 1W grid and the 30-minute fetch, finer than a day.
    expect(intradayStepMs('1M')).toBeGreaterThan(intradayStepMs('1W'));
    expect(intradayStepMs('1M')).toBeGreaterThan(30 * MIN);
    expect(intradayStepMs('1M')).toBeLessThan(24 * 60 * MIN);
  });

  it.each(INTRADAY_PORTFOLIO_RANGES)('uses a UTC-day-aligned grid step for %s', (range) => {
    // Unix epoch starts at UTC midnight. A divisor of 1440 minutes therefore
    // keeps every floored bucket inside the candle's calendar day.
    expect(DAY % intradayStepMs(range)).toBe(0);
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
  it('files a 00:10Z 1M candle under its own UTC day with grid coverage', () => {
    const earlyToday = Date.parse(`${T}T00:10:00.000Z`);
    const points = buildIntradayEurValuePoints({
      range: '1M',
      cutoffDay: Y,
      asOfDay: T,
      nowMs: Date.parse(`${T}T01:00:00.000Z`),
      dailyValueEurByDay: new Map([
        [Y, 90],
        [T, 100],
      ]),
      perAssetEurByDay: new Map([
        [
          'a',
          new Map([
            [Y, 90],
            [T, 100],
          ]),
        ],
      ]),
      candlesByAsset: new Map([['a', [{ atMs: earlyToday, price: 100 }]]]),
    });

    // The prior day supplies only its daily close; the 00:10 candle creates a
    // real grid point on T at midnight. The old 149-minute step put it on Y.
    expect(points).toEqual([
      { date: Y, timeMs: Date.parse(`${Y}T23:59:59.999Z`), valueEur: 90 },
      { date: T, timeMs: Date.parse(`${T}T00:00:00.000Z`), valueEur: 100 },
    ]);
  });

  it('uses yesterday close plus today buckets for 1D and re-bases at that close', () => {
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: Y,
      asOfDay: T,
      nowMs: Date.parse(`${T}T17:00:00.000Z`),
      dailyValueEurByDay: new Map([
        [Y, 100],
        [T, 108],
      ]),
      perAssetEurByDay: new Map([
        [
          'a',
          new Map([
            [Y, 100],
            [T, 108],
          ]),
        ],
      ]),
      candlesByAsset: new Map([
        [
          'a',
          [
            { atMs: Date.parse(`${Y}T10:00:00.000Z`), price: 95 },
            { atMs: Date.parse(`${T}T09:00:00.000Z`), price: 100 },
            { atMs: Date.parse(`${T}T15:00:00.000Z`), price: 108 },
          ],
        ],
      ]),
    });

    expect(points).toEqual([
      { date: Y, timeMs: Date.parse(`${Y}T23:59:59.999Z`), valueEur: 100 },
      { date: T, timeMs: Date.parse(`${T}T09:00:00.000Z`), valueEur: 100 },
      { date: T, timeMs: Date.parse(`${T}T15:00:00.000Z`), valueEur: 108 },
    ]);

    const performance = intradayPerformancePoints({
      intradayPoints: points,
      dailyBasePoints: [
        { date: Y, valueEur: 100 },
        { date: T, valueEur: 108 },
      ],
      flowsBase: [],
    });
    expect(performance.map((point) => Number(point.pct.toFixed(6)))).toEqual([0, 0, 8]);
    // The final 1D percentage is the daily day-change, not a two-day rebase.
    expect(performance.at(-1)!.pct).toBeCloseTo(8, 9);
  });

  it('renders a dense (≥20) 1D curve whose last point equals the fresh daily value', () => {
    // One EUR asset worth 1080 today (scale 10 = units·fx, native refClose 108).
    const candles = candlesForDay(T, 26, 15 * MIN, (i) => 100 + i * 0.32); // 100 → 108
    const points = buildIntradayEurValuePoints({
      range: '1D',
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
      asOfDay: T,
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
      asOfDay: T,
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
      asOfDay: T,
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

  it.each(['1D', '1W', '1M'] as const)(
    'matches the legacy scan for cash, missing assets, finite filtering, ordering, and the %s close',
    (range) => {
      const stepMs = intradayStepMs(range);
      const dayStart = Date.parse(`${T}T00:00:00.000Z`);
      const firstBucket = Math.ceil((dayStart + 6 * 60 * MIN) / stepMs) * stepMs;
      const rawA: IntradayCandle[] = [
        { atMs: firstBucket + 3.25 * stepMs, price: 130 },
        { atMs: Number.NaN, price: 999 },
        { atMs: firstBucket + 0.25 * stepMs, price: 100 },
        { atMs: firstBucket + 2.25 * stepMs, price: 120 },
        { atMs: firstBucket + 1.25 * stepMs, price: 110 },
        { atMs: firstBucket + 2.5 * stepMs, price: Number.POSITIVE_INFINITY },
      ];
      const rawB: IntradayCandle[] = [
        { atMs: firstBucket + 3.5 * stepMs, price: 220 },
        { atMs: firstBucket + 1.5 * stepMs, price: 200 },
        { atMs: firstBucket + 2.5 * stepMs, price: 210 },
      ];
      const clean = (candles: readonly IntradayCandle[]) =>
        candles
          .filter(
            (candle) =>
              Number.isFinite(candle.atMs) &&
              Number.isFinite(candle.price) &&
              candle.atMs >= dayStart &&
              candle.atMs <= NOW_MS,
          )
          .sort((a, b) => a.atMs - b.atMs);
      const assets = [
        { dailyValue: 1200, candles: clean(rawA) },
        { dailyValue: 700, candles: clean(rawB) },
      ];
      const cash = 200;
      const flatAssetValue = 300;
      const dailyValue = cash + flatAssetValue + assets.reduce((sum, a) => sum + a.dailyValue, 0);

      const points = buildIntradayEurValuePoints({
        range,
        cutoffDay: T,
        asOfDay: T,
        nowMs: NOW_MS,
        dailyValueEurByDay: new Map([[T, dailyValue]]),
        perAssetEurByDay: new Map([
          ['a', new Map([[T, assets[0]!.dailyValue]])],
          ['b', new Map([[T, assets[1]!.dailyValue]])],
          ['missing', new Map([[T, flatAssetValue]])],
        ]),
        candlesByAsset: new Map([
          ['a', rawA],
          ['b', rawB],
        ]),
      });

      expect(points).toEqual(legacyDayPoints(T, stepMs, cash, flatAssetValue, assets));
      expect(points[points.length - 1]!.valueEur).toBe(dailyValue);
      for (let index = 1; index < points.length; index += 1) {
        expect(points[index]!.timeMs).toBeGreaterThan(points[index - 1]!.timeMs);
      }
    },
  );

  it('matches the legacy scan for a dense multi-asset 1D portfolio', () => {
    const stepMs = intradayStepMs('1D');
    const firstBucket = Date.parse(`${T}T09:00:00.000Z`);
    const bucketCount = 32;
    const assetCount = 24;
    const assets: LegacyAssetFixture[] = [];
    const perAssetEurByDay = new Map<string, ReadonlyMap<string, number>>();
    const candlesByAsset = new Map<string, readonly IntradayCandle[]>();

    for (let assetIndex = 0; assetIndex < assetCount; assetIndex += 1) {
      const openBucket = assetIndex % 5;
      const candles = Array.from({ length: bucketCount - openBucket }, (_, candleIndex) => ({
        atMs: firstBucket + (openBucket + candleIndex) * stepMs + (assetIndex % 3) * MIN,
        price: 100 + assetIndex + candleIndex,
      }));
      const dailyValue = 1000 + assetIndex * 10;
      const assetId = `asset-${assetIndex}`;
      assets.push({ dailyValue, candles });
      perAssetEurByDay.set(assetId, new Map([[T, dailyValue]]));
      candlesByAsset.set(assetId, candles);
    }

    const cash = 250;
    const flatAssetValue = 500;
    perAssetEurByDay.set('manual', new Map([[T, flatAssetValue]]));
    const dailyValue =
      cash + flatAssetValue + assets.reduce((sum, asset) => sum + asset.dailyValue, 0);

    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: T,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([[T, dailyValue]]),
      perAssetEurByDay,
      candlesByAsset,
    });

    expect(points).toEqual(legacyDayPoints(T, stepMs, cash, flatAssetValue, assets));
    expect(points).toHaveLength(bucketCount);
    expect(points.length).toBeGreaterThanOrEqual(20);
    expect(points[points.length - 1]!.valueEur).toBe(dailyValue);
  });
});

describe('buildIntradayEurValuePoints — #1120 prior-close anchoring + same-day steps', () => {
  const at = (day: string, hm: string): number => Date.parse(`${day}T${hm}:00.000Z`);

  it('I1: a 14:00 buy applies at its bucket — pre-trade value before 14:00, the true +€50 move, no phantom dip', () => {
    // Fresh position: 1100 cash all morning, buy 10 @ 110 at 14:00 (paid from
    // cash), close 115 ⇒ V_a(T) = 1150, EOD cash 0. The pre-#1120 curve
    // retro-applied the EOD units+cash from 09:00: 0 cash + 1150·108/115 =
    // 1080 at the open — a −2 % dip that never happened.
    const prices = [108, 109, 108, 110, 109, 110, 112, 113, 114, 114, 115, 115];
    const candles = candlesForDay(T, 12, 60 * MIN, (i) => prices[i]!); // 09:00 … 20:00
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: T,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([[T, 1150]]),
      perAssetEurByDay: new Map([['a', new Map([[T, 1150]])]]),
      candlesByAsset: new Map([['a', candles]]),
      unitsByAsset: new Map([
        ['a', { initialUnits: 0, steps: [{ atMs: at(T, '14:00'), units: 10 }] }],
      ]),
      cashEvents: [{ atMs: at(T, '14:00'), amountEur: -1100 }],
    });

    // 12 candle buckets + the trade's leading-edge mark at 13:45, so the buy
    // reads as ONE grid step rather than a ramp off the previous candle.
    expect(points.length).toBe(13);
    expect(points.some((p) => p.timeMs === at(T, '13:45'))).toBe(true);
    // Before the trade the portfolio is its 1100 cash — flat, pinned exactly.
    for (const p of points.filter((p) => p.timeMs < at(T, '14:00'))) {
      expect(p.valueEur).toBeCloseTo(1100, 9);
    }
    // The trade bucket is continuous: cash −1100, position +10·110·(V/close
    // scale) = 1150·110/115 = 1100 — no jump for an internal conversion.
    const tradeBucket = points.find((p) => p.timeMs === at(T, '14:00'))!;
    expect(tradeBucket.valueEur).toBeCloseTo(1100, 9);
    // No phantom dip anywhere: the curve never drops below the pre-trade cash.
    for (const p of points) expect(p.valueEur).toBeGreaterThanOrEqual(1100 - 1e-9);
    // Close stitches to the daily value exactly: the true move is +€50.
    const last = points[points.length - 1]!;
    expect(last.valueEur).toBeCloseTo(1150, 9);
    expect(last.valueEur - points[0]!.valueEur).toBeCloseTo(50, 9);
  });

  it('keeps 1D to one intraday calendar day when the prior-close anchor has an event', () => {
    // #1121 keeps yesterday as a single close anchor. Main's event-created grid
    // marks must obey that same boundary, otherwise a prior-day cash event
    // silently restores a two-calendar-day 1D curve.
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: Y,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([
        [Y, 1000],
        [T, 1000],
      ]),
      perAssetEurByDay: new Map(),
      candlesByAsset: new Map([['grid', [{ atMs: at(T, '09:00'), price: 100 }]]]),
      cashEvents: [{ atMs: at(Y, '14:00'), amountEur: 100 }],
    });

    const priorDayPoints = points.filter((point) => point.date === Y);
    expect(priorDayPoints).toEqual([
      { date: Y, timeMs: Date.parse(`${Y}T23:59:59.999Z`), valueEur: 1000 },
    ]);
    expect(points.map((point) => point.date)).toEqual([Y, T]);
  });

  it('I2: pre-open buckets value a US leg at its PRIOR close; the opening gap appears AT the US open bucket', () => {
    // EU asset e trades 08:00–16:00 (flat 200); US asset u opens 14:30 with an
    // overnight gap: V_u(Y) = 1000, V_u(T) = 1100 (refClose 110), first candle
    // 108. Pre-#1120 the 08:00 bucket already showed the gap (backfilled first
    // candle: 1100·108/110 = 1080).
    const euBase = at(T, '08:00');
    const eu = Array.from({ length: 9 }, (_, i) => ({ atMs: euBase + i * 60 * MIN, price: 200 }));
    const usBase = at(T, '14:30');
    const usPrices = [108, 108.5, 109, 109, 109.5, 109.5, 110, 110, 110, 110, 110, 110];
    const us = Array.from({ length: 12 }, (_, i) => ({
      atMs: usBase + i * 30 * MIN,
      price: usPrices[i]!,
    }));
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: Y,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([
        [Y, 3000],
        [T, 3100],
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
      ]),
      candlesByAsset: new Map([
        ['e', eu],
        ['u', us],
      ]),
    });

    // Before the US open every bucket carries the US leg at its prior close:
    // 2000 (EU, flat) + 1000 (US prior-day value) — pinned, NOT 3080.
    const preOpen = points.filter((p) => p.date === T && p.timeMs < at(T, '14:30'));
    expect(preOpen.length).toBeGreaterThan(0);
    for (const p of preOpen) expect(p.valueEur).toBeCloseTo(3000, 9);
    // The overnight gap materialises AT the US open bucket: 2000 + 1100·108/110.
    const openBucket = points.find((p) => p.timeMs === at(T, '14:30'))!;
    expect(openBucket.valueEur).toBeCloseTo(2000 + (1100 * 108) / 110, 9);
    // Closing seam unchanged: the day's last bucket equals the daily value.
    const last = points[points.length - 1]!;
    expect(last.valueEur).toBeCloseTo(3100, 9);
    // Yesterday keeps its single daily point.
    expect(points[0]!.date).toBe(Y);
    expect(points[0]!.valueEur).toBeCloseTo(3000, 9);
  });

  it('I3: a candle-less asset flat-lines at its prior-close value; its day move lands at the closing seam', () => {
    // Market asset m provides the grid (flat 100); candle-less asset c closed
    // +10 % today (500 → 550). Pre-#1120 every bucket showed the post-gain 550.
    const candles = candlesForDay(T, 9, 60 * MIN, () => 100); // 09:00 … 17:00, refClose 100
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: Y,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([
        [Y, 1500],
        [T, 1550],
      ]),
      perAssetEurByDay: new Map([
        [
          'm',
          new Map([
            [Y, 1000],
            [T, 1000],
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
      candlesByAsset: new Map([['m', candles]]),
    });

    const todayPoints = points.filter((p) => p.date === T);
    expect(todayPoints.length).toBe(9);
    // Every bucket before the seam: m at 1000 + c at its PRIOR close 500.
    for (const p of todayPoints.slice(0, -1)) expect(p.valueEur).toBeCloseTo(1500, 9);
    // The +10 % lands at the closing seam, which equals the daily value exactly.
    expect(todayPoints[todayPoints.length - 1]!.valueEur).toBeCloseTo(1550, 9);
  });

  it('steps the derived cash at a movement’s bucket, keeping the closing seam exact', () => {
    const candles = candlesForDay(T, 9, 60 * MIN, () => 100); // 09:00 … 17:00
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: T,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([[T, 1500]]), // 1000 asset + 500 EOD cash
      perAssetEurByDay: new Map([['a', new Map([[T, 1000]])]]),
      candlesByAsset: new Map([['a', candles]]),
      cashEvents: [{ atMs: at(T, '12:00'), amountEur: 500 }],
    });

    for (const p of points) {
      if (p.timeMs < at(T, '12:00')) expect(p.valueEur).toBeCloseTo(1000, 9);
      else expect(p.valueEur).toBeCloseTo(1500, 9);
    }
    expect(points[points.length - 1]!.valueEur).toBeCloseTo(1500, 9);
  });

  it('steps a SPARSE-candle day at the trade bucket instead of ramping to the next candle', () => {
    // Same story as I1, but the provider only served 09:00 / 13:00 / 20:00.
    // Candle marks alone give the 14:00 buy no bucket, so the state change
    // would smear across the 13:00 → 20:00 gap; the event's own marks fix it.
    const candles: IntradayCandle[] = [
      { atMs: at(T, '09:00'), price: 108 },
      { atMs: at(T, '13:00'), price: 110 },
      { atMs: at(T, '20:00'), price: 115 },
    ];
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: T,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([[T, 1150]]), // 10 units · 115 close, EOD cash 0
      perAssetEurByDay: new Map([['a', new Map([[T, 1150]])]]),
      candlesByAsset: new Map([['a', candles]]),
      unitsByAsset: new Map([
        ['a', { initialUnits: 0, steps: [{ atMs: at(T, '14:00'), units: 10 }] }],
      ]),
      cashEvents: [{ atMs: at(T, '14:00'), amountEur: -1100 }],
    });

    // The grid is the three candle marks plus the trade's own step (13:45/14:00).
    expect(points.map((p) => p.timeMs)).toEqual([
      at(T, '09:00'),
      at(T, '13:00'),
      at(T, '13:45'),
      at(T, '14:00'),
      at(T, '20:00'),
    ]);
    // Every pre-trade mark — including the 13:00 candle that used to carry the
    // ramp — is exactly the untouched 1100 cash.
    for (const p of points.filter((p) => p.timeMs < at(T, '14:00'))) {
      expect(p.valueEur).toBeCloseTo(1100, 9);
    }
    // The buy lands at its own bucket, priced at the last print (110): 1150·110/115.
    expect(points.find((p) => p.timeMs === at(T, '14:00'))!.valueEur).toBeCloseTo(1100, 9);
    // Closing seam still exact.
    expect(points[points.length - 1]!.valueEur).toBeCloseTo(1150, 9);
  });

  it('extends the grid past the day’s last candle for an after-hours cash movement', () => {
    // Candles stop at 17:00; €500 lands at 19:30. Anchoring the seam to 17:00
    // retro-applied that deposit two and a half hours before it happened.
    const candles = candlesForDay(T, 9, 60 * MIN, () => 100); // 09:00 … 17:00
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: T,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([[T, 1500]]), // 1000 asset + 500 EOD cash
      perAssetEurByDay: new Map([['a', new Map([[T, 1000]])]]),
      candlesByAsset: new Map([['a', candles]]),
      cashEvents: [{ atMs: at(T, '19:30'), amountEur: 500 }],
    });

    const last = points[points.length - 1]!;
    expect(last.timeMs).toBe(at(T, '19:30')); // the seam moved to the movement
    expect(last.valueEur).toBeCloseTo(1500, 9); // and is still exactly the daily value
    // Everything before it — the old seam at 17:00 included — is pre-deposit.
    for (const p of points.slice(0, -1)) expect(p.valueEur).toBeCloseTo(1000, 9);
    expect(points.find((p) => p.timeMs === at(T, '17:00'))!.valueEur).toBeCloseTo(1000, 9);
    expect(points.some((p) => p.timeMs === at(T, '19:15'))).toBe(true);
  });

  it('extends the grid past the day’s last candle for an after-hours units step', () => {
    // 10 units held; the day runs 100 → 110 on candles ending at 17:00; 5 more
    // units transfer in at 18:00 (no cash leg). EOD: 15 units · 110 = 1650.
    const candles = candlesForDay(T, 9, 60 * MIN, (i) => 100 + (i * 10) / 8); // 09:00 … 17:00
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: Y,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([
        [Y, 1000],
        [T, 1650],
      ]),
      perAssetEurByDay: new Map([
        [
          'a',
          new Map([
            [Y, 1000],
            [T, 1650],
          ]),
        ],
      ]),
      candlesByAsset: new Map([['a', candles]]),
      unitsByAsset: new Map([
        ['a', { initialUnits: 10, steps: [{ atMs: at(T, '18:00'), units: 15 }] }],
      ]),
    });

    // Open: the 10 held units at yesterday's close — 1650·(100/110)·(10/15).
    expect(points.find((p) => p.timeMs === at(T, '09:00'))!.valueEur).toBeCloseTo(1000, 9);
    // The old seam now carries the day's real gain on the 10 held units only
    // (1650·10/15 = 1100), not the not-yet-arrived 5 units.
    expect(points.find((p) => p.timeMs === at(T, '17:00'))!.valueEur).toBeCloseTo(1100, 9);
    expect(points.find((p) => p.timeMs === at(T, '17:45'))!.valueEur).toBeCloseTo(1100, 9);
    // The transfer lands at its own bucket, which is the new exact seam.
    const last = points[points.length - 1]!;
    expect(last.timeMs).toBe(at(T, '18:00'));
    expect(last.valueEur).toBeCloseTo(1650, 9);
  });

  it('steps a CANDLE-LESS day at its event buckets while its daily point stays the exact close', () => {
    // 10 units @100 + 100 cash yesterday; +1 unit for 100 cash at 11:00 today;
    // today closes at 110 ⇒ 11 · 110 = 1210. No candles anywhere (manual asset,
    // or a day the provider missed entirely).
    const inputs = {
      range: '1D' as const,
      cutoffDay: Y,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([
        [Y, 1100],
        [T, 1210],
      ]),
      perAssetEurByDay: new Map([
        [
          'a',
          new Map([
            [Y, 1000],
            [T, 1210],
          ]),
        ],
      ]),
      candlesByAsset: new Map<string, readonly IntradayCandle[]>(),
    };
    const points = buildIntradayEurValuePoints({
      ...inputs,
      unitsByAsset: new Map([
        ['a', { initialUnits: 10, steps: [{ atMs: at(T, '11:00'), units: 11 }] }],
      ]),
      cashEvents: [{ atMs: at(T, '11:00'), amountEur: -100 }],
    });

    expect(points.map((p) => [p.timeMs, Number(p.valueEur.toFixed(6))])).toEqual([
      [Date.parse(`${Y}T23:59:59.999Z`), 1100], // yesterday's daily point
      [at(T, '10:45'), 1100], // pre-trade: prior close + the 100 cash
      [at(T, '11:00'), 1100], // post-trade: 11 units at the prior per-unit value
      [NOW_MS, 1210], // the day's own move lands at its close (I3), exactly
    ]);
    // Without step inputs the same window is still the bare daily slice.
    expect(buildIntradayEurValuePoints(inputs).map((p) => [p.date, p.valueEur])).toEqual([
      [Y, 1100],
      [T, 1210],
    ]);
  });

  it('leaves a same-day ROUND TRIP un-stepped: no dip, no marks, the day stays flat', () => {
    // 1000 cash yesterday; today buys 10 @110 (paid from cash) at 10:00 and
    // sells all 10 @112 at 15:00 ⇒ V_a(T) = 0, EOD cash 1020. The position has
    // no EUR anchor on either side (no units at the close, none the day
    // before), so it can never be priced at a bucket — stepping its cash legs
    // alone would show the 1100 leave with nothing bought for it (the #1120
    // review's −1100 plunge-and-recover). The day is left day-anchored.
    const candles = candlesForDay(T, 9, 60 * MIN, () => 112); // 09:00 … 17:00
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: Y,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([
        [Y, 1000],
        [T, 1020],
      ]),
      perAssetEurByDay: new Map([['a', new Map([[T, 0]])]]),
      candlesByAsset: new Map([['a', candles]]),
      unitsByAsset: new Map([
        [
          'a',
          {
            initialUnits: 0,
            steps: [
              { atMs: at(T, '10:00'), units: 10 },
              { atMs: at(T, '15:00'), units: 0 },
            ],
          },
        ],
      ]),
      cashEvents: [
        { atMs: at(T, '10:00'), amountEur: -1100, assetId: 'a' },
        { atMs: at(T, '15:00'), amountEur: 1120, assetId: 'a' },
      ],
    });

    const todayPoints = points.filter((p) => p.date === T);
    // Only the 9 candle marks: a suppressed event contributes no grid mark, so
    // the 09:45 / 14:45 leading edges of the two trades are absent.
    expect(todayPoints.map((p) => p.timeMs)).toEqual(
      candles.map((c) => Math.floor(c.atMs / (15 * MIN)) * (15 * MIN)),
    );
    // Flat at the day's EOD figure end to end — the round trip's +€20 shows as
    // the day's step, exactly as it did before #1120. Nothing dips.
    for (const p of todayPoints) expect(p.valueEur).toBeCloseTo(1020, 9);
    expect(points[0]!.valueEur).toBeCloseTo(1000, 9); // yesterday's daily point
    expect(Math.min(...points.map((p) => p.valueEur))).toBeCloseTo(1000, 9);
  });

  it('still steps a PARTIAL same-day exit — the anchored case keeps its buckets', () => {
    // 2000 cash yesterday; buy 10 @110 at 10:00 (cash 900), sell 6 @112 at
    // 15:00 (cash 1572), 4 units left at the 112 close ⇒ V_a(T) = 448. Units
    // survive to the close, so the day HAS an anchor and must keep stepping —
    // the round-trip suppression must not spill onto it.
    const candles = candlesForDay(T, 9, 60 * MIN, () => 112); // 09:00 … 17:00
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: Y,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([
        [Y, 2000],
        [T, 2020],
      ]),
      perAssetEurByDay: new Map([['a', new Map([[T, 448]])]]),
      candlesByAsset: new Map([['a', candles]]),
      unitsByAsset: new Map([
        [
          'a',
          {
            initialUnits: 0,
            steps: [
              { atMs: at(T, '10:00'), units: 10 },
              { atMs: at(T, '15:00'), units: 4 },
            ],
          },
        ],
      ]),
      cashEvents: [
        { atMs: at(T, '10:00'), amountEur: -1100, assetId: 'a' },
        { atMs: at(T, '15:00'), amountEur: 672, assetId: 'a' },
      ],
    });

    const todayPoints = points.filter((p) => p.date === T);
    // 9 candle marks + both trades' leading edges (09:45, 14:45).
    expect(todayPoints.length).toBe(11);
    expect(todayPoints.some((p) => p.timeMs === at(T, '09:45'))).toBe(true);
    expect(todayPoints.some((p) => p.timeMs === at(T, '14:45'))).toBe(true);
    // Pre-trade: the untouched 2000 cash. From the buy on: 10 units at 112
    // (1120) + 900 cash, then 4 units (448) + 1572 cash — 2020 either way.
    for (const p of todayPoints) {
      expect(p.valueEur).toBeCloseTo(p.timeMs < at(T, '10:00') ? 2000 : 2020, 9);
    }
    // Closing seam exact.
    expect(points[points.length - 1]!.valueEur).toBeCloseTo(2020, 9);
  });

  it('leaves a FRACTIONAL same-day round trip un-stepped — dust cannot defeat the guard', () => {
    // Same shape as the whole-unit round trip, but the position is built from
    // two fractional lots and closed with the STORED total: 0.1 + 0.2 folds to
    // 0.30000000000000004, so selling 0.3 leaves ~5.6e-17 units unless the
    // fold clamps at QTY_EPSILON. Dust ⇒ the day looks anchored ⇒ the cash legs
    // step against a position that prices at 0 at every bucket ⇒ the −€300
    // plunge-and-recover is back (#1120 review).
    //
    // 1000 cash yesterday; buy 0.1 @1000 (−100) at 10:00, buy 0.2 @1000 (−200)
    // at 11:00, sell 0.3 @1100 (+330) at 15:00 ⇒ V_a(T) = 0, EOD cash 1030.
    const cutoffMs = Date.parse(`${T}T00:00:00.000Z`);
    const units = unitsTimelineFromTrades(
      [
        { atMs: at(T, '10:00'), unitsDelta: 0.1 },
        { atMs: at(T, '11:00'), unitsDelta: 0.2 },
        { atMs: at(T, '15:00'), unitsDelta: -0.3 },
      ],
      cutoffMs,
    )!;
    const candles = candlesForDay(T, 9, 60 * MIN, () => 1100); // 09:00 … 17:00
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: Y,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([
        [Y, 1000],
        [T, 1030],
      ]),
      perAssetEurByDay: new Map([['a', new Map([[T, 0]])]]),
      candlesByAsset: new Map([['a', candles]]),
      unitsByAsset: new Map([['a', units]]),
      cashEvents: [
        { atMs: at(T, '10:00'), amountEur: -100, assetId: 'a' },
        { atMs: at(T, '11:00'), amountEur: -200, assetId: 'a' },
        { atMs: at(T, '15:00'), amountEur: 330, assetId: 'a' },
      ],
    });

    const todayPoints = points.filter((p) => p.date === T);
    // Suppressed: only the 9 candle marks, no trade leading edges.
    expect(todayPoints.map((p) => p.timeMs)).toEqual(
      candles.map((c) => Math.floor(c.atMs / (15 * MIN)) * (15 * MIN)),
    );
    // Flat at the day's EOD figure end to end; the +€30 lands at the close.
    for (const p of todayPoints) expect(p.valueEur).toBeCloseTo(1030, 9);
    expect(Math.min(...points.map((p) => p.valueEur))).toBeCloseTo(1000, 9);
  });

  it('keeps 1M unit steps on their own UTC calendar day', () => {
    // #1121 makes the 1M grid a UTC-day divisor. A bucket can therefore never
    // straddle midnight and apply the following day's units to yesterday's
    // day-scoped value.
    const step = intradayStepMs('1M');
    const midnight = Date.parse(`${T}T00:00:00.000Z`);
    const todayBucket = Math.floor(midnight / step) * step;
    expect(DAY % step).toBe(0);
    expect(todayBucket).toBe(midnight);

    const points = buildIntradayEurValuePoints({
      range: '1M',
      cutoffDay: Y,
      asOfDay: T,
      nowMs: NOW_MS,
      // 10 units bought late on Y at €100 (1000), 10 more just after midnight.
      dailyValueEurByDay: new Map([
        [Y, 1000],
        [T, 2000],
      ]),
      perAssetEurByDay: new Map([
        [
          'a',
          new Map([
            [Y, 1000],
            [T, 2000],
          ]),
        ],
      ]),
      candlesByAsset: new Map(),
      unitsByAsset: new Map([
        [
          'a',
          {
            initialUnits: 0,
            steps: [
              { atMs: at(Y, '23:00'), units: 10 },
              { atMs: at(T, '00:30'), units: 20 },
            ],
          },
        ],
      ]),
    });

    // Yesterday's final event bucket carries YESTERDAY's 10 units at the
    // yesterday-close value. The next day's own midnight bucket sees its 20
    // units — no cross-midnight state leak is possible.
    const yesterdayBucket = todayBucket - step;
    expect(points.find((p) => p.timeMs === yesterdayBucket)!.date).toBe(Y);
    expect(points.find((p) => p.timeMs === yesterdayBucket)!.valueEur).toBeCloseTo(1000, 9);
    expect(points.find((p) => p.timeMs === todayBucket)!.date).toBe(T);
    expect(points.find((p) => p.timeMs === todayBucket)!.valueEur).toBeCloseTo(2000, 9);
    // The pre-buy bucket is still empty, and each day still closes exactly.
    expect(points.find((p) => p.timeMs === yesterdayBucket - step)!.valueEur).toBeCloseTo(0, 9);
    expect(points.filter((p) => p.date === Y).pop()!.valueEur).toBeCloseTo(1000, 9);
    expect(points[points.length - 1]!.valueEur).toBeCloseTo(2000, 9);
  });

  it('honours a caller-supplied anchorless set (the service’s, so both curves agree)', () => {
    // The service computes the set once for its flow suppression and hands it
    // in, so the value curve cannot disagree with the % curve about which
    // asset-days are stepped (#1120 review).
    const candles = candlesForDay(T, 9, 60 * MIN, () => 112); // 09:00 … 17:00
    const build = (anchorlessDays?: ReadonlySet<string>) =>
      buildIntradayEurValuePoints({
        range: '1D',
        cutoffDay: T,
        asOfDay: T,
        nowMs: NOW_MS,
        dailyValueEurByDay: new Map([[T, 2020]]),
        perAssetEurByDay: new Map([['a', new Map([[T, 448]])]]),
        candlesByAsset: new Map([['a', candles]]),
        unitsByAsset: new Map([
          ['a', { initialUnits: 0, steps: [{ atMs: at(T, '10:00'), units: 4 }] }],
        ]),
        cashEvents: [{ atMs: at(T, '10:00'), amountEur: -448, assetId: 'a' }],
        anchorlessDays,
      });

    // Anchored on its own terms: the 10:00 buy steps (leading edge at 09:45).
    expect(build().some((p) => p.timeMs === at(T, '09:45'))).toBe(true);
    // Suppressed by the caller's set: no mark, no step, flat at the EOD figure.
    const suppressed = build(new Set([assetDayKey('a', T)]));
    expect(suppressed.some((p) => p.timeMs === at(T, '09:45'))).toBe(false);
    for (const p of suppressed) expect(p.valueEur).toBeCloseTo(2020, 9);
  });

  it('leaves a cash leg for an asset outside the daily per-asset series un-stepped', () => {
    // An FX-unconvertible asset never appears on the value curve, so its linked
    // cash leg has no counterpart either — step it and the curve dips.
    const candles = candlesForDay(T, 9, 60 * MIN, () => 100); // 09:00 … 17:00
    const points = buildIntradayEurValuePoints({
      range: '1D',
      cutoffDay: T,
      asOfDay: T,
      nowMs: NOW_MS,
      dailyValueEurByDay: new Map([[T, 1500]]), // 1000 asset m + 500 EOD cash
      perAssetEurByDay: new Map([['m', new Map([[T, 1000]])]]),
      candlesByAsset: new Map([['m', candles]]),
      cashEvents: [{ atMs: at(T, '12:00'), amountEur: -400, assetId: 'ghost' }],
    });

    for (const p of points) expect(p.valueEur).toBeCloseTo(1500, 9);
  });
});

describe('anchorlessAssetDays — the asset-days that cannot be stepped (#1120 review)', () => {
  const stepsAt = (
    hm: string,
    units: number,
    initialUnits = 0,
  ): { initialUnits: number; steps: { atMs: number; units: number }[] } => ({
    initialUnits,
    steps: [{ atMs: Date.parse(`${T}T${hm}:00.000Z`), units }],
  });

  it('flags a position opened AND fully closed inside one day', () => {
    const keys = anchorlessAssetDays({
      dailyValueEurByDay: new Map([
        [Y, 1000],
        [T, 1020],
      ]),
      perAssetEurByDay: new Map([['a', new Map([[T, 0]])]]),
      unitsByAsset: new Map([
        [
          'a',
          {
            initialUnits: 0,
            steps: [
              { atMs: Date.parse(`${T}T10:00:00.000Z`), units: 10 },
              { atMs: Date.parse(`${T}T15:00:00.000Z`), units: 0 },
            ],
          },
        ],
      ]),
      // The condition is "opened and closed in one day", NOT "the series' first
      // day": T here is the window's SECOND day and is flagged all the same.
    });
    expect([...keys]).toEqual([assetDayKey('a', T)]);
  });

  it('does not flag a day whose units survive to the close (the day-close anchor)', () => {
    const keys = anchorlessAssetDays({
      dailyValueEurByDay: new Map([[T, 1150]]),
      perAssetEurByDay: new Map([['a', new Map([[T, 1150]])]]),
      unitsByAsset: new Map([['a', stepsAt('14:00', 10)]]),
    });
    expect(keys.size).toBe(0);
  });

  it('does not flag a position sold out mid-day that was held the day before (prior-day anchor)', () => {
    const keys = anchorlessAssetDays({
      dailyValueEurByDay: new Map([
        [Y, 2000],
        [T, 1020],
      ]),
      perAssetEurByDay: new Map([
        [
          'a',
          new Map([
            [Y, 1000],
            [T, 0],
          ]),
        ],
      ]),
      unitsByAsset: new Map([['a', stepsAt('15:00', 0, 10)]]),
    });
    expect(keys.size).toBe(0);
  });

  it('flags every step-day of an asset missing from the per-asset series, and nothing without steps', () => {
    expect([
      ...anchorlessAssetDays({
        dailyValueEurByDay: new Map([[T, 1000]]),
        perAssetEurByDay: new Map(),
        unitsByAsset: new Map([['ghost', stepsAt('14:00', 10)]]),
      }),
    ]).toEqual([assetDayKey('ghost', T)]);

    expect(
      anchorlessAssetDays({
        dailyValueEurByDay: new Map([[T, 1000]]),
        perAssetEurByDay: new Map([['a', new Map([[T, 1000]])]]),
      }).size,
    ).toBe(0);
  });

  it('flags a FRACTIONAL round trip whose "sell all" leaves float dust', () => {
    // The step function comes from the real fold, so this pins the guard and
    // the clamp together: dust units at the close would read as an anchor that
    // the daily series (V_a(T) = 0) does not have (#1120 review).
    const units = unitsTimelineFromTrades(
      [
        { atMs: Date.parse(`${T}T10:00:00.000Z`), unitsDelta: 0.1 },
        { atMs: Date.parse(`${T}T11:00:00.000Z`), unitsDelta: 0.2 },
        { atMs: Date.parse(`${T}T15:00:00.000Z`), unitsDelta: -0.3 },
      ],
      Date.parse(`${T}T00:00:00.000Z`),
    )!;
    const keys = anchorlessAssetDays({
      dailyValueEurByDay: new Map([
        [Y, 1000],
        [T, 1030],
      ]),
      perAssetEurByDay: new Map([['a', new Map([[T, 0]])]]),
      unitsByAsset: new Map([['a', units]]),
    });
    expect([...keys]).toEqual([assetDayKey('a', T)]);
  });

  it('ignores dust in a hand-built step function (the input is public)', () => {
    const keys = anchorlessAssetDays({
      dailyValueEurByDay: new Map([[T, 1000]]),
      perAssetEurByDay: new Map([['a', new Map([[T, 0]])]]),
      unitsByAsset: new Map([
        [
          'a',
          {
            initialUnits: 0,
            steps: [
              { atMs: Date.parse(`${T}T10:00:00.000Z`), units: 10 },
              { atMs: Date.parse(`${T}T15:00:00.000Z`), units: QTY_EPSILON / 2 },
            ],
          },
        ],
      ]),
    });
    expect([...keys]).toEqual([assetDayKey('a', T)]);
  });

  it('keys are stable `assetId|day` pairs', () => {
    expect(assetDayKey('asset-1', T)).toBe(`asset-1|${T}`);
  });
});

describe('unitsTimelineFromTrades', () => {
  const T14 = Date.parse(`${T}T14:00:00.000Z`);
  const T15 = Date.parse(`${T}T15:00:00.000Z`);
  const cutoff = Date.parse(`${T}T00:00:00.000Z`);

  it('folds pre-cutoff deltas into initialUnits and windows the rest into steps', () => {
    const timeline = unitsTimelineFromTrades(
      [
        { atMs: cutoff - 86_400_000, unitsDelta: 5 },
        { atMs: T14, unitsDelta: 5 },
        { atMs: T15, unitsDelta: -10 },
      ],
      cutoff,
    );
    expect(timeline).toEqual({
      initialUnits: 5,
      steps: [
        { atMs: T14, units: 10 },
        { atMs: T15, units: 0 },
      ],
    });
  });

  it('clamps at zero (no shorts, mirroring the uncovered-sell close-at-zero)', () => {
    const timeline = unitsTimelineFromTrades(
      [
        { atMs: T14, unitsDelta: 3 },
        { atMs: T15, unitsDelta: -10 },
      ],
      cutoff,
    )!;
    expect(timeline.steps[1]!.units).toBe(0);
  });

  it('folds away sell-everything float dust exactly like the valuation engine', () => {
    // 0.1 + 0.2 = 0.30000000000000004 held; the UI offers the STORED 0.3 for
    // "sell all", so the fold ends at 5.55e-17 unless it clamps at
    // QTY_EPSILON. `deriveHoldings` clamps, publishing V_a(D) = 0 — leaving
    // dust here would make this the one place that still calls the position
    // held, which is what defeats the anchorless guard (#1120 review).
    const T13 = Date.parse(`${T}T13:00:00.000Z`);
    const timeline = unitsTimelineFromTrades(
      [
        { atMs: T13, unitsDelta: 0.1 },
        { atMs: T14, unitsDelta: 0.2 },
        { atMs: T15, unitsDelta: -0.3 },
      ],
      cutoff,
    )!;
    expect(0.1 + 0.2 - 0.3).not.toBe(0); // the dust is real, not hypothetical
    expect(timeline.steps[2]!.units).toBe(0);
    expect(timeline.steps[2]!.units).toBeLessThan(QTY_EPSILON);
    // The clamp is a floor at zero, not a rounding of every quantity: a real
    // fractional holding survives untouched.
    expect(timeline.steps[1]!.units).toBe(0.1 + 0.2);
  });

  it('returns undefined when no in-window trade exists (constant units)', () => {
    expect(unitsTimelineFromTrades([{ atMs: cutoff - 1, unitsDelta: 5 }], cutoff)).toBeUndefined();
    expect(unitsTimelineFromTrades([], cutoff)).toBeUndefined();
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

  it('applies flow instants progressively (#1120): a 14:00 deposit on a STEPPED value curve stays flat 0 %', () => {
    // With the value curve now stepping at the deposit instant (1000 before
    // 14:00, 1500 after), day-boundary flow anchoring would fabricate a dip/
    // jump; flow instants neutralise each point against the flows actually
    // applied by then.
    const daily: ValuePoint[] = [
      { date: Y, valueEur: 1000 },
      { date: T, valueEur: 1500 },
    ];
    const flows: FlowPoint[] = [{ date: T, flowEur: 500 }];
    const stepped: IntradayValuePoint[] = [
      { date: T, timeMs: Date.parse(`${T}T10:00:00Z`), valueEur: 1000 },
      { date: T, timeMs: Date.parse(`${T}T14:00:00Z`), valueEur: 1500 },
      { date: T, timeMs: Date.parse(`${T}T18:00:00Z`), valueEur: 1500 },
    ];
    const withEvents = intradayPerformancePoints({
      intradayPoints: stepped,
      dailyBasePoints: daily,
      flowsBase: flows,
      flowEvents: [{ atMs: Date.parse(`${T}T14:00:00Z`), flowEur: 500 }],
      stepMs: 15 * MIN,
    });
    for (const p of withEvents) expect(p.pct).toBeCloseTo(0, 9);
    // The close still telescopes to the daily TWR (0 % — holdings never moved).
    expect(withEvents[withEvents.length - 1]!.pct).toBeCloseTo(0, 9);

    // Contrast: WITHOUT flow instants the same stepped values read as a
    // phantom +50 % swing after re-basing — the pre-#1120 fabrication.
    const withoutEvents = intradayPerformancePoints({
      intradayPoints: stepped,
      dailyBasePoints: daily,
      flowsBase: flows,
    });
    expect(withoutEvents[1]!.pct).toBeGreaterThan(40);
  });
});
