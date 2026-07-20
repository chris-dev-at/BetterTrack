import type { HistoryInterval, HistoryRange, PortfolioHistoryRange } from '@bettertrack/contracts';

import {
  timeWeightedReturn,
  VALUE_EPSILON,
  type FlowPoint,
  type ValuePoint,
} from '../../domain/holdings';

/**
 * Intraday portfolio value series (PROJECTPLAN §13.5 V5-P1 arc d, issue #556).
 *
 * The daily snapshot layer (issue #553) serves one close per calendar day, so a
 * 1D range collapsed to ~2 points ("yesterday close → today"). This module
 * densifies **every non-MAX range** into a sub-daily curve without a second
 * value engine: it reuses the daily series as the anchor and scales each held
 * asset by its own **intraday price ratio**. 1D/1W get a full intraday curve;
 * 1M/6M/1Y/5Y get a sub-daily grid over the recent window the provider still
 * serves at an intraday interval, degrading to the daily slice for older days
 * (2026-07-20 resolution bump).
 *
 * ## The anchoring identity
 *
 * The snapshot layer already gives, per calendar day `D`, each asset's EUR value
 * `V_a(D)` (units · close · fx) and the portfolio net worth `V(D) = Σ_a V_a(D) +
 * cash(D)`. For an intraday instant `t` on day `D`, the asset's EUR value is
 *
 *     value_a(t) = units_a(D) · price_a(t) · fx_a(D)
 *                = V_a(D) · price_a(t) / close_a(D)
 *
 * where `close_a(D)` is the asset's own day-`D` reference close — taken here as
 * the **last intraday candle on `D`** (`refClose`). Two properties fall out for
 * free and are exactly what the stitching requirement (§16, issue #556) needs:
 *
 *  1. **fx consistency** — `V_a(D)` already carries day-`D`'s historical rate,
 *     and `price/refClose` is a same-currency ratio (currency-invariant), so the
 *     intraday value inherits the daily series' currency treatment with no extra
 *     FX math (a multi-currency portfolio just works).
 *  2. **Seamless close** — at `t = refClose`, `price/refClose = 1`, so
 *     `value_a(refClose) = V_a(D)` and the portfolio point equals the daily
 *     `V(D)` **exactly**. The last intraday point therefore coincides with the
 *     always-fresh snapshot "today" point — the curve stitches with no gap and
 *     no double-count.
 *
 * An asset with **no intraday candles on `D`** (custom/manual assets always; a
 * market asset on a day the provider missed) contributes its flat `V_a(D)` — it
 * carries forward and the curve never breaks or drops it. With zero candles for
 * the whole window the output degrades precisely to the daily slice (one point
 * per in-window day), i.e. the pre-#556 behaviour.
 *
 * ## Granularity (planner-picked, §13.5 arc d; 2026-07-20 resolution bump)
 *
 * The grid step coarsens as the span grows, so every range reads as a smooth
 * curve without an unbounded point count: 1D → **15-minute**, 1W → **hourly**,
 * 1M → **hourly**, 6M → **2-hour**, 1Y/5Y → **4-hour**. Provider candles are
 * quantized onto that fixed step so every asset lands on the same grid marks
 * (aligned, never jagged) while grid points exist only where intraday data does
 * (no dead overnight/weekend flats).
 *
 * A provider only serves sub-daily candles for a recent window (§5.3: 30-minute
 * bars reach ~60 days back), so the 1M/6M/1Y/5Y ranges fetch their candles over
 * the recent **`fetchRange`** (`1M`) rather than the whole span. The recent
 * portion therefore densifies to the grid while older days keep their single
 * daily point (the built-in degrade-to-daily-slice path) — the long ranges get
 * a smoother recent curve at a bounded cost, and 1M densifies end to end. All
 * four share the one `1M@30m` §5.3 cache entry, so a burst of reads across them
 * costs at most one upstream fetch per asset.
 */

/**
 * The ranges that render a densified (sub-daily) curve rather than a plain daily
 * slice — every range except MAX (#556; 2026-07-20 resolution bump extends the
 * original 1D/1W set to 1M/6M/1Y/5Y).
 */
export const DENSIFIED_PORTFOLIO_RANGES = ['1D', '1W', '1M', '6M', '1Y', '5Y'] as const;
export type DensifiedPortfolioRange = (typeof DENSIFIED_PORTFOLIO_RANGES)[number];

export function isDensifiedRange(range: PortfolioHistoryRange): range is DensifiedPortfolioRange {
  return (DENSIFIED_PORTFOLIO_RANGES as readonly string[]).includes(range);
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Per-range candle `fetchRange` + provider `interval` + grid `stepMs`. 1D pulls
 * 15-minute candles onto a 15-minute grid; 1W pulls 30-minute candles thinned
 * onto an hourly grid (there is no native 1-hour provider interval, and
 * 30-minute bars quantized to the hour give one clean point per market hour).
 *
 * 1M/6M/1Y/5Y reuse the same 30-minute candles but fetch them over the recent
 * `1M` window (all a provider reliably serves sub-daily) and quantize onto a
 * progressively coarser grid, so the recent portion is smooth while the point
 * count stays bounded; older days fall back to the daily slice. Every interval
 * is short-TTL cached by the §5.3 keystone (1D = 60 s, 1W = 5 min, the shared
 * `1M@30m` entry = 15 min), so a burst of series reads costs at most one
 * upstream fetch per asset/interval.
 */
const RANGE_CONFIG: Record<
  DensifiedPortfolioRange,
  { fetchRange: HistoryRange; interval: HistoryInterval; stepMs: number }
> = {
  '1D': { fetchRange: '1D', interval: '15m', stepMs: 15 * MINUTE_MS },
  '1W': { fetchRange: '1W', interval: '30m', stepMs: 60 * MINUTE_MS },
  '1M': { fetchRange: '1M', interval: '30m', stepMs: 60 * MINUTE_MS },
  '6M': { fetchRange: '1M', interval: '30m', stepMs: 120 * MINUTE_MS },
  '1Y': { fetchRange: '1M', interval: '30m', stepMs: 240 * MINUTE_MS },
  '5Y': { fetchRange: '1M', interval: '30m', stepMs: 240 * MINUTE_MS },
};

export function densifiedIntervalFor(range: DensifiedPortfolioRange): HistoryInterval {
  return RANGE_CONFIG[range].interval;
}

export function densifiedStepMs(range: DensifiedPortfolioRange): number {
  return RANGE_CONFIG[range].stepMs;
}

/** The recent §5.3 range window whose sub-daily candles densify `range`. */
export function densifiedFetchRange(range: DensifiedPortfolioRange): HistoryRange {
  return RANGE_CONFIG[range].fetchRange;
}

/** One native-currency intraday price observation for an asset. */
export interface IntradayCandle {
  /** Epoch-ms of the observation. */
  atMs: number;
  /** Close in the asset's native currency. */
  price: number;
}

/** One point on the assembled intraday value curve (EUR before re-denomination). */
export interface IntradayValuePoint {
  /** The calendar day (ISO `YYYY-MM-DD`, UTC) the point falls on. */
  date: string;
  /** Exact instant (epoch-ms). */
  timeMs: number;
  /** Portfolio value in EUR at that instant. */
  valueEur: number;
}

export interface BuildIntradayEurInput {
  range: DensifiedPortfolioRange;
  /** Inclusive window start day (ISO), i.e. `rangeCutoffIso(range, today)`. */
  cutoffDay: string;
  /** Current wall-clock (epoch-ms) — bounds the "today" fallback stamp. */
  nowMs: number;
  /** Net-worth EUR per calendar day (the daily snapshot points, full series). */
  dailyValueEurByDay: ReadonlyMap<string, number>;
  /** Per-asset EUR value per calendar day (the daily snapshot per-asset series). */
  perAssetEurByDay: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Native intraday candles per asset; missing/empty ⇒ that asset carries forward. */
  candlesByAsset: ReadonlyMap<string, readonly IntradayCandle[]>;
}

/** UTC calendar day of an epoch-ms instant. */
function dayOfMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Epoch-ms of an ISO day's UTC midnight. */
function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** Quantize an instant down to the grid step (floor). */
function bucketMs(atMs: number, stepMs: number): number {
  return Math.floor(atMs / stepMs) * stepMs;
}

/**
 * The asset's price to use at grid bucket `bucket`: the last same-day candle
 * whose instant falls at or before the bucket's end (`bucket + step`), i.e. the
 * price "as of" that bucket. Before the day's first candle the first candle is
 * carried back (an asset whose session opens later than another's). `candles`
 * is the day's candles, ascending.
 */
function priceForBucket(
  candles: readonly IntradayCandle[],
  bucket: number,
  stepMs: number,
): number | null {
  if (candles.length === 0) return null;
  const cutoff = bucket + stepMs;
  let chosen: number | null = null;
  for (const candle of candles) {
    if (candle.atMs < cutoff) chosen = candle.price;
    else break;
  }
  // `bucket` sits before this asset's first candle (a later-opening market):
  // carry the first candle back rather than dropping the asset from the curve.
  return chosen ?? candles[0]!.price;
}

/**
 * Assemble the EUR intraday value curve for `[cutoffDay, today]`. Pure and
 * deterministic — the caller supplies the daily snapshot ingredients and the
 * already-fetched candles; re-denomination into a non-EUR base and the
 * performance curve are layered on top by the service.
 */
export function buildIntradayEurValuePoints(input: BuildIntradayEurInput): IntradayValuePoint[] {
  const { cutoffDay, nowMs, dailyValueEurByDay, perAssetEurByDay, candlesByAsset } = input;
  const stepMs = RANGE_CONFIG[input.range].stepMs;

  // In-window days come straight from the daily series (one point per calendar
  // day), so weekends/holidays are already present via carry-forward.
  const windowDays = [...dailyValueEurByDay.keys()].filter((d) => d >= cutoffDay).sort();
  if (windowDays.length === 0) return [];
  const windowDaySet = new Set(windowDays);
  const cutoffMs = dayStartMs(cutoffDay);

  // Cash per day = net worth − Σ held-asset value (holdings, #311). Derived so
  // the intraday sum reproduces the daily net worth exactly at each close.
  const cashByDay = new Map<string, number>();
  for (const day of windowDays) {
    let holdings = 0;
    for (const perDay of perAssetEurByDay.values()) {
      const v = perDay.get(day);
      if (v !== undefined) holdings += v;
    }
    cashByDay.set(day, (dailyValueEurByDay.get(day) ?? 0) - holdings);
  }

  // Per-asset, per-day candles (window-clamped, ascending) + each day's
  // reference close (its last candle). Only held assets carry candles.
  const dayCandles = new Map<string, Map<string, IntradayCandle[]>>();
  const refCloseByAssetDay = new Map<string, Map<string, number>>();
  const bucketSet = new Set<number>();
  for (const [assetId, candles] of candlesByAsset) {
    if (candles.length === 0) continue;
    const byDay = new Map<string, IntradayCandle[]>();
    for (const candle of candles) {
      if (!Number.isFinite(candle.atMs) || !Number.isFinite(candle.price)) continue;
      if (candle.atMs < cutoffMs || candle.atMs > nowMs) continue;
      const day = dayOfMs(candle.atMs);
      if (!windowDaySet.has(day)) continue;
      const list = byDay.get(day);
      if (list) list.push(candle);
      else byDay.set(day, [candle]);
      bucketSet.add(bucketMs(candle.atMs, stepMs));
    }
    if (byDay.size === 0) continue;
    const refs = new Map<string, number>();
    for (const [day, list] of byDay) {
      list.sort((a, b) => a.atMs - b.atMs);
      refs.set(day, list[list.length - 1]!.price);
    }
    dayCandles.set(assetId, byDay);
    refCloseByAssetDay.set(assetId, refs);
  }

  const points: IntradayValuePoint[] = [];
  const gridDays = new Set<string>();

  for (const bucket of [...bucketSet].sort((a, b) => a - b)) {
    const day = dayOfMs(bucket);
    if (!windowDaySet.has(day)) continue;
    gridDays.add(day);
    let value = cashByDay.get(day) ?? 0;
    for (const [assetId, perDay] of perAssetEurByDay) {
      const vday = perDay.get(day);
      if (vday === undefined) continue; // asset not held on this day
      const candles = dayCandles.get(assetId)?.get(day);
      if (!candles || candles.length === 0) {
        value += vday; // carry forward (custom/manual, or a missed session)
        continue;
      }
      const ref = refCloseByAssetDay.get(assetId)?.get(day);
      const price = priceForBucket(candles, bucket, stepMs);
      value += ref !== undefined && ref !== 0 && price !== null ? (vday * price) / ref : vday;
    }
    points.push({ date: day, timeMs: bucket, valueEur: value });
  }

  // Any in-window day with no intraday coverage at all keeps its single daily
  // point (the daily↔intraday boundary): stamped at the day's close, or "now"
  // for today. This is what makes a zero-candle window degrade to the daily
  // slice and lets a 1W span mix intraday-recent with daily-older days.
  for (const day of windowDays) {
    if (gridDays.has(day)) continue;
    const closeMs = Math.min(dayStartMs(day) + DAY_MS - 1, nowMs);
    points.push({ date: day, timeMs: closeMs, valueEur: dailyValueEurByDay.get(day) ?? 0 });
  }

  points.sort((a, b) => a.timeMs - b.timeMs);
  return points;
}

/** One point on the intraday performance (%) curve. */
export interface IntradayPerformancePoint {
  date: string;
  timeMs: number;
  pct: number;
}

export interface IntradayPerformanceInput {
  /** The base-currency intraday value points (windowed, ascending). */
  intradayPoints: readonly IntradayValuePoint[];
  /** The FULL daily base-currency value series (cumulative-index anchor). */
  dailyBasePoints: readonly ValuePoint[];
  /** The base-currency external TWR flows (any day). */
  flowsBase: readonly FlowPoint[];
}

/**
 * The cash-flow-neutralized performance (%) curve at intraday granularity,
 * **anchored to the established daily TWR** (issue #125) so it agrees with the
 * 1M+ ranges at every day close. Each day's chained index comes from
 * {@link timeWeightedReturn} over the daily series; within a day an intraday
 * point scales that day's return by its own value while keeping the flow at the
 * day boundary:
 *
 *     index(t) = index(D−1) · (value(t) − min(flow_D, 0)) / (V(D−1) + max(flow_D, 0))
 *
 * At `t = close`, `value(t) = V(D)` and the bracket collapses to the daily
 * return `r_D`, so `index(close) = index(D)` exactly — the intraday curve
 * telescopes to the daily one at each close, deposits cause no jump, and the
 * result is finally re-based so the window opens at 0 % (the non-MAX
 * convention).
 */
export function intradayPerformancePoints(
  input: IntradayPerformanceInput,
): IntradayPerformancePoint[] {
  const { intradayPoints, dailyBasePoints, flowsBase } = input;
  if (intradayPoints.length === 0) return [];

  // Cumulative daily index per day (1 + pct/100) and the daily value per day.
  const dailyPerf = timeWeightedReturn(dailyBasePoints, flowsBase);
  const indexByDay = new Map<string, number>();
  for (const p of dailyPerf) indexByDay.set(p.date, 1 + p.pct / 100);
  const valueByDay = new Map<string, number>();
  for (const p of dailyBasePoints) valueByDay.set(p.date, p.valueEur);

  const flowByDay = new Map<string, number>();
  for (const f of flowsBase) flowByDay.set(f.date, (flowByDay.get(f.date) ?? 0) + f.flowEur);

  // Ascending distinct days of the daily series → each day's predecessor.
  const orderedDays = [...valueByDay.keys()].sort();
  const prevDayOf = new Map<string, string | undefined>();
  for (let i = 0; i < orderedDays.length; i += 1) {
    prevDayOf.set(orderedDays[i]!, i > 0 ? orderedDays[i - 1] : undefined);
  }

  const raw: IntradayPerformancePoint[] = intradayPoints.map((pt) => {
    const prevDay = prevDayOf.get(pt.date);
    const prevIndex = prevDay !== undefined ? (indexByDay.get(prevDay) ?? 1) : 1;
    const prevValue = prevDay !== undefined ? (valueByDay.get(prevDay) ?? 0) : 0;
    const flow = flowByDay.get(pt.date) ?? 0;
    const numerator = pt.valueEur - Math.min(flow, 0);
    const denominator = prevValue + Math.max(flow, 0);
    const r =
      numerator > VALUE_EPSILON && denominator > VALUE_EPSILON ? numerator / denominator : 1;
    const index = prevIndex * r;
    return { date: pt.date, timeMs: pt.timeMs, pct: (index - 1) * 100 };
  });

  // Re-base to 0 % at the window's first point (compounding, not subtraction —
  // issue #125): the 1D/1W curve shows the TWR *of that window*.
  const base = 1 + raw[0]!.pct / 100;
  if (!Number.isFinite(base) || base <= 0) return raw;
  return raw.map((p) => ({
    date: p.date,
    timeMs: p.timeMs,
    pct: ((1 + p.pct / 100) / base - 1) * 100,
  }));
}
