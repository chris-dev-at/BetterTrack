import { isDeepStrictEqual } from 'node:util';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { VaultStrictEntity } from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  assetIdentities,
  assets,
  cashTags,
  importBatches,
  importRows,
  portfolios,
  priceHistory,
} from '../schema';
import { createParanoidRehydrationSourceRepository } from './paranoidRehydrationRepository';
import { entitiesOf } from './portfolioVaultTransitionRepository';

export class PortfolioVaultRestoreWriteError extends Error {
  constructor(
    readonly code: 'COMMON_FACT_CONFLICT' | 'IMPORT_NOT_HISTORICAL' | 'STUB_LOST',
    message: string,
  ) {
    super(message);
    this.name = 'PortfolioVaultRestoreWriteError';
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  // jsonb canonicalizes object key order, while the unlocked request retains
  // its wire order. Equality here is structural: object order is irrelevant,
  // array order and primitive values remain significant.
  return isDeepStrictEqual(left, right);
}

function sameDecimal(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) return value;
    const whole = (match[2] ?? '0').replace(/^0+(?=\d)/, '');
    const fraction = (match[3] ?? '').replace(/0+$/, '');
    const magnitude = fraction.length > 0 ? `${whole}.${fraction}` : whole;
    return /^0(?:\.0*)?$/.test(magnitude) ? '0' : `${match[1] ?? ''}${magnitude}`;
  };
  return canonical(left) === canonical(right);
}

function commonFactConflict(message: string): never {
  throw new PortfolioVaultRestoreWriteError('COMMON_FACT_CONFLICT', message);
}

/**
 * Recreate the strict, already-validated source graph in dependency order.
 * Account-common rows are validation snapshots: existing rows must agree and
 * missing own-manual assets may be restated through the DB identity-claim guard.
 */
export async function restorePortfolioVaultGraph(input: {
  tx: Database;
  userId: string;
  portfolioId: string;
  vaultId: string;
  entities: readonly VaultStrictEntity[];
  afterCashMovements: () => Promise<void>;
  afterStage?: (stage: PortfolioVaultRestoreStage) => void | Promise<void>;
}): Promise<{ restoredCustomAssetIds: readonly string[] }> {
  const { tx, userId, portfolioId, vaultId, entities } = input;
  const stage = async (name: PortfolioVaultRestoreStage) => input.afterStage?.(name);
  const source = createParanoidRehydrationSourceRepository(tx);

  // Keep the repository fail-closed even if a future caller accidentally skips
  // the shared write-free validator. These checks precede every insert/update:
  // the one portfolio anchor keeps its UUID, catalog assets are re-resolved
  // server-side, and only the owner's manual assets may be restated.
  const portfolioEntities = entitiesOf(entities, 'portfolio');
  const portfolioEntity = portfolioEntities[0];
  if (
    portfolioEntities.length !== 1 ||
    !portfolioEntity ||
    portfolioEntity.id !== portfolioId ||
    portfolioEntity.data.userId !== userId ||
    portfolioEntity.data.vaultId !== null ||
    portfolioEntity.data.vaultAlias !== null ||
    portfolioEntity.data.alias !== null
  ) {
    throw new PortfolioVaultRestoreWriteError(
      'STUB_LOST',
      'The restore graph does not have exactly one matching portfolio anchor.',
    );
  }

  const customAssets = entitiesOf(entities, 'customAsset');
  const customAssetIdsSet = new Set<string>();
  for (const entity of customAssets) {
    if (
      customAssetIdsSet.has(entity.id) ||
      entity.data.ownerId !== userId ||
      entity.data.providerId !== 'manual' ||
      entity.data.providerRef !== entity.id
    ) {
      commonFactConflict('A custom asset is not a unique owner-manual restatement.');
    }
    customAssetIdsSet.add(entity.id);
  }

  const referencedAssetIds = new Set([
    ...entitiesOf(entities, 'transaction').map(({ data }) => data.assetId),
    ...entitiesOf(entities, 'dividend').map(({ data }) => data.assetId),
    ...entitiesOf(entities, 'standingOrder').flatMap(({ data }) =>
      data.assetId === null ? [] : [data.assetId],
    ),
    ...entitiesOf(entities, 'importRow').flatMap(({ data }) =>
      data.assetId === null ? [] : [data.assetId],
    ),
  ]);
  for (const customAssetId of customAssetIdsSet) {
    if (!referencedAssetIds.has(customAssetId)) {
      commonFactConflict('The restore graph contains an unrelated custom asset restatement.');
    }
  }
  for (const value of entitiesOf(entities, 'customAssetValue')) {
    if (!customAssetIdsSet.has(value.data.assetId)) {
      commonFactConflict('A custom-asset value does not belong to a restated manual asset.');
    }
  }

  const referencedAssetCurrencies = new Map(
    customAssets.map(({ id, data }) => [id, data.currency] as const),
  );
  const catalogAssetIds = [...referencedAssetIds].filter((id) => !customAssetIdsSet.has(id));
  if (catalogAssetIds.length > 0) {
    const catalogAssets = await tx
      .select({ id: assets.id, currency: assets.currency })
      .from(assets)
      .where(and(inArray(assets.id, catalogAssetIds), isNull(assets.ownerId)))
      .for('update');
    if (new Set(catalogAssets.map(({ id }) => id)).size !== catalogAssetIds.length) {
      commonFactConflict('A referenced catalog asset is missing or is not server-owned.');
    }
    for (const asset of catalogAssets) referencedAssetCurrencies.set(asset.id, asset.currency);
  }
  for (const order of entitiesOf(entities, 'standingOrder')) {
    if (order.data.kind !== 'buy-asset') {
      if (order.data.currency !== 'EUR') {
        commonFactConflict('A cash standing order must use EUR.');
      }
      continue;
    }
    if (
      order.data.assetId === null ||
      referencedAssetCurrencies.get(order.data.assetId) !== order.data.currency
    ) {
      commonFactConflict('A buy standing-order currency disagrees with its resolved asset.');
    }
  }

  const importBatchEntities = entitiesOf(entities, 'importBatch');
  for (const batch of importBatchEntities) {
    if (batch.data.status !== 'applied') {
      throw new PortfolioVaultRestoreWriteError(
        'IMPORT_NOT_HISTORICAL',
        'Only completed historical import batches may be restored.',
      );
    }
  }

  const customAssetIds = customAssets.map(({ id }) => id);
  const retainedIdentityClaims =
    customAssetIds.length === 0
      ? []
      : await tx
          .select({ id: assetIdentities.id, ownerId: assetIdentities.ownerId })
          .from(assetIdentities)
          .where(inArray(assetIdentities.id, customAssetIds))
          .for('update');
  if (retainedIdentityClaims.some(({ ownerId }) => ownerId !== userId)) {
    commonFactConflict('A retained custom-asset identity is claimed by another account.');
  }
  const existingAssets =
    customAssetIds.length === 0
      ? []
      : await tx.select().from(assets).where(inArray(assets.id, customAssetIds)).for('update');
  const existingById = new Map(existingAssets.map((asset) => [asset.id, asset]));
  for (const entity of customAssets) {
    const existing = existingById.get(entity.id);
    if (!existing) continue;
    const data = entity.data;
    if (
      existing.ownerId !== userId ||
      data.ownerId !== userId ||
      existing.providerId !== 'manual' ||
      existing.providerRef !== entity.id ||
      data.providerId !== 'manual' ||
      data.providerRef !== entity.id ||
      existing.type !== data.type ||
      existing.symbol !== data.symbol ||
      existing.name !== data.name ||
      existing.exchange !== data.exchange ||
      existing.currency !== data.currency ||
      !sameJson(existing.meta, data.meta)
    ) {
      throw new PortfolioVaultRestoreWriteError(
        'COMMON_FACT_CONFLICT',
        'An existing custom asset disagrees with the unlocked vault snapshot.',
      );
    }
  }
  const restoredCustomAssets = customAssets.filter((entity) => !existingById.has(entity.id));
  await source.restoreCustomAssets(restoredCustomAssets);

  const customValues = entitiesOf(entities, 'customAssetValue');
  for (const value of customValues) {
    const [existing] = await tx
      .select({ close: priceHistory.close })
      .from(priceHistory)
      .where(
        and(eq(priceHistory.assetId, value.data.assetId), eq(priceHistory.date, value.data.date)),
      )
      .for('update');
    if (existing && !sameDecimal(existing.close, value.data.close)) {
      throw new PortfolioVaultRestoreWriteError(
        'COMMON_FACT_CONFLICT',
        'An existing custom-asset value disagrees with the unlocked vault snapshot.',
      );
    }
    if (!existing) await source.restoreCustomAssetValues([value]);
  }

  const cashTagSnapshots = entitiesOf(entities, 'cashTag');
  const tagIds = cashTagSnapshots.map(({ id }) => id);
  const existingTags =
    tagIds.length === 0
      ? []
      : await tx.select().from(cashTags).where(inArray(cashTags.id, tagIds)).for('update');
  const tagsById = new Map(existingTags.map((tag) => [tag.id, tag]));
  for (const entity of cashTagSnapshots) {
    const tag = tagsById.get(entity.id);
    if (
      !tag ||
      tag.userId !== userId ||
      entity.data.userId !== userId ||
      tag.name !== entity.data.name ||
      tag.color !== entity.data.color ||
      tag.system !== entity.data.system ||
      tag.systemKey !== entity.data.systemKey ||
      tag.createdAt.getTime() !== new Date(entity.data.createdAt).getTime() ||
      tag.updatedAt.getTime() !== new Date(entity.data.updatedAt).getTime()
    ) {
      throw new PortfolioVaultRestoreWriteError(
        'COMMON_FACT_CONFLICT',
        'A cash-tag snapshot is missing or disagrees with the server common rows.',
      );
    }
  }
  await stage('commonFacts');

  const [updatedStub] = await tx
    .update(portfolios)
    .set({
      name: portfolioEntity.data.name,
      visibility: portfolioEntity.data.visibility,
      sortOrder: portfolioEntity.data.sortOrder,
      defaultPayFromCash: portfolioEntity.data.defaultPayFromCash,
      archivedAt: portfolioEntity.data.archivedAt
        ? new Date(portfolioEntity.data.archivedAt)
        : null,
      kind: portfolioEntity.data.kind ?? null,
      // Keep membership set until every child row, ciphertext archive and receipt
      // succeeds. The E2 kill matrix therefore turns off only at final commit.
      vaultId,
    })
    .where(
      and(
        eq(portfolios.id, portfolioId),
        eq(portfolios.userId, userId),
        eq(portfolios.vaultId, vaultId),
      ),
    )
    .returning({ id: portfolios.id });
  if (!updatedStub) {
    throw new PortfolioVaultRestoreWriteError('STUB_LOST', 'The locked portfolio stub changed.');
  }
  await stage('portfolio');

  await source.restoreCashSources(entitiesOf(entities, 'cashSource'));
  await source.restorePortfolioSettings(entitiesOf(entities, 'portfolioSetting'));
  await stage('portfolioDependencies');

  await source.restoreTransactions(entitiesOf(entities, 'transaction'));
  await source.restoreDividends(entitiesOf(entities, 'dividend'));
  await source.restoreCashMovements(entitiesOf(entities, 'cashMovement'));
  await input.afterCashMovements();
  await stage('ledger');

  await source.restoreStandingOrders(entitiesOf(entities, 'standingOrder'));
  await source.restoreStandingOrderRuns(entitiesOf(entities, 'standingOrderRun'));

  if (importBatchEntities.length > 0) {
    await tx.insert(importBatches).values(
      importBatchEntities.map((entity) => ({
        id: entity.id,
        ownerId: entity.data.ownerId,
        portfolioId: entity.data.portfolioId,
        brokerId: entity.data.brokerId,
        filename: entity.data.filename,
        status: entity.data.status,
        cashSourceId: entity.data.cashSourceId,
        createdAt: new Date(entity.data.createdAt),
        appliedAt: entity.data.appliedAt ? new Date(entity.data.appliedAt) : null,
      })),
    );
  }
  const importRowEntities = entitiesOf(entities, 'importRow');
  if (importRowEntities.length > 0) {
    await tx.insert(importRows).values(
      importRowEntities.map((entity) => ({
        id: entity.id,
        batchId: entity.data.batchId,
        rowIndex: entity.data.rowIndex,
        raw: entity.data.raw,
        kind: entity.data.kind,
        flag: entity.data.flag,
        message: entity.data.message,
        executedAt: entity.data.executedAt ? new Date(entity.data.executedAt) : null,
        isin: entity.data.isin,
        symbol: entity.data.symbol,
        name: entity.data.name,
        quantity: entity.data.quantity,
        price: entity.data.price,
        fee: entity.data.fee,
        amountEur: entity.data.amountEur,
        currency: entity.data.currency,
        note: entity.data.note,
        assetId: entity.data.assetId,
        contentHash: entity.data.contentHash,
        result: entity.data.result,
        resultMessage: entity.data.resultMessage,
      })),
    );
  }
  await stage('standingOrdersAndImports');

  await source.restoreCashBudgets(entitiesOf(entities, 'cashBudget'));
  await source.restoreCashMovementTags(entitiesOf(entities, 'cashMovementTag'));
  await stage('classification');
  // Every restated manual identity participates in derived-state convergence,
  // not only newly inserted `assets` rows. An already-existing sibling-shared
  // asset may gain a missing price point above, which reshapes every holder's
  // snapshot and must therefore survive a worker recovery in the durable plan.
  return { restoredCustomAssetIds: [...customAssetIdsSet].sort() };
}

export type PortfolioVaultRestoreStage =
  | 'commonFacts'
  | 'portfolio'
  | 'portfolioDependencies'
  | 'ledger'
  | 'standingOrdersAndImports'
  | 'classification';
