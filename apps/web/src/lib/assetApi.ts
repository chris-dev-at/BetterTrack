import {
  assetDetailResponseSchema,
  assetQuotesResponseSchema,
  assetSparklinesResponseSchema,
  dailyClosesResponseSchema,
  historyResponseSchema,
  quoteResponseSchema,
  type AssetDetailResponse,
  type AssetQuotesResponse,
  type AssetSparklinesResponse,
  type DailyClosesResponse,
  type HistoryRange,
  type HistoryResponse,
  type QuoteResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/** Stable URLs keep aggregate GETs reusable across reorder-only renders. */
const canonicalAssetIds = (ids: readonly string[]): string => [...new Set(ids)].sort().join(',');

/** `GET /assets/:id` — meta + latest quote with EUR conversion (§6.3). */
export async function getAssetDetail(
  id: string,
  signal?: AbortSignal,
): Promise<AssetDetailResponse> {
  const data = await apiRequest<unknown>(`/assets/${encodeURIComponent(id)}`, { signal });
  return assetDetailResponseSchema.parse(data);
}

/** `GET /assets/:id/quote` — live quote with stale/asOf markers (§6.3). */
export async function getAssetQuote(id: string, signal?: AbortSignal): Promise<QuoteResponse> {
  const data = await apiRequest<unknown>(`/assets/${encodeURIComponent(id)}/quote`, { signal });
  return quoteResponseSchema.parse(data);
}

/** `GET /assets/quotes?ids=` — one quote read/poll for a whole watchlist. */
export async function getAssetQuotes(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<AssetQuotesResponse> {
  const data = await apiRequest<unknown>('/assets/quotes', {
    query: { ids: canonicalAssetIds(ids) },
    signal,
  });
  return assetQuotesResponseSchema.parse(data);
}

/** `GET /assets/sparklines?ids=` — compact daily one-month workboard series. */
export async function getAssetSparklines(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<AssetSparklinesResponse> {
  const data = await apiRequest<unknown>('/assets/sparklines', {
    query: { ids: canonicalAssetIds(ids) },
    signal,
  });
  return assetSparklinesResponseSchema.parse(data);
}

/**
 * `GET /assets/:id/history?range=` — price series for a chart range (§6.3).
 * `range` must be a `HistoryRange` value ('1D'…'MAX'); the API picks the
 * appropriate candle interval per the §5.3 cache table.
 */
export async function getAssetHistory(
  id: string,
  range: HistoryRange,
  signal?: AbortSignal,
): Promise<HistoryResponse> {
  const data = await apiRequest<unknown>(`/assets/${encodeURIComponent(id)}/history`, {
    query: { range },
    signal,
  });
  return historyResponseSchema.parse(data);
}

/**
 * `GET /assets/:id/daily-closes` — the full available **daily** close series
 * (§5.3), forced to a `1d` interval. Fetched once when the transaction dialog
 * opens; the linked date ↔ price fields (#226) resolve both directions locally
 * from it, so a lookup never triggers a synchronous provider call.
 */
export async function getAssetDailyCloses(
  id: string,
  signal?: AbortSignal,
): Promise<DailyClosesResponse> {
  const data = await apiRequest<unknown>(`/assets/${encodeURIComponent(id)}/daily-closes`, {
    signal,
  });
  return dailyClosesResponseSchema.parse(data);
}
