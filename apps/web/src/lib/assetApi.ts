import {
  ASSET_BATCH_MAX_IDS,
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

/**
 * Canonical, cache-friendly id pages for the aggregate reads. Sorting and
 * de-duplicating keeps the URL stable across reorder-only renders; the chunk
 * respects the server's hard `ASSET_BATCH_MAX_IDS` cap, which a long watchlist
 * would otherwise hit as a permanent 400 on every aggregate read. Realistic
 * lists still resolve in a single request.
 */
const assetIdPages = (ids: readonly string[]): string[] => {
  const canonical = [...new Set(ids)].sort();
  const pages: string[] = [];
  for (let start = 0; start < canonical.length; start += ASSET_BATCH_MAX_IDS) {
    pages.push(canonical.slice(start, start + ASSET_BATCH_MAX_IDS).join(','));
  }
  return pages;
};

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
 * Query keys for the aggregate watchlist reads. The id set is part of the key,
 * so every distinct watchlist is its own cache entry — which also means the
 * asset-scoped `['asset', id]` prefix the realtime `quote.updated` push
 * invalidates cannot reach them. {@link matchesWorkboardQuotesForAsset} closes
 * that gap without widening the push: it matches only the batches that actually
 * contain the moved asset, exactly as narrow as when every row held its own
 * `['asset', id, 'quote']` entry.
 */
export const workboardQuotesQueryKey = (assetIds: readonly string[]) =>
  ['assets', 'workboard', 'quotes', assetIds] as const;

/** Companion of {@link workboardQuotesQueryKey} for the compact daily series. */
export const workboardSparklinesQueryKey = (assetIds: readonly string[]) =>
  ['assets', 'workboard', 'sparklines', assetIds] as const;

/**
 * Does `queryKey` address a watchlist **quote** batch containing `assetId`?
 * Deliberately quotes-only: a quote push says the price moved, which tells us
 * nothing new about the daily sparkline candles.
 */
export function matchesWorkboardQuotesForAsset(
  queryKey: readonly unknown[],
  assetId: string,
): boolean {
  const [scope, surface, read, ids] = queryKey;
  return (
    scope === 'assets' &&
    surface === 'workboard' &&
    read === 'quotes' &&
    Array.isArray(ids) &&
    ids.includes(assetId)
  );
}

/** `GET /assets/quotes?ids=` — one quote read/poll for a whole watchlist. */
export async function getAssetQuotes(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<AssetQuotesResponse> {
  const pages = await Promise.all(
    assetIdPages(ids).map(async (page) => {
      const data = await apiRequest<unknown>('/assets/quotes', { query: { ids: page }, signal });
      return assetQuotesResponseSchema.parse(data);
    }),
  );
  // `failed` merges like the payload: a chunked read must not lose the fact
  // that some rows could not be priced.
  return {
    quotes: pages.flatMap((page) => page.quotes),
    failed: pages.flatMap((page) => page.failed),
  };
}

/** `GET /assets/sparklines?ids=` — compact daily one-month workboard series. */
export async function getAssetSparklines(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<AssetSparklinesResponse> {
  const pages = await Promise.all(
    assetIdPages(ids).map(async (page) => {
      const data = await apiRequest<unknown>('/assets/sparklines', {
        query: { ids: page },
        signal,
      });
      return assetSparklinesResponseSchema.parse(data);
    }),
  );
  return {
    sparklines: pages.flatMap((page) => page.sparklines),
    failed: pages.flatMap((page) => page.failed),
  };
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
