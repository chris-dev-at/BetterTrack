import {
  dividendCalendarResponseSchema,
  dividendsResponseSchema,
  earningsCalendarResponseSchema,
  earningsResponseSchema,
  projectedDividendIncomeResponseSchema,
  splitsResponseSchema,
  type DividendCalendarResponse,
  type DividendsResponse,
  type EarningsCalendarResponse,
  type EarningsResponse,
  type ProjectedDividendIncomeResponse,
  type SplitsResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Market-intelligence client (PROJECTPLAN.md §13.5 V5-P5). Every read returns the
 * "unconfigured" shape (`available: false`, empty) whenever the global
 * `MARKET_INTEL_ENABLED` gate is off, the provider lacks the capability, or the
 * upstream errored — never a 5xx — so every caller keys its block's visibility
 * off `available` and hides the whole surface otherwise.
 */

/** Query key for one asset's dividends block (arc a). */
export const ASSET_DIVIDENDS_QUERY_KEY = (id: string) =>
  ['asset', id, 'intel', 'dividends'] as const;
/** Query key for one asset's earnings block (arc b). */
export const ASSET_EARNINGS_QUERY_KEY = (id: string) => ['asset', id, 'intel', 'earnings'] as const;
/** Query key for one asset's splits block (arc d). */
export const ASSET_SPLITS_QUERY_KEY = (id: string) => ['asset', id, 'intel', 'splits'] as const;
/** Query key for the portfolio-level upcoming-earnings calendar (Workboard panel). */
export const EARNINGS_CALENDAR_QUERY_KEY = ['intel', 'earnings-calendar'] as const;
/** Query key for the portfolio-level dividend calendar (arc a). */
export const PORTFOLIO_DIVIDEND_CALENDAR_QUERY_KEY = ['portfolio', 'dividend-calendar'] as const;
/** Query key for the portfolio-level projected dividend income (arc a). */
export const PORTFOLIO_DIVIDEND_PROJECTION_QUERY_KEY = [
  'portfolio',
  'dividend-projection',
] as const;

/** `GET /assets/:id/intel/dividends` — history + upcoming ex/pay + forward yield (arc a). */
export async function getAssetDividends(
  id: string,
  signal?: AbortSignal,
): Promise<DividendsResponse> {
  const data = await apiRequest<unknown>(`/assets/${encodeURIComponent(id)}/intel/dividends`, {
    signal,
  });
  return dividendsResponseSchema.parse(data);
}

/** `GET /assets/:id/intel/earnings` — next + recent earnings reports (arc b). */
export async function getAssetEarnings(
  id: string,
  signal?: AbortSignal,
): Promise<EarningsResponse> {
  const data = await apiRequest<unknown>(`/assets/${encodeURIComponent(id)}/intel/earnings`, {
    signal,
  });
  return earningsResponseSchema.parse(data);
}

/** `GET /assets/:id/intel/splits` — past + announced splits (arc d). */
export async function getAssetSplits(id: string, signal?: AbortSignal): Promise<SplitsResponse> {
  const data = await apiRequest<unknown>(`/assets/${encodeURIComponent(id)}/intel/splits`, {
    signal,
  });
  return splitsResponseSchema.parse(data);
}

/**
 * `GET /assets/intel/earnings-calendar` — the upcoming-earnings feed across the
 * caller's held + watched assets, ascending by date (Workboard panel, arc b).
 */
export async function getEarningsCalendar(signal?: AbortSignal): Promise<EarningsCalendarResponse> {
  const data = await apiRequest<unknown>('/assets/intel/earnings-calendar', { signal });
  return earningsCalendarResponseSchema.parse(data);
}

/** `GET /assets/portfolio/dividend-calendar` — upcoming ex/pay across held + watched (arc a). */
export async function getPortfolioDividendCalendar(
  signal?: AbortSignal,
): Promise<DividendCalendarResponse> {
  const data = await apiRequest<unknown>('/assets/portfolio/dividend-calendar', { signal });
  return dividendCalendarResponseSchema.parse(data);
}

/** `GET /assets/portfolio/dividend-projection` — projected income (monthly/yearly EUR, arc a). */
export async function getPortfolioDividendProjection(
  signal?: AbortSignal,
): Promise<ProjectedDividendIncomeResponse> {
  const data = await apiRequest<unknown>('/assets/portfolio/dividend-projection', { signal });
  return projectedDividendIncomeResponseSchema.parse(data);
}
