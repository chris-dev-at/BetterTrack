import type {
  AssetFundamentals,
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
  /** Provider-locality lookup; defaults to every provider being upstream. */
  local?: (ref: Pick<AssetRef, 'providerId'>) => boolean;
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
  /**
   * Fundamentals behaviour (arc f / INTEL1). Leave unset to model a
   * capability-less provider: `getFundamentals` then rejects, so the read layer
   * degrades to `available: false`.
   */
  fundamentals?: (
    ref: AssetRef,
  ) => Promise<CachedResult<AssetFundamentals>> | CachedResult<AssetFundamentals>;
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
    fundamentals: number;
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
    fundamentals: 0,
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
  const fundamentals = controls.fundamentals ?? notConfigured('getFundamentals');
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
    isLocalProvider(ref) {
      return controls.local?.(ref) ?? false;
    },
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
    async getFundamentals(ref) {
      calls.fundamentals += 1;
      return fundamentals(ref);
    },
    // The stub has no cache, so there is never a background refresh to await.
    async settled() {},
    // No upstream providers behind the stub, so no breakers to report.
    breakerStates: () => [],
    breakerSnapshots: () => [],
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

/**
 * A canned {@link DividendEvents} payload, overridable per field. The
 * `trailingAmountBasis` is derived from the resulting amount unless the caller
 * names one, so a fixture that only sets `trailingAmount` still satisfies the
 * contract invariant "the basis is null exactly when the amount is".
 */
export function sampleDividendEvents(overrides: Partial<DividendEvents> = {}): DividendEvents {
  const merged = {
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
    trailingAmountBasis: 'trailing-12m',
    ...overrides,
  } satisfies DividendEvents;
  return {
    ...merged,
    trailingAmountBasis:
      overrides.trailingAmountBasis ??
      (merged.trailingAmount == null ? null : merged.trailingAmountBasis),
  };
}

/**
 * A canned {@link EarningsEvents} payload, overridable per field.
 *
 * `next` is dated 30 days ahead of the WALL CLOCK, not at a literal: the
 * earnings calendar drops reports dated before today (§13.5 V5-P5), so a fixed
 * date would quietly turn this fixture into "no upcoming report" once it
 * passed, and every integration test built on it into a vacuous pass. Suites
 * that pin their own clock override `next` outright.
 */
export function sampleEarningsEvents(overrides: Partial<EarningsEvents> = {}): EarningsEvents {
  return {
    next: {
      date: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      periodEnd: null,
      epsEstimate: 1.42,
      epsActual: null,
      estimated: true,
    },
    recent: [
      {
        // A reported quarter carries its fiscal PERIOD END, not an announcement
        // date — the two are separate contract fields since #1790.
        date: null,
        periodEnd: '2026-04-30T00:00:00.000Z',
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

/**
 * A canned {@link AssetFundamentals} payload (arc f / INTEL1), overridable per
 * field. Three annual periods (most-recent-first) and one quarter, so a test can
 * exercise both granularities and the limit clamp.
 */
export function sampleFundamentals(overrides: Partial<AssetFundamentals> = {}): AssetFundamentals {
  const annualRow = (
    year: number,
    revenue: number,
    netIncome: number,
  ): AssetFundamentals['annual'][number] => ({
    fiscalPeriod: 'FY',
    fiscalYear: year,
    endDate: `${year}-09-30T00:00:00.000Z`,
    reportDate: null,
    revenue,
    netIncome,
    eps: null,
    grossProfit: Math.round(revenue * 0.44),
    operatingIncome: Math.round(revenue * 0.3),
    totalAssets: Math.round(revenue * 0.9),
    totalLiabilities: Math.round(revenue * 0.7),
    totalEquity: Math.round(revenue * 0.2),
    operatingCashFlow: Math.round(netIncome * 1.2),
    freeCashFlow: Math.round(netIncome * 1.05),
  });
  return {
    currency: 'USD',
    annual: [
      annualRow(2025, 391_035_000_000, 93_736_000_000),
      annualRow(2024, 383_285_000_000, 96_995_000_000),
      annualRow(2023, 394_328_000_000, 96_995_000_000),
    ],
    quarterly: [
      {
        fiscalPeriod: 'Q2',
        fiscalYear: 2026,
        endDate: '2026-03-28T00:00:00.000Z',
        reportDate: null,
        revenue: 90_753_000_000,
        netIncome: 23_636_000_000,
        eps: null,
        grossProfit: 40_000_000_000,
        operatingIncome: 27_000_000_000,
        totalAssets: 331_000_000_000,
        totalLiabilities: 264_000_000_000,
        totalEquity: 67_000_000_000,
        operatingCashFlow: 24_000_000_000,
        freeCashFlow: 22_000_000_000,
      },
    ],
    ratios: {
      marketCap: 3_100_000_000_000,
      trailingPe: 32.4,
      forwardPe: 29.1,
      priceToBook: 48.2,
      profitMargin: 0.24,
      returnOnEquity: 1.47,
      debtToEquity: 145.0,
      trailingEps: 6.12,
      forwardEps: 7.3,
    },
    ...overrides,
  };
}
