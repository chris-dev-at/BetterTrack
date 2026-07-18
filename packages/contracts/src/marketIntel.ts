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

/** The provider payload for the dividends capability. */
export const dividendEventsSchema = z
  .object({
    /** Canonical currency of the payouts, or null when the provider omitted it. */
    currency: currencyCodeSchema.nullable(),
    /** Past payouts, ascending by ex-date. */
    history: z.array(dividendEventSchema),
    /** Known upcoming ex/pay dates (forward calendar). */
    upcoming: z.array(dividendEventSchema),
    /**
     * Forward annual dividend yield as the provider reports it (a fraction —
     * `0.015` ≈ 1.5 %), where cheaply available (arc e). Null when absent.
     */
    forwardYield: z.number().nullable(),
    /** Trailing 12-month dividend per share in `currency`, where available. */
    trailingAmount: z.number().nonnegative().nullable(),
  })
  .strict();
export type DividendEvents = z.infer<typeof dividendEventsSchema>;

/** `GET /assets/:id/intel/dividends` — the payload plus the availability signal. */
export const dividendsResponseSchema = dividendEventsSchema
  .extend({ available: z.boolean() })
  .strict();
export type DividendsResponse = z.infer<typeof dividendsResponseSchema>;

// ── Earnings (arc b) ─────────────────────────────────────────────────────────

/**
 * One earnings report, upcoming or past. `estimated` is true when the date or
 * figures are still an estimate (an unconfirmed upcoming report); a past report
 * carries the actual EPS. EPS values are informational and left in the
 * provider's reporting unit (not converted to the portfolio base).
 */
export const earningsEventSchema = z
  .object({
    date: z.string().datetime().nullable(),
    epsEstimate: z.number().nullable(),
    epsActual: z.number().nullable(),
    estimated: z.boolean(),
  })
  .strict();
export type EarningsEvent = z.infer<typeof earningsEventSchema>;

/** The provider payload for the earnings capability. */
export const earningsEventsSchema = z
  .object({
    /** The next (upcoming) earnings report, or null when none is known. */
    next: earningsEventSchema.nullable(),
    /** Recent past reports, ascending by date. */
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
 * the panel stays invisible when the arc is unconfigured.
 */
export const earningsCalendarResponseSchema = z
  .object({
    available: z.boolean(),
    entries: z.array(earningsCalendarEntrySchema),
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
