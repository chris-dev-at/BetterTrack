import {
  VAULT_ENTITY_ROW_SCHEMAS,
  type PortfolioAsset,
  type TaxCountry,
  type TaxMode,
  type VaultDocument,
  type VaultEntity,
} from '@bettertrack/contracts';
import type { SourcedCashMovement } from '@bettertrack/domain/cashLedger';
import type { Transaction as DomainTransaction } from '@bettertrack/domain/holdings';

import { moneyFailure } from './errors';
import { liveEntities, requireLiveEntity } from './session';

export interface ClientAssetRecord {
  id: string;
  providerId: string;
  providerRef: string;
  currency: string;
  type: string;
  dto: PortfolioAsset;
}

export interface LocalAssetSnapshotFacts {
  readonly isCustom?: unknown;
  readonly ownerId?: unknown;
  readonly providerId?: unknown;
  readonly type?: unknown;
}

/** Decide whether one row in the vault's local asset table is owner-local. */
export function isLocalAssetSnapshot(row: LocalAssetSnapshotFacts): boolean {
  return typeof row.isCustom === 'boolean'
    ? row.isCustom
    : row.ownerId != null ||
        (typeof row.providerId === 'string' ? row.providerId : 'manual') === 'manual' ||
        row.type === 'custom';
}

export interface ClientTransactionRecord extends DomainTransaction {
  id: string;
  portfolioId: string;
  allowUncovered: boolean;
  uncoveredEntryPrice: number | null;
  taxMode: TaxMode | null;
  taxCountry: TaxCountry | null;
  taxAmountEur: number | null;
  taxParams: unknown;
  source: string;
}

export interface ClientDividendRecord {
  id: string;
  portfolioId: string;
  assetId: string;
  cashSourceId: string;
  grossAmountEur: number;
  executedAt: string;
  taxMode: TaxMode;
  taxCountry: TaxCountry | null;
  taxAmountEur: number | null;
  taxParams: unknown;
  source: string;
}

export interface ClientCashMovementRecord extends SourcedCashMovement {
  id: string;
  portfolioId: string;
  transactionId: string | null;
  taxYear: number | null;
  source: string;
}

export interface ClientCashSourceRecord {
  id: string;
  portfolioId: string;
  name: string;
}

export interface ClientPortfolioModel {
  portfolioId: string;
  ownerUserId: string;
  assets: ReadonlyMap<string, ClientAssetRecord>;
  transactions: ClientTransactionRecord[];
  dividends: ClientDividendRecord[];
  cashMovements: ClientCashMovementRecord[];
  cashSources: ClientCashSourceRecord[];
}

export function readPortfolioModel(
  document: VaultDocument,
  portfolioId: string,
): ClientPortfolioModel {
  const portfolio = requireLiveEntity(document, 'portfolio', portfolioId);
  const ownerUserId = stringValue(portfolio.data.userId, 'portfolio.userId');
  const assets = new Map(
    liveEntities(document, 'customAsset').map((entity) => {
      const row = VAULT_ENTITY_ROW_SCHEMAS.customAsset.parse(entity.data);
      const meta = isRecord(row.meta) ? row.meta : null;
      const isCustom = isLocalAssetSnapshot(entity.data);
      const dto: PortfolioAsset = {
        id: entity.id,
        symbol: row.symbol,
        name: row.name,
        exchange: row.exchange,
        currency: row.currency,
        type: row.type,
        isCustom,
        category: isCustom ? customCategory(meta) : null,
        smoothing: meta?.smoothing === true,
      };
      const asset: ClientAssetRecord = {
        id: entity.id,
        providerId: row.providerId,
        providerRef: row.providerRef,
        currency: row.currency,
        type: row.type,
        dto,
      };
      return [entity.id, asset] as const;
    }),
  );

  const transactions = liveEntities(document, 'transaction')
    .map(parseTransaction)
    .filter((row) => row.portfolioId === portfolioId)
    .sort(
      (left, right) =>
        Date.parse(left.executedAt) - Date.parse(right.executedAt) ||
        left.id.localeCompare(right.id),
    );
  for (const transaction of transactions) {
    if (!assets.has(transaction.assetId)) {
      throw moneyFailure(
        'VAULT_INVALID_OWNERSHIP',
        `Transaction ${transaction.id} references an unavailable asset.`,
      );
    }
  }

  const dividends = liveEntities(document, 'dividend')
    .map(parseDividend)
    .filter((row) => row.portfolioId === portfolioId)
    .sort(
      (left, right) =>
        Date.parse(left.executedAt) - Date.parse(right.executedAt) ||
        left.id.localeCompare(right.id),
    );
  const cashMovements = liveEntities(document, 'cashMovement')
    .map(parseCashMovement)
    .filter((row) => row.portfolioId === portfolioId)
    .sort(
      (left, right) =>
        Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
        left.id.localeCompare(right.id),
    );
  const cashSources = liveEntities(document, 'cashSource')
    .map((entity): ClientCashSourceRecord => {
      const row = VAULT_ENTITY_ROW_SCHEMAS.cashSource.parse(entity.data);
      return { id: entity.id, portfolioId: row.portfolioId, name: row.name };
    })
    .filter((row) => row.portfolioId === portfolioId);

  return {
    portfolioId,
    ownerUserId,
    assets,
    transactions,
    dividends,
    cashMovements,
    cashSources,
  };
}

export function storedPrices(
  document: VaultDocument,
  assetId: string,
): Array<{ date: string; close: number }> {
  return liveEntities(document, 'customAssetValue')
    .map((entity) => VAULT_ENTITY_ROW_SCHEMAS.customAssetValue.parse(entity.data))
    .filter((row) => row.assetId === assetId)
    .map((row) => ({ date: row.date, close: decimal(row.close, 'custom asset close') }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function parseTransaction(entity: VaultEntity): ClientTransactionRecord {
  const row = VAULT_ENTITY_ROW_SCHEMAS.transaction.parse(entity.data);
  return {
    id: entity.id,
    portfolioId: row.portfolioId,
    assetId: row.assetId,
    side: row.side,
    quantity: decimal(row.quantity, 'transaction quantity'),
    price: decimal(row.price, 'transaction price'),
    fee: decimal(row.fee, 'transaction fee'),
    executedAt: row.executedAt,
    allowUncovered: row.allowUncovered,
    uncoveredEntryPrice:
      row.uncoveredEntryPrice === null
        ? null
        : decimal(row.uncoveredEntryPrice, 'uncovered entry price'),
    taxMode: row.taxMode,
    taxCountry: row.taxCountry,
    taxAmountEur: row.taxAmountEur === null ? null : decimal(row.taxAmountEur, 'transaction tax'),
    taxParams: row.taxParams,
    source: row.source,
  };
}

function parseDividend(entity: VaultEntity): ClientDividendRecord {
  const row = VAULT_ENTITY_ROW_SCHEMAS.dividend.parse(entity.data);
  return {
    id: entity.id,
    portfolioId: row.portfolioId,
    assetId: row.assetId,
    cashSourceId: row.cashSourceId,
    grossAmountEur: decimal(row.grossAmountEur, 'dividend gross amount'),
    executedAt: row.executedAt,
    taxMode: row.taxMode,
    taxCountry: row.taxCountry,
    taxAmountEur: row.taxAmountEur === null ? null : decimal(row.taxAmountEur, 'dividend tax'),
    taxParams: row.taxParams,
    source: row.source,
  };
}

function parseCashMovement(entity: VaultEntity): ClientCashMovementRecord {
  const row = VAULT_ENTITY_ROW_SCHEMAS.cashMovement.parse(entity.data);
  return {
    id: entity.id,
    portfolioId: row.portfolioId,
    sourceId: row.sourceId,
    kind: row.kind,
    amountEur: decimal(row.amountEur, 'cash movement amount'),
    occurredAt: row.executedAt,
    transactionId: row.transactionId,
    taxYear: row.taxYear,
    source: row.source,
  };
}

function decimal(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw moneyFailure('VAULT_CORRUPT', `${label} is outside the supported numeric range.`);
  }
  return parsed;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw moneyFailure('VAULT_CORRUPT', `${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function customCategory(meta: Record<string, unknown> | null): PortfolioAsset['category'] {
  const category = meta?.category;
  return category === 'stock' ||
    category === 'etf' ||
    category === 'crypto' ||
    category === 'commodity' ||
    category === 'cash_like' ||
    category === 'other'
    ? category
    : null;
}
