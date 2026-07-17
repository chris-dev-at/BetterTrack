import type { Redis } from 'ioredis';

import type { Database } from '../data/db';

import type { AssetProvider } from './AssetProvider';
import type { FailoverChains } from './failoverChain';
import { createManualAssetSource, createManualProvider } from './manualProvider';
import {
  createMarketDataService,
  type MarketDataService,
  type MarketDataServiceOptions,
} from './marketDataService';
import { createProviderRegistry, type ProviderRegistry } from './registry';
import type { RequestQueueOptions } from './requestQueue';
import { createStooqClient, type StooqClient } from './stooqClient';
import { createStooqProvider } from './stooqProvider';
import { createYahooClient, type YahooClient } from './yahooClient';
import { createYahooProvider } from './yahooProvider';

/**
 * Failover chains when the Stooq secondary is enabled (§13.5 V5-P1c): equities/
 * ETFs/indices fall back to Stooq; crypto/FX/commodities stay Yahoo-only (Stooq
 * has no cheap keyless coverage there). Adding a third source is a one-line edit
 * here plus registering the provider — config-only, no architecture change.
 */
export const STOOQ_FAILOVER_CHAINS: FailoverChains = {
  byClass: { crypto: [], fx: [], commodity: [] },
  default: ['stooq'],
};

/**
 * Composition root for the market-data layer (PROJECTPLAN.md §5.1–§5.2): build
 * the concrete providers, register them, and wrap them in the caching/resilience
 * service. `registry.for(asset)` then resolves any asset by `providerId`. This is
 * the single place that knows the Yahoo, Stooq and manual providers exist.
 */
export interface CreateMarketDataDeps {
  db: Database;
  redis: Redis;
  /** Test seam: inject a stubbed Yahoo client; defaults to the live one. */
  yahooClient?: YahooClient;
  /** Test seam: inject a stubbed Stooq client; defaults to the live one. */
  stooqClient?: StooqClient;
  /**
   * Provider failover (§13.5 V5-P1c). When `enabled`, the Stooq secondary is
   * registered and the {@link STOOQ_FAILOVER_CHAINS} apply; when off (the
   * default) only Yahoo + manual are registered and behaviour is byte-identical
   * to a single-provider setup.
   */
  failover?: { enabled: boolean };
  /** Per-provider request budget (concurrency + spacing, §5.3), from config §11. */
  queueOptions?: RequestQueueOptions;
  options?: MarketDataServiceOptions;
}

export interface MarketData {
  registry: ProviderRegistry;
  service: MarketDataService;
}

export function createMarketData(deps: CreateMarketDataDeps): MarketData {
  const yahoo = createYahooProvider({
    client: deps.yahooClient ?? createYahooClient(),
    queueOptions: deps.queueOptions,
  });
  const manual = createManualProvider({ source: createManualAssetSource(deps.db) });

  const failoverEnabled = deps.failover?.enabled === true;
  const providers: AssetProvider[] = [yahoo];
  if (failoverEnabled) {
    providers.push(
      createStooqProvider({
        client: deps.stooqClient ?? createStooqClient(),
        queueOptions: deps.queueOptions,
      }),
    );
  }
  // Manual (local) last: it never participates in failover.
  providers.push(manual);

  const registry = createProviderRegistry(providers);
  const service = createMarketDataService({
    registry,
    redis: deps.redis,
    options: {
      ...deps.options,
      failover: failoverEnabled ? STOOQ_FAILOVER_CHAINS : deps.options?.failover,
    },
  });
  return { registry, service };
}
