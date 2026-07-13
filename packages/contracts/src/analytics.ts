import { z } from 'zod';

import { ASSET_TYPES, currencyCodeSchema } from './market';
import { CUSTOM_ASSET_CATEGORIES, portfolioAssetSchema } from './portfolio';

/**
 * Analytics deep-dive contracts (PROJECTPLAN.md §13.3 V3-P9).
 *
 * The Portfolio → Analytics page's configurable main graph + contribution
 * table speak these shapes. Defined once so the API validates against them and
 * the web client derives its types from the same source. The response mirrors
 * the pure domain in `apps/api/src/domain/seriesStats.ts` (per-series
 * `stats` over a value series) plus the assembled per-asset `contributions`.
 *
 * The endpoint is a READ (`GET`, `portfolio:read`): the graph configuration —
 * free date range, value/performance mode, per-asset visibility, category/type
 * filters, an optional compare target and an optional inflation mode — is
 * carried entirely in the query string.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Grouping key for the visibility filters: a market asset groups by its
 * {@link ASSET_TYPES} `type`, a custom asset by its {@link CUSTOM_ASSET_CATEGORIES}
 * `category` (V3-P2 — a custom "stock" folds under Stocks with market stocks).
 * The union of both taxonomies, deduplicated.
 */
export const ANALYTICS_GROUP_KEYS = [
  ...new Set<string>([...ASSET_TYPES, ...CUSTOM_ASSET_CATEGORIES]),
] as const;
export const analyticsGroupKeySchema = z.enum(
  ANALYTICS_GROUP_KEYS as unknown as [string, ...string[]],
);
export type AnalyticsGroupKey = z.infer<typeof analyticsGroupKeySchema>;

/** Main-graph render mode (§13.3): absolute value vs cumulative performance-%. */
export const ANALYTICS_MODES = ['value', 'perf'] as const;
export const analyticsModeSchema = z.enum(ANALYTICS_MODES);
export type AnalyticsMode = z.infer<typeof analyticsModeSchema>;

/** Compare-target kinds (§13.3): a catalog asset/index, another own portfolio, or an own conglomerate. */
export const ANALYTICS_COMPARE_KINDS = ['asset', 'portfolio', 'conglomerate'] as const;
export const analyticsCompareKindSchema = z.enum(ANALYTICS_COMPARE_KINDS);
export type AnalyticsCompareKind = z.infer<typeof analyticsCompareKindSchema>;

/** Series kinds tagged on each returned series (primary is always `portfolio`). */
export const ANALYTICS_SERIES_KINDS = ['portfolio', 'asset', 'conglomerate'] as const;
export const analyticsSeriesKindSchema = z.enum(ANALYTICS_SERIES_KINDS);
export type AnalyticsSeriesKind = z.infer<typeof analyticsSeriesKindSchema>;

/**
 * Inflation mode (§13.3): a country/area HICP-or-CPI index, or a custom flat
 * `%/yr`. `flat` requires {@link AnalyticsSeriesQuery.inflationRate}; the index
 * modes ignore it.
 */
export const ANALYTICS_INFLATION_MODES = ['hicp-at', 'hicp-eu', 'cpi-us', 'flat'] as const;
export const analyticsInflationModeSchema = z.enum(ANALYTICS_INFLATION_MODES);
export type AnalyticsInflationMode = z.infer<typeof analyticsInflationModeSchema>;

/** Split a `a,b,c` query value into trimmed, non-empty, individually-validated items. */
const csvList = <T extends z.ZodTypeAny>(item: T) =>
  z.string().transform((raw, ctx) => {
    const parts = raw
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const out: z.infer<T>[] = [];
    for (const part of parts) {
      const parsed = item.safeParse(part);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid value "${part}".` });
        return z.NEVER;
      }
      out.push(parsed.data);
    }
    return out;
  });

/**
 * `GET /analytics/portfolios/:portfolioId/series` query. Every knob of the
 * configurable graph:
 * - `from`/`to` — free date window (ISO `YYYY-MM-DD`); default is inception → today.
 * - `mode` — `value` | `perf`.
 * - `hide` — CSV of asset ids to hide (per-asset visibility toggle).
 * - `groups` — CSV of group keys to include (when present, ONLY these groups render).
 * - `hideGroups` — CSV of group keys to exclude (category/type exclude filter).
 * - `compareKind` + `compareId` — overlay a benchmark (both or neither).
 * - `inflation` (+ `inflationRate` for `flat`) — real-terms normalization.
 *
 * Cross-field requirements (`compareId` with `compareKind`; `inflationRate`
 * with `inflation=flat`) are enforced in the service so this stays a plain
 * object schema (clean OpenAPI param extraction).
 */
export const analyticsSeriesQuerySchema = z
  .object({
    from: z.string().regex(ISO_DATE).optional(),
    to: z.string().regex(ISO_DATE).optional(),
    mode: analyticsModeSchema.default('value'),
    hide: csvList(z.string().uuid()).optional(),
    groups: csvList(analyticsGroupKeySchema).optional(),
    hideGroups: csvList(analyticsGroupKeySchema).optional(),
    compareKind: analyticsCompareKindSchema.optional(),
    compareId: z.string().uuid().optional(),
    inflation: analyticsInflationModeSchema.optional(),
    inflationRate: z.coerce.number().finite().optional(),
  })
  .strict();
export type AnalyticsSeriesQuery = z.infer<typeof analyticsSeriesQuerySchema>;

/** One point on a returned series (EUR value, or cumulative % in `perf`/real modes). */
export const analyticsSeriesPointSchema = z
  .object({
    date: z.string().regex(ISO_DATE),
    value: z.number(),
  })
  .strict();
export type AnalyticsSeriesPoint = z.infer<typeof analyticsSeriesPointSchema>;

/** A single day's return (percent), tagged with its date. */
export const analyticsDayReturnSchema = z
  .object({
    date: z.string().regex(ISO_DATE),
    returnPct: z.number(),
  })
  .strict();
export type AnalyticsDayReturn = z.infer<typeof analyticsDayReturnSchema>;

/** Performance statistics over a value series (§13.3): mirrors `domain/seriesStats`. */
export const analyticsStatsSchema = z
  .object({
    totalReturnPct: z.number(),
    cagrPct: z.number().nullable(),
    /** Max drawdown, percent, ≤ 0 (0 when the series only rises). */
    maxDrawdownPct: z.number(),
    bestDay: analyticsDayReturnSchema.nullable(),
    worstDay: analyticsDayReturnSchema.nullable(),
  })
  .strict();
export type AnalyticsStats = z.infer<typeof analyticsStatsSchema>;

/** One rendered series — the primary (filtered) portfolio curve or a compare overlay. */
export const analyticsSeriesSchema = z
  .object({
    kind: analyticsSeriesKindSchema,
    /** Display label: the portfolio name, the asset symbol, or the conglomerate name. */
    label: z.string(),
    points: z.array(analyticsSeriesPointSchema),
    stats: analyticsStatsSchema,
  })
  .strict();
export type AnalyticsSeries = z.infer<typeof analyticsSeriesSchema>;

/**
 * One per-asset contribution row (§13.3). `value`/`cost`/`pnl`/`weight` are the
 * holdings-math facts for the visible set; `contributionPct` is the asset's
 * share of the period change of the filtered series — the visible rows'
 * `contributionPct` sum to the filtered series' total return.
 */
export const analyticsContributionRowSchema = z
  .object({
    asset: portfolioAssetSchema,
    /** Current market value, base currency. */
    value: z.number(),
    /** Open cost basis, base currency. */
    cost: z.number(),
    /** Unrealized P/L, base currency. */
    pnl: z.number(),
    /** Fraction (0..1) of the visible set's market value. */
    weight: z.number(),
    /** (endValue − startValue) / visible-start-total · 100, percent. */
    contributionPct: z.number(),
  })
  .strict();
export type AnalyticsContributionRow = z.infer<typeof analyticsContributionRowSchema>;

/** Echo of the applied inflation mode; `pctPerYear` is set only for `flat`. */
export const analyticsInflationAppliedSchema = z
  .object({
    id: analyticsInflationModeSchema,
    pctPerYear: z.number().nullable(),
  })
  .strict();
export type AnalyticsInflationApplied = z.infer<typeof analyticsInflationAppliedSchema>;

/** `GET /analytics/portfolios/:portfolioId/series` response. */
export const analyticsSeriesResponseSchema = z
  .object({
    portfolioId: z.string().uuid(),
    baseCurrency: currencyCodeSchema,
    mode: analyticsModeSchema,
    /** Resolved window start (ISO `YYYY-MM-DD`). */
    from: z.string().regex(ISO_DATE),
    /** Resolved window end (ISO `YYYY-MM-DD`). */
    to: z.string().regex(ISO_DATE),
    /** The applied inflation mode, or `null` in nominal mode. */
    inflation: analyticsInflationAppliedSchema.nullable(),
    /** The filtered/visibility-masked portfolio curve + its stats. */
    primary: analyticsSeriesSchema,
    /** The compare overlay + its stats, or `null` when no compare target. */
    compare: analyticsSeriesSchema.nullable(),
    /** Per-asset contribution rows for the visible set. */
    contributions: z.array(analyticsContributionRowSchema),
  })
  .strict();
export type AnalyticsSeriesResponse = z.infer<typeof analyticsSeriesResponseSchema>;
