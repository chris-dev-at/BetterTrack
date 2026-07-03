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

/** One position's share of the total return; `contributionPct` values sum to `totalReturnPct`. */
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
  })
  .strict();
export type BacktestResponse = z.infer<typeof backtestResponseSchema>;
