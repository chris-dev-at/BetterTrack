import type {
  AssetMeta,
  AssetRef,
  AssetSearchResult,
  CachedResult,
  HistoryInterval,
  HistoryRange,
  PricePoint,
  Quote,
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
}

export interface StubMarketData extends MarketDataService {
  /** Per-method call counts, for asserting coalescing / first-touch behaviour. */
  readonly calls: { search: number; quote: number; history: number; meta: number; poll: number };
}

const notConfigured = (method: string) => (): never => {
  throw new Error(`stub market data: ${method} not configured`);
};

export function createStubMarketData(controls: StubMarketDataControls = {}): StubMarketData {
  const calls = { search: 0, quote: 0, history: 0, meta: 0, poll: 0 };
  const search = controls.search ?? (() => []);
  const quote = controls.quote ?? notConfigured('getQuote');
  const poll = controls.poll ?? controls.quote ?? notConfigured('pollQuote');
  const history = controls.history ?? notConfigured('getHistory');
  const meta = controls.meta ?? notConfigured('getMeta');

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
    // The stub has no cache, so there is never a background refresh to await.
    async settled() {},
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
