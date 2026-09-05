import {
  REFRESHABLE_ASSET_FIELDS,
  type AssetRepository,
  type GlobalAssetUpsert,
} from '../../data/repositories/assetRepository';
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
 * corrects a row it finds instead of leaving it frozen at whatever its first
 * touch happened to say. They correct DIFFERENT columns and never the same row:
 * see {@link isCuratedCatalogRef}.
 */
export type CatalogSeedEntry = GlobalAssetUpsert;

/**
 * The shipped common-symbols list (§6.2(c)) — major global indices, the world/EM
 * UCITS + flagship US ETFs, DAX 40 / ATX 20 / S&P 500 constituents, top cryptos,
 * major FX pairs and key commodities. The content lives in {@link ./catalogSeedData}
 * (~600+ rows); this module owns the idempotent, backfill-free upsert plumbing.
 */
export const COMMON_SYMBOLS_SEED: readonly CatalogSeedEntry[] = CATALOG_SEED_ENTRIES;

/** `(providerId, providerRef)` of every shipped entry, as one comparable string. */
const CURATED_REFS: ReadonlySet<string> = new Set(
  CATALOG_SEED_ENTRIES.map((entry) => `${entry.providerId}\u0000${entry.providerRef}`),
);

/**
 * Whether this `(providerId, providerRef)` is one the shipped list curates.
 *
 * The interactive provider fallback asks before it refreshes anything (#1810
 * review). Both writers reach the same rows — a user searching "dax" gets
 * Yahoo hits for refs the seed already owns — and they describe them
 * differently on purpose: the list carries a curated `exchange` (`XETRA`) and
 * a curated `name`, Yahoo returns `exchDisp` and its own casing. Left to fight,
 * each would rewrite the other's value, and because the catalog watermark is
 * stamped per content-changing STATEMENT and is instance-wide, every flip would
 * push the search `Last-Modified` another second ahead for every client. So the
 * curated list wins on its own rows: corrections to them ship in a release, not
 * from a picker projection.
 */
export const isCuratedCatalogRef = (providerId: string, providerRef: string): boolean =>
  CURATED_REFS.has(`${providerId}\u0000${providerRef}`);

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
 *
 * The seed refreshes EVERY descriptive column, unlike the provider fallback
 * (`catalogEnrichment.ts`), because this list is curated: each row's type,
 * exchange and native currency were checked by hand against the real listing,
 * so it is the one writer entitled to correct `currency` — the column
 * `portfolioService` converts persisted cash movements through.
 */
export async function seedAssetCatalog(
  assetRepo: AssetRepository,
  entries: readonly CatalogSeedEntry[],
): Promise<CatalogSeedResult> {
  let created = 0;
  let existing = 0;
  let refreshed = 0;
  for (const entry of entries) {
    const { created: wasCreated, refreshed: wasRefreshed } = await assetRepo.upsertGlobal(entry, {
      refresh: REFRESHABLE_ASSET_FIELDS,
    });
    if (wasCreated) created += 1;
    else existing += 1;
    if (wasRefreshed) refreshed += 1;
  }
  return { created, existing, refreshed };
}
