import { z } from 'zod';

import {
  assetTypeSchema,
  currencyCodeSchema,
  historyIntervalSchema,
  historyRangeSchema,
  pricePointSchema,
  quoteSchema,
} from './market';

/**
 * Market-data **read API** contracts (PROJECTPLAN.md §6.2, §6.3, §8): the wire
 * shapes for search and the asset detail/quote/history endpoints. The provider
 * data shapes themselves (`Quote`, `PricePoint`, …) live in `market.ts`; this
 * module owns only the request/response envelopes the HTTP surface exchanges.
 *
 * Cached values are wrapped with `stale`/`asOf` markers (§5.1, §6.3): `stale`
 * is true when the upstream was unreachable and a last-known-good copy is being
 * served under stale-while-revalidate, and `asOf` (ISO-8601) is when that value
 * was last fetched from upstream.
 */

// --- Search (§6.2) ---------------------------------------------------------

/** `GET /search?q=` query — min 2 chars after trimming (§6.2). */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, 'query must be at least 2 characters').max(64),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * One merged search hit (§6.2): a provider result or one of the caller's own
 * custom assets. `id` is the materialized `assets` row id — present on every hit
 * because a provider result is upserted (first-touch) before it is returned, so
 * the client can immediately act on it (→ Workboard / Conglomerate / Portfolio).
 */
export const searchResultItemSchema = z
  .object({
    id: z.string().uuid(),
    providerId: z.string().min(1).max(64),
    providerRef: z.string().min(1).max(128),
    symbol: z.string(),
    name: z.string(),
    exchange: z.string().nullable(),
    type: assetTypeSchema,
    currency: currencyCodeSchema,
    /** True for the caller's own custom (`manual`) asset; false for a market asset. */
    isCustom: z.boolean(),
  })
  .strict();
export type SearchResultItem = z.infer<typeof searchResultItemSchema>;

/** `GET /search` response. */
export const searchResponseSchema = z.object({ results: z.array(searchResultItemSchema) }).strict();
export type SearchResponse = z.infer<typeof searchResponseSchema>;

// --- Asset detail / quote / history (§6.3) ---------------------------------

/** Route param for the asset read endpoints. */
export const assetIdParamSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * The stored, descriptive view of an asset (§6.3 header). Sourced from the
 * `assets` row, so it is always available even when the provider is degraded.
 */
export const assetSummarySchema = z
  .object({
    id: z.string().uuid(),
    providerId: z.string().min(1).max(64),
    providerRef: z.string().min(1).max(128),
    symbol: z.string(),
    name: z.string(),
    exchange: z.string().nullable(),
    currency: currencyCodeSchema,
    type: assetTypeSchema,
    isCustom: z.boolean(),
  })
  .strict();
export type AssetSummary = z.infer<typeof assetSummarySchema>;

/**
 * `GET /assets/:id` — meta + latest quote (§6.3). The meta always resolves from
 * the stored row; the quote is best-effort: `null` (with `stale: true`) when the
 * provider is down and nothing has ever been cached.
 */
export const assetDetailResponseSchema = z
  .object({
    asset: assetSummarySchema,
    quote: quoteSchema.nullable(),
    stale: z.boolean(),
    asOf: z.string().datetime().nullable(),
  })
  .strict();
export type AssetDetailResponse = z.infer<typeof assetDetailResponseSchema>;

/** `GET /assets/:id/quote` response. */
export const quoteResponseSchema = z
  .object({
    quote: quoteSchema,
    stale: z.boolean(),
    asOf: z.string().datetime(),
  })
  .strict();
export type QuoteResponse = z.infer<typeof quoteResponseSchema>;

/** `GET /assets/:id/history?range=` query. Range drives the candle interval (§5.3). */
export const historyQuerySchema = z.object({ range: historyRangeSchema });
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

/** `GET /assets/:id/history` response. `interval` is the §5.3 mapping of `range`. */
export const historyResponseSchema = z
  .object({
    range: historyRangeSchema,
    interval: historyIntervalSchema,
    points: z.array(pricePointSchema),
    stale: z.boolean(),
    asOf: z.string().datetime(),
  })
  .strict();
export type HistoryResponse = z.infer<typeof historyResponseSchema>;
