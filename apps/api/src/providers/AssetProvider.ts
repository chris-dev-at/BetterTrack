import type {
  AssetMeta,
  AssetRef,
  AssetSearchResult,
  HistoryInterval,
  HistoryRange,
  PricePoint,
  Quote,
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

  /** Symbol/name lookup across this provider's universe (§6.2). */
  search(query: string): Promise<AssetSearchResult[]>;

  /** Live-ish quote: price, currency, prevClose, dayChangePct, asOf (§5.1). */
  getQuote(ref: AssetRef): Promise<Quote>;

  /** Adjusted-close price series for a range/interval (§5.1, §5.3). */
  getHistory(ref: AssetRef, range: HistoryRange, interval: HistoryInterval): Promise<PricePoint[]>;

  /** Descriptive metadata: name, symbol, exchange, currency, type (§5.1). */
  getMeta(ref: AssetRef): Promise<AssetMeta>;
}
