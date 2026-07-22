import { z } from 'zod';

/**
 * Market-data contracts (PROJECTPLAN.md §5.1–§5.4).
 *
 * Every price-like value in BetterTrack flows through the provider abstraction,
 * and every shape it speaks is defined once here so the API, the web client and
 * any future consumer derive their types from the same source. The provider
 * *interface* itself (the methods) lives in the API (`apps/api/src/providers`);
 * this module owns only the data shapes it exchanges.
 */

/** ISO-4217 currency code, e.g. `EUR`, `USD`. Upper-cased three letters. */
export const currencyCodeSchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code');
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/**
 * Exchange session state for an asset (§6.3 / §13.5 V5-P1 — the live-mode
 * market badge). Sourced from the provider's own field (Yahoo `marketState`)
 * and cached with the quote — never a hand-built exchange calendar. `open` also
 * covers always-on assets (crypto is 24/7 → always `open`). Absent/unknown ⇒ no
 * badge is rendered (never a wrong one).
 */
export const MARKET_STATES = ['open', 'closed', 'pre', 'post'] as const;
export const marketStateSchema = z.enum(MARKET_STATES);
export type MarketState = z.infer<typeof marketStateSchema>;

/** Asset taxonomy — mirrors the `assets.type` enum in §5.5. */
export const ASSET_TYPES = [
  'stock',
  'etf',
  'index',
  'fx',
  'commodity',
  'crypto',
  'custom',
] as const;
export const assetTypeSchema = z.enum(ASSET_TYPES);
export type AssetType = z.infer<typeof assetTypeSchema>;

/**
 * Opaque pointer to a tradable thing: which provider owns it and that
 * provider's own reference for it (§5.1). e.g. `{ providerId: 'yahoo',
 * providerRef: 'BAYN.DE' }`. Services route on `providerId`; nobody outside the
 * provider knows what `providerRef` means.
 */
export const assetRefSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    providerRef: z.string().min(1).max(128),
  })
  .strict();
export type AssetRef = z.infer<typeof assetRefSchema>;

/**
 * Chart range presets (§5.3). Each maps to a default candle interval and a
 * cache TTL; the API picks the interval, callers pick the range.
 */
export const HISTORY_RANGES = ['1D', '1W', '1M', '3M', '6M', '1Y', '5Y', 'MAX'] as const;
export const historyRangeSchema = z.enum(HISTORY_RANGES);
export type HistoryRange = z.infer<typeof historyRangeSchema>;

/** Candle granularity (§5.3). */
export const HISTORY_INTERVALS = ['1m', '15m', '30m', '1d', '1wk', '1mo'] as const;
export const historyIntervalSchema = z.enum(HISTORY_INTERVALS);
export type HistoryInterval = z.infer<typeof historyIntervalSchema>;

/** One result row from a provider/custom-asset search (§6.2). */
export const assetSearchResultSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    providerRef: z.string().min(1).max(128),
    symbol: z.string(),
    name: z.string(),
    exchange: z.string().nullable().optional(),
    type: assetTypeSchema,
    currency: currencyCodeSchema,
  })
  .strict();
export type AssetSearchResult = z.infer<typeof assetSearchResultSchema>;

/** A live-ish quote for one asset (§5.1). Amounts are in the asset's native currency. */
export const quoteSchema = z
  .object({
    price: z.number(),
    currency: currencyCodeSchema,
    prevClose: z.number().nullable().optional(),
    dayChangePct: z.number().nullable().optional(),
    /**
     * The exchange session the quote was observed in (§13.5 V5-P1 live badge):
     * the provider's own state field, cached with the quote. Absent when the
     * provider does not report it (secondary providers, custom assets) — the
     * client then renders no badge.
     */
    marketState: marketStateSchema.nullable().optional(),
    /** When the upstream last observed this price (ISO-8601). */
    asOf: z.string().datetime(),
  })
  .strict();
export type Quote = z.infer<typeof quoteSchema>;

/**
 * One point on a price series (§5.1, §5.3). `time` is ISO-8601 — a day for
 * daily closes, a timestamp for intraday candles. `close` is the
 * dividend/split-adjusted close in the asset's native currency (§5.2), so
 * backtests built on top are total-return.
 */
export const pricePointSchema = z
  .object({
    time: z.string().datetime(),
    close: z.number(),
  })
  .strict();
export type PricePoint = z.infer<typeof pricePointSchema>;

/** Descriptive metadata for an asset (§5.1). */
export const assetMetaSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    providerRef: z.string().min(1).max(128),
    symbol: z.string(),
    name: z.string(),
    exchange: z.string().nullable().optional(),
    currency: currencyCodeSchema,
    type: assetTypeSchema,
  })
  .strict();
export type AssetMeta = z.infer<typeof assetMetaSchema>;

/**
 * Resilience envelope around any cached provider value (§5.1). `stale: true`
 * means the upstream was unreachable and this is the last-known-good value
 * served under stale-while-revalidate rather than an error. `asOf` is the epoch
 * millisecond at which the wrapped value was fetched from upstream.
 */
export interface CachedResult<T> {
  value: T;
  stale: boolean;
  asOf: number;
}
