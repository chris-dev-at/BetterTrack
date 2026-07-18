import type { AssetRef, MarketIntelCapabilities } from '@bettertrack/contracts';

import { ApiError } from '../errors';

import type { AssetProvider } from './AssetProvider';

/**
 * Which optional market-intelligence capabilities (§13.5 V5-P5) a provider
 * advertises, derived purely from which methods it implements. Capabilities are
 * per provider and NOT assumed universal: a secondary/failover source that
 * implements none simply reports all `false`, and the read layer degrades to the
 * "unconfigured" shape for it.
 */
export function providerCapabilities(provider: AssetProvider): MarketIntelCapabilities {
  return {
    dividends: typeof provider.getDividendEvents === 'function',
    earnings: typeof provider.getEarningsEvents === 'function',
    news: typeof provider.getNewsHeadlines === 'function',
    splits: typeof provider.getSplitEvents === 'function',
  };
}

/**
 * Central map of `providerId → AssetProvider` (PROJECTPLAN.md §5.1). The rest of
 * the system asks the registry for the provider behind an asset and calls the
 * interface; it never knows or cares which concrete provider answers.
 */
export interface ProviderRegistry {
  /** Register a provider. Throws on a duplicate id so wiring mistakes fail loud. */
  register(provider: AssetProvider): void;
  /** True if a provider with this id is registered. */
  has(providerId: string): boolean;
  /** Provider by id; throws `PROVIDER_NOT_FOUND` (500) if absent. */
  get(providerId: string): AssetProvider;
  /** Provider that owns this asset ref. */
  for(ref: Pick<AssetRef, 'providerId'>): AssetProvider;
  /** All registered provider ids (for fan-out search). */
  ids(): string[];
  /** All registered providers (for fan-out search). */
  all(): AssetProvider[];
  /**
   * Market-intelligence capabilities (§13.5 V5-P5) the given provider advertises.
   * Throws `PROVIDER_NOT_FOUND` (500) if the id is absent — the same contract as
   * {@link ProviderRegistry.get}.
   */
  capabilitiesFor(providerId: string): MarketIntelCapabilities;
}

const providerNotFound = (providerId: string) =>
  new ApiError(
    500,
    'PROVIDER_NOT_FOUND',
    `No market-data provider registered for "${providerId}".`,
  );

export function createProviderRegistry(initial: AssetProvider[] = []): ProviderRegistry {
  const providers = new Map<string, AssetProvider>();

  const registry: ProviderRegistry = {
    register(provider) {
      if (providers.has(provider.id)) {
        throw new ApiError(
          500,
          'PROVIDER_DUPLICATE',
          `A market-data provider with id "${provider.id}" is already registered.`,
        );
      }
      providers.set(provider.id, provider);
    },
    has(providerId) {
      return providers.has(providerId);
    },
    get(providerId) {
      const provider = providers.get(providerId);
      if (!provider) throw providerNotFound(providerId);
      return provider;
    },
    for(ref) {
      return registry.get(ref.providerId);
    },
    ids() {
      return [...providers.keys()];
    },
    all() {
      return [...providers.values()];
    },
    capabilitiesFor(providerId) {
      return providerCapabilities(registry.get(providerId));
    },
  };

  for (const provider of initial) registry.register(provider);
  return registry;
}
