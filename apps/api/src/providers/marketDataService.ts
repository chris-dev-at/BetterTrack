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
import type { ProviderRegistry } from './registry';
import { DEFAULT_TIMEOUT_MS, retryOnce, withTimeout } from './resilience';
import { historyTtlSeconds, META_TTL_SECONDS, QUOTE_TTL_SECONDS } from './ttl';

/**
 * The one place the rest of the app reaches market data (PROJECTPLAN.md §5.1).
 * It resolves the provider for an asset through the {@link ProviderRegistry},
 * wraps every upstream call in timeout → retry-once → per-provider circuit
 * breaker, and serves results through the cache with request coalescing and
 * stale-while-revalidate. No service outside `providers/` imports a concrete
 * provider; they depend on this interface.
 */
export interface MarketDataService {
  /** Fan-out search across all registered providers; failing providers are skipped. */
  search(query: string): Promise<AssetSearchResult[]>;
  getQuote(ref: AssetRef): Promise<CachedResult<Quote>>;
  getHistory(
    ref: AssetRef,
    range: HistoryRange,
    interval?: HistoryInterval,
  ): Promise<CachedResult<PricePoint[]>>;
  getMeta(ref: AssetRef): Promise<CachedResult<AssetMeta>>;
}

export interface MarketDataServiceOptions {
  /** Upstream timeout per attempt; defaults to 5 s (§5.1). */
  timeoutMs?: number;
  /** Circuit-breaker tuning, applied per provider. */
  breaker?: CircuitBreakerOptions;
  /** Stale-copy retention; defaults to the cache's own default. */
  staleTtlSeconds?: number;
  /** Injectable clock (tests). Threaded into the cache and breakers. */
  now?: () => number;
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

export function createMarketDataService(deps: CreateMarketDataServiceDeps): MarketDataService {
  const { registry, redis } = deps;
  const options = deps.options ?? {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleTtlSeconds = options.staleTtlSeconds;

  const cache: MarketCache = createMarketCache(redis, { now: options.now });

  // One breaker per provider: a sick upstream trips fast for all its assets.
  const breakers = new Map<string, CircuitBreaker>();
  const breakerFor = (providerId: string): CircuitBreaker => {
    let breaker = breakers.get(providerId);
    if (!breaker) {
      breaker = new CircuitBreaker(providerId, {
        now: options.now,
        ...options.breaker,
      });
      breakers.set(providerId, breaker);
    }
    return breaker;
  };

  /** timeout → retry-once → circuit breaker (§5.1). */
  const callUpstream = <T>(providerId: string, fn: () => Promise<T>): Promise<T> =>
    breakerFor(providerId).execute(() => retryOnce(() => withTimeout(fn, timeoutMs)));

  return {
    async search(query) {
      const settled = await Promise.allSettled(
        registry.all().map((provider) => callUpstream(provider.id, () => provider.search(query))),
      );
      return settled
        .filter((r): r is PromiseFulfilledResult<AssetSearchResult[]> => r.status === 'fulfilled')
        .flatMap((r) => r.value);
    },

    getQuote(ref) {
      const provider = registry.for(ref);
      return cache.getOrLoad<Quote>({
        key: cacheKey(ref.providerId, ref.providerRef, 'quote', 'spot'),
        ttlSeconds: QUOTE_TTL_SECONDS,
        staleTtlSeconds,
        loader: () => callUpstream(provider.id, () => provider.getQuote(ref)),
      });
    },

    getHistory(ref, range, interval) {
      const provider = registry.for(ref);
      const chosenInterval = interval ?? defaultIntervalForRange(range);
      return cache.getOrLoad<PricePoint[]>({
        key: cacheKey(ref.providerId, ref.providerRef, 'history', `${range}@${chosenInterval}`),
        ttlSeconds: historyTtlSeconds(range),
        staleTtlSeconds,
        loader: () =>
          callUpstream(provider.id, () => provider.getHistory(ref, range, chosenInterval)),
      });
    },

    getMeta(ref) {
      const provider = registry.for(ref);
      return cache.getOrLoad<AssetMeta>({
        key: cacheKey(ref.providerId, ref.providerRef, 'meta', 'default'),
        ttlSeconds: META_TTL_SECONDS,
        staleTtlSeconds,
        loader: () => callUpstream(provider.id, () => provider.getMeta(ref)),
      });
    },
  };
}
