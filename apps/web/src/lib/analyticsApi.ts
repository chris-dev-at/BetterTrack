import {
  analyticsSeriesResponseSchema,
  type AnalyticsCompareKind,
  type AnalyticsInflationMode,
  type AnalyticsMode,
  type AnalyticsSeriesResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the Analytics deep-dive surface (PROJECTPLAN.md §13.3 V3-P9).
 * The single `series` endpoint is a READ whose entire graph configuration — free
 * date window, value/perf mode, per-asset visibility, category/type filters, an
 * optional compare target and an optional inflation mode — travels in the query
 * string (mirrors the `analyticsSeriesQuerySchema` contract). Every response is
 * parsed through its contract schema, so the page works against validated shapes.
 */

/** The Analytics main-graph knobs, mapped 1:1 to the query contract. */
export interface AnalyticsSeriesParams {
  /** Window start, ISO `YYYY-MM-DD`; omit for inception. */
  from?: string;
  /** Window end, ISO `YYYY-MM-DD`; omit for today. */
  to?: string;
  /** `value` (absolute) vs `perf` (cumulative %). */
  mode?: AnalyticsMode;
  /** Asset ids to hide (per-asset visibility toggle). */
  hide?: readonly string[];
  /** Group keys to include — when non-empty, ONLY these groups render. */
  groups?: readonly string[];
  /** Group keys to exclude (category/type exclude filter). */
  hideGroups?: readonly string[];
  /** Compare-target kind; paired with {@link compareId}. */
  compareKind?: AnalyticsCompareKind;
  /** Compare-target id (asset / portfolio / conglomerate). */
  compareId?: string;
  /** Inflation real-terms mode; `flat` also needs {@link inflationRate}. */
  inflation?: AnalyticsInflationMode;
  /** Custom flat inflation rate (%/yr) — required only for `inflation: 'flat'`. */
  inflationRate?: number;
}

/** Join a list into the contract's `a,b,c` CSV form, or `undefined` when empty. */
function csv(list: readonly string[] | undefined): string | undefined {
  return list && list.length > 0 ? list.join(',') : undefined;
}

/**
 * `GET /analytics/portfolios/:portfolioId/series` — the configurable main graph
 * (primary + optional compare series with per-series stats) plus the per-asset
 * contribution table for the visible set. Ownership is enforced server-side.
 */
export async function getAnalyticsSeries(
  portfolioId: string,
  params: AnalyticsSeriesParams = {},
  signal?: AbortSignal,
): Promise<AnalyticsSeriesResponse> {
  const data = await apiRequest<unknown>(
    `/analytics/portfolios/${encodeURIComponent(portfolioId)}/series`,
    {
      query: {
        from: params.from,
        to: params.to,
        mode: params.mode,
        hide: csv(params.hide),
        groups: csv(params.groups),
        hideGroups: csv(params.hideGroups),
        compareKind: params.compareKind,
        compareId: params.compareId,
        inflation: params.inflation,
        inflationRate: params.inflationRate,
      },
      signal,
    },
  );
  return analyticsSeriesResponseSchema.parse(data);
}
