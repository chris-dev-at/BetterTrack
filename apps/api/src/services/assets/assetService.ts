import type {
  AssetDetailResponse,
  AssetSummary,
  HistoryRange,
  HistoryResponse,
  QuoteResponse,
  SearchResultItem,
} from '@bettertrack/contracts';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import type { AssetRow } from '../../data/schema';
import { badGateway, notFound } from '../../errors';
import type { BackfillScheduler } from '../../jobs';
import { defaultIntervalForRange, type MarketDataService } from '../../providers';

/**
 * The market-data read API (PROJECTPLAN.md §6.2, §6.3, §8): search and the asset
 * detail/quote/history endpoints over the provider/cache layer.
 *
 * It owns two responsibilities the routes stay clear of:
 *  - **first touch** (§6.2): every provider search hit is upserted into a global
 *    `assets` row and, the first time only, a history backfill is enqueued;
 *  - **access scoping** (§10): asset lookups go through the repository, which
 *    only ever returns a global asset or the caller's own custom asset.
 */
export interface AssetService {
  /** Provider search merged with the caller's matching custom assets (§6.2). */
  search(userId: string, query: string): Promise<SearchResultItem[]>;
  /** Asset meta + latest quote (§6.3). */
  getDetail(userId: string, id: string): Promise<AssetDetailResponse>;
  /** Latest quote with stale/asOf markers (§6.3). */
  getQuote(userId: string, id: string): Promise<QuoteResponse>;
  /** Price history for a range; interval follows the §5.3 table. */
  getHistory(userId: string, id: string, range: HistoryRange): Promise<HistoryResponse>;
}

export interface AssetServiceDeps {
  marketData: MarketDataService;
  assetRepo: AssetRepository;
  backfill: BackfillScheduler;
}

/** Epoch-ms (the cache's `asOf`) → ISO-8601 for the wire. */
const asOfIso = (asOf: number): string => new Date(asOf).toISOString();

const toSummary = (row: AssetRow): AssetSummary => ({
  id: row.id,
  providerId: row.providerId,
  providerRef: row.providerRef,
  symbol: row.symbol,
  name: row.name,
  exchange: row.exchange ?? null,
  currency: row.currency,
  type: row.type,
  isCustom: row.ownerId !== null,
});

export function createAssetService(deps: AssetServiceDeps): AssetService {
  const { marketData, assetRepo, backfill } = deps;

  async function requireAsset(userId: string, id: string): Promise<AssetRow> {
    const row = await assetRepo.findByIdForUser(id, userId);
    // A global asset or the caller's own custom asset, else 404 — another user's
    // custom asset is indistinguishable from missing, so nothing leaks (§10).
    if (!row) throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
    return row;
  }

  return {
    async search(userId, query) {
      // Provider fan-out (failing providers are skipped inside the service).
      const providerHits = await marketData.search(query);

      const marketItems: SearchResultItem[] = [];
      for (const hit of providerHits) {
        // First touch (§6.2): materialize a global row so the result has an id,
        // and enqueue a backfill exactly once — only when this call created it.
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
        marketItems.push({ ...toResultItem(row), isCustom: false });
      }

      // The caller's own custom assets matching by name (§6.2).
      const customMatches = await assetRepo.searchCustomByName(userId, query);
      const customItems: SearchResultItem[] = customMatches.map((c) => ({
        id: c.id,
        providerId: c.providerId,
        providerRef: c.providerRef,
        symbol: c.symbol,
        name: c.name,
        exchange: c.exchange ?? null,
        type: c.type,
        currency: c.currency,
        isCustom: true,
      }));

      // Provider hits first, then the caller's own assets; de-duplicate by id so
      // an asset never appears twice if both sides surface it.
      const merged: SearchResultItem[] = [];
      const seen = new Set<string>();
      for (const item of [...marketItems, ...customItems]) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        merged.push(item);
      }
      return merged;
    },

    async getDetail(userId, id) {
      const row = await requireAsset(userId, id);
      const asset = toSummary(row);
      try {
        const cached = await marketData.getQuote({
          providerId: row.providerId,
          providerRef: row.providerRef,
        });
        return {
          asset,
          quote: cached.value,
          stale: cached.stale,
          asOf: asOfIso(cached.asOf),
        };
      } catch {
        // Meta always resolves from the stored row; the quote is best-effort, so
        // a provider outage with no cached copy degrades to a null quote rather
        // than failing the whole page (§6.3).
        return { asset, quote: null, stale: true, asOf: null };
      }
    },

    async getQuote(userId, id) {
      const row = await requireAsset(userId, id);
      try {
        const cached = await marketData.getQuote({
          providerId: row.providerId,
          providerRef: row.providerRef,
        });
        return { quote: cached.value, stale: cached.stale, asOf: asOfIso(cached.asOf) };
      } catch {
        throw badGateway();
      }
    },

    async getHistory(userId, id, range) {
      const row = await requireAsset(userId, id);
      const interval = defaultIntervalForRange(range);
      try {
        const cached = await marketData.getHistory(
          { providerId: row.providerId, providerRef: row.providerRef },
          range,
        );
        return {
          range,
          interval,
          points: cached.value,
          stale: cached.stale,
          asOf: asOfIso(cached.asOf),
        };
      } catch {
        throw badGateway();
      }
    },
  };
}

/** Map a stored asset row to the shared search-result fields. */
function toResultItem(row: AssetRow): Omit<SearchResultItem, 'isCustom'> {
  return {
    id: row.id,
    providerId: row.providerId,
    providerRef: row.providerRef,
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange ?? null,
    type: row.type,
    currency: row.currency,
  };
}
