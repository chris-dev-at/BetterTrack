import { createHash } from 'node:crypto';

import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  like,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import {
  readVaultDocServerHeader,
  serializeVaultRetirementVersionSet,
  type VaultStrictEntity,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  apiKeyRequestLog,
  assetIdentities,
  assets,
  auditLog,
  cashBudgetFires,
  cashBudgets,
  cashMovementTags,
  cashTags,
  dividends,
  exportJobs,
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
  portfolioVaultTransitionStates,
  portfolios,
  priceHistory,
  shareAudienceLinks,
  shareAudienceMembers,
  shareAudiences,
  sharedItemActivityPrefs,
  standingOrderRuns,
  standingOrders,
  transactions,
  users,
  vaultBlobHistory,
  vaultBlobs,
  vaultRetired,
  vaultServerCandidates,
  vaults,
  type PortfolioRow,
  type PortfolioVaultTransitionStateRow,
  type UserRow,
  type VaultRow,
} from '../schema';
import {
  assertVaultedPortfolioProbeCompleteness,
  assertVaultedPortfolioScopeHasNoCleartext,
  collectVaultedPortfolioProbeScope,
  vaultedPortfolioStubName,
  type VaultedPortfolioProbeScope,
} from './vaultedPortfolioProbe';
import { PARANOID_RETIRED_EXPORT_ERROR } from './paranoidTransitionRepository';

type Entity = VaultStrictEntity;
type EntityOf<K extends Entity['kind']> = Extract<Entity, { kind: K }>;

const EMPTY_DIGEST = '-';
const rowsDigest = (table: PgTable) =>
  sql<string>`coalesce(md5(string_agg(md5(${table}::text), ',' order by md5(${table}::text))), ${EMPTY_DIGEST})`;

async function digest(query: PromiseLike<Array<{ value: string | null }>>): Promise<string> {
  const [row] = await query;
  return row?.value ?? EMPTY_DIGEST;
}

async function digestByIds(
  ids: readonly string[],
  query: (ids: string[]) => PromiseLike<Array<{ value: string | null }>>,
): Promise<string> {
  return ids.length === 0 ? EMPTY_DIGEST : digest(query([...ids]));
}

/**
 * E4's capture digest. Whole-row hashes make every column part of the CAS and
 * the fixed table roster is exactly the source graph move-out recreates. Derived
 * snapshots and fired markers are excluded; historical imports are included by
 * the E4 ruling because they ride the portfolio document and are restored.
 */
export async function computePortfolioDataRevision(
  db: Database,
  userId: string,
  portfolioId: string,
): Promise<string | null> {
  const [portfolio] = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
    .limit(1);
  if (!portfolio) return null;

  const [movementRows, budgetRows, orderRows, batchRows, referencedOwnedManualAssetIds] =
    await Promise.all([
      db
        .select({ id: portfolioCashMovements.id })
        .from(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, portfolioId)),
      db
        .select({ id: cashBudgets.id, tagId: cashBudgets.tagId })
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
      collectReferencedOwnedManualAssetIds(db, userId, portfolioId),
    ]);
  const movementIds = movementRows.map(({ id }) => id);
  const budgetIds = budgetRows.map(({ id }) => id);
  const orderIds = orderRows.map(({ id }) => id);
  const batchIds = batchRows.map(({ id }) => id);
  const movementTagRows =
    movementIds.length === 0
      ? []
      : await db
          .select({ tagId: cashMovementTags.tagId })
          .from(cashMovementTags)
          .where(inArray(cashMovementTags.movementId, movementIds));
  const referencedCashTagIds = [
    ...new Set([
      ...movementTagRows.map(({ tagId }) => tagId),
      ...budgetRows.map(({ tagId }) => tagId),
    ]),
  ].sort();

  // This is the exact logical projection exposed by
  // `listRetainedForkProvenance`, narrowed to this target portfolio. Hashing
  // the joined membership id matters: after a rejoin, the same mirror row can
  // be authenticated by a different ended membership tombstone/watermark.
  const forkProvenanceRow = sql`
    jsonb_build_object(
      'chainId', ${mirrorRows.chainId},
      'membershipId', ${mirrorChainMembers.id},
      'kind', ${mirrorRows.kind},
      'mirrorId', ${mirrorRows.mirrorId},
      'portfolioId', ${mirrorRows.portfolioId},
      'localId', ${mirrorRows.localId}
    )
  `;
  const forkProvenanceDigest = sql<string>`coalesce(
    md5(string_agg(md5(${forkProvenanceRow}::text), ',' order by md5(${forkProvenanceRow}::text))),
    ${EMPTY_DIGEST}
  )`;

  const parts = await Promise.all([
    digest(
      db
        .select({ value: rowsDigest(portfolios) })
        .from(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId))),
    ),
    digest(
      db
        .select({ value: rowsDigest(transactions) })
        .from(transactions)
        .where(eq(transactions.portfolioId, portfolioId)),
    ),
    digest(
      db
        .select({ value: rowsDigest(dividends) })
        .from(dividends)
        .where(eq(dividends.portfolioId, portfolioId)),
    ),
    digest(
      db
        .select({ value: rowsDigest(portfolioCashSources) })
        .from(portfolioCashSources)
        .where(eq(portfolioCashSources.portfolioId, portfolioId)),
    ),
    digest(
      db
        .select({ value: rowsDigest(portfolioCashMovements) })
        .from(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, portfolioId)),
    ),
    digest(
      db
        .select({ value: rowsDigest(portfolioSettings) })
        .from(portfolioSettings)
        .where(eq(portfolioSettings.portfolioId, portfolioId)),
    ),
    digest(
      db
        .select({ value: rowsDigest(standingOrders) })
        .from(standingOrders)
        .where(eq(standingOrders.portfolioId, portfolioId)),
    ),
    digestByIds(orderIds, (ids) =>
      db
        .select({ value: rowsDigest(standingOrderRuns) })
        .from(standingOrderRuns)
        .where(inArray(standingOrderRuns.standingOrderId, ids)),
    ),
    digestByIds(movementIds, (ids) =>
      db
        .select({ value: rowsDigest(cashMovementTags) })
        .from(cashMovementTags)
        .where(inArray(cashMovementTags.movementId, ids)),
    ),
    digest(
      db
        .select({ value: rowsDigest(cashBudgets) })
        .from(cashBudgets)
        .where(eq(cashBudgets.portfolioId, portfolioId)),
    ),
    digestByIds(budgetIds, (ids) =>
      db
        .select({ value: rowsDigest(cashBudgetFires) })
        .from(cashBudgetFires)
        // Fires are derived, but including the empty/derived branch here would
        // manufacture capture conflicts. Keep the expression structurally empty.
        .where(and(inArray(cashBudgetFires.budgetId, ids), sql`false`)),
    ),
    digest(
      db
        .select({ value: rowsDigest(importBatches) })
        .from(importBatches)
        .where(eq(importBatches.portfolioId, portfolioId)),
    ),
    digestByIds(batchIds, (ids) =>
      db
        .select({ value: rowsDigest(importRows) })
        .from(importRows)
        .where(inArray(importRows.batchId, ids)),
    ),
    digestByIds(referencedOwnedManualAssetIds, (ids) =>
      db
        .select({ value: rowsDigest(assets) })
        .from(assets)
        .where(inArray(assets.id, ids)),
    ),
    digestByIds(referencedOwnedManualAssetIds, (ids) =>
      db
        .select({ value: rowsDigest(priceHistory) })
        .from(priceHistory)
        .where(inArray(priceHistory.assetId, ids)),
    ),
    digestByIds(referencedCashTagIds, (ids) =>
      db
        .select({ value: rowsDigest(cashTags) })
        .from(cashTags)
        .where(inArray(cashTags.id, ids)),
    ),
    digest(
      db
        .select({ value: forkProvenanceDigest })
        .from(mirrorRows)
        .innerJoin(portfolios, eq(portfolios.id, mirrorRows.portfolioId))
        .innerJoin(
          mirrorChainMembers,
          and(
            eq(mirrorChainMembers.chainId, mirrorRows.chainId),
            eq(mirrorChainMembers.portfolioId, mirrorRows.portfolioId),
            eq(mirrorChainMembers.userId, userId),
            ne(mirrorChainMembers.status, 'active'),
          ),
        )
        .where(and(eq(portfolios.userId, userId), eq(mirrorRows.portfolioId, portfolioId))),
    ),
  ]);

  const labels = [
    'portfolios',
    'transactions',
    'dividends',
    'portfolio_cash_sources',
    'portfolio_cash_movements',
    'portfolio_settings',
    'standing_orders',
    'standing_order_runs',
    'cash_movement_tags',
    'cash_budgets',
    'cash_budget_fires:excluded',
    'import_batches',
    'import_rows',
    'referenced_owned_manual_assets',
    'referenced_owned_manual_asset_values',
    'referenced_cash_tags',
    'retained_fork_provenance',
  ];
  return createHash('sha256')
    .update(parts.map((part, index) => `${labels[index]}=${part}`).join('\n'))
    .digest('base64url');
}

/**
 * Historical import batches keyed to the portfolio (E6 residual, #1525).
 * They are part of the capture digest above, but this build has no client
 * read path for their staging rows — the revision response surfaces the
 * count so the client capture can refuse losslessly instead of purging rows
 * its encrypted document never carried. Run inside the SAME snapshot
 * transaction as the digest so the pair cannot tear.
 */
export async function countPortfolioImportBatches(
  db: Database,
  portfolioId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(importBatches)
    .where(eq(importBatches.portfolioId, portfolioId));
  return Number(row?.value ?? 0);
}

export type PortfolioVaultLifecycleRead =
  | { status: 'ok'; vaultId: string; lifecycleGeneration: number }
  | { status: 'not_found' }
  | { status: 'not_vaulted' }
  | { status: 'inconsistent' };

/**
 * Owner-scoped read of a vaulted portfolio's current membership lifecycle
 * (E6 residual, #1525). §10 allows move-out from ANY unlocked device holding
 * the phrase, and the move-out challenge/commit both bind the proof to the
 * exact server-minted generation — which only the moving device ever received.
 * The value is transition metadata about the locked stub (it already rides the
 * owner's own audit records), never portfolio content. Plain reads, no locks:
 * a stale answer only makes the later challenge refuse, exactly like any other
 * CAS input read outside the commit lock.
 */
export async function readPortfolioVaultLifecycle(
  db: Database,
  userId: string,
  portfolioId: string,
): Promise<PortfolioVaultLifecycleRead> {
  const [portfolio] = await db
    .select({ id: portfolios.id, vaultId: portfolios.vaultId })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
    .limit(1);
  if (!portfolio) return { status: 'not_found' };
  if (portfolio.vaultId === null) return { status: 'not_vaulted' };
  const [state] = await db
    .select({
      lifecycleGeneration: portfolioVaultTransitionStates.lifecycleGeneration,
      moveInVaultId: portfolioVaultTransitionStates.moveInVaultId,
      moveInCompletedAt: portfolioVaultTransitionStates.moveInCompletedAt,
    })
    .from(portfolioVaultTransitionStates)
    .where(
      and(
        eq(portfolioVaultTransitionStates.portfolioId, portfolioId),
        eq(portfolioVaultTransitionStates.userId, userId),
      ),
    )
    .limit(1);
  if (
    !state ||
    state.moveInVaultId !== portfolio.vaultId ||
    state.moveInCompletedAt === null ||
    state.lifecycleGeneration < 1
  ) {
    return { status: 'inconsistent' };
  }
  return {
    status: 'ok',
    vaultId: portfolio.vaultId,
    lifecycleGeneration: state.lifecycleGeneration,
  };
}

export interface LockedPortfolioVaultOwner {
  passwordHash: string;
  twoFactorSecret: string | null;
  twoFactorEnabled: boolean;
  twoFactorEmailEnabled: boolean;
}

export type PortfolioVaultMoveInBlocker =
  | 'active_mirrorchain'
  | 'pending_import'
  | 'pending_export'
  | null;

export interface PortfolioVaultDocumentVerification {
  mediaReady: boolean;
  portfolioVersion: number | null;
  exactRoster: boolean;
}

export interface PortfolioVaultDocumentSetVerification {
  mediaReady: boolean;
  exactRoster: boolean;
  documentSetHash: string | null;
}

export interface PortfolioVaultPurgeScope extends VaultedPortfolioProbeScope {
  /** Owner account whose exclusive custom-asset set was frozen. */
  userId: string;
  /**
   * Owner-manual assets referenced by this portfolio and by no sibling at the
   * instant the destructive scope is frozen. Their content rows move into the
   * common ciphertext; the opaque owner claim remains for same-UUID restore,
   * including when no alert/workboard/conglomerate row happens to pin it.
   */
  exclusiveCustomAssetIds: readonly string[];
}

export interface PortfolioVaultCleartextExportArtifact {
  id: string;
  filePath: string;
}

/** Durable, content-free work needed before a restored portfolio is un-killed. */
export interface PendingPortfolioVaultMoveOutFinalization {
  userId: string;
  portfolioId: string;
  vaultId: string;
  lifecycleGeneration: number;
  customAssetIds: readonly string[];
  completedAt: Date;
}

export interface PortfolioVaultTransitionTransactionRepository {
  lockOwner(userId: string): Promise<LockedPortfolioVaultOwner | null>;
  lockPortfolio(userId: string, portfolioId: string): Promise<PortfolioRow | null>;
  lockVault(userId: string, vaultId: string): Promise<VaultRow | null>;
  lockTransitionState(portfolioId: string): Promise<PortfolioVaultTransitionStateRow | null>;
  blocker(userId: string, portfolioId: string): Promise<PortfolioVaultMoveInBlocker>;
  verifyMoveInDocuments(input: {
    vault: VaultRow;
    portfolioId: string;
    docVersion: number;
    now: Date;
    state: PortfolioVaultTransitionStateRow;
  }): Promise<PortfolioVaultDocumentVerification>;
  verifyMoveOutDocuments(input: {
    vault: VaultRow;
    portfolioId: string;
    now: Date;
  }): Promise<PortfolioVaultDocumentSetVerification>;
  /** Whole-account ZIPs can contain this portfolio, regardless of job age/status. */
  lockCleartextExports(userId: string): Promise<readonly PortfolioVaultCleartextExportArtifact[]>;
  retireCleartextExports(userId: string, exportIds: readonly string[]): Promise<void>;
  finalizeRetiredCleartextExports(userId: string, exportIds: readonly string[]): Promise<void>;
  capturePurgeScope(userId: string, portfolioId: string): Promise<PortfolioVaultPurgeScope>;
  purgePortfolio(input: {
    userId: string;
    portfolioId: string;
    vaultId: string;
    vaultAlias: string;
    scope: PortfolioVaultPurgeScope;
  }): Promise<void>;
  completeMoveIn(input: {
    userId: string;
    portfolioId: string;
    vaultId: string;
    docVersion: number;
    lifecycleGeneration: number;
    retiredCustomAssetIds: readonly string[];
    completedAt: Date;
  }): Promise<void>;
  archiveAndRemovePortfolioDocument(input: {
    vaultId: string;
    portfolioId: string;
    now: Date;
    historyMaxVersions: number;
    historyMaxAgeMs: number;
  }): Promise<'ok' | 'conflict'>;
  completeMoveOut(input: {
    userId: string;
    portfolioId: string;
    vaultId: string;
    moveOutId: string;
    lifecycleGeneration: number;
    documentDigest: string;
    documentSetHash: string;
    proofPublicKey: string;
    customAssetIds: readonly string[];
    completedAt: Date;
  }): Promise<void>;
}

function pathResidueCondition(
  pathColumn: typeof apiKeyRequestLog.path | typeof idempotencyKeys.path | SQL<string>,
  resourceIds: readonly string[],
) {
  return or(
    ...resourceIds.flatMap((id) => [
      sql<boolean>`${pathColumn} = ${`/${id}`}`,
      sql<boolean>`${pathColumn} like ${`%/${id}/%`}`,
      sql<boolean>`${pathColumn} like ${`%/${id}`}`,
    ]),
  )!;
}

async function collectReferencedOwnedManualAssetIds(
  db: Database,
  userId: string,
  portfolioId: string,
): Promise<string[]> {
  const [transactionAssets, dividendAssets, orderAssets, importAssets] = await Promise.all([
    db
      .select({ assetId: transactions.assetId })
      .from(transactions)
      .where(eq(transactions.portfolioId, portfolioId)),
    db
      .select({ assetId: dividends.assetId })
      .from(dividends)
      .where(eq(dividends.portfolioId, portfolioId)),
    db
      .select({ assetId: standingOrders.assetId })
      .from(standingOrders)
      .where(and(eq(standingOrders.portfolioId, portfolioId), isNotNull(standingOrders.assetId))),
    db
      .select({ assetId: importRows.assetId })
      .from(importRows)
      .innerJoin(importBatches, eq(importBatches.id, importRows.batchId))
      .where(and(eq(importBatches.portfolioId, portfolioId), isNotNull(importRows.assetId))),
  ]);
  const referencedIds = [
    ...new Set(
      [...transactionAssets, ...dividendAssets, ...orderAssets, ...importAssets]
        .map(({ assetId }) => assetId)
        .filter((assetId): assetId is string => assetId !== null),
    ),
  ];
  if (referencedIds.length === 0) return [];

  const ownedManual = await db
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        inArray(assets.id, referencedIds),
        eq(assets.ownerId, userId),
        eq(assets.providerId, 'manual'),
      ),
    );
  return ownedManual.map(({ id }) => id).sort();
}

async function collectExclusiveCustomAssetIds(
  db: Database,
  userId: string,
  portfolioId: string,
): Promise<string[]> {
  const ownedIds = await collectReferencedOwnedManualAssetIds(db, userId, portfolioId);
  if (ownedIds.length === 0) return [];

  const [siblingTransactions, siblingDividends, siblingOrders, siblingImports] = await Promise.all([
    db
      .select({ assetId: transactions.assetId })
      .from(transactions)
      .where(
        and(inArray(transactions.assetId, ownedIds), ne(transactions.portfolioId, portfolioId)),
      ),
    db
      .select({ assetId: dividends.assetId })
      .from(dividends)
      .where(and(inArray(dividends.assetId, ownedIds), ne(dividends.portfolioId, portfolioId))),
    db
      .select({ assetId: standingOrders.assetId })
      .from(standingOrders)
      .where(
        and(inArray(standingOrders.assetId, ownedIds), ne(standingOrders.portfolioId, portfolioId)),
      ),
    db
      .select({ assetId: importRows.assetId })
      .from(importRows)
      .innerJoin(importBatches, eq(importBatches.id, importRows.batchId))
      .where(
        and(inArray(importRows.assetId, ownedIds), ne(importBatches.portfolioId, portfolioId)),
      ),
  ]);
  const siblingIds = new Set(
    [...siblingTransactions, ...siblingDividends, ...siblingOrders, ...siblingImports]
      .map(({ assetId }) => assetId)
      .filter((assetId): assetId is string => assetId !== null),
  );
  return ownedIds.filter((id) => !siblingIds.has(id)).sort();
}

function strictHeader(row: { blob: Buffer }) {
  try {
    return readVaultDocServerHeader(row.blob);
  } catch {
    return null;
  }
}

function exactDocumentRoster(
  vault: VaultRow,
  memberIds: readonly string[],
  rows: readonly { docId: string; portfolioId?: string | null; blob: Buffer; version: number }[],
): boolean {
  const expected = new Map<
    string,
    { kind: 'header' | 'common' | 'portfolio'; portfolioId: string | null }
  >([
    [vault.headerDocId, { kind: 'header', portfolioId: null }],
    [vault.commonDocId, { kind: 'common', portfolioId: null }],
    ...memberIds.map((id) => [id, { kind: 'portfolio' as const, portfolioId: id }] as const),
  ]);
  if (expected.size !== rows.length) return false;
  return rows.every((row) => {
    const wanted = expected.get(row.docId);
    const header = strictHeader(row);
    return Boolean(
      wanted &&
      header &&
      header.vaultId === vault.id &&
      header.docId === row.docId &&
      header.docKind === wanted.kind &&
      (row.portfolioId === undefined || row.portfolioId === wanted.portfolioId) &&
      header.docVersion === row.version,
    );
  });
}

function documentSetHash(rows: readonly { docId: string; version: number }[]): string {
  return createHash('sha256')
    .update(
      serializeVaultRetirementVersionSet(
        rows.map((row) => ({ docId: row.docId, docVersion: row.version })),
      ),
    )
    .digest('base64url');
}

export function createPortfolioVaultTransitionTransactionRepository(
  tx: Database,
): PortfolioVaultTransitionTransactionRepository {
  return {
    async lockOwner(userId) {
      const [owner] = await tx
        .select({
          passwordHash: users.passwordHash,
          twoFactorSecret: users.twoFactorSecret,
          twoFactorEnabled: users.twoFactorEnabled,
          twoFactorEmailEnabled: users.twoFactorEmailEnabled,
        })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      return owner ?? null;
    },

    async lockPortfolio(userId, portfolioId) {
      const [portfolio] = await tx
        .select()
        .from(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
        .for('update');
      return portfolio ?? null;
    },

    async lockVault(userId, vaultId) {
      const [vault] = await tx
        .select()
        .from(vaults)
        .where(and(eq(vaults.id, vaultId), eq(vaults.userId, userId)))
        .for('update');
      return vault ?? null;
    },

    async lockTransitionState(portfolioId) {
      const [state] = await tx
        .select()
        .from(portfolioVaultTransitionStates)
        .where(eq(portfolioVaultTransitionStates.portfolioId, portfolioId))
        .for('update');
      return state ?? null;
    },

    async blocker(userId, portfolioId) {
      const [mirror, pendingImport, pendingExport] = await Promise.all([
        tx
          .select({ value: count() })
          .from(mirrorChainMembers)
          .where(
            and(
              eq(mirrorChainMembers.portfolioId, portfolioId),
              eq(mirrorChainMembers.status, 'active'),
            ),
          ),
        tx
          .select({ value: count() })
          .from(importBatches)
          .where(
            and(eq(importBatches.portfolioId, portfolioId), eq(importBatches.status, 'pending')),
          ),
        tx
          .select({ value: count() })
          .from(exportJobs)
          .where(and(eq(exportJobs.userId, userId), eq(exportJobs.status, 'pending'))),
      ]);
      if (Number(mirror[0]?.value ?? 0) > 0) return 'active_mirrorchain';
      if (Number(pendingImport[0]?.value ?? 0) > 0) return 'pending_import';
      if (Number(pendingExport[0]?.value ?? 0) > 0) return 'pending_export';
      return null;
    },

    async verifyMoveInDocuments({ vault, portfolioId, docVersion, now, state }) {
      const mediaReady =
        state.captureRevision !== null &&
        state.captureExpiresAt !== null &&
        state.captureExpiresAt.getTime() > now.getTime() &&
        state.captureVaultId === vault.id &&
        state.captureMediaAttestedAt !== null &&
        // The prospective first write snapshots the previously-live target and
        // then invalidates this current proof. Requiring both prevents a
        // server+Drive vault from committing after only its server bytes were
        // replaced; E1 must first attest the final full doc set again.
        vault.mediaAttestedAt !== null &&
        (!vault.media.includes('drive') ||
          (state.captureMediaAttestedDriveConnectionId === vault.driveConnectionId &&
            vault.mediaAttestedDriveConnectionId === vault.driveConnectionId));
      if (!mediaReady) return { mediaReady: false, portfolioVersion: null, exactRoster: false };

      const members = await tx
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(and(eq(portfolios.userId, vault.userId), eq(portfolios.vaultId, vault.id)))
        .orderBy(asc(portfolios.id));
      const memberIds = [...new Set([...members.map(({ id }) => id), portfolioId])].sort();
      if (vault.media.includes('server')) {
        const active = await tx
          .select()
          .from(vaultBlobs)
          .where(eq(vaultBlobs.vaultId, vault.id))
          .orderBy(asc(vaultBlobs.docId))
          .for('update');
        const portfolio = active.find((row) => row.docId === portfolioId);
        return {
          mediaReady,
          portfolioVersion: portfolio?.version ?? null,
          exactRoster:
            portfolio?.version === docVersion && exactDocumentRoster(vault, memberIds, active),
        };
      }

      // Drive-only still stages one inactive, readback-capable ciphertext set.
      // It never activates the server medium; it exists only so the destructive
      // commit can prove an exact R1-addressed document roster before deleting.
      const candidates = await tx
        .select()
        .from(vaultServerCandidates)
        .where(eq(vaultServerCandidates.vaultId, vault.id))
        .orderBy(asc(vaultServerCandidates.docId))
        .for('update');
      const live = candidates.filter((row) => row.expiresAt.getTime() > now.getTime());
      const transitionIds = new Set(live.map((row) => row.transitionId));
      const portfolio = live.find((row) => row.docId === portfolioId);
      return {
        mediaReady,
        portfolioVersion: portfolio?.version ?? null,
        exactRoster:
          portfolio?.version === docVersion &&
          transitionIds.size === 1 &&
          !transitionIds.has(null) &&
          exactDocumentRoster(vault, memberIds, live),
      };
    },

    async verifyMoveOutDocuments({ vault, portfolioId, now }) {
      const expectedDriveConnectionId = vault.media.includes('drive')
        ? vault.driveConnectionId
        : null;
      const mediaReady =
        vault.mediaAttestedAt !== null &&
        vault.mediaAttestedDriveConnectionId === expectedDriveConnectionId;
      if (!mediaReady) {
        return { mediaReady: false, exactRoster: false, documentSetHash: null };
      }

      const members = await tx
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(and(eq(portfolios.userId, vault.userId), eq(portfolios.vaultId, vault.id)))
        .orderBy(asc(portfolios.id));
      if (!members.some(({ id }) => id === portfolioId)) {
        return { mediaReady, exactRoster: false, documentSetHash: null };
      }
      const memberIds = members.map(({ id }) => id);

      // With an active server medium, lock and re-enumerate the exact current
      // roster. The version-set digest is the destructive move-out CAS: the
      // service must commit the same value into the durable receipt.
      if (vault.media.includes('server')) {
        const active = await tx
          .select()
          .from(vaultBlobs)
          .where(eq(vaultBlobs.vaultId, vault.id))
          .orderBy(asc(vaultBlobs.docId))
          .for('update');
        const exactRoster = exactDocumentRoster(vault, memberIds, active);
        return {
          mediaReady,
          exactRoster,
          documentSetHash: exactRoster ? documentSetHash(active) : null,
        };
      }

      // Drive-only move-out cannot trust the attestation timestamp alone. Its
      // current document set is the one full, readback-capable candidate batch:
      // every row must still be live, share one non-null transition id, and
      // exactly cover the vault's required R1-addressed roster.
      if (!vault.media.includes('drive')) {
        return { mediaReady: false, exactRoster: false, documentSetHash: null };
      }
      const candidates = await tx
        .select()
        .from(vaultServerCandidates)
        .where(eq(vaultServerCandidates.vaultId, vault.id))
        .orderBy(asc(vaultServerCandidates.docId))
        .for('update');
      const live = candidates.filter((row) => row.expiresAt.getTime() > now.getTime());
      const transitionIds = new Set(live.map((row) => row.transitionId));
      const attestedAtMs = vault.mediaAttestedAt?.getTime();
      const exactRoster =
        transitionIds.size === 1 &&
        !transitionIds.has(null) &&
        // A batch staged after the last Drive refresh cannot borrow that stale
        // attestation. Same-millisecond rows remain valid because the refresh
        // and its verified candidate reads share one transaction clock sample.
        attestedAtMs !== undefined &&
        live.every((row) => row.createdAt.getTime() <= attestedAtMs) &&
        exactDocumentRoster(vault, memberIds, live);
      return {
        mediaReady,
        exactRoster,
        documentSetHash: exactRoster ? documentSetHash(live) : null,
      };
    },

    async lockCleartextExports(userId) {
      const rows = await tx
        .select({ id: exportJobs.id, filePath: exportJobs.filePath })
        .from(exportJobs)
        .where(eq(exportJobs.userId, userId))
        .for('update');
      return rows.filter((row): row is typeof row & { filePath: string } => row.filePath !== null);
    },

    async retireCleartextExports(userId, exportIds) {
      if (exportIds.length === 0) return;
      await tx
        .update(exportJobs)
        .set({
          status: 'failed',
          fileSize: null,
          downloadTokenHash: null,
          expiresAt: null,
          readyAt: null,
          error: PARANOID_RETIRED_EXPORT_ERROR,
        })
        .where(and(eq(exportJobs.userId, userId), inArray(exportJobs.id, [...exportIds])));
    },

    async finalizeRetiredCleartextExports(userId, exportIds) {
      if (exportIds.length === 0) return;
      await tx
        .update(exportJobs)
        .set({ filePath: null })
        .where(
          and(
            eq(exportJobs.userId, userId),
            inArray(exportJobs.id, [...exportIds]),
            eq(exportJobs.error, PARANOID_RETIRED_EXPORT_ERROR),
          ),
        );
    },

    async capturePurgeScope(userId, portfolioId) {
      assertVaultedPortfolioProbeCompleteness();
      const [scope, exclusiveCustomAssetIds] = await Promise.all([
        collectVaultedPortfolioProbeScope(tx, portfolioId),
        collectExclusiveCustomAssetIds(tx, userId, portfolioId),
      ]);
      return { ...scope, userId, exclusiveCustomAssetIds };
    },

    async purgePortfolio({ userId, portfolioId, vaultId, vaultAlias, scope }) {
      // The transitive ids are frozen before the first delete. Accepting a
      // sibling's scope here would turn that safety property into a cross-
      // portfolio deletion primitive, so fail before executing any statement.
      if (scope.portfolioId !== portfolioId || scope.userId !== userId) {
        throw new Error('portfolio vault purge scope does not match the target portfolio');
      }
      const resourceIds = [
        portfolioId,
        ...scope.cashMovementIds,
        ...scope.cashBudgetIds,
        ...scope.standingOrderIds,
        ...scope.importBatchIds,
        ...scope.audienceIds,
        ...scope.commentIds,
        ...scope.exclusiveCustomAssetIds,
      ];

      // Keep the security event but remove a concrete target/child path for
      // this portfolio only. Sibling audit metadata and every non-path field
      // remain byte-for-byte intact.
      const auditPath = sql<string>`${auditLog.meta} ->> 'path'`;
      await tx
        .update(auditLog)
        .set({ meta: sql`${auditLog.meta} - 'path'` })
        .where(
          and(
            eq(auditLog.actorId, userId),
            eq(auditLog.action, 'api_key.scope_denied'),
            pathResidueCondition(auditPath, resourceIds),
          ),
        );

      // Purge resource fingerprints before their parent rows disappear. The
      // post-sweep probe uses this frozen scope and therefore catches even a path
      // that contained only a child UUID.
      await tx
        .delete(apiKeyRequestLog)
        .where(pathResidueCondition(apiKeyRequestLog.path, resourceIds));
      await tx
        .delete(idempotencyKeys)
        .where(
          or(
            pathResidueCondition(idempotencyKeys.path, resourceIds),
            ...resourceIds.map((id) => like(idempotencyKeys.responseBody, `%${id}%`)),
          ),
        );

      const directReaction = and(
        eq(itemReactions.targetType, 'item'),
        eq(itemReactions.kind, 'portfolio'),
        eq(itemReactions.subjectId, portfolioId),
      );
      await tx
        .delete(itemReactions)
        .where(
          scope.commentIds.length > 0
            ? or(
                directReaction,
                and(
                  eq(itemReactions.targetType, 'comment'),
                  inArray(itemReactions.commentId, [...scope.commentIds]),
                ),
              )
            : directReaction,
        );
      await tx
        .delete(itemComments)
        .where(and(eq(itemComments.kind, 'portfolio'), eq(itemComments.subjectId, portfolioId)));
      await tx
        .delete(itemFollows)
        .where(and(eq(itemFollows.kind, 'portfolio'), eq(itemFollows.subjectId, portfolioId)));
      await tx
        .delete(sharedItemActivityPrefs)
        .where(
          and(
            eq(sharedItemActivityPrefs.kind, 'portfolio'),
            eq(sharedItemActivityPrefs.subjectId, portfolioId),
          ),
        );
      if (scope.audienceIds.length > 0) {
        await tx
          .delete(shareAudienceLinks)
          .where(inArray(shareAudienceLinks.audienceId, [...scope.audienceIds]));
        await tx
          .delete(shareAudienceMembers)
          .where(inArray(shareAudienceMembers.audienceId, [...scope.audienceIds]));
        await tx.delete(shareAudiences).where(inArray(shareAudiences.id, [...scope.audienceIds]));
      }
      await tx.delete(mirrorRows).where(eq(mirrorRows.portfolioId, portfolioId));

      if (scope.cashBudgetIds.length > 0) {
        await tx
          .delete(cashBudgetFires)
          .where(inArray(cashBudgetFires.budgetId, [...scope.cashBudgetIds]));
      }
      if (scope.cashMovementIds.length > 0) {
        await tx
          .delete(cashMovementTags)
          .where(inArray(cashMovementTags.movementId, [...scope.cashMovementIds]));
      }
      if (scope.standingOrderIds.length > 0) {
        await tx
          .delete(standingOrderRuns)
          .where(inArray(standingOrderRuns.standingOrderId, [...scope.standingOrderIds]));
      }
      if (scope.importBatchIds.length > 0) {
        await tx.delete(importRows).where(inArray(importRows.batchId, [...scope.importBatchIds]));
      }
      await tx
        .delete(portfolioDailySnapshots)
        .where(eq(portfolioDailySnapshots.portfolioId, portfolioId));
      await tx
        .delete(portfolioSnapshotState)
        .where(eq(portfolioSnapshotState.portfolioId, portfolioId));
      await tx
        .delete(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, portfolioId));
      await tx.delete(dividends).where(eq(dividends.portfolioId, portfolioId));
      await tx.delete(transactions).where(eq(transactions.portfolioId, portfolioId));
      await tx
        .delete(portfolioCashSources)
        .where(eq(portfolioCashSources.portfolioId, portfolioId));
      await tx.delete(portfolioSettings).where(eq(portfolioSettings.portfolioId, portfolioId));
      await tx.delete(cashBudgets).where(eq(cashBudgets.portfolioId, portfolioId));
      await tx.delete(standingOrders).where(eq(standingOrders.portfolioId, portfolioId));
      await tx.delete(importBatches).where(eq(importBatches.portfolioId, portfolioId));

      // `assets` / `price_history` are common rows while a sibling references
      // them. An owner-manual asset used only by this target, however, is part
      // of the moved graph: detach its content through the database identity
      // seam after every FK-bearing portfolio row is gone.
      for (const assetId of scope.exclusiveCustomAssetIds) {
        await tx.execute(sql`
          select bettertrack_detach_owned_asset_data(
            cast(${assetId} as uuid),
            cast(${userId} as uuid)
          )
        `);
        // E1's detach helper prunes an identity that has no remaining
        // alert/workboard/conglomerate reference. E4 needs the stronger
        // same-UUID restore claim even in that case: recreate only the opaque
        // (id, owner) tombstone, then prove a conflicting account did not own
        // an already-retained claim. No asset content is reintroduced.
        await tx
          .insert(assetIdentities)
          .values({ id: assetId, ownerId: userId })
          .onConflictDoNothing();
        const [identityClaim] = await tx
          .select({ ownerId: assetIdentities.ownerId })
          .from(assetIdentities)
          .where(eq(assetIdentities.id, assetId))
          .for('update');
        if (!identityClaim || identityClaim.ownerId !== userId) {
          throw new Error('portfolio vault purge could not retain a custom-asset owner claim');
        }
      }
      if (scope.exclusiveCustomAssetIds.length > 0) {
        const [assetResidue, valueResidue] = await Promise.all([
          tx
            .select({ value: count() })
            .from(assets)
            .where(inArray(assets.id, [...scope.exclusiveCustomAssetIds])),
          tx
            .select({ value: count() })
            .from(priceHistory)
            .where(inArray(priceHistory.assetId, [...scope.exclusiveCustomAssetIds])),
        ]);
        if (
          Number(assetResidue[0]?.value ?? 0) !== 0 ||
          Number(valueResidue[0]?.value ?? 0) !== 0
        ) {
          throw new Error('portfolio vault purge left exclusive custom-asset cleartext');
        }
      }

      const [stub] = await tx
        .update(portfolios)
        .set({
          name: vaultedPortfolioStubName(portfolioId),
          visibility: 'private',
          sortOrder: 0,
          defaultPayFromCash: false,
          archivedAt: null,
          kind: null,
          vaultId,
          vaultAlias,
        })
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
        .returning({ id: portfolios.id });
      if (!stub) {
        throw new Error('portfolio vault purge lost the locked target portfolio');
      }

      // The shared frozen probe represents polymorphic parent rows by their
      // captured ids (a post-delete graph walk cannot rediscover them). Prove
      // those ids and their FK children explicitly, then clear only those two
      // sentinel arrays for the remainder of the registry probe.
      const [
        audienceResidue,
        audienceMemberResidue,
        audienceLinkResidue,
        commentResidue,
        commentReactionResidue,
        apiLogResidue,
        idempotencyResidue,
      ] = await Promise.all([
        scope.audienceIds.length === 0
          ? Promise.resolve([])
          : tx
              .select({ id: shareAudiences.id })
              .from(shareAudiences)
              .where(inArray(shareAudiences.id, [...scope.audienceIds])),
        scope.audienceIds.length === 0
          ? Promise.resolve([])
          : tx
              .select({ audienceId: shareAudienceMembers.audienceId })
              .from(shareAudienceMembers)
              .where(inArray(shareAudienceMembers.audienceId, [...scope.audienceIds])),
        scope.audienceIds.length === 0
          ? Promise.resolve([])
          : tx
              .select({ audienceId: shareAudienceLinks.audienceId })
              .from(shareAudienceLinks)
              .where(inArray(shareAudienceLinks.audienceId, [...scope.audienceIds])),
        scope.commentIds.length === 0
          ? Promise.resolve([])
          : tx
              .select({ id: itemComments.id })
              .from(itemComments)
              .where(inArray(itemComments.id, [...scope.commentIds])),
        scope.commentIds.length === 0
          ? Promise.resolve([])
          : tx
              .select({ commentId: itemReactions.commentId })
              .from(itemReactions)
              .where(inArray(itemReactions.commentId, [...scope.commentIds])),
        tx
          .select({ id: apiKeyRequestLog.id })
          .from(apiKeyRequestLog)
          .where(pathResidueCondition(apiKeyRequestLog.path, resourceIds)),
        tx
          .select({ id: idempotencyKeys.id })
          .from(idempotencyKeys)
          .where(
            or(
              pathResidueCondition(idempotencyKeys.path, resourceIds),
              ...resourceIds.map((id) => like(idempotencyKeys.responseBody, `%${id}%`)),
            ),
          ),
      ]);
      if (
        audienceResidue.length > 0 ||
        audienceMemberResidue.length > 0 ||
        audienceLinkResidue.length > 0 ||
        commentResidue.length > 0 ||
        commentReactionResidue.length > 0 ||
        apiLogResidue.length > 0 ||
        idempotencyResidue.length > 0
      ) {
        throw new Error('portfolio vault purge left frozen sharing/comment cleartext');
      }
      await assertVaultedPortfolioScopeHasNoCleartext({
        ...scope,
        audienceIds: [],
        commentIds: [],
      });
    },

    async completeMoveIn({
      userId,
      portfolioId,
      vaultId,
      docVersion,
      lifecycleGeneration,
      retiredCustomAssetIds,
      completedAt,
    }) {
      // Idempotency identity: (portfolioId, lifecycleGeneration, vaultId,
      // docVersion). The server-minted generation is committed with membership,
      // the receipt, and the zero-cleartext proof.
      await tx
        .insert(portfolioVaultTransitionStates)
        .values({
          portfolioId,
          userId,
          lifecycleGeneration,
          moveInVaultId: vaultId,
          moveInDocVersion: docVersion,
          moveInCompletedAt: completedAt,
          moveInRetiredCustomAssetIds: [...retiredCustomAssetIds],
          updatedAt: completedAt,
        })
        .onConflictDoUpdate({
          target: portfolioVaultTransitionStates.portfolioId,
          set: {
            userId,
            captureRevision: null,
            captureExpiresAt: null,
            captureVaultId: null,
            captureMediaAttestedAt: null,
            captureMediaAttestedDriveConnectionId: null,
            lifecycleGeneration,
            moveInVaultId: vaultId,
            moveInDocVersion: docVersion,
            moveInCompletedAt: completedAt,
            moveInRetiredCustomAssetIds: [...retiredCustomAssetIds],
            moveOutVaultId: null,
            moveOutId: null,
            moveOutDocumentDigest: null,
            moveOutDocumentSetHash: null,
            moveOutProofPublicKey: null,
            moveOutCompletedAt: null,
            moveOutPostCommitPending: false,
            moveOutPostCommitCustomAssetIds: [],
            moveOutPostCommitLastAttemptAt: null,
            updatedAt: completedAt,
          },
        });
      await tx.delete(vaultServerCandidates).where(eq(vaultServerCandidates.vaultId, vaultId));
      await tx
        .update(vaults)
        .set({
          mediaAttestedAt: completedAt,
          mediaAttestedDriveConnectionId: sql`${vaults.driveConnectionId}`,
          updatedAt: completedAt,
        })
        .where(eq(vaults.id, vaultId));
    },

    async archiveAndRemovePortfolioDocument({
      vaultId,
      portfolioId,
      now,
      historyMaxVersions,
      historyMaxAgeMs,
    }) {
      const [current] = await tx
        .select()
        .from(vaultBlobs)
        .where(and(eq(vaultBlobs.vaultId, vaultId), eq(vaultBlobs.docId, portfolioId)))
        .for('update');
      if (current) {
        const [sameVersion] = await tx
          .select()
          .from(vaultBlobHistory)
          .where(
            and(
              eq(vaultBlobHistory.vaultId, vaultId),
              eq(vaultBlobHistory.docId, portfolioId),
              eq(vaultBlobHistory.version, current.version),
            ),
          )
          .for('update');
        const [retiredSameVersion] = await tx
          .select()
          .from(vaultRetired)
          .where(
            and(
              eq(vaultRetired.vaultId, vaultId),
              eq(vaultRetired.docId, portfolioId),
              eq(vaultRetired.version, current.version),
            ),
          )
          .for('update');
        if (
          (sameVersion && !sameVersion.blob.equals(current.blob)) ||
          (retiredSameVersion && !retiredSameVersion.blob.equals(current.blob))
        ) {
          return 'conflict';
        }
        if (!sameVersion) {
          await tx.insert(vaultBlobHistory).values({
            vaultId,
            docId: portfolioId,
            version: current.version,
            formatVersion: current.formatVersion,
            sizeBytes: current.sizeBytes,
            blob: current.blob,
            createdAt: now,
          });
        }
        await tx
          .delete(vaultBlobs)
          .where(and(eq(vaultBlobs.vaultId, vaultId), eq(vaultBlobs.docId, portfolioId)));
      }
      await tx
        .delete(vaultBlobHistory)
        .where(
          and(
            eq(vaultBlobHistory.vaultId, vaultId),
            eq(vaultBlobHistory.docId, portfolioId),
            lt(vaultBlobHistory.createdAt, new Date(now.getTime() - historyMaxAgeMs)),
          ),
        );
      const excess = await tx
        .select({ id: vaultBlobHistory.id })
        .from(vaultBlobHistory)
        .where(and(eq(vaultBlobHistory.vaultId, vaultId), eq(vaultBlobHistory.docId, portfolioId)))
        .orderBy(desc(vaultBlobHistory.createdAt), desc(vaultBlobHistory.id))
        .offset(Math.max(0, historyMaxVersions));
      if (excess.length > 0) {
        await tx.delete(vaultBlobHistory).where(
          inArray(
            vaultBlobHistory.id,
            excess.map(({ id }) => id),
          ),
        );
      }
      return 'ok';
    },

    async completeMoveOut({
      userId,
      portfolioId,
      vaultId,
      moveOutId,
      lifecycleGeneration,
      documentDigest,
      documentSetHash,
      proofPublicKey,
      customAssetIds,
      completedAt,
    }) {
      // Idempotency key: (portfolioId, lifecycleGeneration,
      // restoreDocumentDigest). `moveOutId` is a client correlation id
      // additionally pinned to that generation and digest in the receipt.
      // Restored rows, membership, receipt and the pending recovery plan are
      // one commit. The marker schedules only idempotent derived-state repair;
      // E2 capability enforcement follows membership and turns off here.
      const [receipt] = await tx
        .update(portfolioVaultTransitionStates)
        .set({
          userId,
          captureRevision: null,
          captureExpiresAt: null,
          captureVaultId: null,
          captureMediaAttestedAt: null,
          captureMediaAttestedDriveConnectionId: null,
          moveInVaultId: null,
          moveInDocVersion: null,
          moveInCompletedAt: null,
          moveInRetiredCustomAssetIds: [],
          moveOutVaultId: vaultId,
          moveOutId,
          moveOutDocumentDigest: documentDigest,
          moveOutDocumentSetHash: documentSetHash,
          moveOutProofPublicKey: proofPublicKey,
          moveOutCompletedAt: completedAt,
          moveOutPostCommitPending: true,
          moveOutPostCommitCustomAssetIds: [...customAssetIds],
          moveOutPostCommitLastAttemptAt: null,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(portfolioVaultTransitionStates.portfolioId, portfolioId),
            eq(portfolioVaultTransitionStates.lifecycleGeneration, lifecycleGeneration),
          ),
        )
        .returning({ portfolioId: portfolioVaultTransitionStates.portfolioId });
      if (!receipt) {
        throw new Error('portfolio vault move-out transition state disappeared');
      }
      const [restoredMembership] = await tx
        .update(portfolios)
        .set({ vaultId: null, vaultAlias: null })
        .where(
          and(
            eq(portfolios.id, portfolioId),
            eq(portfolios.userId, userId),
            eq(portfolios.vaultId, vaultId),
          ),
        )
        .returning({ id: portfolios.id });
      if (!restoredMembership) {
        throw new Error('portfolio vault move-out lost its locked membership');
      }
      await tx.delete(vaultServerCandidates).where(eq(vaultServerCandidates.vaultId, vaultId));
      await tx
        .update(vaults)
        .set({
          // The required roster changed and a Drive portfolio file is deleted
          // only after commit by the unlocked client. Keep the vault stale
          // until E6 tombstones/syncs the new set and attests that round trip.
          mediaAttestedAt: null,
          mediaAttestedDriveConnectionId: null,
          updatedAt: completedAt,
        })
        .where(eq(vaults.id, vaultId));
    },
  };
}

/** Read one pending finalization plan. Callers must hold the owner's exclusive privacy lock. */
export async function readPendingPortfolioVaultMoveOutFinalization(
  db: Database,
  userId: string,
  portfolioId: string,
): Promise<PendingPortfolioVaultMoveOutFinalization | null> {
  const [row] = await db
    .select({
      userId: portfolioVaultTransitionStates.userId,
      portfolioId: portfolioVaultTransitionStates.portfolioId,
      vaultId: portfolioVaultTransitionStates.moveOutVaultId,
      lifecycleGeneration: portfolioVaultTransitionStates.lifecycleGeneration,
      customAssetIds: portfolioVaultTransitionStates.moveOutPostCommitCustomAssetIds,
      completedAt: portfolioVaultTransitionStates.moveOutCompletedAt,
    })
    .from(portfolioVaultTransitionStates)
    .where(
      and(
        eq(portfolioVaultTransitionStates.userId, userId),
        eq(portfolioVaultTransitionStates.portfolioId, portfolioId),
        eq(portfolioVaultTransitionStates.moveOutPostCommitPending, true),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.vaultId === null || row.completedAt === null) {
    throw new Error('pending portfolio vault move-out has an incomplete receipt');
  }
  const [portfolio] = await db
    .select({ vaultId: portfolios.vaultId })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
    .limit(1);
  if (!portfolio || portfolio.vaultId !== null) {
    throw new Error('pending portfolio vault move-out has inconsistent membership');
  }
  return {
    userId: row.userId,
    portfolioId: row.portfolioId,
    vaultId: row.vaultId,
    lifecycleGeneration: row.lifecycleGeneration,
    customAssetIds: [...row.customAssetIds].sort(),
    completedAt: row.completedAt,
  };
}

/** Oldest-first bounded sweep input; each item is re-read under its account lock. */
export async function listPendingPortfolioVaultMoveOutFinalizations(
  db: Database,
  limit: number,
): Promise<readonly { userId: string; portfolioId: string; lifecycleGeneration: number }[]> {
  return db
    .select({
      userId: portfolioVaultTransitionStates.userId,
      portfolioId: portfolioVaultTransitionStates.portfolioId,
      lifecycleGeneration: portfolioVaultTransitionStates.lifecycleGeneration,
    })
    .from(portfolioVaultTransitionStates)
    .where(eq(portfolioVaultTransitionStates.moveOutPostCommitPending, true))
    .orderBy(
      sql`${portfolioVaultTransitionStates.moveOutPostCommitLastAttemptAt} asc nulls first`,
      asc(portfolioVaultTransitionStates.updatedAt),
      asc(portfolioVaultTransitionStates.portfolioId),
    )
    .limit(limit);
}

/**
 * Rotate one sweep candidate before callbacks run. New (NULL) plans are always
 * selected before retries; failed retries then round-robin by database time so
 * a fixed poison batch cannot starve later move-outs forever.
 */
export async function markPendingPortfolioVaultMoveOutFinalizationAttempt(
  db: Database,
  input: { userId: string; portfolioId: string; lifecycleGeneration: number },
): Promise<boolean> {
  const [marked] = await db
    .update(portfolioVaultTransitionStates)
    .set({ moveOutPostCommitLastAttemptAt: sql`now()` })
    .where(
      and(
        eq(portfolioVaultTransitionStates.userId, input.userId),
        eq(portfolioVaultTransitionStates.portfolioId, input.portfolioId),
        eq(portfolioVaultTransitionStates.lifecycleGeneration, input.lifecycleGeneration),
        eq(portfolioVaultTransitionStates.moveOutPostCommitPending, true),
      ),
    )
    .returning({ portfolioId: portfolioVaultTransitionStates.portfolioId });
  return Boolean(marked);
}

/** Clear the durable recovery marker only after every repeatable effect converged. */
export async function completePendingPortfolioVaultMoveOut(
  db: Database,
  input: PendingPortfolioVaultMoveOutFinalization,
): Promise<boolean> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const [portfolio] = await tx
      .select({ id: portfolios.id, vaultId: portfolios.vaultId })
      .from(portfolios)
      .where(and(eq(portfolios.id, input.portfolioId), eq(portfolios.userId, input.userId)))
      .for('update');
    if (!portfolio || portfolio.vaultId !== null) return false;
    const [state] = await tx
      .select({
        lifecycleGeneration: portfolioVaultTransitionStates.lifecycleGeneration,
        vaultId: portfolioVaultTransitionStates.moveOutVaultId,
        pending: portfolioVaultTransitionStates.moveOutPostCommitPending,
      })
      .from(portfolioVaultTransitionStates)
      .where(eq(portfolioVaultTransitionStates.portfolioId, input.portfolioId))
      .for('update');
    if (
      !state ||
      !state.pending ||
      state.lifecycleGeneration !== input.lifecycleGeneration ||
      state.vaultId !== input.vaultId
    ) {
      return false;
    }
    const [completed] = await tx
      .update(portfolioVaultTransitionStates)
      .set({
        moveOutPostCommitPending: false,
        moveOutPostCommitCustomAssetIds: [],
        moveOutPostCommitLastAttemptAt: null,
      })
      .where(
        and(
          eq(portfolioVaultTransitionStates.portfolioId, input.portfolioId),
          eq(portfolioVaultTransitionStates.userId, input.userId),
          eq(portfolioVaultTransitionStates.lifecycleGeneration, input.lifecycleGeneration),
          eq(portfolioVaultTransitionStates.moveOutPostCommitPending, true),
        ),
      )
      .returning({ portfolioId: portfolioVaultTransitionStates.portfolioId });
    if (!completed) throw new Error('portfolio vault move-out completion lost its locked state');
    return true;
  });
}

/** Open/renew the short E4 staging window after a repeatable-read digest. */
export async function beginPortfolioVaultCapture(input: {
  db: Database;
  userId: string;
  portfolioId: string;
  revision: string;
  now: Date;
  expiresAt: Date;
}): Promise<'ok' | 'not_found' | 'already_vaulted' | 'finalization_pending'> {
  return input.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    // Capture renewal can remove a previously staged active document. Take the
    // same account privacy lock as the commit path, then preserve E1's lock
    // order (account -> vault -> portfolio -> transition state). The initial
    // unlocked state read only discovers which vault row must be locked; the
    // account lock prevents a conforming transition/blob writer from changing
    // that binding underneath us.
    const [owner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update');
    if (!owner) return 'not_found';
    const [priorBinding] = await tx
      .select({ captureVaultId: portfolioVaultTransitionStates.captureVaultId })
      .from(portfolioVaultTransitionStates)
      .where(eq(portfolioVaultTransitionStates.portfolioId, input.portfolioId));
    if (priorBinding?.captureVaultId) {
      const [lockedPriorVault] = await tx
        .select({ id: vaults.id })
        .from(vaults)
        .where(and(eq(vaults.id, priorBinding.captureVaultId), eq(vaults.userId, input.userId)))
        .for('update');
      if (!lockedPriorVault) {
        throw new Error('portfolio vault capture is bound to a foreign or missing vault');
      }
    }
    const [portfolio] = await tx
      .select()
      .from(portfolios)
      .where(and(eq(portfolios.id, input.portfolioId), eq(portfolios.userId, input.userId)))
      .for('update');
    if (!portfolio) return 'not_found';
    if (portfolio.vaultId !== null) return 'already_vaulted';
    const [prior] = await tx
      .select()
      .from(portfolioVaultTransitionStates)
      .where(eq(portfolioVaultTransitionStates.portfolioId, input.portfolioId))
      .for('update');
    if (prior?.moveOutPostCommitPending) return 'finalization_pending';
    if ((prior?.captureVaultId ?? null) !== (priorBinding?.captureVaultId ?? null)) {
      throw new Error('portfolio vault capture binding changed while acquiring locks');
    }
    if (prior?.captureVaultId) {
      // Only an uncommitted prospective live row is removed. Bounded history is
      // retained: it may be the move-out safety copy and contains ciphertext only.
      await tx
        .delete(vaultBlobs)
        .where(
          and(
            eq(vaultBlobs.vaultId, prior.captureVaultId),
            eq(vaultBlobs.docId, input.portfolioId),
          ),
        );
      await tx
        .delete(vaultServerCandidates)
        .where(
          and(
            eq(vaultServerCandidates.vaultId, prior.captureVaultId),
            eq(vaultServerCandidates.docId, input.portfolioId),
          ),
        );
      // Removing a required prospective document changes the exact roster.
      // Never leave the old vault attestation claiming that reduced set was
      // read back from every configured medium.
      await tx
        .update(vaults)
        .set({
          mediaAttestedAt: null,
          mediaAttestedDriveConnectionId: null,
          updatedAt: input.now,
        })
        .where(and(eq(vaults.id, prior.captureVaultId), eq(vaults.userId, input.userId)));
    }
    await tx
      .insert(portfolioVaultTransitionStates)
      .values({
        portfolioId: input.portfolioId,
        userId: input.userId,
        captureRevision: input.revision,
        captureExpiresAt: input.expiresAt,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: portfolioVaultTransitionStates.portfolioId,
        set: {
          userId: input.userId,
          captureRevision: input.revision,
          captureExpiresAt: input.expiresAt,
          captureVaultId: null,
          captureMediaAttestedAt: null,
          captureMediaAttestedDriveConnectionId: null,
          moveInVaultId: null,
          moveInDocVersion: null,
          moveInCompletedAt: null,
          // Keep the preceding move-out receipt during a new capture window.
          // An outcome-ambiguous move-out retry must still converge if another
          // tab has already started (but not yet committed) the next move-in.
          // `completeMoveIn` retires the old lifecycle receipt atomically.
          updatedAt: input.now,
        },
      });
    return 'ok';
  });
}

export async function withPortfolioVaultTransitionTransaction<T>(
  db: Database,
  userId: string,
  run: (tx: Database) => Promise<T>,
): Promise<T> {
  const { withExclusiveParanoidTransitionTestLock } =
    await import('./paranoidEnforcementRepository');
  return withExclusiveParanoidTransitionTestLock(db, userId, () =>
    db.transaction((rawTx) => run(rawTx as unknown as Database)),
  );
}

export function entitiesOf<K extends Entity['kind']>(
  entities: readonly Entity[],
  kind: K,
): EntityOf<K>[] {
  return entities.filter((entity): entity is EntityOf<K> => entity.kind === kind);
}

export type PortfolioVaultTransitionUserRow = Pick<
  UserRow,
  'passwordHash' | 'twoFactorSecret' | 'twoFactorEnabled' | 'twoFactorEmailEnabled'
>;
