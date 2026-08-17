import type { HistoryRange, VaultDocument } from '@bettertrack/contracts';
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
  type MarketDataValue,
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
  /*
   * The stale/missing flags are false on every loaded result by contract:
   * loadMarketInputs fails closed (typed retryable failure) on any stale or
   * missing input instead of serving a partial series. They exist so a future
   * partial-staleness mode can flow through the series builder unchanged.
   */
  historyStale: boolean;
  quoteStale: boolean;
  historyMissing: boolean;
  quoteMissing: boolean;
  watermark: string;
}

interface AssetMarketDemand {
  history: boolean;
  quote: boolean;
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
        /*
         * The cache key needs the derived market watermark (FX dates are only
         * known after derivation), so this cache cannot skip the derive work;
         * it stabilizes RESULT IDENTITY for equal inputs so consumers can use
         * reference equality. Restructure for compute reuse when #728 wires
         * production consumers.
         */
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
  if (holdingsValueEur === null) {
    throw moneyFailure(
      'MARKET_DATA_MISSING',
      'A current price or FX rate is missing for an active holding.',
      { retryable: true },
    );
  }
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

  const linkedTransactionIds = cashSettledTransactionIds(model.cashMovements);
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
  const start = portfolioRangeStartIso(today, range);
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
  if (hasAnyMissing) {
    const missingAssetIds = [
      ...new Set([...missingByDate.values()].flatMap((assetIds) => assetIds)),
    ].sort();
    throw moneyFailure(
      'MARKET_DATA_MISSING',
      'A required historical close is missing for the portfolio series.',
      { retryable: true, details: { assetIds: missingAssetIds } },
    );
  }
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
  document: VaultDocument,
  model: ClientPortfolioModel,
  today: string,
  market: MarketDataSource,
  signal?: AbortSignal,
): Promise<LoadedAssetMarket[]> {
  const demandByAsset = marketDemandByAsset(model, today);
  return Promise.all(
    [...demandByAsset].map(async ([assetId, demand]): Promise<LoadedAssetMarket> => {
      signal?.throwIfAborted();
      const asset = model.assets.get(assetId);
      if (asset === undefined) {
        throw moneyFailure('VAULT_INVALID_OWNERSHIP', `Asset ${assetId} is unavailable.`);
      }
      const local = storedPrices(document, assetId);
      if (asset.providerId === 'manual') {
        const manual = localManualAssetMarket(document, asset);
        if (demand.history && manual.prices.length === 0) {
          throw moneyFailure(
            'MARKET_DATA_MISSING',
            `Historical local valuations are unavailable for manual asset ${assetId}.`,
            { retryable: true, details: { assetId } },
          );
        }
        if (demand.quote && manual.quote === null) {
          throw moneyFailure(
            'MARKET_DATA_MISSING',
            `A current local valuation is unavailable for manual asset ${assetId}.`,
            { retryable: true, details: { assetId } },
          );
        }
        const prices = demand.history ? [...manual.prices] : [];
        if (demand.quote && manual.quote !== null) {
          prices.push({ date: today, close: manual.quote.price });
        }
        return {
          asset,
          prices,
          quote: demand.quote ? manual.quote : null,
          historyStale: false,
          quoteStale: false,
          historyMissing: false,
          quoteMissing: false,
          watermark: [
            demand.history ? `history:${manual.watermark}` : 'history:not-required',
            demand.quote ? `quote:${manual.watermark}` : 'quote:not-required',
          ].join(':'),
        };
      }

      const [historyResult, quoteResult] = await Promise.all([
        demand.history
          ? requiredMarketResult(`daily history for asset ${assetId}`, () =>
              market.history(assetId, 'MAX', signal),
            )
          : null,
        demand.quote
          ? requiredMarketResult(`quote for asset ${assetId}`, () => market.quote(assetId, signal))
          : null,
      ]);
      if (historyResult !== null) {
        assertFreshMarketResult(historyResult, `daily history for asset ${assetId}`);
        if (historyResult.value.length === 0) {
          throw moneyFailure(
            'MARKET_DATA_MISSING',
            `Daily history for asset ${assetId} is empty.`,
            {
              retryable: true,
              details: { assetId },
            },
          );
        }
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
        assertFreshMarketResult(quoteResult, `quote for asset ${assetId}`);
        assertMarketWatermark(quoteResult.watermark, assetId);
        if (
          !Number.isFinite(quoteResult.value.price) ||
          quoteResult.value.price <= 0 ||
          (quoteResult.value.prevClose != null &&
            (!Number.isFinite(quoteResult.value.prevClose) || quoteResult.value.prevClose <= 0))
        ) {
          throw moneyFailure('MARKET_DATA_INVALID', `Quote for ${assetId} is invalid.`);
        }
        if (quoteResult.value.currency.toUpperCase() !== asset.currency.toUpperCase()) {
          throw moneyFailure(
            'MARKET_DATA_INVALID',
            `Quote currency for ${assetId} does not match its vault asset currency.`,
          );
        }
      }
      const byDate = new Map(
        (demand.history ? local : []).map((point) => [point.date, point.close]),
      );
      if (historyResult !== null) {
        for (const point of historyResult.value) {
          const day = point.time.slice(0, 10);
          if (day < today) byDate.set(day, point.close);
        }
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
        historyStale: false,
        quoteStale: false,
        historyMissing: false,
        quoteMissing: false,
        watermark: [
          historyResult === null ? 'history:not-required' : `history:${historyResult.watermark}`,
          quoteResult === null ? 'quote:not-required' : `quote:${quoteResult.watermark}`,
        ].join(':'),
      };
    }),
  );
}

function marketDemandByAsset(
  model: ClientPortfolioModel,
  today: string,
): Map<string, AssetMarketDemand> {
  const transactionsByAsset = new Map<string, ClientPortfolioModel['transactions']>();
  for (const transaction of model.transactions) {
    const transactions = transactionsByAsset.get(transaction.assetId);
    if (transactions === undefined) {
      transactionsByAsset.set(transaction.assetId, [transaction]);
    } else {
      transactions.push(transaction);
    }
  }

  return new Map(
    [...transactionsByAsset].map(([assetId, transactions]) => {
      const throughToday = transactions.filter(
        (transaction) => transaction.executedAt.slice(0, 10) <= today,
      );
      const priorDays = [
        ...new Set(
          throughToday
            .map((transaction) => transaction.executedAt.slice(0, 10))
            .filter((day) => day < today),
        ),
      ];
      const history = priorDays.some((day) => {
        const throughDay = throughToday.filter(
          (transaction) => transaction.executedAt.slice(0, 10) <= day,
        );
        return reducePosition(throughDay).quantity > QTY_EPSILON;
      });
      /*
       * Current holdings intentionally match the shared/server domain and are
       * derived from the complete persisted transaction set, including
       * future-dated rows. Quote demand must use that same set or holdings can
       * become positive after the loader has decided that no quote is needed.
       * Historical series remain bounded by `today`.
       */
      const quote = transactions.length > 0 && reducePosition(transactions).quantity > QTY_EPSILON;
      return [assetId, { history, quote }] as const;
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
          assertFreshMarketResult(result, `${currency}->EUR FX for ${date ?? 'spot'}`);
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

/**
 * The transactions whose money never crossed the portfolio boundary because they
 * were settled against the cash ledger — a `buy` paid from cash or a `sell` whose
 * proceeds were booked into cash. Their external flow was recorded when that cash
 * moved, so counting the transaction again would double it (#125).
 *
 * **Only `buy` / `sell_proceeds` legs qualify.** A V3-P4 `tax_withholding` /
 * `tax_refund` settlement also rides on its sell's `transactionId` (§16
 * 2026-07-08) and says nothing about where the proceeds went. Keying on "has
 * *any* linked movement" suppressed the outflow of a taxed sell that paid out
 * instead of into cash while the holdings still left the value curve — a phantom
 * loss. Mirrors `cashSettledTxnIds` in the server's snapshot engine; the two must
 * stay identical or the paranoid client and the API report different returns.
 */
export function cashSettledTransactionIds(
  cashMovements: readonly ClientPortfolioModel['cashMovements'][number][],
): Set<string> {
  const ids = new Set<string>();
  for (const movement of cashMovements) {
    if (movement.transactionId === null) continue;
    if (movement.kind === 'buy' || movement.kind === 'sell_proceeds') {
      ids.add(movement.transactionId);
    }
  }
  return ids;
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

/**
 * UTC day at which a portfolio range opens. Calendar spans clamp onto the
 * target month's last real day so March 31 minus one month is February 28/29,
 * never a rollover back into March.
 */
export function portfolioRangeStartIso(today: string, range: ClientPortfolioRange): string {
  if (range === 'MAX') return '0000-01-01';
  switch (range) {
    case '1D':
      return daysBeforeIso(today, 1);
    case '1W':
      return daysBeforeIso(today, 7);
    case '1M':
      return monthsBeforeIso(today, 1);
    case '6M':
      return monthsBeforeIso(today, 6);
    case '1Y':
      return monthsBeforeIso(today, 12);
    case '5Y':
      return monthsBeforeIso(today, 60);
  }
}

function daysBeforeIso(today: string, days: number): string {
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function monthsBeforeIso(today: string, months: number): string {
  const date = new Date(`${today}T00:00:00.000Z`);
  const dayOfMonth = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return date.toISOString().slice(0, 10);
}

function rethrowAbort(cause: unknown): void {
  if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
}

function assertMarketWatermark(watermark: string, label: string): void {
  if (typeof watermark !== 'string' || watermark.length === 0) {
    throw moneyFailure('MARKET_DATA_INVALID', `Market-data watermark for ${label} is missing.`);
  }
}

async function requiredMarketResult<T>(
  label: string,
  load: () => Promise<MarketDataValue<T>>,
): Promise<MarketDataValue<T>> {
  try {
    return await load();
  } catch (cause) {
    rethrowAbort(cause);
    if (cause instanceof MarketDataSourceError || cause instanceof VaultMoneyEngineError) {
      throw cause;
    }
    throw moneyFailure('MARKET_DATA_UNAVAILABLE', `Fresh ${label} is unavailable.`, {
      retryable: true,
      cause,
    });
  }
}

function assertFreshMarketResult(
  result: Pick<MarketDataValue<unknown>, 'stale' | 'asOf'>,
  label: string,
): void {
  if (!result.stale) return;
  throw moneyFailure('MARKET_DATA_UNAVAILABLE', `Fresh ${label} is unavailable.`, {
    retryable: true,
    details: { stale: true, asOf: result.asOf },
  });
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
  lifecycle: Pick<
    VaultMoneyEngine,
    | 'onAppOpen'
    | 'afterUnlock'
    | 'getLastStandingOrderMaterialization'
    | 'subscribeStandingOrderMaterialization'
  >,
): VaultMoneyEngine {
  return {
    onAppOpen: lifecycle.onAppOpen,
    afterUnlock: lifecycle.afterUnlock,
    getLastStandingOrderMaterialization: lifecycle.getLastStandingOrderMaterialization,
    subscribeStandingOrderMaterialization: lifecycle.subscribeStandingOrderMaterialization,
    derivePortfolio: portfolio.derivePortfolio,
    deriveTaxReport,
    clearCache: portfolio.clearCache,
  };
}

/** Narrowing helper retained for tests that exercise the public range contract. */
export function marketHistoryRangeForPortfolioRange(range: ClientPortfolioRange): HistoryRange {
  return range;
}
