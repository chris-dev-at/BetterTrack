import { z } from 'zod';

import { assetTypeSchema, currencyCodeSchema } from './market';

/**
 * Portfolio + custom-asset contracts (PROJECTPLAN.md §6.9, §8).
 *
 * Transactions are the source of truth; holdings and the value-over-time series
 * are *derived* (never stored) by `apps/api/src/domain/holdings`. Every wire
 * shape the portfolio surface speaks is defined once here so the API and the web
 * client derive their types from the same source. Money values cross the wire as
 * plain `number`s at full precision — display rounding lives in the client
 * (§5.4), never in the contract.
 */

// --- Portfolios (the list + a single portfolio) ----------------------------

/**
 * Per-portfolio visibility (§6.8/§6.9): `private` (default) or `friends`. V1
 * stores + exposes this flag only; social consumption is P5 (§6.9).
 */
export const portfolioVisibilitySchema = z.enum(['private', 'friends']);
export type PortfolioVisibility = z.infer<typeof portfolioVisibilitySchema>;

/**
 * One portfolio in the list (§6.8, §7.2). V1 auto-creates exactly one "Main"
 * per user — `isDefault` marks it — but the shape is already multi-portfolio so
 * additional rows are purely additive.
 */
export const portfolioSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    visibility: portfolioVisibilitySchema,
    sortOrder: z.number().int(),
    isDefault: z.boolean(),
  })
  .strict();
export type PortfolioSummary = z.infer<typeof portfolioSummarySchema>;

/** `GET /portfolios` response — the user's portfolios (V1: the single default). */
export const portfolioListResponseSchema = z
  .object({ portfolios: z.array(portfolioSummarySchema) })
  .strict();
export type PortfolioListResponse = z.infer<typeof portfolioListResponseSchema>;

/** `PATCH /portfolios/:id` body — rename and/or change visibility (§6.8). */
export const updatePortfolioRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    visibility: portfolioVisibilitySchema.optional(),
  })
  .strict();
export type UpdatePortfolioRequest = z.infer<typeof updatePortfolioRequestSchema>;

/** `PATCH /portfolios/:id` response — the updated portfolio summary (§6.8). */
export const updatePortfolioResponseSchema = z
  .object({ portfolio: portfolioSummarySchema })
  .strict();
export type UpdatePortfolioResponse = z.infer<typeof updatePortfolioResponseSchema>;

/** Route param for every `/portfolios/:portfolioId/…` endpoint. */
export const portfolioIdParamSchema = z.object({ portfolioId: z.string().uuid() }).strict();

/** Route params for `/portfolios/:portfolioId/transactions/:txId` mutations. */
export const portfolioTransactionParamsSchema = z
  .object({ portfolioId: z.string().uuid(), txId: z.string().uuid() })
  .strict();

// --- Transactions ----------------------------------------------------------

/** BUY adds to a position; SELL reduces it (§6.9). */
export const transactionSideSchema = z.enum(['buy', 'sell']);
export type TransactionSide = z.infer<typeof transactionSideSchema>;

/**
 * One transaction as submitted by the client (§6.9). Amounts are in the asset's
 * **native currency**. `quantity` is strictly positive; `price` and `fee` are
 * non-negative. `executedAt` is an ISO-8601 timestamp (its date portion is the
 * day key for the value-over-time series).
 */
export const transactionInputSchema = z
  .object({
    assetId: z.string().uuid(),
    side: transactionSideSchema,
    quantity: z.number().positive(),
    price: z.number().nonnegative(),
    fee: z.number().nonnegative().default(0),
    executedAt: z.string().datetime(),
    note: z.string().max(1000).nullish(),
  })
  .strict();
export type TransactionInput = z.infer<typeof transactionInputSchema>;

/**
 * `POST /portfolios/:id/transactions` request body — single **or bulk** (the buy
 * flow, §6.9). A bare transaction object is accepted, as is `{ transactions:
 * [...] }` with one or more rows. The bulk form is tried first so the
 * discriminating `transactions` key wins.
 */
export const createTransactionsRequestSchema = z.union([
  z.object({ transactions: z.array(transactionInputSchema).min(1).max(500) }).strict(),
  transactionInputSchema,
]);
export type CreateTransactionsRequest = z.infer<typeof createTransactionsRequestSchema>;

/** `PATCH /portfolios/:id/transactions/:txId` body — every field optional. */
export const updateTransactionRequestSchema = z
  .object({
    side: transactionSideSchema.optional(),
    quantity: z.number().positive().optional(),
    price: z.number().nonnegative().optional(),
    fee: z.number().nonnegative().optional(),
    executedAt: z.string().datetime().optional(),
    note: z.string().max(1000).nullish(),
  })
  .strict();
export type UpdateTransactionRequest = z.infer<typeof updateTransactionRequestSchema>;

/** Asset metadata embedded in a transaction / holding row for display (§6.9). */
export const portfolioAssetSchema = z
  .object({
    id: z.string().uuid(),
    symbol: z.string(),
    name: z.string(),
    exchange: z.string().nullable(),
    currency: currencyCodeSchema,
    type: assetTypeSchema,
    isCustom: z.boolean(),
  })
  .strict();
export type PortfolioAsset = z.infer<typeof portfolioAssetSchema>;

/** One stored transaction, enriched with its asset metadata (§6.9, §8). */
export const transactionSchema = z
  .object({
    id: z.string().uuid(),
    assetId: z.string().uuid(),
    side: transactionSideSchema,
    quantity: z.number(),
    price: z.number(),
    fee: z.number(),
    executedAt: z.string().datetime(),
    note: z.string().nullable(),
    asset: portfolioAssetSchema,
  })
  .strict();
export type Transaction = z.infer<typeof transactionSchema>;

/** `GET /portfolios/:id/transactions?cursor=` response (keyset paginated, newest first). */
export const transactionListResponseSchema = z
  .object({
    items: z.array(transactionSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type TransactionListResponse = z.infer<typeof transactionListResponseSchema>;

/** Cursor pagination query for the transaction ledger. */
export const transactionListQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;

// --- Holdings + totals (`GET /portfolios/:id`) ------------------------------

/**
 * One row of the holdings view (§6.9). Native-currency facts sit alongside
 * EUR-converted figures; every EUR figure is `null` when it cannot be computed
 * (no quote, or a flat position). Mirrors the `domain/holdings` `Holding` shape
 * plus the asset metadata the page renders.
 */
export const holdingSchema = z
  .object({
    asset: portfolioAssetSchema,
    quantity: z.number(),
    avgCost: z.number(),
    realizedPnl: z.number(),
    price: z.number().nullable(),
    marketValueEur: z.number().nullable(),
    costBasisEur: z.number().nullable(),
    unrealizedPnlEur: z.number().nullable(),
    unrealizedPnlPct: z.number().nullable(),
    dayChangeEur: z.number().nullable(),
    dayChangePct: z.number().nullable(),
  })
  .strict();
export type Holding = z.infer<typeof holdingSchema>;

/** Portfolio totals header (§6.9): the at-a-glance numbers across all holdings. */
export const portfolioTotalsSchema = z
  .object({
    marketValueEur: z.number(),
    investedEur: z.number(),
    unrealizedPnlEur: z.number(),
    unrealizedPnlPct: z.number().nullable(),
    dayChangeEur: z.number(),
    dayChangePct: z.number().nullable(),
  })
  .strict();
export type PortfolioTotals = z.infer<typeof portfolioTotalsSchema>;

/** `GET /portfolios/:id` response — holdings + totals (§6.9, §8). */
export const portfolioResponseSchema = z
  .object({
    baseCurrency: currencyCodeSchema,
    holdings: z.array(holdingSchema),
    totals: portfolioTotalsSchema,
  })
  .strict();
export type PortfolioResponse = z.infer<typeof portfolioResponseSchema>;

// --- Value over time (`GET /portfolios/:id/history`) ----------------------------

/** Portfolio history ranges (§6.9): 1M / 6M / 1Y / Max. */
export const PORTFOLIO_HISTORY_RANGES = ['1M', '6M', '1Y', 'MAX'] as const;
export const portfolioHistoryRangeSchema = z.enum(PORTFOLIO_HISTORY_RANGES);
export type PortfolioHistoryRange = z.infer<typeof portfolioHistoryRangeSchema>;

/**
 * `GET /portfolios/:id/history?range=&overlay=` query. `overlay=true` additionally
 * returns each held asset's own daily price series (issue #122) so the chart
 * can overlay them on the portfolio curve; it arrives as a query-string token,
 * so it is an explicit `'true' | 'false'` enum rather than a boolean coercion
 * (`z.coerce.boolean()` would turn the literal string `"false"` into `true`).
 */
export const portfolioHistoryQuerySchema = z
  .object({
    range: portfolioHistoryRangeSchema.default('MAX'),
    overlay: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict();
export type PortfolioHistoryQuery = z.infer<typeof portfolioHistoryQuerySchema>;

/** One point on the portfolio value-over-time series, EUR (§6.9). */
export const portfolioHistoryPointSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    valueEur: z.number(),
  })
  .strict();
export type PortfolioHistoryPoint = z.infer<typeof portfolioHistoryPointSchema>;

/** One point of an overlay asset's daily price series, **native currency**. */
export const portfolioHistoryOverlayPointSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    close: z.number(),
  })
  .strict();
export type PortfolioHistoryOverlayPoint = z.infer<typeof portfolioHistoryOverlayPointSchema>;

/**
 * One held asset's own daily price series, returned alongside the portfolio
 * curve when `overlay=true` (issue #122). Closes are in the asset's **native
 * currency** — the chart renders overlays in normalized (percentage) mode, which
 * is scale- and currency-invariant, so no EUR conversion is done here and the
 * series honestly shows the asset's own movement ("when Bayer tanked…").
 */
export const portfolioHistoryOverlaySchema = z
  .object({
    assetId: z.string().uuid(),
    symbol: z.string(),
    name: z.string(),
    currency: currencyCodeSchema,
    points: z.array(portfolioHistoryOverlayPointSchema),
  })
  .strict();
export type PortfolioHistoryOverlay = z.infer<typeof portfolioHistoryOverlaySchema>;

/**
 * One point on the cash-flow-neutralized performance series (issue #125):
 * cumulative time-weighted return since the selected range's start, percent.
 * Deposits cause no jump — the curve moves only when holdings move.
 */
export const portfolioPerformancePointSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    pct: z.number(),
  })
  .strict();
export type PortfolioPerformancePoint = z.infer<typeof portfolioPerformancePointSchema>;

/** `GET /portfolios/:id/history` response. `assets` is present only when `overlay=true`. */
export const portfolioHistoryResponseSchema = z
  .object({
    range: portfolioHistoryRangeSchema,
    baseCurrency: currencyCodeSchema,
    points: z.array(portfolioHistoryPointSchema),
    /** Performance-% display mode data (issue #125), same daily grid as `points`. */
    performance: z.array(portfolioPerformancePointSchema),
    assets: z.array(portfolioHistoryOverlaySchema).optional(),
  })
  .strict();
export type PortfolioHistoryResponse = z.infer<typeof portfolioHistoryResponseSchema>;

// --- Custom assets ---------------------------------------------------------

/** Custom-investment categories (§6.9). */
export const CUSTOM_ASSET_CATEGORIES = [
  'real_estate',
  'vehicle',
  'collectible',
  'cash',
  'unlisted_stock',
  'other',
] as const;
export const customAssetCategorySchema = z.enum(CUSTOM_ASSET_CATEGORIES);
export type CustomAssetCategory = z.infer<typeof customAssetCategorySchema>;

/** Optional initial purchase, recorded as a BUY transaction (§6.9). */
export const initialPurchaseSchema = z
  .object({
    quantity: z.number().positive(),
    price: z.number().nonnegative(),
    fee: z.number().nonnegative().default(0),
    executedAt: z.string().datetime(),
    note: z.string().max(1000).nullish(),
  })
  .strict();
export type InitialPurchase = z.infer<typeof initialPurchaseSchema>;

/** `POST /custom-assets` request body (§6.9). */
export const createCustomAssetRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    category: customAssetCategorySchema,
    currency: currencyCodeSchema,
    initialPurchase: initialPurchaseSchema.optional(),
  })
  .strict();
export type CreateCustomAssetRequest = z.infer<typeof createCustomAssetRequestSchema>;

/**
 * `PATCH /custom-assets/:id` body. Name and category are editable; the currency
 * is immutable once created — native prices and value points are already
 * recorded against it, so re-denominating would silently corrupt the money math
 * (§5.4).
 */
export const updateCustomAssetRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    category: customAssetCategorySchema.optional(),
  })
  .strict();
export type UpdateCustomAssetRequest = z.infer<typeof updateCustomAssetRequestSchema>;

/** A custom asset as returned to its owner (§6.9). */
export const customAssetSchema = z
  .object({
    id: z.string().uuid(),
    symbol: z.string(),
    name: z.string(),
    category: customAssetCategorySchema,
    currency: currencyCodeSchema,
    type: assetTypeSchema,
  })
  .strict();
export type CustomAsset = z.infer<typeof customAssetSchema>;

/** `POST /custom-assets` response: the asset plus the initial BUY id when created. */
export const createCustomAssetResponseSchema = z
  .object({
    asset: customAssetSchema,
    transactionId: z.string().uuid().nullable(),
  })
  .strict();
export type CreateCustomAssetResponse = z.infer<typeof createCustomAssetResponseSchema>;

// --- Value points ----------------------------------------------------------

/** One value point of a custom asset: a value on a calendar day (§6.9). */
export const valuePointSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be ISO YYYY-MM-DD'),
    value: z.number().nonnegative(),
  })
  .strict();
export type ValuePoint = z.infer<typeof valuePointSchema>;

/** `GET /custom-assets/:id/value-points` response, ascending by date. */
export const valuePointsResponseSchema = z.object({ points: z.array(valuePointSchema) }).strict();
export type ValuePointsResponse = z.infer<typeof valuePointsResponseSchema>;

/**
 * `PUT /custom-assets/:id/value-points` body — the full desired set, one row per
 * day (§6.9). A single replace expresses add / edit / delete at once. Duplicate
 * dates are rejected by the service.
 */
export const putValuePointsRequestSchema = z
  .object({ points: z.array(valuePointSchema).max(10000) })
  .strict();
export type PutValuePointsRequest = z.infer<typeof putValuePointsRequestSchema>;

/** Route param for custom-asset operations. */
export const customAssetIdParamSchema = z.object({ id: z.string().uuid() }).strict();
