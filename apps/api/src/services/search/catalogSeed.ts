import type { AssetRepository, GlobalAssetUpsert } from '../../data/repositories/assetRepository';
import { CATALOG_SEED_ENTRIES } from './catalogSeedData';

/**
 * Seed-list plumbing for the shipped common-symbols catalog (PROJECTPLAN.md
 * §6.2(c)): major indices and DAX/ATX/S&P constituents ship with the app so
 * first searches hit the local catalog, not a provider. This module is the
 * *hook* — idempotent upsert of a seed list at boot (`pnpm db:seed`). The list
 * content itself (and the `catalog.enrich` job that keeps rows fresh) is
 * authored in the P1 T2 slice.
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
  /** Rows that already existed (re-seed is a no-op per entry). */
  existing: number;
}

/**
 * Idempotently upsert `entries` as global catalog rows. Seeding deliberately
 * enqueues **no** history backfills — hundreds of untouched seed rows must not
 * flood the queue at boot. A seeded asset's history is backfilled the first
 * time a user actually *references* it (workboard add / transaction) by the
 * first-reference trigger in `services/assets/referenceBackfill.ts` (§6.2, §9).
 */
export async function seedAssetCatalog(
  assetRepo: AssetRepository,
  entries: readonly CatalogSeedEntry[],
): Promise<CatalogSeedResult> {
  let created = 0;
  let existing = 0;
  for (const entry of entries) {
    const { created: wasCreated } = await assetRepo.upsertGlobal(entry);
    if (wasCreated) created += 1;
    else existing += 1;
  }
  return { created, existing };
}
