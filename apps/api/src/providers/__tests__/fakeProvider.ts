import type {
  AssetMeta,
  AssetRef,
  AssetSearchResult,
  HistoryInterval,
  HistoryRange,
  PricePoint,
  Quote,
} from '@bettertrack/contracts';

import type { AssetProvider } from '../AssetProvider';

/** A manually-resolvable promise, for driving coalescing/timing tests. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function sampleQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    price: 100,
    currency: 'EUR',
    prevClose: 99,
    dayChangePct: 1.0101,
    asOf: '2026-06-15T10:00:00.000Z',
    ...overrides,
  };
}

export function sampleHistory(): PricePoint[] {
  return [
    { time: '2026-06-13T00:00:00.000Z', close: 98 },
    { time: '2026-06-14T00:00:00.000Z', close: 99 },
    { time: '2026-06-15T00:00:00.000Z', close: 100 },
  ];
}

export function sampleMeta(overrides: Partial<AssetMeta> = {}): AssetMeta {
  return {
    providerId: 'fake',
    providerRef: 'ACME',
    symbol: 'ACME',
    name: 'Acme Corp',
    exchange: 'XETRA',
    currency: 'EUR',
    type: 'stock',
    ...overrides,
  };
}

export function sampleSearchResult(overrides: Partial<AssetSearchResult> = {}): AssetSearchResult {
  return {
    providerId: 'fake',
    providerRef: 'ACME',
    symbol: 'ACME',
    name: 'Acme Corp',
    exchange: 'XETRA',
    type: 'stock',
    currency: 'EUR',
    ...overrides,
  };
}

export interface FakeProviderControls {
  /** How a `getQuote` call behaves. */
  quote: () => Promise<Quote>;
  search: () => Promise<AssetSearchResult[]>;
  history: () => Promise<PricePoint[]>;
  meta: () => Promise<AssetMeta>;
}

export interface FakeProvider extends AssetProvider {
  readonly calls: { quote: number; search: number; history: number; meta: number };
}

/**
 * A configurable provider for tests. Each method delegates to a controllable
 * behaviour function and records its call count, so tests can assert exactly how
 * many upstream calls happened (coalescing, retry, circuit breaker).
 */
export function createFakeProvider(
  id = 'fake',
  controls: Partial<FakeProviderControls> = {},
): FakeProvider {
  const calls = { quote: 0, search: 0, history: 0, meta: 0 };
  const behaviour: FakeProviderControls = {
    quote: controls.quote ?? (() => Promise.resolve(sampleQuote())),
    search: controls.search ?? (() => Promise.resolve([sampleSearchResult({ providerId: id })])),
    history: controls.history ?? (() => Promise.resolve(sampleHistory())),
    meta: controls.meta ?? (() => Promise.resolve(sampleMeta({ providerId: id }))),
  };

  return {
    id,
    calls,
    search(_query: string): Promise<AssetSearchResult[]> {
      calls.search += 1;
      return behaviour.search();
    },
    getQuote(_ref: AssetRef): Promise<Quote> {
      calls.quote += 1;
      return behaviour.quote();
    },
    getHistory(
      _ref: AssetRef,
      _range: HistoryRange,
      _interval: HistoryInterval,
    ): Promise<PricePoint[]> {
      calls.history += 1;
      return behaviour.history();
    },
    getMeta(_ref: AssetRef): Promise<AssetMeta> {
      calls.meta += 1;
      return behaviour.meta();
    },
  };
}
