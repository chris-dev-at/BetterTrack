import type { VaultStrictDocumentV1 } from '@bettertrack/contracts';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '../db';

import {
  assets,
  dividends,
  expenseBudgets,
  expenseCategories,
  expenseRules,
  expenseTransactions,
  portfolioCashMovements,
  portfolioCashSources,
  portfolios,
  portfolioSettings,
  priceHistory,
  standingOrderRuns,
  standingOrders,
  transactions,
  userTaxSettings,
} from '../schema';

/**
 * Transaction-bound source-row primitives for paranoid disable rehydration. This
 * is deliberately not a public write repository: callers receive an executor
 * only from the dedicated rehydration transaction, so no method can commit a
 * partial document or emit the normal write-path's effects before the batch does.
 */

type Entity = VaultStrictDocumentV1['entities'][number];
type EntityOf<K extends Entity['kind']> = Extract<Entity, { kind: K }>;

export interface ParanoidRehydrationReferencedAsset {
  id: string;
  currency: string;
}

export interface ParanoidRehydrationExistingCustomAsset {
  id: string;
  ownerId: string | null;
  providerId: string;
}

export interface ParanoidRehydrationSourceRepository {
  findReferencedGlobalAssets(
    assetIds: readonly string[],
  ): Promise<readonly ParanoidRehydrationReferencedAsset[]>;
  findExistingCustomAssets(
    assetIds: readonly string[],
  ): Promise<readonly ParanoidRehydrationExistingCustomAsset[]>;
  hasExistingRestorableRows(userId: string): Promise<boolean>;
  restoreCustomAssets(rows: readonly EntityOf<'customAsset'>[]): Promise<void>;
  restoreCustomAssetValues(rows: readonly EntityOf<'customAssetValue'>[]): Promise<void>;
  restorePortfolios(rows: readonly EntityOf<'portfolio'>[]): Promise<void>;
  restoreCashSources(rows: readonly EntityOf<'cashSource'>[]): Promise<void>;
  restoreTaxSettings(row: EntityOf<'taxSetting'> | undefined): Promise<void>;
  restorePortfolioSettings(rows: readonly EntityOf<'portfolioSetting'>[]): Promise<void>;
  restoreTransactions(rows: readonly EntityOf<'transaction'>[]): Promise<void>;
  restoreDividends(rows: readonly EntityOf<'dividend'>[]): Promise<void>;
  restoreCashMovements(rows: readonly EntityOf<'cashMovement'>[]): Promise<void>;
  restoreStandingOrders(rows: readonly EntityOf<'standingOrder'>[]): Promise<void>;
  restoreStandingOrderRuns(rows: readonly EntityOf<'standingOrderRun'>[]): Promise<void>;
  restoreExpenseCategories(rows: readonly EntityOf<'expenseCategory'>[]): Promise<void>;
  restoreExpenseTransactions(rows: readonly EntityOf<'expenseTransaction'>[]): Promise<void>;
  restoreExpenseRules(rows: readonly EntityOf<'expenseRule'>[]): Promise<void>;
  restoreExpenseBudgets(rows: readonly EntityOf<'expenseBudget'>[]): Promise<void>;
}

const REHYDRATION_INSERT_CHUNK_SIZE = 1_000;

async function forEachChunk<T>(
  rows: readonly T[],
  insert: (chunk: readonly T[]) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += REHYDRATION_INSERT_CHUNK_SIZE) {
    await insert(rows.slice(offset, offset + REHYDRATION_INSERT_CHUNK_SIZE));
  }
}

export function createParanoidRehydrationSourceRepository(
  tx: Database,
): ParanoidRehydrationSourceRepository {
  return {
    async findReferencedGlobalAssets(assetIds) {
      if (!assetIds.length) return [];
      const found: ParanoidRehydrationReferencedAsset[] = [];
      await forEachChunk(assetIds, async (chunk) => {
        found.push(
          ...(await tx
            .select({ id: assets.id, currency: assets.currency })
            .from(assets)
            .where(and(inArray(assets.id, [...chunk]), isNull(assets.ownerId)))),
        );
      });
      return found;
    },

    async findExistingCustomAssets(assetIds) {
      if (!assetIds.length) return [];
      const found: ParanoidRehydrationExistingCustomAsset[] = [];
      await forEachChunk(assetIds, async (chunk) => {
        found.push(
          ...(await tx
            .select({ id: assets.id, ownerId: assets.ownerId, providerId: assets.providerId })
            .from(assets)
            .where(inArray(assets.id, [...chunk]))),
        );
      });
      return found;
    },

    async hasExistingRestorableRows(userId) {
      const present = await Promise.all([
        tx
          .select({ id: assets.id })
          .from(assets)
          .where(and(eq(assets.ownerId, userId), eq(assets.providerId, 'manual')))
          .limit(1),
        tx
          .select({ id: portfolios.id })
          .from(portfolios)
          .where(eq(portfolios.userId, userId))
          .limit(1),
        tx
          .select({ id: expenseCategories.id })
          .from(expenseCategories)
          .where(eq(expenseCategories.userId, userId))
          .limit(1),
        tx
          .select({ id: expenseTransactions.id })
          .from(expenseTransactions)
          .where(eq(expenseTransactions.userId, userId))
          .limit(1),
        tx
          .select({ id: standingOrders.id })
          .from(standingOrders)
          .where(eq(standingOrders.userId, userId))
          .limit(1),
        tx
          .select({ userId: userTaxSettings.userId })
          .from(userTaxSettings)
          .where(eq(userTaxSettings.userId, userId))
          .limit(1),
      ]);
      return present.some((records) => records.length > 0);
    },

    async restoreCustomAssets(rows) {
      for (const entity of rows) {
        const ownerId = entity.data.ownerId;
        if (ownerId === null) {
          throw new Error(`custom asset ${entity.id} is missing its owner`);
        }
        await tx.insert(assets).values({
          id: entity.id,
          ownerId,
          providerId: entity.data.providerId,
          providerRef: entity.data.providerRef,
          type: entity.data.type,
          symbol: entity.data.symbol,
          name: entity.data.name,
          exchange: entity.data.exchange,
          currency: entity.data.currency,
          meta: entity.data.meta,
          // `search_text` is GENERATED ALWAYS from symbol + name. PostgreSQL
          // reproduces the carried value; generated columns cannot be inserted.
        });
      }
    },

    async restoreCustomAssetValues(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(priceHistory).values(
          chunk.map((entity) => ({
            assetId: entity.data.assetId,
            date: entity.data.date,
            close: entity.data.close,
          })),
        );
      });
    },

    async restorePortfolios(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(portfolios).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            name: entity.data.name,
            visibility: entity.data.visibility,
            sortOrder: entity.data.sortOrder,
            defaultPayFromCash: entity.data.defaultPayFromCash,
            archivedAt: entity.data.archivedAt ? new Date(entity.data.archivedAt) : null,
          })),
        );
      });
    },

    async restoreCashSources(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(portfolioCashSources).values(
          chunk.map((entity) => ({
            id: entity.id,
            portfolioId: entity.data.portfolioId,
            name: entity.data.name,
            type: entity.data.type,
            isMain: entity.data.isMain,
            archivedAt: entity.data.archivedAt ? new Date(entity.data.archivedAt) : null,
            createdAt: new Date(entity.data.createdAt),
          })),
        );
      });
    },

    async restoreTaxSettings(row) {
      if (!row) return;
      await tx.insert(userTaxSettings).values({
        userId: row.data.userId,
        mode: row.data.mode,
        country: row.data.country,
        manualDefaultAmountEur: row.data.manualDefaultAmountEur,
        manualDefaultRatePct: row.data.manualDefaultRatePct,
        customParams: row.data.customParams,
        updatedAt: new Date(row.data.updatedAt),
      });
    },

    async restorePortfolioSettings(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(portfolioSettings).values(
          chunk.map((entity) => ({
            portfolioId: entity.data.portfolioId,
            key: entity.data.key,
            value: entity.data.value,
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreTransactions(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(transactions).values(
          chunk.map((entity) => ({
            id: entity.id,
            portfolioId: entity.data.portfolioId,
            assetId: entity.data.assetId,
            side: entity.data.side,
            quantity: entity.data.quantity,
            price: entity.data.price,
            fee: entity.data.fee,
            executedAt: new Date(entity.data.executedAt),
            note: entity.data.note,
            taxMode: entity.data.taxMode,
            taxCountry: entity.data.taxCountry,
            taxAmountEur: entity.data.taxAmountEur,
            taxParams: entity.data.taxParams,
            allowUncovered: entity.data.allowUncovered,
            uncoveredEntryPrice: entity.data.uncoveredEntryPrice,
            source: entity.data.source,
          })),
        );
      });
    },

    async restoreDividends(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(dividends).values(
          chunk.map((entity) => ({
            id: entity.id,
            portfolioId: entity.data.portfolioId,
            assetId: entity.data.assetId,
            cashSourceId: entity.data.cashSourceId,
            grossAmountEur: entity.data.grossAmountEur,
            executedAt: new Date(entity.data.executedAt),
            note: entity.data.note,
            taxMode: entity.data.taxMode,
            taxCountry: entity.data.taxCountry,
            taxAmountEur: entity.data.taxAmountEur,
            taxParams: entity.data.taxParams,
            source: entity.data.source,
            createdAt: new Date(entity.data.createdAt),
          })),
        );
      });
    },

    async restoreCashMovements(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(portfolioCashMovements).values(
          chunk.map((entity) => ({
            id: entity.id,
            portfolioId: entity.data.portfolioId,
            sourceId: entity.data.sourceId,
            kind: entity.data.kind,
            amountEur: entity.data.amountEur,
            transactionId: entity.data.transactionId,
            transferId: entity.data.transferId,
            counterpartSourceId: entity.data.counterpartSourceId,
            dividendId: entity.data.dividendId,
            taxYear: entity.data.taxYear,
            executedAt: new Date(entity.data.executedAt),
            note: entity.data.note,
            source: entity.data.source,
            createdAt: new Date(entity.data.createdAt),
          })),
        );
      });
    },

    async restoreStandingOrders(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(standingOrders).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            portfolioId: entity.data.portfolioId,
            kind: entity.data.kind,
            assetId: entity.data.assetId,
            amount: entity.data.amount,
            currency: entity.data.currency,
            label: entity.data.label,
            cadence: entity.data.cadence,
            anchorDay: entity.data.anchorDay,
            startDate: entity.data.startDate,
            endDate: entity.data.endDate,
            status: entity.data.status,
            // The separately restored run rows are the authoritative no-replay
            // fence; these displays retain the highest known booking as a fast path.
            lastRunAt: entity.data.lastRunAt ? new Date(entity.data.lastRunAt) : null,
            lastPeriodKey: entity.data.lastPeriodKey,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreStandingOrderRuns(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(standingOrderRuns).values(
          chunk.map((entity) => ({
            id: entity.id,
            standingOrderId: entity.data.standingOrderId,
            periodKey: entity.data.periodKey,
            bookedAt: new Date(entity.data.bookedAt),
          })),
        );
      });
    },

    async restoreExpenseCategories(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(expenseCategories).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            name: entity.data.name,
            direction: entity.data.direction,
            color: entity.data.color,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreExpenseTransactions(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(expenseTransactions).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            categoryId: entity.data.categoryId,
            direction: entity.data.direction,
            amount: entity.data.amount,
            currency: entity.data.currency,
            bookedOn: entity.data.bookedOn,
            description: entity.data.description,
            source: entity.data.source,
            dedupHash: entity.data.dedupHash,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreExpenseRules(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(expenseRules).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            categoryId: entity.data.categoryId,
            matchType: entity.data.matchType,
            pattern: entity.data.pattern,
            priority: entity.data.priority,
            enabled: entity.data.enabled,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreExpenseBudgets(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(expenseBudgets).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            categoryId: entity.data.categoryId,
            amount: entity.data.amount,
            currency: entity.data.currency,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },
  };
}
