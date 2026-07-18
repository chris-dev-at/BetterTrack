import {
  dividendCalendarResponseSchema,
  dividendsResponseSchema,
  projectedDividendIncomeResponseSchema,
  type DividendCalendarResponse,
  type DividendsResponse,
  type ProjectedDividendIncomeResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Market-intelligence client (§13.5 V5-P5, arc a). Every read degrades to the
 * "unavailable" shape (`available: false`, empty) when the global
 * `MARKET_INTEL_ENABLED` gate is off, the provider lacks the capability, or the
 * upstream errored — the UI keys block visibility off `available`, so the whole
 * surface stays invisible when unconfigured.
 */

export const ASSET_DIVIDENDS_QUERY_KEY = (id: string) => ['asset', id, 'dividends'] as const;
export const PORTFOLIO_DIVIDEND_CALENDAR_QUERY_KEY = ['portfolio', 'dividend-calendar'] as const;
export const PORTFOLIO_DIVIDEND_PROJECTION_QUERY_KEY = [
  'portfolio',
  'dividend-projection',
] as const;

/** `GET /assets/:id/intel/dividends` — history + upcoming ex/pay + forward yield. */
export async function getAssetDividends(
  id: string,
  signal?: AbortSignal,
): Promise<DividendsResponse> {
  const data = await apiRequest<unknown>(`/assets/${encodeURIComponent(id)}/intel/dividends`, {
    signal,
  });
  return dividendsResponseSchema.parse(data);
}

/** `GET /assets/portfolio/dividend-calendar` — upcoming ex/pay across held + watched. */
export async function getPortfolioDividendCalendar(
  signal?: AbortSignal,
): Promise<DividendCalendarResponse> {
  const data = await apiRequest<unknown>('/assets/portfolio/dividend-calendar', { signal });
  return dividendCalendarResponseSchema.parse(data);
}

/** `GET /assets/portfolio/dividend-projection` — projected income (monthly/yearly EUR). */
export async function getPortfolioDividendProjection(
  signal?: AbortSignal,
): Promise<ProjectedDividendIncomeResponse> {
  const data = await apiRequest<unknown>('/assets/portfolio/dividend-projection', { signal });
  return projectedDividendIncomeResponseSchema.parse(data);
}
