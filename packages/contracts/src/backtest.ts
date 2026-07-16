import { z } from 'zod';

/**
 * Backtest preview contracts (PROJECTPLAN.md §6.5, §6.6, §7.2).
 *
 * The Conglomerate Builder's live-preview panel backtests the *unsaved* draft
 * basket (debounced 500 ms after any weight change) by POSTing its inline
 * positions to `/backtest/preview`. These are the wire shapes that endpoint
 * speaks — defined once so the API validates against them and the web client
 * derives its types from the same source.
 *
 * The response mirrors the pure engine's `BacktestResult`
 * (`apps/api/src/domain/backtest.ts`): a base-100 index `series`, performance
 * `stats`, per-position `contributions`, an optional clipping `notice`, and an
 * optional `benchmark` overlay run through the same pipeline at weight 100.
 */

// --- Request ---------------------------------------------------------------

/**
 * Range presets the Builder offers (§6.5): 1Y / 3Y / 5Y / Max. `MAX` backtests
 * over the basket's full common (overlapping) history.
 */
export const BACKTEST_PREVIEW_RANGES = ['1Y', '3Y', '5Y', 'MAX'] as const;
export const backtestPreviewRangeSchema = z.enum(BACKTEST_PREVIEW_RANGES);
export type BacktestPreviewRange = z.infer<typeof backtestPreviewRangeSchema>;

/**
 * Benchmark overlay tickers (§6.6): S&P 500, DAX, MSCI World. Each is run
 * through the same pipeline as a single position at weight 100.
 */
export const BACKTEST_BENCHMARKS = ['^GSPC', '^GDAXI', 'URTH'] as const;
export const backtestBenchmarkSchema = z.enum(BACKTEST_BENCHMARKS);
export type BacktestBenchmark = z.infer<typeof backtestBenchmarkSchema>;

/**
 * Late-listed-constituent modes (§14): what happens to a constituent younger
 * than the requested window. `clip` (default) clips the window to the common
 * history (the pre-§14 behavior); `cash` holds a late share as uninvested cash
 * (0 % return) until its first trading day; `redistribute` splits it equally
 * among the already-listed constituents and rebalances to the target weights on
 * the entry day. In `cash`/`redistribute` the window runs the full requested
 * span and the response carries one entry event per late constituent.
 */
export const BACKTEST_MODES = ['clip', 'cash', 'redistribute'] as const;
export const backtestModeSchema = z.enum(BACKTEST_MODES);
export type BacktestMode = z.infer<typeof backtestModeSchema>;

/**
 * Scheduled-rebalance frequencies (§13.4 V4-P7): `none` (default) is pure
 * buy-and-hold — the pre-V4-P7 behavior; the others rebalance the basket back
 * to its target weights on the first trading day of each new calendar month /
 * quarter / year, executed at that day's closes through the same §14 rebalance
 * primitive the entry-day events use (§16, 2026-07-15).
 */
export const REBALANCE_FREQUENCIES = ['none', 'monthly', 'quarterly', 'yearly'] as const;
export const rebalanceFrequencySchema = z.enum(REBALANCE_FREQUENCIES);
export type RebalanceFrequency = z.infer<typeof rebalanceFrequencySchema>;

/**
 * One inline basket member: which asset, and its relative weight. Weights are
 * relative (normalised across the basket by the engine so the index opens at
 * 100), so any positive number is valid — the Builder sends raw percentages.
 */
export const backtestPreviewPositionSchema = z
  .object({
    assetId: z.string().uuid(),
    weight: z.number().finite().gt(0, 'Weight must be greater than 0.'),
  })
  .strict();
export type BacktestPreviewPosition = z.infer<typeof backtestPreviewPositionSchema>;

/** `POST /backtest/preview` body — an inline draft basket to backtest (§6.5). */
export const backtestPreviewRequestSchema = z
  .object({
    positions: z.array(backtestPreviewPositionSchema).min(1).max(50),
    range: backtestPreviewRangeSchema,
    benchmark: backtestBenchmarkSchema.nullish(),
    /** Late-listing mode (§14); omitting it keeps the pre-§14 clip behavior. */
    mode: backtestModeSchema.default('clip'),
    /** Rebalance schedule (V4-P7); omitting it keeps today's buy-and-hold. */
    rebalance: rebalanceFrequencySchema.default('none'),
  })
  .strict();
export type BacktestPreviewRequest = z.infer<typeof backtestPreviewRequestSchema>;

// --- Response --------------------------------------------------------------

/** One point on a base-100 index series. */
export const backtestSeriesPointSchema = z
  .object({
    date: z.string(),
    value: z.number(),
  })
  .strict();
export type BacktestSeriesPoint = z.infer<typeof backtestSeriesPointSchema>;

/** A single day's index return (percent), tagged with its date. */
export const backtestDayReturnSchema = z
  .object({
    date: z.string(),
    returnPct: z.number(),
  })
  .strict();
export type BacktestDayReturn = z.infer<typeof backtestDayReturnSchema>;

/** Performance statistics for a base-100 index series (§6.6). */
export const backtestStatsSchema = z
  .object({
    totalReturnPct: z.number(),
    cagrPct: z.number().nullable(),
    maxDrawdownPct: z.number(),
    volatilityPct: z.number().nullable(),
    bestDay: backtestDayReturnSchema.nullable(),
    worstDay: backtestDayReturnSchema.nullable(),
  })
  .strict();
export type BacktestStats = z.infer<typeof backtestStatsSchema>;

/**
 * One position's share of the total return; `contributionPct` values sum to
 * `totalReturnPct` in every mode. In `clip`/`cash` mode a contribution is the
 * weighted own return (`weight · returnPct`); in `redistribute` mode it is the
 * money-weighted gain including temporarily redistributed capital, so it can
 * differ from `weight · returnPct`. With a rebalance schedule active (V4-P7)
 * every mode reports the money-weighted segment gain.
 */
export const backtestContributionSchema = z
  .object({
    assetId: z.string(),
    symbol: z.string(),
    weight: z.number(),
    returnPct: z.number(),
    contributionPct: z.number(),
  })
  .strict();
export type BacktestContribution = z.infer<typeof backtestContributionSchema>;

/** The benchmark overlay: its own base-100 series + stats, on the main axis. */
export const backtestBenchmarkResultSchema = z
  .object({
    assetId: z.string(),
    symbol: z.string(),
    series: z.array(backtestSeriesPointSchema),
    stats: backtestStatsSchema,
  })
  .strict();
export type BacktestBenchmarkResult = z.infer<typeof backtestBenchmarkResultSchema>;

/**
 * A late constituent's entry into the running portfolio (§14): the trading day
 * of its first available close on/after its listing date. Drawn as a chart
 * marker ("X enters"). Empty in `clip` mode.
 */
export const backtestEntryEventSchema = z
  .object({
    assetId: z.string(),
    symbol: z.string(),
    /** ISO `YYYY-MM-DD` — the entry trading day. */
    date: z.string(),
  })
  .strict();
export type BacktestEntryEvent = z.infer<typeof backtestEntryEventSchema>;

/**
 * One executed scheduled rebalance (V4-P7): the first trading day of a new
 * calendar period, where the portfolio was reset to its target weights at that
 * day's closes. Drawn as a chart marker by the Workboard UI. Empty when the
 * frequency is `none`.
 */
export const backtestRebalanceEventSchema = z
  .object({
    /** ISO `YYYY-MM-DD` — the rebalance trading day (always on the series axis). */
    date: z.string(),
  })
  .strict();
export type BacktestRebalanceEvent = z.infer<typeof backtestRebalanceEventSchema>;

/** `POST /backtest/preview` response — mirrors the engine's `BacktestResult`. */
export const backtestResponseSchema = z
  .object({
    startDate: z.string(),
    endDate: z.string(),
    series: z.array(backtestSeriesPointSchema),
    stats: backtestStatsSchema,
    contributions: z.array(backtestContributionSchema),
    notice: z.string().nullable(),
    benchmark: backtestBenchmarkResultSchema.nullable(),
    /** The late-listing mode the backtest ran under (§14). */
    mode: backtestModeSchema,
    /** The rebalance schedule the backtest ran under (V4-P7). */
    rebalance: rebalanceFrequencySchema,
    /** One entry per late constituent, ascending by date; empty in `clip` mode. */
    entryEvents: z.array(backtestEntryEventSchema),
    /** One event per executed scheduled rebalance, ascending; empty for `none`. */
    rebalanceEvents: z.array(backtestRebalanceEventSchema),
    /**
     * Cash mode only: mean share of the portfolio value sitting uninvested
     * across the window, in percent ("avg. uninvested"); `null` in other modes.
     */
    idleCashAvgPct: z.number().nullable(),
  })
  .strict();
export type BacktestResponse = z.infer<typeof backtestResponseSchema>;
