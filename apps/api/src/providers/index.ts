/**
 * Public surface of the market-data keystone (PROJECTPLAN.md §5.1). Services
 * outside this folder import only from here: the registry, the market-data
 * service and the provider interface — never a concrete provider.
 */
export type { AssetProvider } from './AssetProvider';
export { createProviderRegistry, type ProviderRegistry } from './registry';
export {
  createMarketDataService,
  defaultIntervalForRange,
  normalizeSearchQuery,
  type MarketDataService,
  type MarketDataServiceOptions,
  type CreateMarketDataServiceDeps,
} from './marketDataService';
export {
  createFailoverResolver,
  classifyRefClass,
  NO_FAILOVER,
  DEFAULT_MAX_SWITCH_EVENTS,
  type FailoverChains,
  type FailoverResolver,
  type FailoverStatus,
  type FailoverChainSummary,
  type FailoverSwitchEvent,
  type ProviderServeStat,
} from './failoverChain';
export { AssetNotFoundError, isNotFoundError, isRateLimitError } from './errors';
export {
  CircuitBreaker,
  CircuitOpenError,
  type CircuitState,
  type CircuitBreakerOptions,
} from './circuitBreaker';
export { TimeoutError, withTimeout, retryOnce, DEFAULT_TIMEOUT_MS } from './resilience';
export { rangeStartMs } from './historyWindow';
export { cacheKey, createMarketCache, type MarketCache } from './cache';
export {
  QUOTE_TTL_SECONDS,
  META_TTL_SECONDS,
  STALE_TTL_SECONDS,
  SEARCH_TTL_SECONDS,
  NEGATIVE_TTL_SECONDS,
  historyTtlSeconds,
} from './ttl';

// Concrete providers (§5.1, §5.2) and the composition root that registers them.
export { createYahooProvider, type CreateYahooProviderDeps } from './yahooProvider';
export { createYahooClient, type YahooClient } from './yahooClient';
export { createStooqProvider, type CreateStooqProviderDeps } from './stooqProvider';
export {
  createStooqClient,
  type StooqClient,
  type StooqQuoteRow,
  type StooqHistoryRow,
  type CreateStooqClientDeps,
} from './stooqClient';
export { mapToStooq, stooqCanServe, type StooqRef } from './stooqMapping';
export {
  createManualProvider,
  createManualAssetSource,
  type CreateManualProviderDeps,
  type ManualAssetSource,
  type ManualAssetRecord,
  type ManualValuePoint,
} from './manualProvider';
export {
  createRequestQueue,
  isRetryableUpstreamError,
  DEFAULT_CONCURRENCY,
  DEFAULT_MIN_SPACING_MS,
  type RequestQueue,
  type RequestQueueOptions,
} from './requestQueue';
export {
  createMarketData,
  STOOQ_FAILOVER_CHAINS,
  type CreateMarketDataDeps,
  type MarketData,
} from './createMarketData';
