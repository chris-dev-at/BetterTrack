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
 * densifies the short ranges into a sub-daily curve without a second value
 * engine: it reuses the daily series as the anchor and scales each held asset by
 * its own **intraday price ratio**.
 *
 * ## Point budget, not fixed density (2026-07-20 rework)
 *
 * Every chart aims at roughly the SAME modest number of plotted points
 * ({@link TARGET_POINTS}) so it is light on the server and loads fast — density
 * therefore DECREASES as the span grows, never the reverse. Two mechanisms serve
 * it, split by whether sub-daily market data even exists for the span:
 *
 *  - **1D / 1W / 1M — the intraday curve here.** A provider serves sub-daily
 *    candles only for a recent window (§5.3: 30-minute bars reach ~60 days), and
 *    1M fits inside it. 1D/1W keep their fine per-day resolution (a single day
 *    is *meant* to be the highest per-time detail); 1M coarsens its grid to the
 *    budget — a smooth month, not an every-30-minutes wall.
 *  - **6M / 1Y / 5Y — daily downsample (see {@link downsampledIndices}).** No
 *    sub-daily fetch and no reuse of the 1M candles: the already-computed daily
 *    snapshot series is thinned to ≤ {@link TARGET_POINTS} by taking every k-th
 *    day (k = ⌈days / TARGET_POINTS⌉), so a 5-year chart is ~TARGET points across
 *    five years rather than ~1250 daily points — cheap, adds no upstream fetch.
 *  - **MAX** keeps its full daily since-inception curve (unchanged).
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
 * ## Grid granularity
 *
 * Provider candles are quantized onto a fixed per-range step so every asset
 * lands on the same grid marks (aligned, never jagged) while grid points exist
 * only where intraday data does (no dead overnight/weekend flats). 1D keeps a
 * 15-minute grid and 1W an hourly one; 1M coarsens to ~`span / TARGET_POINTS`
 * (a few hours) so a 24/7 asset lands near the budget and an equity — trading
 * only market hours — comfortably below it.
 */

/**
 * Target number of plotted points per chart — the one knob (2026-07-20 rework).
 * Each range picks its resolution so it renders roughly this many points: a
 * smooth line that is cheap to compute, transfer and draw at every zoom. Kept in
 * the 250–350 band; the value is presentational, so tuning it never touches a
 * money number.
 */
export const TARGET_POINTS = 300;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The ranges rendered by the intraday curve here: 1D/1W/1M. Sub-daily market
 * data exists for all three (1M sits inside the provider's ~60-day intraday
 * window), so they anchor a sub-daily curve to the daily snapshot. Longer spans
 * (6M/1Y/5Y) have no sub-daily data that far back and instead downsample the
 * daily series ({@link isDownsampledRange}); MAX stays full daily.
 */
export const INTRADAY_PORTFOLIO_RANGES = ['1D', '1W', '1M'] as const;
export type IntradayPortfolioRange = (typeof INTRADAY_PORTFOLIO_RANGES)[number];

export function isIntradayRange(range: PortfolioHistoryRange): range is IntradayPortfolioRange {
  return (INTRADAY_PORTFOLIO_RANGES as readonly string[]).includes(range);
}

/**
 * The ranges served by downsampling the already-computed daily snapshot series
 * to {@link TARGET_POINTS} (no upstream fetch): 6M/1Y/5Y.
 */
export const DOWNSAMPLED_PORTFOLIO_RANGES = ['6M', '1Y', '5Y'] as const;
export type DownsampledPortfolioRange = (typeof DOWNSAMPLED_PORTFOLIO_RANGES)[number];

export function isDownsampledRange(
  range: PortfolioHistoryRange,
): range is DownsampledPortfolioRange {
  return (DOWNSAMPLED_PORTFOLIO_RANGES as readonly string[]).includes(range);
}

/**
 * 1M keeps sub-daily candles (it is inside the provider's ~60-day intraday
 * window) but coarsens to the point budget instead of the 30-minute fetch
 * granularity: the grid step is the 1-month span divided by {@link TARGET_POINTS}
 * (~2.5 h). A "nice month curve", not an every-30-minutes wall.
 */
const INTRADAY_MONTH_STEP_MS =
  Math.max(1, Math.round((31 * DAY_MS) / TARGET_POINTS / MINUTE_MS)) * MINUTE_MS;

/**
 * Per-range candle `fetchRange` + provider `interval` + grid `stepMs` for the
 * intraday ranges. 1D pulls 15-minute candles onto a 15-minute grid; 1W pulls
 * 30-minute candles thinned onto an hourly grid (there is no native 1-hour
 * provider interval, and 30-minute bars quantized to the hour give one clean
 * point per market hour); 1M reuses the 30-minute candles on the budget-sized
 * grid. Every interval is short-TTL cached by the §5.3 keystone (1D = 60 s,
 * 1W = 5 min, 1M = 15 min), so a burst of series reads costs at most one
 * upstream fetch per asset/interval.
 */
const RANGE_CONFIG: Record<
  IntradayPortfolioRange,
  { fetchRange: HistoryRange; interval: HistoryInterval; stepMs: number }
> = {
  '1D': { fetchRange: '1D', interval: '15m', stepMs: 15 * MINUTE_MS },
  '1W': { fetchRange: '1W', interval: '30m', stepMs: 60 * MINUTE_MS },
  '1M': { fetchRange: '1M', interval: '30m', stepMs: INTRADAY_MONTH_STEP_MS },
};

export function intradayIntervalFor(range: IntradayPortfolioRange): HistoryInterval {
  return RANGE_CONFIG[range].interval;
}

export function intradayStepMs(range: IntradayPortfolioRange): number {
  return RANGE_CONFIG[range].stepMs;
}

/** The §5.3 range window whose candles feed `range` (1D/1W self; 1M the month). */
export function intradayFetchRange(range: IntradayPortfolioRange): HistoryRange {
  return RANGE_CONFIG[range].fetchRange;
}

/**
 * Indices of an `n`-point series thinned to ≤ `target` points by keeping every
 * k-th (k = ⌈n / target⌉) plus the first and last — the presentation-only day
 * sampling the 6M/1Y/5Y charts apply to the daily snapshot series. The endpoints
 * are always kept so the window still opens at its start (0 % after re-basing)
 * and ends at the fresh "today" value; each kept index is a real snapshot day,
 * so every plotted value stays exactly correct. `n ≤ target` returns every index
 * unchanged (short spans are never thinned).
 */
export function downsampledIndices(n: number, target: number): number[] {
  if (n <= 0) return [];
  if (n <= target) return Array.from({ length: n }, (_, i) => i);
  const k = Math.ceil(n / target);
  const indices: number[] = [];
  for (let i = 0; i < n; i += k) indices.push(i);
  if (indices[indices.length - 1] !== n - 1) indices.push(n - 1);
  return indices;
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
  range: IntradayPortfolioRange;
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
