import {
  VAULT_ENTITY_ROW_SCHEMAS,
  customTaxParamsSchema,
  taxYearReportResponseSchema,
  type CustomTaxParams as ContractCustomTaxParams,
  type TaxCountry,
  type TaxMode,
  type TaxYearPosition,
  type TaxYearReportResponse,
  type VaultDocument,
} from '@bettertrack/contracts';
import { floorCents, projectCashLedgerBySource } from '@bettertrack/domain/cashLedger';
import { resolvePortfolioSetting } from '@bettertrack/domain/settingsScope';
import {
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  costBasisStrategyForCountry,
  customCarryForYears,
  deCarryPots,
  dePotCategoryForAssetType,
  realizedSellsEur,
  settleAtYear,
  settleCustomYear,
  settleDeYear,
  viennaYearOf,
  type CostBasisStrategy,
  type CustomTaxParams,
  type CustomTaxableEvent,
  type DeTaxableEvent,
  type SellRealizationEur,
  type TaxableTransaction,
} from '@bettertrack/domain/tax';

import { MarketDataSourceError, type MarketDataSource } from '../../../lib/marketDataSource';
import type { VaultSyncEngine } from '../sync';
import { VaultDerivedCache } from './cache';
import { asMoneyFailure, moneyFailure, type VaultMoneyOutcome } from './errors';
import {
  readPortfolioModel,
  type ClientDividendRecord,
  type ClientPortfolioModel,
  type ClientTransactionRecord,
} from './model';
import { assertVaultSnapshotCurrent, liveEntities, validatedVaultSnapshot } from './session';
import type { ClientTaxReport } from './types';

interface EffectiveTaxSettings {
  mode: TaxMode;
  country: TaxCountry | null;
  custom: CustomTaxParams | null;
}

type TaxRegime =
  | { kind: 'none' }
  | { kind: 'manual' }
  | { kind: 'at' }
  | { kind: 'de' }
  | { kind: 'custom'; params: CustomTaxParams };

interface TaxEngineOptions {
  now?: () => number;
  cache?: VaultDerivedCache<ClientTaxReport>;
}

export interface ClientTaxEngine {
  deriveTaxReport(
    portfolioId: string,
    year: number,
    signal?: AbortSignal,
  ): Promise<VaultMoneyOutcome<ClientTaxReport>>;
  clearTaxCache(): void;
}

export function createClientTaxEngine(
  sync: VaultSyncEngine,
  market: MarketDataSource,
  options: TaxEngineOptions = {},
): ClientTaxEngine {
  const now = options.now ?? Date.now;
  const cache = options.cache ?? new VaultDerivedCache<ClientTaxReport>();

  return {
    async deriveTaxReport(portfolioId, year, signal) {
      try {
        signal?.throwIfAborted();
        if (!Number.isInteger(year) || year < 1900 || year > 3000) {
          throw moneyFailure('TAX_DATA_INVALID', `Unsupported tax-report year ${year}.`);
        }
        const snapshot = validatedVaultSnapshot(sync);
        const model = readPortfolioModel(snapshot.document, portfolioId);
        const settings = effectiveTaxSettings(snapshot.document, model);
        const currentYear = viennaYearOf(new Date(now()).toISOString());
        const converted = await taxableTransactions(model, market, signal);
        const fxWatermarks = converted.watermarks.sort().join('|');
        const assetPriceWatermark = `${converted.stale ? 'stale' : 'fresh'}:${
          fxWatermarks || 'EUR-only'
        }`;
        const key = {
          ownerUserId: snapshot.ownerUserId,
          vaultKeyId: snapshot.vaultKeyId,
          portfolioId,
          vaultVersion: snapshot.vaultVersion,
          writeId: snapshot.writeId,
          assetPriceWatermark,
          range: `tax:${year}:${currentYear}`,
        };
        const cached = cache.get(key);
        if (cached !== undefined) {
          assertVaultSnapshotCurrent(sync, snapshot);
          return { ok: true, value: cached };
        }

        const report = buildTaxReport(model, converted.rows, settings, year, currentYear);
        const value: ClientTaxReport = {
          ownerUserId: snapshot.ownerUserId,
          vaultKeyId: snapshot.vaultKeyId,
          portfolioId,
          report: report.report,
          computedTaxTargetEur: report.computedTaxTargetEur,
          vaultVersion: snapshot.vaultVersion,
          writeId: snapshot.writeId,
          assetPriceWatermark,
          freshness: converted.stale ? 'stale' : 'fresh',
        };
        assertVaultSnapshotCurrent(sync, snapshot);
        cache.set(key, value);
        return { ok: true, value };
      } catch (cause) {
        return { ok: false, error: taxFailure(cause) };
      }
    },

    clearTaxCache() {
      cache.clear();
    },
  };
}

async function taxableTransactions(
  model: ClientPortfolioModel,
  market: MarketDataSource,
  signal?: AbortSignal,
): Promise<{ rows: TaxableTransaction[]; watermarks: string[]; stale: boolean }> {
  const fxMemo = new Map<string, Promise<Awaited<ReturnType<MarketDataSource['fx']>>>>();
  const watermarks = new Set<string>();
  const stale = false;
  const neededAssetIds = new Set(
    model.transactions
      .filter((transaction) => transaction.side === 'sell')
      .map((transaction) => transaction.assetId),
  );
  const sorted = [...model.transactions]
    .sort(
      (left, right) =>
        Date.parse(left.executedAt) - Date.parse(right.executedAt) ||
        left.id.localeCompare(right.id),
    )
    .filter((transaction) => neededAssetIds.has(transaction.assetId));
  const rows: TaxableTransaction[] = [];
  for (const transaction of sorted) {
    signal?.throwIfAborted();
    const asset = model.assets.get(transaction.assetId);
    if (asset === undefined) {
      throw moneyFailure('VAULT_INVALID_OWNERSHIP', `Tax asset ${transaction.assetId} is missing.`);
    }
    const date = transaction.executedAt.slice(0, 10);
    const memoKey = `${asset.currency}|${date}`;
    let pending = fxMemo.get(memoKey);
    if (pending === undefined) {
      pending = market.fx(asset.currency, 'EUR', date, signal);
      fxMemo.set(memoKey, pending);
    }
    let fx: Awaited<ReturnType<MarketDataSource['fx']>>;
    try {
      fx = await pending;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
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
        `Tax FX data is unavailable for ${asset.currency} on ${date}.`,
        { retryable: true, details: { currency: asset.currency, date }, cause },
      );
    }
    if (!Number.isFinite(fx.value) || fx.value <= 0) {
      throw moneyFailure(
        'MARKET_DATA_INVALID',
        `Tax FX data is invalid for ${asset.currency} on ${date}.`,
      );
    }
    if (
      fx.from !== asset.currency ||
      fx.to !== 'EUR' ||
      fx.date !== date ||
      typeof fx.watermark !== 'string' ||
      fx.watermark.length === 0
    ) {
      throw moneyFailure(
        'MARKET_DATA_INVALID',
        `Tax FX metadata is invalid for ${asset.currency} on ${date}.`,
      );
    }
    if (fx.stale) {
      throw moneyFailure(
        'MARKET_DATA_UNAVAILABLE',
        `Fresh tax FX data is unavailable for ${asset.currency} on ${date}.`,
        {
          retryable: true,
          details: { currency: asset.currency, date, stale: true, asOf: fx.asOf },
        },
      );
    }
    // `stale` stays false by contract: the throw above fails closed on any
    // stale FX input. The field exists for a future partial-staleness mode.
    watermarks.add(`${asset.currency}:${date}:${fx.watermark}`);
    rows.push({
      id: transaction.id,
      assetId: transaction.assetId,
      side: transaction.side,
      quantity: transaction.quantity,
      priceEur: transaction.price * fx.value,
      feeEur: transaction.fee * fx.value,
      executedAt: transaction.executedAt,
      allowUncovered: transaction.allowUncovered,
      uncoveredEntryPriceEur:
        transaction.uncoveredEntryPrice === null
          ? null
          : transaction.uncoveredEntryPrice * fx.value,
    });
  }
  return { rows, watermarks: [...watermarks], stale };
}

function buildTaxReport(
  model: ClientPortfolioModel,
  taxables: readonly TaxableTransaction[],
  settings: EffectiveTaxSettings,
  requestedYear: number,
  currentYear: number,
): { report: TaxYearReportResponse; computedTaxTargetEur: number } {
  projectCashLedgerBySource(model.cashMovements);
  const moving = realizationMap(realizedSellsEur(taxables, 'moving-average'));
  const fifo = realizationMap(realizedSellsEur(taxables, 'fifo'));
  const activeRegime = regimeFromSettings(settings);
  const assignedSells = model.transactions
    .filter((transaction) => transaction.side === 'sell')
    .map((transaction) => ({
      row: transaction,
      year: viennaYearOf(transaction.executedAt),
      regime: regimeForRow(transaction, activeRegime, currentYear),
    }));
  const assignedDividends = model.dividends.map((dividend) => ({
    row: dividend,
    year: viennaYearOf(dividend.executedAt),
    regime: regimeForRow(dividend, activeRegime, currentYear),
  }));

  const realizationFor = (
    transaction: ClientTransactionRecord,
    year: number,
    regime: TaxRegime,
  ): SellRealizationEur => {
    const strategy = strategyForReportRow(transaction, regime, year, currentYear, settings);
    const realization = (strategy === 'fifo' ? fifo : moving).get(transaction.id);
    if (realization === undefined) {
      throw moneyFailure(
        'TAX_DATA_INVALID',
        `Tax realization is missing for sell ${transaction.id}.`,
      );
    }
    return realization;
  };

  const atEvents = new Map<number, CustomTaxableEvent[]>();
  const deEvents = new Map<number, DeTaxableEvent[]>();
  const customGroups = new Map<
    string,
    { params: CustomTaxParams; events: Map<number, CustomTaxableEvent[]> }
  >();

  const datedEvents = [
    ...assignedSells.map((entry, order) => {
      const realization = realizationFor(entry.row, entry.year, entry.regime);
      return {
        at: Date.parse(entry.row.executedAt),
        order,
        regime: entry.regime,
        year: entry.year,
        event: {
          kind: 'sell_gain' as const,
          amountEur: realization.realizedPnlEur,
        },
        category: dePotCategoryForAssetType(model.assets.get(entry.row.assetId)?.type ?? ''),
      };
    }),
    ...assignedDividends.map((entry, index) => ({
      at: Date.parse(entry.row.executedAt),
      order: assignedSells.length + index,
      regime: entry.regime,
      year: entry.year,
      event: { kind: 'dividend' as const, amountEur: entry.row.grossAmountEur },
      category: 'sonstige' as const,
    })),
  ].sort((left, right) => left.at - right.at || left.order - right.order);
  for (const entry of datedEvents) {
    addRegimeEvent(
      entry.regime,
      entry.year,
      entry.event,
      entry.category,
      atEvents,
      deEvents,
      customGroups,
    );
  }

  const targets = new Map<number, number>();
  const addTarget = (year: number, value: number) =>
    targets.set(year, floorCents((targets.get(year) ?? 0) + value));
  for (const [year, events] of atEvents) {
    const gains = events
      .filter((event) => event.kind === 'sell_gain')
      .map((event) => event.amountEur);
    const dividends = events
      .filter((event) => event.kind === 'dividend')
      .map((event) => event.amountEur);
    addTarget(
      year,
      settleAtYear({
        existingGainsEur: gains,
        existingDividendsEur: dividends,
        heldEur: 0,
        newEvents: [],
      }).heldAfterEur,
    );
  }

  const deStates = new Map<
    number,
    {
      settlement: ReturnType<typeof settleDeYear>;
      pots: ReturnType<typeof deCarryPots>;
    }
  >();
  const sortedDeYears = [...deEvents.keys()].sort((left, right) => left - right);
  for (const year of sortedDeYears) {
    const prior = sortedDeYears
      .filter((candidate) => candidate < year)
      .map((candidate) => deEvents.get(candidate) ?? []);
    const pots = deCarryPots(prior);
    const settlement = settleDeYear({
      aktienPotInEur: pots.aktienEur,
      sonstigePotInEur: pots.sonstigeEur,
      existingEvents: deEvents.get(year) ?? [],
      heldEur: 0,
      newEvents: [],
    });
    deStates.set(year, { settlement, pots });
    addTarget(year, settlement.heldAfterEur);
  }

  for (const group of customGroups.values()) {
    const years = [...group.events.keys()].sort((left, right) => left - right);
    for (const year of years) {
      const carry = customCarryForYears(
        group.params,
        years
          .filter((candidate) => candidate < year)
          .map((candidate) => group.events.get(candidate) ?? []),
      );
      const settlement = settleCustomYear({
        params: group.params,
        carry,
        existingEvents: group.events.get(year) ?? [],
        heldEur: 0,
        newEvents: [],
      });
      addTarget(year, settlement.heldAfterEur);
    }
  }

  const summary = summaryForYear(
    model,
    requestedYear,
    currentYear,
    settings.mode !== 'manual_per_trade',
    assignedSells,
    assignedDividends,
    realizationFor,
    targets.get(requestedYear) ?? 0,
    deStates.get(requestedYear),
  );
  const positions = positionsForYear(
    model,
    requestedYear,
    assignedSells,
    assignedDividends,
    realizationFor,
  );
  const report = taxYearReportResponseSchema.parse({
    year: requestedYear,
    summary,
    positions,
  });
  return { report, computedTaxTargetEur: targets.get(requestedYear) ?? 0 };
}

function summaryForYear(
  model: ClientPortfolioModel,
  year: number,
  currentYear: number,
  liveDerivation: boolean,
  sells: Array<{ row: ClientTransactionRecord; year: number; regime: TaxRegime }>,
  dividends: Array<{ row: ClientDividendRecord; year: number; regime: TaxRegime }>,
  realizationFor: (
    row: ClientTransactionRecord,
    year: number,
    regime: TaxRegime,
  ) => SellRealizationEur,
  automaticTargetEur: number,
  deState:
    | {
        settlement: ReturnType<typeof settleDeYear>;
        pots: ReturnType<typeof deCarryPots>;
      }
    | undefined,
) {
  const yearSells = sells.filter((entry) => entry.year === year);
  const yearDividends = dividends.filter((entry) => entry.year === year);
  const realizedPnlEur = yearSells.reduce(
    (total, entry) => total + realizationFor(entry.row, year, entry.regime).realizedPnlEur,
    0,
  );
  const dividendsGrossEur = yearDividends.reduce(
    (total, entry) => total + entry.row.grossAmountEur,
    0,
  );
  let taxWithheldEur = 0;
  let taxRefundedEur = 0;
  for (const movement of model.cashMovements) {
    if (movement.taxYear !== year) continue;
    if (movement.kind === 'tax_withholding') taxWithheldEur += -movement.amountEur;
    if (movement.kind === 'tax_refund') taxRefundedEur += movement.amountEur;
  }
  taxWithheldEur = floorCents(taxWithheldEur);
  taxRefundedEur = floorCents(taxRefundedEur);
  const movementNet = floorCents(taxWithheldEur - taxRefundedEur);
  const manualTax = floorCents(
    yearSells
      .filter((entry) => entry.regime.kind === 'manual')
      .reduce((total, entry) => total + (entry.row.taxAmountEur ?? 0), 0) +
      yearDividends
        .filter((entry) => entry.regime.kind === 'manual')
        .reduce((total, entry) => total + (entry.row.taxAmountEur ?? 0), 0),
  );
  const taxNetEur =
    year < currentYear || !liveDerivation
      ? movementNet
      : floorCents(automaticTargetEur + manualTax);
  const de =
    deState === undefined
      ? undefined
      : {
          allowanceUsedEur: floorCents(deState.settlement.yearEnd.allowanceUsedEur),
          allowanceRemainingEur: floorCents(deState.settlement.yearEnd.allowanceRemainingEur),
          aktienPotInEur: floorCents(deState.pots.aktienEur),
          aktienPotOutEur: floorCents(deState.settlement.yearEnd.aktienPotOutEur),
          sonstigePotInEur: floorCents(deState.pots.sonstigeEur),
          sonstigePotOutEur: floorCents(deState.settlement.yearEnd.sonstigePotOutEur),
          kapestEur: deState.settlement.yearEnd.kapestEur,
          soliEur: deState.settlement.yearEnd.soliEur,
        };

  return {
    year,
    realizedPnlEur,
    dividendsGrossEur,
    taxWithheldEur,
    taxRefundedEur,
    taxNetEur,
    ...(de === undefined ? {} : { de }),
    ...(year < currentYear ? { locked: true } : {}),
  };
}

function positionsForYear(
  model: ClientPortfolioModel,
  year: number,
  sells: Array<{ row: ClientTransactionRecord; year: number; regime: TaxRegime }>,
  dividends: Array<{ row: ClientDividendRecord; year: number; regime: TaxRegime }>,
  realizationFor: (
    row: ClientTransactionRecord,
    year: number,
    regime: TaxRegime,
  ) => SellRealizationEur,
): TaxYearPosition[] {
  const assetIds = new Set([
    ...sells.filter((entry) => entry.year === year).map((entry) => entry.row.assetId),
    ...dividends.filter((entry) => entry.year === year).map((entry) => entry.row.assetId),
  ]);
  const positions: TaxYearPosition[] = [];
  for (const assetId of assetIds) {
    const asset = model.assets.get(assetId);
    if (asset === undefined) {
      throw moneyFailure('TAX_DATA_INVALID', `Tax report asset ${assetId} is missing.`);
    }
    const sellRows = sells
      .filter((entry) => entry.year === year && entry.row.assetId === assetId)
      .sort(
        (left, right) =>
          Date.parse(left.row.executedAt) - Date.parse(right.row.executedAt) ||
          left.row.id.localeCompare(right.row.id),
      )
      .map((entry) => {
        const realization = realizationFor(entry.row, year, entry.regime);
        return {
          transactionId: entry.row.id,
          executedAt: entry.row.executedAt,
          quantity: entry.row.quantity,
          proceedsEur: realization.proceedsEur,
          costBasisEur: realization.costBasisEur,
          realizedPnlEur: realization.realizedPnlEur,
          taxMode: entry.row.taxMode,
          taxAmountEur: entry.row.taxAmountEur,
        };
      });
    const dividendRows = dividends
      .filter((entry) => entry.year === year && entry.row.assetId === assetId)
      .sort(
        (left, right) =>
          Date.parse(left.row.executedAt) - Date.parse(right.row.executedAt) ||
          left.row.id.localeCompare(right.row.id),
      )
      .map((entry) => ({
        dividendId: entry.row.id,
        executedAt: entry.row.executedAt,
        grossAmountEur: entry.row.grossAmountEur,
        taxMode: entry.row.taxMode,
        taxAmountEur: entry.row.taxAmountEur,
      }));
    positions.push({
      asset: asset.dto,
      realizedPnlEur: sellRows.reduce((total, row) => total + row.realizedPnlEur, 0),
      dividendsGrossEur: dividendRows.reduce((total, row) => total + row.grossAmountEur, 0),
      taxEur: floorCents(
        sellRows.reduce((total, row) => total + (row.taxAmountEur ?? 0), 0) +
          dividendRows.reduce((total, row) => total + (row.taxAmountEur ?? 0), 0),
      ),
      sells: sellRows,
      dividends: dividendRows,
    });
  }
  return positions.sort((left, right) => left.asset.symbol.localeCompare(right.asset.symbol));
}

function addRegimeEvent(
  regime: TaxRegime,
  year: number,
  event: CustomTaxableEvent,
  category: 'aktien' | 'sonstige',
  atEvents: Map<number, CustomTaxableEvent[]>,
  deEvents: Map<number, DeTaxableEvent[]>,
  customGroups: Map<string, { params: CustomTaxParams; events: Map<number, CustomTaxableEvent[]> }>,
): void {
  if (regime.kind === 'at') {
    append(atEvents, year, event);
  } else if (regime.kind === 'de') {
    append(
      deEvents,
      year,
      event.kind === 'dividend'
        ? event
        : { kind: 'sell_gain', amountEur: event.amountEur, category },
    );
  } else if (regime.kind === 'custom') {
    const key = customKey(regime.params);
    let group = customGroups.get(key);
    if (group === undefined) {
      group = { params: regime.params, events: new Map() };
      customGroups.set(key, group);
    }
    append(group.events, year, event);
  }
}

function regimeForRow(
  row: ClientTransactionRecord | ClientDividendRecord,
  active: TaxRegime,
  currentYear: number,
): TaxRegime {
  const year = viennaYearOf(row.executedAt);
  if (year >= currentYear && row.taxMode !== 'manual_per_trade' && active.kind !== 'manual') {
    return active;
  }
  if (row.taxMode === 'manual_per_trade') return { kind: 'manual' };
  if (row.taxMode === 'none' || row.taxMode === null) return { kind: 'none' };
  if (row.taxMode === 'country_specific') {
    if (row.taxCountry === null || row.taxCountry === TAX_COUNTRY_AT) {
      return { kind: 'at' };
    }
    if (row.taxCountry === TAX_COUNTRY_DE) return { kind: 'de' };
    throw moneyFailure(
      'TAX_MODE_UNSUPPORTED',
      `Tax country ${String(row.taxCountry)} is unsupported by the paranoid client engine.`,
    );
  }
  if (row.taxMode === 'custom') {
    return { kind: 'custom', params: parseCustom(row.taxParams) };
  }
  throw moneyFailure('TAX_MODE_UNSUPPORTED', `Unsupported frozen tax mode ${String(row.taxMode)}.`);
}

function strategyForReportRow(
  transaction: ClientTransactionRecord,
  regime: TaxRegime,
  year: number,
  currentYear: number,
  settings: EffectiveTaxSettings,
): CostBasisStrategy {
  if (
    year >= currentYear &&
    transaction.taxMode !== 'manual_per_trade' &&
    settings.mode !== 'manual_per_trade'
  ) {
    if (settings.mode === 'country_specific') {
      return costBasisStrategyForCountry(settings.country);
    }
    if (settings.mode === 'custom' && settings.custom !== null) return settings.custom.costBasis;
    if (settings.mode !== 'none') return 'moving-average';
  }
  if (transaction.taxMode === 'country_specific') {
    if (transaction.taxCountry === null || transaction.taxCountry === TAX_COUNTRY_AT) {
      return 'moving-average';
    }
    if (transaction.taxCountry === TAX_COUNTRY_DE) return 'fifo';
    throw moneyFailure(
      'TAX_MODE_UNSUPPORTED',
      `Tax country ${String(transaction.taxCountry)} is unsupported by the paranoid client engine.`,
    );
  }
  if (transaction.taxMode === 'custom') {
    return parseCustom(transaction.taxParams).costBasis;
  }
  if (regime.kind === 'de') return 'fifo';
  if (regime.kind === 'custom') return regime.params.costBasis;
  return 'moving-average';
}

function effectiveTaxSettings(
  document: VaultDocument,
  model: ClientPortfolioModel,
): EffectiveTaxSettings {
  const overrideEntity = liveEntities(document, 'portfolioSetting').find((entity) => {
    const row = VAULT_ENTITY_ROW_SCHEMAS.portfolioSetting.parse(entity.data);
    return row.portfolioId === model.portfolioId && row.key === 'tax';
  });
  const override =
    overrideEntity === undefined
      ? null
      : parseSettings(
          VAULT_ENTITY_ROW_SCHEMAS.portfolioSetting.parse(overrideEntity.data).value,
          'portfolio tax override',
        );
  const defaults = liveEntities(document, 'taxSetting')
    .map((entity) => ({
      id: entity.id,
      row: VAULT_ENTITY_ROW_SCHEMAS.taxSetting.parse(entity.data),
    }))
    .filter(({ row }) => row.userId === model.ownerUserId)
    .sort(
      (left, right) =>
        left.row.updatedAt.localeCompare(right.row.updatedAt) || left.id.localeCompare(right.id),
    );
  const latest = defaults.at(-1)?.row;
  const userDefault =
    latest === undefined
      ? null
      : validateSettings({
          mode: latest.mode,
          country: latest.country,
          custom: latest.customParams,
        });
  return resolvePortfolioSetting<EffectiveTaxSettings>(override, userDefault, {
    mode: 'none',
    country: null,
    custom: null,
  }).value;
}

function parseSettings(raw: unknown, label: string): EffectiveTaxSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw moneyFailure('TAX_PARAMETERS_INVALID', `${label} is malformed.`);
  }
  const value = raw as Record<string, unknown>;
  return validateSettings({
    mode: value.mode,
    country: value.country,
    custom: value.custom,
  });
}

function validateSettings(input: {
  mode: unknown;
  country: unknown;
  custom: unknown;
}): EffectiveTaxSettings {
  const mode = input.mode;
  if (
    mode !== 'none' &&
    mode !== 'manual_per_trade' &&
    mode !== 'country_specific' &&
    mode !== 'custom'
  ) {
    throw moneyFailure('TAX_MODE_UNSUPPORTED', `Unsupported tax mode ${String(mode)}.`);
  }
  const countryPresent = input.country !== null && input.country !== undefined;
  const customPresent = input.custom !== null && input.custom !== undefined;
  if ((mode === 'country_specific') !== countryPresent || (mode === 'custom') !== customPresent) {
    throw moneyFailure(
      'TAX_PARAMETERS_INVALID',
      `Tax mode ${mode} has inconsistent country or custom parameters.`,
    );
  }
  if (mode === 'country_specific') {
    if (input.country !== TAX_COUNTRY_AT && input.country !== TAX_COUNTRY_DE) {
      throw moneyFailure(
        'TAX_MODE_UNSUPPORTED',
        `Tax country ${String(input.country)} is unsupported by the paranoid client engine.`,
      );
    }
    return {
      mode,
      country: input.country,
      custom: null,
    };
  }
  if (mode === 'custom') {
    return { mode, country: null, custom: parseCustom(input.custom) };
  }
  return { mode, country: null, custom: null };
}

function regimeFromSettings(settings: EffectiveTaxSettings): TaxRegime {
  if (settings.mode === 'none') return { kind: 'none' };
  if (settings.mode === 'manual_per_trade') return { kind: 'manual' };
  if (settings.mode === 'custom') {
    if (settings.custom === null) {
      throw moneyFailure('TAX_PARAMETERS_INVALID', 'Custom tax mode has no parameter set.');
    }
    return { kind: 'custom', params: settings.custom };
  }
  if (settings.country === TAX_COUNTRY_AT) return { kind: 'at' };
  if (settings.country === TAX_COUNTRY_DE) return { kind: 'de' };
  throw moneyFailure('TAX_MODE_UNSUPPORTED', `Unsupported tax country ${settings.country}.`);
}

function parseCustom(raw: unknown): CustomTaxParams {
  const candidate =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'custom' in raw
      ? (raw as { custom: unknown }).custom
      : raw;
  const parsed = customTaxParamsSchema.safeParse(candidate);
  if (!parsed.success) {
    throw moneyFailure('TAX_PARAMETERS_INVALID', 'Custom tax parameters are malformed.', {
      details: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
    });
  }
  return contractToDomainCustom(parsed.data);
}

function contractToDomainCustom(params: ContractCustomTaxParams): CustomTaxParams {
  return { ...params };
}

function realizationMap(rows: readonly SellRealizationEur[]): Map<string, SellRealizationEur> {
  return new Map(rows.map((row) => [row.id, row]));
}

function append<T>(map: Map<number, T[]>, year: number, value: T): void {
  const rows = map.get(year);
  if (rows === undefined) map.set(year, [value]);
  else rows.push(value);
}

function customKey(params: CustomTaxParams): string {
  return [
    params.ratePct,
    params.lossOffset,
    params.refund,
    params.yearReset,
    params.carryForward,
    params.costBasis,
  ].join(':');
}

function taxFailure(cause: unknown) {
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
