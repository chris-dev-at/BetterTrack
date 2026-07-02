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
 *    every keystroke, and concurrent processes coalesce too. The guard value
 *    distinguishes an enrichment still `running` from one that is `done`, so a
 *    caller who loses the NX race still reports the right `enriching` flag.
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
   * (started by this call, or already in flight in this or another process),
   * false when the guard says it completed recently, so the caller knows
   * whether "Searching providers…" applies.
   */
  request(query: string): Promise<boolean>;
  /** Resolves once every enrichment currently in flight has finished (graceful shutdown, deterministic tests). */
  settled(): Promise<void>;
}

/**
 * How long a query's enrichment result — including "the providers had nothing"
 * — is trusted before the fallback may run again (§5.3 negative-cache spirit).
 * The window restarts when the enrichment completes (guard flips to `done`).
 */
export const ENRICH_GUARD_TTL_SECONDS = 60;

/** Redis guard key per normalized query; lowercased so "BAYN" and "bayn" coalesce. */
export const enrichGuardKey = (query: string): string => `search:enrich:${query.toLowerCase()}`;

/** Guard value while the winning process is still running the provider search. */
export const ENRICH_GUARD_RUNNING = 'running';
/** Guard value once the enrichment finished — negative-cache window (§5.3). */
export const ENRICH_GUARD_DONE = 'done';

export interface CatalogEnrichmentDeps {
  marketData: MarketDataService;
  assetRepo: AssetRepository;
  backfill: BackfillScheduler;
  redis: Redis;
  logger: Logger;
}

interface InFlightEntry {
  /** The `request()` answer, resolved as soon as the coalescing decision is made. */
  enriching: Promise<boolean>;
  /** Resolves once the guard writes + provider search + upserts have all finished. */
  settled: Promise<void>;
}

export function createCatalogEnrichment(deps: CatalogEnrichmentDeps): CatalogEnrichment {
  const { marketData, assetRepo, backfill, redis, logger } = deps;
  const inFlight = new Map<string, InFlightEntry>();

  async function run(query: string): Promise<void> {
    try {
      const hits = await marketData.search(query);
      for (const hit of hits) {
        // A brand-new catalog row (§6.2 first touch): enqueue its history
        // backfill right away, exactly once. Rows that already existed —
        // seeded (§6.2(c)) or created by an earlier search — are warmed on
        // first *reference* instead (services/assets/referenceBackfill.ts).
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

  /**
   * Start (or decline) an enrichment for `key`. The caller registers the entry
   * in the in-flight map *synchronously*, before any await — so a concurrent
   * same-process request always finds it and shares this entry's answer instead
   * of losing the Redis NX race and misreporting `enriching: false` while a
   * search is genuinely running.
   */
  function begin(key: string, query: string): InFlightEntry {
    let resolveEnriching!: (enriching: boolean) => void;
    const enriching = new Promise<boolean>((resolve) => (resolveEnriching = resolve));

    const settled = (async () => {
      try {
        const acquired = await redis.set(
          key,
          ENRICH_GUARD_RUNNING,
          'EX',
          ENRICH_GUARD_TTL_SECONDS,
          'NX',
        );
        if (acquired !== 'OK') {
          // Guard held elsewhere: `running` means another process is enriching
          // this query right now; anything else means it completed within the
          // TTL window (negative cache) — nothing is in flight.
          resolveEnriching((await redis.get(key)) === ENRICH_GUARD_RUNNING);
          return;
        }
        resolveEnriching(true);
        await run(query);
        // Flip the guard to `done` so cross-process callers stop reporting
        // "enriching"; the fresh TTL trusts the result for a full window from
        // completion. `run` never throws, so this always executes.
        await redis.set(key, ENRICH_GUARD_DONE, 'EX', ENRICH_GUARD_TTL_SECONDS);
      } catch (err) {
        // A Redis hiccup must never fail /search (§6.2): log, report "not
        // enriching", and skip this fallback round.
        logger.warn({ err, query }, 'catalog enrichment guard failed');
      } finally {
        resolveEnriching(false); // no-op when already resolved
      }
    })();

    return { enriching, settled };
  }

  return {
    async request(query) {
      const key = enrichGuardKey(query);
      const existing = inFlight.get(key);
      if (existing) return existing.enriching;

      const entry = begin(key, query);
      inFlight.set(key, entry);
      void entry.settled.finally(() => inFlight.delete(key));
      return entry.enriching;
    },

    async settled() {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight.values()].map((entry) => entry.settled));
      }
    },
  };
}
