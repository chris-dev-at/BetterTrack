import { ASSET_SPARKLINE_MAX_POINTS } from '@bettertrack/contracts';
import type {
  AssetBatchQuote,
  AssetDetailResponse,
  AssetQuotesResponse,
  AssetSparklinesResponse,
  AssetSummary,
  DailyClosesResponse,
  HistoryInterval,
  HistoryRange,
  HistoryResponse,
  QuoteResponse,
} from '@bettertrack/contracts';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import type { AssetRow } from '../../data/schema';
import { badGateway, notFound } from '../../errors';
import { defaultIntervalForRange, type MarketDataService } from '../../providers';
import { ParanoidModeError, type ParanoidModeGuard } from '../account/paranoidEnforcement';
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
  getDetail(
    userId: string,
    id: string,
    opts?: { baseCurrency?: string },
  ): Promise<AssetDetailResponse>;
  /** Latest quote with stale/asOf markers (§6.3). */
  getQuote(userId: string, id: string): Promise<QuoteResponse>;
  /**
   * Many latest quotes in one owner-scoped read. Per-row isolated: ids the
   * caller cannot see and rows the provider cannot price are omitted, never
   * escalated into a failure for the whole set. A row the provider *failed* on
   * is reported in `failed` so the caller can present the outage — omission
   * alone would make it silent and unretryable.
   */
  getQuotes(userId: string, ids: readonly string[]): Promise<AssetQuotesResponse>;
  /** Compact one-month daily series for many workboard rows; per-row isolated. */
  getSparklines(userId: string, ids: readonly string[]): Promise<AssetSparklinesResponse>;
  /** Price history for a range; interval follows the §5.3 table. */
  getHistory(userId: string, id: string, range: HistoryRange): Promise<HistoryResponse>;
  /**
   * Full available **daily** close series (§5.3), forced to `1d` — the source
   * for the transaction form's linked date ↔ price fields (#226). Best-effort:
   * a degraded provider with nothing cached yields an empty series, never a 502.
   */
  getDailyCloses(userId: string, id: string): Promise<DailyClosesResponse>;
}

export interface AssetServiceDeps {
  marketData: MarketDataService;
  assetRepo: AssetRepository;
  /** Single conversion keystone (§5.4) — all EUR conversion routes through here. */
  currencyService: CurrencyService;
  /** Mixed global/custom reads serialize custom rows against privacy transitions. */
  paranoid?: Pick<ParanoidModeGuard, 'runAllowed'>;
}

/** Epoch-ms (the cache's `asOf`) → ISO-8601 for the wire. */
const asOfIso = (asOf: number): string => new Date(asOf).toISOString();

/**
 * Simultaneous upstream reads one aggregate request may have in flight.
 *
 * The provider queue (§5.2) starts ~4 calls/second, and the service timeout
 * runs *around* that queue wait, so dispatching a cold 100-id batch at once
 * both monopolises the shared politeness queue for every other caller and times
 * out its own tail. Feeding rows through a small pool keeps this request's
 * footprint in that queue bounded and keeps each call's wait inside the
 * timeout; total upstream volume is unchanged.
 */
export const MAX_INFLIGHT_ROW_READS = 6;

/** Marks a row whose own read rejected, so it can be reported, not just dropped. */
const ROW_FAILED = Symbol('rowFailed');

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
  const { marketData, assetRepo, currencyService, paranoid } = deps;

  const assetNotFound = () => notFound('Asset not found.', 'ASSET_NOT_FOUND');

  async function withVisibleAsset<T>(
    userId: string,
    id: string,
    read: (row: AssetRow) => Promise<T>,
  ): Promise<T> {
    const candidate = await assetRepo.findByIdForUser(id, userId);
    // A global asset or the caller's own custom asset, else 404 — another user's
    // custom asset is indistinguishable from missing, so nothing leaks (§10).
    if (!candidate) throw assetNotFound();
    if (candidate.ownerId === null || !paranoid) return read(candidate);

    try {
      return await paranoid.runAllowed(candidate.ownerId, 'portfolioServer', async () => {
        // Ownership/liveness is re-read after the lock is acquired. A transition
        // that won first may already have purged the row; either outcome is the
        // same indistinguishable custom-asset 404.
        const current = await assetRepo.findByIdForUser(id, userId);
        if (!current || current.ownerId !== candidate.ownerId) throw assetNotFound();
        return read(current);
      });
    } catch (error) {
      if (error instanceof ParanoidModeError) throw assetNotFound();
      throw error;
    }
  }

  /**
   * Resolve an aggregate id set with one SQL read while preserving the exact
   * access and transition-lock semantics of {@link withVisibleAsset}.
   *
   * Aggregate reads are per-row isolated. An id the caller cannot see — another
   * user's custom asset, a row a winning paranoid transition already purged, an
   * asset deleted between the list read and this one — is simply ABSENT from
   * the response instead of 404ing the whole set: one vanished asset must not
   * blank every other row of a watchlist. The singular endpoints keep their 404
   * (there the missing row *is* the answer), and absence stays indistinguishable
   * from a foreign custom asset, so nothing leaks (§10).
   */
  async function withVisibleAssets<T>(
    userId: string,
    ids: readonly string[],
    read: (rows: AssetRow[]) => Promise<T>,
  ): Promise<T> {
    const orderRows = (rows: AssetRow[]): AssetRow[] => {
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.flatMap((id) => {
        const row = byId.get(id);
        return row ? [row] : [];
      });
    };

    const candidates = orderRows(await assetRepo.findByIdsForUser(ids, userId));
    const customOwnerId = candidates.find((row) => row.ownerId !== null)?.ownerId ?? null;
    if (customOwnerId === null || !paranoid) return read(candidates);

    try {
      return await paranoid.runAllowed(customOwnerId, 'portfolioServer', async () => {
        // Re-read after acquiring the transition lock, just like the singular
        // path: a winning transition may have purged an owned custom row.
        const current = orderRows(await assetRepo.findByIdsForUser(ids, userId));
        return read(current);
      });
    } catch (error) {
      if (error instanceof ParanoidModeError) throw assetNotFound();
      throw error;
    }
  }

  async function quoteForRow(row: AssetRow): Promise<QuoteResponse> {
    try {
      const cached = await marketData.getQuote({
        providerId: row.providerId,
        providerRef: row.providerRef,
      });
      return { quote: cached.value, stale: cached.stale, asOf: asOfIso(cached.asOf) };
    } catch {
      throw badGateway();
    }
  }

  /**
   * Per-row isolation for the aggregate market reads. `Promise.all` rejects the
   * whole batch on the first failure, so a single unpriceable asset — a custom
   * asset whose value points were all deleted, a delisted ticker parked on a
   * negative cache entry for the whole negative TTL — would take down price,
   * day ±% and every sparkline for all N rows at once.
   *
   * A failed row is dropped from the payload but its id is REPORTED: silently
   * shortening the array makes a provider failure indistinguishable from an
   * asset that simply has no data, so the query resolves as a success and the
   * gap never re-runs (the sparkline read has a 15-minute stale window and no
   * poll — it would sit blank for that long with nothing to press).
   *
   * Input order is preserved, and reads run through a small pool
   * ({@link MAX_INFLIGHT_ROW_READS}) rather than all at once.
   */
  async function perRow<T>(
    rows: readonly AssetRow[],
    read: (row: AssetRow) => Promise<T>,
  ): Promise<{ values: T[]; failed: string[] }> {
    const outcomes = new Array<T | typeof ROW_FAILED>(rows.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      // `next++` is claimed synchronously, so two workers never take one row.
      for (let index = next++; index < rows.length; index = next++) {
        try {
          outcomes[index] = await read(rows[index]!);
        } catch {
          outcomes[index] = ROW_FAILED;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_INFLIGHT_ROW_READS, rows.length) }, () => worker()),
    );

    const values: T[] = [];
    const failed: string[] = [];
    outcomes.forEach((outcome, index) => {
      if (outcome === ROW_FAILED) failed.push(rows[index]!.id);
      else values.push(outcome);
    });
    return { values, failed };
  }

  async function historyForRow(
    row: AssetRow,
    range: HistoryRange,
    interval: HistoryInterval = defaultIntervalForRange(range),
  ): Promise<HistoryResponse> {
    try {
      const cached = await marketData.getHistory(
        { providerId: row.providerId, providerRef: row.providerRef },
        range,
        interval,
      );
      return {
        range,
        interval,
        currency: row.currency,
        points: cached.value,
        stale: cached.stale,
        asOf: asOfIso(cached.asOf),
      };
    } catch {
      throw badGateway();
    }
  }

  return {
    async getDetail(userId, id, opts) {
      return withVisibleAsset(userId, id, async (row) => {
        const asset = toSummary(row);
        const fx =
          opts?.baseCurrency === undefined
            ? currencyService
            : currencyService.withBase(opts.baseCurrency);
        try {
          const cached = await marketData.getQuote({
            providerId: row.providerId,
            providerRef: row.providerRef,
          });

          // Base-currency conversion for foreign assets (§6.3, §5.4, V3-P10d —
          // the caller's per-user base; the `eurPrice` field name predates it).
          // All conversion routes through the currency keystone — no inline FX
          // math here. Best-effort: null when the spot rate is unavailable,
          // absent when the native currency already is the base.
          let eurPriceEntry: { eurPrice: number | null } | undefined;
          if (asset.currency !== fx.baseCurrency) {
            try {
              eurPriceEntry = {
                eurPrice: await fx.toBase(cached.value.price, asset.currency),
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
            baseCurrency: fx.baseCurrency,
            ...eurPriceEntry,
          };
        } catch {
          // Meta always resolves from the stored row; the quote is best-effort, so
          // a provider outage with no cached copy degrades to a null quote rather
          // than failing the whole page (§6.3).
          return { asset, quote: null, stale: true, asOf: null, baseCurrency: fx.baseCurrency };
        }
      });
    },

    async getQuote(userId, id) {
      return withVisibleAsset(userId, id, quoteForRow);
    },

    async getQuotes(userId, ids) {
      return withVisibleAssets(userId, ids, async (rows) => {
        const { values, failed } = await perRow(
          rows,
          async (row): Promise<AssetBatchQuote> => ({
            assetId: row.id,
            ...(await quoteForRow(row)),
          }),
        );
        return { quotes: values, failed };
      });
    },

    async getSparklines(userId, ids) {
      return withVisibleAssets(userId, ids, async (rows) => {
        const { values, failed } = await perRow(rows, async (row) => {
          // Explicit daily granularity avoids the 1M endpoint's dense 30m
          // candles; the final slice keeps every provider inside the contract's
          // own payload bound, which is why it comes from contracts.
          const history = await historyForRow(row, '1M', '1d');
          return {
            assetId: row.id,
            points: history.points.slice(-ASSET_SPARKLINE_MAX_POINTS),
            stale: history.stale,
            asOf: history.asOf,
          };
        });
        return { sparklines: values, failed };
      });
    },

    async getHistory(userId, id, range) {
      return withVisibleAsset(userId, id, (row) => historyForRow(row, range));
    },

    async getDailyCloses(userId, id) {
      return withVisibleAsset(userId, id, async (row) => {
        try {
          // Force the daily interval over the full window (like the backtest
          // loader §6.6) so the client always gets calendar-day granularity — the
          // §5.3 range→interval table would otherwise return weekly/monthly candles
          // for the multi-year windows this form needs.
          const cached = await marketData.getHistory(
            { providerId: row.providerId, providerRef: row.providerRef },
            'MAX',
            '1d',
          );
          return { points: cached.value, stale: cached.stale, asOf: asOfIso(cached.asOf) };
        } catch {
          // Best-effort: the transaction form degrades to fully-manual entry rather
          // than erroring when no series is cached and the provider is down (#226).
          return { points: [], stale: true, asOf: null };
        }
      });
    },
  };
}
