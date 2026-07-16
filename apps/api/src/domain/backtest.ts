/**
 * Conglomerate backtest engine (PROJECTPLAN.md §6.6).
 *
 * A **pure** function that replays a weighted basket of positions as a
 * buy-and-hold index over a date range and reports its performance. Like the
 * rest of `domain/**` this is money-critical T1 code: it has **no imports of DB,
 * HTTP, or the clock** — price history, the date range, and FX all arrive as
 * parameters, and currency conversion is the injected {@link CurrencyConverter}
 * shared with the holdings core (§5.4). A silent off-by-one, a rounding shortcut,
 * or an un-coalesced FX call here costs real money, so the implementation is
 * deliberate about each:
 *
 *  - **No rounding mid-computation** (§5.4). Every figure is returned at full
 *    `number` precision; display rounding lives in the display layer.
 *  - **Trading-day axis.** The series is built over the *union of the positions'
 *    actual price dates* within the window — i.e. real trading days. Days on
 *    which no asset trades never enter the series, so the √252 annualisation of
 *    volatility stays consistent (~252 points/year) instead of being diluted by
 *    zero-return weekends. Within that axis a single asset that is missing a
 *    given day carries its last close forward (step function, §6.6).
 *  - **FX at the valuation day, coalesced.** Each native close is converted to
 *    the base currency at *that day's* rate; every distinct `(currency, date)`
 *    rate is fetched exactly once via a memoised promise (the request-coalescing
 *    the money path requires). Because conversion is linear, summing
 *    `native · rate` is identical at full precision to converting each asset
 *    individually.
 *
 * **Method (§6.6).**
 *  1. *Common start.* Each position's first-available date is the earliest date
 *     in its price history; the window start is clipped up to the *latest* of
 *     those ("common start") so every asset has data on day t₀. When that clips
 *     the requested start the result carries a notice naming the limiting asset
 *     — `"Limited by TEM (data since 2024-06-14)"`.
 *  2. *Convert + carry forward.* Each series is valued in the base currency at
 *     the day's FX rate, carrying the last close forward over gaps.
 *  3. *Index.* `index(t) = 100 · Σᵢ wᵢ · Pᵢ(t)/Pᵢ(t₀)` where the weights `wᵢ` are
 *     **normalised to sum to 1** (input weights are relative — percentages for a
 *     conglomerate, 100 for a single benchmark — so the index opens at exactly
 *     100). By default this is buy-and-hold of the *initial* weights — no
 *     rebalancing; a {@link RebalanceFrequency} schedule (V4-P7, below) opts
 *     into periodic rebalancing. Adjusted closes ⇒ dividends are included.
 *
 * **Scheduled rebalancing (V4-P7, §16 2026-07-15).** An optional
 * `monthly`/`quarterly`/`yearly` schedule rebalances the portfolio back to its
 * target weights on the **first trading day of each new calendar period** on
 * the series axis — detected as an axis day whose period differs from the
 * previous axis day's, so t₀ never rebalances (the initial allocation already
 * sits at target weights) and a trading gap spanning several boundaries
 * collapses into a single rebalance on the next trading day. The rebalance
 * executes at that day's closes, after any §14 entry events, through the same
 * {@link rebalanceToTargets} primitive the entry days use; it conserves value,
 * so the boundary day's index point is unaffected and the restored weights
 * apply from the next day. Composition with the late-listing modes: in `clip`
 * mode there are no late assets by construction, so the whole basket
 * rebalances to the full target weights; in `cash` mode a not-yet-listed
 * constituent enters the target set only once listed — the schedule rebalances
 * ONLY the invested sleeve to the listed constituents' relative weights while
 * the uninvested pool stays exactly the not-yet-listed weight (0 % return,
 * untouched), and a late constituent still buys in with its full target share
 * at listing; in `redistribute` mode the schedule rebalances to the same
 * *effective* targets as the entry-day rebalance (listed positive-weight
 * constituents absorbing an equal share of unlisted weight), so an entry day
 * coinciding with a boundary is idempotent. Each executed scheduled rebalance
 * is reported in `rebalanceEvents` for chart markers; the schedule never
 * touches the benchmark overlay (a single asset — rebalancing is the
 * identity). With any schedule active the engine runs the event-driven
 * pipeline even in `clip` mode and `contributionPct` becomes the
 * money-weighted segment gain (still summing to the total return);
 * `rebalance: 'none'` (or omitting it) keeps every mode's previous pipeline —
 * `clip` results stay bit-identical to the pre-V4-P7 engine.
 *
 * **Benchmark overlay.** An optional benchmark (`^GSPC`/`^GDAXI`/`URTH`) runs
 * through the *same pipeline* as a single position at weight 100, over the *same
 * date axis* as the main backtest, so the two index series share t₀ and are
 * directly overlayable on one chart. The benchmark always runs the **full**
 * axis — in the late-listing modes below that is the full requested window,
 * idle-cash drag and all (§14: the honest comparison being asked for).
 *
 * **Late-listed constituents (§14).** When a position's history starts after
 * the requested window ("the SpaceX case"), the {@link BacktestMode} decides
 * what happens before its first trading day:
 *
 *  - `clip` (default) — the pre-§14 behavior above: the window is clipped to
 *    the common history and the notice names the limiting asset. This path is
 *    unchanged, so `clip` results are bit-identical to the previous engine.
 *  - `cash` — the window runs from the requested start; a late constituent's
 *    share sits as uninvested cash (0 % return) until its first trading day,
 *    then buys in at the first available close on/after the listing date. The
 *    result reports the mean uninvested share (`idleCashAvgPct`).
 *  - `redistribute` — a late constituent's share is split **equally** among the
 *    already-listed positive-weight constituents (the owner-default rule; a
 *    proportional variant is a possible later option) until its first trading
 *    day; on that day the whole portfolio **rebalances to the target weights**
 *    via the shared {@link rebalanceToTargets} primitive.
 *
 * The rule applies **per late asset independently** — every listing date is its
 * own investment (cash) or rebalance (redistribute) event, reported in
 * `entryEvents` for chart markers. In both non-clip modes the window start is
 * clipped only up to the *earliest* first-available date (before that no
 * constituent existed at all). Entry pricing is the first available close
 * on/after the listing date; FX and (adjusted-close) dividends are unchanged.
 *
 * NOTE(delisting/merger, §14 out of scope): an asset that *stops* trading
 * mid-window is not modelled — its last close simply carries forward to the end
 * of the window in every mode. Revisit once provider metadata can distinguish
 * "no longer listed" from "no data today".
 */

import type { CurrencyConverter, PricePoint } from './holdings';

// Re-exported so callers can type backtest inputs without reaching into holdings.
export type { CurrencyConverter, PricePoint } from './holdings';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * Calendar days per year for the CAGR exponent (ACT/365.25 — averages in the
 * leap day so multi-year annualisation does not drift). CAGR is about elapsed
 * *calendar* time, hence 365.25 here rather than the 252 trading days used to
 * annualise volatility.
 */
const DAYS_PER_YEAR = 365.25;

/** Trading days per year — the √252 scaler for annualised volatility (§6.6). */
const TRADING_DAYS_PER_YEAR = 252;

const DEFAULT_BASE_CURRENCY = 'EUR';

/** Late-listed-constituent modes (§14); see the module header. */
export const BACKTEST_MODES = ['clip', 'cash', 'redistribute'] as const;
export type BacktestMode = (typeof BACKTEST_MODES)[number];

/** Scheduled-rebalance frequencies (V4-P7); see the module header. */
export const REBALANCE_FREQUENCIES = ['none', 'monthly', 'quarterly', 'yearly'] as const;
export type RebalanceFrequency = (typeof REBALANCE_FREQUENCIES)[number];

/**
 * Reserved holding key for the uninvested pool when an entry-day rebalance
 * absorbs cash (the degenerate "no positive-weight constituent listed yet"
 * phase). Contains a NUL byte so it can never collide with a real asset id.
 */
const CASH_KEY = '\u0000cash';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A backtest that cannot be computed from the supplied data (no overlapping
 * price history in the window, a missing benchmark base price, a non-positive
 * base value, an invalid FX rate). A typed error so the API can map it to a 422
 * rather than a 500. Programming errors (bad weights, unknown asset, malformed
 * dates) throw plain `Error` instead — they are caller bugs, not data states.
 */
export class BacktestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BacktestError';
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A single basket member: which asset, and its relative weight (see
 * {@link backtest}). A zero-weight position contributes nothing to the index
 * but still participates in common-start clipping and the trading-day axis —
 * §6.6 clips "across positions" without qualification.
 */
export interface BacktestPosition {
  assetId: string;
  /** Relative weight; non-negative. Normalised across the basket so the index opens at 100. */
  weight: number;
}

/** Per-asset market data: identity plus its daily adjusted closes (native currency). */
export interface BacktestAsset {
  assetId: string;
  /** Ticker symbol, used in the clipping notice (`"Limited by TEM …"`). */
  symbol: string;
  /** ISO-4217 native currency of the asset. */
  currency: string;
  /** Daily adjusted closes, native currency, any order. Carried forward over gaps. */
  prices: readonly PricePoint[];
}

/** Inclusive requested window, ISO `YYYY-MM-DD`. The start may be clipped (see §6.6). */
export interface BacktestRange {
  start: string;
  end: string;
}

export interface BacktestInput {
  /** Basket members; at least one. */
  positions: readonly BacktestPosition[];
  /**
   * Market data for every position asset; a position referencing a missing
   * asset throws. (The benchmark carries its own prices via {@link benchmark}
   * and does not need an entry here.)
   */
  assets: readonly BacktestAsset[];
  /** Requested window; the start is clipped up to the common start. */
  range: BacktestRange;
  /** Historical-rate currency conversion into the base currency (§5.4), injected. */
  converter: CurrencyConverter;
  /** Base currency; defaults to EUR but is a parameter throughout (§5.4). */
  baseCurrency?: string;
  /** Optional overlay run through the same pipeline at weight 100, over the same axis. */
  benchmark?: BacktestAsset | null;
  /** Late-listed-constituent mode (§14, module header). Defaults to `clip`. */
  mode?: BacktestMode;
  /** Rebalance schedule (V4-P7, module header). Defaults to `none` (buy-and-hold). */
  rebalance?: RebalanceFrequency;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** One point on a base-100 index series. */
export interface SeriesPoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Index level (opens at 100 on t₀). */
  value: number;
}

/** A single day's index return, in percent, tagged with its (later) date. */
export interface DayReturn {
  date: string;
  returnPct: number;
}

/**
 * One position's share of the total return (§6.6). `contributionPct` figures
 * across the basket **sum exactly to `stats.totalReturnPct`** — it is the
 * weighted single-asset return `weight · returnPct`.
 */
export interface PositionContribution {
  assetId: string;
  symbol: string;
  /** Normalised weight (fraction of the basket; the basket sums to 1). */
  weight: number;
  /** The asset's own base-currency return over the window, in percent. */
  returnPct: number;
  /** `weight · returnPct`; these sum to the basket's total return. */
  contributionPct: number;
}

/** The performance statistics for an index series (§6.6). */
export interface BacktestStats {
  /** `(index(end)/index(t₀) − 1) · 100`. */
  totalReturnPct: number;
  /** Compound annual growth rate (%), ACT/365.25; `null` for a single-day window. */
  cagrPct: number | null;
  /** Largest peak-to-trough decline (%), `≤ 0`; `0` when the series only rises. */
  maxDrawdownPct: number;
  /** Annualised volatility: sample σ of daily returns × √252, in percent; `null` with < 2 returns. */
  volatilityPct: number | null;
  /** Best single-day return; `null` when there are no returns. */
  bestDay: DayReturn | null;
  /** Worst single-day return; `null` when there are no returns. */
  worstDay: DayReturn | null;
}

/** The benchmark overlay: its own base-100 series and stats, on the main axis. */
export interface BenchmarkResult {
  assetId: string;
  symbol: string;
  series: SeriesPoint[];
  stats: BacktestStats;
}

/**
 * A late constituent's entry into the running portfolio (§14): the trading day
 * of its first available close on/after its listing date — an investment event
 * in `cash` mode, a rebalance event in `redistribute` mode. Never emitted in
 * `clip` mode (the clipped window has no late assets by construction).
 */
export interface BacktestEntryEvent {
  assetId: string;
  symbol: string;
  /** ISO `YYYY-MM-DD` — the entry trading day (always on the series axis). */
  date: string;
}

/**
 * One executed scheduled rebalance (V4-P7): the first trading day of a new
 * calendar period, on which the portfolio was reset to its target weights at
 * that day's closes. Emitted even when the reset is mathematically a no-op
 * (e.g. a single-asset basket) — the schedule ran; NOT emitted when there was
 * nothing to allocate to (no listed positive-weight constituent). Always empty
 * when the frequency is `none`.
 */
export interface BacktestRebalanceEvent {
  /** ISO `YYYY-MM-DD` — the rebalance trading day (always on the series axis). */
  date: string;
}

export interface BacktestResult {
  /** t₀ — the effective (possibly clipped) first day of the series. */
  startDate: string;
  /** The last day of the series. */
  endDate: string;
  /** The base-100 index series. */
  series: SeriesPoint[];
  /** Performance statistics. */
  stats: BacktestStats;
  /** Per-position attribution; `contributionPct` sums to `stats.totalReturnPct`. */
  contributions: PositionContribution[];
  /** Clipping notice when the start was limited, else `null`. */
  notice: string | null;
  /** The benchmark overlay, or `null` when none was requested. */
  benchmark: BenchmarkResult | null;
  /** The late-listing mode this result was computed under (§14). */
  mode: BacktestMode;
  /** The rebalance schedule this result was computed under (V4-P7). */
  rebalance: RebalanceFrequency;
  /** One event per late constituent, ascending by date; `[]` in `clip` mode. */
  entryEvents: BacktestEntryEvent[];
  /** One event per executed scheduled rebalance, ascending; `[]` for `none`. */
  rebalanceEvents: BacktestRebalanceEvent[];
  /**
   * `cash` mode only: mean share of the portfolio value sitting uninvested
   * across the axis days, in percent; `null` in the other modes.
   */
  idleCashAvgPct: number | null;
}

// ---------------------------------------------------------------------------
// Date / validation helpers
// ---------------------------------------------------------------------------

function assertIsoDate(date: string, label: string): void {
  if (!ISO_DATE.test(date)) {
    throw new Error(`${label} must be ISO YYYY-MM-DD, got ${date}`);
  }
}

/** UTC midnight epoch-ms of an ISO date (no clock read; deterministic). */
function dateToMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * The calendar period an ISO date falls into for a rebalance schedule (V4-P7):
 * `YYYY-MM` for monthly, `YYYY-Qn` for quarterly (calendar quarters), `YYYY`
 * for yearly. Two consecutive axis days with different keys mark the later one
 * as a rebalance day — the first trading day of the new period.
 */
function periodKey(date: string, frequency: Exclude<RebalanceFrequency, 'none'>): string {
  switch (frequency) {
    case 'monthly':
      return date.slice(0, 7);
    case 'quarterly':
      return `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
    case 'yearly':
      return date.slice(0, 4);
  }
}

/**
 * Validate a price series up front — every date ISO, every close finite — then
 * return a stable ascending copy. Validation must not live in the sort
 * comparator: a comparator never runs for 0/1-element arrays, so a lone
 * malformed point would slip through and silently mis-value the series (the
 * same fail-loud contract as `holdings.valueOverTime`). Finiteness is checked
 * for *every* close, not just t₀ — a NaN or Infinity mid-series would otherwise
 * flow straight into the index and every statistic derived from it.
 */
function sortPrices(prices: readonly PricePoint[], symbol: string): PricePoint[] {
  for (const point of prices) {
    assertIsoDate(point.date, `price date for ${symbol}`);
    if (!Number.isFinite(point.close)) {
      throw new Error(
        `Price point for ${symbol} on ${point.date} must be a finite close, got ${point.close}`,
      );
    }
  }
  return [...prices].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Rebalance primitive (§14 — shared with future scheduled rebalancing)
// ---------------------------------------------------------------------------

/** One holding as the rebalance primitive sees it: a key and its current value. */
export interface RebalanceHolding {
  /** Identifies the holding (an asset id in the engine). */
  key: string;
  /** Current value in any single common unit (base currency, index units, …). */
  value: number;
}

/** A relative target weight; normalised across the target set. */
export interface RebalanceTarget {
  key: string;
  /** Relative weight; non-negative, finite. The set must sum to a positive number. */
  weight: number;
}

/**
 * Rebalance a portfolio to target weights: value the current holdings, then
 * reallocate the **total** across the targets in proportion to their
 * (normalised) weights. Pure value-space math — pricing the holdings and
 * turning values back into units is the caller's job.
 *
 * This is the §14 rebalance primitive: an entry-day rebalance is
 * `rebalanceToTargets(currentValues, effectiveTargetWeights)` at the entry
 * day's closes, and *scheduled* rebalancing (V4-P7) is the same call on each
 * period boundary — one primitive, no duplicated rebalance math.
 *
 * Semantics:
 *  - The result has exactly one holding per **target** key, in target order,
 *    each worth `normalisedWeight · totalValue`.
 *  - A holding key absent from the targets is liquidated into the pool (that is
 *    how the engine's waiting cash flows into the basket on an entry day).
 *  - A target key absent from the holdings enters at value 0 and receives its
 *    full target share (the entry case).
 *  - The total value is conserved at full precision up to floating-point
 *    association (Σ out ≡ Σ in · Σᵢ wᵢ/Σw); there is no rounding.
 *
 * Throws a plain `Error` for caller bugs: duplicate keys, non-finite or
 * negative values (shorts are not modelled), non-finite or negative weights, or
 * targets that do not sum to a positive weight. A zero **total value** is legal
 * and yields all-zero holdings.
 */
export function rebalanceToTargets(
  holdings: readonly RebalanceHolding[],
  targets: readonly RebalanceTarget[],
): RebalanceHolding[] {
  const seenHoldings = new Set<string>();
  let total = 0;
  for (const h of holdings) {
    if (seenHoldings.has(h.key)) {
      throw new Error(`rebalanceToTargets: duplicate holding key ${JSON.stringify(h.key)}.`);
    }
    seenHoldings.add(h.key);
    if (!Number.isFinite(h.value) || h.value < 0) {
      throw new Error(
        `rebalanceToTargets: holding ${JSON.stringify(h.key)} must have a finite non-negative value, got ${h.value}.`,
      );
    }
    total += h.value;
  }

  const seenTargets = new Set<string>();
  let totalWeight = 0;
  for (const t of targets) {
    if (seenTargets.has(t.key)) {
      throw new Error(`rebalanceToTargets: duplicate target key ${JSON.stringify(t.key)}.`);
    }
    seenTargets.add(t.key);
    if (!Number.isFinite(t.weight) || t.weight < 0) {
      throw new Error(
        `rebalanceToTargets: target ${JSON.stringify(t.key)} must have a finite non-negative weight, got ${t.weight}.`,
      );
    }
    totalWeight += t.weight;
  }
  if (!(totalWeight > 0)) {
    throw new Error(
      `rebalanceToTargets: target weights must sum to a positive number, got ${totalWeight}.`,
    );
  }

  return targets.map((t) => ({ key: t.key, value: (t.weight / totalWeight) * total }));
}

// ---------------------------------------------------------------------------
// Core pipeline (shared by the basket and the benchmark)
// ---------------------------------------------------------------------------

/** An asset prepared for the pipeline: pre-sorted prices and a normalised weight. */
interface PreparedAsset {
  assetId: string;
  symbol: string;
  currency: string;
  /** Ascending by date. */
  prices: PricePoint[];
  /** Normalised weight (the basket's weights sum to 1). */
  weight: number;
}

/** What the core returns: the index series plus, per asset, the data attribution needs. */
interface PipelineResult {
  series: SeriesPoint[];
  perAsset: Array<{
    assetId: string;
    symbol: string;
    weight: number;
    /** Pᵢ(end)/Pᵢ(t₀) in base currency. */
    ratioEnd: number;
  }>;
}

/** Resolves a `(currency, date) → base` rate, fetching each distinct pair at most once. */
type RateResolver = (currency: string, date: string) => Promise<number>;

/**
 * Walk the date `axis` once, valuing every asset in the base currency (FX at the
 * day, last close carried forward) and accumulating the base-100 index. Returns
 * the series and each asset's end/start ratio for attribution.
 *
 * Throws {@link BacktestError} if an asset has no price on or before t₀ (its base
 * value is undefined) or if a base value is non-positive (the ratio is undefined)
 * — the latter cannot arise from real adjusted closes but is guarded rather than
 * silently producing `Infinity`/`NaN` on the money path.
 */
async function runPipeline(
  assets: PreparedAsset[],
  axis: string[],
  getRate: RateResolver,
): Promise<PipelineResult> {
  interface Cursor {
    asset: PreparedAsset;
    idx: number;
    lastClose: number | null;
    baseEur: number;
    lastEur: number;
  }
  const cursors: Cursor[] = assets.map((asset) => ({
    asset,
    idx: 0,
    lastClose: null,
    baseEur: 0,
    lastEur: 0,
  }));

  const series: SeriesPoint[] = [];

  for (let i = 0; i < axis.length; i += 1) {
    const day = axis[i];
    if (day === undefined) continue; // unreachable: i < axis.length
    let indexValue = 0;

    for (const c of cursors) {
      // Carry forward: advance to the latest close on or before `day`.
      while (c.idx < c.asset.prices.length) {
        const point = c.asset.prices[c.idx];
        if (point === undefined || point.date > day) break;
        c.lastClose = point.close;
        c.idx += 1;
      }
      if (c.lastClose === null) {
        // Only reachable for a benchmark whose history starts after t₀.
        throw new BacktestError(
          `${c.asset.symbol} has no price data on or before the backtest start ${day}.`,
        );
      }

      const rate = await getRate(c.asset.currency, day);
      const eur = c.lastClose * rate;

      if (i === 0) {
        if (!(eur > 0)) {
          throw new BacktestError(
            `${c.asset.symbol} has a non-positive base value (${eur}) on ${day}; cannot index.`,
          );
        }
        c.baseEur = eur;
      }
      c.lastEur = eur;
      indexValue += c.asset.weight * (eur / c.baseEur);
    }

    series.push({ date: day, value: 100 * indexValue });
  }

  const perAsset = cursors.map((c) => ({
    assetId: c.asset.assetId,
    symbol: c.asset.symbol,
    weight: c.asset.weight,
    ratioEnd: c.lastEur / c.baseEur,
  }));

  return { series, perAsset };
}

// ---------------------------------------------------------------------------
// Event-driven pipeline (§14 late-listing modes + V4-P7 scheduled rebalancing)
// ---------------------------------------------------------------------------

/** A prepared asset plus its absolute first price date — its listing day. */
interface LateModeAsset extends PreparedAsset {
  firstAvailable: string;
}

/** What the event pipeline returns (a superset of {@link PipelineResult}). */
interface EventPipelineResult {
  series: SeriesPoint[];
  perAsset: Array<{
    assetId: string;
    symbol: string;
    weight: number;
    /** Own base-currency price ratio over the invested period; 1 when never invested. */
    ratioEnd: number;
    /** Money-weighted gain in index units; the gains sum to `index(end)/100 − 1`. */
    gain: number;
  }>;
  entryEvents: BacktestEntryEvent[];
  rebalanceEvents: BacktestRebalanceEvent[];
  /** Mean uninvested share across axis days, percent (`cash` mode), else `null`. */
  idleCashAvgPct: number | null;
}

/**
 * Walk the date `axis` once for the §14 `cash` / `redistribute` modes and for
 * any V4-P7 rebalance schedule (which routes `clip` through here too — with the
 * clipped window every asset is listed at t₀, so no entry events arise). Like
 * {@link runPipeline} it values every asset in the base currency (FX at the
 * day, last close carried forward), but the portfolio is event-driven: an asset
 * whose history starts after t₀ waits (as cash, or redistributed into the
 * listed constituents) and **enters** on its first trading day — an investment
 * event in `cash` mode, a full rebalance to the effective target weights (via
 * {@link rebalanceToTargets}) in `redistribute` mode — and each schedule
 * boundary rebalances back to the target weights via the same primitive.
 * Values are tracked in index units (the t₀ portfolio ≡ 1), segment-wise
 * between events, so per-asset money-weighted gains sum exactly to the index
 * return.
 *
 * Throws {@link BacktestError} when an asset's entry close is non-positive (its
 * ratio would be undefined) — the same guard {@link runPipeline} applies at t₀.
 */
async function runEventPipeline(
  assets: LateModeAsset[],
  axis: string[],
  getRate: RateResolver,
  mode: BacktestMode,
  rebalance: RebalanceFrequency,
): Promise<EventPipelineResult> {
  interface Cursor {
    asset: LateModeAsset;
    idx: number;
    lastClose: number | null;
    /** Today's base-currency price; meaningful once `lastClose` is set. */
    eur: number;
    /** Whether the asset has entered the running portfolio. */
    entered: boolean;
    /** Base-currency price at entry — the own-return denominator. */
    entryEur: number;
    /** Base-currency price at the current segment start (the last (re)allocation). */
    segBaseEur: number;
    /** Value (index units) at the current segment start. */
    segBaseValue: number;
    /** Current value in index units. */
    value: number;
    /** Gain (index units) accumulated over closed segments. */
    gain: number;
  }

  const cursors: Cursor[] = assets.map((asset) => ({
    asset,
    idx: 0,
    lastClose: null,
    eur: 0,
    entered: false,
    entryEur: 0,
    segBaseEur: 0,
    segBaseValue: 0,
    value: 0,
    gain: 0,
  }));

  const series: SeriesPoint[] = [];
  const entryEvents: BacktestEntryEvent[] = [];
  const rebalanceEvents: BacktestRebalanceEvent[] = [];
  // The uninvested pool, in index units. `cash` mode recomputes it each day
  // from the not-yet-entered weights (exact — no FP drift from += / −=);
  // `redistribute` mode starts all-cash and empties the pool into the basket at
  // the first rebalance that has a positive-weight constituent to allocate to
  // (normally day one; later only in the degenerate all-late case). `clip`
  // (only routed here with a schedule) has every asset listed at t₀ — the pool
  // stays 0 throughout.
  let cash = mode === 'redistribute' ? 1 : 0;
  let cashFractionSum = 0;

  /**
   * Redistribute-mode effective targets: every listed positive-weight
   * constituent absorbs an **equal** share of all not-yet-listed weight (§14,
   * the owner-default rule). `null` while no positive-weight constituent is
   * listed — the portfolio then stays cash (degenerate, unreachable through the
   * API, which rejects zero weights).
   */
  function redistributeTargets(): RebalanceTarget[] | null {
    const listedPositive = cursors.filter((c) => c.entered && c.asset.weight > 0);
    if (listedPositive.length === 0) return null;
    let missing = 0;
    for (const c of cursors) {
      if (!c.entered) missing += c.asset.weight;
    }
    const share = missing / listedPositive.length;
    return listedPositive.map((c) => ({ key: c.asset.assetId, weight: c.asset.weight + share }));
  }

  /**
   * Scheduled-rebalance targets in `clip`/`cash` mode: every LISTED constituent
   * at its own target weight — a not-yet-listed constituent enters the target
   * set only once listed (§16, V4-P7), its share keeps waiting as the untouched
   * uninvested pool. `null` while no listed constituent has positive weight
   * (degenerate, unreachable through the API which rejects zero weights) —
   * nothing to allocate to, so no rebalance and no event.
   */
  function scheduledTargets(): RebalanceTarget[] | null {
    if (mode === 'redistribute') return redistributeTargets();
    const listed = cursors.filter((c) => c.entered);
    if (!listed.some((c) => c.asset.weight > 0)) return null;
    return listed.map((c) => ({ key: c.asset.assetId, weight: c.asset.weight }));
  }

  /**
   * Rebalance every invested holding to `targets` at today's closes via the
   * shared §14 primitive: close the running segments (accumulating each
   * asset's money-weighted gain), reallocate, and open new segments at today's
   * prices. The one call both entry days and schedule boundaries go through.
   * In `redistribute` mode a still-uninvested pool joins the reallocation
   * (the degenerate all-late start); in `cash` mode the pool never does — it
   * belongs to the not-yet-listed constituents.
   */
  function rebalanceHoldings(targets: RebalanceTarget[]): void {
    for (const c of cursors) {
      if (c.entered) c.gain += c.value - c.segBaseValue;
    }
    const pool: RebalanceHolding[] = cursors
      .filter((c) => c.entered)
      .map((c) => ({ key: c.asset.assetId, value: c.value }));
    if (mode === 'redistribute' && cash > 0) pool.push({ key: CASH_KEY, value: cash });
    const rebalanced = new Map(rebalanceToTargets(pool, targets).map((h) => [h.key, h.value]));
    for (const c of cursors) {
      if (!c.entered) continue;
      const value = rebalanced.get(c.asset.assetId) ?? 0;
      c.value = value;
      c.segBaseValue = value;
      c.segBaseEur = c.eur;
    }
    if (mode === 'redistribute') cash = 0;
  }

  for (let i = 0; i < axis.length; i += 1) {
    const day = axis[i];
    if (day === undefined) continue; // unreachable: i < axis.length

    // 1. Advance cursors; value every listed asset at today's FX; collect the
    //    assets entering today (day 0 "enters" the initial constituents).
    const entering: Cursor[] = [];
    for (const c of cursors) {
      while (c.idx < c.asset.prices.length) {
        const point = c.asset.prices[c.idx];
        if (point === undefined || point.date > day) break;
        c.lastClose = point.close;
        c.idx += 1;
      }
      if (c.lastClose === null) continue; // not yet listed — waits as cash / stays redistributed
      const rate = await getRate(c.asset.currency, day);
      c.eur = c.lastClose * rate;
      if (c.entered) {
        // Carry the segment: revalue the held position at today's price.
        c.value = c.segBaseValue * (c.eur / c.segBaseEur);
      } else {
        entering.push(c);
      }
    }

    // 2. Entries. Day 0 is the initial allocation; every later batch is a §14
    //    entry event, one per late asset independently.
    if (entering.length > 0) {
      for (const c of entering) {
        if (!(c.eur > 0)) {
          throw new BacktestError(
            `${c.asset.symbol} has a non-positive base value (${c.eur}) on ${day}; cannot index.`,
          );
        }
        c.entered = true;
        c.entryEur = c.eur;
        c.segBaseEur = c.eur;
        if (i > 0) {
          entryEvents.push({ assetId: c.asset.assetId, symbol: c.asset.symbol, date: day });
        }
      }

      if (mode !== 'redistribute') {
        // `cash` (and `clip` day 0): each share converts its waiting cash into
        // the position at today's close — the entry itself does not move the
        // index. (A just-entered cursor's segment is zero-length, so the
        // helper's segment-close below is a no-op for it.)
        for (const c of entering) {
          c.value = c.asset.weight;
          c.segBaseValue = c.asset.weight;
        }
      } else {
        // Redistribute: rebalance the whole portfolio (running positions + any
        // cash pool) to the effective target weights via the shared primitive.
        const targets = redistributeTargets();
        if (targets !== null) rebalanceHoldings(targets);
      }
    }

    // 2b. Scheduled rebalance (V4-P7): the first trading day of a new calendar
    //     period resets the portfolio to its target weights at today's closes,
    //     after any entries (an asset listing on the boundary day joins the
    //     reset). Value is conserved, so today's index point is unaffected —
    //     the restored weights apply from the next day. See the module header
    //     for the per-mode target semantics (§16, 2026-07-15).
    if (rebalance !== 'none' && i > 0) {
      const prevDay = axis[i - 1];
      if (prevDay !== undefined && periodKey(day, rebalance) !== periodKey(prevDay, rebalance)) {
        const targets = scheduledTargets();
        if (targets !== null) {
          rebalanceHoldings(targets);
          rebalanceEvents.push({ date: day });
        }
      }
    }

    if (mode === 'cash') {
      // Exact by construction: the pool is the not-yet-entered target weight.
      cash = 0;
      for (const c of cursors) {
        if (!c.entered) cash += c.asset.weight;
      }
    }

    // 3. The day's index level (a rebalance conserves value, so the point is
    //    the same seen pre- or post-event).
    let total = cash;
    for (const c of cursors) {
      if (c.entered) total += c.value;
    }
    series.push({ date: day, value: 100 * total });
    // total ≥ cash, so a zero total implies zero cash — count that as fully
    // invested rather than dividing 0/0.
    if (mode === 'cash') cashFractionSum += total > 0 ? cash / total : 0;
  }

  // Close the final segment of every invested asset.
  for (const c of cursors) {
    if (c.entered) c.gain += c.value - c.segBaseValue;
  }

  const perAsset = cursors.map((c) => ({
    assetId: c.asset.assetId,
    symbol: c.asset.symbol,
    weight: c.asset.weight,
    ratioEnd: c.entered ? c.eur / c.entryEur : 1,
    gain: c.gain,
  }));

  return {
    series,
    perAsset,
    entryEvents,
    rebalanceEvents,
    idleCashAvgPct: mode === 'cash' ? (cashFractionSum / axis.length) * 100 : null,
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Performance statistics for a base-100 index series (§6.6). Degenerate windows
 * are handled explicitly: a single-day series has no return (`totalReturn 0`,
 * everything annualised `null`), and volatility needs ≥ 2 daily returns for the
 * sample (n−1) standard deviation to be defined.
 */
function computeStats(series: SeriesPoint[]): BacktestStats {
  const first = series[0];
  const last = series[series.length - 1];
  if (first === undefined || last === undefined) {
    // Unreachable: the axis is non-empty by the time stats run.
    throw new BacktestError('Cannot compute statistics for an empty series.');
  }

  const totalReturnPct = (last.value / first.value - 1) * 100;

  const years = (dateToMs(last.date) - dateToMs(first.date)) / (MS_PER_DAY * DAYS_PER_YEAR);
  const cagrPct = years > 0 ? (Math.pow(last.value / first.value, 1 / years) - 1) * 100 : null;

  // Single sweep: running peak for drawdown, consecutive ratios for returns.
  let peak = first.value;
  let maxDd = 0;
  const returns: DayReturn[] = [];
  for (let i = 0; i < series.length; i += 1) {
    const pt = series[i];
    if (pt === undefined) continue; // unreachable
    if (pt.value > peak) peak = pt.value;
    const dd = pt.value / peak - 1;
    if (dd < maxDd) maxDd = dd;
    if (i > 0) {
      const prev = series[i - 1];
      if (prev !== undefined) {
        returns.push({ date: pt.date, returnPct: (pt.value / prev.value - 1) * 100 });
      }
    }
  }
  const maxDrawdownPct = maxDd * 100;

  let bestDay: DayReturn | null = null;
  let worstDay: DayReturn | null = null;
  for (const r of returns) {
    if (bestDay === null || r.returnPct > bestDay.returnPct) bestDay = r;
    if (worstDay === null || r.returnPct < worstDay.returnPct) worstDay = r;
  }

  let volatilityPct: number | null = null;
  if (returns.length >= 2) {
    // Sample standard deviation (Bessel-corrected, n−1) of the daily returns,
    // annualised by √252. Returns are taken in fractional form so the result is
    // a clean percentage.
    const rs = returns.map((r) => r.returnPct / 100);
    const mean = rs.reduce((s, x) => s + x, 0) / rs.length;
    const variance = rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (rs.length - 1);
    volatilityPct = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
  }

  return {
    totalReturnPct,
    cagrPct,
    maxDrawdownPct,
    volatilityPct,
    bestDay: bestDay === null ? null : { ...bestDay },
    worstDay: worstDay === null ? null : { ...worstDay },
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run a buy-and-hold backtest of a weighted basket over a date range (§6.6).
 *
 * See the module header for the method, purity guarantees, and the trading-day /
 * FX-coalescing decisions. Throws a plain `Error` for caller bugs (no positions,
 * unknown asset, malformed dates, bad weights) and {@link BacktestError} for data
 * states that make a backtest impossible (no overlapping history in the window).
 */
export async function backtest(input: BacktestInput): Promise<BacktestResult> {
  const { positions, range, converter } = input;
  const baseCurrency = input.baseCurrency ?? DEFAULT_BASE_CURRENCY;
  const mode: BacktestMode = input.mode ?? 'clip';
  if (!BACKTEST_MODES.includes(mode)) {
    throw new Error(`backtest: unknown mode ${JSON.stringify(mode)}.`);
  }
  const rebalance: RebalanceFrequency = input.rebalance ?? 'none';
  if (!REBALANCE_FREQUENCIES.includes(rebalance)) {
    throw new Error(`backtest: unknown rebalance frequency ${JSON.stringify(rebalance)}.`);
  }

  if (positions.length === 0) {
    throw new Error('backtest requires at least one position.');
  }
  assertIsoDate(range.start, 'range.start');
  assertIsoDate(range.end, 'range.end');
  if (range.start > range.end) {
    throw new Error(`range.start (${range.start}) must not be after range.end (${range.end}).`);
  }

  const assetMap = new Map<string, BacktestAsset>();
  for (const a of input.assets) assetMap.set(a.assetId, a);

  // Prepare each position: validate, sort prices, and find its first-available date.
  interface Prepared {
    assetId: string;
    symbol: string;
    currency: string;
    prices: PricePoint[];
    firstAvailable: string;
    weight: number;
  }
  const prepared: Prepared[] = [];
  let totalWeight = 0;
  for (const pos of positions) {
    if (!Number.isFinite(pos.weight) || pos.weight < 0) {
      throw new Error(
        `Position weight for ${pos.assetId} must be a finite non-negative number, got ${pos.weight}.`,
      );
    }
    totalWeight += pos.weight;

    const asset = assetMap.get(pos.assetId);
    if (asset === undefined) {
      throw new Error(`backtest: position references asset ${pos.assetId} with no market data.`);
    }
    const prices = sortPrices(asset.prices, asset.symbol);
    const firstPoint = prices[0];
    if (firstPoint === undefined) {
      throw new Error(`backtest: asset ${asset.symbol} (${pos.assetId}) has no price history.`);
    }
    prepared.push({
      assetId: pos.assetId,
      symbol: asset.symbol,
      currency: asset.currency,
      prices,
      firstAvailable: firstPoint.date,
      weight: pos.weight,
    });
  }

  if (!(totalWeight > 0)) {
    throw new Error(
      `backtest: position weights must sum to a positive number, got ${totalWeight}.`,
    );
  }

  let effectiveStart: string;
  let notice: string | null;
  if (mode === 'clip') {
    // Common start: the latest first-available date across positions (strict `>`
    // so the earliest-listed asset wins ties — deterministic notice).
    let commonStart = prepared[0]?.firstAvailable ?? range.start;
    let limiting = prepared[0];
    for (const p of prepared) {
      if (p.firstAvailable > commonStart) {
        commonStart = p.firstAvailable;
        limiting = p;
      }
    }

    const clipped = commonStart > range.start;
    effectiveStart = clipped ? commonStart : range.start;
    notice =
      clipped && limiting !== undefined
        ? `Limited by ${limiting.symbol} (data since ${commonStart})`
        : null;

    if (effectiveStart > range.end) {
      throw new BacktestError(
        `No price data in the requested range: common start ${commonStart} is after range end ${range.end}.`,
      );
    }
  } else {
    // §14 full-window modes run from the requested start, clipped only up to
    // the EARLIEST first-available date — before it no constituent existed at
    // all (strict `<` so the first position wins ties — deterministic notice).
    let dataStart = prepared[0]?.firstAvailable ?? range.start;
    let earliest = prepared[0];
    for (const p of prepared) {
      if (p.firstAvailable < dataStart) {
        dataStart = p.firstAvailable;
        earliest = p;
      }
    }

    const clipped = dataStart > range.start;
    effectiveStart = clipped ? dataStart : range.start;
    notice =
      clipped && earliest !== undefined
        ? `Limited by ${earliest.symbol} (data since ${dataStart})`
        : null;

    if (effectiveStart > range.end) {
      throw new BacktestError(
        `No price data in the requested range: first listing ${dataStart} is after range end ${range.end}.`,
      );
    }
  }

  // Trading-day axis: the sorted, de-duplicated union of every position's price
  // dates that fall within [effectiveStart, range.end].
  const dateSet = new Set<string>();
  for (const p of prepared) {
    for (const point of p.prices) {
      if (point.date >= effectiveStart && point.date <= range.end) dateSet.add(point.date);
    }
  }
  const axis = [...dateSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (axis.length === 0) {
    throw new BacktestError(
      `No price data in the requested range [${effectiveStart}, ${range.end}].`,
    );
  }

  // Shared FX resolver: each distinct (currency, day) rate fetched exactly once.
  const rateCache = new Map<string, Promise<number>>();
  const getRate: RateResolver = async (currency, date) => {
    const key = `${currency}|${date}`;
    let pending = rateCache.get(key);
    if (pending === undefined) {
      pending = converter.toBase(1, currency, { date, base: baseCurrency });
      rateCache.set(key, pending);
    }
    const rate = await pending;
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new BacktestError(`Invalid FX rate ${rate} for ${currency} on ${date}.`);
    }
    return rate;
  };

  // Normalise weights so the index opens at exactly 100.
  const basket: LateModeAsset[] = prepared.map((p) => ({
    assetId: p.assetId,
    symbol: p.symbol,
    currency: p.currency,
    prices: p.prices,
    weight: p.weight / totalWeight,
    firstAvailable: p.firstAvailable,
  }));

  let series: SeriesPoint[];
  let contributions: PositionContribution[];
  let entryEvents: BacktestEntryEvent[];
  let rebalanceEvents: BacktestRebalanceEvent[];
  let idleCashAvgPct: number | null;

  if (mode === 'clip' && rebalance === 'none') {
    // The pre-§14 buy-and-hold pipeline, untouched: schedule-less `clip`
    // results stay bit-identical to the previous engine.
    const pipeline = await runPipeline(basket, axis, getRate);
    series = pipeline.series;

    // Per-position attribution: weight · (ratioEnd − 1) · 100. These sum exactly to
    // stats.totalReturnPct (Σ wᵢ = 1 ⇒ Σ contributions = index(end) − 100).
    contributions = pipeline.perAsset.map((a) => {
      const returnPct = (a.ratioEnd - 1) * 100;
      return {
        assetId: a.assetId,
        symbol: a.symbol,
        weight: a.weight,
        returnPct,
        contributionPct: a.weight * returnPct,
      };
    });
    entryEvents = [];
    rebalanceEvents = [];
    idleCashAvgPct = null;
  } else {
    const pipeline = await runEventPipeline(basket, axis, getRate, mode, rebalance);
    series = pipeline.series;

    // Per-position attribution on the event-driven path: `returnPct` stays the
    // asset's own price return over its invested period, while `contributionPct`
    // is the money-weighted segment gain — in schedule-less `cash` mode that
    // equals weight · returnPct; in `redistribute` mode, and in every mode with
    // a rebalance schedule active, it additionally carries the temporarily
    // re-allocated capital. All variants still sum to stats.totalReturnPct.
    contributions = pipeline.perAsset.map((a) => ({
      assetId: a.assetId,
      symbol: a.symbol,
      weight: a.weight,
      returnPct: (a.ratioEnd - 1) * 100,
      contributionPct: a.gain * 100,
    }));
    entryEvents = pipeline.entryEvents;
    rebalanceEvents = pipeline.rebalanceEvents;
    idleCashAvgPct = pipeline.idleCashAvgPct;
  }

  const stats = computeStats(series);

  // Benchmark overlay: a single position at weight 100 (→ 1 normalised) run
  // through the same pipeline over the same axis, so both series share t₀.
  let benchmark: BenchmarkResult | null = null;
  if (input.benchmark) {
    const b = input.benchmark;
    const benchPrices = sortPrices(b.prices, b.symbol);
    if (benchPrices.length === 0) {
      throw new Error(`backtest: benchmark ${b.symbol} (${b.assetId}) has no price history.`);
    }
    const benchPipeline = await runPipeline(
      [
        {
          assetId: b.assetId,
          symbol: b.symbol,
          currency: b.currency,
          prices: benchPrices,
          weight: 1,
        },
      ],
      axis,
      getRate,
    );
    benchmark = {
      assetId: b.assetId,
      symbol: b.symbol,
      series: benchPipeline.series,
      stats: computeStats(benchPipeline.series),
    };
  }

  const lastDate = axis[axis.length - 1];

  return {
    startDate: axis[0] ?? effectiveStart,
    endDate: lastDate ?? range.end,
    series,
    stats,
    contributions,
    notice,
    benchmark,
    mode,
    rebalance,
    entryEvents,
    rebalanceEvents,
    idleCashAvgPct,
  };
}
