import type { HistoryRange, VaultDocumentV1 } from '@bettertrack/contracts';
import {
  cashBalancesBySource,
  externalCashFlowsForTwr,
  floorCents,
  netWorthSeries,
  projectCashLedgerBySource,
} from '@bettertrack/domain/cashLedger';
import {
  QTY_EPSILON,
  costBasisOverTime,
  deriveHoldings,
  netFlowsOverTime,
  rebasePerformance,
  reducePosition,
  timeWeightedReturn,
  valueOverTime,
  type CurrencyConverter,
  type HoldingAssetInput,
  type PricePoint as DomainPricePoint,
  type ValueOverTimeAsset,
} from '@bettertrack/domain/holdings';
import { computeSeriesStats } from '@bettertrack/domain/seriesStats';

import {
  MarketDataSourceError,
  type MarketDataSource,
  type MarketFxValue,
} from '../../../lib/marketDataSource';
import type { VaultSyncEngine } from '../sync';
import { VaultDerivedCache } from './cache';
import {
  asMoneyFailure,
  moneyFailure,
  VaultMoneyEngineError,
  type VaultMoneyOutcome,
} from './errors';
import {
  readPortfolioModel,
  storedPrices,
  type ClientAssetRecord,
  type ClientPortfolioModel,
} from './model';
import { localManualAssetMarket } from './manualAsset';
import {
  assertVaultSnapshotCurrent,
  validatedVaultSnapshot,
  type ValidatedVaultSnapshot,
} from './session';
import type { ClientPortfolioDerivation, ClientPortfolioRange, VaultMoneyEngine } from './types';

interface LoadedAssetMarket {
  asset: ClientAssetRecord;
  prices: DomainPricePoint[];
  quote: HoldingAssetInput['quote'];
  historyStale: boolean;
  quoteStale: boolean;
  historyMissing: boolean;
  quoteMissing: boolean;
  watermark: string;
}

interface PortfolioEngineOptions {
  now?: () => number;
  cache?: VaultDerivedCache<ClientPortfolioDerivation>;
}

interface FxInputLoader {
  converter: CurrencyConverter;
  values(): ReadonlyMap<string, MarketFxValue>;
}

export interface PortfolioDerivationEngine {
  derivePortfolio(
    portfolioId: string,
    range: ClientPortfolioRange,
    signal?: AbortSignal,
  ): Promise<VaultMoneyOutcome<ClientPortfolioDerivation>>;
  clearCache(): void;
}

export function createPortfolioDerivationEngine(
  sync: VaultSyncEngine,
  market: MarketDataSource,
  options: PortfolioEngineOptions = {},
): PortfolioDerivationEngine {
  const now = options.now ?? Date.now;
  const cache = options.cache ?? new VaultDerivedCache<ClientPortfolioDerivation>();

  return {
    async derivePortfolio(portfolioId, range, signal) {
      try {
        signal?.throwIfAborted();
        const snapshot = validatedVaultSnapshot(sync);
        const model = readPortfolioModel(snapshot.document, portfolioId);
        const today = new Date(now()).toISOString().slice(0, 10);
        const loaded = await loadMarketInputs(snapshot.document, model, today, market, signal);
        signal?.throwIfAborted();
        const fx = createFxInputLoader(market, signal);
        const value = await derive(snapshot, model, loaded, fx, range, today);
        const key = {
          ownerUserId: snapshot.ownerUserId,
          vaultKeyId: snapshot.vaultKeyId,
          portfolioId,
          vaultVersion: snapshot.vaultVersion,
          writeId: snapshot.writeId,
          assetPriceWatermark: value.assetPriceWatermark,
          range,
          effectiveDay: today,
        };
        const cached = cache.get(key);
        if (cached !== undefined) {
          assertVaultSnapshotCurrent(sync, snapshot);
          return { ok: true, value: cached };
        }

        assertVaultSnapshotCurrent(sync, snapshot);
        cache.set(key, value);
        return { ok: true, value };
      } catch (cause) {
        return { ok: false, error: marketOrMoneyFailure(cause) };
      }
    },

    clearCache() {
      cache.clear();
    },
  };
}

async function derive(
  snapshot: ValidatedVaultSnapshot,
  model: ClientPortfolioModel,
  loaded: LoadedAssetMarket[],
  fx: FxInputLoader,
  range: ClientPortfolioRange,
  today: string,
): Promise<ClientPortfolioDerivation> {
  const converter = fx.converter;

  const domainTransactions = model.transactions;
  const holdingAssets: HoldingAssetInput[] = loaded.map((entry) => ({
    assetId: entry.asset.id,
    currency: entry.asset.currency,
    quote: entry.quote,
  }));
  const valueAssets: ValueOverTimeAsset[] = loaded.map((entry) => ({
    assetId: entry.asset.id,
    currency: entry.asset.currency,
    prices: entry.prices,
  }));

  const holdings = await deriveHoldings(domainTransactions, holdingAssets, converter);
  const sourcedMovements = model.cashMovements;
  projectCashLedgerBySource(sourcedMovements);
  const rawBalances = cashBalancesBySource(sourcedMovements);
  const cashSources = model.cashSources
    .map((source) => ({
      sourceId: source.id,
      name: source.name,
      balanceEur: floorCents(rawBalances.get(source.id) ?? 0),
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.sourceId.localeCompare(right.sourceId),
    );
  const cashBalanceEur = floorCents(
    [...rawBalances.values()].reduce((total, balance) => total + balance, 0),
  );

  const holdingsValueEur = holdings.some(
    (holding) => holding.quantity > QTY_EPSILON && holding.marketValueEur === null,
  )
    ? null
    : holdings.reduce((total, holding) => total + (holding.marketValueEur ?? 0), 0);
  const totalValueEur =
    holdingsValueEur === null ? null : floorCents(holdingsValueEur + cashBalanceEur);
  const allocation =
    holdingsValueEur === null
      ? null
      : holdingsValueEur <= 0
        ? []
        : holdings
            .filter(
              (holding): holding is typeof holding & { marketValueEur: number } =>
                holding.marketValueEur !== null && holding.marketValueEur > 0,
            )
            .map((holding) => ({
              assetId: holding.assetId,
              valueEur: holding.marketValueEur,
              pct: (holding.marketValueEur / holdingsValueEur) * 100,
            }));

  const holdingsValues =
    domainTransactions.length === 0
      ? []
      : await valueOverTime({
          transactions: domainTransactions,
          assets: valueAssets,
          today,
          converter,
        });
  const costs =
    domainTransactions.length === 0
      ? []
      : await costBasisOverTime({
          transactions: domainTransactions,
          assets: valueAssets,
          today,
          converter,
        });

  const linkedTransactionIds = new Set(
    model.cashMovements
      .map((movement) => movement.transactionId)
      .filter((id): id is string => id !== null),
  );
  const externalTransactionFlows =
    domainTransactions.length === 0
      ? []
      : await netFlowsOverTime({
          transactions: domainTransactions.filter(
            (transaction) => !linkedTransactionIds.has(transaction.id),
          ),
          currencyByAsset: new Map(loaded.map((entry) => [entry.asset.id, entry.asset.currency])),
          converter,
        });
  const allFlows = [
    ...externalTransactionFlows,
    ...splitCashBuyFlows(model),
    ...externalCashFlowsForTwr(sourcedMovements),
  ];
  const netWorth = netWorthSeries({
    holdingsValues,
    movements: sourcedMovements,
    today,
  });
  const fullTwr = timeWeightedReturn(netWorth, allFlows);
  const start = rangeStart(today, range);
  const slicedValues = netWorth.filter((point) => point.date >= start);
  const rangedTwr = fullTwr.filter((point) => point.date >= start);
  const slicedTwr = range === 'MAX' ? rangedTwr : rebasePerformance(rangedTwr);
  const twrByDate = new Map(slicedTwr.map((point) => [point.date, point.pct]));
  const holdingsByDate = new Map(holdingsValues.map((point) => [point.date, point.valueEur]));
  const costByDate = new Map(costs.map((point) => [point.date, point.costBasisEur]));
  const missingByDate = missingPricesByDay(
    model,
    loaded,
    slicedValues.map((point) => point.date),
    today,
  );
  const hasAnyMissing = [...missingByDate.values()].some((ids) => ids.length > 0);
  const fxInputs = fx.values();
  const fxStale = [...fxInputs.values()].some((result) => result.stale);
  const stale = fxStale || loaded.some((entry) => entry.historyStale || entry.quoteStale);
  const assetPriceWatermark = marketWatermark(loaded, fxInputs);

  const series = slicedValues.map((point) => {
    const missingAssetIds = missingByDate.get(point.date) ?? [];
    const complete = missingAssetIds.length === 0;
    const holdingValue = holdingsByDate.get(point.date) ?? 0;
    const costBasis = costByDate.get(point.date) ?? 0;
    return {
      date: point.date,
      valueEur: complete ? point.valueEur : null,
      costBasisEur: complete ? costBasis : null,
      pnlEur: complete ? holdingValue - costBasis : null,
      twrPct: complete && !hasAnyMissing ? (twrByDate.get(point.date) ?? 0) : null,
      missingAssetIds,
      freshness: stale ? ('stale' as const) : ('fresh' as const),
      isLiveToday: point.date === today,
    };
  });
  const stats =
    hasAnyMissing || slicedTwr.length === 0
      ? null
      : computeSeriesStats(
          slicedValues.map((point) => ({ date: point.date, value: point.valueEur })),
        );
  const currentMissing = new Set<string>();
  for (const holding of holdings) {
    if (holding.quantity > QTY_EPSILON && holding.marketValueEur === null) {
      currentMissing.add(holding.assetId);
    }
  }
  for (const id of missingByDate.get(today) ?? []) currentMissing.add(id);

  return {
    ownerUserId: snapshot.ownerUserId,
    vaultKeyId: snapshot.vaultKeyId,
    portfolioId: model.portfolioId,
    vaultVersion: snapshot.vaultVersion,
    writeId: snapshot.writeId,
    assetPriceWatermark,
    range,
    baseCurrency: 'EUR',
    holdings,
    holdingsValueEur,
    cashBalanceEur,
    totalValueEur,
    allocation,
    cashSources,
    series,
    stats,
    freshness: stale ? 'stale' : 'fresh',
    missingAssetIds: [...currentMissing].sort(),
  };
}

async function loadMarketInputs(
  document: VaultDocumentV1,
  model: ClientPortfolioModel,
  today: string,
  market: MarketDataSource,
  signal?: AbortSignal,
): Promise<LoadedAssetMarket[]> {
  const assetIds = [...new Set(model.transactions.map((transaction) => transaction.assetId))];
  return Promise.all(
    assetIds.map(async (assetId): Promise<LoadedAssetMarket> => {
      signal?.throwIfAborted();
      const asset = model.assets.get(assetId);
      if (asset === undefined) {
        throw moneyFailure('VAULT_INVALID_OWNERSHIP', `Asset ${assetId} is unavailable.`);
      }
      const local = storedPrices(document, assetId);
      if (asset.providerId === 'manual') {
        const manual = localManualAssetMarket(document, asset);
        return {
          asset,
          prices: manual.prices,
          quote: manual.quote,
          historyStale: false,
          quoteStale: false,
          historyMissing: manual.prices.length === 0,
          quoteMissing: manual.quote === null,
          watermark: manual.watermark,
        };
      }

      const [historyResult, quoteResult] = await Promise.all([
        market.history(assetId, 'MAX', signal).catch((cause: unknown) => {
          rethrowAbort(cause);
          rethrowInvalidMarketData(cause);
          return null;
        }),
        market.quote(assetId, signal).catch((cause: unknown) => {
          rethrowAbort(cause);
          rethrowInvalidMarketData(cause);
          return null;
        }),
      ]);
      if (historyResult !== null) {
        assertMarketWatermark(historyResult.watermark, assetId);
        for (const point of historyResult.value) {
          if (
            !Number.isFinite(Date.parse(point.time)) ||
            !Number.isFinite(point.close) ||
            point.close <= 0
          ) {
            throw moneyFailure('MARKET_DATA_INVALID', `Daily close for ${assetId} is invalid.`);
          }
        }
      }
      if (quoteResult !== null) {
        assertMarketWatermark(quoteResult.watermark, assetId);
        if (
          !Number.isFinite(quoteResult.value.price) ||
          quoteResult.value.price <= 0 ||
          (quoteResult.value.prevClose != null &&
            (!Number.isFinite(quoteResult.value.prevClose) || quoteResult.value.prevClose <= 0))
        ) {
          throw moneyFailure('MARKET_DATA_INVALID', `Quote for ${assetId} is invalid.`);
        }
      }
      if (
        quoteResult !== null &&
        quoteResult.value.currency.toUpperCase() !== asset.currency.toUpperCase()
      ) {
        throw moneyFailure(
          'MARKET_DATA_INVALID',
          `Quote currency for ${assetId} does not match its vault asset currency.`,
        );
      }
      const byDate = new Map(local.map((point) => [point.date, point.close]));
      for (const point of historyResult?.value ?? []) {
        const day = point.time.slice(0, 10);
        if (day < today) byDate.set(day, point.close);
      }
      if (quoteResult !== null) byDate.set(today, quoteResult.value.price);
      const prices = [...byDate]
        .map(([date, close]) => ({ date, close }))
        .sort((left, right) => left.date.localeCompare(right.date));
      return {
        asset,
        prices,
        quote:
          quoteResult === null
            ? null
            : {
                price: quoteResult.value.price,
                prevClose: quoteResult.value.prevClose ?? null,
              },
        historyStale: historyResult?.stale ?? local.length > 0,
        quoteStale: quoteResult?.stale ?? false,
        historyMissing: historyResult === null && local.length === 0,
        quoteMissing: quoteResult === null,
        watermark: [
          historyResult?.watermark ??
            `local:${local.map((point) => `${point.date}:${point.close}`).join(',')}`,
          quoteResult?.watermark ?? 'quote-missing',
        ].join(':'),
      };
    }),
  );
}

function createFxInputLoader(market: MarketDataSource, signal?: AbortSignal): FxInputLoader {
  const pending = new Map<string, Promise<MarketFxValue>>();
  const resolved = new Map<string, MarketFxValue>();

  async function rate(currency: string, date?: string): Promise<MarketFxValue> {
    const key = `${currency}|${date ?? 'spot'}`;
    let request = pending.get(key);
    if (request === undefined) {
      request = (async () => {
        try {
          const result = await market.fx(currency, 'EUR', date, signal);
          assertMarketWatermark(result.watermark, `${currency}->EUR`);
          if (
            result.from !== currency ||
            result.to !== 'EUR' ||
            result.date !== (date ?? null) ||
            !Number.isFinite(result.value) ||
            result.value <= 0
          ) {
            throw moneyFailure(
              'MARKET_DATA_INVALID',
              `The ${currency}->EUR market-data response is invalid.`,
            );
          }
          resolved.set(key, result);
          return result;
        } catch (cause) {
          rethrowAbort(cause);
          if (cause instanceof VaultMoneyEngineError) throw cause;
          if (cause instanceof MarketDataSourceError) {
            if (cause.code === 'MARKET_DATA_INVALID') {
              throw moneyFailure('MARKET_DATA_INVALID', cause.message, { cause });
            }
            if (cause.code === 'MARKET_DATA_UNSUPPORTED') {
              throw moneyFailure('MARKET_DATA_UNSUPPORTED', cause.message, { cause });
            }
          }
          throw moneyFailure(
            'MARKET_DATA_MISSING',
            `A ${currency}->EUR rate is unavailable for ${date ?? 'spot'}.`,
            { retryable: true, details: { currency, date: date ?? null }, cause },
          );
        }
      })();
      pending.set(key, request);
      request.catch(() => {
        if (pending.get(key) === request) pending.delete(key);
      });
    }
    return request;
  }

  return {
    converter: {
      async toBase(amount, currency, options) {
        signal?.throwIfAborted();
        const result = await rate(currency, options?.date);
        return amount * result.value;
      },
    },
    values() {
      return resolved;
    },
  };
}

function splitCashBuyFlows(model: ClientPortfolioModel): Array<{ date: string; flowEur: number }> {
  const transactionDayById = new Map(
    model.transactions.map((transaction) => [transaction.id, transaction.executedAt.slice(0, 10)]),
  );
  return model.cashMovements.flatMap((movement) => {
    if (movement.kind !== 'buy' || movement.transactionId === null) return [];
    const buyDay = transactionDayById.get(movement.transactionId);
    const settleDay = movement.occurredAt.slice(0, 10);
    if (buyDay === undefined || buyDay === settleDay) return [];
    return [
      { date: buyDay, flowEur: -movement.amountEur },
      { date: settleDay, flowEur: movement.amountEur },
    ];
  });
}

function marketWatermark(
  loaded: readonly LoadedAssetMarket[],
  fxInputs: ReadonlyMap<string, MarketFxValue>,
): string {
  return [
    ...loaded.map(
      (entry) =>
        `${entry.asset.id}:${entry.historyStale ? 'history-stale' : 'history-fresh'}:${
          entry.quoteStale ? 'quote-stale' : 'quote-fresh'
        }:${entry.watermark}`,
    ),
    ...[...fxInputs.entries()].map(
      ([key, result]) => `${key}:EUR:${result.stale ? 'stale' : 'fresh'}:${result.watermark}`,
    ),
  ]
    .sort()
    .join('|');
}

function missingPricesByDay(
  model: ClientPortfolioModel,
  loaded: readonly LoadedAssetMarket[],
  days: readonly string[],
  today: string,
): Map<string, string[]> {
  const byAsset = new Map(
    loaded.map((entry) => [
      entry.asset.id,
      {
        entry,
        transactions: model.transactions.filter(
          (transaction) => transaction.assetId === entry.asset.id,
        ),
      },
    ]),
  );
  const result = new Map<string, string[]>();
  for (const day of days) {
    const missing: string[] = [];
    for (const [assetId, state] of byAsset) {
      const throughDay = state.transactions.filter(
        (transaction) => transaction.executedAt.slice(0, 10) <= day,
      );
      if (throughDay.length === 0 || reducePosition(throughDay).quantity <= QTY_EPSILON) continue;
      const hasPrice = state.entry.prices.some((point) => point.date <= day);
      const currentQuoteMissing = day === today && state.entry.quoteMissing;
      if (!hasPrice || currentQuoteMissing || (state.entry.historyMissing && day < today)) {
        missing.push(assetId);
      }
    }
    result.set(day, missing.sort());
  }
  return result;
}

function rangeStart(today: string, range: ClientPortfolioRange): string {
  if (range === 'MAX') return '0000-01-01';
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  const date = new Date(todayMs);
  switch (range) {
    case '1D':
      return new Date(todayMs - 86_400_000).toISOString().slice(0, 10);
    case '1W':
      return new Date(todayMs - 7 * 86_400_000).toISOString().slice(0, 10);
    case '1M':
      date.setUTCMonth(date.getUTCMonth() - 1);
      break;
    case '6M':
      date.setUTCMonth(date.getUTCMonth() - 6);
      break;
    case '1Y':
      date.setUTCFullYear(date.getUTCFullYear() - 1);
      break;
    case '5Y':
      date.setUTCFullYear(date.getUTCFullYear() - 5);
      break;
  }
  return date.toISOString().slice(0, 10);
}

function rethrowAbort(cause: unknown): void {
  if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
}

function rethrowInvalidMarketData(cause: unknown): void {
  if (!(cause instanceof MarketDataSourceError)) return;
  if (cause.code === 'MARKET_DATA_INVALID') {
    throw moneyFailure('MARKET_DATA_INVALID', cause.message, { cause });
  }
  if (cause.code === 'MARKET_DATA_UNSUPPORTED') {
    throw moneyFailure('MARKET_DATA_UNSUPPORTED', cause.message, { cause });
  }
}

function assertMarketWatermark(watermark: string, label: string): void {
  if (typeof watermark !== 'string' || watermark.length === 0) {
    throw moneyFailure('MARKET_DATA_INVALID', `Market-data watermark for ${label} is missing.`);
  }
}

function marketOrMoneyFailure(cause: unknown) {
  if (cause instanceof MarketDataSourceError) {
    return {
      code:
        cause.code === 'MARKET_DATA_INVALID'
          ? ('MARKET_DATA_INVALID' as const)
          : cause.code === 'MARKET_DATA_UNSUPPORTED'
            ? ('MARKET_DATA_UNSUPPORTED' as const)
            : ('MARKET_DATA_UNAVAILABLE' as const),
      message: cause.message,
      retryable: cause.code === 'MARKET_DATA_UNAVAILABLE',
    };
  }
  return asMoneyFailure(cause);
}

/** Compose the valuation half with the tax half without exposing internals. */
export function withTaxEngine(
  portfolio: PortfolioDerivationEngine,
  deriveTaxReport: VaultMoneyEngine['deriveTaxReport'],
  lifecycle: Pick<VaultMoneyEngine, 'onAppOpen' | 'afterUnlock'>,
): VaultMoneyEngine {
  return {
    onAppOpen: lifecycle.onAppOpen,
    afterUnlock: lifecycle.afterUnlock,
    derivePortfolio: portfolio.derivePortfolio,
    deriveTaxReport,
    clearCache: portfolio.clearCache,
  };
}

/** Narrowing helper retained for tests that exercise the public range contract. */
export function marketHistoryRangeForPortfolioRange(range: ClientPortfolioRange): HistoryRange {
  return range;
}
