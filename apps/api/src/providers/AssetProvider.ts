import type {
  AssetFundamentals,
  AssetMeta,
  AssetRef,
  AssetSearchResult,
  DividendEvents,
  EarningsEvents,
  HistoryInterval,
  HistoryRange,
  NewsHeadline,
  PricePoint,
  Quote,
  SplitEvents,
} from '@bettertrack/contracts';

/**
 * The single interface every market-data source implements (PROJECTPLAN.md
 * §5.1). Stocks, ETFs, FX pairs, commodities and custom ("manual") investments
 * all look identical to the rest of the system — portfolio charts, totals and
 * P/L need zero special-casing for a house vs. a stock.
 *
 * Implementations live in this folder and nowhere else; the rest of the app
 * reaches them only through the registry and the market-data service, never by
 * importing a concrete provider. Adding gold later is "register symbols or a
 * new provider file — nothing else changes".
 */
/**
 * The upstream call families a provider is asked for. This is the *breaker
 * scope* (§13.5 V5-P1c): the market-data service keeps one circuit breaker per
 * provider AND capability, so repeated `fundamentals` failures on symbols the
 * upstream has no module for can never fail-fast `quote` for every asset — "with
 * the primary mocked dead, quotes keep flowing" is about quotes. It is also what
 * the failover chain routes on (see `historyBasis`).
 *
 * Not to be confused with {@link providerCapabilities}, which reports which
 * OPTIONAL market-intelligence families a provider implements.
 */
export type ProviderCapability =
  | 'search'
  | 'quote'
  | 'history'
  | 'meta'
  | 'dividends'
  | 'earnings'
  | 'news'
  | 'splits'
  | 'fundamentals';

/**
 * Price basis of a provider's {@link AssetProvider.getHistory} series (money,
 * §13.5 V5-P1c): `adjusted` is a dividend/split-adjusted total-return series,
 * `unadjusted` the raw traded close. The two are NOT interchangeable — a
 * backtest or a portfolio history that silently switches basis mid-series
 * reports a different return for the same holding.
 */
export type HistoryBasis = 'adjusted' | 'unadjusted';

export interface AssetProvider {
  /** Stable id used as the routing key and as the first cache-key segment. */
  readonly id: string;

  /**
   * True when this provider's data lives in our own database (the `manual`
   * provider). Local providers are exempt from the §5.3 upstream-politeness
   * machinery — no Redis TTL cache and no negative caching — because there is
   * no upstream to protect and a user's edit must be visible immediately.
   */
  readonly local?: boolean;

  /**
   * Failover capability gate (§13.5 V5-P1c). A *secondary* provider returns
   * false for a ref whose asset it cannot map into its own universe (e.g. Stooq
   * for a crypto or an unlisted exchange), so the failover chain skips it
   * instead of asking — which would surface a spurious "not found" and poison
   * the (primary-keyed) negative cache. Omitted ⇒ the provider serves any ref
   * routed to it (the primary's own assets always resolve, so the primary
   * never needs this).
   */
  canServe?(ref: AssetRef): boolean;

  /**
   * The price basis this provider's {@link getHistory} returns (money gate,
   * §13.5 V5-P1c). The failover chain lets a *secondary* serve `history` for
   * another provider's asset ONLY when it declares the same basis as that
   * asset's own provider: the series is cached under the asset's primary key and
   * handed to backtests/portfolio history as one continuous series, so a
   * secondary with a different basis would silently swap adjusted for raw
   * mid-flight. An undeclared basis is *unknown*, never "equal" — such a provider
   * is skipped for history and the read degrades to the primary's stale copy
   * (§5.3) instead of changing the meaning of the numbers. Quote/meta failover is
   * unaffected: a spot price has no adjustment basis.
   */
  readonly historyBasis?: HistoryBasis;

  /** Symbol/name lookup across this provider's universe (§6.2). */
  search(query: string): Promise<AssetSearchResult[]>;

  /** Live-ish quote: price, currency, prevClose, dayChangePct, asOf (§5.1). */
  getQuote(ref: AssetRef): Promise<Quote>;

  /** Price series for a range/interval, on the declared {@link historyBasis} (§5.1, §5.3). */
  getHistory(ref: AssetRef, range: HistoryRange, interval: HistoryInterval): Promise<PricePoint[]>;

  /**
   * The SAME series on the raw traded (`unadjusted`) basis — what the portfolio
   * valuation path multiplies stored quantities against (§16 2026-09-03).
   *
   * OPTIONAL, and only meaningful for a provider whose {@link historyBasis} is
   * `adjusted`: one whose `getHistory` is already `unadjusted` needs nothing
   * here, and the market-data service uses `getHistory` for it. A provider that
   * is `adjusted` and does NOT implement this cannot serve the valuation path at
   * all — the service refuses rather than handing the money math a series on a
   * basis its quantities are not on.
   */
  getUnadjustedHistory?(
    ref: AssetRef,
    range: HistoryRange,
    interval: HistoryInterval,
  ): Promise<PricePoint[]>;

  /** Descriptive metadata: name, symbol, exchange, currency, type (§5.1). */
  getMeta(ref: AssetRef): Promise<AssetMeta>;

  // ── Market-intelligence capabilities (§13.5 V5-P5) ─────────────────────────
  // All four are OPTIONAL: a provider implements any subset, and the registry
  // reports per-provider availability (a provider that lacks a capability simply
  // does not advertise it — see `providerCapabilities`). A secondary/failover
  // provider that carries none is fully valid. Freshness caching, coalescing and
  // circuit breaking are layered on by the market-data service exactly like the
  // quote/history paths, so these methods never touch Redis.

  /** Dividend history + known upcoming ex/pay dates + forward yield (arc a). */
  getDividendEvents?(ref: AssetRef): Promise<DividendEvents>;

  /** Next + recent past earnings reports, with a confirmed/estimated flag (arc b). */
  getEarningsEvents?(ref: AssetRef): Promise<EarningsEvents>;

  /** Recent news headlines for the asset (arc c). */
  getNewsHeadlines?(ref: AssetRef): Promise<NewsHeadline[]>;

  /** Past + announced stock splits with ratios (arc d). */
  getSplitEvents?(ref: AssetRef): Promise<SplitEvents>;

  /**
   * Revenue / statement / ratio fundamentals for the richer asset page (arc f,
   * INTEL1). OPTIONAL like the four families above: a provider without it (the
   * local/Drive-only sources) simply does not advertise it, and the read layer
   * degrades the endpoint to `available: false`. Returns BOTH period
   * granularities plus snapshot ratios; the service selects and slices.
   */
  getFundamentals?(ref: AssetRef): Promise<AssetFundamentals>;
}
