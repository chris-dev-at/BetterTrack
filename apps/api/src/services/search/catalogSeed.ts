import type { AssetRepository, GlobalAssetUpsert } from '../../data/repositories/assetRepository';
import { CATALOG_SEED_ENTRIES } from './catalogSeedData';

/**
 * Seed-list plumbing for the shipped common-symbols catalog (PROJECTPLAN.md
 * §6.2(c)): major indices and DAX/ATX/S&P constituents ship with the app so
 * first searches hit the local catalog, not a provider. This module is the
 * *hook* — idempotent upsert of a seed list at boot (`pnpm db:seed`), the list
 * content itself living in {@link ./catalogSeedData}.
 *
 * Boot IS the refresh path (#1810). There is no `catalog.enrich` job — an
 * earlier version of this comment cited one that was never written — so the two
 * writers that keep a global row honest are this seed and the interactive
 * provider fallback, both through `assetRepository.upsertGlobal`, which now
 * corrects the provider-owned columns of a row it finds instead of leaving it
 * frozen at whatever its first touch happened to say.
 */
export type CatalogSeedEntry = GlobalAssetUpsert;

/**
 * The shipped common-symbols list (§6.2(c)) — major global indices, the world/EM
 * UCITS + flagship US ETFs, DAX 40 / ATX 20 / S&P 500 constituents, top cryptos,
 * major FX pairs and key commodities. The content lives in {@link ./catalogSeedData}
 * (~600+ rows); this module owns the idempotent, backfill-free upsert plumbing.
 */
export const COMMON_SYMBOLS_SEED: readonly CatalogSeedEntry[] = CATALOG_SEED_ENTRIES;

export interface CatalogSeedResult {
  /** Rows this run inserted. */
  created: number;
  /** Rows that already existed — refreshed or not, so `created + existing` is the entry count. */
  existing: number;
  /**
   * Of the `existing` rows, how many carried stale provider-owned fields that
   * this run corrected (#1810). Zero for an unchanged re-seed, which writes
   * nothing; non-zero exactly when a shipped entry has been edited since the
   * install last booted.
   */
  refreshed: number;
}

/**
 * Idempotently upsert `entries` as global catalog rows. Seeding deliberately
 * enqueues **no** history backfills — hundreds of untouched seed rows must not
 * flood the queue at boot. A seeded asset's history is backfilled the first
 * time a user actually *references* it (workboard add / transaction) by the
 * first-reference trigger in `services/assets/referenceBackfill.ts` (§6.2, §9).
 *
 * Re-seeding an install whose shipped list has since been corrected updates the
 * affected rows in place (same id, so every transaction and watchlist entry
 * pointing at them survives); an unchanged entry is not written at all.
 */
export async function seedAssetCatalog(
  assetRepo: AssetRepository,
  entries: readonly CatalogSeedEntry[],
): Promise<CatalogSeedResult> {
  let created = 0;
  let existing = 0;
  let refreshed = 0;
  for (const entry of entries) {
    const { created: wasCreated, refreshed: wasRefreshed } = await assetRepo.upsertGlobal(entry);
    if (wasCreated) created += 1;
    else existing += 1;
    if (wasRefreshed) refreshed += 1;
  }
  return { created, existing, refreshed };
}
