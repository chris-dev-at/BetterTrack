import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';

import type { VaultStrictEntity } from '@bettertrack/contracts';

import {
  assetIdentities,
  assets,
  portfolioVaultTransitionStates,
  portfolios,
  priceHistory,
  transactions,
  vaults,
} from '../../schema';
import { createCurrencyService } from '../../../services/currency/currencyService';
import { createMarketDataFxSource } from '../../../services/currency/marketDataFxSource';
import { createPortfolioSnapshotService } from '../../../services/portfolio/portfolioSnapshots';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { createCashMovementRepository } from '../cashMovementRepository';
import { createPortfolioRepository } from '../portfolioRepository';
import { createPortfolioSnapshotRepository } from '../portfolioSnapshotRepository';
import { restorePortfolioVaultGraph } from '../portfolioVaultRestoreRepository';
import { vaultedPortfolioStubName } from '../vaultedPortfolioProbe';
import { createTransactionRepository } from '../transactionRepository';

// Deterministic TEST VECTOR values; no fixture is a credential.
const id = (value: number) => `019c8300-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;
const TEST_VECTOR = {
  vaultId: id(1),
  headerDocId: id(2),
  commonDocId: id(3),
  portfolioId: id(4),
  otherPortfolioId: id(5),
  manualAssetId: id(6),
  catalogAssetId: id(7),
  transactionId: id(8),
  assetValueEntityId: id(9),
  orderId: id(10),
  deviceId: id(11),
  siblingTransactionId: id(12),
  at: '2026-08-21T10:00:00.000Z',
} as const;

type EntityOf<K extends VaultStrictEntity['kind']> = Extract<VaultStrictEntity, { kind: K }>;

const meta = (entityId: string) => ({
  id: entityId,
  rev: 1,
  editedAt: TEST_VECTOR.at,
  editedBy: TEST_VECTOR.deviceId,
  deletedAt: null,
});

function portfolioEntity(
  portfolioId = TEST_VECTOR.portfolioId,
  ownerId?: string,
): EntityOf<'portfolio'> {
  if (!ownerId) throw new Error('TEST VECTOR owner is required');
  return {
    ...meta(portfolioId),
    kind: 'portfolio',
    data: {
      userId: ownerId,
      name: 'TEST VECTOR restored portfolio',
      visibility: 'private',
      sortOrder: 3,
      defaultPayFromCash: true,
      archivedAt: null,
      kind: 'business',
      vaultId: null,
      alias: null,
      vaultAlias: null,
    },
  };
}

function transactionEntity(assetId: string): EntityOf<'transaction'> {
  return {
    ...meta(TEST_VECTOR.transactionId),
    kind: 'transaction',
    data: {
      portfolioId: TEST_VECTOR.portfolioId,
      assetId,
      side: 'buy',
      quantity: '1',
      price: '10',
      fee: '0',
      executedAt: TEST_VECTOR.at,
      note: null,
      taxMode: null,
      taxCountry: null,
      taxAmountEur: null,
      taxParams: null,
      allowUncovered: false,
      uncoveredEntryPrice: null,
      source: 'manual',
    },
  };
}

function manualAssetEntity(ownerId: string, metaValue: unknown): EntityOf<'customAsset'> {
  return {
    ...meta(TEST_VECTOR.manualAssetId),
    kind: 'customAsset',
    data: {
      ownerId,
      providerId: 'manual',
      providerRef: TEST_VECTOR.manualAssetId,
      type: 'custom',
      symbol: 'MANUAL',
      name: 'TEST VECTOR manual asset',
      exchange: null,
      currency: 'EUR',
      meta: metaValue as EntityOf<'customAsset'>['data']['meta'],
      searchText: null,
    },
  };
}

function standingOrderEntity(input: {
  kind: 'buy-asset' | 'cash-add';
  assetId: string | null;
  currency: string;
}): EntityOf<'standingOrder'> {
  return {
    ...meta(TEST_VECTOR.orderId),
    kind: 'standingOrder',
    data: {
      userId: '', // overwritten by the test with the seeded owner
      portfolioId: TEST_VECTOR.portfolioId,
      kind: input.kind,
      assetId: input.assetId,
      amount: '10',
      currency: input.currency,
      label: null,
      cadence: 'daily',
      anchorDay: null,
      startDate: '2026-08-21',
      endDate: null,
      status: 'active',
      lastRunAt: null,
      lastPeriodKey: null,
      createdAt: TEST_VECTOR.at,
      updatedAt: TEST_VECTOR.at,
    },
  };
}

let h: TestHarness;
let userId: string;

beforeEach(async () => {
  h = await createTestApp();
  const user = await h.seedUser({
    email: 'portfolio-restore-repository@bettertrack.test',
    username: 'portfolio_restore_repository',
  });
  userId = user.id;
  await h.db.insert(vaults).values({
    id: TEST_VECTOR.vaultId,
    userId,
    name: 'TEST VECTOR restore vault',
    headerDocId: TEST_VECTOR.headerDocId,
    commonDocId: TEST_VECTOR.commonDocId,
    media: ['server'],
    retirementProofPublicKey: 'TEST VECTOR retirement public key',
    keyFingerprint: 'TEST-VECTOR-RESTORE',
  });
  await h.db.insert(portfolios).values({
    id: TEST_VECTOR.portfolioId,
    userId,
    name: vaultedPortfolioStubName(TEST_VECTOR.portfolioId),
    vaultId: TEST_VECTOR.vaultId,
    vaultAlias: 'TEST VECTOR locked alias',
  });
  await h.db.insert(portfolioVaultTransitionStates).values({
    portfolioId: TEST_VECTOR.portfolioId,
    userId,
    lifecycleGeneration: 1,
    moveInVaultId: TEST_VECTOR.vaultId,
    moveInDocVersion: 1,
    moveInCompletedAt: new Date(TEST_VECTOR.at),
  });
});

// NOTE: no redis.quit() here — the redis handle is the shared module-level
// singleton; quitting it in real-Redis (integration) mode kills every later
// suite in the singleFork process (the #1456 landmine class).

async function restore(entities: readonly VaultStrictEntity[]): Promise<void> {
  await restorePortfolioVaultGraph({
    tx: h.db,
    userId,
    portfolioId: TEST_VECTOR.portfolioId,
    vaultId: TEST_VECTOR.vaultId,
    entities,
    afterCashMovements: async () => undefined,
  });
}

async function restoreWithResult(entities: readonly VaultStrictEntity[]) {
  return restorePortfolioVaultGraph({
    tx: h.db,
    userId,
    portfolioId: TEST_VECTOR.portfolioId,
    vaultId: TEST_VECTOR.vaultId,
    entities,
    afterCashMovements: async () => undefined,
  });
}

function createFinalizationSnapshotService() {
  const marketData = createStubMarketData();
  return createPortfolioSnapshotService({
    snapshotRepo: createPortfolioSnapshotRepository(h.db),
    portfolioRepo: createPortfolioRepository(h.db),
    transactionRepo: createTransactionRepository(h.db),
    cashMovementRepo: createCashMovementRepository(h.db),
    marketData,
    currencyService: createCurrencyService({ source: createMarketDataFxSource(marketData) }),
    now: () => Date.parse(TEST_VECTOR.at),
  });
}

describe('portfolio vault restore repository', () => {
  it('returns an existing sibling-shared manual asset in the recompute plan when adding a price point', async () => {
    await h.db.insert(portfolios).values({
      id: TEST_VECTOR.otherPortfolioId,
      userId,
      name: 'TEST VECTOR sibling portfolio',
    });
    await h.db.insert(assets).values({
      id: TEST_VECTOR.manualAssetId,
      ownerId: userId,
      providerId: 'manual',
      providerRef: TEST_VECTOR.manualAssetId,
      type: 'custom',
      symbol: 'MANUAL',
      name: 'TEST VECTOR manual asset',
      exchange: null,
      currency: 'EUR',
      meta: { shared: true },
    });
    await h.db.insert(priceHistory).values({
      assetId: TEST_VECTOR.manualAssetId,
      date: '2026-08-19',
      close: '1.000000',
    });
    await h.db.insert(transactions).values({
      id: TEST_VECTOR.siblingTransactionId,
      portfolioId: TEST_VECTOR.otherPortfolioId,
      assetId: TEST_VECTOR.manualAssetId,
      side: 'buy',
      quantity: '2',
      price: '1',
      fee: '0',
      executedAt: new Date('2026-08-19T10:00:00.000Z'),
      source: 'manual',
    });
    const snapshots = createFinalizationSnapshotService();
    const snapshotRepo = createPortfolioSnapshotRepository(h.db);
    await snapshots.recompute(TEST_VECTOR.otherPortfolioId);
    expect(
      (await snapshotRepo.listForPortfolio(TEST_VECTOR.otherPortfolioId)).find(
        (row) => row.date === '2026-08-20',
      )?.valueEur,
    ).toBe(2);
    const restoredValue: EntityOf<'customAssetValue'> = {
      ...meta(TEST_VECTOR.assetValueEntityId),
      kind: 'customAssetValue',
      data: {
        assetId: TEST_VECTOR.manualAssetId,
        date: '2026-08-20',
        close: '2',
      },
    };

    const result = await restoreWithResult([
      portfolioEntity(TEST_VECTOR.portfolioId, userId),
      manualAssetEntity(userId, { shared: true }),
      restoredValue,
      transactionEntity(TEST_VECTOR.manualAssetId),
    ]);

    // The asset row was not inserted by this restore, but the missing price
    // fact changes both portfolios' value series. Keeping its id in the durable
    // finalization plan is what lets API and worker recovery invalidate every
    // current transaction reference before recomputing target + sibling.
    expect(result.restoredCustomAssetIds).toEqual([TEST_VECTOR.manualAssetId]);

    // This is the transition-only finalization sequence used by both the API
    // and recovery worker. It must discover the sibling reference before
    // invalidation, then recompute every affected portfolio even though the
    // restore target remains vaulted until the later membership commit.
    const affectedPortfolios = new Set([TEST_VECTOR.portfolioId]);
    for (const assetId of result.restoredCustomAssetIds) {
      const references = await snapshots.resolveAssetReferences(assetId);
      await snapshots.invalidateForAsset(assetId);
      for (const reference of references) affectedPortfolios.add(reference.portfolioId);
    }
    expect(affectedPortfolios).toEqual(
      new Set([TEST_VECTOR.portfolioId, TEST_VECTOR.otherPortfolioId]),
    );
    for (const affectedPortfolioId of [...affectedPortfolios].sort()) {
      await snapshots.recompute(affectedPortfolioId);
    }
    expect(
      (await snapshotRepo.listForPortfolio(TEST_VECTOR.otherPortfolioId)).find(
        (row) => row.date === '2026-08-20',
      )?.valueEur,
    ).toBe(4);

    expect(
      await h.db
        .select({ date: priceHistory.date, close: priceHistory.close })
        .from(priceHistory)
        .where(eq(priceHistory.assetId, TEST_VECTOR.manualAssetId))
        .orderBy(asc(priceHistory.date)),
    ).toEqual([
      { date: '2026-08-19', close: '1.000000' },
      { date: '2026-08-20', close: '2' },
    ]);
    expect(
      await h.db
        .select({ id: transactions.id, portfolioId: transactions.portfolioId })
        .from(transactions)
        .where(eq(transactions.assetId, TEST_VECTOR.manualAssetId)),
    ).toEqual(
      expect.arrayContaining([
        { id: TEST_VECTOR.transactionId, portfolioId: TEST_VECTOR.portfolioId },
        { id: TEST_VECTOR.siblingTransactionId, portfolioId: TEST_VECTOR.otherPortfolioId },
      ]),
    );
  });

  it('uses structural JSON equality and exact decimal equality for an existing manual asset', async () => {
    await h.db.insert(assets).values({
      id: TEST_VECTOR.manualAssetId,
      ownerId: userId,
      providerId: 'manual',
      providerRef: TEST_VECTOR.manualAssetId,
      type: 'custom',
      symbol: 'MANUAL',
      name: 'TEST VECTOR manual asset',
      exchange: null,
      currency: 'EUR',
      meta: { alpha: 1, nested: { first: true, second: false } },
    });
    await h.db.insert(priceHistory).values({
      assetId: TEST_VECTOR.manualAssetId,
      date: '2026-08-20',
      close: '1.000000',
    });
    const customAsset = manualAssetEntity(userId, {
      nested: { second: false, first: true },
      alpha: 1,
    });
    const customValue: EntityOf<'customAssetValue'> = {
      ...meta(TEST_VECTOR.assetValueEntityId),
      kind: 'customAssetValue',
      data: { assetId: TEST_VECTOR.manualAssetId, date: '2026-08-20', close: '1' },
    };

    await expect(
      restore([
        portfolioEntity(TEST_VECTOR.portfolioId, userId),
        customAsset,
        customValue,
        transactionEntity(TEST_VECTOR.manualAssetId),
      ]),
    ).resolves.toBeUndefined();

    expect(
      await h.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.id, TEST_VECTOR.transactionId)),
    ).toEqual([{ id: TEST_VECTOR.transactionId }]);
  });

  it('does not collapse distinct high-precision decimal facts through binary floats', async () => {
    await h.db.insert(assets).values({
      id: TEST_VECTOR.manualAssetId,
      ownerId: userId,
      providerId: 'manual',
      providerRef: TEST_VECTOR.manualAssetId,
      type: 'custom',
      symbol: 'MANUAL',
      name: 'TEST VECTOR manual asset',
      exchange: null,
      currency: 'EUR',
      meta: null,
    });
    await h.db.insert(priceHistory).values({
      assetId: TEST_VECTOR.manualAssetId,
      date: '2026-08-20',
      close: '99999999999999.000001',
    });
    const customValue: EntityOf<'customAssetValue'> = {
      ...meta(TEST_VECTOR.assetValueEntityId),
      kind: 'customAssetValue',
      data: {
        assetId: TEST_VECTOR.manualAssetId,
        date: '2026-08-20',
        close: '99999999999999.000002',
      },
    };

    await expect(
      restore([
        portfolioEntity(TEST_VECTOR.portfolioId, userId),
        manualAssetEntity(userId, null),
        customValue,
        transactionEntity(TEST_VECTOR.manualAssetId),
      ]),
    ).rejects.toMatchObject({ code: 'COMMON_FACT_CONFLICT' });
    expect(
      await h.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.id, TEST_VECTOR.transactionId)),
    ).toEqual([]);
  });

  it('rehydrates an owner-manual asset under its retained same-UUID claim', async () => {
    await h.db.insert(assetIdentities).values({
      id: TEST_VECTOR.manualAssetId,
      ownerId: userId,
    });

    await expect(
      restore([
        portfolioEntity(TEST_VECTOR.portfolioId, userId),
        manualAssetEntity(userId, { retained: true }),
        transactionEntity(TEST_VECTOR.manualAssetId),
      ]),
    ).resolves.toBeUndefined();
    expect(
      await h.db
        .select({ id: assets.id, ownerId: assets.ownerId })
        .from(assets)
        .where(eq(assets.id, TEST_VECTOR.manualAssetId)),
    ).toEqual([{ id: TEST_VECTOR.manualAssetId, ownerId: userId }]);
    expect(
      await h.db
        .select({ id: assetIdentities.id, ownerId: assetIdentities.ownerId })
        .from(assetIdentities)
        .where(eq(assetIdentities.id, TEST_VECTOR.manualAssetId)),
    ).toEqual([{ id: TEST_VECTOR.manualAssetId, ownerId: userId }]);
  });

  it('accepts a re-resolved global catalog asset but refuses an omitted own-manual restatement', async () => {
    await h.db.insert(assets).values({
      id: TEST_VECTOR.catalogAssetId,
      providerId: 'test-vector-provider',
      providerRef: 'catalog',
      type: 'stock',
      symbol: 'CAT',
      name: 'TEST VECTOR catalog asset',
      currency: 'USD',
    });
    await expect(
      restore([
        portfolioEntity(TEST_VECTOR.portfolioId, userId),
        transactionEntity(TEST_VECTOR.catalogAssetId),
      ]),
    ).resolves.toBeUndefined();

    await h.db.delete(transactions).where(eq(transactions.id, TEST_VECTOR.transactionId));
    await h.db
      .update(portfolios)
      .set({
        name: vaultedPortfolioStubName(TEST_VECTOR.portfolioId),
        vaultId: TEST_VECTOR.vaultId,
        vaultAlias: 'TEST VECTOR locked alias',
      })
      .where(eq(portfolios.id, TEST_VECTOR.portfolioId));
    await h.db.insert(assets).values({
      id: TEST_VECTOR.manualAssetId,
      ownerId: userId,
      providerId: 'manual',
      providerRef: TEST_VECTOR.manualAssetId,
      type: 'custom',
      symbol: 'MANUAL',
      name: 'TEST VECTOR manual asset',
      currency: 'EUR',
    });

    await expect(
      restore([
        portfolioEntity(TEST_VECTOR.portfolioId, userId),
        transactionEntity(TEST_VECTOR.manualAssetId),
      ]),
    ).rejects.toMatchObject({
      code: 'COMMON_FACT_CONFLICT',
    });
    expect(
      await h.db
        .select({ name: portfolios.name })
        .from(portfolios)
        .where(eq(portfolios.id, TEST_VECTOR.portfolioId)),
    ).toEqual([{ name: vaultedPortfolioStubName(TEST_VECTOR.portfolioId) }]);
  });

  it('refuses a foreign/manual restatement and a mismatched portfolio UUID before writes', async () => {
    const foreign = await h.seedUser({
      email: 'portfolio-restore-foreign@bettertrack.test',
      username: 'portfolio_restore_foreign',
    });
    await expect(
      restore([
        portfolioEntity(TEST_VECTOR.portfolioId, userId),
        manualAssetEntity(foreign.id, { test: true }),
        transactionEntity(TEST_VECTOR.manualAssetId),
      ]),
    ).rejects.toMatchObject({
      code: 'COMMON_FACT_CONFLICT',
    });
    await h.db.insert(assetIdentities).values({
      id: TEST_VECTOR.manualAssetId,
      ownerId: foreign.id,
    });
    await expect(
      restore([
        portfolioEntity(TEST_VECTOR.portfolioId, userId),
        manualAssetEntity(userId, { test: true }),
        transactionEntity(TEST_VECTOR.manualAssetId),
      ]),
    ).rejects.toMatchObject({ code: 'COMMON_FACT_CONFLICT' });
    await expect(
      restore([portfolioEntity(TEST_VECTOR.otherPortfolioId, userId)]),
    ).rejects.toMatchObject({ code: 'STUB_LOST' });
    expect(
      await h.db
        .select({ name: portfolios.name })
        .from(portfolios)
        .where(eq(portfolios.id, TEST_VECTOR.portfolioId)),
    ).toEqual([{ name: vaultedPortfolioStubName(TEST_VECTOR.portfolioId) }]);
  });

  it.each([
    {
      label: 'cash order using a non-EUR currency',
      order: { kind: 'cash-add' as const, assetId: null, currency: 'USD' },
    },
    {
      label: 'buy order disagreeing with its catalog asset currency',
      order: {
        kind: 'buy-asset' as const,
        assetId: TEST_VECTOR.catalogAssetId,
        currency: 'EUR',
      },
    },
  ])('rejects $label before mutating the stub', async ({ order }) => {
    await h.db.insert(assets).values({
      id: TEST_VECTOR.catalogAssetId,
      providerId: 'test-vector-provider',
      providerRef: 'catalog',
      type: 'stock',
      symbol: 'CAT',
      name: 'TEST VECTOR catalog asset',
      currency: 'USD',
    });
    const entity = standingOrderEntity(order);
    entity.data.userId = userId;

    await expect(
      restore([portfolioEntity(TEST_VECTOR.portfolioId, userId), entity]),
    ).rejects.toMatchObject({
      code: 'COMMON_FACT_CONFLICT',
    });
    expect(
      await h.db
        .select({ name: portfolios.name })
        .from(portfolios)
        .where(eq(portfolios.id, TEST_VECTOR.portfolioId)),
    ).toEqual([{ name: vaultedPortfolioStubName(TEST_VECTOR.portfolioId) }]);
  });
});
