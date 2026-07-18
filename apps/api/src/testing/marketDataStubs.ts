import type {
  AssetMeta,
  AssetRef,
  AssetSearchResult,
  CachedResult,
  DividendEvents,
  EarningsEvents,
  HistoryInterval,
  HistoryRange,
  MarketIntelCapabilities,
  NewsHeadline,
  PricePoint,
  Quote,
  SplitEvents,
} from '@bettertrack/contracts';

import type { BackfillScheduler } from '../jobs';
import type { MarketDataService } from '../providers';

/**
 * Test doubles for the market-data read API (issue #34): a configurable
 * {@link MarketDataService} stub (the "stubbed providers" the acceptance
 * criteria call for) and a recording {@link BackfillScheduler} to assert
 * first-touch enqueue idempotency.
 */

export interface StubMarketDataControls {
  /** Provider fan-out result for `GET /search`. Defaults to an empty list. */
  search?: (query: string) => Promise<AssetSearchResult[]> | AssetSearchResult[];
  /** Quote behaviour; throw to simulate a hard provider failure with no cache. */
  quote?: (ref: AssetRef) => Promise<CachedResult<Quote>> | CachedResult<Quote>;
  /** Live-poll behaviour (V3-P7b); defaults to the `quote` control. */
  poll?: (ref: AssetRef) => Promise<CachedResult<Quote>> | CachedResult<Quote>;
  /** History behaviour; throw to simulate a hard provider failure with no cache. */
  history?: (
    ref: AssetRef,
    range: HistoryRange,
    interval?: HistoryInterval,
  ) => Promise<CachedResult<PricePoint[]>> | CachedResult<PricePoint[]>;
  /** Meta behaviour (unused by the read API, which sources meta from the DB row). */
  meta?: (ref: AssetRef) => Promise<CachedResult<AssetMeta>> | CachedResult<AssetMeta>;
  // ── Market intelligence (§13.5 V5-P5) ──────────────────────────────────────
  /**
   * Advertised intel capabilities. Defaults to whichever of the four intel
   * behaviours below are configured, so a test that wires `dividends` gets
   * `dividends: true` for free; override to model a capability-less provider.
   */
  intelCapabilities?: MarketIntelCapabilities | ((ref: AssetRef) => MarketIntelCapabilities);
  /** Dividends behaviour; throw to simulate a provider failure with no cache. */
  dividends?: (
    ref: AssetRef,
  ) => Promise<CachedResult<DividendEvents>> | CachedResult<DividendEvents>;
  /** Earnings behaviour; throw to simulate a provider failure with no cache. */
  earnings?: (
    ref: AssetRef,
  ) => Promise<CachedResult<EarningsEvents>> | CachedResult<EarningsEvents>;
  /** News behaviour; throw to simulate a provider failure with no cache. */
  news?: (ref: AssetRef) => Promise<CachedResult<NewsHeadline[]>> | CachedResult<NewsHeadline[]>;
  /** Splits behaviour; throw to simulate a provider failure with no cache. */
  splits?: (ref: AssetRef) => Promise<CachedResult<SplitEvents>> | CachedResult<SplitEvents>;
}

export interface StubMarketData extends MarketDataService {
  /** Per-method call counts, for asserting coalescing / first-touch behaviour. */
  readonly calls: {
    search: number;
    quote: number;
    history: number;
    meta: number;
    poll: number;
    dividends: number;
    earnings: number;
    news: number;
    splits: number;
  };
}

const notConfigured = (method: string) => (): never => {
  throw new Error(`stub market data: ${method} not configured`);
};

export function createStubMarketData(controls: StubMarketDataControls = {}): StubMarketData {
  const calls = {
    search: 0,
    quote: 0,
    history: 0,
    meta: 0,
    poll: 0,
    dividends: 0,
    earnings: 0,
    news: 0,
    splits: 0,
  };
  const search = controls.search ?? (() => []);
  const quote = controls.quote ?? notConfigured('getQuote');
  const poll = controls.poll ?? controls.quote ?? notConfigured('pollQuote');
  const history = controls.history ?? notConfigured('getHistory');
  const meta = controls.meta ?? notConfigured('getMeta');
  const dividends = controls.dividends ?? notConfigured('getDividendEvents');
  const earnings = controls.earnings ?? notConfigured('getEarningsEvents');
  const news = controls.news ?? notConfigured('getNewsHeadlines');
  const splits = controls.splits ?? notConfigured('getSplitEvents');
  // Default capabilities reflect which intel behaviours the test wired up, so a
  // fixtured family reports available without a separate declaration.
  const capabilities: MarketIntelCapabilities = {
    dividends: controls.dividends !== undefined,
    earnings: controls.earnings !== undefined,
    news: controls.news !== undefined,
    splits: controls.splits !== undefined,
  };

  return {
    calls,
    async search(query) {
      calls.search += 1;
      return search(query);
    },
    async getQuote(ref) {
      calls.quote += 1;
      return quote(ref);
    },
    async pollQuote(ref) {
      calls.poll += 1;
      return poll(ref);
    },
    async getHistory(ref, range, interval) {
      calls.history += 1;
      return history(ref, range, interval);
    },
    async getMeta(ref) {
      calls.meta += 1;
      return meta(ref);
    },
    intelCapabilities(ref) {
      const override = controls.intelCapabilities;
      if (override === undefined) return capabilities;
      return typeof override === 'function' ? override(ref) : override;
    },
    async getDividendEvents(ref) {
      calls.dividends += 1;
      return dividends(ref);
    },
    async getEarningsEvents(ref) {
      calls.earnings += 1;
      return earnings(ref);
    },
    async getNewsHeadlines(ref) {
      calls.news += 1;
      return news(ref);
    },
    async getSplitEvents(ref) {
      calls.splits += 1;
      return splits(ref);
    },
    // The stub has no cache, so there is never a background refresh to await.
    async settled() {},
    // No upstream providers behind the stub, so no breakers to report.
    breakerStates: () => [],
    // No failover chain behind the stub — empty attribution/switches.
    failoverStatus: () => ({ chains: [], switches: [], attribution: [] }),
  };
}

export interface RecordingBackfill extends BackfillScheduler {
  /** Asset ids passed to {@link BackfillScheduler.enqueue}, in order. */
  readonly enqueued: string[];
}

export function createRecordingBackfill(): RecordingBackfill {
  const enqueued: string[] = [];
  return {
    enqueued,
    async enqueue(assetId) {
      enqueued.push(assetId);
    },
  };
}

/** A canned provider search hit, overridable per field. */
export function providerHit(overrides: Partial<AssetSearchResult> = {}): AssetSearchResult {
  return {
    providerId: 'yahoo',
    providerRef: 'AAPL',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    exchange: 'NASDAQ',
    type: 'stock',
    currency: 'USD',
    ...overrides,
  };
}

// ── Market-intelligence fixtures (§13.5 V5-P5) ───────────────────────────────
// Canned intel payloads the downstream P5 UI issues' tests can wire straight
// into `createStubMarketData({ dividends: () => cachedIntel(sampleDividendEvents()) })`.

const INTEL_FETCHED_AT = Date.parse('2026-06-20T10:00:00.000Z');

/** Wrap an intel payload in the service's resilience envelope (fresh by default). */
export function cachedIntel<T>(
  value: T,
  overrides: Partial<CachedResult<T>> = {},
): CachedResult<T> {
  return { value, stale: false, asOf: INTEL_FETCHED_AT, ...overrides };
}

/** A canned {@link DividendEvents} payload, overridable per field. */
export function sampleDividendEvents(overrides: Partial<DividendEvents> = {}): DividendEvents {
  return {
    currency: 'USD',
    history: [
      { exDate: '2026-02-07T00:00:00.000Z', payDate: null, amount: 0.24, currency: 'USD' },
      { exDate: '2026-05-09T00:00:00.000Z', payDate: null, amount: 0.25, currency: 'USD' },
    ],
    upcoming: [
      {
        exDate: '2026-08-08T00:00:00.000Z',
        payDate: '2026-08-15T00:00:00.000Z',
        amount: null,
        currency: 'USD',
      },
    ],
    forwardYield: 0.0044,
    trailingAmount: 0.98,
    ...overrides,
  };
}

/** A canned {@link EarningsEvents} payload, overridable per field. */
export function sampleEarningsEvents(overrides: Partial<EarningsEvents> = {}): EarningsEvents {
  return {
    next: {
      date: '2026-07-30T00:00:00.000Z',
      epsEstimate: 1.42,
      epsActual: null,
      estimated: true,
    },
    recent: [
      {
        date: '2026-04-30T00:00:00.000Z',
        epsEstimate: 1.5,
        epsActual: 1.53,
        estimated: false,
      },
    ],
    ...overrides,
  };
}

/** A canned news-headline list, overridable wholesale. */
export function sampleNewsHeadlines(overrides?: NewsHeadline[]): NewsHeadline[] {
  return (
    overrides ?? [
      {
        id: 'news-1',
        title: 'Apple beats expectations',
        publisher: 'Reuters',
        url: 'https://example.com/apple-beats',
        publishedAt: '2026-06-20T08:00:00.000Z',
      },
    ]
  );
}

/** A canned {@link SplitEvents} payload, overridable per field. */
export function sampleSplitEvents(overrides: Partial<SplitEvents> = {}): SplitEvents {
  return {
    history: [{ date: '2020-08-31T00:00:00.000Z', numerator: 4, denominator: 1, ratio: '4:1' }],
    upcoming: [],
    ...overrides,
  };
}
