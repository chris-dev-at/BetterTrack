import type { Redis } from 'ioredis';

import type { Database } from '../data/db';

import { createManualAssetSource, createManualProvider } from './manualProvider';
import {
  createMarketDataService,
  type MarketDataService,
  type MarketDataServiceOptions,
} from './marketDataService';
import { createProviderRegistry, type ProviderRegistry } from './registry';
import { createYahooClient, type YahooClient } from './yahooClient';
import { createYahooProvider } from './yahooProvider';

/**
 * Composition root for the market-data layer (PROJECTPLAN.md §5.1–§5.2): build
 * the concrete providers, register them, and wrap them in the caching/resilience
 * service. `registry.for(asset)` then resolves any asset by `providerId`. This is
 * the single place that knows the Yahoo and manual providers exist.
 */
export interface CreateMarketDataDeps {
  db: Database;
  redis: Redis;
  /** Test seam: inject a stubbed Yahoo client; defaults to the live one. */
  yahooClient?: YahooClient;
  options?: MarketDataServiceOptions;
}

export interface MarketData {
  registry: ProviderRegistry;
  service: MarketDataService;
}

export function createMarketData(deps: CreateMarketDataDeps): MarketData {
  const yahoo = createYahooProvider({ client: deps.yahooClient ?? createYahooClient() });
  const manual = createManualProvider({ source: createManualAssetSource(deps.db) });
  const registry = createProviderRegistry([yahoo, manual]);
  const service = createMarketDataService({
    registry,
    redis: deps.redis,
    options: deps.options,
  });
  return { registry, service };
}
