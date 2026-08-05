import type { HistoryRange } from '@bettertrack/contracts';

/**
 * Cache TTLs from PROJECTPLAN.md §5.3. These are the *freshness* windows: how
 * long a cached value is served without re-fetching. A separate, longer
 * retention ({@link STALE_TTL_SECONDS}) keeps the last-known-good copy around so
 * it can be served as `stale` when the upstream is unreachable.
 */

/** Quote freshness: 60 s — one fetch serves every user viewing the asset. */
export const QUOTE_TTL_SECONDS = 60;

/**
 * History freshness per range (§5.3). Shorter ranges use fine candles that go
 * stale fast; long ranges are daily/weekly and change slowly.
 */
const HISTORY_TTL_BY_RANGE: Record<HistoryRange, number> = {
  '1D': 60, // 1-minute candles
  '1W': 5 * 60, // 15-minute candles
  '1M': 15 * 60, // 30-minute candles
  '3M': 60 * 60, // daily candles
  '6M': 60 * 60, // daily candles
  '1Y': 60 * 60, // daily candles
  '5Y': 6 * 60 * 60, // weekly candles
  MAX: 6 * 60 * 60, // monthly candles
};

export function historyTtlSeconds(range: HistoryRange): number {
  return HISTORY_TTL_BY_RANGE[range];
}

/**
 * Metadata changes rarely (name/exchange/currency); §5.3 does not list it, so we
 * cache it for a day. Documented here as the keystone's own choice.
 */
export const META_TTL_SECONDS = 24 * 60 * 60;

/** Provider search results (catalog-fill), keyed by normalized query: 24 h (§5.3). */
export const SEARCH_TTL_SECONDS = 24 * 60 * 60;

/**
 * Negative results (unknown symbol, 404): 15 min (§5.3), so repeated misses
 * don't hammer the provider.
 */
export const NEGATIVE_TTL_SECONDS = 15 * 60;

/**
 * Retention of the last-known-good copy used for stale-while-revalidate (§5.1).
 * Long enough to ride out a multi-hour upstream outage; not permanent (durable
 * daily closes live in Postgres `price_history`, §5.3).
 */
export const STALE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Market-intelligence freshness windows (§13.5 V5-P5). Corporate-actions and
 * scheduled events move slowly, so dividends/earnings/splits cache for hours
 * (one fetch serves every viewer of the asset for a working session); news is
 * the volatile family and refreshes in minutes. Same serve-stale + coalescing
 * machinery as the quote/history paths.
 */
export const DIVIDENDS_TTL_SECONDS = 12 * 60 * 60;
export const EARNINGS_TTL_SECONDS = 6 * 60 * 60;
export const SPLITS_TTL_SECONDS = 12 * 60 * 60;
export const NEWS_TTL_SECONDS = 10 * 60;
