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
import type { Redis } from 'ioredis';

import type { AssetProvider, ProviderCapability } from './AssetProvider';
import { cacheKey, createMarketCache, type MarketCache } from './cache';
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitBreakerSnapshot,
  type CircuitState,
} from './circuitBreaker';
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
  FUNDAMENTALS_TTL_SECONDS,
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
 * wraps every upstream call in timeout → retry-once → circuit breaker (one per
 * provider AND capability, §13.5 V5-P1c), and serves results through the cache
 * with request coalescing, serve-stale-while-revalidate and negative caching
 * (§5.3). An upstream 429 trips that capability's breaker immediately, and while
 * a breaker is open, expired entries keep being served stale with no upstream
 * attempt — TTLs stretch instead of users seeing errors. No service outside
 * `providers/` imports a concrete provider; they depend on this interface.
 */
export interface MarketDataService {
  /**
   * Whether the ref's owning provider is backed by BetterTrack's own database.
   * Business services use this metadata when provider timestamps describe a
   * user-maintained value point rather than an upstream market execution.
   */
  isLocalProvider(ref: Pick<AssetRef, 'providerId'>): boolean;
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
   * Revenue / statement / ratio fundamentals (arc f, INTEL1), cached in hours.
   * Rejects with {@link CapabilityUnavailableError} when the asset's provider
   * does not implement the capability; the read layer degrades to "unconfigured".
   */
  getFundamentals(ref: AssetRef): Promise<CachedResult<AssetFundamentals>>;

  /**
   * Resolves once in-flight background cache revalidations have finished
   * (graceful shutdown, deterministic tests).
   */
  settled(): Promise<void>;
  /**
   * Per-provider circuit-breaker state for the admin health page (§13.4 V4-P5a).
   * Reports every non-local (upstream) provider; a provider that has not yet been
   * called has no breaker and reads `closed`. Breakers are scoped per capability
   * (§13.5 V5-P1c), so this reports the WORST state across a provider's
   * capabilities — the admin surface still shows "this upstream is impaired"
   * without the payload growing a capability dimension. Read-only introspection —
   * never creates or trips a breaker.
   */
  breakerStates(): Array<{ providerId: string; state: CircuitState }>;
  /**
   * The per-capability breaker detail the admin operations cockpit reads
   * (#1406 W4). {@link breakerStates} deliberately collapses a provider to its
   * WORST capability so the health payload stays one-dimensional — which hides
   * exactly the distinction per-capability isolation was built for ("with
   * `fundamentals` dead, quotes keep flowing"). This is that dimension, and it
   * is the only place it is published.
   *
   * Reports a provider's LIVE breakers only: a capability that has never been
   * called has no breaker and is therefore absent rather than listed as
   * `closed`, because "never exercised" and "exercised and healthy" are
   * different operational facts. Read-only — never creates or trips a breaker.
   */
  breakerSnapshots(): ProviderBreakerSnapshots[];
  /**
   * Failover attribution for the admin health surface (§13.5 V5-P1c): which
   * provider is currently serving each chain, the recent switch events, and
   * per-provider serve counts. Empty arrays when no secondary is configured.
   */
  failoverStatus(): FailoverStatus;
}

/** One provider's live capability breakers, worst-first at the provider level. */
export interface ProviderBreakerSnapshots {
  providerId: string;
  /** Worst state across this provider's live capability breakers. */
  state: CircuitState;
  capabilities: Array<{ capability: ProviderCapability } & CircuitBreakerSnapshot>;
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

/**
 * Payload **shape version** per intel capability — the §5.3 cache's migration
 * lever, and the reason a payload change is safe to deploy.
 *
 * An intel entry is stored as serialized JSON and read back verbatim: a fresh
 * hit is returned with no schema parse and no revalidation, and the
 * last-known-good stale copy is retained for `STALE_TTL_SECONDS` (7 days) —
 * served, and never refreshed, for as long as the upstream is failing. So the
 * entries a *previous* release wrote outlive the deploy by hours to days, and a
 * release that changes what a payload MEANS cannot simply read them back: they
 * arrive missing the new field and the new consumer misreads them.
 *
 * Bumping a capability's number changes its cache key, so those entries are
 * never read again and expire on their own TTL — the new code only ever sees
 * payloads its own release produced. A capability absent from this map is at
 * version 1 and keeps the bare `capability` variant it has always used: a shape
 * change to one payload must not evict the other five.
 */
const INTEL_PAYLOAD_VERSIONS: Partial<Record<ProviderCapability, number>> = {
  // v2 (#1741): `trailingAmountBasis` now travels beside `trailingAmount`, and
  // the portfolio projection treats a per-share amount carrying no basis as an
  // unresolved holding (the two bases differ by a large factor after a special
  // dividend). Without this bump every v1 entry would blank the whole
  // projection until it expired.
  dividends: 2,
};

/**
 * The §5.3 cache-key variant for one intel capability, carrying its payload
 * shape version (see {@link INTEL_PAYLOAD_VERSIONS}). Version 1 is the bare
 * capability name, so only a payload that actually changed gets a new key.
 */
export function intelCacheVariant(capability: ProviderCapability): string {
  const version = INTEL_PAYLOAD_VERSIONS[capability];
  return version === undefined ? capability : `${capability}@v${version}`;
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

  // One breaker per provider AND capability: a sick upstream endpoint trips fast
  // for all its assets, but only for the call family that is actually sick. A
  // provider-wide breaker took every capability down together — repeated
  // `fundamentals`/`news` failures on symbols the upstream has no module for
  // would fail-fast QUOTES for the whole open window, the opposite of "with the
  // primary mocked dead, quotes keep flowing" (§13.5 V5-P1c).
  // A 429 trips it immediately (§5.3), unless the caller overrides the predicate.
  // A not-found is breaker-neutral: an authoritative "this symbol does not
  // exist" comes from a *healthy* upstream, so a portfolio holding several
  // delisted tickers (or an import with unmapped symbols) must not open the
  // provider's breaker — which would degrade every other asset to stale and
  // report a provider outage that never happened (§13.5 V5-P1c).
  const breakers = new Map<string, Map<ProviderCapability, CircuitBreaker>>();
  const breakerFor = (providerId: string, capability: ProviderCapability): CircuitBreaker => {
    let perCapability = breakers.get(providerId);
    if (!perCapability) {
      perCapability = new Map();
      breakers.set(providerId, perCapability);
    }
    let breaker = perCapability.get(capability);
    if (!breaker) {
      // The breaker keeps the plain provider id: it is the `provider` metric
      // label and the CircuitOpenError text, neither of which grows a dimension.
      breaker = new CircuitBreaker(providerId, {
        now: options.now,
        tripImmediately: isRateLimitError,
        ignoreFailure: isNotFoundError,
        ...options.breaker,
      });
      perCapability.set(capability, breaker);
    }
    return breaker;
  };
  /** open ≻ half-open ≻ closed, for the provider-level admin projection. */
  const STATE_SEVERITY: Record<CircuitState, number> = { closed: 0, 'half-open': 1, open: 2 };
  /** Worst state across a provider's capability breakers (never creates one). */
  const providerBreakerState = (providerId: string): CircuitState => {
    let worst: CircuitState = 'closed';
    for (const breaker of breakers.get(providerId)?.values() ?? []) {
      const state = breaker.getState();
      if (STATE_SEVERITY[state] > STATE_SEVERITY[worst]) worst = state;
    }
    return worst;
  };
  /**
   * Read-only breaker state (never creates one): a not-yet-called provider (or
   * capability) is closed. Without a capability, the provider's aggregate.
   */
  const breakerStateOf = (providerId: string, capability?: ProviderCapability): CircuitState =>
    capability === undefined
      ? providerBreakerState(providerId)
      : (breakers.get(providerId)?.get(capability)?.getState() ?? 'closed');

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
  const callUpstream = <T>(
    providerId: string,
    capability: ProviderCapability,
    fn: () => Promise<T>,
  ): Promise<T> =>
    breakerFor(providerId, capability).execute(() =>
      retryOnce(
        () => withTimeout(fn, timeoutMs),
        (err) => !isDefinitiveError(err),
      ),
    );

  /**
   * One failover-chained read: the chain tries the asset's own provider first,
   * then the configured secondaries, and every attempt goes through this
   * capability's breaker. Naming the capability once per call site keeps the
   * breaker scope and the chain's capability gate (history basis) in step.
   */
  const runChained = <T>(
    ref: AssetRef,
    capability: ProviderCapability,
    op: (provider: AssetProvider) => Promise<T>,
  ): Promise<T> =>
    resolver.run(
      ref,
      (providerId, fn) => callUpstream(providerId, capability, fn),
      op,
      isNotFoundError,
      capability,
    );

  /**
   * Revalidation gate: while a provider's breaker for this capability is open,
   * expired entries are served stale with no upstream attempt at all (§5.3 TTL
   * stretch). Once the cooldown elapses (half-open) the next revalidation is the
   * probe.
   */
  const revalidateGate = (providerId: string, capability: ProviderCapability) => (): boolean =>
    breakerFor(providerId, capability).getState() !== 'open';

  /**
   * Cache + coalesce + breaker-wrap one intel read against the asset's own
   * provider (§13.5 V5-P5). Rejects with {@link CapabilityUnavailableError} when
   * the provider does not implement the capability — the read layer treats that
   * exactly like a provider error and degrades to the "unconfigured" shape.
   *
   * The key carries the payload's shape version ({@link intelCacheVariant}), so
   * a release that changes what a payload means never reads back an entry the
   * previous release wrote.
   */
  const loadIntel = <T>(
    ref: AssetRef,
    capability: ProviderCapability,
    ttlSeconds: number,
    method: ((ref: AssetRef) => Promise<T>) | undefined,
  ): Promise<CachedResult<T>> => {
    const provider = registry.for(ref);
    if (typeof method !== 'function') {
      return Promise.reject(new CapabilityUnavailableError(provider.id, capability));
    }
    return cache.getOrLoad<T>({
      key: cacheKey(ref.providerId, ref.providerRef, 'intel', intelCacheVariant(capability)),
      ttlSeconds,
      staleTtlSeconds,
      negativeTtlSeconds,
      isNotFound: isNotFoundError,
      shouldRevalidate: revalidateGate(provider.id, capability),
      loader: () => callUpstream(provider.id, capability, () => method(ref)),
    });
  };

  return {
    isLocalProvider(ref) {
      return registry.for(ref).local === true;
    },

    async search(query) {
      const normalized = normalizeSearchQuery(query);
      if (normalized === '') return [];
      const settled = await Promise.allSettled(
        registry.all().map((provider) => {
          const load = (): Promise<AssetSearchResult[]> =>
            callUpstream(provider.id, 'search', () => provider.search(query));
          // Local providers search our own DB — nothing upstream to protect.
          if (provider.local) return load();
          return cache
            .getOrLoad<AssetSearchResult[]>({
              key: cacheKey(provider.id, '*', 'search', normalized),
              ttlSeconds: SEARCH_TTL_SECONDS,
              staleTtlSeconds,
              negativeTtlSeconds,
              isNotFound: isNotFoundError,
              shouldRevalidate: revalidateGate(provider.id, 'search'),
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
        return callUpstream(provider.id, 'quote', () => provider.getQuote(ref)).then((value) => ({
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
        shouldRevalidate: () => resolver.anyAvailable(ref, 'quote'),
        loader: () => runChained(ref, 'quote', (p) => p.getQuote(ref)),
      });
    },

    async pollQuote(ref) {
      const provider = registry.for(ref);
      if (provider.local) {
        return callUpstream(provider.id, 'quote', () => provider.getQuote(ref)).then((value) => ({
          value,
          stale: false,
          asOf: now(),
        }));
      }
      // Non-local: the same failover chain as getQuote, priming the shared cache.
      const value = await runChained(ref, 'quote', (p) => p.getQuote(ref));
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
        return callUpstream(provider.id, 'history', () =>
          provider.getHistory(ref, range, chosenInterval),
        ).then((value) => ({ value, stale: false, asOf: now() }));
      }
      return cache.getOrLoad<PricePoint[]>({
        key: cacheKey(ref.providerId, ref.providerRef, 'history', `${range}@${chosenInterval}`),
        ttlSeconds: historyTtlSeconds(range),
        staleTtlSeconds,
        negativeTtlSeconds,
        isNotFound: isNotFoundError,
        shouldRevalidate: () => resolver.anyAvailable(ref, 'history'),
        loader: () => runChained(ref, 'history', (p) => p.getHistory(ref, range, chosenInterval)),
      });
    },

    getMeta(ref) {
      const provider = registry.for(ref);
      if (provider.local) {
        return callUpstream(provider.id, 'meta', () => provider.getMeta(ref)).then((value) => ({
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
        shouldRevalidate: () => resolver.anyAvailable(ref, 'meta'),
        loader: () => runChained(ref, 'meta', (p) => p.getMeta(ref)),
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

    getFundamentals(ref) {
      const provider = registry.for(ref);
      return loadIntel<AssetFundamentals>(
        ref,
        'fundamentals',
        FUNDAMENTALS_TTL_SECONDS,
        provider.getFundamentals?.bind(provider),
      );
    },

    settled: () => cache.settled(),

    breakerStates: () =>
      registry
        .all()
        .filter((provider) => provider.local !== true)
        .map((provider) => ({
          providerId: provider.id,
          state: providerBreakerState(provider.id),
        })),

    breakerSnapshots: () =>
      registry
        .all()
        .filter((provider) => provider.local !== true)
        .map((provider) => {
          const live = breakers.get(provider.id);
          const capabilities = [...(live?.entries() ?? [])]
            .map(([capability, breaker]) => ({ capability, ...breaker.snapshot() }))
            // Worst first: an operator scanning the list should meet the open
            // breaker before the nine healthy ones.
            .sort((a, b) => STATE_SEVERITY[b.state] - STATE_SEVERITY[a.state]);
          return {
            providerId: provider.id,
            state: providerBreakerState(provider.id),
            capabilities,
          };
        }),

    failoverStatus: () => resolver.status(),
  };
}
