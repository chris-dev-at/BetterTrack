import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMarketIntelRepository } from '../marketIntelRepository';
import { createPortfolioSnapshotRepository } from '../portfolioSnapshotRepository';
import { createStandingOrderRepository } from '../standingOrderRepository';
import * as schema from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

// Deterministic TEST VECTOR identifiers and timestamps. The locked portfolio
// deliberately retains impossible cleartext rows: E2 requires job policy to
// reject those rows independently of the move-in purge/probe invariant.
const TEST_VECTOR = {
  ownerId: '019c8500-0000-7000-8000-000000000001',
  controlOwnerId: '019c8500-0000-7000-8000-000000000002',
  legacyOwnerId: '019c8500-0000-7000-8000-000000000003',
  vaultId: '019c8500-0000-7000-8000-000000000004',
  headerDocId: '019c8500-0000-7000-8000-000000000005',
  commonDocId: '019c8500-0000-7000-8000-000000000006',
  vaultedPortfolioId: '019c8500-0000-7000-8000-000000000010',
  siblingPortfolioId: '019c8500-0000-7000-8000-000000000011',
  controlPortfolioId: '019c8500-0000-7000-8000-000000000012',
  vaultedAssetId: '019c8500-0000-7000-8000-000000000020',
  siblingAssetId: '019c8500-0000-7000-8000-000000000021',
  controlAssetId: '019c8500-0000-7000-8000-000000000022',
  vaultedTransactionId: '019c8500-0000-7000-8000-000000000030',
  siblingTransactionId: '019c8500-0000-7000-8000-000000000031',
  controlTransactionId: '019c8500-0000-7000-8000-000000000032',
  vaultedOrderId: '019c8500-0000-7000-8000-000000000040',
  siblingOrderId: '019c8500-0000-7000-8000-000000000041',
  controlOrderId: '019c8500-0000-7000-8000-000000000042',
  at: new Date('2026-08-21T07:00:00.000Z'),
} as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();

  await harness.db.insert(schema.users).values([
    {
      id: TEST_VECTOR.ownerId,
      email: 'e2-job-owner@bettertrack.test',
      username: 'e2_job_owner',
      passwordHash: 'TEST VECTOR password hash',
    },
    {
      id: TEST_VECTOR.controlOwnerId,
      email: 'e2-job-control@bettertrack.test',
      username: 'e2_job_control',
      passwordHash: 'TEST VECTOR password hash',
    },
    {
      id: TEST_VECTOR.legacyOwnerId,
      email: 'e2-job-legacy@bettertrack.test',
      username: 'e2_job_legacy',
      passwordHash: 'TEST VECTOR password hash',
      privacyMode: 'paranoid',
      paranoidMediaSet: ['server'],
    },
  ]);

  await harness.db.insert(schema.vaults).values({
    id: TEST_VECTOR.vaultId,
    userId: TEST_VECTOR.ownerId,
    name: 'TEST VECTOR vault',
    headerDocId: TEST_VECTOR.headerDocId,
    commonDocId: TEST_VECTOR.commonDocId,
    media: ['server'],
    retirementProofPublicKey: 'TEST VECTOR retirement verifier',
    keyFingerprint: 'TEST-VECTOR-JOBS',
  });

  await harness.db.insert(schema.portfolios).values([
    {
      id: TEST_VECTOR.vaultedPortfolioId,
      userId: TEST_VECTOR.ownerId,
      name: 'TEST VECTOR locked stub',
      vaultId: TEST_VECTOR.vaultId,
      vaultAlias: 'Locked TEST VECTOR',
    },
    {
      id: TEST_VECTOR.siblingPortfolioId,
      userId: TEST_VECTOR.ownerId,
      name: 'TEST VECTOR plain sibling',
    },
    {
      id: TEST_VECTOR.controlPortfolioId,
      userId: TEST_VECTOR.controlOwnerId,
      name: 'TEST VECTOR no-vault control',
    },
  ]);

  await harness.db.insert(schema.assets).values([
    {
      id: TEST_VECTOR.vaultedAssetId,
      providerId: 'yahoo',
      providerRef: 'E2-VAULTED',
      type: 'stock',
      symbol: 'VLT',
      name: 'TEST VECTOR vaulted holding',
      currency: 'EUR',
    },
    {
      id: TEST_VECTOR.siblingAssetId,
      providerId: 'yahoo',
      providerRef: 'E2-SIBLING',
      type: 'stock',
      symbol: 'SIB',
      name: 'TEST VECTOR sibling holding',
      currency: 'EUR',
    },
    {
      id: TEST_VECTOR.controlAssetId,
      providerId: 'yahoo',
      providerRef: 'E2-CONTROL',
      type: 'stock',
      symbol: 'CTL',
      name: 'TEST VECTOR control holding',
      currency: 'EUR',
    },
  ]);

  await harness.db.insert(schema.transactions).values([
    {
      id: TEST_VECTOR.vaultedTransactionId,
      portfolioId: TEST_VECTOR.vaultedPortfolioId,
      assetId: TEST_VECTOR.vaultedAssetId,
      side: 'buy',
      quantity: '1',
      price: '100',
      fee: '0',
      executedAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingTransactionId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      assetId: TEST_VECTOR.siblingAssetId,
      side: 'buy',
      quantity: '2',
      price: '100',
      fee: '0',
      executedAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.controlTransactionId,
      portfolioId: TEST_VECTOR.controlPortfolioId,
      assetId: TEST_VECTOR.controlAssetId,
      side: 'buy',
      quantity: '2',
      price: '100',
      fee: '0',
      executedAt: TEST_VECTOR.at,
    },
  ]);

  await harness.db.insert(schema.standingOrders).values([
    {
      id: TEST_VECTOR.vaultedOrderId,
      userId: TEST_VECTOR.ownerId,
      portfolioId: TEST_VECTOR.vaultedPortfolioId,
      kind: 'cash-add',
      amount: '10',
      currency: 'EUR',
      label: 'TEST VECTOR vaulted order',
      cadence: 'daily',
      startDate: '2026-08-21',
      createdAt: new Date('2026-08-21T07:00:00.000Z'),
    },
    {
      id: TEST_VECTOR.siblingOrderId,
      userId: TEST_VECTOR.ownerId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      kind: 'cash-add',
      amount: '20',
      currency: 'EUR',
      label: 'TEST VECTOR sibling order',
      cadence: 'daily',
      startDate: '2026-08-21',
      createdAt: new Date('2026-08-21T07:00:01.000Z'),
    },
    {
      id: TEST_VECTOR.controlOrderId,
      userId: TEST_VECTOR.controlOwnerId,
      portfolioId: TEST_VECTOR.controlPortfolioId,
      kind: 'cash-add',
      amount: '20',
      currency: 'EUR',
      label: 'TEST VECTOR control order',
      cadence: 'daily',
      startDate: '2026-08-21',
      createdAt: new Date('2026-08-21T07:00:02.000Z'),
    },
  ]);
});

afterEach(async () => {
  await harness.ctx.events.close();
});

describe('E2 vaulted-portfolio background scan policy', () => {
  it('excludes the locked stub from snapshot target and asset-invalidation scans', async () => {
    const repo = createPortfolioSnapshotRepository(harness.db);

    expect((await repo.listSnapshotTargets()).map((row) => row.portfolioId)).toEqual([
      TEST_VECTOR.siblingPortfolioId,
      TEST_VECTOR.controlPortfolioId,
    ]);
    expect(await repo.portfoliosReferencingAsset(TEST_VECTOR.vaultedAssetId)).toEqual([]);
    expect(await repo.portfoliosReferencingAsset(TEST_VECTOR.siblingAssetId)).toEqual([
      { portfolioId: TEST_VECTOR.siblingPortfolioId, firstTxnDay: '2026-08-21' },
    ]);
  });

  it('excludes vaulted holdings from earnings/dividend scans but keeps the plain sibling', async () => {
    const repo = createMarketIntelRepository(harness.db);

    expect(
      (await repo.listUserWatchAndHoldAssets(TEST_VECTOR.ownerId)).map((row) => row.assetId),
    ).toEqual([TEST_VECTOR.siblingAssetId]);
    expect(
      (await repo.listHeldPositionsForUser(TEST_VECTOR.ownerId)).map((row) => row.assetId),
    ).toEqual([TEST_VECTOR.siblingAssetId]);
    expect(
      (await repo.listHeldAssetHoldersForUser(TEST_VECTOR.ownerId)).map((row) => row.assetId),
    ).toEqual([TEST_VECTOR.siblingAssetId]);
    expect((await repo.listHeldAssetHoldersAllUsers()).map((row) => row.assetId).sort()).toEqual(
      [TEST_VECTOR.siblingAssetId, TEST_VECTOR.controlAssetId].sort(),
    );

    // The pre-E9 account rail remains independently active for legacy users.
    expect((await repo.listNormalUserIds()).sort()).toEqual(
      [TEST_VECTOR.ownerId, TEST_VECTOR.controlOwnerId].sort(),
    );
  });

  it('excludes vaulted standing orders at discovery and the final mutation lock', async () => {
    const repo = createStandingOrderRepository(harness.db);

    expect((await repo.listActive()).map((row) => row.id)).toEqual([
      TEST_VECTOR.siblingOrderId,
      TEST_VECTOR.controlOrderId,
    ]);

    let mutated = false;
    const outcome = await repo.withActivePortfolioLock(
      TEST_VECTOR.vaultedPortfolioId,
      TEST_VECTOR.vaultedOrderId,
      '2026-08-21',
      async () => {
        mutated = true;
        return 'booked';
      },
    );
    expect(outcome).toBeNull();
    expect(mutated).toBe(false);
  });
});
