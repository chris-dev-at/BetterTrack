import type {
  HistoryInterval,
  HistoryRange,
  PortfolioHistoryInterval,
  PortfolioHistoryRange,
  PortfolioHistoryResolvedInterval,
} from '@bettertrack/contracts';

import {
  QTY_EPSILON,
  timeWeightedReturn,
  VALUE_EPSILON,
  type FlowPoint,
  type ValuePoint,
} from '../../domain/holdings';
import { buildIntradayBucketPrices } from './intradayBucketPrices';

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
 * ## Prior-close anchoring + same-day steps (issue #1120)
 *
 * The identity above carries ONE end-of-day units+cash figure per day, which
 * fabricated movement in three ways the #1120 audit pinned: a same-day trade
 * was retro-applied from the day's first bucket (I1), an asset's pre-open
 * buckets were backfilled with its FIRST candle so overnight gaps appeared at
 * the wrong instant (I2), and a candle-less asset flat-lined at its CURRENT
 * day value instead of its prior close (I3). Three rules repair that without
 * touching the closing seam or the FX discipline:
 *
 *  - **Pre-open buckets** (before an asset's first candle of the day) and
 *    **candle-less days** anchor to the PREVIOUS series day's value
 *    `V_a(D−1)` — the daily series is the authority for "prior close in EUR",
 *    so no extra price or FX lookup is needed. When no prior-day value exists
 *    (the series' first day), the legacy behaviour — first-candle backfill /
 *    flat `V_a(D)` — is the fallback.
 *  - **Same-day trades** ({@link BuildIntradayEurInput.unitsByAsset}) apply as
 *    a step function at their actual bucket: an intraday bucket scales by
 *    `units(t) / units_a(D,EOD)` (and pre-open/candle-less buckets by the
 *    prior-day per-unit value), so the curve before a 14:00 buy reflects the
 *    pre-trade holdings. Cash movements
 *    ({@link BuildIntradayEurInput.cashEvents}) step the derived cash figure
 *    the same way. Both inputs are optional — absent, a day keeps its constant
 *    EOD units/cash exactly as before. **Each event contributes its own grid
 *    marks** so the step always exists where the event does, however sparse (or
 *    absent) the day's candles are — see "Grid granularity" below.
 *  - **The day's LAST grid bucket is the closing seam** and always carries the
 *    exact EOD state (EOD units, EOD cash, candle-less assets at `V_a(D)`), so
 *    the last intraday point still coincides with the daily value precisely.
 *    A day's own move for a candle-less asset therefore lands AT its close
 *    rather than being spread backward over hours it never covered. A day with
 *    no candles at all has no seam: its daily point (stamped at the day's close,
 *    or "now" for today) is its closing value, so its event buckets all carry
 *    progressive state.
 *
 * Known, deliberate limitation — **a same-day round trip is not stepped**
 * (#1120 review). A position opened AND fully closed inside ONE day has no EUR
 * anchor on either side (`V_a(D) = 0` at that close, no units the day before),
 * so no bucket between its buy and its sell can price it. Stepping its cash
 * legs alone would show the money leaving while the position it bought stays
 * invisible — a fabricated dip the size of the whole position. Such an
 * asset-day is therefore detected up front ({@link anchorlessAssetDays}) and
 * left un-stepped: its trades contribute no grid marks, its linked cash legs
 * stay folded into the day's EOD figure, and the day reads exactly as it did
 * pre-#1120 (flat, the round trip's P/L landing at the day's close). The
 * service drops the matching per-instant TWR flows for those trades too, so
 * the % curve keeps its day-anchored (flat) shape as well. A position sold out
 * mid-window — held the day before, so anchored — keeps its steps: its
 * pre-sale buckets price at the prior-day per-unit value (flat) rather than at
 * intraday candles, never fabricated movement, just coarser.
 *
 * A *today*-dated pay-from-cash buy that was short of cash at its own instant
 * is a second, pre-existing coarseness: `settleCashAsOfToday` stamps the linked
 * movement "now" while the trade keeps its earlier instant, so between the two
 * the stepped curve carries the position with its cash not yet deducted. The
 * % curve is neutral across it (the service emits the #378 compensator pair for
 * same-day settlements too); the value curve shows the transient.
 *
 * An asset with **no intraday candles on `D`** (custom/manual assets always; a
 * market asset on a day the provider missed) contributes its prior-day value
 * until the day's last bucket snaps it to `V_a(D)` (legacy flat `V_a(D)` when
 * no prior day exists) — it carries forward and the curve never breaks or
 * drops it. With zero candles AND no step inputs for the whole window the
 * output degrades precisely to the daily slice (one point per in-window day),
 * i.e. the pre-#556 behaviour.
 *
 * ## Grid granularity
 *
 * Provider candles are quantized onto a fixed per-range step so every asset
 * lands on the same grid marks (aligned, never jagged) while grid points exist
 * only where intraday data does (no dead overnight/weekend flats). 1D keeps a
 * 15-minute grid, 1W an hourly one, and 1M a UTC-day-aligned 144-minute grid.
 * That leaves a 24/7 asset near the point budget and an equity — trading only
 * market hours — comfortably below it.
 *
 * **Step inputs add grid marks of their own** (#1120 review): candle marks
 * alone cannot represent an event that falls between two candles — sparse
 * provider coverage, an after-hours cash movement past the day's last candle,
 * or a candle-less day. Without a mark of its own the state change would ramp
 * across the surrounding candles, and past the day's last candle the seam would
 * retro-apply it onto an earlier bucket. Each in-window trade/cash instant
 * therefore contributes its quantized bucket plus the bucket before it (the
 * step's leading edge), both clamped to the event's own day, so the change
 * reads as ONE grid step at the event's instant. The marks are a set, so events
 * sharing a bucket (and edges coinciding with candle marks) cost nothing.
 *
 * {@link TARGET_POINTS} therefore sizes the CANDLE grid only — once step inputs
 * exist the budget is advisory, and a window over a busy ledger (a freshly
 * imported broker CSV, a dense standing-order set) can exceed it by up to two
 * points per distinct event bucket. Correctness comes first here: dropping an
 * event's mark would ramp its state change across the surrounding candles, or
 * retro-apply it at the seam. Thinning candle marks to make room for event
 * marks is the follow-up if a payload ever warrants it (#1120 review).
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
 * granularity. Its 144-minute step is the closest UTC-day divisor to the
 * ~2.5-hour point-budget target, so flooring a candle can never move it across
 * a UTC midnight. A "nice month curve", not an every-30-minutes wall.
 */
const INTRADAY_MONTH_STEP_MS = 144 * MINUTE_MS;

/**
 * Per-range candle `fetchRange` + provider `interval` + grid `stepMs` — the
 * pure builder's FALLBACK grid when the caller supplies no resolved `stepMs`
 * (see {@link resolveHistoryInterval}, which owns request-time resolution since
 * IN3). Kept at the long-established grids (1D 15-minute, 1W hourly, 1M the
 * budget grid) so the direct-call surface — and the fixture-heavy #1120/#1121
 * regression suites pinning it — stays byte-stable; the 15-minute 1D grid
 * remains a requestable interval, so these fallbacks stay genuinely served
 * configurations, not dead code. The SERVICE always passes the resolved grid
 * explicitly. Every interval is short-TTL cached by the §5.3 keystone (1D =
 * 60 s, 1W = 5 min, 1M = 15 min), so a burst of series reads costs at most one
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
 * Candle fetch + grid step behind each servable sub-daily interval (IN3, board
 * #76 item 2). The provider interval is the finest native §5.3 interval no
 * coarser than the grid step, so every grid mark can carry a real observation:
 * a 5-minute grid quantizes 1-minute candles (§5.3's own 1D table row — 60 s
 * TTL), the hourly and 144-minute grids thin 30-minute bars, and `15m`/`30m`
 * fetch natively. Every step divides the 1440-minute UTC day (#1121/IN2), so
 * no bucket can span midnight and day-scoped state can never leak across it.
 */
const SUB_DAILY_GRIDS: Record<
  Exclude<PortfolioHistoryResolvedInterval, '1d'>,
  { stepMs: number; fetchInterval: HistoryInterval }
> = {
  '5m': { stepMs: 5 * MINUTE_MS, fetchInterval: '1m' },
  '15m': { stepMs: 15 * MINUTE_MS, fetchInterval: '15m' },
  '30m': { stepMs: 30 * MINUTE_MS, fetchInterval: '30m' },
  '1h': { stepMs: 60 * MINUTE_MS, fetchInterval: '30m' },
  '144m': { stepMs: INTRADAY_MONTH_STEP_MS, fetchInterval: '30m' },
};

/**
 * The sub-daily grids each intraday range can serve, FINEST FIRST — the head is
 * what `auto` resolves to. Membership is budget-derived: a grid is servable iff
 * its worst-case bucket count (a 24/7 asset covering the whole span, span ×
 * 1440 min / step) stays inside the {@link TARGET_POINTS} band (≤ 350, the
 * documented ceiling):
 *
 *  - 1D (1 day):  5m → 288 ✓ (the IN3 owner ask), 15m → 96, 30m → 48, 1h → 24;
 *                 1m → 1440 ✗ (why `1m` is never servable anywhere).
 *  - 1W (7 days): 1h → 168 ✓; 30m → 336 ✗.
 *  - 1M (31 days): 144m → 310 ✓ (the established budget grid); 1h → 744 ✗.
 */
const SERVABLE_SUB_DAILY: Record<
  IntradayPortfolioRange,
  readonly Exclude<PortfolioHistoryResolvedInterval, '1d'>[]
> = {
  '1D': ['5m', '15m', '30m', '1h'],
  '1W': ['1h'],
  '1M': ['144m'],
};

/** Requested sub-daily interval → minutes, for the finest-fit comparison. */
const REQUESTED_STEP_MINUTES: Record<Exclude<PortfolioHistoryInterval, 'auto' | '1d'>, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
};

/** A resolved history request: what to echo, and (sub-daily only) how to build it. */
export interface ResolvedHistoryInterval {
  /** Echoed to the client as the response's `interval`. */
  interval: PortfolioHistoryResolvedInterval;
  /**
   * The sub-daily grid to assemble; absent ⇔ `interval` is `'1d'` and the
   * range serves its plain daily path (slice/downsample), untouched by IN3.
   */
  grid?: { stepMs: number; fetchInterval: HistoryInterval; fetchRange: HistoryRange };
}

/**
 * Resolve a client `interval` request against a range (IN3, board #76 item 2).
 * Total — every (range, interval) pair resolves; nothing is rejected:
 *
 *  - `auto` → the range's finest servable grid: 1D `5m` (the owner's "more 1D
 *    detail" — 1W/1M/daily auto behaviour is UNCHANGED), 1W `1h`, 1M `144m`,
 *    6M/1Y/5Y/MAX `1d`.
 *  - An explicit sub-daily interval is honored exactly when servable; one finer
 *    than the range's budget allows is coarsened to the finest servable grid
 *    that is not finer than requested (the **finest-fit rule** — chosen over a
 *    400 so every enum value stays usable as "the finest you can give me", and
 *    the echoed `interval` tells the client what it actually got).
 *  - `1d` — and every request against a range with no sub-daily data — is the
 *    plain daily grid.
 */
export function resolveHistoryInterval(
  range: PortfolioHistoryRange,
  requested: PortfolioHistoryInterval,
): ResolvedHistoryInterval {
  if (!isIntradayRange(range) || requested === '1d') return { interval: '1d' };
  const servable = SERVABLE_SUB_DAILY[range];
  let pick = servable[0]!; // auto ⇒ the finest servable grid
  if (requested !== 'auto') {
    const wantedMs = REQUESTED_STEP_MINUTES[requested] * MINUTE_MS;
    const fit = servable.find((interval) => SUB_DAILY_GRIDS[interval].stepMs >= wantedMs);
    // No servable sub-daily grid at/above the request ⇒ daily. Unreachable
    // while every range's coarsest servable grid is coarser than `1h`-or-finer
    // requests, but the fallback keeps the function total by construction.
    if (fit === undefined) return { interval: '1d' };
    pick = fit;
  }
  const { stepMs, fetchInterval } = SUB_DAILY_GRIDS[pick];
  return {
    interval: pick,
    grid: { stepMs, fetchInterval, fetchRange: RANGE_CONFIG[range].fetchRange },
  };
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

/** One step of an asset's cumulative units — the state AFTER a trade (#1120). */
export interface IntradayUnitsStep {
  /** Trade instant (epoch-ms). */
  atMs: number;
  /**
   * Cumulative units held immediately after this trade. Never negative, and
   * never dust: {@link unitsTimelineFromTrades} clamps anything below
   * {@link QTY_EPSILON} to exactly 0, mirroring `domain/holdings`, so a closed
   * position reads as closed on both sides (#1120 review).
   */
  units: number;
}

/**
 * An asset's units step function across the window (#1120/I1): the units held
 * entering the window plus each in-window trade's resulting cumulative units.
 */
export interface IntradayAssetUnits {
  /** Units held entering the window (before the first step). */
  initialUnits: number;
  /** Ascending by `atMs`; at least one step (constant assets pass nothing). */
  steps: readonly IntradayUnitsStep[];
}

/** One cash-ledger movement at its instant: signed EUR amount (#1120/I1). */
export interface IntradayCashEvent {
  atMs: number;
  /** Signed as stored: inflows positive, outflows negative. */
  amountEur: number;
  /**
   * The asset whose trade this movement settles, for a linked leg (#1120
   * review). A leg settling a position with no EUR anchor that day — a same-day
   * round trip, or an asset absent from the daily per-asset series — is left
   * un-stepped: the position it pays for can never appear, so stepping the cash
   * alone would fabricate a dip. External movements pass nothing.
   */
  assetId?: string;
}

/** One external TWR flow at its instant, in the caller's base currency. */
export interface IntradayFlowEvent {
  atMs: number;
  flowEur: number;
}

/**
 * Fold signed unit deltas (buy +qty / sell −qty, chronological) into the
 * {@link IntradayAssetUnits} step function for the window starting at
 * `cutoffMs`: deltas before the cutoff collapse into `initialUnits`, deltas at
 * or after it become steps. The running total takes `domain/holdings`' clamp
 * verbatim (`holdings.ts`, the `deriveHoldings`/`valueOverTime` fold): anything
 * below {@link QTY_EPSILON} becomes exactly 0, which covers both the no-shorts
 * invariant (an uncovered sell closes the position at zero) and the
 * sell-everything float dust. Returns `undefined` when no in-window delta
 * exists: constant units need no stepping, and skipping them keeps their
 * assembly path bit-identical to the pre-#1120 one.
 *
 * The clamp is load-bearing, not cosmetic (#1120 review). Selling a position
 * built from fractional lots (`0.1 + 0.2` folds to `0.30000000000000004`, and
 * the UI offers the stored `0.3` for "sell all") leaves ~5.6e-17 units behind
 * under a plain `max(0, …)`. The engine clamps that to 0 and publishes
 * `V_a(D) = 0`, so the dust would make this fold — and only this fold — read
 * the day as "units survive to the close": {@link anchorlessAssetDays} would
 * see an anchor that does not exist, the same-day round trip would step its
 * cash legs against a position that prices at 0 at every bucket, and the
 * full-position plunge-and-recover this issue exists to remove would be back.
 */
export function unitsTimelineFromTrades(
  trades: readonly { atMs: number; unitsDelta: number }[],
  cutoffMs: number,
): IntradayAssetUnits | undefined {
  let cumulative = 0;
  let initialUnits = 0;
  const steps: IntradayUnitsStep[] = [];
  for (const trade of trades) {
    if (!Number.isFinite(trade.atMs) || !Number.isFinite(trade.unitsDelta)) continue;
    cumulative += trade.unitsDelta;
    if (cumulative < QTY_EPSILON) cumulative = 0;
    if (trade.atMs < cutoffMs) initialUnits = cumulative;
    else steps.push({ atMs: trade.atMs, units: cumulative });
  }
  return steps.length > 0 ? { initialUnits, steps } : undefined;
}

/** Units held as of `atMs` per the step function (last step at or before it). */
function unitsAt(info: IntradayAssetUnits, atMs: number): number {
  let units = info.initialUnits;
  for (const step of info.steps) {
    if (step.atMs > atMs) break;
    units = step.units;
  }
  return units;
}

/** Key of one `(assetId, day)` pair — the {@link anchorlessAssetDays} members. */
export function assetDayKey(assetId: string, day: string): string {
  return `${assetId}|${day}`;
}

/**
 * The `(assetId, day)` pairs whose same-day trades have **no EUR anchor** and
 * therefore cannot be stepped (#1120 review).
 *
 * An intraday bucket prices a held position from one of two EUR anchors: the
 * day's own per-asset value `V_a(D)` (usable only when units survive to the
 * close, so the `u / eod` ratio exists) or the previous series day's value
 * `V_a(D−1)` (usable only when units were held entering the day). A position
 * opened AND fully closed inside one day has neither — `V_a(D) = 0` with
 * `eod = 0`, and no units the day before — as does any asset missing from the
 * daily per-asset series entirely. Its intraday value is 0 at every bucket
 * while its linked cash legs would keep stepping, so the curve would show the
 * cash leave with nothing bought for it: a dip the size of the position, which
 * is precisely the fabrication class #1120 exists to remove.
 *
 * Callers drop the day's steps, its linked cash legs (value curve) and its
 * per-instant TWR flows (% curve) for these pairs, which restores the
 * pre-#1120 day-anchored treatment for exactly that day.
 *
 * Only days carrying an in-window step are considered — a day the asset merely
 * carries through has no event to suppress.
 *
 * "Held" is tested against {@link QTY_EPSILON}, not against 0, so a hand-built
 * step function carrying sell-everything dust cannot claim an anchor the daily
 * series does not have ({@link unitsTimelineFromTrades} already clamps, but
 * this input is public).
 */
export function anchorlessAssetDays(input: {
  /** Net-worth EUR per calendar day — the day ordering for the prior-day anchor. */
  dailyValueEurByDay: ReadonlyMap<string, number>;
  /** Per-asset EUR value per calendar day (the daily snapshot per-asset series). */
  perAssetEurByDay: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Same-day trade steps per asset; absent ⇒ nothing is stepped at all. */
  unitsByAsset?: ReadonlyMap<string, IntradayAssetUnits>;
}): ReadonlySet<string> {
  const keys = new Set<string>();
  if (input.unitsByAsset === undefined) return keys;

  const orderedDays = [...input.dailyValueEurByDay.keys()].sort();
  const prevDayOf = new Map<string, string | undefined>();
  for (let i = 0; i < orderedDays.length; i += 1) {
    prevDayOf.set(orderedDays[i]!, i > 0 ? orderedDays[i - 1] : undefined);
  }

  for (const [assetId, info] of input.unitsByAsset) {
    // An asset outside the per-asset series has no anchor on any day.
    const perDay = input.perAssetEurByDay.get(assetId) ?? new Map<string, number>();
    const stepDays = new Set<string>();
    for (const step of info.steps) {
      if (Number.isFinite(step.atMs)) stepDays.add(dayOfMs(step.atMs));
    }
    for (const day of stepDays) {
      const dayStart = dayStartMs(day);
      // Anchor 1: the day's own close, scalable only with units at the close.
      if (perDay.get(day) !== undefined && unitsAt(info, dayStart + DAY_MS - 1) > QTY_EPSILON) {
        continue;
      }
      // Anchor 2: the prior series day's value, per unit held entering the day.
      const prevDay = prevDayOf.get(day);
      const vPrev = prevDay !== undefined ? perDay.get(prevDay) : undefined;
      if (vPrev !== undefined && unitsAt(info, dayStart - 1) > QTY_EPSILON) continue;
      keys.add(assetDayKey(assetId, day));
    }
  }
  return keys;
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
  /**
   * Grid step in ms — the resolved interval's step ({@link resolveHistoryInterval},
   * IN3). MUST divide the 1440-minute UTC day (#1121/IN2) so no bucket spans
   * midnight; every servable grid does by construction. Omitted ⇒ the range's
   * {@link RANGE_CONFIG} fallback grid (1D 15-minute, 1W hourly, 1M 144-minute),
   * which keeps the pure surface — and the #1120/#1121 fixture suites pinning
   * it — byte-stable. The service always passes the resolved step explicitly.
   */
  stepMs?: number;
  /**
   * Inclusive daily window start (ISO), i.e. `rangeCutoffIso(range, today)`.
   * For 1D this is the prior-close anchor; its intraday grid begins today.
   */
  cutoffDay: string;
  /** Captured request-as-of UTC day; daily data after it is outside the window. */
  asOfDay: string;
  /** Current wall-clock (epoch-ms) — bounds the "today" fallback stamp. */
  nowMs: number;
  /** Net-worth EUR per calendar day (the daily snapshot points, full series). */
  dailyValueEurByDay: ReadonlyMap<string, number>;
  /** Per-asset EUR value per calendar day (the daily snapshot per-asset series). */
  perAssetEurByDay: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Native intraday candles per asset; missing/empty ⇒ that asset carries forward. */
  candlesByAsset: ReadonlyMap<string, readonly IntradayCandle[]>;
  /**
   * Same-day trade steps per asset (#1120/I1) — only assets with an in-window
   * trade. Absent (or an asset missing here) ⇒ constant EOD units per day, the
   * pre-#1120 behaviour.
   */
  unitsByAsset?: ReadonlyMap<string, IntradayAssetUnits>;
  /**
   * In-window cash-ledger movements at their instants (#1120/I1). Absent ⇒
   * each day's derived cash stays constant at its EOD figure.
   */
  cashEvents?: readonly IntradayCashEvent[];
  /**
   * The {@link anchorlessAssetDays} set, when the caller already computed it to
   * suppress the matching TWR flows on the % curve (#1120 review). Passing it
   * makes the two curves provably agree about which asset-days are stepped —
   * and saves the duplicate pass on the hottest V5-P1 read. Absent ⇒ computed
   * here from the same three inputs.
   */
  anchorlessDays?: ReadonlySet<string>;
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
 * Assemble the EUR intraday value curve for `[cutoffDay, asOfDay]`. Pure and
 * deterministic — the caller supplies the daily snapshot ingredients and the
 * already-fetched candles; re-denomination into a non-EUR base and the
 * performance curve are layered on top by the service.
 */
export function buildIntradayEurValuePoints(input: BuildIntradayEurInput): IntradayValuePoint[] {
  const {
    cutoffDay,
    asOfDay,
    nowMs,
    dailyValueEurByDay,
    perAssetEurByDay,
    candlesByAsset,
    unitsByAsset,
    cashEvents,
  } = input;
  const stepMs = input.stepMs ?? RANGE_CONFIG[input.range].stepMs;

  // In-window days come straight from the daily series (one point per calendar
  // day), so weekends/holidays are already present via carry-forward.
  const windowDays = [...dailyValueEurByDay.keys()]
    .filter((d) => d >= cutoffDay && d <= asOfDay)
    .sort();
  if (windowDays.length === 0) return [];
  const windowDaySet = new Set(windowDays);
  const cutoffMs = dayStartMs(cutoffDay);
  // 1D is yesterday's close followed by today's intraday curve. Providers can
  // return trailing candles from yesterday for a 1D request; accepting those
  // would turn the visual into two full calendar days and re-base at the wrong
  // point. The prior day's daily fallback below remains the close anchor.
  const candleStartMs = input.range === '1D' ? dayStartMs(asOfDay) : cutoffMs;

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
  // reference close (its last candle) and open bucket (its first candle's grid
  // mark — buckets before it are pre-open, #1120/I2). Only held assets carry
  // candles.
  const dayCandles = new Map<string, Map<string, IntradayCandle[]>>();
  const refCloseByAssetDay = new Map<string, Map<string, number>>();
  const openBucketByAssetDay = new Map<string, Map<string, number>>();
  const candleBuckets = new Set<number>();
  for (const [assetId, candles] of candlesByAsset) {
    if (candles.length === 0) continue;
    const byDay = new Map<string, IntradayCandle[]>();
    for (const candle of candles) {
      if (!Number.isFinite(candle.atMs) || !Number.isFinite(candle.price)) continue;
      if (candle.atMs < candleStartMs || candle.atMs > nowMs) continue;
      const day = dayOfMs(candle.atMs);
      if (!windowDaySet.has(day)) continue;
      const list = byDay.get(day);
      if (list) list.push(candle);
      else byDay.set(day, [candle]);
      candleBuckets.add(bucketMs(candle.atMs, stepMs));
    }
    if (byDay.size === 0) continue;
    const refs = new Map<string, number>();
    const opens = new Map<string, number>();
    for (const [day, list] of byDay) {
      list.sort((a, b) => a.atMs - b.atMs);
      refs.set(day, list[list.length - 1]!.price);
      opens.set(day, bucketMs(list[0]!.atMs, stepMs));
    }
    dayCandles.set(assetId, byDay);
    refCloseByAssetDay.set(assetId, refs);
    openBucketByAssetDay.set(assetId, opens);
  }

  // Asset-days whose position cannot be priced at ANY bucket (same-day round
  // trips; assets outside the daily per-asset series). Their steps, their
  // linked cash legs and their grid marks are all suppressed, so the day keeps
  // its pre-#1120 day-anchored shape instead of stepping cash against an
  // invisible position (#1120 review).
  const anchorlessDays =
    input.anchorlessDays ??
    anchorlessAssetDays({
      dailyValueEurByDay,
      perAssetEurByDay,
      unitsByAsset,
    });
  const stepSuppressed = (assetId: string, day: string): boolean =>
    !perAssetEurByDay.has(assetId) || anchorlessDays.has(assetDayKey(assetId, day));

  // Grid marks contributed by the step inputs themselves (#1120 review): the
  // event's own quantized bucket plus the bucket before it (the step's leading
  // edge), so a trade or movement between two candles — or on a day with none —
  // reads as one grid step AT its instant instead of ramping across the
  // surrounding candles. Both marks stay on the event's own calendar day, so a
  // grid step that does not divide the day can never leak a mark into its
  // neighbour, and events already covered by a candle mark add nothing.
  const eventBuckets = new Set<number>();
  const addEventBuckets = (atMs: number, assetId?: string): void => {
    if (!Number.isFinite(atMs) || atMs < candleStartMs || atMs > nowMs) return;
    const day = dayOfMs(atMs);
    if (!windowDaySet.has(day)) return;
    // A suppressed event never steps, so a mark for it would be a duplicate
    // point with nothing behind it.
    if (assetId !== undefined && stepSuppressed(assetId, day)) return;
    const bucket = bucketMs(atMs, stepMs);
    if (dayOfMs(bucket) !== day) return;
    eventBuckets.add(bucket);
    const leadingEdge = bucket - stepMs;
    if (leadingEdge >= candleStartMs && dayOfMs(leadingEdge) === day) {
      eventBuckets.add(leadingEdge);
    }
  };
  for (const [assetId, info] of unitsByAsset ?? []) {
    for (const step of info.steps) addEventBuckets(step.atMs, assetId);
  }
  for (const event of cashEvents ?? []) addEventBuckets(event.atMs, event.assetId);

  const sortedBuckets = [...new Set([...candleBuckets, ...eventBuckets])].sort((a, b) => a - b);
  const bucketsByDay = new Map<string, number[]>();
  // Days with real intraday candle coverage: only these own a closing seam and
  // give up their daily point (see the emission loop below).
  const candleDays = new Set<string>();
  for (const bucket of sortedBuckets) {
    const day = dayOfMs(bucket);
    if (!windowDaySet.has(day)) continue;
    const buckets = bucketsByDay.get(day);
    if (buckets) buckets.push(bucket);
    else bucketsByDay.set(day, [bucket]);
    if (candleBuckets.has(bucket)) candleDays.add(day);
  }

  // Each asset/day candle list advances one cursor across that day's sorted
  // grid. Aggregation below then performs constant-time price lookups instead
  // of restarting an as-of candle scan for every bucket.
  const bucketPricesByAssetDay = new Map<string, Map<string, ReadonlyMap<number, number>>>();
  for (const [assetId, byDay] of dayCandles) {
    const pricesByDay = new Map<string, ReadonlyMap<number, number>>();
    for (const [day, candles] of byDay) {
      const buckets = bucketsByDay.get(day);
      if (!buckets) continue;
      pricesByDay.set(day, buildIntradayBucketPrices(candles, buckets, stepMs));
    }
    if (pricesByDay.size > 0) bucketPricesByAssetDay.set(assetId, pricesByDay);
  }

  // Previous SERIES day per window day — the prior-close anchor (#1120/I2+I3).
  // The predecessor comes from ALL daily-series days, so the window's first
  // day still anchors to the day just before the window.
  const orderedSeriesDays = [...dailyValueEurByDay.keys()].sort();
  const prevSeriesDayOf = new Map<string, string | undefined>();
  for (let i = 0; i < orderedSeriesDays.length; i += 1) {
    prevSeriesDayOf.set(orderedSeriesDays[i]!, i > 0 ? orderedSeriesDays[i - 1] : undefined);
  }

  // Each candle-covered day's last grid bucket: the closing seam, always
  // carrying EOD state — including when an after-hours event bucket extends the
  // grid past the day's last candle, which is precisely where the EOD state
  // belongs. A day whose grid is made of event buckets alone has NO seam: its
  // daily point below is its close, so every bucket there stays progressive.
  const seamBucketByDay = new Map<string, number>();
  for (const [day, buckets] of bucketsByDay) {
    if (!candleDays.has(day)) continue;
    seamBucketByDay.set(day, buckets[buckets.length - 1]!);
  }

  /** The daily↔intraday boundary stamp of a candle-less day: its close, or "now" for today. */
  const dailyStampOf = (day: string): number => Math.min(dayStartMs(day) + DAY_MS - 1, nowMs);

  // Cash steps (#1120/I1): per non-seam bucket, the signed sum of the day's
  // movements NOT yet applied by the bucket's end — subtracted from the EOD
  // figure, so the curve before a movement shows the pre-movement balance.
  const cashUnappliedByBucket = new Map<number, number>();
  if (cashEvents !== undefined && cashEvents.length > 0) {
    const eventsByDay = new Map<string, IntradayCashEvent[]>();
    for (const event of cashEvents) {
      if (!Number.isFinite(event.atMs) || !Number.isFinite(event.amountEur)) continue;
      const day = dayOfMs(event.atMs);
      if (!windowDaySet.has(day)) continue;
      // A leg settling an unpriceable position stays inside the day's EOD cash
      // figure — stepping it would move cash with nothing on the other side.
      if (event.assetId !== undefined && stepSuppressed(event.assetId, day)) continue;
      const list = eventsByDay.get(day);
      if (list) list.push(event);
      else eventsByDay.set(day, [event]);
    }
    for (const [day, events] of eventsByDay) {
      // Days without a grid keep their single EOD daily point — nothing to step.
      const buckets = bucketsByDay.get(day);
      if (!buckets) continue;
      events.sort((a, b) => a.atMs - b.atMs);
      // Undefined on a candle-less day (no seam): every bucket steps, and the
      // day's daily point still lands on the exact EOD cash.
      const seamBucket = seamBucketByDay.get(day);
      let total = 0;
      for (const event of events) total += event.amountEur;
      let applied = 0;
      let index = 0;
      for (const bucket of buckets) {
        if (bucket === seamBucket) break;
        const cutoff = bucket + stepMs;
        while (index < events.length && events[index]!.atMs < cutoff) {
          applied += events[index]!.amountEur;
          index += 1;
        }
        const unapplied = total - applied;
        if (unapplied !== 0) cashUnappliedByBucket.set(bucket, unapplied);
      }
    }
  }

  // Per asset+day EOD units under the step function (memoised per day).
  const unitsEodCache = new Map<string, number>();
  const eodUnits = (assetId: string, info: IntradayAssetUnits, day: string): number => {
    const key = `${assetId}|${day}`;
    let units = unitsEodCache.get(key);
    if (units === undefined) {
      units = unitsAt(info, dayStartMs(day) + DAY_MS - 1);
      unitsEodCache.set(key, units);
    }
    return units;
  };

  /**
   * One asset's EUR contribution at a bucket. `seam` marks the day's last grid
   * bucket, which always carries the exact EOD state — the closing seam. Every
   * path with neither same-day trades nor a prior-day value reduces to the
   * pre-#1120 expression bit-for-bit.
   */
  const assetValueAt = (
    assetId: string,
    perDay: ReadonlyMap<string, number>,
    day: string,
    bucket: number,
    seam: boolean,
  ): number => {
    const vday = perDay.get(day);
    // An anchorless day is left un-stepped (its cash legs are too), so it takes
    // the constant-units path below and reproduces the pre-#1120 value exactly.
    const info = anchorlessDays.has(assetDayKey(assetId, day))
      ? undefined
      : unitsByAsset?.get(assetId);
    if (vday === undefined && info === undefined) return 0; // asset not held on this day

    const ref = refCloseByAssetDay.get(assetId)?.get(day);
    const price = bucketPricesByAssetDay.get(assetId)?.get(day)?.get(bucket);
    // The day-close identity value: V_a(D)·price/refClose, flat V_a(D) with
    // no candles — exactly the legacy expression.
    const closeScaled = (): number =>
      ref !== undefined && ref !== 0 && price !== undefined ? (vday! * price) / ref : vday!;

    if (seam) return vday === undefined ? 0 : closeScaled();

    // Genuinely priced by the day's own candles: at/after the asset's first
    // candle (earlier buckets only carry the first-candle backfill).
    const openBucket = openBucketByAssetDay.get(assetId)?.get(day);
    const priced =
      openBucket !== undefined &&
      bucket >= openBucket &&
      ref !== undefined &&
      ref !== 0 &&
      price !== undefined;

    const prevDay = prevSeriesDayOf.get(day);
    const vPrev = prevDay !== undefined ? perDay.get(prevDay) : undefined;

    if (info === undefined) {
      // Constant units across the day. Pre-open and candle-less buckets anchor
      // to the prior series day's value (#1120/I2+I3); without one (the
      // series' first day), the legacy backfill/flat fallback applies.
      if (!priced && vPrev !== undefined) return vPrev;
      return closeScaled();
    }

    // Units apply at the bucket's END, never past the day's own end. Every
    // current range step divides a UTC day (#1121), so ordinary buckets cannot
    // straddle midnight; retain the clamp as a defensive guard for any future
    // non-dividing grid, because `vday`/`eod` below are day-scoped and an
    // unclamped read could scale THIS day's close by TOMORROW's units.
    const u = unitsAt(info, Math.min(bucket + stepMs - 1, dayStartMs(day) + DAY_MS - 1));
    if (u <= QTY_EPSILON) return 0;
    const eod = eodUnits(assetId, info, day);
    const prevEod = unitsAt(info, dayStartMs(day) - 1);

    if (priced && vday !== undefined && eod > QTY_EPSILON) {
      // Normal intraday pricing, stepped by the units ratio (#1120/I1) —
      // ratio 1 keeps the legacy value bit-for-bit.
      const scaled = (vday * price) / ref;
      return u === eod ? scaled : scaled * (u / eod);
    }
    // Pre-open / candle-less before any same-day trade: exactly the prior close.
    if (vPrev !== undefined && u === prevEod) return vPrev;
    // Prior-day per-unit anchor: pre-open/candle-less after a same-day trade,
    // or a day whose own close cannot scale (position sold out to zero EOD).
    if (vPrev !== undefined && prevEod > QTY_EPSILON) return u * (vPrev / prevEod);
    // First series day the asset appears: no prior anchor — the day's own
    // close scale, stepped by the units ratio (the legacy value when u = EOD).
    if (vday !== undefined && eod > QTY_EPSILON) {
      const scaled = closeScaled();
      return u === eod ? scaled : scaled * (u / eod);
    }
    // No EUR anchor at all: a day the asset is held through but the daily
    // per-asset series has no value for (an FX gap on both this day and the
    // previous one). Contribute 0 rather than guess a price. Same-day round
    // trips — the other shape with no anchor — never reach here: they are
    // detected up front and left un-stepped ({@link anchorlessAssetDays}).
    return 0;
  };

  const points: IntradayValuePoint[] = [];
  for (const bucket of sortedBuckets) {
    const day = dayOfMs(bucket);
    if (!windowDaySet.has(day)) continue;
    // A candle-less day's daily point carries its close; drop any event bucket
    // at or past that stamp so the two never land on the same instant.
    if (!candleDays.has(day) && bucket >= dailyStampOf(day)) continue;
    const seam = bucket === seamBucketByDay.get(day);
    let value = (cashByDay.get(day) ?? 0) - (seam ? 0 : (cashUnappliedByBucket.get(bucket) ?? 0));
    for (const [assetId, perDay] of perAssetEurByDay) {
      value += assetValueAt(assetId, perDay, day, bucket, seam);
    }
    points.push({ date: day, timeMs: bucket, valueEur: value });
  }

  // Any in-window day with no intraday CANDLE coverage keeps its daily point
  // (the daily↔intraday boundary): stamped at the day's close, or "now" for
  // today. This is what makes a zero-candle window degrade to the daily slice
  // and lets a 1W span mix intraday-recent with daily-older days. A candle-less
  // day carrying event buckets keeps it too — those buckets step the pre-close
  // state, and the daily point remains the day's exact closing value.
  for (const day of windowDays) {
    if (candleDays.has(day)) continue;
    points.push({
      date: day,
      timeMs: dailyStampOf(day),
      valueEur: dailyValueEurByDay.get(day) ?? 0,
    });
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

interface IntradayPerformanceBase {
  /**
   * The base-currency intraday value points, ascending by `timeMs` within each
   * day (as {@link buildIntradayEurValuePoints} returns them). Day order is
   * irrelevant; only the per-day maximum is read, so a shuffled input still
   * finds each day's closing seam.
   */
  intradayPoints: readonly IntradayValuePoint[];
  /** The FULL daily base-currency value series (cumulative-index anchor). */
  dailyBasePoints: readonly ValuePoint[];
  /** The base-currency external TWR flows (any day). */
  flowsBase: readonly FlowPoint[];
}

/**
 * Flow instants and the grid step travel TOGETHER (#1120 review): an event is
 * "applied" at its bucket's END (`atMs >= timeMs + stepMs`), exactly as the
 * value curve applies its own steps, so a caller passing events but forgetting
 * the step would silently offset the % curve from the value curve by one
 * bucket at every event. The union makes that unrepresentable.
 *
 * `flowEvents`:
 * In-window external-flow instants, base currency (#1120). With these, a
 * day's flow is neutralised progressively: each point neutralises only the
 * flows applied by its bucket's end (with the value curve stepping at the same
 * instants, a deposit no longer reads as a pre-deposit dip), any event↔day-total
 * residual anchors at the day start, and each day's LAST point neutralises the
 * full day flow — the close still telescopes to the daily TWR exactly. Absent ⇒
 * the whole day's flow anchors at the day boundary (the pre-#1120 behaviour).
 */
export type IntradayPerformanceInput = IntradayPerformanceBase &
  (
    | { flowEvents: readonly IntradayFlowEvent[]; stepMs: number }
    | { flowEvents?: undefined; stepMs?: undefined }
  );

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

  // #1120: flow instants per day + each day's last point (its closing seam,
  // which always neutralises the full day flow).
  const eventsByDay = new Map<string, IntradayFlowEvent[]>();
  for (const event of input.flowEvents ?? []) {
    if (!Number.isFinite(event.atMs) || !Number.isFinite(event.flowEur)) continue;
    const day = new Date(event.atMs).toISOString().slice(0, 10);
    const list = eventsByDay.get(day);
    if (list) list.push(event);
    else eventsByDay.set(day, [event]);
  }
  const lastTimeByDay = new Map<string, number>();
  for (const pt of intradayPoints) {
    // Max, not last-write-wins: the day's closing seam is the one point that
    // must neutralise the FULL day flow, so it cannot depend on the caller
    // having sorted its input (#1120 review).
    lastTimeByDay.set(pt.date, Math.max(lastTimeByDay.get(pt.date) ?? pt.timeMs, pt.timeMs));
  }
  const stepMs = input.stepMs ?? 0;

  const raw: IntradayPerformancePoint[] = intradayPoints.map((pt) => {
    const prevDay = prevDayOf.get(pt.date);
    const prevIndex = prevDay !== undefined ? (indexByDay.get(prevDay) ?? 1) : 1;
    const prevValue = prevDay !== undefined ? (valueByDay.get(prevDay) ?? 0) : 0;
    const dayFlow = flowByDay.get(pt.date) ?? 0;
    let flow = dayFlow;
    const events = eventsByDay.get(pt.date);
    if (events !== undefined && pt.timeMs !== lastTimeByDay.get(pt.date)) {
      // Progressive application: subtract the flows not yet applied by this
      // bucket's end; any residual (FX dust, un-instanted flows) stays at the
      // day start, exactly where the day-boundary convention put everything.
      let unapplied = 0;
      for (const event of events) {
        if (event.atMs >= pt.timeMs + stepMs) unapplied += event.flowEur;
      }
      flow = dayFlow - unapplied;
    }
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
