import type {
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

import type { AssetProvider } from './AssetProvider';
import { AssetNotFoundError } from './errors';
import { rangeStartMs } from './historyWindow';
import { createRequestQueue, type RequestQueue, type RequestQueueOptions } from './requestQueue';
import {
  currencyForSearchResult,
  mapAssetType,
  mapDividendEvents,
  mapEarningsEvents,
  mapNewsHeadlines,
  mapSplitEvents,
  normalizeCurrency,
} from './yahooMapping';
import type { YahooChartEventsResult, YahooChartInterval, YahooClient } from './yahooClient';

/**
 * The Yahoo Finance provider (PROJECTPLAN.md §5.2): `search`/`getQuote`/
 * `getHistory`/`getMeta` over `yahoo-finance2`, mapped to the §5.1 contract
 * shapes. It owns the §5.2 outbound policy (concurrency-4 + backoff via the
 * injected {@link RequestQueue}); freshness caching, timeout, retry-once,
 * circuit breaking and stale-while-revalidate are added on top by the
 * market-data service (§5.1), so this file never touches Redis.
 *
 * FX pairs (`EURUSD=X`) and commodities (`GC=F`) are ordinary Yahoo symbols and
 * flow through unchanged — no special-casing (§5.1).
 */

const PROVIDER_ID = 'yahoo';

/** How many headlines to request per asset (§13.5 V5-P5) — compact, expandable. */
const NEWS_HEADLINE_COUNT = 20;

/** §5.3 interval → the matching `yahoo-finance2` candle granularity. */
const INTERVAL_MAP: Record<HistoryInterval, YahooChartInterval> = {
  '1m': '1m',
  '15m': '15m',
  '30m': '30m',
  '1d': '1d',
  '1wk': '1wk',
  '1mo': '1mo',
};

export interface CreateYahooProviderDeps {
  /** The (real or stubbed) Yahoo client. Stubbed in tests — no live network. */
  client: YahooClient;
  /** Outbound queue policy; defaults to the §5.2/§5.3 concurrency + spacing + backoff queue. */
  queue?: RequestQueue;
  /** Tuning for the default queue (per-provider budget, §5.3); ignored when `queue` is given. */
  queueOptions?: RequestQueueOptions;
  /** Injectable clock (tests) used to derive history windows. */
  now?: () => number;
}

/** Coerce a Yahoo timestamp (Date | epoch | ISO string) to an ISO-8601 string. */
function toIso(value: Date | number | string | undefined, fallbackMs: number): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

export function createYahooProvider(deps: CreateYahooProviderDeps): AssetProvider {
  const { client } = deps;
  const queue = deps.queue ?? createRequestQueue(deps.queueOptions);
  const now = deps.now ?? Date.now;

  async function search(query: string): Promise<AssetSearchResult[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];
    const result = await queue.run(() => client.search(trimmed));
    const out: AssetSearchResult[] = [];
    for (const q of result.quotes ?? []) {
      // Drop non-Yahoo hits (company/crunchbase entries) — not tradable assets.
      if (q.isYahooFinance === false) continue;
      const symbol = (q.symbol ?? '').trim();
      if (symbol === '') continue;
      out.push({
        providerId: PROVIDER_ID,
        providerRef: symbol,
        symbol,
        name: q.longname ?? q.shortname ?? symbol,
        exchange: q.exchDisp ?? q.exchange ?? null,
        type: mapAssetType(q.quoteType, symbol),
        currency: currencyForSearchResult(symbol, q.exchange),
      });
    }
    return out;
  }

  async function getQuote(ref: AssetRef): Promise<Quote> {
    const q = await queue.run(() => client.quote(ref.providerRef));
    if (typeof q.regularMarketPrice !== 'number') {
      // A priceless quote means the symbol is unknown/delisted — a definitive
      // answer, negative-cached per §5.3 (vs. a transient failure, which throws
      // from the client itself).
      throw new AssetNotFoundError(`Yahoo returned no price for "${ref.providerRef}"`);
    }
    const { code, priceScale } = normalizeCurrency(q.currency);
    const price = q.regularMarketPrice * priceScale;
    const prevClose =
      typeof q.regularMarketPreviousClose === 'number'
        ? q.regularMarketPreviousClose * priceScale
        : null;
    // Prefer a day change derived from the prices we actually report (scale-
    // invariant, internally consistent); fall back to Yahoo's own percent only
    // when there is no usable previous close.
    const dayChangePct =
      prevClose !== null && prevClose !== 0
        ? ((price - prevClose) / prevClose) * 100
        : typeof q.regularMarketChangePercent === 'number'
          ? q.regularMarketChangePercent
          : null;
    return {
      price,
      currency: code,
      prevClose,
      dayChangePct,
      asOf: toIso(q.regularMarketTime, now()),
    };
  }

  async function getHistory(
    ref: AssetRef,
    range: HistoryRange,
    interval: HistoryInterval,
  ): Promise<PricePoint[]> {
    const end = now();
    const start = rangeStartMs(end, range);
    const result = await queue.run(() =>
      client.chart(ref.providerRef, {
        period1: new Date(start),
        period2: new Date(end),
        interval: INTERVAL_MAP[interval],
      }),
    );
    const candles = result.quotes ?? [];
    if (candles.length === 0) return [];
    const { priceScale } = normalizeCurrency(result.meta?.currency);
    const points: PricePoint[] = [];
    for (const candle of candles) {
      // Adjusted close = dividend/split-adjusted total return (§5.2); fall back
      // to the raw close for intraday candles, where Yahoo omits adjclose. Null
      // closes (holidays / data gaps) are skipped.
      const raw = candle.adjclose ?? candle.close;
      if (typeof raw !== 'number') continue;
      points.push({ time: toIso(candle.date, end), close: raw * priceScale });
    }
    return points;
  }

  async function getMeta(ref: AssetRef): Promise<AssetMeta> {
    const q = await queue.run(() => client.quote(ref.providerRef));
    const { code } = normalizeCurrency(q.currency);
    const symbol = (q.symbol ?? ref.providerRef).trim() || ref.providerRef;
    return {
      providerId: PROVIDER_ID,
      providerRef: ref.providerRef,
      symbol,
      name: q.longName ?? q.shortName ?? q.displayName ?? symbol,
      exchange: q.fullExchangeName ?? q.exchange ?? null,
      currency: code,
      type: mapAssetType(q.quoteType, symbol),
    };
  }

  // ── Market intelligence (§13.5 V5-P5) ──────────────────────────────────────
  // Corporate actions come from `chart` events over the full window; the forward
  // calendar and earnings/detail modules from `quoteSummary`; headlines from
  // `search`. Every upstream call flows through the same queue as the price
  // paths; caching/coalescing/breaker are added by the market-data service.

  /** Deepest window Yahoo will serve (upstream clamps to what it actually has). */
  const eventsPeriod1 = (): Date => new Date(rangeStartMs(now(), 'MAX'));

  async function getDividendEvents(ref: AssetRef): Promise<DividendEvents> {
    // History (chart) and the forward calendar + yield (quoteSummary) are two
    // independent calls; a hiccup on one must not blank the other, but a total
    // failure must surface so the breaker counts it and the read layer degrades.
    const [chartResult, summaryResult] = await Promise.allSettled([
      queue.run(() =>
        client.chartEvents(ref.providerRef, {
          period1: eventsPeriod1(),
          interval: '1mo',
          events: 'div',
        }),
      ),
      queue.run(() => client.quoteSummary(ref.providerRef, ['calendarEvents', 'summaryDetail'])),
    ]);
    if (chartResult.status === 'rejected' && summaryResult.status === 'rejected') {
      throw chartResult.reason;
    }
    const chart: YahooChartEventsResult =
      chartResult.status === 'fulfilled'
        ? chartResult.value
        : { meta: {}, dividends: [], splits: [] };
    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : {};
    return mapDividendEvents(chart, summary);
  }

  async function getEarningsEvents(ref: AssetRef): Promise<EarningsEvents> {
    const summary = await queue.run(() =>
      client.quoteSummary(ref.providerRef, ['calendarEvents', 'earningsHistory']),
    );
    return mapEarningsEvents(summary);
  }

  async function getNewsHeadlines(ref: AssetRef): Promise<NewsHeadline[]> {
    const result = await queue.run(() => client.searchNews(ref.providerRef, NEWS_HEADLINE_COUNT));
    return mapNewsHeadlines(result);
  }

  async function getSplitEvents(ref: AssetRef): Promise<SplitEvents> {
    const chart = await queue.run(() =>
      client.chartEvents(ref.providerRef, {
        period1: eventsPeriod1(),
        interval: '1mo',
        events: 'split',
      }),
    );
    return mapSplitEvents(chart);
  }

  return {
    id: PROVIDER_ID,
    search,
    getQuote,
    getHistory,
    getMeta,
    getDividendEvents,
    getEarningsEvents,
    getNewsHeadlines,
    getSplitEvents,
  };
}
