import YahooFinance from 'yahoo-finance2';

/**
 * The narrow slice of `yahoo-finance2` the Yahoo provider depends on
 * (PROJECTPLAN.md §5.2). Defining our own boundary type — rather than leaning on
 * the library's full surface — keeps the provider testable with a tiny stub (no
 * live network in CI, an acceptance criterion of #33) and contains a future
 * library swap to this one file (§5.1: "the provider interface makes
 * replacement a contained change").
 *
 * Every field is optional/loose because Yahoo's unofficial API is best-effort;
 * the provider reads defensively and the mapping in `yahooMapping.ts` turns
 * whatever arrives into the strict contract shapes.
 */

/** Candle granularities we ask Yahoo for — the §5.3 interval set. */
export type YahooChartInterval = '1m' | '15m' | '30m' | '1d' | '1wk' | '1mo';

export interface YahooQuoteResult {
  symbol?: string;
  currency?: string;
  quoteType?: string;
  exchange?: string;
  fullExchangeName?: string;
  shortName?: string;
  longName?: string;
  displayName?: string;
  marketState?: string;
  regularMarketPrice?: number;
  regularMarketPreviousClose?: number;
  regularMarketChangePercent?: number;
  regularMarketTime?: Date | number | string;
}

export interface YahooChartQuote {
  date: Date | number | string;
  close?: number | null;
  adjclose?: number | null;
}

export interface YahooChartMeta {
  currency?: string;
  symbol?: string;
  instrumentType?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  longName?: string;
  shortName?: string;
}

export interface YahooChartResult {
  meta: YahooChartMeta;
  quotes: YahooChartQuote[];
}

export interface YahooChartParams {
  period1: Date | number | string;
  period2?: Date | number | string;
  interval?: YahooChartInterval;
}

export interface YahooSearchQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchange?: string;
  exchDisp?: string;
  quoteType?: string;
  isYahooFinance?: boolean;
}

export interface YahooSearchResult {
  quotes: YahooSearchQuote[];
}

// ── Market-intelligence shapes (§13.5 V5-P5) ─────────────────────────────────
// Yahoo carries dividends/splits as `chart` events, upcoming ex/pay + earnings
// dates via `quoteSummary` modules, and headlines via `search`'s news array.
// Kept loose/optional (Yahoo's unofficial API is best-effort); the pure mappers
// in `yahooMapping.ts` turn whatever arrives into the strict contract shapes.

/** A single dividend event from `chart(events: 'div')`. `date` is the ex-date. */
export interface YahooChartDividend {
  amount?: number;
  date?: Date | number | string;
}

/** A single split event from `chart(events: 'split')`. */
export interface YahooChartSplit {
  date?: Date | number | string;
  numerator?: number;
  denominator?: number;
  splitRatio?: string;
}

/** `chart(...)` narrowed to the corporate-action events (candles ignored here). */
export interface YahooChartEventsResult {
  meta: YahooChartMeta;
  dividends: YahooChartDividend[];
  splits: YahooChartSplit[];
}

export interface YahooChartEventsParams {
  period1: Date | number | string;
  interval?: YahooChartInterval;
  /** Yahoo events filter, e.g. `'div'`, `'split'` or `'div|split'`. */
  events: string;
}

/** `quoteSummary.calendarEvents.earnings` — upcoming earnings dates + estimate. */
export interface YahooCalendarEarnings {
  earningsDate?: Array<Date | number | string>;
  isEarningsDateEstimate?: boolean;
  earningsAverage?: number;
}

/** `quoteSummary.calendarEvents` — forward ex/pay dates + the earnings block. */
export interface YahooCalendarEvents {
  exDividendDate?: Date | number | string;
  dividendDate?: Date | number | string;
  earnings?: YahooCalendarEarnings;
}

/** `quoteSummary.summaryDetail` — currency + the forward/trailing dividend fields. */
export interface YahooSummaryDetail {
  currency?: string;
  dividendYield?: number;
  dividendRate?: number;
  trailingAnnualDividendRate?: number;
}

/** One row of `quoteSummary.earningsHistory.history` — a past reported quarter. */
export interface YahooEarningsHistoryRow {
  epsActual?: number | null;
  epsEstimate?: number | null;
  quarter?: Date | number | string | null;
}

export interface YahooEarningsHistory {
  history?: YahooEarningsHistoryRow[];
}

/** The `quoteSummary` modules the intel provider requests, narrowed. */
export interface YahooQuoteSummaryResult {
  calendarEvents?: YahooCalendarEvents;
  summaryDetail?: YahooSummaryDetail;
  earningsHistory?: YahooEarningsHistory;
}

/** The `quoteSummary` module names the intel provider asks for. */
export type YahooQuoteSummaryModule = 'calendarEvents' | 'summaryDetail' | 'earningsHistory';

/** One item of `search(...).news`. */
export interface YahooNewsItem {
  uuid?: string;
  title?: string;
  publisher?: string;
  link?: string;
  providerPublishTime?: Date | number | string;
}

export interface YahooNewsResult {
  news: YahooNewsItem[];
}

export interface YahooClient {
  search(query: string): Promise<YahooSearchResult>;
  quote(symbol: string): Promise<YahooQuoteResult>;
  chart(symbol: string, params: YahooChartParams): Promise<YahooChartResult>;
  /** Dividend/split events over a window (§13.5 V5-P5); candles are discarded. */
  chartEvents(symbol: string, params: YahooChartEventsParams): Promise<YahooChartEventsResult>;
  /** Fetch the given `quoteSummary` modules (calendar/earnings/detail). */
  quoteSummary(
    symbol: string,
    modules: YahooQuoteSummaryModule[],
  ): Promise<YahooQuoteSummaryResult>;
  /** Recent news headlines for a symbol via `search`'s news array. */
  searchNews(symbol: string, count: number): Promise<YahooNewsResult>;
}

/**
 * Build the real `yahoo-finance2`-backed client. Notices (the survey + the
 * historical-deprecation banners) are suppressed so they don't pollute server
 * logs, and `versionCheck` is off so an error never triggers a surprise
 * outbound version probe — our own queue/backoff (§5.2) owns upstream traffic.
 */
export function createYahooClient(): YahooClient {
  const yf = new YahooFinance({
    suppressNotices: ['yahooSurvey', 'ripHistorical'],
    versionCheck: false,
  });

  return {
    search: (query): Promise<YahooSearchResult> => yf.search(query),
    quote: (symbol): Promise<YahooQuoteResult> => yf.quote(symbol),
    chart: (symbol, params): Promise<YahooChartResult> =>
      yf.chart(symbol, {
        period1: params.period1,
        period2: params.period2,
        interval: params.interval,
        return: 'array',
      }),
    chartEvents: (symbol, params): Promise<YahooChartEventsResult> =>
      // `return: 'array'` gives events as parallel arrays; the candles are
      // discarded here (the intel path only needs dividends/splits).
      yf
        .chart(symbol, {
          period1: params.period1,
          interval: params.interval,
          events: params.events,
          return: 'array',
        })
        .then((result) => ({
          meta: result.meta ?? {},
          dividends: result.events?.dividends ?? [],
          splits: result.events?.splits ?? [],
        })),
    quoteSummary: (symbol, modules): Promise<YahooQuoteSummaryResult> =>
      yf.quoteSummary(symbol, { modules }),
    // We only consume the news array; keep quotes minimal but present (Yahoo
    // rejects `quotesCount: 0` on some builds, so we leave it at the default).
    searchNews: (symbol, count): Promise<YahooNewsResult> =>
      yf.search(symbol, { newsCount: count }).then((result) => ({ news: result.news ?? [] })),
  };
}
