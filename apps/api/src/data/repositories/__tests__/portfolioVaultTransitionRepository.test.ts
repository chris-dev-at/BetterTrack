import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import {
  encodeVaultDocEnvelope,
  serializeVaultRetirementVersionSet,
  VAULT_CONTENT_CIPHER,
  type VaultDocKind,
} from '@bettertrack/contracts';

import type { Database } from '../../db';
import {
  alerts,
  apiKeyRequestLog,
  apiKeys,
  assets,
  assetIdentities,
  auditLog,
  cashBudgetFires,
  cashBudgets,
  cashMovementTags,
  cashTags,
  dividends,
  driveConnections,
  exportJobs,
  importBatches,
  importRows,
  idempotencyKeys,
  itemComments,
  itemFollows,
  itemReactions,
  mirrorChainMembers,
  mirrorChains,
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
  vaultBlobHistory,
  vaultBlobs,
  vaultRetired,
  vaultServerCandidates,
  vaults,
} from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  beginPortfolioVaultCapture,
  completePendingPortfolioVaultMoveOut,
  computePortfolioDataRevision,
  createPortfolioVaultTransitionTransactionRepository,
  listPendingPortfolioVaultMoveOutFinalizations,
  markPendingPortfolioVaultMoveOutFinalizationAttempt,
  readPendingPortfolioVaultMoveOutFinalization,
} from '../portfolioVaultTransitionRepository';
import { createVaultBlobRepository } from '../vaultBlobRepository';
import { PARANOID_RETIRED_EXPORT_ERROR } from '../paranoidTransitionRepository';
import { vaultedPortfolioStubName } from '../vaultedPortfolioProbe';

// Deterministic TEST VECTOR UUIDs and bytes; none are credentials.
const id = (value: number) => `019c8200-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;
const TEST_VECTOR = {
  vaultId: id(1),
  headerDocId: id(2),
  commonDocId: id(3),
  targetPortfolioId: id(4),
  siblingPortfolioId: id(5),
  assetId: id(6),
  targetSourceId: id(7),
  siblingSourceId: id(8),
  targetTransactionId: id(9),
  siblingTransactionId: id(10),
  targetDividendId: id(11),
  targetMovementId: id(12),
  siblingMovementId: id(13),
  cashTagId: id(14),
  targetMovementTagId: id(15),
  targetBudgetId: id(16),
  siblingBudgetId: id(17),
  targetBudgetFireId: id(18),
  targetOrderId: id(19),
  siblingOrderId: id(20),
  targetOrderRunId: id(21),
  targetBatchId: id(22),
  siblingBatchId: id(23),
  targetImportRowId: id(24),
  chainId: id(25),
  chainMemberId: id(26),
  mirrorId: id(27),
  audienceId: id(28),
  audienceLinkId: id(29),
  commentId: id(30),
  reactionId: id(31),
  deviceId: id(32),
  keyId: id(33),
  exclusiveCustomAssetId: id(34),
  sharedCustomAssetId: id(35),
  exclusiveTransactionId: id(36),
  sharedTargetTransactionId: id(37),
  sharedSiblingTransactionId: id(38),
  targetAuditId: id(39),
  siblingAuditId: id(40),
  exclusiveAssetAlertId: id(41),
  changedMirrorLocalId: id(42),
  viewerApiKeyId: id(43),
  viewerApiLogId: id(44),
  targetIdempotencyId: id(45),
  unscopedAuditId: id(46),
  priorCandidateId: id(47),
  priorCandidateTransitionId: id(48),
  driveConnectionId: id(49),
  pendingExportId: id(50),
  readyExportId: id(51),
  failedExportId: id(52),
  pointerlessExportId: id(53),
  foreignExportId: id(54),
  at: new Date('2026-08-21T10:00:00.000Z'),
  activeBytes: Buffer.from('TEST_VECTOR_ACTIVE_BYTES'),
  conflictingBytes: Buffer.from('TEST_VECTOR_CONFLICTING_BYTES'),
} as const;

function envelope(docId: string, docKind: VaultDocKind, docVersion: number): Buffer {
  return Buffer.from(
    encodeVaultDocEnvelope(
      {
        formatVersion: 2,
        cipher: VAULT_CONTENT_CIPHER,
        iv: 'AA',
        keyId: TEST_VECTOR.keyId,
        keySlots: [
          { keyId: TEST_VECTOR.keyId, slot: 'seed-v1', wrappedKc: 'TEST_VECTOR_wrapped_key' },
        ],
        vaultId: TEST_VECTOR.vaultId,
        docId,
        docKind,
        accountBinding: 'A'.repeat(43),
        docVersion,
        schemaVersion: 1,
        deviceId: TEST_VECTOR.deviceId,
        writeId: id(
          100 + docVersion + (docKind === 'portfolio' ? 10 : docKind === 'common' ? 20 : 30),
        ),
        writtenAt: TEST_VECTOR.at.toISOString(),
      },
      new Uint8Array([0, 255, docVersion]),
    ),
  );
}

function versionSetHash(rows: readonly { docId: string; version: number }[]): string {
  return createHash('sha256')
    .update(
      serializeVaultRetirementVersionSet(
        rows.map((row) => ({ docId: row.docId, docVersion: row.version })),
      ),
    )
    .digest('base64url');
}

let h: TestHarness;
let userId: string;

beforeEach(async () => {
  h = await createTestApp();
  const user = await h.seedUser({
    email: 'portfolio-transition-repository@bettertrack.test',
    username: 'portfolio_transition_repository',
  });
  userId = user.id;
  await h.db.insert(vaults).values({
    id: TEST_VECTOR.vaultId,
    userId,
    name: 'TEST VECTOR vault',
    headerDocId: TEST_VECTOR.headerDocId,
    commonDocId: TEST_VECTOR.commonDocId,
    media: ['server'],
    retirementProofPublicKey: 'TEST VECTOR retirement public key',
    keyFingerprint: 'TEST-VECTOR-FINGERPRINT',
  });
  await h.db.insert(portfolios).values([
    {
      id: TEST_VECTOR.targetPortfolioId,
      userId,
      name: 'TEST VECTOR target',
      sortOrder: 1,
      defaultPayFromCash: true,
    },
    {
      id: TEST_VECTOR.siblingPortfolioId,
      userId,
      name: 'TEST VECTOR sibling',
      visibility: 'friends',
      sortOrder: 2,
      defaultPayFromCash: true,
      kind: 'investment',
    },
  ]);
});

// NOTE: no redis.quit() here — the redis handle is the shared module-level
// singleton; quitting it in real-Redis (integration) mode kills every later
// suite in the singleFork process (the #1456 landmine class).

async function seedLedgerGraph(): Promise<void> {
  const viewer = await h.seedUser({
    email: 'portfolio-transition-viewer@bettertrack.test',
    username: 'portfolio_transition_viewer',
  });
  await h.db.insert(assets).values({
    id: TEST_VECTOR.assetId,
    providerId: 'test-vector-provider',
    providerRef: 'test-vector-asset',
    type: 'stock',
    symbol: 'TVEC',
    name: 'TEST VECTOR asset',
    currency: 'EUR',
  });
  await h.db.insert(assets).values([
    {
      id: TEST_VECTOR.exclusiveCustomAssetId,
      ownerId: userId,
      providerId: 'manual',
      providerRef: TEST_VECTOR.exclusiveCustomAssetId,
      type: 'custom',
      symbol: 'ONLY',
      name: 'TEST VECTOR target-only manual asset',
      currency: 'EUR',
      meta: { scope: 'target' },
    },
    {
      id: TEST_VECTOR.sharedCustomAssetId,
      ownerId: userId,
      providerId: 'manual',
      providerRef: TEST_VECTOR.sharedCustomAssetId,
      type: 'custom',
      symbol: 'SHARED',
      name: 'TEST VECTOR sibling-shared manual asset',
      currency: 'EUR',
      meta: { scope: 'siblings' },
    },
  ]);
  await h.db.insert(priceHistory).values([
    { assetId: TEST_VECTOR.exclusiveCustomAssetId, date: '2026-08-20', close: '11' },
    { assetId: TEST_VECTOR.sharedCustomAssetId, date: '2026-08-20', close: '22' },
  ]);
  // Price alerts are server-kept, asset-level, and unrelated to portfolio
  // membership. Keep this one on the global asset so the exclusive manual
  // asset below has deliberately NO retained reference pinning its identity.
  await h.db.insert(alerts).values({
    id: TEST_VECTOR.exclusiveAssetAlertId,
    userId,
    assetId: TEST_VECTOR.assetId,
    kind: 'price_above',
    threshold: '12',
    repeat: false,
    status: 'active',
  });
  await h.db.insert(portfolioCashSources).values([
    {
      id: TEST_VECTOR.targetSourceId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      name: 'Target Main',
      type: 'cash',
      isMain: true,
      createdAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingSourceId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      name: 'Sibling Main',
      type: 'cash',
      isMain: true,
      createdAt: TEST_VECTOR.at,
    },
  ]);
  await h.db.insert(transactions).values([
    {
      id: TEST_VECTOR.targetTransactionId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      assetId: TEST_VECTOR.assetId,
      side: 'buy',
      quantity: '1',
      price: '10',
      fee: '0',
      executedAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingTransactionId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      assetId: TEST_VECTOR.assetId,
      side: 'buy',
      quantity: '2',
      price: '20',
      fee: '0',
      executedAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.exclusiveTransactionId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      assetId: TEST_VECTOR.exclusiveCustomAssetId,
      side: 'buy',
      quantity: '1',
      price: '11',
      fee: '0',
      executedAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.sharedTargetTransactionId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      assetId: TEST_VECTOR.sharedCustomAssetId,
      side: 'buy',
      quantity: '1',
      price: '22',
      fee: '0',
      executedAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.sharedSiblingTransactionId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      assetId: TEST_VECTOR.sharedCustomAssetId,
      side: 'buy',
      quantity: '1',
      price: '22',
      fee: '0',
      executedAt: TEST_VECTOR.at,
    },
  ]);
  await h.db.insert(dividends).values({
    id: TEST_VECTOR.targetDividendId,
    portfolioId: TEST_VECTOR.targetPortfolioId,
    assetId: TEST_VECTOR.assetId,
    cashSourceId: TEST_VECTOR.targetSourceId,
    grossAmountEur: '2',
    executedAt: TEST_VECTOR.at,
    taxMode: 'none',
    createdAt: TEST_VECTOR.at,
  });
  await h.db.insert(portfolioCashMovements).values([
    {
      id: TEST_VECTOR.targetMovementId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      sourceId: TEST_VECTOR.targetSourceId,
      kind: 'buy',
      amountEur: '-10',
      transactionId: TEST_VECTOR.targetTransactionId,
      executedAt: TEST_VECTOR.at,
      createdAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingMovementId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      sourceId: TEST_VECTOR.siblingSourceId,
      kind: 'deposit',
      amountEur: '100',
      executedAt: TEST_VECTOR.at,
      createdAt: TEST_VECTOR.at,
    },
  ]);
  await h.db.insert(cashTags).values({
    id: TEST_VECTOR.cashTagId,
    userId,
    name: 'TEST VECTOR common tag',
    color: '#123456',
    createdAt: TEST_VECTOR.at,
    updatedAt: TEST_VECTOR.at,
  });
  await h.db.insert(cashMovementTags).values({
    id: TEST_VECTOR.targetMovementTagId,
    movementId: TEST_VECTOR.targetMovementId,
    tagId: TEST_VECTOR.cashTagId,
    createdAt: TEST_VECTOR.at,
  });
  await h.db.insert(cashBudgets).values([
    {
      id: TEST_VECTOR.targetBudgetId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      tagId: TEST_VECTOR.cashTagId,
      amount: '50',
      currency: 'EUR',
      createdAt: TEST_VECTOR.at,
      updatedAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingBudgetId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      tagId: TEST_VECTOR.cashTagId,
      amount: '75',
      currency: 'EUR',
      createdAt: TEST_VECTOR.at,
      updatedAt: TEST_VECTOR.at,
    },
  ]);
  await h.db.insert(cashBudgetFires).values({
    id: TEST_VECTOR.targetBudgetFireId,
    budgetId: TEST_VECTOR.targetBudgetId,
    periodKey: '2026-08',
    firedAt: TEST_VECTOR.at,
  });
  await h.db.insert(standingOrders).values([
    {
      id: TEST_VECTOR.targetOrderId,
      userId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      kind: 'cash-add',
      amount: '10',
      currency: 'EUR',
      cadence: 'daily',
      startDate: '2026-08-21',
      createdAt: TEST_VECTOR.at,
      updatedAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingOrderId,
      userId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      kind: 'cash-add',
      amount: '20',
      currency: 'EUR',
      cadence: 'daily',
      startDate: '2026-08-21',
      createdAt: TEST_VECTOR.at,
      updatedAt: TEST_VECTOR.at,
    },
  ]);
  await h.db.insert(standingOrderRuns).values({
    id: TEST_VECTOR.targetOrderRunId,
    standingOrderId: TEST_VECTOR.targetOrderId,
    periodKey: '2026-08-21',
    bookedAt: TEST_VECTOR.at,
  });
  await h.db.insert(importBatches).values([
    {
      id: TEST_VECTOR.targetBatchId,
      ownerId: userId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      brokerId: 'test-vector',
      filename: 'target.csv',
      status: 'applied',
      cashSourceId: TEST_VECTOR.targetSourceId,
      createdAt: TEST_VECTOR.at,
      appliedAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingBatchId,
      ownerId: userId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      brokerId: 'test-vector',
      filename: 'sibling.csv',
      status: 'applied',
      cashSourceId: TEST_VECTOR.siblingSourceId,
      createdAt: TEST_VECTOR.at,
      appliedAt: TEST_VECTOR.at,
    },
  ]);
  await h.db.insert(importRows).values({
    id: TEST_VECTOR.targetImportRowId,
    batchId: TEST_VECTOR.targetBatchId,
    rowIndex: 1,
    raw: 'TEST VECTOR raw import row',
    flag: 'mapped',
  });
  await h.db.insert(portfolioSettings).values({
    portfolioId: TEST_VECTOR.targetPortfolioId,
    key: 'TEST_VECTOR',
    value: { enabled: true },
    updatedAt: TEST_VECTOR.at,
  });
  await h.db.insert(portfolioDailySnapshots).values({
    portfolioId: TEST_VECTOR.targetPortfolioId,
    date: '2026-08-20',
    valueEur: '100',
    costBasisEur: '90',
    plEur: '10',
    flowEur: '0',
    cashBySource: { [TEST_VECTOR.targetSourceId]: '0' },
    assetValues: { [TEST_VECTOR.assetId]: '100' },
    computedAt: TEST_VECTOR.at,
  });
  await h.db.insert(portfolioSnapshotState).values({
    portfolioId: TEST_VECTOR.targetPortfolioId,
    computedThrough: '2026-08-20',
    updatedAt: TEST_VECTOR.at,
  });
  await h.db.insert(mirrorChains).values({
    id: TEST_VECTOR.chainId,
    name: 'TEST VECTOR ended chain',
    createdBy: userId,
    createdByUsername: 'portfolio_transition_repository',
  });
  await h.db.insert(mirrorChainMembers).values({
    id: TEST_VECTOR.chainMemberId,
    chainId: TEST_VECTOR.chainId,
    userId,
    username: 'portfolio_transition_repository',
    portfolioId: TEST_VECTOR.targetPortfolioId,
    role: 'owner',
    status: 'left',
    endedAt: TEST_VECTOR.at,
  });
  await h.db.insert(mirrorRows).values({
    chainId: TEST_VECTOR.chainId,
    kind: 'transaction',
    mirrorId: TEST_VECTOR.mirrorId,
    portfolioId: TEST_VECTOR.targetPortfolioId,
    localId: TEST_VECTOR.targetTransactionId,
    createdBy: userId,
    createdByUsername: 'portfolio_transition_repository',
  });
  await h.db.insert(shareAudiences).values({
    id: TEST_VECTOR.audienceId,
    ownerId: userId,
    kind: 'portfolio',
    subjectId: TEST_VECTOR.targetPortfolioId,
    audience: 'public_link',
  });
  await h.db.insert(shareAudienceMembers).values({
    audienceId: TEST_VECTOR.audienceId,
    friendId: viewer.id,
  });
  await h.db.insert(shareAudienceLinks).values({
    id: TEST_VECTOR.audienceLinkId,
    audienceId: TEST_VECTOR.audienceId,
    tokenHash: 'TEST VECTOR share token hash',
  });
  await h.db.insert(itemFollows).values({
    userId: viewer.id,
    kind: 'portfolio',
    subjectId: TEST_VECTOR.targetPortfolioId,
  });
  await h.db.insert(sharedItemActivityPrefs).values({
    viewerId: viewer.id,
    kind: 'portfolio',
    subjectId: TEST_VECTOR.targetPortfolioId,
  });
  await h.db.insert(itemComments).values({
    id: TEST_VECTOR.commentId,
    kind: 'portfolio',
    subjectId: TEST_VECTOR.targetPortfolioId,
    authorId: viewer.id,
    body: 'TEST VECTOR comment',
  });
  await h.db.insert(itemReactions).values({
    id: TEST_VECTOR.reactionId,
    userId: viewer.id,
    targetType: 'comment',
    commentId: TEST_VECTOR.commentId,
    emoji: '👍',
  });
  await h.db.insert(apiKeys).values({
    id: TEST_VECTOR.viewerApiKeyId,
    userId: viewer.id,
    name: 'TEST VECTOR viewer key',
    tokenHash: 'a'.repeat(64),
  });
  await h.db.insert(apiKeyRequestLog).values({
    id: TEST_VECTOR.viewerApiLogId,
    keyId: TEST_VECTOR.viewerApiKeyId,
    userId: viewer.id,
    method: 'POST',
    path: `/api/v1/social/comments/${TEST_VECTOR.commentId}/reactions`,
    status: 201,
  });
  await h.db.insert(idempotencyKeys).values({
    id: TEST_VECTOR.targetIdempotencyId,
    userId,
    key: 'TEST_VECTOR_target_idempotency',
    method: 'POST',
    path: '/api/v1/custom-assets',
    requestHash: 'b'.repeat(64),
    statusCode: 201,
    responseBody: `{"assetId":"${TEST_VECTOR.exclusiveCustomAssetId}"}`,
  });
  await h.db.insert(auditLog).values([
    {
      id: TEST_VECTOR.targetAuditId,
      actorId: userId,
      action: 'api_key.scope_denied',
      meta: {
        path: `/api/v1/assets/${TEST_VECTOR.exclusiveCustomAssetId}`,
        reason: 'TEST VECTOR target denial',
      },
      createdAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingAuditId,
      actorId: userId,
      action: 'api_key.scope_denied',
      meta: {
        path: `/api/v1/portfolios/${TEST_VECTOR.siblingPortfolioId}/transactions`,
        reason: 'TEST VECTOR sibling denial',
      },
      createdAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.unscopedAuditId,
      actorId: viewer.id,
      action: 'api_key.scope_denied',
      meta: {
        path: `/api/v1/assets/${TEST_VECTOR.exclusiveCustomAssetId}`,
        reason: 'TEST VECTOR different actor must remain',
      },
      createdAt: TEST_VECTOR.at,
    },
  ]);
}

describe('portfolio vault purge repository', () => {
  it('moves the capture CAS for shared manual facts, referenced cash tags, and fork provenance', async () => {
    await seedLedgerGraph();
    const revision = () =>
      computePortfolioDataRevision(h.db, userId, TEST_VECTOR.targetPortfolioId);

    const initial = await revision();
    await h.db
      .update(assets)
      .set({ name: 'TEST VECTOR sibling-shared manual asset changed' })
      .where(eq(assets.id, TEST_VECTOR.sharedCustomAssetId));
    const afterSharedAsset = await revision();
    expect(afterSharedAsset).not.toBe(initial);

    await h.db
      .update(priceHistory)
      .set({ close: '23' })
      .where(eq(priceHistory.assetId, TEST_VECTOR.sharedCustomAssetId));
    const afterSharedValue = await revision();
    expect(afterSharedValue).not.toBe(afterSharedAsset);

    await h.db
      .update(cashTags)
      .set({ name: 'TEST VECTOR referenced common tag changed' })
      .where(eq(cashTags.id, TEST_VECTOR.cashTagId));
    const afterCashTag = await revision();
    expect(afterCashTag).not.toBe(afterSharedValue);

    await h.db
      .update(mirrorRows)
      .set({ localId: TEST_VECTOR.changedMirrorLocalId })
      .where(
        and(
          eq(mirrorRows.portfolioId, TEST_VECTOR.targetPortfolioId),
          eq(mirrorRows.mirrorId, TEST_VECTOR.mirrorId),
        ),
      );
    expect(await revision()).not.toBe(afterCashTag);
  });

  it('uses FK-safe order, proves the frozen target scope, and leaves the sibling byte-identical', async () => {
    await seedLedgerGraph();
    const [siblingBefore] = await h.db
      .select()
      .from(portfolios)
      .where(eq(portfolios.id, TEST_VECTOR.siblingPortfolioId));

    await h.db.transaction(async (rawTx) => {
      const repo = createPortfolioVaultTransitionTransactionRepository(
        rawTx as unknown as Database,
      );
      const scope = await repo.capturePurgeScope(userId, TEST_VECTOR.targetPortfolioId);
      expect(scope.exclusiveCustomAssetIds).toEqual([TEST_VECTOR.exclusiveCustomAssetId]);
      await repo.purgePortfolio({
        userId,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        vaultId: TEST_VECTOR.vaultId,
        vaultAlias: 'TEST VECTOR locked target',
        scope,
      });
    });

    const [target, siblingAfter] = await Promise.all([
      h.db.select().from(portfolios).where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
      h.db.select().from(portfolios).where(eq(portfolios.id, TEST_VECTOR.siblingPortfolioId)),
    ]);
    expect(target[0]).toMatchObject({
      id: TEST_VECTOR.targetPortfolioId,
      name: vaultedPortfolioStubName(TEST_VECTOR.targetPortfolioId),
      vaultId: TEST_VECTOR.vaultId,
      vaultAlias: 'TEST VECTOR locked target',
      visibility: 'private',
    });
    expect(siblingAfter[0]).toEqual(siblingBefore);

    expect(
      await h.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.portfolioId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([]);
    expect(
      new Set(
        (
          await h.db
            .select({ id: transactions.id })
            .from(transactions)
            .where(eq(transactions.portfolioId, TEST_VECTOR.siblingPortfolioId))
        ).map(({ id: transactionId }) => transactionId),
      ),
    ).toEqual(new Set([TEST_VECTOR.siblingTransactionId, TEST_VECTOR.sharedSiblingTransactionId]));
    expect(
      await h.db
        .select({ id: cashBudgets.id })
        .from(cashBudgets)
        .where(eq(cashBudgets.portfolioId, TEST_VECTOR.siblingPortfolioId)),
    ).toEqual([{ id: TEST_VECTOR.siblingBudgetId }]);
    expect(
      await h.db
        .select({ id: standingOrders.id })
        .from(standingOrders)
        .where(eq(standingOrders.portfolioId, TEST_VECTOR.siblingPortfolioId)),
    ).toEqual([{ id: TEST_VECTOR.siblingOrderId }]);
    expect(
      await h.db
        .select({ id: importBatches.id })
        .from(importBatches)
        .where(eq(importBatches.portfolioId, TEST_VECTOR.siblingPortfolioId)),
    ).toEqual([{ id: TEST_VECTOR.siblingBatchId }]);
    expect(
      await h.db.select().from(cashTags).where(eq(cashTags.id, TEST_VECTOR.cashTagId)),
    ).toHaveLength(1);
    expect(
      await h.db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.id, TEST_VECTOR.exclusiveCustomAssetId)),
    ).toEqual([]);
    expect(
      await h.db
        .select({ id: assetIdentities.id, ownerId: assetIdentities.ownerId })
        .from(assetIdentities)
        .where(eq(assetIdentities.id, TEST_VECTOR.exclusiveCustomAssetId)),
    ).toEqual([{ id: TEST_VECTOR.exclusiveCustomAssetId, ownerId: userId }]);
    expect(
      await h.db
        .select({ close: priceHistory.close })
        .from(priceHistory)
        .where(eq(priceHistory.assetId, TEST_VECTOR.exclusiveCustomAssetId)),
    ).toEqual([]);
    expect(
      await h.db
        .select({ id: alerts.id, assetId: alerts.assetId })
        .from(alerts)
        .where(eq(alerts.id, TEST_VECTOR.exclusiveAssetAlertId)),
    ).toEqual([
      {
        id: TEST_VECTOR.exclusiveAssetAlertId,
        assetId: TEST_VECTOR.assetId,
      },
    ]);
    expect(
      await h.db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.id, TEST_VECTOR.sharedCustomAssetId)),
    ).toEqual([{ id: TEST_VECTOR.sharedCustomAssetId }]);
    expect(
      await h.db
        .select({ close: priceHistory.close })
        .from(priceHistory)
        .where(eq(priceHistory.assetId, TEST_VECTOR.sharedCustomAssetId)),
    ).toEqual([{ close: '22' }]);
    const scrubbedAudits = await h.db
      .select({ id: auditLog.id, meta: auditLog.meta })
      .from(auditLog)
      .where(eq(auditLog.action, 'api_key.scope_denied'));
    expect(scrubbedAudits).toEqual(
      expect.arrayContaining([
        {
          id: TEST_VECTOR.targetAuditId,
          meta: { reason: 'TEST VECTOR target denial' },
        },
        {
          id: TEST_VECTOR.siblingAuditId,
          meta: {
            path: `/api/v1/portfolios/${TEST_VECTOR.siblingPortfolioId}/transactions`,
            reason: 'TEST VECTOR sibling denial',
          },
        },
      ]),
    );
    expect(
      await h.db
        .select({ meta: auditLog.meta })
        .from(auditLog)
        .where(eq(auditLog.id, TEST_VECTOR.unscopedAuditId)),
    ).toEqual([
      {
        meta: {
          path: `/api/v1/assets/${TEST_VECTOR.exclusiveCustomAssetId}`,
          reason: 'TEST VECTOR different actor must remain',
        },
      },
    ]);
    expect(
      await h.db
        .select({ id: apiKeyRequestLog.id })
        .from(apiKeyRequestLog)
        .where(eq(apiKeyRequestLog.id, TEST_VECTOR.viewerApiLogId)),
    ).toEqual([]);
    expect(
      await h.db
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.id, TEST_VECTOR.targetIdempotencyId)),
    ).toEqual([]);
    expect(
      await h.db
        .select()
        .from(mirrorChainMembers)
        .where(eq(mirrorChainMembers.id, TEST_VECTOR.chainMemberId)),
    ).toHaveLength(1);
    expect(
      await h.db.select().from(shareAudiences).where(eq(shareAudiences.id, TEST_VECTOR.audienceId)),
    ).toEqual([]);
  });

  it('rejects a sibling frozen scope before deleting either portfolio', async () => {
    await seedLedgerGraph();
    const repo = createPortfolioVaultTransitionTransactionRepository(h.db);
    const siblingScope = await repo.capturePurgeScope(userId, TEST_VECTOR.siblingPortfolioId);

    await expect(
      repo.purgePortfolio({
        userId,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        vaultId: TEST_VECTOR.vaultId,
        vaultAlias: 'TEST VECTOR must not land',
        scope: siblingScope,
      }),
    ).rejects.toThrow('purge scope does not match');

    expect(
      await h.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.portfolioId, TEST_VECTOR.targetPortfolioId),
            eq(transactions.id, TEST_VECTOR.targetTransactionId),
          ),
        ),
    ).toEqual([{ id: TEST_VECTOR.targetTransactionId }]);
    expect(
      await h.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.id, TEST_VECTOR.siblingTransactionId)),
    ).toEqual([{ id: TEST_VECTOR.siblingTransactionId }]);
  });
});

describe('portfolio vault capture renewal', () => {
  it('removes the prior prospective document and invalidates its vault attestation', async () => {
    const oldBlob = envelope(TEST_VECTOR.targetPortfolioId, 'portfolio', 1);
    await h.db
      .update(vaults)
      .set({ mediaAttestedAt: TEST_VECTOR.at })
      .where(eq(vaults.id, TEST_VECTOR.vaultId));
    await h.db.insert(portfolioVaultTransitionStates).values({
      portfolioId: TEST_VECTOR.targetPortfolioId,
      userId,
      captureRevision: 'TEST_VECTOR_old_revision',
      captureExpiresAt: new Date('2099-08-21T10:00:00.000Z'),
      captureVaultId: TEST_VECTOR.vaultId,
      captureMediaAttestedAt: TEST_VECTOR.at,
    });
    await h.db.insert(vaultBlobs).values({
      vaultId: TEST_VECTOR.vaultId,
      docId: TEST_VECTOR.targetPortfolioId,
      docKind: 'portfolio',
      portfolioId: TEST_VECTOR.targetPortfolioId,
      version: 1,
      formatVersion: 2,
      sizeBytes: oldBlob.length,
      blob: oldBlob,
      createdAt: TEST_VECTOR.at,
      updatedAt: TEST_VECTOR.at,
    });
    await h.db.insert(vaultServerCandidates).values({
      id: TEST_VECTOR.priorCandidateId,
      transitionId: TEST_VECTOR.priorCandidateTransitionId,
      vaultId: TEST_VECTOR.vaultId,
      docId: TEST_VECTOR.targetPortfolioId,
      version: 1,
      formatVersion: 2,
      sizeBytes: oldBlob.length,
      blob: oldBlob,
      createdAt: TEST_VECTOR.at,
      expiresAt: new Date('2099-08-21T10:00:00.000Z'),
    });

    const renewedAt = new Date('2026-08-21T10:01:00.000Z');
    await expect(
      beginPortfolioVaultCapture({
        db: h.db,
        userId,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        revision: 'TEST_VECTOR_new_revision',
        now: renewedAt,
        expiresAt: new Date('2026-08-21T10:06:00.000Z'),
      }),
    ).resolves.toBe('ok');

    expect(
      await h.db
        .select({ docId: vaultBlobs.docId })
        .from(vaultBlobs)
        .where(
          and(
            eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId),
            eq(vaultBlobs.docId, TEST_VECTOR.targetPortfolioId),
          ),
        ),
    ).toEqual([]);
    expect(
      await h.db
        .select({ id: vaultServerCandidates.id })
        .from(vaultServerCandidates)
        .where(eq(vaultServerCandidates.id, TEST_VECTOR.priorCandidateId)),
    ).toEqual([]);
    expect(
      await h.db
        .select({
          mediaAttestedAt: vaults.mediaAttestedAt,
          mediaAttestedDriveConnectionId: vaults.mediaAttestedDriveConnectionId,
        })
        .from(vaults)
        .where(eq(vaults.id, TEST_VECTOR.vaultId)),
    ).toEqual([{ mediaAttestedAt: null, mediaAttestedDriveConnectionId: null }]);
    expect(
      await h.db
        .select({
          captureRevision: portfolioVaultTransitionStates.captureRevision,
          captureVaultId: portfolioVaultTransitionStates.captureVaultId,
        })
        .from(portfolioVaultTransitionStates)
        .where(eq(portfolioVaultTransitionStates.portfolioId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ captureRevision: 'TEST_VECTOR_new_revision', captureVaultId: null }]);
  });
});

describe('move-in document verification', () => {
  it('requires a current full-set attestation and the requested portfolio version', async () => {
    const expiresAt = new Date('2099-08-21T10:00:00.000Z');
    await h.db.insert(portfolioVaultTransitionStates).values({
      portfolioId: TEST_VECTOR.targetPortfolioId,
      userId,
      captureRevision: 'TEST_VECTOR_capture_revision',
      captureExpiresAt: expiresAt,
      captureVaultId: TEST_VECTOR.vaultId,
      captureMediaAttestedAt: TEST_VECTOR.at,
    });
    for (const [docId, docKind, version] of [
      [TEST_VECTOR.headerDocId, 'header', 1],
      [TEST_VECTOR.commonDocId, 'common', 1],
      [TEST_VECTOR.targetPortfolioId, 'portfolio', 7],
    ] as const) {
      const blob = envelope(docId, docKind, version);
      await h.db.insert(vaultBlobs).values({
        vaultId: TEST_VECTOR.vaultId,
        docId,
        docKind,
        portfolioId: docKind === 'portfolio' ? TEST_VECTOR.targetPortfolioId : null,
        version,
        formatVersion: 2,
        sizeBytes: blob.length,
        blob,
        createdAt: TEST_VECTOR.at,
        updatedAt: TEST_VECTOR.at,
      });
    }
    const [state] = await h.db
      .select()
      .from(portfolioVaultTransitionStates)
      .where(eq(portfolioVaultTransitionStates.portfolioId, TEST_VECTOR.targetPortfolioId));
    const [unattestedVault] = await h.db
      .select()
      .from(vaults)
      .where(eq(vaults.id, TEST_VECTOR.vaultId));
    if (!state || !unattestedVault) throw new Error('TEST VECTOR setup failed');
    const repo = createPortfolioVaultTransitionTransactionRepository(h.db);

    await expect(
      repo.verifyMoveInDocuments({
        vault: unattestedVault,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        docVersion: 7,
        now: TEST_VECTOR.at,
        state,
      }),
    ).resolves.toEqual({ mediaReady: false, portfolioVersion: null, exactRoster: false });

    await h.db
      .update(vaults)
      .set({ mediaAttestedAt: TEST_VECTOR.at })
      .where(eq(vaults.id, TEST_VECTOR.vaultId));
    const [attestedVault] = await h.db
      .select()
      .from(vaults)
      .where(eq(vaults.id, TEST_VECTOR.vaultId));
    if (!attestedVault) throw new Error('TEST VECTOR vault disappeared');

    await expect(
      repo.verifyMoveInDocuments({
        vault: attestedVault,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        docVersion: 8,
        now: TEST_VECTOR.at,
        state,
      }),
    ).resolves.toEqual({ mediaReady: true, portfolioVersion: 7, exactRoster: false });
    await expect(
      repo.verifyMoveInDocuments({
        vault: attestedVault,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        docVersion: 7,
        now: TEST_VECTOR.at,
        state,
      }),
    ).resolves.toEqual({ mediaReady: true, portfolioVersion: 7, exactRoster: true });
  });
});

describe('move-out document verification', () => {
  it('locks the exact active server roster and hashes its current version set', async () => {
    await h.db
      .update(portfolios)
      .set({ vaultId: TEST_VECTOR.vaultId })
      .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId));
    for (const [docId, docKind, version] of [
      [TEST_VECTOR.headerDocId, 'header', 1],
      [TEST_VECTOR.commonDocId, 'common', 2],
      [TEST_VECTOR.targetPortfolioId, 'portfolio', 7],
    ] as const) {
      const blob = envelope(docId, docKind, version);
      await h.db.insert(vaultBlobs).values({
        vaultId: TEST_VECTOR.vaultId,
        docId,
        docKind,
        portfolioId: docKind === 'portfolio' ? TEST_VECTOR.targetPortfolioId : null,
        version,
        formatVersion: 2,
        sizeBytes: blob.length,
        blob,
        createdAt: TEST_VECTOR.at,
        updatedAt: TEST_VECTOR.at,
      });
    }
    const repo = createPortfolioVaultTransitionTransactionRepository(h.db);
    const readVault = async () => {
      const [vault] = await h.db.select().from(vaults).where(eq(vaults.id, TEST_VECTOR.vaultId));
      if (!vault) throw new Error('TEST VECTOR vault disappeared');
      return vault;
    };

    await expect(
      repo.verifyMoveOutDocuments({
        vault: await readVault(),
        portfolioId: TEST_VECTOR.targetPortfolioId,
        now: TEST_VECTOR.at,
      }),
    ).resolves.toEqual({ mediaReady: false, exactRoster: false, documentSetHash: null });

    await h.db
      .update(vaults)
      .set({ mediaAttestedAt: TEST_VECTOR.at })
      .where(eq(vaults.id, TEST_VECTOR.vaultId));
    await expect(
      repo.verifyMoveOutDocuments({
        vault: await readVault(),
        portfolioId: TEST_VECTOR.targetPortfolioId,
        now: TEST_VECTOR.at,
      }),
    ).resolves.toEqual({
      mediaReady: true,
      exactRoster: true,
      documentSetHash: versionSetHash([
        { docId: TEST_VECTOR.headerDocId, version: 1 },
        { docId: TEST_VECTOR.commonDocId, version: 2 },
        { docId: TEST_VECTOR.targetPortfolioId, version: 7 },
      ]),
    });

    const first = await repo.verifyMoveOutDocuments({
      vault: await readVault(),
      portfolioId: TEST_VECTOR.targetPortfolioId,
      now: TEST_VECTOR.at,
    });
    const updatedCommon = envelope(TEST_VECTOR.commonDocId, 'common', 3);
    await h.db
      .update(vaultBlobs)
      .set({ version: 3, blob: updatedCommon, sizeBytes: updatedCommon.length })
      .where(
        and(
          eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId),
          eq(vaultBlobs.docId, TEST_VECTOR.commonDocId),
        ),
      );
    const changed = await repo.verifyMoveOutDocuments({
      vault: await readVault(),
      portfolioId: TEST_VECTOR.targetPortfolioId,
      now: TEST_VECTOR.at,
    });
    expect(changed).toEqual({
      mediaReady: true,
      exactRoster: true,
      documentSetHash: versionSetHash([
        { docId: TEST_VECTOR.headerDocId, version: 1 },
        { docId: TEST_VECTOR.commonDocId, version: 3 },
        { docId: TEST_VECTOR.targetPortfolioId, version: 7 },
      ]),
    });
    expect(changed.documentSetHash).not.toBe(first.documentSetHash);

    await h.db
      .delete(vaultBlobs)
      .where(
        and(
          eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId),
          eq(vaultBlobs.docId, TEST_VECTOR.commonDocId),
        ),
      );
    await expect(
      repo.verifyMoveOutDocuments({
        vault: await readVault(),
        portfolioId: TEST_VECTOR.targetPortfolioId,
        now: TEST_VECTOR.at,
      }),
    ).resolves.toEqual({ mediaReady: true, exactRoster: false, documentSetHash: null });
  });

  it('requires one live, single-transition, exact Drive candidate roster', async () => {
    await h.db.insert(driveConnections).values({
      id: TEST_VECTOR.driveConnectionId,
      userId,
      googleSub: 'TEST_VECTOR_move_out_drive_sub',
      email: 'test-vector-move-out-drive@example.test',
    });
    await h.db
      .update(portfolios)
      .set({ vaultId: TEST_VECTOR.vaultId })
      .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId));
    await h.db
      .update(vaults)
      .set({
        media: ['drive'],
        driveConnectionId: TEST_VECTOR.driveConnectionId,
        mediaAttestedAt: TEST_VECTOR.at,
        mediaAttestedDriveConnectionId: TEST_VECTOR.driveConnectionId,
      })
      .where(eq(vaults.id, TEST_VECTOR.vaultId));
    const [vault] = await h.db.select().from(vaults).where(eq(vaults.id, TEST_VECTOR.vaultId));
    if (!vault) throw new Error('TEST VECTOR vault disappeared');
    const repo = createPortfolioVaultTransitionTransactionRepository(h.db);
    const driveTransitionId = id(60);
    const driveRows = [
      { id: id(61), docId: TEST_VECTOR.headerDocId, docKind: 'header', version: 1 },
      { id: id(62), docId: TEST_VECTOR.commonDocId, docKind: 'common', version: 2 },
      {
        id: id(63),
        docId: TEST_VECTOR.targetPortfolioId,
        docKind: 'portfolio',
        version: 7,
      },
    ] as const;
    await h.db.insert(vaultServerCandidates).values(
      driveRows.map((row) => {
        const blob = envelope(row.docId, row.docKind, row.version);
        return {
          id: row.id,
          transitionId: driveTransitionId,
          vaultId: TEST_VECTOR.vaultId,
          docId: row.docId,
          version: row.version,
          formatVersion: 2,
          sizeBytes: blob.length,
          blob,
          createdAt: TEST_VECTOR.at,
          expiresAt: new Date('2026-08-21T10:05:00.000Z'),
        };
      }),
    );
    const expectedHash = versionSetHash(driveRows);

    await expect(
      repo.verifyMoveOutDocuments({
        vault,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        now: TEST_VECTOR.at,
      }),
    ).resolves.toEqual({ mediaReady: true, exactRoster: true, documentSetHash: expectedHash });

    await h.db
      .delete(vaultServerCandidates)
      .where(
        and(
          eq(vaultServerCandidates.vaultId, TEST_VECTOR.vaultId),
          eq(vaultServerCandidates.docId, TEST_VECTOR.commonDocId),
        ),
      );
    await expect(
      repo.verifyMoveOutDocuments({
        vault,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        now: TEST_VECTOR.at,
      }),
    ).resolves.toEqual({ mediaReady: true, exactRoster: false, documentSetHash: null });

    const staleCommon = envelope(TEST_VECTOR.commonDocId, 'common', 2);
    await h.db.insert(vaultServerCandidates).values({
      id: id(64),
      transitionId: driveTransitionId,
      vaultId: TEST_VECTOR.vaultId,
      docId: TEST_VECTOR.commonDocId,
      version: 2,
      formatVersion: 2,
      sizeBytes: staleCommon.length,
      blob: staleCommon,
      createdAt: TEST_VECTOR.at,
      expiresAt: TEST_VECTOR.at,
    });
    await expect(
      repo.verifyMoveOutDocuments({
        vault,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        now: TEST_VECTOR.at,
      }),
    ).resolves.toEqual({ mediaReady: true, exactRoster: false, documentSetHash: null });

    await h.db
      .update(vaultServerCandidates)
      .set({ transitionId: id(65), expiresAt: new Date('2026-08-21T10:05:00.000Z') })
      .where(eq(vaultServerCandidates.docId, TEST_VECTOR.commonDocId));
    await expect(
      repo.verifyMoveOutDocuments({
        vault,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        now: TEST_VECTOR.at,
      }),
    ).resolves.toEqual({ mediaReady: true, exactRoster: false, documentSetHash: null });

    await h.db
      .update(vaultServerCandidates)
      .set({
        transitionId: driveTransitionId,
        createdAt: new Date('2026-08-21T10:01:00.000Z'),
      })
      .where(eq(vaultServerCandidates.docId, TEST_VECTOR.commonDocId));
    await expect(
      repo.verifyMoveOutDocuments({
        vault,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        now: TEST_VECTOR.at,
      }),
    ).resolves.toEqual({ mediaReady: true, exactRoster: false, documentSetHash: null });

    await expect(
      repo.verifyMoveOutDocuments({
        vault: { ...vault, mediaAttestedDriveConnectionId: null },
        portfolioId: TEST_VECTOR.targetPortfolioId,
        now: TEST_VECTOR.at,
      }),
    ).resolves.toEqual({ mediaReady: false, exactRoster: false, documentSetHash: null });
  });
});

describe('portfolio vault cleartext export retirement', () => {
  it('selects every owner pointer, preserves pending blocking, and finalizes only retired owner rows', async () => {
    const foreign = await h.seedUser({
      email: 'portfolio-transition-export-foreign@bettertrack.test',
      username: 'portfolio_transition_export_foreign',
    });
    const expiresAt = new Date('2099-08-21T10:00:00.000Z');
    await h.db.insert(exportJobs).values([
      {
        id: TEST_VECTOR.pendingExportId,
        userId,
        status: 'pending',
        filePath: '/TEST_VECTOR/owner-pending.zip',
        fileSize: 101,
        downloadTokenHash: 'TEST_VECTOR_owner_pending_token_hash',
        expiresAt,
        readyAt: TEST_VECTOR.at,
      },
      {
        id: TEST_VECTOR.readyExportId,
        userId,
        status: 'ready',
        filePath: '/TEST_VECTOR/owner-ready.zip',
        fileSize: 202,
        downloadTokenHash: 'TEST_VECTOR_owner_ready_token_hash',
        expiresAt,
        readyAt: TEST_VECTOR.at,
      },
      {
        id: TEST_VECTOR.failedExportId,
        userId,
        status: 'failed',
        filePath: '/TEST_VECTOR/owner-failed.zip',
        fileSize: 303,
        downloadTokenHash: 'TEST_VECTOR_owner_failed_token_hash',
        expiresAt,
        readyAt: TEST_VECTOR.at,
        error: 'TEST_VECTOR_prior_failure',
      },
      {
        id: TEST_VECTOR.pointerlessExportId,
        userId,
        status: 'ready',
        filePath: null,
        fileSize: 404,
        downloadTokenHash: 'TEST_VECTOR_owner_pointerless_token_hash',
        expiresAt,
        readyAt: TEST_VECTOR.at,
      },
      {
        id: TEST_VECTOR.foreignExportId,
        userId: foreign.id,
        status: 'ready',
        filePath: '/TEST_VECTOR/foreign-ready.zip',
        fileSize: 505,
        downloadTokenHash: 'TEST_VECTOR_foreign_ready_token_hash',
        expiresAt,
        readyAt: TEST_VECTOR.at,
      },
    ]);
    const repo = createPortfolioVaultTransitionTransactionRepository(h.db);

    await expect(repo.blocker(userId, TEST_VECTOR.targetPortfolioId)).resolves.toBe(
      'pending_export',
    );
    const artifacts = await repo.lockCleartextExports(userId);
    expect(artifacts).toHaveLength(3);
    expect(artifacts).toEqual(
      expect.arrayContaining([
        { id: TEST_VECTOR.pendingExportId, filePath: '/TEST_VECTOR/owner-pending.zip' },
        { id: TEST_VECTOR.readyExportId, filePath: '/TEST_VECTOR/owner-ready.zip' },
        { id: TEST_VECTOR.failedExportId, filePath: '/TEST_VECTOR/owner-failed.zip' },
      ]),
    );
    await expect(repo.blocker(userId, TEST_VECTOR.targetPortfolioId)).resolves.toBe(
      'pending_export',
    );

    const artifactIds = artifacts.map(({ id: exportId }) => exportId);
    await repo.retireCleartextExports(userId, [...artifactIds, TEST_VECTOR.foreignExportId]);
    const afterRetire = await h.db.select().from(exportJobs);
    for (const exportId of artifactIds) {
      expect(afterRetire.find(({ id: rowId }) => rowId === exportId)).toMatchObject({
        status: 'failed',
        filePath: expect.any(String),
        fileSize: null,
        downloadTokenHash: null,
        expiresAt: null,
        readyAt: null,
        error: PARANOID_RETIRED_EXPORT_ERROR,
      });
    }
    expect(
      afterRetire.find(({ id: rowId }) => rowId === TEST_VECTOR.pointerlessExportId),
    ).toMatchObject({
      status: 'ready',
      filePath: null,
      fileSize: 404,
      downloadTokenHash: 'TEST_VECTOR_owner_pointerless_token_hash',
    });
    expect(
      afterRetire.find(({ id: rowId }) => rowId === TEST_VECTOR.foreignExportId),
    ).toMatchObject({
      status: 'ready',
      filePath: '/TEST_VECTOR/foreign-ready.zip',
      fileSize: 505,
      downloadTokenHash: 'TEST_VECTOR_foreign_ready_token_hash',
    });
    await expect(repo.blocker(userId, TEST_VECTOR.targetPortfolioId)).resolves.toBeNull();

    await repo.finalizeRetiredCleartextExports(userId, [
      ...artifactIds,
      TEST_VECTOR.foreignExportId,
    ]);
    const afterFinalize = await h.db.select().from(exportJobs);
    for (const exportId of artifactIds) {
      expect(afterFinalize.find(({ id: rowId }) => rowId === exportId)?.filePath).toBeNull();
    }
    expect(
      afterFinalize.find(({ id: rowId }) => rowId === TEST_VECTOR.foreignExportId)?.filePath,
    ).toBe('/TEST_VECTOR/foreign-ready.zip');
  });
});

describe('portfolio document archival', () => {
  async function lockTargetAndInsertActive(): Promise<void> {
    await h.db
      .update(portfolios)
      .set({
        name: vaultedPortfolioStubName(TEST_VECTOR.targetPortfolioId),
        vaultId: TEST_VECTOR.vaultId,
        vaultAlias: 'TEST VECTOR locked target',
      })
      .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId));
    await h.db.insert(vaultBlobs).values({
      vaultId: TEST_VECTOR.vaultId,
      docId: TEST_VECTOR.targetPortfolioId,
      docKind: 'portfolio',
      portfolioId: TEST_VECTOR.targetPortfolioId,
      version: 7,
      formatVersion: 2,
      sizeBytes: TEST_VECTOR.activeBytes.length,
      blob: TEST_VECTOR.activeBytes,
      createdAt: TEST_VECTOR.at,
      updatedAt: TEST_VECTOR.at,
    });
  }

  it('refuses a same-version history row with different exact bytes', async () => {
    await lockTargetAndInsertActive();
    await h.db.insert(vaultBlobHistory).values({
      vaultId: TEST_VECTOR.vaultId,
      docId: TEST_VECTOR.targetPortfolioId,
      version: 7,
      formatVersion: 2,
      sizeBytes: TEST_VECTOR.conflictingBytes.length,
      blob: TEST_VECTOR.conflictingBytes,
      createdAt: TEST_VECTOR.at,
    });

    const result = await createPortfolioVaultTransitionTransactionRepository(
      h.db,
    ).archiveAndRemovePortfolioDocument({
      vaultId: TEST_VECTOR.vaultId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      now: new Date('2026-08-21T11:00:00.000Z'),
      historyMaxVersions: 5,
      historyMaxAgeMs: 86_400_000,
    });

    expect(result).toBe('conflict');
    expect(
      await h.db
        .select({ blob: vaultBlobs.blob })
        .from(vaultBlobs)
        .where(
          and(
            eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId),
            eq(vaultBlobs.docId, TEST_VECTOR.targetPortfolioId),
          ),
        ),
    ).toEqual([{ blob: TEST_VECTOR.activeBytes }]);
  });

  it('checks the retired set too, while a byte-identical retained version is idempotent', async () => {
    await lockTargetAndInsertActive();
    await h.db.insert(vaultBlobHistory).values({
      vaultId: TEST_VECTOR.vaultId,
      docId: TEST_VECTOR.targetPortfolioId,
      version: 7,
      formatVersion: 2,
      sizeBytes: TEST_VECTOR.activeBytes.length,
      blob: TEST_VECTOR.activeBytes,
      createdAt: TEST_VECTOR.at,
    });
    await h.db.insert(vaultRetired).values({
      vaultId: TEST_VECTOR.vaultId,
      docId: TEST_VECTOR.targetPortfolioId,
      version: 7,
      formatVersion: 2,
      sizeBytes: TEST_VECTOR.conflictingBytes.length,
      blob: TEST_VECTOR.conflictingBytes,
      createdAt: TEST_VECTOR.at,
      retiredAt: TEST_VECTOR.at,
    });
    const repo = createPortfolioVaultTransitionTransactionRepository(h.db);

    expect(
      await repo.archiveAndRemovePortfolioDocument({
        vaultId: TEST_VECTOR.vaultId,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        now: new Date('2026-08-21T11:00:00.000Z'),
        historyMaxVersions: 5,
        historyMaxAgeMs: 86_400_000,
      }),
    ).toBe('conflict');
    await h.db
      .delete(vaultRetired)
      .where(
        and(
          eq(vaultRetired.vaultId, TEST_VECTOR.vaultId),
          eq(vaultRetired.docId, TEST_VECTOR.targetPortfolioId),
        ),
      );

    expect(
      await repo.archiveAndRemovePortfolioDocument({
        vaultId: TEST_VECTOR.vaultId,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        now: new Date('2026-08-21T11:00:00.000Z'),
        historyMaxVersions: 5,
        historyMaxAgeMs: 86_400_000,
      }),
    ).toBe('ok');
    expect(
      await h.db
        .select()
        .from(vaultBlobs)
        .where(
          and(
            eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId),
            eq(vaultBlobs.docId, TEST_VECTOR.targetPortfolioId),
          ),
        ),
    ).toEqual([]);
    expect(
      await h.db
        .select({ version: vaultBlobHistory.version, blob: vaultBlobHistory.blob })
        .from(vaultBlobHistory)
        .where(
          and(
            eq(vaultBlobHistory.vaultId, TEST_VECTOR.vaultId),
            eq(vaultBlobHistory.docId, TEST_VECTOR.targetPortfolioId),
          ),
        ),
    ).toEqual([{ version: 7, blob: TEST_VECTOR.activeBytes }]);
  });
});

describe('portfolio vault transition receipts', () => {
  it('rotates an attempted poison finalization behind an unattempted pending row', async () => {
    // TEST VECTOR: the target is deliberately older and therefore wins the
    // first bounded sweep. It remains pending after the simulated failure.
    await h.db.insert(portfolioVaultTransitionStates).values([
      {
        portfolioId: TEST_VECTOR.targetPortfolioId,
        userId,
        lifecycleGeneration: 1,
        moveOutVaultId: TEST_VECTOR.vaultId,
        moveOutId: id(55),
        moveOutDocumentDigest: 'TEST_VECTOR_poison_restore_digest',
        moveOutDocumentSetHash: 'TEST_VECTOR_poison_document_set_hash',
        moveOutProofPublicKey: 'TEST VECTOR poison proof public key',
        moveOutCompletedAt: new Date('2026-08-21T09:00:00.000Z'),
        moveOutPostCommitPending: true,
        moveOutPostCommitCustomAssetIds: [],
        updatedAt: new Date('2026-08-21T09:00:00.000Z'),
      },
      {
        portfolioId: TEST_VECTOR.siblingPortfolioId,
        userId,
        lifecycleGeneration: 1,
        moveOutVaultId: TEST_VECTOR.vaultId,
        moveOutId: id(56),
        moveOutDocumentDigest: 'TEST_VECTOR_newer_restore_digest',
        moveOutDocumentSetHash: 'TEST_VECTOR_newer_document_set_hash',
        moveOutProofPublicKey: 'TEST VECTOR newer proof public key',
        moveOutCompletedAt: new Date('2026-08-21T09:01:00.000Z'),
        moveOutPostCommitPending: true,
        moveOutPostCommitCustomAssetIds: [],
        updatedAt: new Date('2026-08-21T09:01:00.000Z'),
      },
    ]);

    const first = await listPendingPortfolioVaultMoveOutFinalizations(h.db, 1);
    expect(first).toEqual([
      {
        userId,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        lifecycleGeneration: 1,
      },
    ]);
    expect(await markPendingPortfolioVaultMoveOutFinalizationAttempt(h.db, first[0]!)).toBe(true);

    const [poison] = await h.db
      .select({
        pending: portfolioVaultTransitionStates.moveOutPostCommitPending,
        lastAttemptAt: portfolioVaultTransitionStates.moveOutPostCommitLastAttemptAt,
      })
      .from(portfolioVaultTransitionStates)
      .where(eq(portfolioVaultTransitionStates.portfolioId, TEST_VECTOR.targetPortfolioId));
    expect(poison).toMatchObject({ pending: true });
    expect(poison!.lastAttemptAt).not.toBeNull();

    expect(await listPendingPortfolioVaultMoveOutFinalizations(h.db, 1)).toEqual([
      {
        userId,
        portfolioId: TEST_VECTOR.siblingPortfolioId,
        lifecycleGeneration: 1,
      },
    ]);
  });

  it('freshens attestation at move-in and invalidates it when move-out changes the roster', async () => {
    const repo = createPortfolioVaultTransitionTransactionRepository(h.db);
    await h.db
      .update(portfolios)
      .set({ vaultId: TEST_VECTOR.vaultId, vaultAlias: 'TEST VECTOR locked target' })
      .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId));
    await h.db.insert(portfolioVaultTransitionStates).values({
      portfolioId: TEST_VECTOR.targetPortfolioId,
      userId,
      lifecycleGeneration: 1,
      moveOutVaultId: TEST_VECTOR.vaultId,
      moveOutId: id(57),
      moveOutDocumentDigest: 'TEST_VECTOR_prior_restore_digest',
      moveOutDocumentSetHash: 'TEST_VECTOR_prior_document_set_hash',
      moveOutProofPublicKey: 'TEST VECTOR prior proof public key',
      moveOutCompletedAt: new Date('2026-08-21T09:59:00.000Z'),
    });

    await repo.completeMoveIn({
      userId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      vaultId: TEST_VECTOR.vaultId,
      docVersion: 7,
      lifecycleGeneration: 2,
      retiredCustomAssetIds: [TEST_VECTOR.assetId],
      completedAt: TEST_VECTOR.at,
    });
    expect(
      await h.db
        .select({ mediaAttestedAt: vaults.mediaAttestedAt })
        .from(vaults)
        .where(eq(vaults.id, TEST_VECTOR.vaultId)),
    ).toEqual([{ mediaAttestedAt: TEST_VECTOR.at }]);
    await expect(
      h.db
        .select({ documentSetHash: portfolioVaultTransitionStates.moveOutDocumentSetHash })
        .from(portfolioVaultTransitionStates)
        .where(eq(portfolioVaultTransitionStates.portfolioId, TEST_VECTOR.targetPortfolioId)),
    ).resolves.toEqual([{ documentSetHash: null }]);

    const movedOutAt = new Date('2026-08-21T10:05:00.000Z');
    await repo.completeMoveOut({
      userId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      vaultId: TEST_VECTOR.vaultId,
      moveOutId: id(49),
      lifecycleGeneration: 2,
      documentDigest: 'TEST_VECTOR_restore_document_digest',
      documentSetHash: 'TEST_VECTOR_encrypted_document_set_hash',
      proofPublicKey: 'TEST VECTOR move-out proof public key',
      customAssetIds: [TEST_VECTOR.assetId],
      completedAt: movedOutAt,
    });
    expect(
      await h.db
        .select({
          mediaAttestedAt: vaults.mediaAttestedAt,
          mediaAttestedDriveConnectionId: vaults.mediaAttestedDriveConnectionId,
        })
        .from(vaults)
        .where(eq(vaults.id, TEST_VECTOR.vaultId)),
    ).toEqual([{ mediaAttestedAt: null, mediaAttestedDriveConnectionId: null }]);
    expect(
      await h.db
        .select({ vaultId: portfolios.vaultId, vaultAlias: portfolios.vaultAlias })
        .from(portfolios)
        .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ vaultId: null, vaultAlias: null }]);
    const pending = await readPendingPortfolioVaultMoveOutFinalization(
      h.db,
      userId,
      TEST_VECTOR.targetPortfolioId,
    );
    expect(pending).toMatchObject({
      vaultId: TEST_VECTOR.vaultId,
      lifecycleGeneration: 2,
      customAssetIds: [TEST_VECTOR.assetId],
      completedAt: movedOutAt,
    });
    expect(pending).not.toBeNull();
    await expect(
      h.db
        .select({ documentSetHash: portfolioVaultTransitionStates.moveOutDocumentSetHash })
        .from(portfolioVaultTransitionStates)
        .where(eq(portfolioVaultTransitionStates.portfolioId, TEST_VECTOR.targetPortfolioId)),
    ).resolves.toEqual([{ documentSetHash: 'TEST_VECTOR_encrypted_document_set_hash' }]);
    expect(await completePendingPortfolioVaultMoveOut(h.db, pending!)).toBe(true);
    expect(
      await h.db
        .select({ vaultId: portfolios.vaultId, vaultAlias: portfolios.vaultAlias })
        .from(portfolios)
        .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ vaultId: null, vaultAlias: null }]);
  });
});

/**
 * #1491 (Chief ruling, 2026-08-22). A Drive-only move-in deletes the portfolio's
 * last server-readable bytes, and the server's Drive attestation is only a
 * consistency check against its own rows — §8/§22 deny it any Drive capability,
 * so it can never be evidence that bytes reached Drive. The staged batch is
 * therefore retained to its own `expires_at` instead of being deleted at commit:
 * inactive the whole time, gone at the TTL.
 */
describe('Drive-only staged candidate retention', () => {
  const RETENTION = {
    transitionId: id(70),
    headerCandidateId: id(71),
    commonCandidateId: id(72),
    portfolioCandidateId: id(73),
    // Staged at TEST_VECTOR.at; VAULT_SERVER_CANDIDATE_TTL_MS is 10 minutes.
    expiresAt: new Date('2026-08-21T10:10:00.000Z'),
    insideWindow: new Date('2026-08-21T10:09:59.999Z'),
  } as const;

  const stagedDocs = [
    { candidateId: RETENTION.headerCandidateId, docId: TEST_VECTOR.headerDocId, kind: 'header' },
    { candidateId: RETENTION.commonCandidateId, docId: TEST_VECTOR.commonDocId, kind: 'common' },
    {
      candidateId: RETENTION.portfolioCandidateId,
      docId: TEST_VECTOR.targetPortfolioId,
      kind: 'portfolio',
    },
  ] as const;

  const portfolioCiphertext = () => envelope(TEST_VECTOR.targetPortfolioId, 'portfolio', 7);

  async function stagedDriveOnlyMoveIn(): Promise<void> {
    await h.db.insert(driveConnections).values({
      id: TEST_VECTOR.driveConnectionId,
      userId,
      googleSub: 'TEST_VECTOR_retention_drive_sub',
      email: 'test-vector-retention-drive@example.test',
    });
    await h.db
      .update(vaults)
      .set({
        media: ['drive'],
        driveConnectionId: TEST_VECTOR.driveConnectionId,
        mediaAttestedAt: TEST_VECTOR.at,
        mediaAttestedDriveConnectionId: TEST_VECTOR.driveConnectionId,
      })
      .where(eq(vaults.id, TEST_VECTOR.vaultId));
    await h.db
      .update(portfolios)
      .set({ vaultId: TEST_VECTOR.vaultId, vaultAlias: 'TEST VECTOR vault' })
      .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId));
    await h.db.insert(vaultServerCandidates).values(
      stagedDocs.map(({ candidateId, docId, kind }) => {
        const blob = envelope(docId, kind, kind === 'portfolio' ? 7 : 1);
        return {
          id: candidateId,
          transitionId: RETENTION.transitionId,
          vaultId: TEST_VECTOR.vaultId,
          docId,
          version: kind === 'portfolio' ? 7 : 1,
          formatVersion: 2,
          sizeBytes: blob.length,
          blob,
          createdAt: TEST_VECTOR.at,
          expiresAt: RETENTION.expiresAt,
        };
      }),
    );
    await createPortfolioVaultTransitionTransactionRepository(h.db).completeMoveIn({
      userId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      vaultId: TEST_VECTOR.vaultId,
      docVersion: 7,
      lifecycleGeneration: 1,
      retiredCustomAssetIds: [],
      completedAt: TEST_VECTOR.at,
    });
  }

  async function stagedDocIds(): Promise<string[]> {
    const rows = await h.db
      .select({ docId: vaultServerCandidates.docId })
      .from(vaultServerCandidates)
      .where(eq(vaultServerCandidates.vaultId, TEST_VECTOR.vaultId))
      .orderBy(vaultServerCandidates.docId);
    return rows.map((row) => row.docId).sort();
  }

  it('keeps the batch after move-in as inactive rows that never serve a read', async () => {
    await stagedDriveOnlyMoveIn();

    expect(await stagedDocIds()).toEqual(
      stagedDocs
        .map(({ docId }) => docId)
        .slice()
        .sort() as string[],
    );
    // The `media` set stays the authority: server never joins it, and no
    // candidate is promoted into the active `vault_blobs` plane.
    expect(
      await h.db
        .select({ media: vaults.media, mediaAttestedAt: vaults.mediaAttestedAt })
        .from(vaults)
        .where(eq(vaults.id, TEST_VECTOR.vaultId)),
    ).toEqual([{ media: ['drive'], mediaAttestedAt: TEST_VECTOR.at }]);
    expect(
      await h.db
        .select({ docId: vaultBlobs.docId })
        .from(vaultBlobs)
        .where(eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId)),
    ).toEqual([]);

    const blobs = createVaultBlobRepository(h.db);
    // The read path resolves against the active plane only, so a retained
    // candidate can never be served as this vault's document.
    for (const { docId } of stagedDocs) {
      await expect(blobs.readCurrent(userId, TEST_VECTOR.vaultId, docId)).resolves.toEqual({
        status: 'medium_inactive',
      });
    }
    // The probe: the vault reports Drive as its only medium and the retained
    // rows as inactive candidates, never as a data home.
    const state = await blobs.getMediaState(userId, TEST_VECTOR.vaultId, RETENTION.insideWindow);
    expect(state).toMatchObject({
      media: ['drive'],
      driveConnectionId: TEST_VECTOR.driveConnectionId,
      server: { disposition: 'inactive-candidates', retirement: null },
    });
    expect(state?.server.candidates.map(({ candidateId }) => candidateId).sort()).toEqual(
      stagedDocs
        .map(({ candidateId }) => candidateId)
        .slice()
        .sort(),
    );
  });

  it('recovers the portfolio ciphertext inside the window and never after the TTL', async () => {
    await stagedDriveOnlyMoveIn();
    const blobs = createVaultBlobRepository(h.db);

    // The failure this retention exists for: the client attested a Drive write
    // that never landed. The server cannot detect that — it has no Drive
    // capability — so recovery is exactly "the retained ciphertext is still
    // readable and still byte-identical to what was moved in".
    const recovered = await blobs.getServerCandidate(
      userId,
      TEST_VECTOR.vaultId,
      RETENTION.portfolioCandidateId,
      RETENTION.insideWindow,
    );
    expect(recovered).not.toBeNull();
    expect(Buffer.from(recovered!.blob).equals(portfolioCiphertext())).toBe(true);

    // The honest boundary: at `expires_at` the same read disposes the row and
    // reports nothing. Past this point a lost Drive write is unrecoverable.
    await expect(
      blobs.getServerCandidate(
        userId,
        TEST_VECTOR.vaultId,
        RETENTION.portfolioCandidateId,
        RETENTION.expiresAt,
      ),
    ).resolves.toBeNull();
    expect(await stagedDocIds()).toEqual(
      [TEST_VECTOR.commonDocId, TEST_VECTOR.headerDocId].slice().sort(),
    );
    // The vault is never read again: the #1521 sweep is what makes the TTL real.
    expect(await blobs.cleanupExpiredServerCandidates(RETENTION.expiresAt, 100)).toBe(2);
    expect(await stagedDocIds()).toEqual([]);
  });

  it('keeps the batch on the move-out sibling path too', async () => {
    await stagedDriveOnlyMoveIn();
    await createPortfolioVaultTransitionTransactionRepository(h.db).completeMoveOut({
      userId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      vaultId: TEST_VECTOR.vaultId,
      moveOutId: id(74),
      lifecycleGeneration: 1,
      documentDigest: 'TEST_VECTOR_retention_restore_digest',
      documentSetHash: 'TEST_VECTOR_retention_document_set_hash',
      proofPublicKey: 'TEST VECTOR retention proof public key',
      customAssetIds: [],
      completedAt: new Date('2026-08-21T10:05:00.000Z'),
    });

    expect(await stagedDocIds()).toEqual(
      stagedDocs
        .map(({ docId }) => docId)
        .slice()
        .sort() as string[],
    );
    // Unchanged by the retention: the roster moved, so the vault stays stale
    // until the client re-attests a fresh full set.
    expect(
      await h.db
        .select({ mediaAttestedAt: vaults.mediaAttestedAt })
        .from(vaults)
        .where(eq(vaults.id, TEST_VECTOR.vaultId)),
    ).toEqual([{ mediaAttestedAt: null }]);
  });
});
