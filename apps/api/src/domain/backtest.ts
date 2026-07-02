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
 *     100). This is buy-and-hold of the *initial* weights: there is **no
 *     rebalancing** (a documented limitation; rebalanced mode is a Future
 *     Feature). Adjusted closes ⇒ dividends are already included.
 *
 * **Benchmark overlay.** An optional benchmark (`^GSPC`/`^GDAXI`/`URTH`) runs
 * through the *same pipeline* as a single position at weight 100, over the *same
 * date axis* as the main backtest, so the two index series share t₀ and are
 * directly overlayable on one chart.
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
  const effectiveStart = clipped ? commonStart : range.start;
  const notice =
    clipped && limiting !== undefined
      ? `Limited by ${limiting.symbol} (data since ${commonStart})`
      : null;

  if (effectiveStart > range.end) {
    throw new BacktestError(
      `No price data in the requested range: common start ${commonStart} is after range end ${range.end}.`,
    );
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
  const basket: PreparedAsset[] = prepared.map((p) => ({
    assetId: p.assetId,
    symbol: p.symbol,
    currency: p.currency,
    prices: p.prices,
    weight: p.weight / totalWeight,
  }));

  const { series, perAsset } = await runPipeline(basket, axis, getRate);
  const stats = computeStats(series);

  // Per-position attribution: weight · (ratioEnd − 1) · 100. These sum exactly to
  // stats.totalReturnPct (Σ wᵢ = 1 ⇒ Σ contributions = index(end) − 100).
  const contributions: PositionContribution[] = perAsset.map((a) => {
    const returnPct = (a.ratioEnd - 1) * 100;
    return {
      assetId: a.assetId,
      symbol: a.symbol,
      weight: a.weight,
      returnPct,
      contributionPct: a.weight * returnPct,
    };
  });

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
  };
}
