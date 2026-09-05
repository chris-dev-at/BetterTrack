import { z } from 'zod';

import { currencyCodeSchema } from './market';

/**
 * Market-intelligence contracts (PROJECTPLAN.md §13.5 V5-P5). The four event
 * families — dividends, earnings, news and splits — are surfaced per asset over
 * the §5.1 provider abstraction. Each family is an **optional** provider
 * capability: a provider advertises only what it can serve, the registry reports
 * per-provider availability, and a global `MARKET_INTEL_ENABLED` gate can hide
 * the whole arc. When a capability is unavailable (gate off, provider lacks it,
 * or the upstream errored) the endpoints return the "unconfigured" shape —
 * `available: false` with empty data — so the follow-up UI stays invisible.
 *
 * The provider *interface* (the methods) lives in the API
 * (`apps/api/src/providers`); this module owns only the data shapes exchanged.
 */

/**
 * The four optional market-intelligence capabilities a provider MAY implement
 * (any subset). Ordered as the arcs appear in §13.5 V5-P5.
 */
export const MARKET_INTEL_CAPABILITIES = ['dividends', 'earnings', 'news', 'splits'] as const;
export const marketIntelCapabilitySchema = z.enum(MARKET_INTEL_CAPABILITIES);
export type MarketIntelCapability = z.infer<typeof marketIntelCapabilitySchema>;

/**
 * Per-capability availability for one provider (or the resolved provider of an
 * asset). Every flag is `false` when the global gate is off or the provider
 * implements no intel capability.
 */
export const marketIntelCapabilitiesSchema = z
  .object({
    dividends: z.boolean(),
    earnings: z.boolean(),
    news: z.boolean(),
    splits: z.boolean(),
  })
  .strict();
export type MarketIntelCapabilities = z.infer<typeof marketIntelCapabilitiesSchema>;

/**
 * `GET /assets/:id/intel` — the capability descriptor the follow-up UI reads to
 * decide which intel blocks to render. `enabled` is the global gate; when it is
 * false every capability flag is false too (invisible when unconfigured).
 */
export const marketIntelStatusResponseSchema = z
  .object({
    enabled: z.boolean(),
    capabilities: marketIntelCapabilitiesSchema,
  })
  .strict();
export type MarketIntelStatusResponse = z.infer<typeof marketIntelStatusResponseSchema>;

// ── Dividends (arc a) ────────────────────────────────────────────────────────

/**
 * One historical or upcoming cash dividend. `amount` is the per-share payout in
 * `currency`, already scaled out of any minor unit (e.g. London pence → GBP), so
 * it is never silently off by 100×. Dates are ISO-8601; a provider's history
 * often carries only the ex-date, and a forward calendar often only the dates.
 */
export const dividendEventSchema = z
  .object({
    exDate: z.string().datetime().nullable(),
    payDate: z.string().datetime().nullable(),
    amount: z.number().nonnegative().nullable(),
    currency: currencyCodeSchema.nullable(),
  })
  .strict();
export type DividendEvent = z.infer<typeof dividendEventSchema>;

/**
 * Which basis an annual dividend-per-share figure carries. The two are NOT
 * interchangeable, and a provider commonly populates only one of them:
 *
 * - `trailing-12m` — the **realized** sum of the last twelve months' payouts, so
 *   it INCLUDES one-off special dividends (a company that just paid one reads
 *   high for a full year afterwards).
 * - `forward-annualized` — the last **regular** payout × its frequency, so it
 *   EXCLUDES specials but assumes the regular schedule continues unchanged.
 *
 * Right after a special payout the two can differ by a large factor, so a
 * consumer that projects forward from the number must be able to see which one
 * it got — hence {@link dividendEventsSchema.shape.trailingAmountBasis}.
 */
export const DIVIDEND_AMOUNT_BASES = ['trailing-12m', 'forward-annualized'] as const;
export const dividendAmountBasisSchema = z.enum(DIVIDEND_AMOUNT_BASES);
export type DividendAmountBasis = z.infer<typeof dividendAmountBasisSchema>;

/**
 * The basis a whole-book projection carries: one of the two per-holding bases
 * when every contributing holding shared it, or `mixed` when they did not —
 * which is a real state, not an error. Providers populate whichever field they
 * have per asset, so one total legitimately sums a `trailing-12m` holding and a
 * `forward-annualized` one; the projection says so instead of presenting the sum
 * as a single kind of number (#1790).
 */
export const DIVIDEND_PROJECTION_BASES = [...DIVIDEND_AMOUNT_BASES, 'mixed'] as const;
export const dividendProjectionBasisSchema = z.enum(DIVIDEND_PROJECTION_BASES);
export type DividendProjectionBasis = z.infer<typeof dividendProjectionBasisSchema>;

/**
 * Upper bound `forwardYield` is validated against: 1 = 100 %/yr, above any
 * forward yield a real payer carries.
 *
 * It is a **plausibility ceiling only — it cannot determine the field's unit**,
 * and it used to be documented as if it could. The convention is a fraction
 * (`0.015` ≈ 1.5 %) and a provider reporting percent renders 100× wrong, but no
 * bound at 1 separates the two conventions below 1.0: on a percent-reporting
 * build a 0.44 %-yielding name arrives as `0.44`, passes this bound, and reads
 * "44 %" — while every correct payer on that same build (`2.5`) is above the
 * bound and vanishes. Filtering on the bound alone therefore deletes the right
 * answers and keeps the wrong ones (#1790).
 *
 * Determining the unit is the provider mapper's job and needs evidence, not a
 * range: see `mapDividendEvents` in `apps/api/src/providers/yahooMapping.ts`,
 * which cross-checks the reported figure against the payload's own annual
 * dividend per share ÷ price and publishes only the reading that check confirms.
 * This bound stays as the schema's last sanity gate on the result.
 */
export const DIVIDEND_FORWARD_YIELD_MAX = 1;

/** The provider payload for the dividends capability. */
export const dividendEventsSchema = z
  .object({
    /** Canonical currency of the payouts, or null when the provider omitted it. */
    currency: currencyCodeSchema.nullable(),
    /**
     * Past payouts, ascending by ex-date. The read service dedupes and bounds
     * this list before it reaches a client (`DIVIDEND_HISTORY_MAX_EVENTS` in
     * `services/marketIntel/marketIntelService.ts`, where the news digest's
     * bound also lives) — a provider is not a trust boundary.
     */
    history: z.array(dividendEventSchema),
    /** Known upcoming ex/pay dates (forward calendar). */
    upcoming: z.array(dividendEventSchema),
    /**
     * Forward annual dividend yield as a **fraction** — `0.015` ≈ 1.5 % — where
     * cheaply available (arc e). Null when absent, and null whenever the
     * provider mapper could not *determine* that the upstream figure is in this
     * convention (see {@link DIVIDEND_FORWARD_YIELD_MAX}): an unpublished yield,
     * never a 100×-wrong one.
     */
    forwardYield: z.number().min(0).max(DIVIDEND_FORWARD_YIELD_MAX).nullable(),
    /**
     * Annual dividend per share in `currency`, where available — the forward
     * estimate a projection multiplies. Its basis is **not** fixed: providers
     * supply a realized trailing-12-month sum or a forward-annualized regular
     * rate depending on what they populate, so read `trailingAmountBasis` to
     * know which one this payload carries. (The field name is historical; it has
     * always carried whichever of the two the provider had.)
     */
    trailingAmount: z.number().nonnegative().nullable(),
    /**
     * Which basis {@link DIVIDEND_AMOUNT_BASES} `trailingAmount` carries. Null
     * exactly when `trailingAmount` is null — a number never travels without the
     * basis that explains it.
     */
    trailingAmountBasis: dividendAmountBasisSchema.nullable(),
  })
  .strict();
export type DividendEvents = z.infer<typeof dividendEventsSchema>;

/** `GET /assets/:id/intel/dividends` — the payload plus the availability signal. */
export const dividendsResponseSchema = dividendEventsSchema
  .extend({ available: z.boolean() })
  .strict();
export type DividendsResponse = z.infer<typeof dividendsResponseSchema>;

// ── Portfolio dividend intelligence (arc a, portfolio-level) ─────────────────
// Aggregations over the caller's own holdings + watchlists, computed on read
// from the same provider/cache keystone (NO storage). `available` mirrors the
// per-asset shape: it is the global `MARKET_INTEL_ENABLED` gate, so the UI hides
// the whole block when it is false (invisible when unconfigured).

/**
 * Roll-up completeness marker, shared by the three book-wide reads (dividend
 * calendar, dividend projection, news digest). Those reads fan out one provider
 * call per held/watched asset onto a shared, deliberately small outbound queue
 * (§5.3), so the server caps the fan-out per request. Present and `true` ONLY
 * when the caller's book exceeded that cap and the response therefore covers a
 * deterministic subset of it (held before watchlist-only, then by symbol);
 * absent means the whole book was covered. Optional so a complete roll-up keeps
 * exactly the shape it has always had.
 */
export const rollupTruncatedSchema = z.literal(true).optional();

/** Whether a calendar entry's asset is currently held or only watchlisted. */
export const DIVIDEND_CALENDAR_SOURCES = ['holding', 'watchlist'] as const;
export const dividendCalendarSourceSchema = z.enum(DIVIDEND_CALENDAR_SOURCES);
export type DividendCalendarSource = z.infer<typeof dividendCalendarSourceSchema>;

/**
 * One upcoming ex/pay event on the portfolio dividend calendar, carrying the
 * asset identity so the UI renders a row without a second lookup. `source`
 * distinguishes a held position from a watchlist-only asset (an asset that is
 * both resolves to `holding`).
 */
export const dividendCalendarEntrySchema = z
  .object({
    assetId: z.string(),
    symbol: z.string(),
    name: z.string(),
    source: dividendCalendarSourceSchema,
    exDate: z.string().datetime().nullable(),
    payDate: z.string().datetime().nullable(),
    amount: z.number().nonnegative().nullable(),
    currency: currencyCodeSchema.nullable(),
  })
  .strict();
export type DividendCalendarEntry = z.infer<typeof dividendCalendarEntrySchema>;

/**
 * `GET /assets/portfolio/dividend-calendar` — the caller's upcoming ex/pay
 * events across held + watchlist assets, ascending by the earliest of
 * ex-date/pay-date. `available: false` (gate off) ⇒ empty and hidden.
 */
export const dividendCalendarResponseSchema = z
  .object({
    available: z.boolean(),
    entries: z.array(dividendCalendarEntrySchema),
    truncated: rollupTruncatedSchema,
  })
  .strict();
export type DividendCalendarResponse = z.infer<typeof dividendCalendarResponseSchema>;

/**
 * One holding's projected annual dividend income. `annualPerShare` is the
 * forward estimate in the asset's **dividend** `currency` (the standard "assume
 * it continues" proxy) and `annualPerShareBasis` names which basis that estimate
 * carries. `annualIncomeBase` is `quantity × annualPerShare` converted once, at
 * the current spot rate, into the **response's** `currency` — the caller's base
 * (§5.4) — which is a different field from this holding's `currency`; the
 * suffix is what keeps the two apart.
 */
export const projectedDividendHoldingSchema = z
  .object({
    assetId: z.string(),
    symbol: z.string(),
    name: z.string(),
    quantity: z.number().nonnegative(),
    annualPerShare: z.number().nonnegative(),
    currency: currencyCodeSchema,
    annualPerShareBasis: dividendAmountBasisSchema,
    annualIncomeBase: z.number().nonnegative(),
  })
  .strict();
export type ProjectedDividendHolding = z.infer<typeof projectedDividendHoldingSchema>;

/**
 * `GET /assets/portfolio/dividend-projection` — projected dividend income for
 * the whole portfolio, monthly + yearly.
 *
 * `currency` is the **caller's base currency** (§5.4: EUR is the default, never
 * a constant), and every `…Base`-suffixed amount here and in `holdings` is
 * denominated in it. That is not cosmetic: the V5-P6b Forecast adds this figure
 * to a base-denominated net worth and renders the sum with the base's symbol, so
 * a EUR-pinned total would put two denominations under one label. The field
 * names deliberately no longer assert a currency — the payload names it.
 *
 * `monthlyTotalBase` is `yearlyTotalBase / 12` (an even spread — the clean
 * series shape the Forecast consumes). `available: false` (gate off, an
 * unresolvable holding, or a book over the fan-out cap) ⇒ zeros/empty and
 * hidden, with `currency` still naming the base those zeros are in.
 *
 * `basis` names what the totals are made of ({@link DIVIDEND_PROJECTION_BASES}),
 * and is null exactly when no holding contributed — an unavailable or all-zero
 * projection describes nothing. A `trailing-12m` total includes any special
 * dividend paid in the last twelve months and so reads well above true forward
 * income for a year afterwards: every surface that renders the total must render
 * this beside it, so the figure is not read as a forward promise (#1790).
 */
export const projectedDividendIncomeResponseSchema = z
  .object({
    available: z.boolean(),
    currency: currencyCodeSchema,
    monthlyTotalBase: z.number().nonnegative(),
    yearlyTotalBase: z.number().nonnegative(),
    basis: dividendProjectionBasisSchema.nullable(),
    holdings: z.array(projectedDividendHoldingSchema),
    truncated: rollupTruncatedSchema,
  })
  .strict();
export type ProjectedDividendIncomeResponse = z.infer<typeof projectedDividendIncomeResponseSchema>;

/**
 * Query for `GET /assets/portfolio/dividend-projection`. Omitted ⇒ the read
 * stays user-wide across every active, non-vaulted portfolio (what the portfolio
 * page's income line has always shown). `portfolioId` narrows it to ONE
 * portfolio — the V5-P6b Forecast projects a single portfolio's net worth, so
 * its dividend factor may only carry that portfolio's income. A portfolio the
 * caller does not own simply matches no holdings (the repository is
 * user-scoped), so the answer is an empty projection, never another user's.
 */
export const projectedDividendIncomeQuerySchema = z
  .object({ portfolioId: z.string().uuid().optional() })
  .strict();
export type ProjectedDividendIncomeQuery = z.infer<typeof projectedDividendIncomeQuerySchema>;

// ── Earnings (arc b) ─────────────────────────────────────────────────────────

/**
 * One earnings report, upcoming or past. `estimated` is true when the date or
 * figures are still an estimate (an unconfirmed upcoming report); a past report
 * carries the actual EPS. EPS values are informational and left in the
 * provider's reporting unit (not converted to the portfolio base).
 *
 * The two dates are DIFFERENT things and each has its own field (#1790): `date`
 * is when the results are/were **announced** — the date a "next report" label
 * may show — and `periodEnd` is the end of the fiscal period being reported on,
 * which for a June quarter announced on 31 Jul is 28 Jun, over a month earlier.
 * They used to share one field, so a reported quarter's period end rendered
 * under a heading that meant announcement date. Either may be null: a provider
 * that supplies only period ends for its history leaves `date` null there, and
 * an upcoming report has no period end of its own to give.
 */
export const earningsEventSchema = z
  .object({
    date: z.string().datetime().nullable(),
    periodEnd: z.string().datetime().nullable(),
    epsEstimate: z.number().nullable(),
    epsActual: z.number().nullable(),
    estimated: z.boolean(),
  })
  .strict();
export type EarningsEvent = z.infer<typeof earningsEventSchema>;

/** The provider payload for the earnings capability. */
export const earningsEventsSchema = z
  .object({
    /**
     * The next (upcoming) earnings report, or null when none is known. `date` is
     * its announcement date — note that a provider keeps returning the last one
     * it knew about, so a consumer that labels this "next" MUST drop a date that
     * has already passed (the read path's cache is served stale for days).
     */
    next: earningsEventSchema.nullable(),
    /**
     * Recent past reports, ascending by the date they carry. Yahoo's history
     * gives only the fiscal period end, so these rows carry `periodEnd` and a
     * null `date`; a surface renders them as the period they are.
     */
    recent: z.array(earningsEventSchema),
  })
  .strict();
export type EarningsEvents = z.infer<typeof earningsEventsSchema>;

/** `GET /assets/:id/intel/earnings`. */
export const earningsResponseSchema = earningsEventsSchema
  .extend({ available: z.boolean() })
  .strict();
export type EarningsResponse = z.infer<typeof earningsResponseSchema>;

/**
 * One held/watched asset's next earnings report — a row in the Workboard
 * "Upcoming earnings" panel (arc b). `held`/`watched` are independent flags (an
 * asset can be both); `date` is the next report date (always present — the
 * calendar drops assets with no dated upcoming report); `estimated`
 * distinguishes a confirmed date from an estimated one in the UI.
 */
export const earningsCalendarEntrySchema = z
  .object({
    assetId: z.string(),
    symbol: z.string(),
    name: z.string(),
    date: z.string().datetime(),
    epsEstimate: z.number().nullable(),
    estimated: z.boolean(),
    held: z.boolean(),
    watched: z.boolean(),
  })
  .strict();
export type EarningsCalendarEntry = z.infer<typeof earningsCalendarEntrySchema>;

/**
 * `GET /assets/intel/earnings-calendar` — the caller's upcoming-earnings feed
 * across held + watched assets, ascending by date (the Workboard panel, arc b).
 * `available` is false (and `entries` empty) whenever the global gate is off, so
 * the panel stays invisible when the arc is unconfigured. `truncated` is set
 * when the book exceeded the roll-up fan-out budget and the calendar therefore
 * covers only part of it — the panel must say so rather than read as complete.
 */
export const earningsCalendarResponseSchema = z
  .object({
    available: z.boolean(),
    entries: z.array(earningsCalendarEntrySchema),
    truncated: rollupTruncatedSchema,
  })
  .strict();
export type EarningsCalendarResponse = z.infer<typeof earningsCalendarResponseSchema>;

// ── News (arc c) ─────────────────────────────────────────────────────────────

/** One news headline linked to an asset. `url` is the article link. */
export const newsHeadlineSchema = z
  .object({
    /** Stable id (the provider's uuid, or the url when it has none). */
    id: z.string(),
    title: z.string(),
    publisher: z.string().nullable(),
    url: z.string().url(),
    publishedAt: z.string().datetime().nullable(),
  })
  .strict();
export type NewsHeadline = z.infer<typeof newsHeadlineSchema>;

/** `GET /assets/:id/intel/news`. Providers return the headlines; the service wraps. */
export const newsResponseSchema = z
  .object({
    available: z.boolean(),
    headlines: z.array(newsHeadlineSchema),
  })
  .strict();
export type NewsResponse = z.infer<typeof newsResponseSchema>;

// ── Portfolio news digest (arc c, portfolio-level) ───────────────────────────
// Headlines aggregated across the caller's held + watchlist assets, grouped per
// asset and computed on read from the provider/cache keystone (NO storage).
// `available` mirrors the per-asset shape — the global `MARKET_INTEL_ENABLED`
// gate — so the UI shows nothing when it is false (invisible when unconfigured).

/**
 * One asset's news group in the portfolio digest: the asset identity, whether it
 * is held and/or watched (independent flags — an asset can be both), and its
 * headlines newest-first. Only assets with at least one headline are included.
 */
export const newsDigestGroupSchema = z
  .object({
    assetId: z.string(),
    symbol: z.string(),
    name: z.string(),
    held: z.boolean(),
    watched: z.boolean(),
    headlines: z.array(newsHeadlineSchema),
  })
  .strict();
export type NewsDigestGroup = z.infer<typeof newsDigestGroupSchema>;

/**
 * `GET /assets/portfolio/news-digest` — the caller's recent headlines across
 * held + watchlist assets, grouped per asset. Groups are ordered by their newest
 * headline (newest-first), and each group's headlines are newest-first too.
 * `available: false` (gate off) ⇒ empty and hidden.
 */
export const newsDigestResponseSchema = z
  .object({
    available: z.boolean(),
    groups: z.array(newsDigestGroupSchema),
    truncated: rollupTruncatedSchema,
  })
  .strict();
export type NewsDigestResponse = z.infer<typeof newsDigestResponseSchema>;

// ── Splits (arc d) ───────────────────────────────────────────────────────────

/**
 * One stock split. `numerator`/`denominator` express the ratio (a 4-for-1 split
 * is `numerator: 4, denominator: 1`); `ratio` is the provider's display string
 * (e.g. `"4:1"`).
 */
export const splitEventSchema = z
  .object({
    date: z.string().datetime().nullable(),
    numerator: z.number().positive(),
    denominator: z.number().positive(),
    ratio: z.string(),
  })
  .strict();
export type SplitEvent = z.infer<typeof splitEventSchema>;

/** The provider payload for the splits capability. */
export const splitEventsSchema = z
  .object({
    /** Past splits, ascending by date. */
    history: z.array(splitEventSchema),
    /** Announced upcoming splits — empty when the provider has none. */
    upcoming: z.array(splitEventSchema),
  })
  .strict();
export type SplitEvents = z.infer<typeof splitEventsSchema>;

/** `GET /assets/:id/intel/splits`. */
export const splitsResponseSchema = splitEventsSchema.extend({ available: z.boolean() }).strict();
export type SplitsResponse = z.infer<typeof splitsResponseSchema>;

// ── Fundamentals (arc f — INTEL1, mobile board #76) ──────────────────────────
// Revenue / statement / ratio data for the richer asset page. A FIFTH optional
// provider capability that mirrors the four families' provider→service→route→
// contract shape and rides the very same caching/coalescing/currency keystone.
// It is deliberately NOT folded into the {@link MarketIntelCapabilities} map (and
// so not into the `GET /assets/:id/intel` descriptor): a provider that cannot
// serve fundamentals (the Drive-only / local providers) just makes the endpoint
// report `available: false`, exactly like a gate-off or upstream-error read.
//
// The statement figures are plain numbers in the company's own reporting
// `currency` — informational and never converted to the portfolio base (the same
// convention as earnings EPS). Real-world revenues (hundreds of billions) sit
// far inside `Number.MAX_SAFE_INTEGER`, so a JSON number never loses precision.

/** Statement granularity: full fiscal years or fiscal quarters. */
export const FUNDAMENTALS_PERIODS = ['annual', 'quarterly'] as const;
export const fundamentalsPeriodTypeSchema = z.enum(FUNDAMENTALS_PERIODS);
export type FundamentalsPeriodType = z.infer<typeof fundamentalsPeriodTypeSchema>;

/** Hard cap on the number of periods a caller may request; extras are dropped. */
export const FUNDAMENTALS_MAX_LIMIT = 12;

/**
 * Query for `GET /assets/:id/intel/fundamentals`. `period` selects the
 * granularity (defaulting to `annual`); an out-of-enum value is a 400. `limit`
 * is an optional positive integer that the service CLAMPS to
 * `1..FUNDAMENTALS_MAX_LIMIT` — a request for 50 periods yields at most 12, never
 * an error — so a client can over-ask without a round-trip failure.
 */
export const fundamentalsQuerySchema = z
  .object({
    period: fundamentalsPeriodTypeSchema.default('annual'),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type FundamentalsQuery = z.infer<typeof fundamentalsQuerySchema>;

/**
 * One reporting period's statement line items. `fiscalPeriod` is `"FY"` for an
 * annual row and `"Q1".."Q4"` for a quarterly one; `fiscalYear` and the quarter
 * are derived from `endDate` (the period-end date the provider reports), so both
 * are calendar-based approximations for issuers whose fiscal year is offset.
 * `reportDate` (the date results were announced) and per-period `eps` are carried
 * for shape-completeness and forward compatibility: Yahoo's statement modules do
 * not supply either, so they are `null` today (trailing/forward EPS live in
 * `ratios`, where they are authoritative). Every figure is nullable — a provider
 * fills only what it has, and a gap is `null`, never a fabricated 0.
 */
export const fundamentalsPeriodSchema = z
  .object({
    fiscalPeriod: z.string(),
    fiscalYear: z.number().int().nullable(),
    endDate: z.string().datetime().nullable(),
    reportDate: z.string().datetime().nullable(),
    revenue: z.number().nullable(),
    netIncome: z.number().nullable(),
    eps: z.number().nullable(),
    grossProfit: z.number().nullable(),
    operatingIncome: z.number().nullable(),
    totalAssets: z.number().nullable(),
    totalLiabilities: z.number().nullable(),
    totalEquity: z.number().nullable(),
    operatingCashFlow: z.number().nullable(),
    freeCashFlow: z.number().nullable(),
  })
  .strict();
export type FundamentalsPeriod = z.infer<typeof fundamentalsPeriodSchema>;

/**
 * Snapshot valuation / profitability ratios for the asset as of the read (not
 * per-period). Every field is nullable — the provider fills what it can and a
 * missing ratio is `null`. Fractions (`profitMargin`, `returnOnEquity`) are left
 * as the provider reports them (`0.25` ≈ 25 %).
 */
export const fundamentalsRatiosSchema = z
  .object({
    marketCap: z.number().nullable(),
    trailingPe: z.number().nullable(),
    forwardPe: z.number().nullable(),
    priceToBook: z.number().nullable(),
    profitMargin: z.number().nullable(),
    returnOnEquity: z.number().nullable(),
    debtToEquity: z.number().nullable(),
    trailingEps: z.number().nullable(),
    forwardEps: z.number().nullable(),
  })
  .strict();
export type FundamentalsRatios = z.infer<typeof fundamentalsRatiosSchema>;

/**
 * The provider payload for the fundamentals capability: BOTH period granularities
 * (annual + quarterly, most-recent-first) plus the snapshot `ratios` and the
 * reporting `currency`. Cached once per asset through the keystone; the route
 * selects one granularity and slices it to the requested `limit`.
 */
export const assetFundamentalsSchema = z
  .object({
    currency: currencyCodeSchema.nullable(),
    annual: z.array(fundamentalsPeriodSchema),
    quarterly: z.array(fundamentalsPeriodSchema),
    ratios: fundamentalsRatiosSchema,
  })
  .strict();
export type AssetFundamentals = z.infer<typeof assetFundamentalsSchema>;

/**
 * `GET /assets/:id/intel/fundamentals` — the period-selected, limit-sliced view.
 * `available: false` with empty `periods` and all-null `ratios` whenever the gate
 * is off, the asset's provider lacks the capability, or the upstream errored —
 * never a 5xx, exactly like the sibling intel families. `period` echoes the
 * granularity actually served so the client need not re-derive it.
 */
export const fundamentalsResponseSchema = z
  .object({
    available: z.boolean(),
    currency: currencyCodeSchema.nullable(),
    period: fundamentalsPeriodTypeSchema,
    periods: z.array(fundamentalsPeriodSchema),
    ratios: fundamentalsRatiosSchema,
  })
  .strict();
export type FundamentalsResponse = z.infer<typeof fundamentalsResponseSchema>;
