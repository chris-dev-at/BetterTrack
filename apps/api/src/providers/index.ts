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
  type MarketDataService,
  type MarketDataServiceOptions,
  type CreateMarketDataServiceDeps,
} from './marketDataService';
export {
  CircuitBreaker,
  CircuitOpenError,
  type CircuitState,
  type CircuitBreakerOptions,
} from './circuitBreaker';
export { TimeoutError, withTimeout, retryOnce, DEFAULT_TIMEOUT_MS } from './resilience';
export { cacheKey, createMarketCache, type MarketCache } from './cache';
export { QUOTE_TTL_SECONDS, META_TTL_SECONDS, STALE_TTL_SECONDS, historyTtlSeconds } from './ttl';

// Concrete providers (§5.1, §5.2) and the composition root that registers them.
export { createYahooProvider, type CreateYahooProviderDeps } from './yahooProvider';
export { createYahooClient, type YahooClient } from './yahooClient';
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
  type RequestQueue,
  type RequestQueueOptions,
} from './requestQueue';
export { createMarketData, type CreateMarketDataDeps, type MarketData } from './createMarketData';
