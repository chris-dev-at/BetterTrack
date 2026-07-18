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
import type { Redis } from 'ioredis';

import { cacheKey, createMarketCache, type MarketCache } from './cache';
import { CircuitBreaker, type CircuitBreakerOptions, type CircuitState } from './circuitBreaker';
import { CapabilityUnavailableError, isNotFoundError, isRateLimitError } from './errors';
import {
  createFailoverResolver,
  NO_FAILOVER,
  type FailoverChains,
  type FailoverStatus,
} from './failoverChain';
import { providerCapabilities, type ProviderRegistry } from './registry';
import { DEFAULT_TIMEOUT_MS, retryOnce, withTimeout } from './resilience';
import {
  DIVIDENDS_TTL_SECONDS,
  EARNINGS_TTL_SECONDS,
  historyTtlSeconds,
  META_TTL_SECONDS,
  NEWS_TTL_SECONDS,
  QUOTE_TTL_SECONDS,
  SEARCH_TTL_SECONDS,
  SPLITS_TTL_SECONDS,
} from './ttl';

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
  /**
   * Fresh quote for the Live Mode poll loop (§6.3, V3-P7b): skips the §5.3
   * freshness window (a 60 s-old cached quote is exactly what a live stream must
   * beat) but goes upstream through the SAME budget → timeout → retry → breaker
   * chain as every other call, and primes the regular quote cache with the
   * result — so the 60 s poll fallback rides the live stream for free. While
   * the provider's breaker is open this throws instead of hammering upstream;
   * the loop stretches its interval, viewers keep the last frames.
   */
  pollQuote(ref: AssetRef): Promise<CachedResult<Quote>>;
  getHistory(
    ref: AssetRef,
    range: HistoryRange,
    interval?: HistoryInterval,
  ): Promise<CachedResult<PricePoint[]>>;
  getMeta(ref: AssetRef): Promise<CachedResult<AssetMeta>>;

  // ── Market intelligence (§13.5 V5-P5) ──────────────────────────────────────
  // Which optional intel capabilities the asset's own provider advertises, and
  // the per-family reads. Capabilities are per provider and NOT assumed
  // universal, so these do NOT go through the failover chain (a secondary that
  // implements none must never mask the primary's capability); they call the
  // asset's own provider through the same timeout → breaker → cache machinery as
  // the quote/history paths. A capability the provider lacks rejects with
  // {@link CapabilityUnavailableError}; the read layer degrades to "unconfigured".

  /** The intel capabilities the asset's own provider advertises. */
  intelCapabilities(ref: AssetRef): MarketIntelCapabilities;
  /** Dividend history + upcoming ex/pay + forward yield (arc a), cached in hours. */
  getDividendEvents(ref: AssetRef): Promise<CachedResult<DividendEvents>>;
  /** Next + recent earnings (arc b), cached in hours. */
  getEarningsEvents(ref: AssetRef): Promise<CachedResult<EarningsEvents>>;
  /** Recent news headlines (arc c), cached in minutes (the volatile family). */
  getNewsHeadlines(ref: AssetRef): Promise<CachedResult<NewsHeadline[]>>;
  /** Past + announced splits (arc d), cached in hours. */
  getSplitEvents(ref: AssetRef): Promise<CachedResult<SplitEvents>>;

  /**
   * Resolves once in-flight background cache revalidations have finished
   * (graceful shutdown, deterministic tests).
   */
  settled(): Promise<void>;
  /**
   * Per-provider circuit-breaker state for the admin health page (§13.4 V4-P5a).
   * Reports every non-local (upstream) provider; a provider that has not yet been
   * called has no breaker and reads `closed`. Read-only introspection — never
   * creates or trips a breaker.
   */
  breakerStates(): Array<{ providerId: string; state: CircuitState }>;
  /**
   * Failover attribution for the admin health surface (§13.5 V5-P1c): which
   * provider is currently serving each chain, the recent switch events, and
   * per-provider serve counts. Empty arrays when no secondary is configured.
   */
  failoverStatus(): FailoverStatus;
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
  /**
   * Per-asset-class failover chains (§13.5 V5-P1c): the ordered secondary
   * providers to try after an asset's own provider. Defaults to {@link NO_FAILOVER}
   * (primary only) — behaviour byte-identical to a single-provider setup.
   */
  failover?: FailoverChains;
  /** Retained failover switch-log cap (admin health surface). */
  maxFailoverSwitchEvents?: number;
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
  '3M': '1d',
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
  /** Read-only breaker state (never creates one): a not-yet-called provider is closed. */
  const breakerStateOf = (providerId: string): CircuitState =>
    breakers.get(providerId)?.getState() ?? 'closed';

  // Failover chain (§13.5 V5-P1c): tries the asset's own provider first, then the
  // configured secondaries. It sits inside the cache loader below, so the cache
  // key stays keyed on the asset's provider whichever source serves.
  const resolver = createFailoverResolver({
    registry,
    chains: options.failover ?? NO_FAILOVER,
    breakerState: breakerStateOf,
    now: options.now,
    maxSwitchEvents: options.maxFailoverSwitchEvents,
  });

  /**
   * timeout → retry-once → circuit breaker (§5.1). Definitive failures skip
   * the retry: a 429 must reach the breaker on the very first attempt so it
   * trips immediately (§5.3) instead of hitting the rate-limiting upstream
   * again, and a not-found is about to be negative-cached — a second call
   * cannot change either answer.
   */
  const isDefinitiveError = (err: unknown): boolean =>
    isRateLimitError(err) || isNotFoundError(err);
  const callUpstream = <T>(providerId: string, fn: () => Promise<T>): Promise<T> =>
    breakerFor(providerId).execute(() =>
      retryOnce(
        () => withTimeout(fn, timeoutMs),
        (err) => !isDefinitiveError(err),
      ),
    );

  /**
   * Revalidation gate: while a provider's breaker is open, expired entries are
   * served stale with no upstream attempt at all (§5.3 TTL stretch). Once the
   * cooldown elapses (half-open) the next revalidation is the probe.
   */
  const revalidateGate = (providerId: string) => (): boolean =>
    breakerFor(providerId).getState() !== 'open';

  /**
   * Cache + coalesce + breaker-wrap one intel read against the asset's own
   * provider (§13.5 V5-P5). Rejects with {@link CapabilityUnavailableError} when
   * the provider does not implement the capability — the read layer treats that
   * exactly like a provider error and degrades to the "unconfigured" shape.
   */
  const loadIntel = <T>(
    ref: AssetRef,
    capability: string,
    ttlSeconds: number,
    method: ((ref: AssetRef) => Promise<T>) | undefined,
  ): Promise<CachedResult<T>> => {
    const provider = registry.for(ref);
    if (typeof method !== 'function') {
      return Promise.reject(new CapabilityUnavailableError(provider.id, capability));
    }
    return cache.getOrLoad<T>({
      key: cacheKey(ref.providerId, ref.providerRef, 'intel', capability),
      ttlSeconds,
      staleTtlSeconds,
      negativeTtlSeconds,
      isNotFound: isNotFoundError,
      shouldRevalidate: revalidateGate(provider.id),
      loader: () => callUpstream(provider.id, () => method(ref)),
    });
  };

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
        shouldRevalidate: () => resolver.anyAvailable(ref),
        loader: () => resolver.run(ref, callUpstream, (p) => p.getQuote(ref), isNotFoundError),
      });
    },

    async pollQuote(ref) {
      const provider = registry.for(ref);
      if (provider.local) {
        return callUpstream(provider.id, () => provider.getQuote(ref)).then((value) => ({
          value,
          stale: false,
          asOf: now(),
        }));
      }
      // Non-local: the same failover chain as getQuote, priming the shared cache.
      const load = (): Promise<Quote> =>
        resolver.run(ref, callUpstream, (p) => p.getQuote(ref), isNotFoundError);
      const value = await load();
      return cache.prime(
        {
          key: cacheKey(ref.providerId, ref.providerRef, 'quote', 'spot'),
          ttlSeconds: QUOTE_TTL_SECONDS,
          staleTtlSeconds,
        },
        value,
      );
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
        shouldRevalidate: () => resolver.anyAvailable(ref),
        loader: () =>
          resolver.run(
            ref,
            callUpstream,
            (p) => p.getHistory(ref, range, chosenInterval),
            isNotFoundError,
          ),
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
        shouldRevalidate: () => resolver.anyAvailable(ref),
        loader: () => resolver.run(ref, callUpstream, (p) => p.getMeta(ref), isNotFoundError),
      });
    },

    intelCapabilities(ref) {
      return providerCapabilities(registry.for(ref));
    },

    getDividendEvents(ref) {
      const provider = registry.for(ref);
      return loadIntel<DividendEvents>(
        ref,
        'dividends',
        DIVIDENDS_TTL_SECONDS,
        provider.getDividendEvents?.bind(provider),
      );
    },

    getEarningsEvents(ref) {
      const provider = registry.for(ref);
      return loadIntel<EarningsEvents>(
        ref,
        'earnings',
        EARNINGS_TTL_SECONDS,
        provider.getEarningsEvents?.bind(provider),
      );
    },

    getNewsHeadlines(ref) {
      const provider = registry.for(ref);
      return loadIntel<NewsHeadline[]>(
        ref,
        'news',
        NEWS_TTL_SECONDS,
        provider.getNewsHeadlines?.bind(provider),
      );
    },

    getSplitEvents(ref) {
      const provider = registry.for(ref);
      return loadIntel<SplitEvents>(
        ref,
        'splits',
        SPLITS_TTL_SECONDS,
        provider.getSplitEvents?.bind(provider),
      );
    },

    settled: () => cache.settled(),

    breakerStates: () =>
      registry
        .all()
        .filter((provider) => provider.local !== true)
        .map((provider) => ({
          providerId: provider.id,
          state: breakers.get(provider.id)?.getState() ?? ('closed' as CircuitState),
        })),

    failoverStatus: () => resolver.status(),
  };
}
