import { and, count, eq, inArray, ne, or, sql } from 'drizzle-orm';

import { VAULT_FORMAT_VERSION, type VaultMediaSet } from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  assetIdentities,
  assets,
  cashBudgetFires,
  cashBudgets,
  cashMovementTags,
  cashRuleTags,
  cashRules,
  cashTags,
  conglomerates,
  dividends,
  expenseBudgetFires,
  expenseBudgets,
  expenseCategories,
  expenseRules,
  expenseTransactions,
  exportJobs,
  friendGroupMembers,
  friendships,
  ideas,
  importBatches,
  importRows,
  itemComments,
  itemFollows,
  itemReactions,
  mirrorChainInvites,
  mirrorChainMembers,
  paranoidRehydrationReceipts,
  paranoidVaultHistory,
  paranoidVaultRetired,
  paranoidVaultRetirements,
  paranoidVaultServerCandidates,
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
import {
  withExclusiveParanoidTransitionTestLock,
  withFreshLockedPrivacyModes,
} from './paranoidEnforcementRepository';

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
  serverVaultHistoryCount: number;
  activeMirrorchain: boolean;
  pendingImport: boolean;
  pendingExport: boolean;
  /** Opaque identities survive content detachment and drive cache retirement. */
  customAssetIds: string[];
  /** Normal-account ZIPs, or a prior enable's recoverable retirement pointers. */
  cleartextExports: Array<{ id: string; filePath: string }>;
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
  retireCleartextExports(userId: string, exportIds: readonly string[]): Promise<void>;
  purgeVaultRows(userId: string): Promise<void>;
  completeEnable(input: {
    userId: string;
    mediaSet: VaultMediaSet;
    driveAttestedVersion: number | null;
    keepServerCiphertext: boolean;
    completedAt: Date;
  }): Promise<void>;
}

export const PARANOID_RETIRED_EXPORT_ERROR = 'RETIRED_FOR_PARANOID_MODE';

interface PurgeScope {
  tx: Database;
  userId: string;
  portfolioIds: string[];
  customAssetIds: string[];
  standingOrderIds: string[];
  importBatchIds: string[];
  expenseBudgetIds: string[];
  cashMovementIds: string[];
  cashBudgetIds: string[];
  cashRuleIds: string[];
}

type PurgeHandler = (scope: PurgeScope) => PromiseLike<unknown> | Promise<void>;
type ProbeHandler = (scope: PurgeScope) => Promise<number>;

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
 * One executable purge branch for every table on the binding vault axis. Runtime
 * completeness below compares this map with the classification before any
 * destructive statement can run.
 */
const PURGE_HANDLERS: Record<string, PurgeHandler> = {
  assets: async ({ customAssetIds, tx, userId }) => {
    // #794's database-enforced identity seam removes every content-bearing
    // custom asset while retaining only its opaque (id, owner_id) integrity key.
    for (const assetId of customAssetIds) {
      await tx.execute(sql`
        select bettertrack_detach_owned_asset_data(
          cast(${assetId} as uuid),
          cast(${userId} as uuid)
        )
      `);
    }
  },
  cash_budget_fires: ({ cashBudgetIds, tx }) =>
    ifIds(cashBudgetIds, (ids) =>
      tx.delete(cashBudgetFires).where(inArray(cashBudgetFires.budgetId, ids)),
    ),
  cash_budgets: ({ portfolioIds, tx }) =>
    ifIds(portfolioIds, (ids) =>
      tx.delete(cashBudgets).where(inArray(cashBudgets.portfolioId, ids)),
    ),
  cash_movement_tags: ({ cashMovementIds, tx }) =>
    ifIds(cashMovementIds, (ids) =>
      tx.delete(cashMovementTags).where(inArray(cashMovementTags.movementId, ids)),
    ),
  cash_rule_tags: ({ cashRuleIds, tx }) =>
    ifIds(cashRuleIds, (ids) => tx.delete(cashRuleTags).where(inArray(cashRuleTags.ruleId, ids))),
  cash_rules: ({ userId, tx }) => tx.delete(cashRules).where(eq(cashRules.userId, userId)),
  cash_tags: ({ userId, tx }) => tx.delete(cashTags).where(eq(cashTags.userId, userId)),
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
 * Dependency-safe destructive order. Membership is checked mechanically; only
 * ordering remains hand-authored because leaves must disappear before parents.
 */
const PARANOID_PURGE_ORDER = [
  'cash_budget_fires',
  'cash_movement_tags',
  'cash_rule_tags',
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
  'cash_budgets',
  'cash_rules',
  'cash_tags',
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

/** One scope-aware zero-cleartext query per classified table. */
const PROBE_HANDLERS: Record<string, ProbeHandler> = {
  assets: ({ userId, tx }) =>
    probe(tx.select({ value: count() }).from(assets).where(eq(assets.ownerId, userId))),
  cash_budget_fires: ({ cashBudgetIds, tx }) =>
    probeIds(cashBudgetIds, (ids) =>
      tx
        .select({ value: count() })
        .from(cashBudgetFires)
        .where(inArray(cashBudgetFires.budgetId, ids)),
    ),
  cash_budgets: ({ portfolioIds, tx }) =>
    probeIds(portfolioIds, (ids) =>
      tx.select({ value: count() }).from(cashBudgets).where(inArray(cashBudgets.portfolioId, ids)),
    ),
  cash_movement_tags: ({ cashMovementIds, tx }) =>
    probeIds(cashMovementIds, (ids) =>
      tx
        .select({ value: count() })
        .from(cashMovementTags)
        .where(inArray(cashMovementTags.movementId, ids)),
    ),
  cash_rule_tags: ({ cashRuleIds, tx }) =>
    probeIds(cashRuleIds, (ids) =>
      tx.select({ value: count() }).from(cashRuleTags).where(inArray(cashRuleTags.ruleId, ids)),
    ),
  cash_rules: ({ userId, tx }) =>
    probe(tx.select({ value: count() }).from(cashRules).where(eq(cashRules.userId, userId))),
  cash_tags: ({ userId, tx }) =>
    probe(tx.select({ value: count() }).from(cashTags).where(eq(cashTags.userId, userId))),
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

function commentSubjectCondition(
  kind: 'portfolio' | 'conglomerate' | 'watchlist' | 'idea',
  ids: readonly string[],
) {
  return ids.length > 0
    ? and(eq(itemComments.kind, kind), inArray(itemComments.subjectId, [...ids]))
    : undefined;
}

function reactionSubjectCondition(
  kind: 'portfolio' | 'conglomerate' | 'watchlist' | 'idea',
  ids: readonly string[],
) {
  return ids.length > 0
    ? and(eq(itemReactions.kind, kind), inArray(itemReactions.subjectId, [...ids]))
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

      const [
        [vault],
        [historyCount],
        [membership],
        [pendingImport],
        ownedAssetIdentities,
        accountExports,
      ] = await Promise.all([
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
          .select({ value: count() })
          .from(paranoidVaultHistory)
          .where(eq(paranoidVaultHistory.userId, userId)),
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
          .select({ id: assetIdentities.id })
          .from(assetIdentities)
          .where(eq(assetIdentities.ownerId, userId)),
        tx
          .select({
            id: exportJobs.id,
            status: exportJobs.status,
            filePath: exportJobs.filePath,
            error: exportJobs.error,
          })
          .from(exportJobs)
          .where(eq(exportJobs.userId, userId))
          .for('update'),
      ]);

      return {
        privacyMode: user.privacyMode,
        mediaSet: user.mediaSet as VaultMediaSet | null,
        driveAttestedVersion: user.driveAttestedVersion,
        currentServerVault: vault ?? null,
        serverVaultHistoryCount: Number(historyCount?.value ?? 0),
        activeMirrorchain: Boolean(membership),
        pendingImport: Boolean(pendingImport),
        pendingExport: accountExports.some((row) => row.status === 'pending'),
        customAssetIds: ownedAssetIdentities.map((row) => row.id),
        cleartextExports: accountExports
          .filter(
            (row): row is typeof row & { filePath: string } =>
              row.filePath !== null &&
              (user.privacyMode === 'normal' || row.error === PARANOID_RETIRED_EXPORT_ERROR),
          )
          .map((row) => ({ id: row.id, filePath: row.filePath })),
      };
    },

    async revokeSharing(userId) {
      const [portfolioIds, conglomerateIds, watchlistIds, ideaIds, audienceIds, friendshipRows] =
        await Promise.all([
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
          tx
            .select({ userA: friendships.userA, userB: friendships.userB })
            .from(friendships)
            .where(or(eq(friendships.userA, userId), eq(friendships.userB, userId))),
        ]);

      const friendIds = friendshipRows.map((row) => (row.userA === userId ? row.userB : row.userA));
      const broadInboundAudiences =
        friendIds.length === 0
          ? []
          : await tx
              .select({ id: shareAudiences.id })
              .from(shareAudiences)
              .where(
                and(
                  inArray(shareAudiences.ownerId, friendIds),
                  inArray(shareAudiences.audience, ['all_friends', 'public_link']),
                ),
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
      const commentSubjects = [
        commentSubjectCondition('portfolio', portfolioIds),
        commentSubjectCondition('conglomerate', conglomerateIds),
        commentSubjectCondition('watchlist', watchlistIds),
        commentSubjectCondition('idea', ideaIds),
      ].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined);
      const reactionSubjects = [
        reactionSubjectCondition('portfolio', portfolioIds),
        reactionSubjectCondition('conglomerate', conglomerateIds),
        reactionSubjectCondition('watchlist', watchlistIds),
        reactionSubjectCondition('idea', ideaIds),
      ].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined);

      await tx
        .delete(itemReactions)
        .where(
          reactionSubjects.length > 0
            ? or(eq(itemReactions.userId, userId), ...reactionSubjects)
            : eq(itemReactions.userId, userId),
        );
      await tx
        .delete(itemComments)
        .where(
          commentSubjects.length > 0
            ? or(eq(itemComments.authorId, userId), ...commentSubjects)
            : eq(itemComments.authorId, userId),
        );
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

      // Explicit and group grants disappear directly.
      await tx.delete(shareAudienceMembers).where(eq(shareAudienceMembers.friendId, userId));
      await tx.delete(friendGroupMembers).where(eq(friendGroupMembers.memberId, userId));

      // `all_friends` and the friend-mode branch of `public_link` are implicit
      // grants. A member row on those broad modes is therefore an exclusion
      // marker. setAudience replaces the row set, so an owner's later deliberate
      // re-share clears the marker without adding schema or touching friendship.
      if (broadInboundAudiences.length > 0) {
        await tx
          .insert(shareAudienceMembers)
          .values(
            broadInboundAudiences.map((audience) => ({
              audienceId: audience.id,
              friendId: userId,
            })),
          )
          .onConflictDoNothing();
      }

      await tx
        .delete(userFollows)
        .where(or(eq(userFollows.followerId, userId), eq(userFollows.followedId, userId)));
      await tx
        .update(mirrorChainInvites)
        .set({ status: 'revoked', respondedAt: new Date() })
        .where(
          and(
            eq(mirrorChainInvites.status, 'pending'),
            or(eq(mirrorChainInvites.fromUser, userId), eq(mirrorChainInvites.toUser, userId)),
          ),
        );
      await ifIds(conglomerateIds, (ids) =>
        tx.delete(shareLinks).where(inArray(shareLinks.conglomerateId, ids)),
      );
      await ifIds(audienceIds, (ids) =>
        tx.delete(shareAudiences).where(inArray(shareAudiences.id, ids)),
      );
      await tx
        .update(conglomerates)
        .set({ visibility: 'private', updatedAt: new Date() })
        .where(and(eq(conglomerates.ownerId, userId), ne(conglomerates.visibility, 'private')));
    },

    async retireCleartextExports(userId, exportIds) {
      await ifIds(exportIds, (ids) =>
        tx
          .update(exportJobs)
          .set({
            status: 'failed',
            fileSize: null,
            downloadTokenHash: null,
            expiresAt: null,
            readyAt: null,
            error: PARANOID_RETIRED_EXPORT_ERROR,
          })
          .where(and(eq(exportJobs.userId, userId), inArray(exportJobs.id, ids))),
      );
    },

    async purgeVaultRows(userId) {
      assertPurgeCompleteness();
      const [
        portfolioIds,
        customAssetIds,
        standingOrderIds,
        importBatchIds,
        expenseBudgetIds,
        cashMovementIds,
        cashBudgetIds,
        cashRuleIds,
      ] = await Promise.all([
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
        portfolioIdsForUser(tx, userId).then((ids) =>
          ids.length === 0
            ? []
            : idsFor(
                tx
                  .select({ id: portfolioCashMovements.id })
                  .from(portfolioCashMovements)
                  .where(inArray(portfolioCashMovements.portfolioId, ids)),
              ),
        ),
        portfolioIdsForUser(tx, userId).then((ids) =>
          ids.length === 0
            ? []
            : idsFor(
                tx
                  .select({ id: cashBudgets.id })
                  .from(cashBudgets)
                  .where(inArray(cashBudgets.portfolioId, ids)),
              ),
        ),
        idsFor(tx.select({ id: cashRules.id }).from(cashRules).where(eq(cashRules.userId, userId))),
      ]);
      const scope: PurgeScope = {
        tx,
        userId,
        portfolioIds,
        customAssetIds,
        standingOrderIds,
        importBatchIds,
        expenseBudgetIds,
        cashMovementIds,
        cashBudgetIds,
        cashRuleIds,
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
      // Candidates and retired media are never part of the initial selected
      // state. Drive-only additionally leaves no ciphertext bytes anywhere.
      await tx
        .delete(paranoidVaultServerCandidates)
        .where(eq(paranoidVaultServerCandidates.userId, input.userId));
      await tx.delete(paranoidVaultRetired).where(eq(paranoidVaultRetired.userId, input.userId));
      await tx
        .delete(paranoidVaultRetirements)
        .where(eq(paranoidVaultRetirements.userId, input.userId));
      if (!input.keepServerCiphertext) {
        await tx.delete(paranoidVaultHistory).where(eq(paranoidVaultHistory.userId, input.userId));
        await tx.delete(paranoidVaults).where(eq(paranoidVaults.userId, input.userId));
      }
      // A new enable starts a new disable generation. Without clearing PD3a's
      // per-user receipt, the next valid disable would conflict forever.
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

async function portfolioIdsForUser(db: Database, userId: string): Promise<string[]> {
  return idsFor(
    db.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.userId, userId)),
  );
}

/**
 * Clear the durable recovery pointer inside the enable transaction only after
 * every staged archive has been removed.
 */
export async function finalizeRetiredCleartextExports(
  db: Database,
  userId: string,
  exportIds: readonly string[],
): Promise<void> {
  await ifIds(exportIds, (ids) =>
    db
      .update(exportJobs)
      .set({ filePath: null })
      .where(
        and(
          eq(exportJobs.userId, userId),
          inArray(exportJobs.id, ids),
          eq(exportJobs.error, PARANOID_RETIRED_EXPORT_ERROR),
        ),
      ),
  );
}

export async function withParanoidTransitionTransaction<T>(
  db: Database,
  userId: string,
  run: (tx: Database) => Promise<T>,
): Promise<T> {
  return withExclusiveParanoidTransitionTestLock(db, userId, () =>
    db.transaction((tx) => run(tx as unknown as Database)),
  );
}

export async function getParanoidAdminMetadata(
  db: Database,
  userId: string,
): Promise<ParanoidAdminMetadata | null> {
  return withFreshLockedPrivacyModes(db, [userId], async () => {
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
  });
}

export function serverVaultMatches(state: LockedParanoidTransitionState, version: number): boolean {
  return (
    state.currentServerVault?.version === version &&
    state.currentServerVault.formatVersion === VAULT_FORMAT_VERSION
  );
}
