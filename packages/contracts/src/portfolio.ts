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
    /**
     * Sticky default funding source for transaction entry (§14, #220): whether
     * "pay from cash" is preselected. Persisted + returned only — the client
     * preselects from it and always sends explicit flags; the backend never
     * applies it silently.
     */
    defaultPayFromCash: z.boolean(),
    /**
     * Soft-archive timestamp (§13.2 V2-P8): ISO-8601 when the portfolio was
     * archived, or `null` while active. Archived portfolios are hidden from the
     * default list (returned only via `?includeArchived=true`) but restorable;
     * they are never the default. The default-portfolio invariant considers
     * only active rows, so archive/restore can never leave a user with zero
     * usable portfolios.
     */
    archivedAt: z.string().datetime().nullable(),
  })
  .strict();
export type PortfolioSummary = z.infer<typeof portfolioSummarySchema>;

/**
 * `GET /portfolios?includeArchived=` query (§13.2 V2-P8). Archived portfolios
 * are hidden by default; `includeArchived=true` returns them too. Arrives as a
 * query-string token, so it is an explicit `'true' | 'false'` enum rather than
 * a boolean coercion (`z.coerce.boolean()` would turn the literal `"false"`
 * into `true`).
 */
export const portfolioListQuerySchema = z
  .object({
    includeArchived: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict();
export type PortfolioListQuery = z.infer<typeof portfolioListQuerySchema>;

/** `GET /portfolios` response — the user's portfolios (V1: the single default). */
export const portfolioListResponseSchema = z
  .object({ portfolios: z.array(portfolioSummarySchema) })
  .strict();
export type PortfolioListResponse = z.infer<typeof portfolioListResponseSchema>;

/** `POST /portfolios` body — create a named portfolio (§13.2 V2-P8). */
export const createPortfolioRequestSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict();
export type CreatePortfolioRequest = z.infer<typeof createPortfolioRequestSchema>;

/**
 * `POST /portfolios`, `POST /portfolios/:id/archive` and `.../restore` response
 * — the affected portfolio summary. One shape for the whole create/archive/
 * restore family so the client parses every mutation the same way.
 */
export const portfolioMutationResponseSchema = z
  .object({ portfolio: portfolioSummarySchema })
  .strict();
export type PortfolioMutationResponse = z.infer<typeof portfolioMutationResponseSchema>;

/** `PATCH /portfolios/:id` body — rename, change visibility, set sticky cash default (§6.8, §14). */
export const updatePortfolioRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    visibility: portfolioVisibilitySchema.optional(),
    defaultPayFromCash: z.boolean().optional(),
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

// --- Shared money bounds -----------------------------------------------------

/**
 * Upper bound on a single cash movement's EUR magnitude. The ledger column is
 * `numeric(20,6)`, so an unbounded amount (or a non-finite `Infinity`, which zod
 * `.number()` otherwise admits) would reach Postgres as an overflow/`Infinity`
 * and surface as a 500 instead of a clean 400. A trillion-euro cap keeps every
 * realistic entry while making the input fail loud and early.
 */
export const MAX_CASH_AMOUNT_EUR = 1_000_000_000_000;

/** A positive, finite EUR magnitude within the ledger's representable range. */
const cashAmountEurSchema = z.number().positive().finite().max(MAX_CASH_AMOUNT_EUR);

// --- Taxes (V3-P4, §13.3) ----------------------------------------------------

/**
 * Tax mode (V3-P4): `none` (default — exact pre-V3-P4 behavior), `manual_per_trade`
 * (optional user-entered tax on every sell/dividend, zero automation), or
 * `country_specific` (automated per country; AT only). The mode active when a
 * sell/dividend is *recorded* is frozen onto that row (§16 2026-07-08) —
 * switching later applies forward only and never rewrites history.
 */
export const TAX_MODES = ['none', 'manual_per_trade', 'country_specific'] as const;
export const taxModeSchema = z.enum(TAX_MODES);
export type TaxMode = z.infer<typeof taxModeSchema>;

/** Countries `country_specific` mode ships for (V3-P4: Austria only, §13.3). */
export const TAX_COUNTRIES = ['AT'] as const;
export const taxCountrySchema = z.enum(TAX_COUNTRIES);
export type TaxCountry = z.infer<typeof taxCountrySchema>;

/** `GET /settings/taxes` + `PATCH /settings/taxes` response — the caller's tax mode. */
export const taxSettingsResponseSchema = z
  .object({
    mode: taxModeSchema,
    /** Set exactly when `mode` is `country_specific`. */
    country: taxCountrySchema.nullable(),
  })
  .strict();
export type TaxSettingsResponse = z.infer<typeof taxSettingsResponseSchema>;

/**
 * `PATCH /settings/taxes` body (Settings → Taxes, V3-P4). `country` is
 * required with `country_specific` and rejected with any other mode — the
 * pair is unrepresentable inconsistently, mirroring the DB CHECK.
 */
export const updateTaxSettingsRequestSchema = z
  .object({
    mode: taxModeSchema,
    country: taxCountrySchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.mode === 'country_specific' && val.country === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['country'],
        message: 'country_specific mode requires a country.',
      });
    }
    if (val.mode !== 'country_specific' && val.country !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['country'],
        message: 'A country applies only to country_specific mode.',
      });
    }
  });
export type UpdateTaxSettingsRequest = z.infer<typeof updateTaxSettingsRequestSchema>;

/**
 * Reject a manual tax entry that states both an absolute amount and a rate —
 * shared by the sell (transaction) and dividend inputs. Whether a manual entry
 * is allowed at all depends on the caller's tax mode, which the service
 * enforces (only `manual_per_trade` accepts one).
 */
const refineManualTaxEntry = (
  val: { taxAmountEur?: number; taxRatePct?: number },
  ctx: z.RefinementCtx,
): void => {
  if (val.taxAmountEur !== undefined && val.taxRatePct !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taxAmountEur'],
      message: 'Provide a manual tax amount OR a rate, not both.',
    });
  }
};

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
    /**
     * Cash-ledger linkage (§14, #220). On a BUY, `payFromCash` funds the buy
     * from the portfolio's EUR cash balance (a linked internal `buy` movement,
     * rejected if it would overdraw); on a SELL, `addProceedsToCash` books the
     * net proceeds into cash (a `sell_proceeds` movement). A flag that does not
     * match the side is rejected. Both default to off. `cashSourceId` picks
     * which cash source funds/receives the movement (V3-P3), defaulting to the
     * portfolio's Main source; it requires one of the two flags.
     */
    payFromCash: z.boolean().optional(),
    addProceedsToCash: z.boolean().optional(),
    cashSourceId: z.string().uuid().optional(),
    /**
     * Manual tax entry on a SELL (V3-P4, `manual_per_trade` mode only):
     * absolute EUR amount OR a percentage of the sell's realized gain — at
     * most one, both optional (no entry = no tax recorded). Rejected on buys,
     * in `none` mode (v2 behavior unchanged) and in `country_specific` mode
     * (the engine owns the computation there).
     */
    taxAmountEur: z.number().nonnegative().finite().max(MAX_CASH_AMOUNT_EUR).optional(),
    taxRatePct: z.number().min(0).max(100).optional(),
  })
  .strict()
  .superRefine(refineManualTaxEntry);
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
    /**
     * Cash balance line (§14, #220): EUR cash held in the portfolio, a
     * first-class overview figure = sum of signed cash movements
     * (`domain/cashLedger.cashBalance`). Held separately from `marketValueEur`
     * (holdings only) so the UI can show both and their sum.
     */
    cashEur: z.number(),
    /**
     * The headline figure (#311): the portfolio's net worth,
     * `marketValueEur + cashEur`. Cash is a component of what the portfolio
     * is worth, not a side number — the UI leads with this and shows the
     * invested/cash composition next to it.
     */
    totalValueEur: z.number(),
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

// --- Cash ledger ("Bargeld") -----------------------------------------------

/**
 * Cash-movement kind (§14, #220; V3-P3 §13.3). `deposit` / `withdrawal` are
 * external (money crossing the portfolio boundary — TWR cash flows); `buy` /
 * `sell_proceeds` are internal (cash ↔ shares form change, TWR-neutral);
 * `transfer_out` / `transfer_in` are the paired legs of an internal transfer
 * between two cash sources (money moving *inside* the portfolio — NEVER a TWR
 * flow). `dividend` / `tax_withholding` / `tax_refund` (V3-P4) are the tax
 * engine's postings — dividend income and its KESt/manual settlements — all
 * internal too, so performance reads net of taxes and inclusive of income.
 * Mirrors `domain/cashLedger.CASH_MOVEMENT_KINDS`.
 */
export const cashMovementKindSchema = z.enum([
  'deposit',
  'withdrawal',
  'buy',
  'sell_proceeds',
  'transfer_out',
  'transfer_in',
  'dividend',
  'tax_withholding',
  'tax_refund',
]);
export type CashMovementKind = z.infer<typeof cashMovementKindSchema>;

// --- Cash sources (V3-P3, §13.3) ---------------------------------------------

/** Cash-source type label (V3-P3): purely descriptive, no behavioral difference. */
export const CASH_SOURCE_TYPES = ['bank', 'retirement', 'cash', 'custom'] as const;
export const cashSourceTypeSchema = z.enum(CASH_SOURCE_TYPES);
export type CashSourceType = z.infer<typeof cashSourceTypeSchema>;

/**
 * One cash source (V3-P3): the auto-provisioned **Main** (`isMain`, the sticky
 * default target of every cash flow) or a named sibling ("Bank account X").
 * `balanceEur` is derived — the cent-exact sum of the source's signed movements
 * — never stored. Archived sources keep their queryable history (movements stay
 * in the ledger and in every roll-up) but leave the active listings; archiving
 * requires a €0.00 balance, so an archived source never hides money.
 */
export const cashSourceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: cashSourceTypeSchema,
    isMain: z.boolean(),
    archivedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    balanceEur: z.number(),
  })
  .strict();
export type CashSource = z.infer<typeof cashSourceSchema>;

/** `GET /portfolios/:id/cash/sources?includeArchived=` query (explicit enum, like the portfolio list). */
export const cashSourceListQuerySchema = z
  .object({
    includeArchived: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict();
export type CashSourceListQuery = z.infer<typeof cashSourceListQuerySchema>;

/** `GET /portfolios/:id/cash/sources` response — Main first, then by creation. */
export const cashSourceListResponseSchema = z
  .object({ sources: z.array(cashSourceSchema) })
  .strict();
export type CashSourceListResponse = z.infer<typeof cashSourceListResponseSchema>;

/** `POST /portfolios/:id/cash/sources` body — create a named source (V3-P3). */
export const createCashSourceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: cashSourceTypeSchema,
  })
  .strict();
export type CreateCashSourceRequest = z.infer<typeof createCashSourceRequestSchema>;

/** `PATCH /portfolios/:id/cash/sources/:sourceId` body — rename / relabel. */
export const updateCashSourceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    type: cashSourceTypeSchema.optional(),
  })
  .strict();
export type UpdateCashSourceRequest = z.infer<typeof updateCashSourceRequestSchema>;

/** Response of every single-source mutation (create / update / archive / restore). */
export const cashSourceResponseSchema = z.object({ source: cashSourceSchema }).strict();
export type CashSourceResponse = z.infer<typeof cashSourceResponseSchema>;

/** Route params for `/portfolios/:portfolioId/cash/sources/:sourceId` operations. */
export const cashSourceParamsSchema = z
  .object({ portfolioId: z.string().uuid(), sourceId: z.string().uuid() })
  .strict();

/**
 * One cash movement as returned to the owner (§14, V3-P3). `amountEur` is
 * **signed** (inflows positive, outflows negative), full precision;
 * `transactionId` links an internal `buy` / `sell_proceeds` movement to the
 * transaction it funded. `sourceId` is the cash source the movement belongs to;
 * a transfer leg additionally carries the pair's shared `transferId` and the
 * `counterpartSourceId` it moved money to/from (all three null where not
 * applicable).
 */
export const cashMovementSchema = z
  .object({
    id: z.string().uuid(),
    kind: cashMovementKindSchema,
    amountEur: z.number(),
    sourceId: z.string().uuid(),
    transactionId: z.string().uuid().nullable(),
    transferId: z.string().uuid().nullable(),
    counterpartSourceId: z.string().uuid().nullable(),
    /** The dividend a `dividend` inflow / its tax settlement belongs to (V3-P4). */
    dividendId: z.string().uuid().nullable(),
    /** Europe/Vienna tax year a `tax_withholding` / `tax_refund` settles (V3-P4). */
    taxYear: z.number().int().nullable(),
    executedAt: z.string().datetime(),
    note: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CashMovement = z.infer<typeof cashMovementSchema>;

/**
 * `GET /portfolios/:id/cash` response — every movement (all sources,
 * chronological), the portfolio's rolled-up balance across all sources, and the
 * sources themselves (archived ones included, so historical movements can
 * always resolve their source's name) with per-source balances — the liquidity
 * split (V3-P3).
 */
export const cashMovementsResponseSchema = z
  .object({
    balanceEur: z.number(),
    movements: z.array(cashMovementSchema),
    sources: z.array(cashSourceSchema),
  })
  .strict();
export type CashMovementsResponse = z.infer<typeof cashMovementsResponseSchema>;

/**
 * `POST /portfolios/:id/cash/deposit` and `.../withdraw` body — a positive EUR
 * **magnitude**; the service assigns the sign by kind. `executedAt` defaults to
 * now (server-side) when omitted. `sourceId` picks the cash source (V3-P3) and
 * defaults to the portfolio's Main source when omitted.
 */
export const cashEntryRequestSchema = z
  .object({
    amountEur: cashAmountEurSchema,
    sourceId: z.string().uuid().optional(),
    executedAt: z.string().datetime().optional(),
    note: z.string().max(1000).nullish(),
  })
  .strict();
export type CashEntryRequest = z.infer<typeof cashEntryRequestSchema>;

/**
 * `POST /portfolios/:id/cash/deposit|withdraw` response — the new movement, the
 * affected source's balance, and the portfolio's rolled-up balance.
 */
export const cashMovementResponseSchema = z
  .object({
    movement: cashMovementSchema,
    sourceBalanceEur: z.number(),
    balanceEur: z.number(),
  })
  .strict();
export type CashMovementResponse = z.infer<typeof cashMovementResponseSchema>;

/**
 * `POST /portfolios/:id/cash/preview` body — a proposed movement of `kind` and
 * positive EUR magnitude, for the live "available → after" preview. Read-only:
 * no movement is persisted. Solvency is per source (V3-P3), so the preview is
 * scoped to `sourceId` (Main when omitted).
 */
export const cashPreviewRequestSchema = z
  .object({
    kind: cashMovementKindSchema,
    amountEur: cashAmountEurSchema,
    sourceId: z.string().uuid().optional(),
  })
  .strict();
export type CashPreviewRequest = z.infer<typeof cashPreviewRequestSchema>;

/**
 * `POST /portfolios/:id/cash/preview` response — the source's balance before
 * and after the proposed movement, whether its cash suffices, and the shortfall
 * (0 when it does). No silent negative balances: an outflow beyond the balance
 * is reported as `sufficient: false` rather than applied.
 */
export const cashPreviewResponseSchema = z
  .object({
    availableEur: z.number(),
    afterEur: z.number(),
    sufficient: z.boolean(),
    shortfallEur: z.number(),
  })
  .strict();
export type CashPreviewResponse = z.infer<typeof cashPreviewResponseSchema>;

/**
 * `POST /portfolios/:id/cash/transfer` body — move a positive EUR magnitude
 * between two *different* active sources of the same portfolio (V3-P3). Written
 * as an atomic pair of movements (`transfer_out` on `fromSourceId`,
 * `transfer_in` on `toSourceId`) sharing one `transferId` — double-entry style,
 * so both histories carry the transfer and the roll-up is unchanged. NEVER a
 * TWR external flow. `executedAt` defaults to now.
 */
export const cashTransferRequestSchema = z
  .object({
    fromSourceId: z.string().uuid(),
    toSourceId: z.string().uuid(),
    amountEur: cashAmountEurSchema,
    executedAt: z.string().datetime().optional(),
    note: z.string().max(1000).nullish(),
  })
  .strict();
export type CashTransferRequest = z.infer<typeof cashTransferRequestSchema>;

/** `POST /portfolios/:id/cash/transfer` response — both legs + resulting balances. */
export const cashTransferResponseSchema = z
  .object({
    outgoing: cashMovementSchema,
    incoming: cashMovementSchema,
    fromBalanceEur: z.number(),
    toBalanceEur: z.number(),
    /** Portfolio roll-up across all sources — unchanged by the transfer. */
    balanceEur: z.number(),
  })
  .strict();
export type CashTransferResponse = z.infer<typeof cashTransferResponseSchema>;

/**
 * `POST /portfolios/:id/cash/sources/:sourceId/set-balance` body — "set balance
 * to X" (V3-P3, §16 2026-07-07): the server computes the signed delta from the
 * source's current balance itself and records it as a *normal* deposit /
 * withdrawal movement, keeping the audit trail intact — no head-math when
 * reconciling with what the bank says. Always effective now (no back-dating).
 */
export const setCashBalanceRequestSchema = z
  .object({
    balanceEur: z.number().nonnegative().finite().max(MAX_CASH_AMOUNT_EUR),
    note: z.string().max(1000).nullish(),
  })
  .strict();
export type SetCashBalanceRequest = z.infer<typeof setCashBalanceRequestSchema>;

/**
 * Set-balance response. `movement` is the recorded deposit/withdrawal carrying
 * the signed delta, or null when the target already equals the current balance
 * (a no-op records nothing); `sourceBalanceEur` reads exactly the requested
 * target afterwards.
 */
export const setCashBalanceResponseSchema = z
  .object({
    movement: cashMovementSchema.nullable(),
    deltaEur: z.number(),
    sourceBalanceEur: z.number(),
    balanceEur: z.number(),
  })
  .strict();
export type SetCashBalanceResponse = z.infer<typeof setCashBalanceResponseSchema>;

// --- Dividends (V3-P4, §13.3) ------------------------------------------------

/**
 * `POST /portfolios/:id/dividends` body — record a dividend on a held asset:
 * gross EUR amount on a pay date, landing in `cashSourceId` (Main when
 * omitted) as a `dividend` movement. Cash is EUR-only, so the gross amount is
 * entered in EUR regardless of the asset's native currency. Taxed per the
 * caller's mode at recording: the optional manual entry follows the same
 * rules as on sells (`manual_per_trade` only, amount or rate, never both).
 * `executedAt` defaults to now.
 */
export const createDividendRequestSchema = z
  .object({
    assetId: z.string().uuid(),
    grossAmountEur: cashAmountEurSchema,
    executedAt: z.string().datetime().optional(),
    cashSourceId: z.string().uuid().optional(),
    note: z.string().max(1000).nullish(),
    taxAmountEur: z.number().nonnegative().finite().max(MAX_CASH_AMOUNT_EUR).optional(),
    taxRatePct: z.number().min(0).max(100).optional(),
  })
  .strict()
  .superRefine(refineManualTaxEntry);
export type CreateDividendRequest = z.infer<typeof createDividendRequestSchema>;

/**
 * One recorded dividend (V3-P4). The tax facts are frozen at recording time
 * (§16 2026-07-08): `taxMode` is the mode that applied then and `taxAmountEur`
 * the tax it produced (signed; `null` = none recorded) — later mode switches
 * or corrections never rewrite them.
 */
export const dividendSchema = z
  .object({
    id: z.string().uuid(),
    assetId: z.string().uuid(),
    grossAmountEur: z.number(),
    executedAt: z.string().datetime(),
    note: z.string().nullable(),
    taxMode: taxModeSchema,
    taxCountry: taxCountrySchema.nullable(),
    taxAmountEur: z.number().nullable(),
    cashSourceId: z.string().uuid(),
    createdAt: z.string().datetime(),
    asset: portfolioAssetSchema,
  })
  .strict();
export type Dividend = z.infer<typeof dividendSchema>;

/** `GET /portfolios/:id/dividends` response, newest pay date first. */
export const dividendListResponseSchema = z.object({ dividends: z.array(dividendSchema) }).strict();
export type DividendListResponse = z.infer<typeof dividendListResponseSchema>;

/**
 * `POST /portfolios/:id/dividends` response — the dividend plus the cash
 * movements it posted (the gross `dividend` inflow and, when taxed, its
 * settlement), with the affected source's and the portfolio's balances.
 */
export const createDividendResponseSchema = z
  .object({
    dividend: dividendSchema,
    movements: z.array(cashMovementSchema),
    sourceBalanceEur: z.number(),
    balanceEur: z.number(),
  })
  .strict();
export type CreateDividendResponse = z.infer<typeof createDividendResponseSchema>;

/** Route params for `/portfolios/:portfolioId/dividends/:dividendId`. */
export const dividendParamsSchema = z
  .object({ portfolioId: z.string().uuid(), dividendId: z.string().uuid() })
  .strict();

// --- Per-year tax report (V3-P4, §13.3) ---------------------------------------

/**
 * One Europe/Vienna calendar year of one portfolio (V3-P4d). `realizedPnlEur`
 * and `dividendsGrossEur` are financial facts across ALL rows of the year
 * regardless of tax mode (realized P/L in EUR at each trade's own date-FX);
 * the tax figures are the *current* movement-level truth: `taxWithheldEur` /
 * `taxRefundedEur` sum the year's settlement movements (corrections included)
 * and `taxNetEur = taxWithheldEur − taxRefundedEur` is what the year holds.
 */
export const taxYearSummarySchema = z
  .object({
    year: z.number().int(),
    realizedPnlEur: z.number(),
    dividendsGrossEur: z.number(),
    taxWithheldEur: z.number(),
    taxRefundedEur: z.number(),
    taxNetEur: z.number(),
  })
  .strict();
export type TaxYearSummary = z.infer<typeof taxYearSummarySchema>;

/** `GET /portfolios/:id/reports/tax-years` response — newest year first. */
export const taxYearListResponseSchema = z
  .object({ years: z.array(taxYearSummarySchema) })
  .strict();
export type TaxYearListResponse = z.infer<typeof taxYearListResponseSchema>;

/**
 * One sell inside the year drill-down: its EUR realization against the
 * moving-average basis (current truth, recomputed) next to the tax facts
 * frozen on the row at recording time (`taxMode` null = pre-engine row).
 */
export const taxYearSellSchema = z
  .object({
    transactionId: z.string().uuid(),
    executedAt: z.string().datetime(),
    quantity: z.number(),
    proceedsEur: z.number(),
    costBasisEur: z.number(),
    realizedPnlEur: z.number(),
    taxMode: taxModeSchema.nullable(),
    taxAmountEur: z.number().nullable(),
  })
  .strict();
export type TaxYearSell = z.infer<typeof taxYearSellSchema>;

/** One dividend inside the year drill-down. */
export const taxYearDividendSchema = z
  .object({
    dividendId: z.string().uuid(),
    executedAt: z.string().datetime(),
    grossAmountEur: z.number(),
    taxMode: taxModeSchema,
    taxAmountEur: z.number().nullable(),
  })
  .strict();
export type TaxYearDividend = z.infer<typeof taxYearDividendSchema>;

/**
 * Per-position drill-down of a year (V3-P4d): the asset's realized P/L,
 * dividends and the taxes *recorded on its rows* (`taxEur` — year-level
 * corrections are portfolio-wide and appear only in the summary), plus every
 * underlying sell/dividend.
 */
export const taxYearPositionSchema = z
  .object({
    asset: portfolioAssetSchema,
    realizedPnlEur: z.number(),
    dividendsGrossEur: z.number(),
    taxEur: z.number(),
    sells: z.array(taxYearSellSchema),
    dividends: z.array(taxYearDividendSchema),
  })
  .strict();
export type TaxYearPosition = z.infer<typeof taxYearPositionSchema>;

/** `GET /portfolios/:id/reports/tax-years/:year` response. */
export const taxYearReportResponseSchema = z
  .object({
    year: z.number().int(),
    summary: taxYearSummarySchema,
    positions: z.array(taxYearPositionSchema),
  })
  .strict();
export type TaxYearReportResponse = z.infer<typeof taxYearReportResponseSchema>;

/** Route params for `/portfolios/:portfolioId/reports/tax-years/:year`. */
export const taxYearParamsSchema = z
  .object({
    portfolioId: z.string().uuid(),
    year: z.coerce.number().int().min(1900).max(3000),
  })
  .strict();

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
