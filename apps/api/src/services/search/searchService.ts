import type { SearchResponse, SearchResultItem } from '@bettertrack/contracts';

import type { AssetRepository, CatalogSearchMatch } from '../../data/repositories/assetRepository';
import type { ParanoidModeGuard } from '../account/paranoidEnforcement';
import type { CatalogEnrichment } from './catalogEnrichment';

/**
 * Local-first search (PROJECTPLAN.md §6.2): `GET /search?q=` answers from the
 * Postgres asset catalog in a single round-trip — ranked exact-symbol → symbol-
 * prefix → name → fuzzy, with the caller's own custom assets merged in by the
 * same ranking (owner-scoped in the repository, §10). There is **never** a
 * synchronous provider call on this path; a thin catalog triggers a background,
 * coalesced provider search instead (see {@link CatalogEnrichment}) and the
 * response says so via `enriching`.
 */
export interface SearchService {
  search(userId: string, rawQuery: string, options?: SearchOptions): Promise<SearchResponse>;
  /**
   * Route-level search + conditional-read watermark under one privacy lock, so
   * a mode transition cannot land between body and freshness construction.
   */
  searchWithFreshness(
    userId: string,
    rawQuery: string,
  ): Promise<SearchResponse & { freshness: Date | null }>;
  /**
   * Freshness watermark for the conditional catalog-search read (issue #555):
   * the creation time of the newest asset in the caller's visible catalog
   * (global assets + their own custom assets). Drives `Last-Modified`; null
   * when empty. Kept separate from {@link SearchService.search} so its return
   * stays the exact `SearchResponse` contract shape.
   */
  catalogFreshness(userId: string): Promise<Date | null>;
  /** Resolves once in-flight background enrichments have finished (graceful shutdown, deterministic tests). */
  enrichmentSettled(): Promise<void>;
}

export interface SearchOptions {
  /**
   * Whether a thin local result set may start provider enrichment. User-facing
   * search defaults to true; bounded batch workflows can perform a complete
   * catalog-only pass before explicitly admitting provider work.
   */
  allowEnrichment?: boolean;
}

/** Cap on returned rows — the UI shows a short list, not a browse page (§6.2). */
export const SEARCH_RESULT_LIMIT = 20;

/**
 * Fewer *market* matches than this counts as a catalog miss and triggers the
 * provider fallback (§6.2). Custom assets don't count — providers can never
 * enrich those.
 */
export const CATALOG_MISS_THRESHOLD = 3;

/** Trim and collapse inner whitespace so ranking and coalescing see one canonical query. */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export interface SearchServiceDeps {
  assetRepo: AssetRepository;
  enrichment: CatalogEnrichment;
  /** Mixed global/custom catalog filtering under the account transition lock. */
  paranoid?: Pick<ParanoidModeGuard, 'runAllowedWithOptional'>;
}

const toResultItem = (match: CatalogSearchMatch): SearchResultItem => ({
  id: match.id,
  providerId: match.providerId,
  providerRef: match.providerRef,
  symbol: match.symbol,
  name: match.name,
  exchange: match.exchange,
  type: match.type,
  currency: match.currency,
  isCustom: match.ownerId !== null,
  // Search answers from the catalog with no synchronous provider call (§6.2),
  // so a live session state is not available per row. The one state knowable
  // without a quote is the always-on case: crypto trades 24/7 ⇒ `open`. Every
  // other type is left unset so the row renders no (possibly wrong) badge.
  ...(match.type === 'crypto' ? { marketState: 'open' as const } : {}),
});

export function createSearchService(deps: SearchServiceDeps): SearchService {
  const { assetRepo, enrichment, paranoid } = deps;

  async function withCatalogVisibility<T>(
    userId: string,
    read: (includeCustomAssets: boolean) => Promise<T>,
  ): Promise<T> {
    if (!paranoid) return read(true);
    return paranoid.runAllowedWithOptional([], [userId], 'portfolioServer', (normalUserIds) =>
      read(normalUserIds.has(userId)),
    );
  }

  async function searchCatalog(
    userId: string,
    rawQuery: string,
    includeCustomAssets: boolean,
    options?: SearchOptions,
  ): Promise<SearchResponse> {
    const query = normalizeQuery(rawQuery);
    const matches = await assetRepo.searchCatalog(userId, query, SEARCH_RESULT_LIMIT, {
      includeCustomAssets,
    });
    const results = matches.map(toResultItem);

    const marketMatches = matches.filter((m) => m.ownerId === null).length;
    const enriching =
      options?.allowEnrichment !== false && marketMatches < CATALOG_MISS_THRESHOLD
        ? // Fire-and-forget: resolves after the coalescing decision, never
          // waits on a provider (§6.2). False when it ran recently, so a
          // refetching client doesn't spin forever.
          await enrichment.request(query)
        : false;

    return { results, enriching };
  }

  return {
    search: (userId, rawQuery, options) =>
      withCatalogVisibility(userId, (includeCustomAssets) =>
        searchCatalog(userId, rawQuery, includeCustomAssets, options),
      ),

    searchWithFreshness: (userId, rawQuery) =>
      withCatalogVisibility(userId, async (includeCustomAssets) => {
        const result = await searchCatalog(userId, rawQuery, includeCustomAssets);
        const freshness = await assetRepo.catalogWatermark(userId, { includeCustomAssets });
        return { ...result, freshness };
      }),

    catalogFreshness: (userId) =>
      withCatalogVisibility(userId, (includeCustomAssets) =>
        assetRepo.catalogWatermark(userId, { includeCustomAssets }),
      ),

    enrichmentSettled: () => enrichment.settled(),
  };
}
