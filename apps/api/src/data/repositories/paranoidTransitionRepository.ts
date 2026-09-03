import { createHash } from 'node:crypto';

import { and, count, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import { VAULT_FORMAT_VERSION, type VaultMediaSet } from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  apiKeyRequestLog,
  assetIdentities,
  assets,
  auditLog,
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
  paranoidEnableTransitions,
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
  usageActivations,
  usageEvents,
  userFollows,
  users,
  userTaxSettings,
  watchlists,
} from '../schema';
import {
  PARANOID_PURGED_TABLE_NAMES,
  PARANOID_RESTORABLE_TABLE_NAMES,
} from '../../services/export/manifest';
import {
  withExclusiveParanoidTransitionTestLock,
  withFreshLockedPrivacyModes,
} from './paranoidEnforcementRepository';

export interface LockedParanoidTransitionState {
  privacyMode: 'normal' | 'paranoid';
  enableStaging: { expiresAt: Date } | null;
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
    /**
     * True only for a `normal → paranoid` transition, whose initial selected
     * state by definition contains no staged candidate and no retired-server
     * recovery set. It MUST be false on an idempotent retry against an already
     * paranoid account: `paranoid_vault_retired` / `paranoid_vault_retirements`
     * (and an unexpired candidate) are gated state, destroyable only through
     * `POST /account/vault/retired/purge` — matching retired version, an Ed25519
     * retirement proof over a server-issued challenge, and the minimum
     * retention window. A replayed enable satisfies none of those, so it must
     * leave those rows alone rather than hard-delete the user's last readable
     * copy behind a `200 {"idempotent": true}`.
     */
    freshTransition: boolean;
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
type DigestHandler = (scope: PurgeScope) => Promise<string>;

/** The digest of an empty scope — an absent id list and an empty table agree. */
const EMPTY_DIGEST = '-';

/**
 * A whole-table content hash for the rows the surrounding query selects. The
 * per-row `md5(row::text)` covers EVERY column (no hand-listed column set can
 * silently miss one), and ordering the aggregate by that same hash makes the
 * result independent of the physical scan order.
 *
 * The one assumption, stated so a future change cannot break enable quietly:
 * `row::text` renders through the session's `DateStyle` / `TimeZone` /
 * `extra_float_digits`, so the capture's read and enable's in-transaction
 * re-derivation must run against the SAME configuration. Today both go through
 * `deps.db`, one pool, so they agree by construction. Serving the read from a
 * replica or a differently-configured pool would make every enable disagree
 * with itself — a permanent 409, never a purge, but a permanent one.
 */
const rowsDigest = (table: PgTable) =>
  sql<string>`coalesce(md5(string_agg(md5(${table}::text), ',' order by md5(${table}::text))), ${EMPTY_DIGEST})`;

const digest = async (query: PromiseLike<Array<{ value: string | null }>>): Promise<string> => {
  const [row] = await query;
  return row?.value ?? EMPTY_DIGEST;
};

const digestIds = async (
  ids: readonly string[],
  run: (ids: string[]) => PromiseLike<Array<{ value: string | null }>>,
): Promise<string> => (ids.length === 0 ? EMPTY_DIGEST : digest(run([...ids])));

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
  api_key_request_log: ({ userId, tx }) =>
    tx.delete(apiKeyRequestLog).where(eq(apiKeyRequestLog.userId, userId)),
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
  // `purge`-classified (see the manifest entry): the per-(user, feature, asset,
  // day) telemetry rows recorded this account's holdings roster every day it
  // valued its portfolio. ALL of the user's rows go, not just the
  // asset-identifying ones — the residual `hits` counter on a bare
  // `feature='assets'` row still tracks how many holdings were priced.
  usage_events: ({ userId, tx }) => tx.delete(usageEvents).where(eq(usageEvents.userId, userId)),
  // The activation marker written from those same rows (#1680). It outlives the
  // retention sweep by design, so unlike the raw events it would never age away
  // on its own — it goes with them here.
  usage_activations: ({ userId, tx }) =>
    tx.delete(usageActivations).where(eq(usageActivations.userId, userId)),
};

/**
 * Dependency-safe destructive order. Membership is checked mechanically; only
 * ordering remains hand-authored because leaves must disappear before parents.
 */
const PARANOID_PURGE_ORDER = [
  // FK-independent operational telemetry, scoped directly to the user.
  'api_key_request_log',
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
  // FK-independent (references `users` only), so ordering is free here.
  'usage_events',
  'usage_activations',
] as const;

/** One scope-aware zero-cleartext query per classified table. */
const PROBE_HANDLERS: Record<string, ProbeHandler> = {
  api_key_request_log: ({ userId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(apiKeyRequestLog)
        .where(eq(apiKeyRequestLog.userId, userId)),
    ),
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
  // Zero rows for this user, full stop — this probe is what keeps the capture
  // suppression honest at RUNTIME, not just in a test: if any writer starts
  // recording a paranoid account again, the next enable aborts on it.
  usage_events: ({ userId, tx }) =>
    probe(tx.select({ value: count() }).from(usageEvents).where(eq(usageEvents.userId, userId))),
  usage_activations: ({ userId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(usageActivations)
        .where(eq(usageActivations.userId, userId)),
    ),
};

/**
 * One content digest per RESTORABLE vault table — the capture↔commit CAS
 * material (`computeNormalDataRevision`). Each row is hashed whole
 * (`md5(row::text)`), so any insert, delete or column edit moves the table's
 * digest; the aggregate is ordered by the row hash so it never depends on scan
 * order. Purge-only tables are deliberately absent: see
 * {@link PARANOID_RESTORABLE_TABLE_NAMES}.
 */
const REVISION_HANDLERS: Record<string, DigestHandler> = {
  assets: ({ userId, tx }) =>
    digest(
      tx
        .select({ value: rowsDigest(assets) })
        .from(assets)
        .where(eq(assets.ownerId, userId)),
    ),
  cash_budgets: ({ portfolioIds, tx }) =>
    digestIds(portfolioIds, (ids) =>
      tx
        .select({ value: rowsDigest(cashBudgets) })
        .from(cashBudgets)
        .where(inArray(cashBudgets.portfolioId, ids)),
    ),
  cash_movement_tags: ({ cashMovementIds, tx }) =>
    digestIds(cashMovementIds, (ids) =>
      tx
        .select({ value: rowsDigest(cashMovementTags) })
        .from(cashMovementTags)
        .where(inArray(cashMovementTags.movementId, ids)),
    ),
  cash_rule_tags: ({ cashRuleIds, tx }) =>
    digestIds(cashRuleIds, (ids) =>
      tx
        .select({ value: rowsDigest(cashRuleTags) })
        .from(cashRuleTags)
        .where(inArray(cashRuleTags.ruleId, ids)),
    ),
  cash_rules: ({ userId, tx }) =>
    digest(
      tx
        .select({ value: rowsDigest(cashRules) })
        .from(cashRules)
        .where(eq(cashRules.userId, userId)),
    ),
  cash_tags: ({ userId, tx }) =>
    digest(
      tx
        .select({ value: rowsDigest(cashTags) })
        .from(cashTags)
        .where(eq(cashTags.userId, userId)),
    ),
  dividends: ({ portfolioIds, tx }) =>
    digestIds(portfolioIds, (ids) =>
      tx
        .select({ value: rowsDigest(dividends) })
        .from(dividends)
        .where(inArray(dividends.portfolioId, ids)),
    ),
  expense_budgets: ({ userId, tx }) =>
    digest(
      tx
        .select({ value: rowsDigest(expenseBudgets) })
        .from(expenseBudgets)
        .where(eq(expenseBudgets.userId, userId)),
    ),
  expense_categories: ({ userId, tx }) =>
    digest(
      tx
        .select({ value: rowsDigest(expenseCategories) })
        .from(expenseCategories)
        .where(eq(expenseCategories.userId, userId)),
    ),
  expense_rules: ({ userId, tx }) =>
    digest(
      tx
        .select({ value: rowsDigest(expenseRules) })
        .from(expenseRules)
        .where(eq(expenseRules.userId, userId)),
    ),
  expense_transactions: ({ userId, tx }) =>
    digest(
      tx
        .select({ value: rowsDigest(expenseTransactions) })
        .from(expenseTransactions)
        .where(eq(expenseTransactions.userId, userId)),
    ),
  portfolio_cash_movements: ({ portfolioIds, tx }) =>
    digestIds(portfolioIds, (ids) =>
      tx
        .select({ value: rowsDigest(portfolioCashMovements) })
        .from(portfolioCashMovements)
        .where(inArray(portfolioCashMovements.portfolioId, ids)),
    ),
  portfolio_cash_sources: ({ portfolioIds, tx }) =>
    digestIds(portfolioIds, (ids) =>
      tx
        .select({ value: rowsDigest(portfolioCashSources) })
        .from(portfolioCashSources)
        .where(inArray(portfolioCashSources.portfolioId, ids)),
    ),
  portfolio_settings: ({ portfolioIds, tx }) =>
    digestIds(portfolioIds, (ids) =>
      tx
        .select({ value: rowsDigest(portfolioSettings) })
        .from(portfolioSettings)
        .where(inArray(portfolioSettings.portfolioId, ids)),
    ),
  portfolios: ({ userId, tx }) =>
    digest(
      tx
        .select({ value: rowsDigest(portfolios) })
        .from(portfolios)
        .where(eq(portfolios.userId, userId)),
    ),
  price_history: ({ customAssetIds, tx }) =>
    digestIds(customAssetIds, (ids) =>
      tx
        .select({ value: rowsDigest(priceHistory) })
        .from(priceHistory)
        .where(inArray(priceHistory.assetId, ids)),
    ),
  standing_order_runs: ({ standingOrderIds, tx }) =>
    digestIds(standingOrderIds, (ids) =>
      tx
        .select({ value: rowsDigest(standingOrderRuns) })
        .from(standingOrderRuns)
        .where(inArray(standingOrderRuns.standingOrderId, ids)),
    ),
  standing_orders: ({ userId, tx }) =>
    digest(
      tx
        .select({ value: rowsDigest(standingOrders) })
        .from(standingOrders)
        .where(eq(standingOrders.userId, userId)),
    ),
  transactions: ({ portfolioIds, tx }) =>
    digestIds(portfolioIds, (ids) =>
      tx
        .select({ value: rowsDigest(transactions) })
        .from(transactions)
        .where(inArray(transactions.portfolioId, ids)),
    ),
  user_tax_settings: ({ userId, tx }) =>
    digest(
      tx
        .select({ value: rowsDigest(userTaxSettings) })
        .from(userTaxSettings)
        .where(eq(userTaxSettings.userId, userId)),
    ),
};

export const PARANOID_PURGE_HANDLER_NAMES = Object.keys(PURGE_HANDLERS).sort();
export const PARANOID_PROBE_HANDLER_NAMES = Object.keys(PROBE_HANDLERS).sort();
export const PARANOID_REVISION_HANDLER_NAMES = Object.keys(REVISION_HANDLERS).sort();

function assertPurgeCompleteness(): void {
  const expected = [...PARANOID_PURGED_TABLE_NAMES];
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
  assertRevisionCompleteness();
}

/**
 * A restorable table with no revision handler would be silently exempt from the
 * capture↔commit CAS — the exact "a new table joins the sweep un-enrolled"
 * failure the purge/probe gates already refuse. Checked before every purge and
 * on every revision read, so neither side can drift alone.
 */
function assertRevisionCompleteness(): void {
  const expected = [...PARANOID_RESTORABLE_TABLE_NAMES];
  const actual = PARANOID_REVISION_HANDLER_NAMES;
  if (expected.length === actual.length && expected.every((name, i) => name === actual[i])) return;
  throw new Error(
    `paranoid revision/manifest drift: revision handlers [${actual.join(', ')}] vs restorable tables [${expected.join(', ')}]`,
  );
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
        [enableStaging],
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
          .select({ expiresAt: paranoidEnableTransitions.expiresAt })
          .from(paranoidEnableTransitions)
          .where(eq(paranoidEnableTransitions.userId, userId))
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
        enableStaging: enableStaging ?? null,
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

      // `audit_log` remains a retained security trail, but historic denied
      // bearer probes can carry a concrete resource path. Remove only that
      // field, only for this actor and action; the audit row and every other
      // user's metadata survive unchanged. Runtime writes use the same account
      // privacy lock and replace the path before persistence.
      await tx
        .update(auditLog)
        .set({ meta: sql`${auditLog.meta} - 'path'` })
        .where(
          and(
            eq(auditLog.actorId, userId),
            eq(auditLog.action, 'api_key.scope_denied'),
            sql`${auditLog.meta} ? 'path'`,
          ),
        );

      const scope = await collectPurgeScope(tx, userId);
      for (const tableName of PARANOID_PURGE_ORDER) {
        await PURGE_HANDLERS[tableName]!(scope);
      }
      for (const tableName of PARANOID_PURGED_TABLE_NAMES) {
        const remaining = await PROBE_HANDLERS[tableName]!(scope);
        if (remaining !== 0) {
          throw new Error(`paranoid zero-cleartext probe failed for ${tableName}`);
        }
      }
    },

    async completeEnable(input) {
      await tx
        .delete(paranoidEnableTransitions)
        .where(eq(paranoidEnableTransitions.userId, input.userId));
      if (input.freshTransition) {
        // Candidates and retired media are never part of the initial selected
        // state of a normal → paranoid transition. A retry against an
        // established account keeps them: see `freshTransition`.
        await tx
          .delete(paranoidVaultServerCandidates)
          .where(eq(paranoidVaultServerCandidates.userId, input.userId));
        await tx.delete(paranoidVaultRetired).where(eq(paranoidVaultRetired.userId, input.userId));
        await tx
          .delete(paranoidVaultRetirements)
          .where(eq(paranoidVaultRetirements.userId, input.userId));
      }
      // Drive-only leaves no active ciphertext bytes anywhere. On a retry the
      // locked state already proved both tables empty, so this is a no-op.
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
 * The owner-scoped id sets every table branch (purge, probe, revision) reads
 * its rows through. One collection, shared by all three, so the revision can
 * never hash a wider or narrower scope than the purge destroys.
 */
async function collectPurgeScope(tx: Database, userId: string): Promise<PurgeScope> {
  // Read the owner's portfolio ids once: the portfolio-scoped id sets below
  // derive from this list instead of re-selecting it per branch.
  const portfolioIds = await portfolioIdsForUser(tx, userId);
  const [
    customAssetIds,
    standingOrderIds,
    importBatchIds,
    expenseBudgetIds,
    cashMovementIds,
    cashBudgetIds,
    cashRuleIds,
  ] = await Promise.all([
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
    portfolioIds.length === 0
      ? []
      : idsFor(
          tx
            .select({ id: portfolioCashMovements.id })
            .from(portfolioCashMovements)
            .where(inArray(portfolioCashMovements.portfolioId, portfolioIds)),
        ),
    portfolioIds.length === 0
      ? []
      : idsFor(
          tx
            .select({ id: cashBudgets.id })
            .from(cashBudgets)
            .where(inArray(cashBudgets.portfolioId, portfolioIds)),
        ),
    idsFor(tx.select({ id: cashRules.id }).from(cashRules).where(eq(cashRules.userId, userId))),
  ]);
  return {
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
}

/**
 * The compare-and-swap token that binds a client CAPTURE to the destructive
 * enable commit (`docs/paranoid-design.md` §7): an opaque digest over every
 * restorable vault table this account owns.
 *
 * Why this exists. The wizard reads the whole normal account over many HTTP
 * calls, encrypts it, writes it to each medium and read-verifies them — seconds
 * to minutes — and only THEN reaches the enable transaction, which is the first
 * moment the account row lock exists. A write that lands inside that window (a
 * second session, or the daily standing-order worker booking a period) is absent
 * from the encrypted document and is nonetheless hard-deleted by the purge:
 * irreversible loss. Enable therefore re-derives this token under the lock,
 * immediately before the first destructive statement, and refuses the whole
 * transition when it disagrees with the one the capture started from.
 *
 * It is intentionally content-derived rather than a stored counter: no writer
 * anywhere has to remember to bump anything, and a table that joins the vault
 * axis without a handler fails {@link assertRevisionCompleteness} loudly.
 * It carries no portfolio content — one-way row hashes only — but it is still
 * only ever handed to its own account.
 *
 * Cost and failure direction. One aggregate per restorable table, bounded by a
 * single account's rows, twice per enable (once for the wizard's read, once
 * under the lock) — paid on a once-in-an-account-lifetime transition. Any
 * disagreement, including one this function itself caused, refuses the enable:
 * the failure direction is a retry, never a purge.
 */
export async function computeNormalDataRevision(db: Database, userId: string): Promise<string> {
  assertRevisionCompleteness();
  const scope = await collectPurgeScope(db, userId);
  const parts: string[] = [];
  for (const tableName of PARANOID_RESTORABLE_TABLE_NAMES) {
    parts.push(`${tableName}=${await REVISION_HANDLERS[tableName]!(scope)}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('base64url');
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

/**
 * Batched admin-only mode/media/blob metadata. Two pool rules make this safe on
 * the admin user list, which asks for every account at once:
 *
 *  1. The privacy lock is taken on the DEDICATED lock pool (`lockDb`) while the
 *     reads run on the main pool. In production `withLockedPrivacyModes` opens a
 *     transaction that reserves its connection for the whole callback, so a lock
 *     and the reads it guards must never share a pool — otherwise N concurrent
 *     calls exhaust that pool with transactions waiting on queries queued behind
 *     the very connections those transactions hold (both pools cap at 10).
 *  2. ONE lock and a fixed number of set-based queries cover a batch, so the cost
 *     of an admin page is independent of the account count instead of
 *     `1 lock + 3 round trips` per user.
 *  3. A batch larger than {@link PARANOID_ADMIN_METADATA_LOCK_CHUNK} is split, so
 *     neither the `FOR KEY SHARE` hold nor the `inArray` list grows with an
 *     unbounded account table. A transition's `FOR UPDATE` therefore waits for at
 *     most one chunk of a list refresh, never for the whole table.
 *
 * Ids that no longer resolve are simply absent from the returned map.
 */
export const PARANOID_ADMIN_METADATA_LOCK_CHUNK = 100;

export async function getParanoidAdminMetadata(
  db: Database,
  lockDb: Database,
  userIds: readonly string[],
): Promise<Map<string, ParanoidAdminMetadata>> {
  const ids = [...new Set(userIds)];
  const metadata = new Map<string, ParanoidAdminMetadata>();
  for (let offset = 0; offset < ids.length; offset += PARANOID_ADMIN_METADATA_LOCK_CHUNK) {
    const chunk = ids.slice(offset, offset + PARANOID_ADMIN_METADATA_LOCK_CHUNK);
    await withFreshLockedPrivacyModes(lockDb, chunk, async () => {
      const [accounts, vaults, histories] = await Promise.all([
        db
          .select({
            id: users.id,
            privacyMode: users.privacyMode,
            mediaSet: users.paranoidMediaSet,
          })
          .from(users)
          .where(inArray(users.id, chunk)),
        db
          .select({
            userId: paranoidVaults.userId,
            version: paranoidVaults.version,
            sizeBytes: paranoidVaults.sizeBytes,
            updatedAt: paranoidVaults.updatedAt,
          })
          .from(paranoidVaults)
          .where(inArray(paranoidVaults.userId, chunk)),
        db
          .select({ userId: paranoidVaultHistory.userId, value: count() })
          .from(paranoidVaultHistory)
          .where(inArray(paranoidVaultHistory.userId, chunk))
          .groupBy(paranoidVaultHistory.userId),
      ]);
      const vaultByUser = new Map(vaults.map(({ userId, ...vault }) => [userId, vault] as const));
      const historyByUser = new Map(
        histories.map((row) => [row.userId, Number(row.value ?? 0)] as const),
      );
      for (const account of accounts) {
        metadata.set(account.id, {
          privacyMode: account.privacyMode,
          mediaSet: account.mediaSet as VaultMediaSet | null,
          vault: vaultByUser.get(account.id) ?? null,
          historyCount: historyByUser.get(account.id) ?? 0,
        });
      }
    });
  }
  return metadata;
}

export function serverVaultMatches(state: LockedParanoidTransitionState, version: number): boolean {
  return (
    state.currentServerVault?.version === version &&
    state.currentServerVault.formatVersion === VAULT_FORMAT_VERSION
  );
}
