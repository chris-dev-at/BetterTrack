import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import type { Database } from '../../db';
import { assetIdentities, portfolios, vaults } from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  isPortfolioVaultLiveRetirementRequired,
  portfolioVaultLiveRetirementOwner,
} from '../portfolioVaultLiveRetirementRepository';
import {
  completePendingPortfolioVaultMoveOut,
  createPortfolioVaultTransitionTransactionRepository,
  readPendingPortfolioVaultMoveOutFinalization,
} from '../portfolioVaultTransitionRepository';

// Deterministic TEST VECTOR UUIDs and receipt metadata; none are credentials.
const TEST_VECTOR = {
  vaultId: '019c82a0-0000-7000-8000-000000000001',
  headerDocId: '019c82a0-0000-7000-8000-000000000002',
  commonDocId: '019c82a0-0000-7000-8000-000000000003',
  targetPortfolioId: '019c82a0-0000-7000-8000-000000000004',
  siblingPortfolioId: '019c82a0-0000-7000-8000-000000000005',
  targetAssetId: '019c82a0-0000-7000-8000-000000000006',
  siblingAssetId: '019c82a0-0000-7000-8000-000000000007',
  moveOutId: '019c82a0-0000-7000-8000-000000000008',
  movedInAt: new Date('2026-08-21T10:00:00.000Z'),
  movedOutAt: new Date('2026-08-21T10:05:00.000Z'),
} as const;

let h: TestHarness;
let userId: string;

beforeEach(async () => {
  h = await createTestApp();
  const user = await h.seedUser({
    email: 'live-retirement-repository@bettertrack.test',
    username: 'live_retirement_repository',
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
    },
    {
      id: TEST_VECTOR.siblingPortfolioId,
      userId,
      name: 'TEST VECTOR sibling',
    },
  ]);
  await h.db.insert(assetIdentities).values([
    { id: TEST_VECTOR.targetAssetId, ownerId: userId },
    { id: TEST_VECTOR.siblingAssetId, ownerId: userId },
  ]);
});

// NOTE: no redis.quit() here — the redis handle is the shared module-level
// singleton; quitting it in real-Redis (integration) mode kills every later
// suite in the singleFork process (the #1456 landmine class).

describe('portfolio vault Live Mode retirement reconciliation', () => {
  it('resolves an owner from the content-free identity after asset content is absent', async () => {
    expect(await portfolioVaultLiveRetirementOwner(h.db, TEST_VECTOR.targetAssetId)).toBe(userId);
    expect(
      await portfolioVaultLiveRetirementOwner(h.db, '019c82a0-0000-7000-8000-000000000099'),
    ).toBeNull();
  });

  it('distinguishes rolled-back, committed, pending move-out, and finalized state', async () => {
    // TEST VECTOR: the Redis fence is installed before this transaction. A
    // process death/rollback must leave no durable reason to keep it closed.
    await expect(
      h.db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        await tx
          .update(portfolios)
          .set({ vaultId: TEST_VECTOR.vaultId, vaultAlias: 'TEST VECTOR locked target' })
          .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId));
        await createPortfolioVaultTransitionTransactionRepository(tx).completeMoveIn({
          userId,
          portfolioId: TEST_VECTOR.targetPortfolioId,
          vaultId: TEST_VECTOR.vaultId,
          docVersion: 1,
          lifecycleGeneration: 1,
          retiredCustomAssetIds: [TEST_VECTOR.targetAssetId],
          completedAt: TEST_VECTOR.movedInAt,
        });
        throw new Error('TEST VECTOR forced rollback');
      }),
    ).rejects.toThrow('TEST VECTOR forced rollback');

    expect(
      await isPortfolioVaultLiveRetirementRequired(h.db, userId, TEST_VECTOR.targetAssetId),
    ).toBe(false);
    expect(
      await h.db
        .select({ vaultId: portfolios.vaultId })
        .from(portfolios)
        .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ vaultId: null }]);

    await h.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      await tx
        .update(portfolios)
        .set({ vaultId: TEST_VECTOR.vaultId, vaultAlias: 'TEST VECTOR locked target' })
        .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId));
      await createPortfolioVaultTransitionTransactionRepository(tx).completeMoveIn({
        userId,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        vaultId: TEST_VECTOR.vaultId,
        docVersion: 1,
        lifecycleGeneration: 1,
        retiredCustomAssetIds: [TEST_VECTOR.targetAssetId],
        completedAt: TEST_VECTOR.movedInAt,
      });
    });

    expect(
      await isPortfolioVaultLiveRetirementRequired(h.db, userId, TEST_VECTOR.targetAssetId),
    ).toBe(true);
    expect(
      await isPortfolioVaultLiveRetirementRequired(h.db, userId, TEST_VECTOR.siblingAssetId),
    ).toBe(false);

    await h.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      await createPortfolioVaultTransitionTransactionRepository(tx).completeMoveOut({
        userId,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        vaultId: TEST_VECTOR.vaultId,
        moveOutId: TEST_VECTOR.moveOutId,
        lifecycleGeneration: 1,
        documentDigest: 'TEST_VECTOR_restore_document_digest',
        documentSetHash: 'TEST_VECTOR_restore_document_set_hash',
        proofPublicKey: 'TEST VECTOR move-out proof public key',
        customAssetIds: [TEST_VECTOR.targetAssetId],
        completedAt: TEST_VECTOR.movedOutAt,
      });
    });

    // Membership is already plain, but the durable finalization plan keeps the
    // fence closed until all repeatable derived-state work converges.
    expect(
      await h.db
        .select({ vaultId: portfolios.vaultId })
        .from(portfolios)
        .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ vaultId: null }]);
    expect(
      await isPortfolioVaultLiveRetirementRequired(h.db, userId, TEST_VECTOR.targetAssetId),
    ).toBe(true);

    const pending = await readPendingPortfolioVaultMoveOutFinalization(
      h.db,
      userId,
      TEST_VECTOR.targetPortfolioId,
    );
    expect(pending).not.toBeNull();
    expect(await completePendingPortfolioVaultMoveOut(h.db, pending!)).toBe(true);
    expect(
      await isPortfolioVaultLiveRetirementRequired(h.db, userId, TEST_VECTOR.targetAssetId),
    ).toBe(false);
    expect(
      await isPortfolioVaultLiveRetirementRequired(h.db, userId, TEST_VECTOR.siblingAssetId),
    ).toBe(false);
  });
});
