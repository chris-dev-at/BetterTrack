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

export interface YahooClient {
  search(query: string): Promise<YahooSearchResult>;
  quote(symbol: string): Promise<YahooQuoteResult>;
  chart(symbol: string, params: YahooChartParams): Promise<YahooChartResult>;
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
  };
}
