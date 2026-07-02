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
import type { Redis } from 'ioredis';

import { cacheKey, createMarketCache, type MarketCache } from './cache';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuitBreaker';
import { isNotFoundError, isRateLimitError } from './errors';
import type { ProviderRegistry } from './registry';
import { DEFAULT_TIMEOUT_MS, retryOnce, withTimeout } from './resilience';
import { historyTtlSeconds, META_TTL_SECONDS, QUOTE_TTL_SECONDS, SEARCH_TTL_SECONDS } from './ttl';

/**
 * The one place the rest of the app reaches market data (PROJECTPLAN.md §5.1).
 * It resolves the provider for an asset through the {@link ProviderRegistry},
 * wraps every upstream call in timeout → retry-once → per-provider circuit
 * breaker, and serves results through the cache with request coalescing,
 * serve-stale-while-revalidate and negative caching (§5.3). An upstream 429
 * trips the provider's breaker immediately, and while a breaker is open,
 * expired entries keep being served stale with no upstream attempt — TTLs
 * stretch instead of users seeing errors. No service outside `providers/`
 * imports a concrete provider; they depend on this interface.
 */
export interface MarketDataService {
  /**
   * Fan-out search across all registered providers; failing providers are
   * skipped. Results are cached 24 h per provider, keyed by normalized query
   * (§5.3 "provider search results").
   */
  search(query: string): Promise<AssetSearchResult[]>;
  getQuote(ref: AssetRef): Promise<CachedResult<Quote>>;
  getHistory(
    ref: AssetRef,
    range: HistoryRange,
    interval?: HistoryInterval,
  ): Promise<CachedResult<PricePoint[]>>;
  getMeta(ref: AssetRef): Promise<CachedResult<AssetMeta>>;
  /**
   * Resolves once in-flight background cache revalidations have finished
   * (graceful shutdown, deterministic tests).
   */
  settled(): Promise<void>;
}

export interface MarketDataServiceOptions {
  /** Upstream timeout per attempt; defaults to 5 s (§5.1). */
  timeoutMs?: number;
  /** Circuit-breaker tuning, applied per provider. */
  breaker?: CircuitBreakerOptions;
  /** Stale-copy retention; defaults to the cache's own default. */
  staleTtlSeconds?: number;
  /** Negative-result retention; defaults to the cache's §5.3 default (15 min). */
  negativeTtlSeconds?: number;
  /** Injectable clock (tests). Threaded into the cache and breakers. */
  now?: () => number;
  /** Observes swallowed background-refresh failures (logging hook). */
  onBackgroundError?: (key: string, err: unknown) => void;
}

export interface CreateMarketDataServiceDeps {
  registry: ProviderRegistry;
  redis: Redis;
  options?: MarketDataServiceOptions;
}

/**
 * Default candle interval for each range (§5.3). Range determines interval in
 * v1; callers may still override it explicitly.
 */
const DEFAULT_INTERVAL_BY_RANGE: Record<HistoryRange, HistoryInterval> = {
  '1D': '1m',
  '1W': '15m',
  '1M': '30m',
  '6M': '1d',
  '1Y': '1d',
  '5Y': '1wk',
  MAX: '1mo',
};

export function defaultIntervalForRange(range: HistoryRange): HistoryInterval {
  return DEFAULT_INTERVAL_BY_RANGE[range];
}

/** One canonical form per query so ranking and coalescing share cache entries (§5.3). */
export function normalizeSearchQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function createMarketDataService(deps: CreateMarketDataServiceDeps): MarketDataService {
  const { registry, redis } = deps;
  const options = deps.options ?? {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleTtlSeconds = options.staleTtlSeconds;
  const negativeTtlSeconds = options.negativeTtlSeconds;
  const now = options.now ?? Date.now;

  const cache: MarketCache = createMarketCache(redis, {
    now: options.now,
    onBackgroundError: options.onBackgroundError,
  });

  // One breaker per provider: a sick upstream trips fast for all its assets.
  // A 429 trips it immediately (§5.3), unless the caller overrides the predicate.
  const breakers = new Map<string, CircuitBreaker>();
  const breakerFor = (providerId: string): CircuitBreaker => {
    let breaker = breakers.get(providerId);
    if (!breaker) {
      breaker = new CircuitBreaker(providerId, {
        now: options.now,
        tripImmediately: isRateLimitError,
        ...options.breaker,
      });
      breakers.set(providerId, breaker);
    }
    return breaker;
  };

  /** timeout → retry-once → circuit breaker (§5.1). */
  const callUpstream = <T>(providerId: string, fn: () => Promise<T>): Promise<T> =>
    breakerFor(providerId).execute(() => retryOnce(() => withTimeout(fn, timeoutMs)));

  /**
   * Revalidation gate: while a provider's breaker is open, expired entries are
   * served stale with no upstream attempt at all (§5.3 TTL stretch). Once the
   * cooldown elapses (half-open) the next revalidation is the probe.
   */
  const revalidateGate = (providerId: string) => (): boolean =>
    breakerFor(providerId).getState() !== 'open';

  return {
    async search(query) {
      const normalized = normalizeSearchQuery(query);
      if (normalized === '') return [];
      const settled = await Promise.allSettled(
        registry.all().map((provider) => {
          const load = (): Promise<AssetSearchResult[]> =>
            callUpstream(provider.id, () => provider.search(query));
          // Local providers search our own DB — nothing upstream to protect.
          if (provider.local) return load();
          return cache
            .getOrLoad<AssetSearchResult[]>({
              key: cacheKey(provider.id, '*', 'search', normalized),
              ttlSeconds: SEARCH_TTL_SECONDS,
              staleTtlSeconds,
              negativeTtlSeconds,
              isNotFound: isNotFoundError,
              shouldRevalidate: revalidateGate(provider.id),
              loader: load,
            })
            .then((cached) => cached.value);
        }),
      );
      return settled
        .filter((r): r is PromiseFulfilledResult<AssetSearchResult[]> => r.status === 'fulfilled')
        .flatMap((r) => r.value);
    },

    getQuote(ref) {
      const provider = registry.for(ref);
      if (provider.local) {
        return callUpstream(provider.id, () => provider.getQuote(ref)).then((value) => ({
          value,
          stale: false,
          asOf: now(),
        }));
      }
      return cache.getOrLoad<Quote>({
        key: cacheKey(ref.providerId, ref.providerRef, 'quote', 'spot'),
        ttlSeconds: QUOTE_TTL_SECONDS,
        staleTtlSeconds,
        negativeTtlSeconds,
        isNotFound: isNotFoundError,
        shouldRevalidate: revalidateGate(provider.id),
        loader: () => callUpstream(provider.id, () => provider.getQuote(ref)),
      });
    },

    getHistory(ref, range, interval) {
      const provider = registry.for(ref);
      const chosenInterval = interval ?? defaultIntervalForRange(range);
      if (provider.local) {
        return callUpstream(provider.id, () =>
          provider.getHistory(ref, range, chosenInterval),
        ).then((value) => ({ value, stale: false, asOf: now() }));
      }
      return cache.getOrLoad<PricePoint[]>({
        key: cacheKey(ref.providerId, ref.providerRef, 'history', `${range}@${chosenInterval}`),
        ttlSeconds: historyTtlSeconds(range),
        staleTtlSeconds,
        negativeTtlSeconds,
        isNotFound: isNotFoundError,
        shouldRevalidate: revalidateGate(provider.id),
        loader: () =>
          callUpstream(provider.id, () => provider.getHistory(ref, range, chosenInterval)),
      });
    },

    getMeta(ref) {
      const provider = registry.for(ref);
      if (provider.local) {
        return callUpstream(provider.id, () => provider.getMeta(ref)).then((value) => ({
          value,
          stale: false,
          asOf: now(),
        }));
      }
      return cache.getOrLoad<AssetMeta>({
        key: cacheKey(ref.providerId, ref.providerRef, 'meta', 'default'),
        ttlSeconds: META_TTL_SECONDS,
        staleTtlSeconds,
        negativeTtlSeconds,
        isNotFound: isNotFoundError,
        shouldRevalidate: revalidateGate(provider.id),
        loader: () => callUpstream(provider.id, () => provider.getMeta(ref)),
      });
    },

    settled: () => cache.settled(),
  };
}
