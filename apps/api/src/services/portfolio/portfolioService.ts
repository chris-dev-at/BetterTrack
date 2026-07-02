import type {
  Holding as HoldingDto,
  HistoryRange,
  PortfolioHistoryRange,
  PortfolioResponse,
  PortfolioTotals,
  PricePoint as ProviderPricePoint,
  TransactionInput,
  TransactionListResponse,
  Transaction as TransactionDto,
  UpdateTransactionRequest,
} from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import type { AssetRow } from '../../data/schema';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type {
  TransactionRecord,
  TransactionRepository,
} from '../../data/repositories/transactionRepository';
import {
  deriveHoldings,
  OversellError,
  reducePosition,
  valueOverTime,
  type Holding,
  type HoldingAssetInput,
  type PricePoint,
  type Transaction as DomainTransaction,
  type ValueOverTimeAsset,
} from '../../domain/holdings';
import { badRequest, notFound } from '../../errors';
import { rangeStartMs, type MarketDataService } from '../../providers';
import type { ReferenceBackfill } from '../assets/referenceBackfill';
import type { CurrencyService } from '../currency/currencyService';

/**
 * Portfolio service (PROJECTPLAN.md §6.9). Owns the write-side validation and
 * the read-side derivations that turn the transaction ledger — the single
 * source of truth — into holdings, totals and the value-over-time series.
 *
 * The money-critical invariants all live here on the way in and out of the
 * pure `domain/holdings` core:
 *
 *  - **Negative-sell rejection** is enforced server-side by replaying the
 *    asset's full transaction set (existing + the pending change) through
 *    {@link reducePosition}; a sell that pushes the held quantity negative at any
 *    point in time throws {@link OversellError}, mapped to a 400 ("you only hold
 *    3.5 shares"). Validating against the whole timeline — not just the current
 *    holding — means a back-dated transaction is judged correctly.
 *  - **EUR conversion** routes exclusively through the {@link CurrencyService}
 *    keystone (§5.4); no FX math is done here.
 *  - **The value series is cached 1 h** and invalidated on every write (any
 *    transaction or value-point change), per §6.9.
 */

export interface PortfolioServiceDeps {
  portfolioRepo: PortfolioRepository;
  transactionRepo: TransactionRepository;
  marketData: MarketDataService;
  currencyService: CurrencyService;
  referenceBackfill: ReferenceBackfill;
  redis: Redis;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
}

export interface PortfolioService {
  listTransactions(
    userId: string,
    params: { cursor?: string; limit?: number },
  ): Promise<TransactionListResponse>;
  createTransactions(userId: string, inputs: TransactionInput[]): Promise<TransactionDto[]>;
  updateTransaction(
    userId: string,
    id: string,
    patch: UpdateTransactionRequest,
  ): Promise<TransactionDto>;
  deleteTransaction(userId: string, id: string): Promise<void>;
  getPortfolio(userId: string): Promise<PortfolioResponse>;
  getHistory(
    userId: string,
    range: PortfolioHistoryRange,
  ): Promise<{
    range: PortfolioHistoryRange;
    baseCurrency: string;
    points: Array<{ date: string; valueEur: number }>;
  }>;
  /** Drop the cached value series for a user's portfolio (called on any write). */
  invalidateHistory(userId: string): Promise<void>;
}

const DEFAULT_LIMIT = 50;
const HISTORY_TTL_SECONDS = 3600; // 1 h (§6.9).

/** Redis key for the cached, full value-over-time series of a portfolio. */
export function portfolioHistoryCacheKey(portfolioId: string): string {
  return `portfolio:history:${portfolioId}`;
}

/** Months of history each non-MAX range covers (§6.9: 1M / 6M / 1Y / Max). */
const RANGE_MONTHS: Record<Exclude<PortfolioHistoryRange, 'MAX'>, number> = {
  '1M': 1,
  '6M': 6,
  '1Y': 12,
};

export function createPortfolioService(deps: PortfolioServiceDeps): PortfolioService {
  const { portfolioRepo, transactionRepo, marketData, currencyService, referenceBackfill, redis } =
    deps;
  const now = deps.now ?? Date.now;
  const baseCurrency = currencyService.baseCurrency;

  /** Today's UTC calendar day, the last point of the value series. */
  function todayIso(): string {
    return new Date(now()).toISOString().slice(0, 10);
  }

  /** Map a stored record / input into the pure-domain transaction shape. */
  function recordToDomain(r: TransactionRecord): DomainTransaction {
    return {
      assetId: r.assetId,
      side: r.side,
      quantity: r.quantity,
      price: r.price,
      fee: r.fee,
      executedAt: r.executedAt.toISOString(),
    };
  }

  function inputToDomain(i: TransactionInput): DomainTransaction {
    return {
      assetId: i.assetId,
      side: i.side,
      quantity: i.quantity,
      price: i.price,
      fee: i.fee,
      executedAt: i.executedAt,
    };
  }

  function assetToDto(row: AssetRow): TransactionDto['asset'] {
    return {
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      exchange: row.exchange ?? null,
      currency: row.currency,
      type: row.type,
      isCustom: row.ownerId !== null,
    };
  }

  function recordToDto(r: TransactionRecord, asset: AssetRow): TransactionDto {
    return {
      id: r.id,
      assetId: r.assetId,
      side: r.side,
      quantity: r.quantity,
      price: r.price,
      fee: r.fee,
      executedAt: r.executedAt.toISOString(),
      note: r.note,
      asset: assetToDto(asset),
    };
  }

  /** Resolve + index the asset rows for a set of ids, asserting each is visible. */
  async function loadVisibleAssets(userId: string, ids: string[]): Promise<Map<string, AssetRow>> {
    const rows = await portfolioRepo.assetsByIds(ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = byId.get(id);
      // A global market asset, or the caller's own custom asset. Anything else
      // (missing, or another user's custom asset) is a 404 — nothing leaks (§10).
      if (!row || (row.ownerId !== null && row.ownerId !== userId)) {
        throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
      }
    }
    return byId;
  }

  /** Replay a single asset's full transaction set, mapping oversell to a 400. */
  function assertNoOversell(domainTxns: DomainTransaction[]): void {
    try {
      reducePosition(domainTxns);
    } catch (err) {
      if (err instanceof OversellError) {
        throw badRequest(`You only hold ${err.held} shares.`, 'OVERSELL', {
          held: err.held,
          requested: err.requested,
          assetId: err.assetId,
        });
      }
      throw err;
    }
  }

  async function invalidateHistory(userId: string): Promise<void> {
    const portfolioId = await portfolioRepo.findMain(userId);
    if (portfolioId) await redis.del(portfolioHistoryCacheKey(portfolioId));
  }

  /**
   * The full value-over-time series for a portfolio (first transaction → today),
   * cached 1 h. Recomputed on a cache miss and re-stored; the range slice is
   * applied by the caller. Invalidated wholesale on any write (§6.9).
   *
   * Per-asset daily prices come from the provider layer (`marketData.getHistory`
   * at `1d`, §5.2/§5.3), merged over the stored `price_history` rows which act
   * as the outage fallback — see {@link mergeDailyPrices}.
   */
  async function loadSeries(
    portfolioId: string,
  ): Promise<Array<{ date: string; valueEur: number }>> {
    const key = portfolioHistoryCacheKey(portfolioId);
    const cached = await redis.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as Array<{ date: string; valueEur: number }>;
      } catch {
        // Corrupt cache entry — fall through and recompute.
      }
    }

    const txns = await transactionRepo.listForPortfolio(portfolioId);
    if (txns.length === 0) {
      await redis.set(key, JSON.stringify([]), 'EX', HISTORY_TTL_SECONDS);
      return [];
    }

    const assetIds = [...new Set(txns.map((t) => t.assetId))];
    const assetsById = new Map((await portfolioRepo.assetsByIds(assetIds)).map((r) => [r.id, r]));

    // The value series converts each day's native sum to EUR via *historical* FX,
    // which is not yet available for non-base currencies (§5.4 future work). Rather
    // than 500 on a non-EUR holding (e.g. a USD custom asset or market stock), we
    // degrade exactly like getPortfolio drops an unconvertible quote: probe each
    // distinct non-base currency once and exclude assets we can't convert from the
    // series. When historical FX lands this path starts including them automatically.
    const today = todayIso();
    const convertible = new Map<string, boolean>();
    for (const asset of assetsById.values()) {
      const ccy = asset.currency;
      if (ccy === baseCurrency || convertible.has(ccy)) continue;
      try {
        await currencyService.toBase(1, ccy, { date: today });
        convertible.set(ccy, true);
      } catch {
        convertible.set(ccy, false);
      }
    }
    const isConvertible = (ccy: string): boolean =>
      ccy === baseCurrency || convertible.get(ccy) === true;

    const usableAssetIds = assetIds.filter((id) => {
      const asset = assetsById.get(id);
      return asset !== undefined && isConvertible(asset.currency);
    });

    // No EUR-convertible holding has any history to plot — degrade to an empty
    // series instead of throwing mid-conversion.
    if (usableAssetIds.length === 0) {
      await redis.set(key, JSON.stringify([]), 'EX', HISTORY_TTL_SECONDS);
      return [];
    }

    const usableIdSet = new Set(usableAssetIds);

    // Stored daily closes / custom value points (`price_history`): the durable
    // fallback layer of the series.
    const priceRows = await portfolioRepo.pricesForAssets(usableAssetIds);
    const storedByAsset = new Map<string, PricePoint[]>();
    for (const row of priceRows) {
      const list = storedByAsset.get(row.assetId);
      const point: PricePoint = { date: row.date, close: row.close };
      if (list) list.push(point);
      else storedByAsset.set(row.assetId, [point]);
    }

    // The primary layer is each asset's real daily history through the
    // market-data keystone (§5.2/§5.3) — cached, coalesced, serve-stale — so
    // the curve moves with the market day by day instead of only at
    // transaction or value-point events. Custom assets route through the
    // manual provider via the exact same call: zero special-casing (§5.2).
    // Best-effort per asset: an outage past the stale window degrades that
    // asset to its stored rows above — the chart renders what is available.
    const firstTxnDay = txns
      .map((t) => t.executedAt.toISOString().slice(0, 10))
      .reduce((a, b) => (a < b ? a : b));
    const range = seriesHistoryRange(firstTxnDay, today);
    const providerPrices = await Promise.all(
      usableAssetIds.map(async (assetId): Promise<readonly ProviderPricePoint[]> => {
        const asset = assetsById.get(assetId);
        if (!asset) return [];
        try {
          const cached = await marketData.getHistory(
            { providerId: asset.providerId, providerRef: asset.providerRef },
            range,
            '1d',
          );
          return cached.value;
        } catch {
          return [];
        }
      }),
    );

    const valueAssets: ValueOverTimeAsset[] = usableAssetIds.map((assetId, i) => {
      const asset = assetsById.get(assetId);
      if (!asset) throw new Error(`Asset ${assetId} missing while building value series`);
      return {
        assetId,
        currency: asset.currency,
        prices: mergeDailyPrices(storedByAsset.get(assetId) ?? [], providerPrices[i] ?? []),
      };
    });

    const series = await valueOverTime({
      transactions: txns.filter((t) => usableIdSet.has(t.assetId)).map(recordToDomain),
      assets: valueAssets,
      today,
      converter: currencyService,
    });

    await redis.set(key, JSON.stringify(series), 'EX', HISTORY_TTL_SECONDS);
    return series;
  }

  return {
    async listTransactions(userId, params) {
      const limit = params.limit ?? DEFAULT_LIMIT;
      const { items, nextCursor } = await transactionRepo.listByUser(userId, {
        limit,
        cursor: params.cursor,
      });
      return {
        items: items.map((row) => ({
          id: row.id,
          assetId: row.assetId,
          side: row.side,
          quantity: row.quantity,
          price: row.price,
          fee: row.fee,
          executedAt: row.executedAt.toISOString(),
          note: row.note,
          asset: {
            id: row.asset.id,
            symbol: row.asset.symbol,
            name: row.asset.name,
            exchange: row.asset.exchange,
            currency: row.asset.currency,
            type: row.asset.type,
            isCustom: row.asset.isCustom,
          },
        })),
        nextCursor,
      };
    },

    async createTransactions(userId, inputs) {
      if (inputs.length === 0) throw badRequest('No transactions to create.', 'EMPTY_BATCH');

      const assetIds = [...new Set(inputs.map((i) => i.assetId))];
      const assetsById = await loadVisibleAssets(userId, assetIds);
      const portfolioId = await portfolioRepo.getOrCreateMain(userId);

      // Validate per asset against the *whole* timeline (existing + pending), so
      // back-dated sells and intra-batch interleaving are judged correctly.
      for (const assetId of assetIds) {
        const existing = await transactionRepo.listForAsset(portfolioId, assetId);
        const pending = inputs.filter((i) => i.assetId === assetId).map(inputToDomain);
        assertNoOversell([...existing.map(recordToDomain), ...pending]);
      }

      const inserted = await transactionRepo.insertMany(
        portfolioId,
        inputs.map((i) => ({
          assetId: i.assetId,
          side: i.side,
          quantity: i.quantity,
          price: i.price,
          fee: i.fee,
          executedAt: new Date(i.executedAt),
          note: i.note ?? null,
        })),
      );

      await invalidateHistory(userId);

      // First reference (§6.2/§9): transacting on an asset warms its daily
      // history so the value-over-time series has closes to plot — seeded and
      // enrichment-upserted catalog rows get their backfill here. Best-effort.
      for (const assetId of assetIds) {
        await referenceBackfill.ensureHistory(assetId);
      }

      return inserted.map((r) => {
        const asset = assetsById.get(r.assetId);
        if (!asset) throw new Error(`Asset ${r.assetId} missing after insert`);
        return recordToDto(r, asset);
      });
    },

    async updateTransaction(userId, id, patch) {
      const existing = await transactionRepo.findByIdForUser(userId, id);
      if (!existing) throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');

      // Build the asset's set with the edited row swapped in, then re-validate.
      const siblings = await transactionRepo.listForAsset(existing.portfolioId, existing.assetId);
      const merged: TransactionRecord = {
        ...existing,
        side: patch.side ?? existing.side,
        quantity: patch.quantity ?? existing.quantity,
        price: patch.price ?? existing.price,
        fee: patch.fee ?? existing.fee,
        executedAt: patch.executedAt ? new Date(patch.executedAt) : existing.executedAt,
        note: patch.note === undefined ? existing.note : (patch.note ?? null),
      };
      const replayed = siblings.map((s) => (s.id === id ? merged : s)).map(recordToDomain);
      assertNoOversell(replayed);

      const updated = await transactionRepo.update(userId, id, {
        side: patch.side,
        quantity: patch.quantity,
        price: patch.price,
        fee: patch.fee,
        executedAt: patch.executedAt ? new Date(patch.executedAt) : undefined,
        note: patch.note === undefined ? undefined : (patch.note ?? null),
      });
      if (!updated) throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');

      await invalidateHistory(userId);

      const [asset] = await portfolioRepo.assetsByIds([updated.assetId]);
      if (!asset) throw new Error(`Asset ${updated.assetId} missing after update`);
      return recordToDto(updated, asset);
    },

    async deleteTransaction(userId, id) {
      const existing = await transactionRepo.findByIdForUser(userId, id);
      if (!existing) throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');

      // Removing a BUY can leave a later SELL over-selling; replay without it.
      const siblings = await transactionRepo.listForAsset(existing.portfolioId, existing.assetId);
      const replayed = siblings.filter((s) => s.id !== id).map(recordToDomain);
      assertNoOversell(replayed);

      const deleted = await transactionRepo.deleteForUser(userId, id);
      if (!deleted) throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');

      await invalidateHistory(userId);
    },

    async getPortfolio(userId) {
      const empty: PortfolioResponse = {
        baseCurrency,
        holdings: [],
        totals: emptyTotals(),
      };
      const portfolioId = await portfolioRepo.findMain(userId);
      if (!portfolioId) return empty;

      const txns = await transactionRepo.listForPortfolio(portfolioId);
      if (txns.length === 0) return empty;

      const assetIds = [...new Set(txns.map((t) => t.assetId))];
      const assetsById = new Map((await portfolioRepo.assetsByIds(assetIds)).map((r) => [r.id, r]));

      // One quote per asset (coalesced), best-effort: a degraded provider yields
      // a null quote rather than failing the page (§6.3). For non-EUR assets we
      // also probe the spot FX rate; if it is unavailable, drop the quote so the
      // pure derivation never throws mid-conversion.
      const assetInputs: HoldingAssetInput[] = [];
      for (const assetId of assetIds) {
        const asset = assetsById.get(assetId);
        if (!asset) continue;
        let quote: HoldingAssetInput['quote'] = null;
        try {
          const cached = await marketData.getQuote({
            providerId: asset.providerId,
            providerRef: asset.providerRef,
          });
          quote = { price: cached.value.price, prevClose: cached.value.prevClose ?? null };
          if (asset.currency !== baseCurrency) {
            // Throws if no spot rate is available → degrade to no quote.
            await currencyService.getRate(asset.currency, baseCurrency);
          }
        } catch {
          quote = null;
        }
        assetInputs.push({ assetId, currency: asset.currency, quote });
      }

      const domainTxns = txns.map(recordToDomain);
      const holdings = await deriveHoldings(domainTxns, assetInputs, currencyService);

      const holdingDtos: HoldingDto[] = holdings.map((h) => {
        const asset = assetsById.get(h.assetId);
        if (!asset) throw new Error(`Asset ${h.assetId} missing while building holdings`);
        return {
          asset: assetToDto(asset),
          quantity: h.quantity,
          avgCost: h.avgCost,
          realizedPnl: h.realizedPnl,
          price: h.price,
          marketValueEur: h.marketValueEur,
          costBasisEur: h.costBasisEur,
          unrealizedPnlEur: h.unrealizedPnlEur,
          unrealizedPnlPct: h.unrealizedPnlPct,
          dayChangeEur: h.dayChangeEur,
          dayChangePct: h.dayChangePct,
        };
      });

      return { baseCurrency, holdings: holdingDtos, totals: computeTotals(holdings) };
    },

    async getHistory(userId, range) {
      const portfolioId = await portfolioRepo.findMain(userId);
      if (!portfolioId) return { range, baseCurrency, points: [] };

      const series = await loadSeries(portfolioId);
      const points = sliceRange(series, range, todayIso());
      return { range, baseCurrency, points };
    },

    invalidateHistory,
  };
}

// ---------------------------------------------------------------------------
// Totals + range helpers
// ---------------------------------------------------------------------------

function emptyTotals(): PortfolioTotals {
  return {
    marketValueEur: 0,
    investedEur: 0,
    unrealizedPnlEur: 0,
    unrealizedPnlPct: null,
    dayChangeEur: 0,
    dayChangePct: null,
  };
}

/** Aggregate the holdings into the totals header (§6.9). */
function computeTotals(holdings: readonly Holding[]): PortfolioTotals {
  let marketValueEur = 0;
  let investedEur = 0;
  let dayChangeEur = 0;
  let dayPrevValueEur = 0; // Σ (marketValue − dayChange) over assets with a known day move.

  for (const h of holdings) {
    if (h.marketValueEur !== null) marketValueEur += h.marketValueEur;
    if (h.costBasisEur !== null) investedEur += h.costBasisEur;
    if (h.dayChangeEur !== null && h.marketValueEur !== null) {
      dayChangeEur += h.dayChangeEur;
      dayPrevValueEur += h.marketValueEur - h.dayChangeEur;
    }
  }

  const unrealizedPnlEur = marketValueEur - investedEur;
  return {
    marketValueEur,
    investedEur,
    unrealizedPnlEur,
    unrealizedPnlPct: investedEur > 0 ? (unrealizedPnlEur / investedEur) * 100 : null,
    dayChangeEur,
    dayChangePct: dayPrevValueEur > 0 ? (dayChangeEur / dayPrevValueEur) * 100 : null,
  };
}

/** Calendar day `months` before `today` (ISO `YYYY-MM-DD`), UTC. */
function monthsBefore(today: string, months: number): string {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/**
 * Left-edge margin when picking the provider history window: the series starts
 * at the first transaction day, which may be a weekend/market holiday, so the
 * window must reach back far enough that a prior close exists to carry forward.
 */
const SERIES_EDGE_MARGIN_DAYS = 7;

const SERIES_RANGE_LADDER: ReadonlyArray<Exclude<HistoryRange, '1D' | '1W' | 'MAX'>> = [
  '1M',
  '6M',
  '1Y',
  '5Y',
];

/**
 * Smallest §5.3 range preset whose lookback (per {@link rangeStartMs}) covers
 * the first transaction day plus {@link SERIES_EDGE_MARGIN_DAYS}. The interval
 * is always `1d` — the value series is daily regardless of span.
 */
function seriesHistoryRange(firstTxnDay: string, today: string): HistoryRange {
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  const neededMs =
    Date.parse(`${firstTxnDay}T00:00:00.000Z`) - SERIES_EDGE_MARGIN_DAYS * 86_400_000;
  for (const range of SERIES_RANGE_LADDER) {
    if (rangeStartMs(todayMs, range) <= neededMs) return range;
  }
  return 'MAX';
}

/**
 * Combine an asset's stored `price_history` rows with its provider history into
 * one daily series for {@link valueOverTime}. Provider candles collapse to one
 * close per calendar day (chronological order upstream, so the last candle of a
 * day wins) and take precedence over a stored row on the same date — they are
 * adjusted and fresher; stored rows fill dates the provider window missed and
 * carry the whole asset when the provider call failed.
 */
function mergeDailyPrices(
  stored: readonly PricePoint[],
  provider: readonly ProviderPricePoint[],
): PricePoint[] {
  const byDate = new Map<string, number>();
  for (const p of stored) byDate.set(p.date, p.close);
  for (const p of provider) {
    if (!Number.isFinite(p.close)) continue;
    byDate.set(p.time.slice(0, 10), p.close);
  }
  return [...byDate].map(([date, close]) => ({ date, close }));
}

/** Slice the full series to a range window; MAX returns it whole (§6.9). */
function sliceRange(
  series: ReadonlyArray<{ date: string; valueEur: number }>,
  range: PortfolioHistoryRange,
  today: string,
): Array<{ date: string; valueEur: number }> {
  if (range === 'MAX') return [...series];
  const cutoff = monthsBefore(today, RANGE_MONTHS[range]);
  return series.filter((p) => p.date >= cutoff);
}
