import {
  assetDetailResponseSchema,
  historyResponseSchema,
  quoteResponseSchema,
  type AssetDetailResponse,
  type HistoryRange,
  type HistoryResponse,
  type QuoteResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

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
