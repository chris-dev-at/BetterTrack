import {
  earningsCalendarResponseSchema,
  earningsResponseSchema,
  splitsResponseSchema,
  type EarningsCalendarResponse,
  type EarningsResponse,
  type SplitsResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Market-intelligence client (PROJECTPLAN.md §13.5 V5-P5). The endpoints return
 * the "unconfigured" shape (`available: false`, empty) whenever the gate is off,
 * the provider lacks the capability, or the upstream errored — never a 5xx — so
 * every caller keys its block's visibility off `available` and hides otherwise.
 */

/** Query key for one asset's earnings block. */
export const ASSET_EARNINGS_QUERY_KEY = (id: string) => ['asset', id, 'intel', 'earnings'] as const;
/** Query key for one asset's splits block. */
export const ASSET_SPLITS_QUERY_KEY = (id: string) => ['asset', id, 'intel', 'splits'] as const;
/** Query key for the portfolio-level upcoming-earnings calendar (Workboard panel). */
export const EARNINGS_CALENDAR_QUERY_KEY = ['intel', 'earnings-calendar'] as const;

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
