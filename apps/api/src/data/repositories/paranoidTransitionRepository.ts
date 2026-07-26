import { and, count, eq, inArray, or } from 'drizzle-orm';

import { VAULT_FORMAT_VERSION, type VaultMediaSet } from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  assets,
  conglomerates,
  dividends,
  expenseBudgetFires,
  expenseBudgets,
  expenseCategories,
  expenseRules,
  expenseTransactions,
  exportJobs,
  friendGroupMembers,
  ideas,
  importBatches,
  importRows,
  itemComments,
  itemFollows,
  itemReactions,
  mirrorChainMembers,
  paranoidRehydrationReceipts,
  paranoidVaultHistory,
  paranoidVaults,
  portfolioCashMovements,
  portfolioCashSources,
  portfolioDailySnapshots,
  portfolios,
  portfolioSettings,
  portfolioSnapshotState,
  priceHistory,
  shareAudienceMembers,
  shareAudiences,
  shareLinks,
  sharedItemActivityPrefs,
  standingOrderRuns,
  standingOrders,
  transactions,
  userFollows,
  users,
  userTaxSettings,
  watchlists,
} from '../schema';
import { PARANOID_VAULT_TABLE_NAMES } from '../../services/export/manifest';

export interface LockedParanoidTransitionState {
  privacyMode: 'normal' | 'paranoid';
  mediaSet: VaultMediaSet | null;
  driveAttestedVersion: number | null;
  currentServerVault: {
    version: number;
    formatVersion: number;
    sizeBytes: number;
    updatedAt: Date;
  } | null;
  activeMirrorchain: boolean;
  pendingImport: boolean;
  pendingExport: boolean;
}

export interface ParanoidAdminMetadata {
  privacyMode: 'normal' | 'paranoid';
  mediaSet: VaultMediaSet | null;
  vault: {
    version: number;
    sizeBytes: number;
    updatedAt: Date;
  } | null;
  historyCount: number;
}

export interface ParanoidTransitionTransactionRepository {
  lockState(userId: string): Promise<LockedParanoidTransitionState | null>;
  revokeSharing(userId: string): Promise<void>;
  purgeVaultRows(userId: string): Promise<void>;
  completeEnable(input: {
    userId: string;
    mediaSet: VaultMediaSet;
    driveAttestedVersion: number | null;
    keepServerCiphertext: boolean;
    completedAt: Date;
  }): Promise<void>;
}

type PurgeHandler = (scope: PurgeScope) => PromiseLike<unknown> | Promise<void>;
type ProbeHandler = (scope: PurgeScope) => Promise<number>;

interface PurgeScope {
  userId: string;
  portfolioIds: string[];
  customAssetIds: string[];
  standingOrderIds: string[];
  importBatchIds: string[];
  expenseBudgetIds: string[];
}

const ifIds = async (ids: readonly string[], run: (ids: string[]) => Promise<unknown>) => {
  if (ids.length > 0) await run([...ids]);
};
const probeIds = async (
  ids: readonly string[],
  run: (ids: string[]) => PromiseLike<Array<{ value: number }>>,
): Promise<number> => {
  if (ids.length === 0) return 0;
  const [row] = await run([...ids]);
  return Number(row?.value ?? 0);
};
const probe = async (query: PromiseLike<Array<{ value: number }>>): Promise<number> => {
  const [row] = await query;
  return Number(row?.value ?? 0);
};

/**
 * One executable purge branch for every table on the binding vault axis. The
 * runtime completeness check below deliberately compares this map with the
 * manifest before a destructive transition can start.
 */
const PURGE_HANDLERS: Record<string, PurgeHandler> = {
  assets: ({ customAssetIds, ...scope }) =>
    ifIds(customAssetIds, (ids) =>
      scope.tx.delete(assets).where(and(eq(assets.ownerId, scope.userId), inArray(assets.id, ids))),
    ),
  dividends: ({ portfolioIds, tx }) =>
    ifIds(portfolioIds, (ids) => tx.delete(dividends).where(inArray(dividends.portfolioId, ids))),
  expense_budget_fires: ({ expenseBudgetIds, tx }) =>
    ifIds(expenseBudgetIds, (ids) =>
      tx.delete(expenseBudgetFires).where(inArray(expenseBudgetFires.budgetId, ids)),
    ),
  expense_budgets: ({ userId, tx }) =>
    tx.delete(expenseBudgets).where(eq(expenseBudgets.userId, userId)),
  expense_categories: ({ userId, tx }) =>
    tx.delete(expenseCategories).where(eq(expenseCategories.userId, userId)),
  expense_rules: ({ userId, tx }) => tx.delete(expenseRules).where(eq(expenseRules.userId, userId)),
  expense_transactions: ({ userId, tx }) =>
    tx.delete(expenseTransactions).where(eq(expenseTransactions.userId, userId)),
  import_batches: ({ userId, tx }) =>
    tx.delete(importBatches).where(eq(importBatches.ownerId, userId)),
  import_rows: ({ importBatchIds, tx }) =>
    ifIds(importBatchIds, (ids) => tx.delete(importRows).where(inArray(importRows.batchId, ids))),
  portfolio_cash_movements: ({ portfolioIds, tx }) =>
    ifIds(portfolioIds, (ids) =>
      tx.delete(portfolioCashMovements).where(inArray(portfolioCashMovements.portfolioId, ids)),
    ),
  portfolio_cash_sources: ({ portfolioIds, tx }) =>
    ifIds(portfolioIds, (ids) =>
      tx.delete(portfolioCashSources).where(inArray(portfolioCashSources.portfolioId, ids)),
    ),
  portfolio_daily_snapshots: ({ portfolioIds, tx }) =>
    ifIds(portfolioIds, (ids) =>
      tx.delete(portfolioDailySnapshots).where(inArray(portfolioDailySnapshots.portfolioId, ids)),
    ),
  portfolio_settings: ({ portfolioIds, tx }) =>
    ifIds(portfolioIds, (ids) =>
      tx.delete(portfolioSettings).where(inArray(portfolioSettings.portfolioId, ids)),
    ),
  portfolio_snapshot_state: ({ portfolioIds, tx }) =>
    ifIds(portfolioIds, (ids) =>
      tx.delete(portfolioSnapshotState).where(inArray(portfolioSnapshotState.portfolioId, ids)),
    ),
  portfolios: ({ userId, tx }) => tx.delete(portfolios).where(eq(portfolios.userId, userId)),
  price_history: ({ customAssetIds, tx }) =>
    ifIds(customAssetIds, (ids) =>
      tx.delete(priceHistory).where(inArray(priceHistory.assetId, ids)),
    ),
  standing_order_runs: ({ standingOrderIds, tx }) =>
    ifIds(standingOrderIds, (ids) =>
      tx.delete(standingOrderRuns).where(inArray(standingOrderRuns.standingOrderId, ids)),
    ),
  standing_orders: ({ userId, tx }) =>
    tx.delete(standingOrders).where(eq(standingOrders.userId, userId)),
  transactions: ({ portfolioIds, tx }) =>
    ifIds(portfolioIds, (ids) =>
      tx.delete(transactions).where(inArray(transactions.portfolioId, ids)),
    ),
  user_tax_settings: ({ userId, tx }) =>
    tx.delete(userTaxSettings).where(eq(userTaxSettings.userId, userId)),
};

/**
 * Dependency-safe destructive order. Its membership is checked against the
 * classification at runtime; the ordering alone is hand-authored because leaf
 * rows must disappear before portfolios/custom assets they reference.
 */
const PARANOID_PURGE_ORDER = [
  'expense_budget_fires',
  'standing_order_runs',
  'import_rows',
  'portfolio_daily_snapshots',
  'portfolio_snapshot_state',
  'dividends',
  'portfolio_cash_movements',
  'transactions',
  'portfolio_cash_sources',
  'portfolio_settings',
  'standing_orders',
  'expense_budgets',
  'expense_rules',
  'expense_transactions',
  'expense_categories',
  'import_batches',
  'portfolios',
  'price_history',
  'assets',
  'user_tax_settings',
] as const;

/**
 * The post-purge zero-cleartext probe has one scope-aware query per classified
 * table. It runs in the enable transaction, using the ids captured before
 * deletion, so a surviving dependent row cannot become unfindable after its
 * parent is removed.
 */
const PROBE_HANDLERS: Record<string, ProbeHandler> = {
  assets: ({ userId, tx }) =>
    probe(tx.select({ value: count() }).from(assets).where(eq(assets.ownerId, userId))),
  dividends: ({ portfolioIds, tx }) =>
    probeIds(portfolioIds, (ids) =>
      tx.select({ value: count() }).from(dividends).where(inArray(dividends.portfolioId, ids)),
    ),
  expense_budget_fires: ({ expenseBudgetIds, tx }) =>
    probeIds(expenseBudgetIds, (ids) =>
      tx
        .select({ value: count() })
        .from(expenseBudgetFires)
        .where(inArray(expenseBudgetFires.budgetId, ids)),
    ),
  expense_budgets: ({ userId, tx }) =>
    probe(
      tx.select({ value: count() }).from(expenseBudgets).where(eq(expenseBudgets.userId, userId)),
    ),
  expense_categories: ({ userId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(expenseCategories)
        .where(eq(expenseCategories.userId, userId)),
    ),
  expense_rules: ({ userId, tx }) =>
    probe(tx.select({ value: count() }).from(expenseRules).where(eq(expenseRules.userId, userId))),
  expense_transactions: ({ userId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(expenseTransactions)
        .where(eq(expenseTransactions.userId, userId)),
    ),
  import_batches: ({ userId, tx }) =>
    probe(
      tx.select({ value: count() }).from(importBatches).where(eq(importBatches.ownerId, userId)),
    ),
  import_rows: ({ importBatchIds, tx }) =>
    probeIds(importBatchIds, (ids) =>
      tx.select({ value: count() }).from(importRows).where(inArray(importRows.batchId, ids)),
    ),
  portfolio_cash_movements: ({ portfolioIds, tx }) =>
    probeIds(portfolioIds, (ids) =>
      tx
        .select({ value: count() })
        .from(portfolioCashMovements)
        .where(inArray(portfolioCashMovements.portfolioId, ids)),
    ),
  portfolio_cash_sources: ({ portfolioIds, tx }) =>
    probeIds(portfolioIds, (ids) =>
      tx
        .select({ value: count() })
        .from(portfolioCashSources)
        .where(inArray(portfolioCashSources.portfolioId, ids)),
    ),
  portfolio_daily_snapshots: ({ portfolioIds, tx }) =>
    probeIds(portfolioIds, (ids) =>
      tx
        .select({ value: count() })
        .from(portfolioDailySnapshots)
        .where(inArray(portfolioDailySnapshots.portfolioId, ids)),
    ),
  portfolio_settings: ({ portfolioIds, tx }) =>
    probeIds(portfolioIds, (ids) =>
      tx
        .select({ value: count() })
        .from(portfolioSettings)
        .where(inArray(portfolioSettings.portfolioId, ids)),
    ),
  portfolio_snapshot_state: ({ portfolioIds, tx }) =>
    probeIds(portfolioIds, (ids) =>
      tx
        .select({ value: count() })
        .from(portfolioSnapshotState)
        .where(inArray(portfolioSnapshotState.portfolioId, ids)),
    ),
  portfolios: ({ userId, tx }) =>
    probe(tx.select({ value: count() }).from(portfolios).where(eq(portfolios.userId, userId))),
  price_history: ({ customAssetIds, tx }) =>
    probeIds(customAssetIds, (ids) =>
      tx.select({ value: count() }).from(priceHistory).where(inArray(priceHistory.assetId, ids)),
    ),
  standing_order_runs: ({ standingOrderIds, tx }) =>
    probeIds(standingOrderIds, (ids) =>
      tx
        .select({ value: count() })
        .from(standingOrderRuns)
        .where(inArray(standingOrderRuns.standingOrderId, ids)),
    ),
  standing_orders: ({ userId, tx }) =>
    probe(
      tx.select({ value: count() }).from(standingOrders).where(eq(standingOrders.userId, userId)),
    ),
  transactions: ({ portfolioIds, tx }) =>
    probeIds(portfolioIds, (ids) =>
      tx
        .select({ value: count() })
        .from(transactions)
        .where(inArray(transactions.portfolioId, ids)),
    ),
  user_tax_settings: ({ userId, tx }) =>
    probe(
      tx.select({ value: count() }).from(userTaxSettings).where(eq(userTaxSettings.userId, userId)),
    ),
};

interface PurgeScope {
  tx: Database;
}

export const PARANOID_PURGE_HANDLER_NAMES = Object.keys(PURGE_HANDLERS).sort();
export const PARANOID_PROBE_HANDLER_NAMES = Object.keys(PROBE_HANDLERS).sort();

function assertPurgeCompleteness(): void {
  const expected = [...PARANOID_VAULT_TABLE_NAMES];
  const handlerSets = [
    ['purge handlers', PARANOID_PURGE_HANDLER_NAMES],
    ['probe handlers', PARANOID_PROBE_HANDLER_NAMES],
    ['purge order', [...PARANOID_PURGE_ORDER].sort()],
  ] as const;
  for (const [label, actual] of handlerSets) {
    if (
      expected.length === actual.length &&
      expected.every((name, index) => name === actual[index])
    ) {
      continue;
    }
    throw new Error(
      `paranoid purge/manifest drift: ${label} [${actual.join(', ')}] vs vault tables [${expected.join(', ')}]`,
    );
  }
}

async function idsFor<T extends { id: string }>(query: PromiseLike<T[]>): Promise<string[]> {
  return (await query).map((row) => row.id);
}

function followedSubjectCondition(
  kind: 'portfolio' | 'conglomerate' | 'watchlist' | 'idea',
  ids: readonly string[],
) {
  return ids.length > 0
    ? and(eq(itemFollows.kind, kind), inArray(itemFollows.subjectId, [...ids]))
    : undefined;
}

function activitySubjectCondition(
  kind: 'portfolio' | 'conglomerate' | 'watchlist' | 'idea',
  ids: readonly string[],
) {
  return ids.length > 0
    ? and(
        eq(sharedItemActivityPrefs.kind, kind),
        inArray(sharedItemActivityPrefs.subjectId, [...ids]),
      )
    : undefined;
}

export function createParanoidTransitionTransactionRepository(
  tx: Database,
): ParanoidTransitionTransactionRepository {
  return {
    async lockState(userId) {
      const [user] = await tx
        .select({
          privacyMode: users.privacyMode,
          mediaSet: users.paranoidMediaSet,
          driveAttestedVersion: users.paranoidDriveAttestedVersion,
        })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!user) return null;

      const [[vault], [membership], [pendingImport], [pendingExport]] = await Promise.all([
        tx
          .select({
            version: paranoidVaults.version,
            formatVersion: paranoidVaults.formatVersion,
            sizeBytes: paranoidVaults.sizeBytes,
            updatedAt: paranoidVaults.updatedAt,
          })
          .from(paranoidVaults)
          .where(eq(paranoidVaults.userId, userId))
          .limit(1),
        tx
          .select({ id: mirrorChainMembers.id })
          .from(mirrorChainMembers)
          .where(
            and(eq(mirrorChainMembers.userId, userId), eq(mirrorChainMembers.status, 'active')),
          )
          .limit(1),
        tx
          .select({ id: importBatches.id })
          .from(importBatches)
          .where(and(eq(importBatches.ownerId, userId), eq(importBatches.status, 'pending')))
          .limit(1),
        tx
          .select({ id: exportJobs.id })
          .from(exportJobs)
          .where(and(eq(exportJobs.userId, userId), eq(exportJobs.status, 'pending')))
          .limit(1),
      ]);

      return {
        privacyMode: user.privacyMode,
        mediaSet: user.mediaSet as VaultMediaSet | null,
        driveAttestedVersion: user.driveAttestedVersion,
        currentServerVault: vault ?? null,
        activeMirrorchain: Boolean(membership),
        pendingImport: Boolean(pendingImport),
        pendingExport: Boolean(pendingExport),
      };
    },

    async revokeSharing(userId) {
      const [portfolioIds, conglomerateIds, watchlistIds, ideaIds, audienceIds] = await Promise.all(
        [
          idsFor(
            tx.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.userId, userId)),
          ),
          idsFor(
            tx
              .select({ id: conglomerates.id })
              .from(conglomerates)
              .where(eq(conglomerates.ownerId, userId)),
          ),
          idsFor(
            tx.select({ id: watchlists.id }).from(watchlists).where(eq(watchlists.userId, userId)),
          ),
          idsFor(tx.select({ id: ideas.id }).from(ideas).where(eq(ideas.ownerId, userId))),
          idsFor(
            tx
              .select({ id: shareAudiences.id })
              .from(shareAudiences)
              .where(eq(shareAudiences.ownerId, userId)),
          ),
        ],
      );

      const followedSubjects = [
        followedSubjectCondition('portfolio', portfolioIds),
        followedSubjectCondition('conglomerate', conglomerateIds),
        followedSubjectCondition('watchlist', watchlistIds),
        followedSubjectCondition('idea', ideaIds),
      ].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined);
      const activitySubjects = [
        activitySubjectCondition('portfolio', portfolioIds),
        activitySubjectCondition('conglomerate', conglomerateIds),
        activitySubjectCondition('watchlist', watchlistIds),
        activitySubjectCondition('idea', ideaIds),
      ].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined);

      await tx.delete(itemReactions).where(eq(itemReactions.userId, userId));
      await tx.delete(itemComments).where(eq(itemComments.authorId, userId));
      await tx
        .delete(itemFollows)
        .where(
          followedSubjects.length > 0
            ? or(eq(itemFollows.userId, userId), ...followedSubjects)
            : eq(itemFollows.userId, userId),
        );
      await tx
        .delete(sharedItemActivityPrefs)
        .where(
          activitySubjects.length > 0
            ? or(eq(sharedItemActivityPrefs.viewerId, userId), ...activitySubjects)
            : eq(sharedItemActivityPrefs.viewerId, userId),
        );
      await tx.delete(shareAudienceMembers).where(eq(shareAudienceMembers.friendId, userId));
      await tx.delete(friendGroupMembers).where(eq(friendGroupMembers.memberId, userId));
      await tx
        .delete(userFollows)
        .where(or(eq(userFollows.followerId, userId), eq(userFollows.followedId, userId)));
      await ifIds(conglomerateIds, (ids) =>
        tx.delete(shareLinks).where(inArray(shareLinks.conglomerateId, ids)),
      );
      await ifIds(audienceIds, (ids) =>
        tx.delete(shareAudiences).where(inArray(shareAudiences.id, ids)),
      );
      await tx
        .update(conglomerates)
        .set({ visibility: 'private', updatedAt: new Date() })
        .where(eq(conglomerates.ownerId, userId));
    },

    async purgeVaultRows(userId) {
      assertPurgeCompleteness();
      const [portfolioIds, customAssetIds, standingOrderIds, importBatchIds, expenseBudgetIds] =
        await Promise.all([
          idsFor(
            tx.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.userId, userId)),
          ),
          idsFor(tx.select({ id: assets.id }).from(assets).where(eq(assets.ownerId, userId))),
          idsFor(
            tx
              .select({ id: standingOrders.id })
              .from(standingOrders)
              .where(eq(standingOrders.userId, userId)),
          ),
          idsFor(
            tx
              .select({ id: importBatches.id })
              .from(importBatches)
              .where(eq(importBatches.ownerId, userId)),
          ),
          idsFor(
            tx
              .select({ id: expenseBudgets.id })
              .from(expenseBudgets)
              .where(eq(expenseBudgets.userId, userId)),
          ),
        ]);
      const scope: PurgeScope = {
        tx,
        userId,
        portfolioIds,
        customAssetIds,
        standingOrderIds,
        importBatchIds,
        expenseBudgetIds,
      };
      for (const tableName of PARANOID_PURGE_ORDER) {
        await PURGE_HANDLERS[tableName]!(scope);
      }
      for (const tableName of PARANOID_VAULT_TABLE_NAMES) {
        const remaining = await PROBE_HANDLERS[tableName]!(scope);
        if (remaining !== 0) {
          throw new Error(`paranoid zero-cleartext probe failed for ${tableName}`);
        }
      }
    },

    async completeEnable(input) {
      if (!input.keepServerCiphertext) {
        await tx.delete(paranoidVaultHistory).where(eq(paranoidVaultHistory.userId, input.userId));
        await tx.delete(paranoidVaults).where(eq(paranoidVaults.userId, input.userId));
      }
      await tx
        .delete(paranoidRehydrationReceipts)
        .where(eq(paranoidRehydrationReceipts.userId, input.userId));
      await tx
        .update(users)
        .set({
          privacyMode: 'paranoid',
          paranoidMediaSet: input.mediaSet,
          paranoidDriveAttestedVersion: input.driveAttestedVersion,
          profilePublic: false,
          watchlistVisibility: 'private',
          defaultPortfolioVisibility: 'private',
          alertsVisibleToFollowers: false,
          updatedAt: input.completedAt,
        })
        .where(eq(users.id, input.userId));
    },
  };
}

export async function withParanoidTransitionTransaction<T>(
  db: Database,
  run: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction((tx) => run(tx as unknown as Database));
}

export async function getParanoidAdminMetadata(
  db: Database,
  userId: string,
): Promise<ParanoidAdminMetadata | null> {
  const [user] = await db
    .select({
      privacyMode: users.privacyMode,
      mediaSet: users.paranoidMediaSet,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;
  const [[vault], [history]] = await Promise.all([
    db
      .select({
        version: paranoidVaults.version,
        sizeBytes: paranoidVaults.sizeBytes,
        updatedAt: paranoidVaults.updatedAt,
      })
      .from(paranoidVaults)
      .where(eq(paranoidVaults.userId, userId))
      .limit(1),
    db
      .select({ value: count() })
      .from(paranoidVaultHistory)
      .where(eq(paranoidVaultHistory.userId, userId)),
  ]);
  return {
    privacyMode: user.privacyMode,
    mediaSet: user.mediaSet as VaultMediaSet | null,
    vault: vault ?? null,
    historyCount: Number(history?.value ?? 0),
  };
}

export function serverVaultMatches(state: LockedParanoidTransitionState, version: number): boolean {
  return (
    state.currentServerVault?.version === version &&
    state.currentServerVault.formatVersion === VAULT_FORMAT_VERSION
  );
}
