import { vaultedPortfolioStubName as contractVaultedPortfolioStubName } from '@bettertrack/contracts';
import { and, count, eq, inArray, like, or } from 'drizzle-orm';

import {
  PARANOID_PURGED_TABLE_NAMES,
  PARANOID_VAULT_DOC_BUCKETS,
} from '../../services/export/manifest';
import type { Database } from '../db';
import {
  apiKeyRequestLog,
  cashBudgetFires,
  cashBudgets,
  cashMovementTags,
  dividends,
  idempotencyKeys,
  importBatches,
  importRows,
  itemComments,
  itemFollows,
  itemReactions,
  mirrorChainMembers,
  mirrorRows,
  portfolioCashMovements,
  portfolioCashSources,
  portfolioDailySnapshots,
  portfolioSettings,
  portfolioSnapshotState,
  portfolios,
  shareAudienceLinks,
  shareAudienceMembers,
  shareAudiences,
  sharedItemActivityPrefs,
  standingOrderRuns,
  standingOrders,
  transactions,
} from '../schema';

/**
 * Read-only half of the per-portfolio zero-cleartext invariant (PARANOID-E2).
 * E4 owns deletion; this module only classifies and counts rows that must be
 * absent once a portfolio is a locked stub.
 */

/**
 * Frozen ownership graph captured before E4 starts deleting rows.
 *
 * This is intentionally opaque to callers. A post-delete re-scan cannot recover
 * a comment, import-row, or standing-order id whose parent has already gone, so
 * the destructive transaction captures the graph once and proves absence against
 * that same graph after the sweep.
 */
export interface VaultedPortfolioProbeScope {
  db: Database;
  portfolioId: string;
  cashMovementIds: readonly string[];
  cashBudgetIds: readonly string[];
  standingOrderIds: readonly string[];
  importBatchIds: readonly string[];
  audienceIds: readonly string[];
  commentIds: readonly string[];
}

type ProbeHandler = (scope: VaultedPortfolioProbeScope) => Promise<number>;

export type VaultedPortfolioCleartextRegistration =
  | {
      readonly kind: 'probe';
      readonly scope: 'stub' | 'direct' | 'transitive' | 'polymorphic' | 'path';
      readonly probe: ProbeHandler;
    }
  | {
      readonly kind: 'not-probed';
      readonly scope: 'common' | 'account';
      readonly reason: string;
    };

const scalarCount = async (query: PromiseLike<Array<{ value: number }>>): Promise<number> => {
  const [row] = await query;
  return Number(row?.value ?? 0);
};

const countByIds = async (
  ids: readonly string[],
  query: (ids: string[]) => PromiseLike<Array<{ value: number }>>,
): Promise<number> => {
  if (ids.length === 0) return 0;
  return scalarCount(query([...ids]));
};

/**
 * The content-free value E4 writes into the legacy NOT NULL `name` column.
 * The UUID makes it unique per account without carrying the portfolio's true
 * name; clients render `vault_alias` for a locked stub instead.
 *
 * The literal itself moved into `@bettertrack/contracts`
 * (`VAULTED_PORTFOLIO_STUB_NAME_PREFIX`) so the client can RECOGNISE what this
 * writes without carrying a second copy of the prefix that is free to drift —
 * a drifted copy is how the raw sentinel reached a dialog subtitle
 * (paranoid-UX failure map #6). This wrapper stays as the API-side name every
 * caller here already imports.
 */
export function vaultedPortfolioStubName(portfolioId: string): string {
  return contractVaultedPortfolioStubName(portfolioId);
}

async function probeLockedStub(scope: VaultedPortfolioProbeScope): Promise<number> {
  const [row] = await scope.db
    .select({
      name: portfolios.name,
      visibility: portfolios.visibility,
      sortOrder: portfolios.sortOrder,
      defaultPayFromCash: portfolios.defaultPayFromCash,
      archivedAt: portfolios.archivedAt,
      kind: portfolios.kind,
      vaultId: portfolios.vaultId,
      vaultAlias: portfolios.vaultAlias,
    })
    .from(portfolios)
    .where(eq(portfolios.id, scope.portfolioId))
    .limit(1);
  if (!row) return 1;
  const privacySafe =
    row.name === vaultedPortfolioStubName(scope.portfolioId) &&
    row.visibility === 'private' &&
    row.sortOrder === 0 &&
    row.defaultPayFromCash === false &&
    row.archivedAt === null &&
    row.kind === null &&
    row.vaultId !== null &&
    row.vaultAlias !== null &&
    row.vaultAlias.trim().length > 0;
  return privacySafe ? 0 : 1;
}

/**
 * Server-classified rows that still carry a concrete portfolio reference and
 * must be absent for a locked stub. This explicit roster extends (and never
 * replaces) the legacy manifest completeness contract.
 */
export const VAULTED_PORTFOLIO_SERVER_RESIDUE_TABLE_NAMES = [
  'idempotency_keys',
  'item_comments',
  'item_follows',
  'item_reactions',
  'mirror_chain_members',
  'mirror_rows',
  'share_audience_links',
  'share_audience_members',
  'share_audiences',
  'shared_item_activity_prefs',
] as const;

/**
 * One compulsory per-portfolio decision for every legacy purge table plus
 * every server-residue table above. `probe` entries are executable counts;
 * every other entry states why a per-portfolio zero count would be incorrect.
 * {@link assertVaultedPortfolioProbeCompleteness} enforces the registry against
 * both rosters and the E0 document-bucket axis.
 */
export const VAULTED_PORTFOLIO_CLEARTEXT_REGISTRY: Readonly<
  Record<string, VaultedPortfolioCleartextRegistration>
> = {
  // The identity row survives as the locked stub, but every legacy content
  // column must hold its deterministic privacy-safe sentinel/default.
  portfolios: {
    kind: 'probe',
    scope: 'stub',
    probe: probeLockedStub,
  },

  // Direct portfolio ownership.
  transactions: {
    kind: 'probe',
    scope: 'direct',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(transactions)
          .where(eq(transactions.portfolioId, portfolioId)),
      ),
  },
  dividends: {
    kind: 'probe',
    scope: 'direct',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db.select({ value: count() }).from(dividends).where(eq(dividends.portfolioId, portfolioId)),
      ),
  },
  portfolio_cash_sources: {
    kind: 'probe',
    scope: 'direct',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(portfolioCashSources)
          .where(eq(portfolioCashSources.portfolioId, portfolioId)),
      ),
  },
  portfolio_cash_movements: {
    kind: 'probe',
    scope: 'direct',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(portfolioCashMovements)
          .where(eq(portfolioCashMovements.portfolioId, portfolioId)),
      ),
  },
  portfolio_settings: {
    kind: 'probe',
    scope: 'direct',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(portfolioSettings)
          .where(eq(portfolioSettings.portfolioId, portfolioId)),
      ),
  },
  standing_orders: {
    kind: 'probe',
    scope: 'direct',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(standingOrders)
          .where(eq(standingOrders.portfolioId, portfolioId)),
      ),
  },
  import_batches: {
    kind: 'probe',
    scope: 'direct',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(importBatches)
          .where(eq(importBatches.portfolioId, portfolioId)),
      ),
  },
  portfolio_daily_snapshots: {
    kind: 'probe',
    scope: 'direct',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(portfolioDailySnapshots)
          .where(eq(portfolioDailySnapshots.portfolioId, portfolioId)),
      ),
  },
  portfolio_snapshot_state: {
    kind: 'probe',
    scope: 'direct',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(portfolioSnapshotState)
          .where(eq(portfolioSnapshotState.portfolioId, portfolioId)),
      ),
  },
  cash_budgets: {
    kind: 'probe',
    scope: 'direct',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(cashBudgets)
          .where(eq(cashBudgets.portfolioId, portfolioId)),
      ),
  },

  // Transitive ownership through a direct portfolio row.
  cash_movement_tags: {
    kind: 'probe',
    scope: 'transitive',
    probe: ({ cashMovementIds, db }) =>
      countByIds(cashMovementIds, (ids) =>
        db
          .select({ value: count() })
          .from(cashMovementTags)
          .where(inArray(cashMovementTags.movementId, ids)),
      ),
  },
  cash_budget_fires: {
    kind: 'probe',
    scope: 'transitive',
    probe: ({ cashBudgetIds, db }) =>
      countByIds(cashBudgetIds, (ids) =>
        db
          .select({ value: count() })
          .from(cashBudgetFires)
          .where(inArray(cashBudgetFires.budgetId, ids)),
      ),
  },
  standing_order_runs: {
    kind: 'probe',
    scope: 'transitive',
    probe: ({ db, standingOrderIds }) =>
      countByIds(standingOrderIds, (ids) =>
        db
          .select({ value: count() })
          .from(standingOrderRuns)
          .where(inArray(standingOrderRuns.standingOrderId, ids)),
      ),
  },
  import_rows: {
    kind: 'probe',
    scope: 'transitive',
    probe: ({ db, importBatchIds }) =>
      countByIds(importBatchIds, (ids) =>
        db.select({ value: count() }).from(importRows).where(inArray(importRows.batchId, ids)),
      ),
  },

  // Server-classified residue that is nevertheless tied to this concrete
  // portfolio. Chain-level oplog/tombstones survive; the per-copy identity map
  // and ACTIVE membership do not. Sharing rows are permanently revoked.
  mirror_rows: {
    kind: 'probe',
    scope: 'direct',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(mirrorRows)
          .where(eq(mirrorRows.portfolioId, portfolioId)),
      ),
  },
  mirror_chain_members: {
    kind: 'probe',
    scope: 'direct',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(mirrorChainMembers)
          .where(
            and(
              eq(mirrorChainMembers.portfolioId, portfolioId),
              eq(mirrorChainMembers.status, 'active'),
            ),
          ),
      ),
  },
  share_audiences: {
    kind: 'probe',
    scope: 'polymorphic',
    probe: async ({ audienceIds }) => audienceIds.length,
  },
  share_audience_members: {
    kind: 'probe',
    scope: 'transitive',
    probe: ({ audienceIds, db }) =>
      countByIds(audienceIds, (ids) =>
        db
          .select({ value: count() })
          .from(shareAudienceMembers)
          .where(inArray(shareAudienceMembers.audienceId, ids)),
      ),
  },
  share_audience_links: {
    kind: 'probe',
    scope: 'transitive',
    probe: ({ audienceIds, db }) =>
      countByIds(audienceIds, (ids) =>
        db
          .select({ value: count() })
          .from(shareAudienceLinks)
          .where(inArray(shareAudienceLinks.audienceId, ids)),
      ),
  },
  shared_item_activity_prefs: {
    kind: 'probe',
    scope: 'polymorphic',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(sharedItemActivityPrefs)
          .where(
            and(
              eq(sharedItemActivityPrefs.kind, 'portfolio'),
              eq(sharedItemActivityPrefs.subjectId, portfolioId),
            ),
          ),
      ),
  },
  item_follows: {
    kind: 'probe',
    scope: 'polymorphic',
    probe: ({ db, portfolioId }) =>
      scalarCount(
        db
          .select({ value: count() })
          .from(itemFollows)
          .where(and(eq(itemFollows.kind, 'portfolio'), eq(itemFollows.subjectId, portfolioId))),
      ),
  },
  item_comments: {
    kind: 'probe',
    scope: 'polymorphic',
    probe: async ({ commentIds }) => commentIds.length,
  },
  item_reactions: {
    kind: 'probe',
    scope: 'polymorphic',
    probe: ({ commentIds, db, portfolioId }) => {
      const directItem = and(
        eq(itemReactions.targetType, 'item'),
        eq(itemReactions.kind, 'portfolio'),
        eq(itemReactions.subjectId, portfolioId),
      );
      return scalarCount(
        db
          .select({ value: count() })
          .from(itemReactions)
          .where(
            commentIds.length > 0
              ? or(
                  directItem,
                  and(
                    eq(itemReactions.targetType, 'comment'),
                    inArray(itemReactions.commentId, [...commentIds]),
                  ),
                )
              : directItem,
          ),
      );
    },
  },

  // Concrete paths are slash-delimited endpoint fingerprints. Exact segment
  // matching avoids a UUID-prefix collision while covering every route family.
  idempotency_keys: {
    kind: 'probe',
    scope: 'path',
    probe: ({
      cashBudgetIds,
      cashMovementIds,
      commentIds,
      db,
      importBatchIds,
      portfolioId,
      standingOrderIds,
    }) => {
      const resourceIds = [
        portfolioId,
        ...cashBudgetIds,
        ...cashMovementIds,
        ...commentIds,
        ...importBatchIds,
        ...standingOrderIds,
      ];
      return scalarCount(
        db
          .select({ value: count() })
          .from(idempotencyKeys)
          .where(
            or(
              ...resourceIds.flatMap((id) => [
                eq(idempotencyKeys.path, `/${id}`),
                like(idempotencyKeys.path, `%/${id}/%`),
                like(idempotencyKeys.path, `%/${id}`),
                // The memoized body is replayed byte-for-byte, so resource ids
                // inside it are cleartext residue even when the route path was
                // indirect or account-scoped.
                like(idempotencyKeys.responseBody, `%${id}%`),
              ]),
            ),
          ),
      );
    },
  },

  // Common-document rows are account-owned. Counting them against one member
  // would incorrectly condemn cleartext needed by a normal sibling portfolio.
  user_tax_settings: {
    kind: 'not-probed',
    scope: 'common',
    reason:
      'Tax defaults are keyed by user, not portfolio, and belong to the vault common document rather than one locked member.',
  },
  assets: {
    kind: 'not-probed',
    scope: 'common',
    reason:
      'Custom assets are account-owned catalog rows that may be referenced by normal sibling portfolios; they belong to the common document.',
  },
  price_history: {
    kind: 'not-probed',
    scope: 'common',
    reason:
      'Custom-asset values follow account-owned assets and cannot be attributed to one portfolio without breaking normal siblings.',
  },
  expense_categories: {
    kind: 'not-probed',
    scope: 'common',
    reason: 'The legacy expense island is keyed by user and has no portfolio reference.',
  },
  expense_transactions: {
    kind: 'not-probed',
    scope: 'common',
    reason: 'Expense transactions are keyed by user and have no portfolio reference.',
  },
  expense_rules: {
    kind: 'not-probed',
    scope: 'common',
    reason: 'Expense rules are account-scoped configuration with no portfolio reference.',
  },
  expense_budgets: {
    kind: 'not-probed',
    scope: 'common',
    reason: 'Expense budgets follow account-scoped expense categories, not a portfolio.',
  },
  expense_budget_fires: {
    kind: 'not-probed',
    scope: 'common',
    reason: 'Expense budget fire markers follow account-scoped expense budgets.',
  },
  cash_tags: {
    kind: 'not-probed',
    scope: 'common',
    reason: 'Cash tags are reusable account vocabulary shared by normal sibling portfolios.',
  },
  cash_rules: {
    kind: 'not-probed',
    scope: 'common',
    reason: 'Cash auto-tagging rules are user-scoped and shared by every portfolio.',
  },
  cash_rule_tags: {
    kind: 'not-probed',
    scope: 'common',
    reason: 'Cash rule-tag links follow the account-scoped rules and tags on both sides.',
  },

  // Request-log rows retain their concrete route and are therefore attributable
  // to a portfolio. Usage telemetry has no equivalent portfolio discriminator.
  api_key_request_log: {
    kind: 'probe',
    scope: 'path',
    probe: ({
      cashBudgetIds,
      cashMovementIds,
      commentIds,
      db,
      importBatchIds,
      portfolioId,
      standingOrderIds,
    }) => {
      const resourceIds = [
        portfolioId,
        ...cashBudgetIds,
        ...cashMovementIds,
        ...commentIds,
        ...importBatchIds,
        ...standingOrderIds,
      ];
      return scalarCount(
        db
          .select({ value: count() })
          .from(apiKeyRequestLog)
          .where(
            or(
              ...resourceIds.flatMap((id) => [
                eq(apiKeyRequestLog.path, `/${id}`),
                like(apiKeyRequestLog.path, `%/${id}/%`),
                like(apiKeyRequestLog.path, `%/${id}`),
              ]),
            ),
          ),
      );
    },
  },
  usage_events: {
    kind: 'not-probed',
    scope: 'account',
    reason:
      'Usage telemetry is keyed by account and optional asset, not portfolio; quote-roster suppression is enforced by its dedicated account-any-vault policy.',
  },
};

export const VAULTED_PORTFOLIO_PROBE_TABLE_NAMES: readonly string[] = Object.entries(
  VAULTED_PORTFOLIO_CLEARTEXT_REGISTRY,
)
  .filter(([, entry]) => entry.kind === 'probe')
  .map(([table]) => table)
  .sort();

/** Fail closed when a purge/residue roster or the document-bucket axis changes. */
export function assertVaultedPortfolioProbeCompleteness(): void {
  const expected = [
    ...new Set([...PARANOID_PURGED_TABLE_NAMES, ...VAULTED_PORTFOLIO_SERVER_RESIDUE_TABLE_NAMES]),
  ].sort();
  const actual = Object.keys(VAULTED_PORTFOLIO_CLEARTEXT_REGISTRY).sort();
  if (actual.join('\0') !== expected.join('\0')) {
    throw new Error(
      'vaulted portfolio cleartext registry disagrees with its required table rosters: ' +
        `${actual.join(', ')} vs ${expected.join(', ')}`,
    );
  }

  for (const table of expected) {
    const entry = VAULTED_PORTFOLIO_CLEARTEXT_REGISTRY[table];
    if (!entry) throw new Error(`vaulted portfolio cleartext registry omitted ${table}`);

    const bucket = PARANOID_VAULT_DOC_BUCKETS[table];
    const mustProbe =
      table === 'portfolios' ||
      table === 'api_key_request_log' ||
      VAULTED_PORTFOLIO_SERVER_RESIDUE_TABLE_NAMES.some((name) => name === table) ||
      bucket === 'portfolio';
    if (mustProbe !== (entry.kind === 'probe')) {
      throw new Error(
        `${table} has bucket ${bucket ?? 'server-residue'} but per-portfolio policy ${entry.kind}`,
      );
    }

    if (entry.kind === 'not-probed') {
      if (entry.reason.trim().length === 0) {
        throw new Error(`${table} needs a non-empty per-portfolio exclusion reason`);
      }
      const expectedScope = bucket === 'common' ? 'common' : 'account';
      if (entry.scope !== expectedScope) {
        throw new Error(`${table} has non-probe scope ${entry.scope}; expected ${expectedScope}`);
      }
    }
  }
}

export async function collectVaultedPortfolioProbeScope(
  db: Database,
  portfolioId: string,
): Promise<VaultedPortfolioProbeScope> {
  const [movements, budgets, orders, batches, audiences, comments] = await Promise.all([
    db
      .select({ id: portfolioCashMovements.id })
      .from(portfolioCashMovements)
      .where(eq(portfolioCashMovements.portfolioId, portfolioId)),
    db
      .select({ id: cashBudgets.id })
      .from(cashBudgets)
      .where(eq(cashBudgets.portfolioId, portfolioId)),
    db
      .select({ id: standingOrders.id })
      .from(standingOrders)
      .where(eq(standingOrders.portfolioId, portfolioId)),
    db
      .select({ id: importBatches.id })
      .from(importBatches)
      .where(eq(importBatches.portfolioId, portfolioId)),
    db
      .select({ id: shareAudiences.id })
      .from(shareAudiences)
      .where(and(eq(shareAudiences.kind, 'portfolio'), eq(shareAudiences.subjectId, portfolioId))),
    db
      .select({ id: itemComments.id })
      .from(itemComments)
      .where(and(eq(itemComments.kind, 'portfolio'), eq(itemComments.subjectId, portfolioId))),
  ]);
  return {
    db,
    portfolioId,
    cashMovementIds: movements.map(({ id }) => id),
    cashBudgetIds: budgets.map(({ id }) => id),
    standingOrderIds: orders.map(({ id }) => id),
    importBatchIds: batches.map(({ id }) => id),
    audienceIds: audiences.map(({ id }) => id),
    commentIds: comments.map(({ id }) => id),
  };
}

export type VaultedPortfolioCleartextCounts = Readonly<Record<string, number>>;

/** Count every direct and transitive cleartext row belonging to one portfolio. */
export async function probeVaultedPortfolioCleartext(
  db: Database,
  portfolioId: string,
): Promise<VaultedPortfolioCleartextCounts> {
  assertVaultedPortfolioProbeCompleteness();
  const scope = await collectVaultedPortfolioProbeScope(db, portfolioId);
  return probeVaultedPortfolioCleartextFromScope(scope);
}

/** Count residue using the pre-purge transitive-id graph. */
export async function probeVaultedPortfolioCleartextFromScope(
  scope: VaultedPortfolioProbeScope,
): Promise<VaultedPortfolioCleartextCounts> {
  assertVaultedPortfolioProbeCompleteness();
  const counts: Record<string, number> = {};
  for (const table of VAULTED_PORTFOLIO_PROBE_TABLE_NAMES) {
    const entry = VAULTED_PORTFOLIO_CLEARTEXT_REGISTRY[table];
    if (!entry || entry.kind !== 'probe') {
      throw new Error(`vaulted portfolio probe handler missing for ${table}`);
    }
    counts[table] = await entry.probe(scope);
  }
  return counts;
}

/** Throw with every offending table, suitable for E4's move-in transaction. */
export function assertVaultedPortfolioCleartextCounts(
  counts: VaultedPortfolioCleartextCounts,
): void {
  const actual = Object.keys(counts).sort();
  if (actual.join('\0') !== VAULTED_PORTFOLIO_PROBE_TABLE_NAMES.join('\0')) {
    throw new Error(
      'vaulted portfolio cleartext counts disagree with the probe registry: ' +
        `${actual.join(', ')} vs ${VAULTED_PORTFOLIO_PROBE_TABLE_NAMES.join(', ')}`,
    );
  }
  const remaining = VAULTED_PORTFOLIO_PROBE_TABLE_NAMES.filter(
    (table) => !Number.isFinite(counts[table]) || counts[table]! !== 0,
  );
  if (remaining.length > 0) {
    throw new Error(
      'vaulted portfolio zero-cleartext probe failed: ' +
        remaining.map((table) => `${table}=${String(counts[table])}`).join(', '),
    );
  }
}

/** Probe and throw in one call; no writes or deletes are performed. */
export async function assertVaultedPortfolioHasNoCleartext(
  db: Database,
  portfolioId: string,
): Promise<void> {
  assertVaultedPortfolioCleartextCounts(await probeVaultedPortfolioCleartext(db, portfolioId));
}

/** E4 commit oracle using the ownership graph captured before its first delete. */
export async function assertVaultedPortfolioScopeHasNoCleartext(
  scope: VaultedPortfolioProbeScope,
): Promise<void> {
  assertVaultedPortfolioCleartextCounts(await probeVaultedPortfolioCleartextFromScope(scope));
}
