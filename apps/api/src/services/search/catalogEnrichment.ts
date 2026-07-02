import type { Redis } from 'ioredis';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import type { BackfillScheduler } from '../../jobs';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';

/**
 * Provider-fallback orchestration for the local-first search (PROJECTPLAN.md
 * §6.2, §5.3): when the catalog comes up short, a provider search runs in the
 * **background** and upserts its hits into the catalog — the HTTP response
 * never waits on a provider. The client refetches after a short delay
 * ("Searching providers…") and the follow-up query is served the enriched rows
 * straight from Postgres.
 *
 * Coalescing is per normalized query, two layers deep:
 *  - an in-process in-flight map, so concurrent misses share one provider search;
 *  - a short-TTL Redis `SET NX` guard, so a just-enriched query — including one
 *    the providers had nothing for (a negative result) — is not re-fetched on
 *    every keystroke, and concurrent processes coalesce too.
 *
 * Per-provider request budgets are part of the §5.3 caching keystone (its own
 * P1 slice); this module consumes `marketData.search`, which is already
 * resilience-wrapped per provider, and adds no budgeting of its own.
 */
export interface CatalogEnrichment {
  /**
   * Request a background provider search for the (normalized) `query`.
   * Resolves as soon as the coalescing decision is made — never waits on a
   * provider. Returns true when an enrichment for this query is now running
   * (started by this call or already in flight), false when the guard says it
   * ran recently, so the caller knows whether "Searching providers…" applies.
   */
  request(query: string): Promise<boolean>;
  /** Resolves once every enrichment currently in flight has finished (graceful shutdown, deterministic tests). */
  settled(): Promise<void>;
}

/**
 * How long a query's enrichment result — including "the providers had nothing"
 * — is trusted before the fallback may run again (§5.3 negative-cache spirit).
 */
export const ENRICH_GUARD_TTL_SECONDS = 60;

/** Redis guard key per normalized query; lowercased so "BAYN" and "bayn" coalesce. */
export const enrichGuardKey = (query: string): string => `search:enrich:${query.toLowerCase()}`;

export interface CatalogEnrichmentDeps {
  marketData: MarketDataService;
  assetRepo: AssetRepository;
  backfill: BackfillScheduler;
  redis: Redis;
  logger: Logger;
}

export function createCatalogEnrichment(deps: CatalogEnrichmentDeps): CatalogEnrichment {
  const { marketData, assetRepo, backfill, redis, logger } = deps;
  const inFlight = new Map<string, Promise<void>>();

  async function run(query: string): Promise<void> {
    try {
      const hits = await marketData.search(query);
      for (const hit of hits) {
        // First touch (§6.2): materialize a global catalog row and enqueue a
        // history backfill exactly once — only when this call created it.
        const { row, created } = await assetRepo.upsertGlobal({
          providerId: hit.providerId,
          providerRef: hit.providerRef,
          type: hit.type,
          symbol: hit.symbol,
          name: hit.name,
          exchange: hit.exchange ?? null,
          currency: hit.currency,
        });
        if (created) await backfill.enqueue(row.id);
      }
    } catch (err) {
      // A provider outage or 404 must never surface to the user (§6.2) — they
      // already got the catalog results; the fallback just found nothing new.
      logger.warn({ err, query }, 'catalog enrichment failed');
    }
  }

  return {
    async request(query) {
      const key = enrichGuardKey(query);
      if (inFlight.has(key)) return true;

      const acquired = await redis.set(key, '1', 'EX', ENRICH_GUARD_TTL_SECONDS, 'NX');
      if (acquired !== 'OK') return false;

      const promise = run(query).finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return true;
    },

    async settled() {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight.values()]);
      }
    },
  };
}
