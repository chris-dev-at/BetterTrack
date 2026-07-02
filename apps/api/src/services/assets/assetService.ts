import type {
  AssetDetailResponse,
  AssetSummary,
  HistoryRange,
  HistoryResponse,
  QuoteResponse,
} from '@bettertrack/contracts';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import type { AssetRow } from '../../data/schema';
import { badGateway, notFound } from '../../errors';
import { defaultIntervalForRange, type MarketDataService } from '../../providers';
import type { CurrencyService } from '../currency/currencyService';

/**
 * The asset read API (PROJECTPLAN.md §6.3, §8): detail/quote/history endpoints
 * over the provider/cache layer. Search lives in `services/search` (§6.2) —
 * local-first over the catalog, never a synchronous provider call.
 *
 * Access scoping (§10) is owned here via the repository, which only ever
 * returns a global asset or the caller's own custom asset.
 */
export interface AssetService {
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
  /** Single conversion keystone (§5.4) — all EUR conversion routes through here. */
  currencyService: CurrencyService;
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
  const { marketData, assetRepo, currencyService } = deps;

  async function requireAsset(userId: string, id: string): Promise<AssetRow> {
    const row = await assetRepo.findByIdForUser(id, userId);
    // A global asset or the caller's own custom asset, else 404 — another user's
    // custom asset is indistinguishable from missing, so nothing leaks (§10).
    if (!row) throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
    return row;
  }

  return {
    async getDetail(userId, id) {
      const row = await requireAsset(userId, id);
      const asset = toSummary(row);
      try {
        const cached = await marketData.getQuote({
          providerId: row.providerId,
          providerRef: row.providerRef,
        });

        // EUR conversion for foreign assets (§6.3, §5.4). All conversion routes
        // through the currency keystone — no inline FX math here. Best-effort:
        // null when the spot rate is unavailable, absent when already EUR.
        let eurPriceEntry: { eurPrice: number | null } | undefined;
        if (asset.currency !== 'EUR') {
          try {
            eurPriceEntry = {
              eurPrice: await currencyService.toBase(cached.value.price, asset.currency),
            };
          } catch {
            eurPriceEntry = { eurPrice: null };
          }
        }

        return {
          asset,
          quote: cached.value,
          stale: cached.stale,
          asOf: asOfIso(cached.asOf),
          ...eurPriceEntry,
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
