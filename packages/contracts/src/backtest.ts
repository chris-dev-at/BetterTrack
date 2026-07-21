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
 * optional `benchmark` block — a second engine run over the same window and
 * settings (§13.4 V4-P7), carrying its own full stat set for the side-by-side
 * table.
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
 * One-click benchmark preset tickers (§6.6): S&P 500, DAX, MSCI World. Since
 * V4-P7 they are sugar over the catalog — the server resolves a preset to its
 * catalog asset and runs it like any other asset benchmark.
 */
export const BACKTEST_BENCHMARKS = ['^GSPC', '^GDAXI', 'URTH'] as const;
export const backtestBenchmarkSchema = z.enum(BACKTEST_BENCHMARKS);
export type BacktestBenchmark = z.infer<typeof backtestBenchmarkSchema>;

/**
 * Benchmark choice (§13.4 V4-P7): exactly one of —
 *  - `preset` — a one-click ticker, resolved server-side to its catalog asset;
 *  - `assetId` — any catalog asset found via local search (§6.2);
 *  - `conglomerateId` — one of the caller's own conglomerates, run through the
 *    same engine as a second basket.
 * A union of single-key `strict` objects: a body naming two sources at once
 * matches no branch and fails validation, so "one benchmark at a time" is a
 * wire invariant rather than a service-side check.
 */
export const backtestBenchmarkInputSchema = z.union([
  z.object({ preset: backtestBenchmarkSchema }).strict(),
  z.object({ assetId: z.string().uuid() }).strict(),
  z.object({ conglomerateId: z.string().uuid() }).strict(),
]);
export type BacktestBenchmarkInput = z.infer<typeof backtestBenchmarkInputSchema>;

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
    /** Exactly one benchmark at a time (V4-P7), or none. */
    benchmark: backtestBenchmarkInputSchema.nullish(),
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

/** What a benchmark resolved to (V4-P7): a single asset or a whole conglomerate. */
export const BACKTEST_BENCHMARK_KINDS = ['asset', 'conglomerate'] as const;
export const backtestBenchmarkKindSchema = z.enum(BACKTEST_BENCHMARK_KINDS);
export type BacktestBenchmarkKind = z.infer<typeof backtestBenchmarkKindSchema>;

/**
 * The benchmark result (V4-P7): its own base-100 series + the same full stat
 * set as the primary basket, computed by a second engine run over the same
 * window, late-listing mode and rebalance schedule (apples-to-apples), so the
 * UI can render every bottom-panel stat side-by-side with a delta.
 */
export const backtestBenchmarkResultSchema = z
  .object({
    kind: backtestBenchmarkKindSchema,
    /** The resolved catalog-asset id (preset ticker if unseeded) or conglomerate id. */
    refId: z.string(),
    /** Display label: the asset's symbol, or the conglomerate's name. */
    label: z.string(),
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

// --- Shared-conglomerate what-if sandbox (§13.5 V5-P6 arc c) ---------------

/**
 * One re-weighted constituent in a shared-conglomerate what-if sandbox (§13.5
 * V5-P6 arc c): the constituent's own id — an asset's `assetId`, exactly as the
 * read-only shared view surfaces it — plus the viewer's locally-tweaked relative
 * weight (normalised by the engine, so any positive number is valid, as in the
 * Builder). The server pins the id SET to the shared basket's real constituents,
 * so the sandbox can only re-weight what the share already exposes — never inject
 * a foreign asset id (the §6.9 privacy boundary).
 */
export const sharedSandboxPositionSchema = z
  .object({
    id: z.string().uuid(),
    weight: z.number().finite().gt(0, 'Weight must be greater than 0.'),
  })
  .strict();
export type SharedSandboxPosition = z.infer<typeof sharedSandboxPositionSchema>;

/**
 * `POST /backtest/shared/:conglomerateId/preview` body (§13.5 V5-P6 arc c): a
 * viewer's local weight tweaks over a FRIEND-SHARED conglomerate, run through the
 * exact same engine as the Builder preview. Only the top-level weights travel;
 * the constituent identities and prices are resolved server-side from the shared
 * basket (owner-scoped, catalog-assets only), so nothing beyond the share's
 * existing exposure is reachable and no write is ever issued. Deliberately has no
 * benchmark axis — a viewer must not overlay their own baskets on someone else's
 * share. Nested constituents are out of arc-c scope (recursive re-weighting is
 * #592): a basket containing one is not sandboxable and the server refuses it.
 */
export const sharedSandboxPreviewRequestSchema = z
  .object({
    positions: z.array(sharedSandboxPositionSchema).min(1).max(50),
    range: backtestPreviewRangeSchema,
    /** Late-listing mode (§14); omitting it keeps the pre-§14 clip behavior. */
    mode: backtestModeSchema.default('clip'),
    /** Rebalance schedule (V4-P7); omitting it keeps buy-and-hold. */
    rebalance: rebalanceFrequencySchema.default('none'),
  })
  .strict();
export type SharedSandboxPreviewRequest = z.infer<typeof sharedSandboxPreviewRequestSchema>;

// --- N-way conglomerate comparison (§13.5 V5-P6 arc a) ---------------------

/**
 * The maximum number of conglomerates one comparison overlays at once (§13.5
 * V5-P6). Two is the floor (a comparison needs a pair); six is the cap — past
 * that the overlay chart and the stats grid stop being readable (anti-bloat),
 * and it bounds the per-request backtest fan-out. `N=7` is rejected here at the
 * contract, before the service ever runs.
 */
export const COMPARISON_MIN_SERIES = 2;
export const COMPARISON_MAX_SERIES = 6;

/**
 * The stat metrics compared across series in the N-way comparison grid (V5-P6):
 * a flat numeric projection of {@link backtestStatsSchema}. The two day-return
 * blocks collapse to their `returnPct` (the grid compares the magnitude; the
 * date stays on the per-series `stats`). Every field is nullable exactly where
 * its `BacktestStats` source is (`cagrPct`/`volatilityPct` on a single-day
 * window, best/worst day with no returns).
 */
export const COMPARISON_METRIC_KEYS = [
  'totalReturnPct',
  'cagrPct',
  'maxDrawdownPct',
  'volatilityPct',
  'bestDayPct',
  'worstDayPct',
] as const;
export const comparisonMetricKeySchema = z.enum(COMPARISON_METRIC_KEYS);
export type ComparisonMetricKey = z.infer<typeof comparisonMetricKeySchema>;

/** The comparable stat vector for one series (nullable where a stat is undefined). */
export const comparisonMetricsSchema = z
  .object({
    totalReturnPct: z.number().nullable(),
    cagrPct: z.number().nullable(),
    maxDrawdownPct: z.number().nullable(),
    volatilityPct: z.number().nullable(),
    bestDayPct: z.number().nullable(),
    worstDayPct: z.number().nullable(),
  })
  .strict();
export type ComparisonMetrics = z.infer<typeof comparisonMetricsSchema>;

/**
 * `POST /backtest/compare` body (§13.5 V5-P6): a set of the caller's own
 * conglomerate ids to overlay, plus the same window/late-listing/rebalance
 * knobs a single backtest takes. Each id is run through the same engine over
 * the FIRST id's effective window (its `stats` are therefore apples-to-apples,
 * exactly as a V4-P7 benchmark is). `baselineId` (default: the first id) is the
 * series every stat delta is measured against; it changes only the deltas, not
 * the window or the per-series stats, so re-picking it is a cheap recompute.
 */
export const backtestComparisonRequestSchema = z
  .object({
    conglomerateIds: z
      .array(z.string().uuid())
      .min(COMPARISON_MIN_SERIES)
      .max(COMPARISON_MAX_SERIES),
    range: backtestPreviewRangeSchema,
    mode: backtestModeSchema.default('clip'),
    rebalance: rebalanceFrequencySchema.default('none'),
    /** The delta baseline; must be one of `conglomerateIds`. Defaults to the first. */
    baselineId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (new Set(val.conglomerateIds).size !== val.conglomerateIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'conglomerateIds must be unique.',
        path: ['conglomerateIds'],
      });
    }
    if (val.baselineId !== undefined && !val.conglomerateIds.includes(val.baselineId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baselineId must be one of conglomerateIds.',
        path: ['baselineId'],
      });
    }
  });
export type BacktestComparisonRequest = z.infer<typeof backtestComparisonRequestSchema>;

/**
 * One overlaid series in a comparison: its own base-100 index `series` + full
 * `stats` (both from a dedicated engine run over the shared window), and its
 * per-metric `deltas` against the response `baselineId` (`stat − baselineStat`,
 * `null` when either side is null). The baseline's own row is all-zero (null
 * where its stat is null).
 */
export const comparisonSeriesSchema = z
  .object({
    conglomerateId: z.string().uuid(),
    name: z.string(),
    series: z.array(backtestSeriesPointSchema),
    stats: backtestStatsSchema,
    deltas: comparisonMetricsSchema,
  })
  .strict();
export type ComparisonSeries = z.infer<typeof comparisonSeriesSchema>;

/**
 * `POST /backtest/compare` response — every requested conglomerate as an
 * apples-to-apples series over one shared window, in request order. `startDate`
 * /`endDate` are that shared window (the first id's effective window); every
 * `series.deltas` is measured against `baselineId`.
 */
export const backtestComparisonResponseSchema = z
  .object({
    startDate: z.string(),
    endDate: z.string(),
    baselineId: z.string().uuid(),
    mode: backtestModeSchema,
    rebalance: rebalanceFrequencySchema,
    series: z.array(comparisonSeriesSchema),
  })
  .strict();
export type BacktestComparisonResponse = z.infer<typeof backtestComparisonResponseSchema>;
