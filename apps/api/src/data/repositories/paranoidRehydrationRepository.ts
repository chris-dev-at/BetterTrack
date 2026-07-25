import type { VaultDocumentV1 } from '@bettertrack/contracts';

import type { Database } from '../db';
import { expenseDedupHash } from '../expenseDedup';

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

type Entity = VaultDocumentV1['entities'][number];
type EntityOf<K extends Entity['kind']> = Extract<Entity, { kind: K }>;

export interface ParanoidRehydrationSourceRepository {
  restoreCustomAssets(userId: string, rows: readonly EntityOf<'customAsset'>[]): Promise<void>;
  restoreCustomAssetValues(rows: readonly EntityOf<'customAssetValue'>[]): Promise<void>;
  restorePortfolios(userId: string, rows: readonly EntityOf<'portfolio'>[]): Promise<void>;
  restoreCashSources(rows: readonly EntityOf<'cashSource'>[]): Promise<void>;
  restoreTaxSettings(userId: string, row: EntityOf<'taxSetting'> | undefined): Promise<void>;
  restorePortfolioSettings(rows: readonly EntityOf<'portfolioSetting'>[]): Promise<void>;
  restoreTransactions(rows: readonly EntityOf<'transaction'>[]): Promise<void>;
  restoreDividends(rows: readonly EntityOf<'dividend'>[]): Promise<void>;
  restoreCashMovements(rows: readonly EntityOf<'cashMovement'>[]): Promise<void>;
  restoreStandingOrders(userId: string, rows: readonly EntityOf<'standingOrder'>[]): Promise<void>;
  restoreStandingOrderRuns(rows: readonly EntityOf<'standingOrder'>[]): Promise<void>;
  restoreExpenseCategories(
    userId: string,
    rows: readonly EntityOf<'expenseCategory'>[],
  ): Promise<void>;
  restoreExpenseTransactions(
    userId: string,
    rows: readonly EntityOf<'expenseTransaction'>[],
  ): Promise<void>;
  restoreExpenseRules(userId: string, rows: readonly EntityOf<'expenseRule'>[]): Promise<void>;
  restoreExpenseBudgets(userId: string, rows: readonly EntityOf<'expenseBudget'>[]): Promise<void>;
}

export function createParanoidRehydrationSourceRepository(
  tx: Database,
): ParanoidRehydrationSourceRepository {
  return {
    async restoreCustomAssets(userId, rows) {
      if (!rows.length) return;
      await tx.insert(assets).values(
        rows.map((entity) => ({
          id: entity.id,
          ownerId: userId,
          providerId: entity.data.providerId,
          // Manual-provider lookup is globally keyed by this ref. Keep the
          // normal custom-asset invariant even if a future caller bypasses
          // restore-graph validation.
          providerRef: entity.id,
          type: entity.data.type,
          symbol: entity.data.symbol,
          name: entity.data.name,
          exchange: entity.data.exchange,
          currency: entity.data.currency,
          meta: {
            category: entity.data.category,
            smoothing: entity.data.smoothing,
            ...(entity.data.recategorize ? { recategorize: true } : {}),
          },
        })),
      );
    },

    async restoreCustomAssetValues(rows) {
      if (!rows.length) return;
      await tx.insert(priceHistory).values(
        rows.map((entity) => ({
          assetId: entity.data.assetId,
          date: entity.data.date,
          close: String(entity.data.close),
        })),
      );
    },

    async restorePortfolios(userId, rows) {
      if (!rows.length) return;
      await tx.insert(portfolios).values(
        rows.map((entity) => ({
          id: entity.id,
          userId,
          name: entity.data.name,
          visibility: entity.data.visibility,
          sortOrder: entity.data.sortOrder,
          defaultPayFromCash: entity.data.defaultPayFromCash,
          archivedAt: entity.data.archivedAt ? new Date(entity.data.archivedAt) : null,
        })),
      );
    },

    async restoreCashSources(rows) {
      if (!rows.length) return;
      await tx.insert(portfolioCashSources).values(
        rows.map((entity) => ({
          id: entity.id,
          portfolioId: entity.data.portfolioId,
          name: entity.data.name,
          type: entity.data.type,
          isMain: entity.data.isMain,
          archivedAt: entity.data.archivedAt ? new Date(entity.data.archivedAt) : null,
          createdAt: new Date(entity.data.createdAt),
        })),
      );
    },

    async restoreTaxSettings(userId, row) {
      if (!row) return;
      await tx.insert(userTaxSettings).values({
        userId,
        mode: row.data.mode,
        country: row.data.country,
        manualDefaultAmountEur:
          row.data.manualDefaultAmountEur === null ? null : String(row.data.manualDefaultAmountEur),
        manualDefaultRatePct:
          row.data.manualDefaultRatePct === null ? null : String(row.data.manualDefaultRatePct),
        customParams: row.data.customParams,
        updatedAt: new Date(row.data.updatedAt),
      });
    },

    async restorePortfolioSettings(rows) {
      if (!rows.length) return;
      await tx.insert(portfolioSettings).values(
        rows.map((entity) => ({
          portfolioId: entity.data.portfolioId,
          key: entity.data.key,
          value: entity.data.value,
          updatedAt: new Date(entity.data.updatedAt),
        })),
      );
    },

    async restoreTransactions(rows) {
      if (!rows.length) return;
      await tx.insert(transactions).values(
        rows.map((entity) => ({
          id: entity.id,
          portfolioId: entity.data.portfolioId,
          assetId: entity.data.assetId,
          side: entity.data.side,
          quantity: String(entity.data.quantity),
          price: String(entity.data.price),
          fee: String(entity.data.fee),
          executedAt: new Date(entity.data.executedAt),
          note: entity.data.note,
          taxMode: entity.data.taxMode,
          taxCountry: entity.data.taxCountry,
          taxAmountEur: entity.data.taxAmountEur === null ? null : String(entity.data.taxAmountEur),
          taxParams: entity.data.taxParams,
          allowUncovered: entity.data.allowUncovered,
          uncoveredEntryPrice:
            entity.data.uncoveredEntryPrice === null
              ? null
              : String(entity.data.uncoveredEntryPrice),
          source: entity.data.source,
        })),
      );
    },

    async restoreDividends(rows) {
      if (!rows.length) return;
      await tx.insert(dividends).values(
        rows.map((entity) => ({
          id: entity.id,
          portfolioId: entity.data.portfolioId,
          assetId: entity.data.assetId,
          cashSourceId: entity.data.cashSourceId,
          grossAmountEur: String(entity.data.grossAmountEur),
          executedAt: new Date(entity.data.executedAt),
          note: entity.data.note,
          taxMode: entity.data.taxMode,
          taxCountry: entity.data.taxCountry,
          taxAmountEur: entity.data.taxAmountEur === null ? null : String(entity.data.taxAmountEur),
          taxParams: entity.data.taxParams,
          source: entity.data.source,
          createdAt: new Date(entity.editedAt),
        })),
      );
    },

    async restoreCashMovements(rows) {
      if (!rows.length) return;
      await tx.insert(portfolioCashMovements).values(
        rows.map((entity) => ({
          id: entity.id,
          portfolioId: entity.data.portfolioId,
          sourceId: entity.data.sourceId,
          kind: entity.data.kind,
          amountEur: String(entity.data.amountEur),
          transactionId: entity.data.transactionId,
          transferId: entity.data.transferId,
          counterpartSourceId: entity.data.counterpartSourceId,
          dividendId: entity.data.dividendId,
          taxYear: entity.data.taxYear,
          executedAt: new Date(entity.data.executedAt),
          note: entity.data.note,
          source: entity.data.source,
          createdAt: new Date(entity.editedAt),
        })),
      );
    },

    async restoreStandingOrders(userId, rows) {
      if (!rows.length) return;
      await tx.insert(standingOrders).values(
        rows.map((entity) => ({
          id: entity.id,
          userId,
          portfolioId: entity.data.portfolioId,
          kind: entity.data.kind,
          assetId: entity.data.assetId,
          amount: String(entity.data.amount),
          currency: entity.data.currency,
          label: entity.data.label,
          cadence: entity.data.cadence,
          anchorDay: entity.data.anchorDay,
          startDate: entity.data.startDate,
          endDate: entity.data.endDate,
          status: entity.data.status,
          // Reconstructed runs below are the authoritative no-replay fence; these
          // displays retain the highest known historical execution as a fast path.
          lastRunAt: entity.data.lastRunAt ? new Date(entity.data.lastRunAt) : null,
          lastPeriodKey: entity.data.lastPeriodKey,
          createdAt: new Date(entity.data.createdAt),
          updatedAt: new Date(entity.data.updatedAt),
        })),
      );
    },

    async restoreStandingOrderRuns(rows) {
      const runs = rows
        .filter((entity) => entity.data.lastPeriodKey !== null)
        .map((entity) => ({
          standingOrderId: entity.id,
          periodKey: entity.data.lastPeriodKey!,
          bookedAt: entity.data.lastRunAt
            ? new Date(entity.data.lastRunAt)
            : new Date(entity.editedAt),
        }));
      if (runs.length > 0) await tx.insert(standingOrderRuns).values(runs);
    },

    async restoreExpenseCategories(userId, rows) {
      if (!rows.length) return;
      await tx.insert(expenseCategories).values(
        rows.map((entity) => ({
          id: entity.id,
          userId,
          name: entity.data.name,
          direction: entity.data.direction,
          color: entity.data.color,
          createdAt: new Date(entity.data.createdAt),
          updatedAt: new Date(entity.data.updatedAt),
        })),
      );
    },

    async restoreExpenseTransactions(userId, rows) {
      if (!rows.length) return;
      await tx.insert(expenseTransactions).values(
        rows.map((entity) => ({
          id: entity.id,
          userId,
          categoryId: entity.data.categoryId,
          direction: entity.data.direction,
          amount: String(entity.data.amount),
          currency: entity.data.currency,
          bookedOn: entity.data.bookedOn,
          description: entity.data.description,
          source: entity.data.source,
          dedupHash: entity.data.source.startsWith('import:')
            ? expenseDedupHash(entity.data)
            : null,
          createdAt: new Date(entity.data.createdAt),
          updatedAt: new Date(entity.data.updatedAt),
        })),
      );
    },

    async restoreExpenseRules(userId, rows) {
      if (!rows.length) return;
      await tx.insert(expenseRules).values(
        rows.map((entity) => ({
          id: entity.id,
          userId,
          categoryId: entity.data.categoryId,
          matchType: entity.data.matchType,
          pattern: entity.data.pattern,
          priority: entity.data.priority,
          enabled: entity.data.enabled,
          createdAt: new Date(entity.data.createdAt),
          updatedAt: new Date(entity.data.updatedAt),
        })),
      );
    },

    async restoreExpenseBudgets(userId, rows) {
      if (!rows.length) return;
      await tx.insert(expenseBudgets).values(
        rows.map((entity) => ({
          id: entity.id,
          userId,
          categoryId: entity.data.categoryId,
          amount: String(entity.data.amount),
          currency: entity.data.currency,
          createdAt: new Date(entity.data.createdAt),
          updatedAt: new Date(entity.data.updatedAt),
        })),
      );
    },
  };
}
