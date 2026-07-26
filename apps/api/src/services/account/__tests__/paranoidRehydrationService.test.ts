import type { ParanoidDisableRehydrationRequest } from '@bettertrack/contracts';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createAssetRepository } from '../../../data/repositories/assetRepository';
import { createCashMovementRepository } from '../../../data/repositories/cashMovementRepository';
import { createCashSourceRepository } from '../../../data/repositories/cashSourceRepository';
import { createPortfolioRepository } from '../../../data/repositories/portfolioRepository';
import { createStandingOrderRepository } from '../../../data/repositories/standingOrderRepository';
import { createTransactionRepository } from '../../../data/repositories/transactionRepository';
import {
  assets,
  dividends,
  expenseBudgetFires,
  expenseBudgets,
  expenseCategories,
  expenseRules,
  expenseTransactions,
  importBatches,
  importRows,
  priceHistory,
  paranoidRehydrationReceipts,
  paranoidVaultHistory,
  paranoidVaults,
  portfolioCashMovements,
  portfolioCashSources,
  portfolioDailySnapshots,
  portfolioSettings,
  portfolioSnapshotState,
  portfolios,
  standingOrderRuns,
  standingOrders,
  transactions,
  userTaxSettings,
  users,
} from '../../../data/schema';
import { createTestApp } from '../../../testing/createTestApp';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { expenseDedupHash } from '../../expenses/expenseImportService';
import { createStandingOrderService } from '../../standingOrders/standingOrderService';
import {
  createParanoidRehydrationService,
  ParanoidRehydrationError,
} from '../paranoidRehydrationService';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000001';
const REHYDRATION_ID = '018f0000-0000-7000-8000-000000000002';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000003';
const CASH_SOURCE_ID = '018f0000-0000-7000-8000-000000000004';
const ASSET_ID = '018f0000-0000-7000-8000-000000000005';
const TRANSACTION_ID = '018f0000-0000-7000-8000-000000000006';
const MOVEMENT_ID = '018f0000-0000-7000-8000-000000000007';
const SECOND_PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000008';
const SECOND_CASH_SOURCE_ID = '018f0000-0000-7000-8000-000000000009';
const SECOND_TRANSACTION_ID = '018f0000-0000-7000-8000-00000000000a';
const TRANSFER_ID = '018f0000-0000-7000-8000-00000000000b';
const TRANSFER_OUT_ID = '018f0000-0000-7000-8000-00000000000c';
const STANDING_ORDER_ID = '018f0000-0000-7000-8000-000000000020';
const editedAt = '2026-07-24T10:00:00.000Z';
let restoreUserId = DEVICE_ID;

function entity<
  K extends ParanoidDisableRehydrationRequest['document']['entities'][number]['kind'],
>(
  id: string,
  kind: K,
  data: Extract<
    ParanoidDisableRehydrationRequest['document']['entities'][number],
    { kind: K }
  >['data'],
): Extract<ParanoidDisableRehydrationRequest['document']['entities'][number], { kind: K }> {
  return { id, kind, rev: 0, editedAt, editedBy: DEVICE_ID, deletedAt: null, data } as Extract<
    ParanoidDisableRehydrationRequest['document']['entities'][number],
    { kind: K }
  >;
}

function request(rehydrationId = REHYDRATION_ID): ParanoidDisableRehydrationRequest {
  return {
    rehydrationId,
    document: {
      schemaVersion: 1,
      entities: [
        entity(PORTFOLIO_ID, 'portfolio', {
          userId: restoreUserId,
          name: 'Main',
          visibility: 'private',
          sortOrder: 0,
          defaultPayFromCash: false,
          archivedAt: null,
        }),
        entity(ASSET_ID, 'customAsset', {
          providerId: 'manual',
          providerRef: ASSET_ID,
          ownerId: restoreUserId,
          type: 'custom',
          symbol: 'HOME',
          name: 'House',
          exchange: null,
          currency: 'EUR',
          meta: { category: 'other', smoothing: false, recategorize: false },
          searchText: "'home':1 'house':2",
        }),
        entity(CASH_SOURCE_ID, 'cashSource', {
          portfolioId: PORTFOLIO_ID,
          name: 'Main',
          type: 'cash',
          isMain: true,
          archivedAt: null,
          createdAt: editedAt,
        }),
        entity(TRANSACTION_ID, 'transaction', {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'buy',
          quantity: '1.00000000',
          price: '100.000000',
          fee: '0.000000',
          executedAt: editedAt,
          note: null,
          taxMode: null,
          taxCountry: null,
          taxAmountEur: null,
          taxParams: null,
          allowUncovered: false,
          uncoveredEntryPrice: null,
          source: 'manual',
        }),
        entity(MOVEMENT_ID, 'cashMovement', {
          portfolioId: PORTFOLIO_ID,
          sourceId: CASH_SOURCE_ID,
          kind: 'deposit',
          amountEur: '100.000000',
          transactionId: null,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: editedAt,
          createdAt: editedAt,
          note: null,
          source: 'manual',
        }),
      ],
      mergeLog: [],
    },
  };
}

function exhaustiveRequest(): ParanoidDisableRehydrationRequest {
  const input = request();
  const dividendId = '018f0000-0000-7000-8000-000000000010';
  const categoryId = '018f0000-0000-7000-8000-000000000013';
  input.document.entities.push(
    entity('018f0000-0000-7000-8000-00000000000d', 'customAssetValue', {
      assetId: ASSET_ID,
      date: '2026-07-24',
      close: '125.1234567',
    }),
    entity('018f0000-0000-7000-8000-00000000000e', 'portfolioSetting', {
      portfolioId: PORTFOLIO_ID,
      key: 'atomic-restore-test',
      value: { enabled: true },
      updatedAt: editedAt,
    }),
    entity('018f0000-0000-7000-8000-00000000000f', 'taxSetting', {
      userId: restoreUserId,
      mode: 'country_specific',
      country: 'AT',
      manualDefaultAmountEur: null,
      manualDefaultRatePct: null,
      customParams: null,
      updatedAt: editedAt,
    }),
    entity(dividendId, 'dividend', {
      portfolioId: PORTFOLIO_ID,
      assetId: ASSET_ID,
      cashSourceId: CASH_SOURCE_ID,
      grossAmountEur: '10.000000',
      executedAt: editedAt,
      createdAt: editedAt,
      note: null,
      taxMode: 'country_specific',
      taxCountry: 'AT',
      taxAmountEur: '0.000000',
      taxParams: null,
      source: 'manual',
    }),
    entity('018f0000-0000-7000-8000-000000000011', 'cashMovement', {
      portfolioId: PORTFOLIO_ID,
      sourceId: CASH_SOURCE_ID,
      kind: 'dividend',
      amountEur: '10.000000',
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId,
      taxYear: null,
      executedAt: editedAt,
      createdAt: editedAt,
      note: null,
      source: 'manual',
    }),
    entity('018f0000-0000-7000-8000-000000000012', 'standingOrder', {
      userId: restoreUserId,
      portfolioId: PORTFOLIO_ID,
      kind: 'cash-add',
      assetId: null,
      amount: '100.00000000',
      currency: 'EUR',
      label: 'Salary',
      cadence: 'daily',
      anchorDay: null,
      startDate: '2026-07-01',
      endDate: null,
      status: 'active',
      lastRunAt: editedAt,
      lastPeriodKey: '2026-07-24',
      createdAt: editedAt,
      updatedAt: editedAt,
    }),
    entity('018f0000-0000-7000-8000-000000000017', 'standingOrderRun', {
      standingOrderId: '018f0000-0000-7000-8000-000000000012',
      periodKey: '2026-07-24',
      bookedAt: '2026-07-24T09:59:59.000Z',
    }),
    entity(categoryId, 'expenseCategory', {
      userId: restoreUserId,
      name: 'Groceries',
      direction: 'expense',
      color: '#22c55e',
      createdAt: editedAt,
      updatedAt: editedAt,
    }),
    entity('018f0000-0000-7000-8000-000000000014', 'expenseTransaction', {
      userId: restoreUserId,
      categoryId,
      direction: 'expense',
      amount: '60.00',
      currency: 'EUR',
      bookedOn: '2026-06-15',
      description: 'Restored groceries',
      source: 'manual',
      dedupHash: null,
      createdAt: editedAt,
      updatedAt: editedAt,
    }),
    entity('018f0000-0000-7000-8000-000000000015', 'expenseRule', {
      userId: restoreUserId,
      categoryId,
      matchType: 'contains',
      pattern: 'grocery',
      priority: 1,
      enabled: true,
      createdAt: editedAt,
      updatedAt: editedAt,
    }),
    entity('018f0000-0000-7000-8000-000000000016', 'expenseBudget', {
      userId: restoreUserId,
      categoryId,
      amount: '50.00',
      currency: 'EUR',
      createdAt: editedAt,
      updatedAt: editedAt,
    }),
  );
  return input;
}

async function makeParanoid() {
  const harness = await createTestApp();
  const user = await harness.seedUser();
  restoreUserId = user.id;
  await harness.db
    .update(users)
    .set({
      privacyMode: 'paranoid',
      paranoidMediaSet: ['server', 'drive'],
      paranoidDriveAttestedVersion: 4,
    })
    .where(eq(users.id, user.id));
  await harness.db.insert(paranoidVaults).values({
    userId: user.id,
    version: 4,
    formatVersion: 1,
    sizeBytes: 10,
    blob: Buffer.from('ciphertext'),
  });
  await harness.db.insert(paranoidVaultHistory).values({
    userId: user.id,
    version: 3,
    formatVersion: 1,
    sizeBytes: 10,
    blob: Buffer.from('old-ciphertext'),
  });
  return { ...harness, user };
}

type AmbiguousStandingOrderWindow = 'booking-failed' | 'mark-booked-failed';

async function captureAmbiguousStandingOrderWindow(window: AmbiguousStandingOrderWindow) {
  const harness = await createTestApp();
  const user = await harness.seedUser();
  await harness.db.insert(portfolios).values({
    id: PORTFOLIO_ID,
    userId: user.id,
    name: 'Main',
  });
  await harness.db.insert(portfolioCashSources).values({
    id: CASH_SOURCE_ID,
    portfolioId: PORTFOLIO_ID,
    name: 'Main',
    type: 'cash',
    isMain: true,
  });
  await harness.db.insert(standingOrders).values({
    id: STANDING_ORDER_ID,
    userId: user.id,
    portfolioId: PORTFOLIO_ID,
    kind: 'cash-add',
    assetId: null,
    amount: '100',
    currency: 'EUR',
    label: 'Salary',
    cadence: 'daily',
    anchorDay: null,
    startDate: '2026-07-01',
    endDate: null,
    status: 'active',
    lastRunAt: null,
    lastPeriodKey: null,
  });

  const realStandingOrderRepo = createStandingOrderRepository(harness.db);
  const realCashMovementRepo = createCashMovementRepository(harness.db);
  const service = createStandingOrderService({
    repo:
      window === 'mark-booked-failed'
        ? {
            ...realStandingOrderRepo,
            async markBooked() {
              throw new Error('injected markBooked failure');
            },
          }
        : realStandingOrderRepo,
    portfolioRepo: createPortfolioRepository(harness.db),
    assetRepo: createAssetRepository(harness.db),
    transactionRepo: createTransactionRepository(harness.db),
    cashMovementRepo:
      window === 'booking-failed'
        ? {
            ...realCashMovementRepo,
            async insert() {
              throw new Error('injected booking failure');
            },
          }
        : realCashMovementRepo,
    cashSourceRepo: createCashSourceRepository(harness.db),
    marketData: createStubMarketData(),
    snapshots: { async invalidate() {} },
  });

  const result = await service.processDueOrders({ now: Date.parse(editedAt) });
  const [order] = await harness.db
    .select()
    .from(standingOrders)
    .where(eq(standingOrders.id, STANDING_ORDER_ID));
  const [run] = await harness.db
    .select()
    .from(standingOrderRuns)
    .where(eq(standingOrderRuns.standingOrderId, STANDING_ORDER_ID));
  const bookedRows = await harness.db
    .select()
    .from(portfolioCashMovements)
    .where(
      and(
        eq(portfolioCashMovements.portfolioId, PORTFOLIO_ID),
        eq(portfolioCashMovements.source, 'standing-order'),
      ),
    );

  expect(order).toBeDefined();
  expect(run).toBeDefined();
  expect(order?.lastPeriodKey).toBeNull();
  expect(order?.lastRunAt).toBeNull();
  expect(bookedRows).toHaveLength(window === 'mark-booked-failed' ? 1 : 0);
  expect(result.booked).toBe(window === 'mark-booked-failed' ? 1 : 0);
  return { order: order!, run: run!, bookedRows };
}

describe('paranoid rehydration service', () => {
  it('restores stable UUIDs and completes the transition atomically', async () => {
    const { db, user } = await makeParanoid();
    const service = createParanoidRehydrationService({
      db,
      now: () => new Date('2026-07-24T11:00:00.000Z'),
    });

    await expect(service.rehydrate(user.id, request())).resolves.toEqual({
      rehydrationId: REHYDRATION_ID,
      completedAt: '2026-07-24T11:00:00.000Z',
      idempotent: false,
      postCommit: { invalidate: ['account', 'portfolio', 'expenses', 'standingOrders', 'tax'] },
    });

    const [account] = await db
      .select({
        mode: users.privacyMode,
        media: users.paranoidMediaSet,
        drive: users.paranoidDriveAttestedVersion,
      })
      .from(users)
      .where(eq(users.id, user.id));
    expect(account).toEqual({ mode: 'normal', media: null, drive: null });
    expect(await db.select().from(portfolios).where(eq(portfolios.id, PORTFOLIO_ID))).toHaveLength(
      1,
    );
    expect(await db.select().from(assets).where(eq(assets.id, ASSET_ID))).toHaveLength(1);
    expect(
      await db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toEqual([]);
    expect(
      await db.select().from(paranoidVaultHistory).where(eq(paranoidVaultHistory.userId, user.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(paranoidRehydrationReceipts)
        .where(
          and(
            eq(paranoidRehydrationReceipts.userId, user.id),
            eq(paranoidRehydrationReceipts.rehydrationId, REHYDRATION_ID),
          ),
        ),
    ).toHaveLength(1);
  });

  it('preserves custom-asset metadata and its generated search text', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const asset = input.document.entities.find((entry) => entry.kind === 'customAsset');
    if (!asset || asset.kind !== 'customAsset') throw new Error('expected custom asset');
    asset.data.meta = {
      category: 'other',
      smoothing: false,
      recategorize: true,
      futureMetadata: { retained: true },
    };
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).resolves.toMatchObject({ idempotent: false });
    const [restored] = await db
      .select({ meta: assets.meta, searchText: assets.searchText })
      .from(assets)
      .where(eq(assets.id, ASSET_ID));
    expect(restored?.meta).toMatchObject({
      category: 'other',
      smoothing: false,
      recategorize: true,
      futureMetadata: { retained: true },
    });
    expect(restored?.searchText).toBe(asset.data.searchText);
  });

  it('restores a custom-asset value point with precision beyond transaction money', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'customAssetValue', {
        assetId: ASSET_ID,
        date: '2026-07-24',
        close: '0.1234567',
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).resolves.toMatchObject({ idempotent: false });
    const [valuePoint] = await db
      .select({ close: priceHistory.close })
      .from(priceHistory)
      .where(eq(priceHistory.assetId, ASSET_ID));
    expect(valuePoint?.close).toBe('0.1234567');
  });

  it('round-trips a valid scale-6 transaction value above the normal cash cap', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const transaction = input.document.entities.find((entry) => entry.kind === 'transaction');
    if (!transaction || transaction.kind !== 'transaction') {
      throw new Error('expected transaction');
    }
    transaction.data.price = '2000000000000.000000';
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).resolves.toMatchObject({ idempotent: false });
    const [restored] = await db
      .select({ price: transactions.price })
      .from(transactions)
      .where(eq(transactions.id, TRANSACTION_ID));
    expect(restored?.price).toBe('2000000000000.000000');
  });

  it('round-trips transaction decimals beyond IEEE-754 precision byte-for-byte', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const transaction = input.document.entities.find((entry) => entry.kind === 'transaction');
    if (!transaction || transaction.kind !== 'transaction') {
      throw new Error('expected transaction');
    }
    transaction.data.quantity = '90071992547.12345678';
    transaction.data.price = '90071992547409.123456';
    transaction.data.fee = '0.123456';

    await createParanoidRehydrationService({ db }).rehydrate(user.id, input);

    const [restored] = await db
      .select({
        quantity: transactions.quantity,
        price: transactions.price,
        fee: transactions.fee,
      })
      .from(transactions)
      .where(eq(transactions.id, TRANSACTION_ID));
    expect(restored).toEqual({
      quantity: '90071992547.12345678',
      price: '90071992547409.123456',
      fee: '0.123456',
    });
  });

  it('accepts every strict purge-only entity without restoring its cache or staging row', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const batchId = '018f0000-0000-7000-8000-000000000030';
    const budgetId = '018f0000-0000-7000-8000-000000000031';
    input.document.entities.push(
      entity(batchId, 'importBatch', {
        ownerId: restoreUserId,
        portfolioId: PORTFOLIO_ID,
        brokerId: 'ibkr',
        filename: 'history.csv',
        status: 'applied',
        cashSourceId: CASH_SOURCE_ID,
        createdAt: editedAt,
        appliedAt: editedAt,
      }),
      entity('018f0000-0000-7000-8000-000000000032', 'importRow', {
        batchId,
        rowIndex: 2,
        raw: '2026-07-24,BUY,HOME',
        kind: 'buy',
        flag: 'mapped',
        message: null,
        executedAt: editedAt,
        isin: null,
        symbol: 'HOME',
        name: 'House',
        quantity: '1.00000000',
        price: '100.000000',
        fee: '0.000000',
        amountEur: null,
        currency: 'EUR',
        note: null,
        assetId: ASSET_ID,
        contentHash: 'a'.repeat(64),
        result: 'applied',
        resultMessage: null,
      }),
      entity('018f0000-0000-7000-8000-000000000033', 'portfolioDailySnapshot', {
        portfolioId: PORTFOLIO_ID,
        date: '2026-07-24',
        valueEur: '100.000000',
        costBasisEur: '100.000000',
        plEur: '0.000000',
        flowEur: '100.000000',
        cashBySource: { [CASH_SOURCE_ID]: '100.000000' },
        assetValues: { [ASSET_ID]: '100.000000' },
        computedAt: editedAt,
      }),
      entity('018f0000-0000-7000-8000-000000000034', 'portfolioSnapshotState', {
        portfolioId: PORTFOLIO_ID,
        computedThrough: '2026-07-24',
        dirtyFrom: null,
        updatedAt: editedAt,
      }),
      entity('018f0000-0000-7000-8000-000000000035', 'expenseBudgetFire', {
        budgetId,
        periodKey: '2026-07',
        firedAt: editedAt,
      }),
    );

    await createParanoidRehydrationService({ db }).rehydrate(user.id, input);

    expect(await db.select().from(importBatches)).toEqual([]);
    expect(await db.select().from(importRows)).toEqual([]);
    expect(await db.select().from(portfolioDailySnapshots)).toEqual([]);
    expect(await db.select().from(portfolioSnapshotState)).toEqual([]);
    expect(await db.select().from(expenseBudgetFires)).toEqual([]);
  });

  it('round-trips import-created notes and descriptions beyond manual-entry limits', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const transactionNote = `Imported trade ${'t'.repeat(1_001)}`;
    const dividendNote = `Imported dividend ${'d'.repeat(1_001)}`;
    const cashNote = `Imported cash ${'c'.repeat(1_001)}`;
    const expenseDescription = `Imported bank memo ${'e'.repeat(501)}`;
    const transaction = input.document.entities.find((entry) => entry.kind === 'transaction');
    const cashMovement = input.document.entities.find((entry) => entry.kind === 'cashMovement');
    if (!transaction || transaction.kind !== 'transaction') {
      throw new Error('expected transaction');
    }
    if (!cashMovement || cashMovement.kind !== 'cashMovement') {
      throw new Error('expected cash movement');
    }
    transaction.data.note = transactionNote;
    transaction.data.source = 'import:ibkr';
    cashMovement.data.note = cashNote;
    cashMovement.data.source = 'import:ibkr';

    const dividendId = '018f0000-0000-7000-8000-000000000017';
    const dividendMovementId = '018f0000-0000-7000-8000-000000000018';
    const expenseId = '018f0000-0000-7000-8000-000000000019';
    input.document.entities.push(
      entity(dividendId, 'dividend', {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        cashSourceId: CASH_SOURCE_ID,
        grossAmountEur: '10.000000',
        executedAt: editedAt,
        createdAt: editedAt,
        note: dividendNote,
        taxMode: 'none',
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
        source: 'import:flatex',
      }),
      entity(dividendMovementId, 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'dividend',
        amountEur: '10.000000',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId,
        taxYear: null,
        executedAt: editedAt,
        createdAt: editedAt,
        note: dividendNote,
        source: 'import:flatex',
      }),
      entity(expenseId, 'expenseTransaction', {
        userId: restoreUserId,
        categoryId: null,
        direction: 'expense',
        amount: '10.00',
        currency: 'EUR',
        bookedOn: '2026-07-24',
        description: expenseDescription,
        source: 'import:n26',
        dedupHash: 'imported-text-fixture',
        createdAt: editedAt,
        updatedAt: editedAt,
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).resolves.toMatchObject({ idempotent: false });
    const [restoredTransaction] = await db
      .select({ note: transactions.note, source: transactions.source })
      .from(transactions)
      .where(eq(transactions.id, TRANSACTION_ID));
    const [restoredDividend] = await db
      .select({ note: dividends.note, source: dividends.source })
      .from(dividends)
      .where(eq(dividends.id, dividendId));
    const [restoredCash] = await db
      .select({ note: portfolioCashMovements.note, source: portfolioCashMovements.source })
      .from(portfolioCashMovements)
      .where(eq(portfolioCashMovements.id, MOVEMENT_ID));
    const [restoredExpense] = await db
      .select({
        description: expenseTransactions.description,
        source: expenseTransactions.source,
      })
      .from(expenseTransactions)
      .where(eq(expenseTransactions.id, expenseId));

    expect(restoredTransaction).toEqual({ note: transactionNote, source: 'import:ibkr' });
    expect(restoredDividend).toEqual({ note: dividendNote, source: 'import:flatex' });
    expect(restoredCash).toEqual({ note: cashNote, source: 'import:ibkr' });
    expect(restoredExpense).toEqual({
      description: expenseDescription,
      source: 'import:n26',
    });
  });

  it('returns the original receipt after an uncertain response retry', async () => {
    const { db, user } = await makeParanoid();
    const service = createParanoidRehydrationService({
      db,
      now: () => new Date('2026-07-24T11:00:00.000Z'),
    });
    await service.rehydrate(user.id, request());
    await expect(service.rehydrate(user.id, request())).resolves.toMatchObject({
      rehydrationId: REHYDRATION_ID,
      idempotent: true,
    });
    await expect(
      service.rehydrate(user.id, request('018f0000-0000-7000-8000-000000000009')),
    ).rejects.toMatchObject({ code: 'REHYDRATION_CONFLICT' });
  });

  it('exercises every restored or reconstructed row in the rollback matrix', async () => {
    const { db, user } = await makeParanoid();
    const service = createParanoidRehydrationService({
      db,
      now: () => new Date('2026-07-24T11:00:00.000Z'),
    });

    await service.rehydrate(user.id, exhaustiveRequest());

    expect(
      (await db.select().from(portfolioCashMovements))
        .filter((row) => row.taxYear !== null)
        .map((row) => row.kind),
    ).toEqual(['tax_withholding']);
    expect(await db.select().from(standingOrderRuns)).toHaveLength(1);
    expect(await db.select().from(expenseBudgetFires)).toMatchObject([
      {
        budgetId: '018f0000-0000-7000-8000-000000000016',
        periodKey: '2026-06',
      },
    ]);
  });

  it.each([
    'customAssets',
    'portfolios',
    'cashSources',
    'taxSettings',
    'portfolioSettings',
    'transactions',
    'dividends',
    'cashMovements',
    'taxReplay',
    'standingOrders',
    'expenseCategories',
    'expenseRules',
    'expenseBudgets',
    'expenseTransactions',
    'normalMode',
    'ciphertextDeleted',
    'finish',
  ] as const)(
    'rolls every injected stage failure back without touching ciphertext (%s)',
    async (stage) => {
      const { db, user } = await makeParanoid();
      const service = createParanoidRehydrationService({
        db,
        afterStage: (actual) => {
          if (actual === stage) throw new ParanoidRehydrationError('INJECTED_FAILURE', 'injected');
        },
      });

      await expect(service.rehydrate(user.id, exhaustiveRequest())).rejects.toMatchObject({
        code: 'INJECTED_FAILURE',
      });

      expect(await db.select().from(assets).where(eq(assets.ownerId, user.id))).toEqual([]);
      expect(
        await db.select().from(priceHistory).where(eq(priceHistory.assetId, ASSET_ID)),
      ).toEqual([]);
      expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
      expect(
        await db
          .select()
          .from(portfolioCashSources)
          .where(eq(portfolioCashSources.portfolioId, PORTFOLIO_ID)),
      ).toEqual([]);
      expect(
        await db.select().from(userTaxSettings).where(eq(userTaxSettings.userId, user.id)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(portfolioSettings)
          .where(eq(portfolioSettings.portfolioId, PORTFOLIO_ID)),
      ).toEqual([]);
      expect(
        await db.select().from(transactions).where(eq(transactions.portfolioId, PORTFOLIO_ID)),
      ).toEqual([]);
      expect(
        await db.select().from(dividends).where(eq(dividends.portfolioId, PORTFOLIO_ID)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(portfolioCashMovements)
          .where(eq(portfolioCashMovements.portfolioId, PORTFOLIO_ID)),
      ).toEqual([]);
      expect(
        await db.select().from(standingOrders).where(eq(standingOrders.userId, user.id)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(standingOrderRuns)
          .where(eq(standingOrderRuns.standingOrderId, '018f0000-0000-7000-8000-000000000012')),
      ).toEqual([]);
      expect(
        await db.select().from(expenseCategories).where(eq(expenseCategories.userId, user.id)),
      ).toEqual([]);
      expect(
        await db.select().from(expenseTransactions).where(eq(expenseTransactions.userId, user.id)),
      ).toEqual([]);
      expect(await db.select().from(expenseRules).where(eq(expenseRules.userId, user.id))).toEqual(
        [],
      );
      expect(
        await db.select().from(expenseBudgets).where(eq(expenseBudgets.userId, user.id)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(expenseBudgetFires)
          .where(eq(expenseBudgetFires.budgetId, '018f0000-0000-7000-8000-000000000016')),
      ).toEqual([]);
      expect(
        await db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(paranoidVaultHistory)
          .where(eq(paranoidVaultHistory.userId, user.id)),
      ).toHaveLength(1);
      const [account] = await db
        .select({
          mode: users.privacyMode,
          media: users.paranoidMediaSet,
          drive: users.paranoidDriveAttestedVersion,
        })
        .from(users)
        .where(eq(users.id, user.id));
      expect(account).toEqual({
        mode: 'paranoid',
        media: ['server', 'drive'],
        drive: 4,
      });
      expect(
        await db
          .select()
          .from(paranoidRehydrationReceipts)
          .where(eq(paranoidRehydrationReceipts.userId, user.id)),
      ).toEqual([]);
    },
  );

  it('rejects an incomplete graph before it can write a row', async () => {
    const { db, user } = await makeParanoid();
    const malformed = request();
    malformed.document.entities = malformed.document.entities.filter(
      (entry) => entry.kind !== 'cashSource',
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, malformed)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
    expect(
      await db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toHaveLength(1);
  });

  it('ignores tombstones and validates references against live entities only', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const deletedPortfolio = input.document.entities.find((entry) => entry.kind === 'portfolio')!;
    deletedPortfolio.deletedAt = editedAt;
    input.document.entities = input.document.entities.filter(
      (entry) =>
        entry.kind !== 'cashSource' &&
        entry.kind !== 'transaction' &&
        entry.kind !== 'cashMovement',
    );
    input.document.entities.push(
      entity(SECOND_PORTFOLIO_ID, 'portfolio', {
        userId: restoreUserId,
        name: 'Live',
        visibility: 'private',
        sortOrder: 1,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).resolves.toMatchObject({ idempotent: false });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toMatchObject([
      { id: SECOND_PORTFOLIO_ID },
    ]);
    expect(await db.select().from(assets).where(eq(assets.id, ASSET_ID))).toHaveLength(1);
  });

  it('rejects an otherwise valid document with only archived portfolios before writing', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const portfolio = input.document.entities.find((entry) => entry.kind === 'portfolio')!;
    if (portfolio.kind !== 'portfolio') throw new Error('expected portfolio');
    portfolio.data.archivedAt = editedAt;
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects frozen tax facts on a buy before writing', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const transaction = input.document.entities.find((entry) => entry.kind === 'transaction');
    if (!transaction || transaction.kind !== 'transaction') throw new Error('expected transaction');
    transaction.data.taxMode = 'none';
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects a frozen tax amount on a none-mode sell before writing', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const transaction = input.document.entities.find((entry) => entry.kind === 'transaction');
    if (!transaction || transaction.kind !== 'transaction') throw new Error('expected transaction');
    transaction.data.side = 'sell';
    transaction.data.allowUncovered = true;
    transaction.data.taxMode = 'none';
    transaction.data.taxAmountEur = '1.000000';
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects a frozen tax amount on a none-mode dividend before writing', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'dividend', {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        cashSourceId: CASH_SOURCE_ID,
        grossAmountEur: '10.000000',
        executedAt: editedAt,
        createdAt: editedAt,
        note: null,
        taxMode: 'none',
        taxCountry: null,
        taxAmountEur: '1.000000',
        taxParams: null,
        source: 'manual',
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('restores reconciled country-tax history and its portfolio override', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const transaction = input.document.entities.find((entry) => entry.kind === 'transaction')!;
    const movement = input.document.entities.find((entry) => entry.kind === 'cashMovement')!;
    if (transaction.kind !== 'transaction' || movement.kind !== 'cashMovement') {
      throw new Error('expected transaction and cash movement');
    }
    transaction.data.side = 'sell';
    transaction.data.allowUncovered = true;
    transaction.data.uncoveredEntryPrice = null;
    transaction.data.taxMode = 'country_specific';
    transaction.data.taxCountry = 'AT';
    transaction.data.taxAmountEur = '0.000000';
    movement.data.kind = 'sell_proceeds';
    movement.data.transactionId = TRANSACTION_ID;
    movement.data.amountEur = '100.000000';
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'portfolioSetting', {
        portfolioId: PORTFOLIO_ID,
        key: 'tax',
        value: { mode: 'country_specific', country: 'AT' },
        updatedAt: editedAt,
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).resolves.toMatchObject({ idempotent: false });
    expect(await db.select().from(transactions)).toMatchObject([
      {
        id: TRANSACTION_ID,
        taxMode: 'country_specific',
        taxCountry: 'AT',
        taxAmountEur: '0.000000',
      },
    ]);
  });

  it.each(['AT', 'DE', 'FI'] as const)(
    'restores %s tax history through the restored user default',
    async (country) => {
      const { db, user } = await makeParanoid();
      const input = request();
      const transaction = input.document.entities.find((entry) => entry.kind === 'transaction')!;
      const movement = input.document.entities.find((entry) => entry.kind === 'cashMovement')!;
      if (transaction.kind !== 'transaction' || movement.kind !== 'cashMovement') {
        throw new Error('expected transaction and cash movement');
      }
      transaction.data.side = 'sell';
      transaction.data.allowUncovered = true;
      transaction.data.taxMode = 'country_specific';
      transaction.data.taxCountry = country;
      transaction.data.taxAmountEur = '0.000000';
      movement.data.kind = 'sell_proceeds';
      movement.data.transactionId = TRANSACTION_ID;
      input.document.entities.push(
        entity('018f0000-0000-7000-8000-00000000000d', 'taxSetting', {
          userId: restoreUserId,
          mode: 'country_specific',
          country,
          manualDefaultAmountEur: null,
          manualDefaultRatePct: null,
          customParams: null,
          updatedAt: editedAt,
        }),
      );
      const service = createParanoidRehydrationService({ db });

      await expect(service.rehydrate(user.id, input)).resolves.toMatchObject({
        idempotent: false,
      });
    },
  );

  it('restores reconciled custom-tax dividend history', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const customParams = {
      ratePct: 10,
      lossOffset: true,
      refund: true,
      yearReset: true,
      carryForward: false,
      costBasis: 'moving-average' as const,
    };
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'dividend', {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        cashSourceId: CASH_SOURCE_ID,
        grossAmountEur: '10.000000',
        executedAt: editedAt,
        createdAt: editedAt,
        note: null,
        taxMode: 'custom',
        taxCountry: null,
        taxAmountEur: '1.000000',
        taxParams: customParams,
        source: 'manual',
      }),
      entity('018f0000-0000-7000-8000-00000000000e', 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'dividend',
        amountEur: '10.000000',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: '018f0000-0000-7000-8000-00000000000d',
        taxYear: null,
        executedAt: editedAt,
        createdAt: editedAt,
        note: null,
        source: 'manual',
      }),
      entity('018f0000-0000-7000-8000-00000000000f', 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'tax_withholding',
        amountEur: '-1.000000',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: '018f0000-0000-7000-8000-00000000000d',
        taxYear: 2026,
        executedAt: editedAt,
        createdAt: editedAt,
        note: null,
        source: 'manual',
      }),
      entity('018f0000-0000-7000-8000-000000000010', 'taxSetting', {
        userId: restoreUserId,
        mode: 'custom',
        country: null,
        manualDefaultAmountEur: null,
        manualDefaultRatePct: null,
        customParams,
        updatedAt: editedAt,
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).resolves.toMatchObject({ idempotent: false });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toHaveLength(
      1,
    );
  });

  it('rejects a malformed tax override before the restore transaction', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-000000000010', 'portfolioSetting', {
        portfolioId: PORTFOLIO_ID,
        key: 'tax',
        value: { mode: 'custom', custom: { ratePct: 150 } },
        updatedAt: editedAt,
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects a country tax override with an unsupported country before writing', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-000000000010', 'portfolioSetting', {
        portfolioId: PORTFOLIO_ID,
        key: 'tax',
        value: { mode: 'country_specific', country: 'XX' },
        updatedAt: editedAt,
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('allows a document with an active portfolio alongside archived portfolios', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity(SECOND_PORTFOLIO_ID, 'portfolio', {
        userId: restoreUserId,
        name: 'Archived',
        visibility: 'private',
        sortOrder: 1,
        defaultPayFromCash: false,
        archivedAt: editedAt,
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).resolves.toMatchObject({ idempotent: false });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toHaveLength(
      2,
    );
  });

  it('rejects a manual asset whose provider reference is not its entity id', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const asset = input.document.entities.find((entry) => entry.kind === 'customAsset')!;
    if (asset.kind !== 'customAsset') throw new Error('expected custom asset');
    asset.data.providerRef = PORTFOLIO_ID;
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(assets).where(eq(assets.id, ASSET_ID))).toEqual([]);
  });

  it('replays positions per portfolio and rejects an oversell in a separate portfolio', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity(SECOND_PORTFOLIO_ID, 'portfolio', {
        userId: restoreUserId,
        name: 'Second',
        visibility: 'private',
        sortOrder: 1,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
      entity(SECOND_CASH_SOURCE_ID, 'cashSource', {
        portfolioId: SECOND_PORTFOLIO_ID,
        name: 'Main',
        type: 'cash',
        isMain: true,
        archivedAt: null,
        createdAt: editedAt,
      }),
      entity(SECOND_TRANSACTION_ID, 'transaction', {
        portfolioId: SECOND_PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'sell',
        quantity: '1.00000000',
        price: '100.000000',
        fee: '0.000000',
        executedAt: editedAt,
        note: null,
        taxMode: null,
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
        allowUncovered: false,
        uncoveredEntryPrice: null,
        source: 'manual',
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_CASH_LEDGER',
    });
    expect(await db.select().from(transactions)).toEqual([]);
  });

  it('accepts an untouched holdings-only portfolio with no cash sources', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities = input.document.entities.filter(
      (entry) => entry.kind !== 'cashSource' && entry.kind !== 'cashMovement',
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).resolves.toMatchObject({ idempotent: false });
    expect(await db.select().from(portfolios).where(eq(portfolios.id, PORTFOLIO_ID))).toHaveLength(
      1,
    );
  });

  it('rejects an archived Main source before it can write', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const source = input.document.entities.find((entry) => entry.kind === 'cashSource')!;
    if (source.kind !== 'cashSource') throw new Error('expected cash source');
    source.data.archivedAt = editedAt;
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects an archived non-Main source with a nonzero balance before it can write', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity(SECOND_CASH_SOURCE_ID, 'cashSource', {
        portfolioId: PORTFOLIO_ID,
        name: 'Archived savings',
        type: 'cash',
        isMain: false,
        archivedAt: editedAt,
        createdAt: editedAt,
      }),
      entity(TRANSFER_OUT_ID, 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: SECOND_CASH_SOURCE_ID,
        kind: 'deposit',
        amountEur: '10.000000',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: editedAt,
        createdAt: editedAt,
        note: null,
        source: 'manual',
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('preserves an imported expense deduplication marker exactly', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const dedupHash = expenseDedupHash({
      bookedOn: '2026-07-23',
      direction: 'expense',
      amount: 12.5,
      currency: 'EUR',
      description: 'Coffee Shop',
    });
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'expenseTransaction', {
        userId: restoreUserId,
        categoryId: null,
        direction: 'expense',
        amount: '12.50',
        currency: 'EUR',
        bookedOn: '2026-07-23',
        description: 'Coffee Shop',
        source: 'import:n26',
        dedupHash,
        createdAt: editedAt,
        updatedAt: editedAt,
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await service.rehydrate(user.id, input);

    const [expense] = await db
      .select({ dedupHash: expenseTransactions.dedupHash })
      .from(expenseTransactions);
    expect(expense?.dedupHash).toBe(dedupHash);
    expect(
      await db
        .insert(expenseTransactions)
        .values({
          userId: user.id,
          direction: 'expense',
          amount: '12.50',
          currency: 'EUR',
          bookedOn: '2026-07-23',
          description: 'Coffee Shop',
          source: 'import:n26',
          dedupHash,
        })
        .onConflictDoNothing({
          target: [expenseTransactions.userId, expenseTransactions.dedupHash],
        })
        .returning({ id: expenseTransactions.id }),
    ).toEqual([]);
  });

  it('rebuilds the closed-period expense budget fence without emitting an alert', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const categoryId = '018f0000-0000-7000-8000-000000000011';
    const budgetId = '018f0000-0000-7000-8000-000000000012';
    input.document.entities.push(
      entity(categoryId, 'expenseCategory', {
        userId: restoreUserId,
        name: 'Groceries',
        direction: 'expense',
        color: '#22c55e',
        createdAt: editedAt,
        updatedAt: editedAt,
      }),
      entity(budgetId, 'expenseBudget', {
        userId: restoreUserId,
        categoryId,
        amount: '50.00',
        currency: 'EUR',
        createdAt: editedAt,
        updatedAt: editedAt,
      }),
      entity('018f0000-0000-7000-8000-000000000013', 'expenseTransaction', {
        userId: restoreUserId,
        categoryId,
        direction: 'expense',
        amount: '60.00',
        currency: 'EUR',
        bookedOn: '2026-06-15',
        description: 'Restored groceries',
        source: 'manual',
        dedupHash: null,
        createdAt: editedAt,
        updatedAt: editedAt,
      }),
    );
    const service = createParanoidRehydrationService({
      db,
      now: () => new Date('2026-07-24T11:00:00.000Z'),
    });

    await expect(service.rehydrate(user.id, input)).resolves.toMatchObject({ idempotent: false });
    expect(await db.select().from(expenseCategories)).toHaveLength(1);
    expect(await db.select().from(expenseBudgets)).toHaveLength(1);
    expect(await db.select().from(expenseBudgetFires)).toMatchObject([
      { budgetId, periodKey: '2026-06' },
    ]);
  });

  it('restores the exact standing-order watermark and authoritative run row', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'standingOrder', {
        userId: restoreUserId,
        portfolioId: PORTFOLIO_ID,
        kind: 'cash-add',
        assetId: null,
        amount: '100.00000000',
        currency: 'EUR',
        label: 'Salary',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-01',
        endDate: null,
        status: 'active',
        lastRunAt: editedAt,
        lastPeriodKey: '2026-07-24',
        createdAt: editedAt,
        updatedAt: editedAt,
      }),
      entity('018f0000-0000-7000-8000-00000000000e', 'standingOrderRun', {
        standingOrderId: '018f0000-0000-7000-8000-00000000000d',
        periodKey: '2026-07-24',
        bookedAt: '2026-07-24T09:59:59.000Z',
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await service.rehydrate(user.id, input);

    const [order] = await db
      .select({ lastRunAt: standingOrders.lastRunAt, lastPeriodKey: standingOrders.lastPeriodKey })
      .from(standingOrders);
    expect(order?.lastRunAt?.toISOString()).toBe(editedAt);
    expect(order?.lastPeriodKey).toBe('2026-07-24');
    expect(await db.select().from(standingOrderRuns)).toMatchObject([
      {
        id: '018f0000-0000-7000-8000-00000000000e',
        standingOrderId: '018f0000-0000-7000-8000-00000000000d',
        periodKey: '2026-07-24',
        bookedAt: new Date('2026-07-24T09:59:59.000Z'),
      },
    ]);
  });

  it.each([
    { window: 'booking-failed' as const, expectedBookedRows: 0 },
    { window: 'mark-booked-failed' as const, expectedBookedRows: 1 },
  ])(
    'round-trips the retained claim when $window and prevents a retry',
    async ({ window, expectedBookedRows }) => {
      const captured = await captureAmbiguousStandingOrderWindow(window);
      const { db, user, ctx } = await makeParanoid();
      const input = request();
      input.document.entities.push(
        entity(STANDING_ORDER_ID, 'standingOrder', {
          userId: restoreUserId,
          portfolioId: PORTFOLIO_ID,
          kind: captured.order.kind,
          assetId: captured.order.assetId,
          amount: captured.order.amount,
          currency: 'EUR',
          label: captured.order.label,
          cadence: captured.order.cadence,
          anchorDay: captured.order.anchorDay,
          startDate: captured.order.startDate,
          endDate: captured.order.endDate,
          status: captured.order.status,
          lastRunAt: null,
          lastPeriodKey: null,
          createdAt: captured.order.createdAt.toISOString(),
          updatedAt: captured.order.updatedAt.toISOString(),
        }),
        entity(captured.run.id, 'standingOrderRun', {
          standingOrderId: captured.run.standingOrderId,
          periodKey: captured.run.periodKey,
          bookedAt: captured.run.bookedAt.toISOString(),
        }),
        ...captured.bookedRows.map((movement) =>
          entity(movement.id, 'cashMovement', {
            portfolioId: movement.portfolioId,
            sourceId: movement.sourceId,
            kind: movement.kind,
            amountEur: movement.amountEur,
            transactionId: movement.transactionId,
            transferId: movement.transferId,
            counterpartSourceId: movement.counterpartSourceId,
            dividendId: movement.dividendId,
            taxYear: movement.taxYear,
            executedAt: movement.executedAt.toISOString(),
            createdAt: movement.createdAt.toISOString(),
            note: movement.note,
            source: movement.source,
          }),
        ),
      );

      await createParanoidRehydrationService({ db }).rehydrate(user.id, input);

      const restoredRuns = await db
        .select()
        .from(standingOrderRuns)
        .where(eq(standingOrderRuns.standingOrderId, STANDING_ORDER_ID));
      expect(restoredRuns).toEqual([captured.run]);
      const beforeRetry = await db
        .select()
        .from(portfolioCashMovements)
        .where(
          and(
            eq(portfolioCashMovements.portfolioId, PORTFOLIO_ID),
            eq(portfolioCashMovements.source, 'standing-order'),
          ),
        );
      expect(beforeRetry).toHaveLength(expectedBookedRows);

      const retry = await ctx.standingOrders.processDueOrders({ now: Date.parse(editedAt) });
      expect(retry).toMatchObject({ booked: 0, skippedDuplicate: 1 });
      expect(
        await db
          .select()
          .from(portfolioCashMovements)
          .where(
            and(
              eq(portfolioCashMovements.portfolioId, PORTFOLIO_ID),
              eq(portfolioCashMovements.source, 'standing-order'),
            ),
          ),
      ).toHaveLength(expectedBookedRows);
    },
  );

  it('rejects a standing-order run whose parent is absent before writing', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'standingOrderRun', {
        standingOrderId: STANDING_ORDER_ID,
        periodKey: '2026-07-24',
        bookedAt: editedAt,
      }),
    );

    await expect(
      createParanoidRehydrationService({ db }).rehydrate(user.id, input),
    ).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects duplicate order-period claims before writing', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity(STANDING_ORDER_ID, 'standingOrder', {
        userId: restoreUserId,
        portfolioId: PORTFOLIO_ID,
        kind: 'cash-add',
        assetId: null,
        amount: '100.00000000',
        currency: 'EUR',
        label: 'Salary',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-01',
        endDate: null,
        status: 'active',
        lastRunAt: null,
        lastPeriodKey: null,
        createdAt: editedAt,
        updatedAt: editedAt,
      }),
      entity('018f0000-0000-7000-8000-00000000000d', 'standingOrderRun', {
        standingOrderId: STANDING_ORDER_ID,
        periodKey: '2026-07-24',
        bookedAt: editedAt,
      }),
      entity('018f0000-0000-7000-8000-00000000000e', 'standingOrderRun', {
        standingOrderId: STANDING_ORDER_ID,
        periodKey: '2026-07-24',
        bookedAt: '2026-07-24T10:00:01.000Z',
      }),
    );

    await expect(
      createParanoidRehydrationService({ db }).rehydrate(user.id, input),
    ).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it.each([
    { kind: 'cash-add' as const, assetId: null, currency: 'USD' },
    { kind: 'cash-deduct' as const, assetId: null, currency: 'USD' },
    { kind: 'buy-asset' as const, assetId: ASSET_ID, currency: 'USD' },
  ])('rejects a $kind standing order with a non-derived currency', async (order) => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'standingOrder', {
        userId: restoreUserId,
        portfolioId: PORTFOLIO_ID,
        kind: order.kind,
        assetId: order.assetId,
        amount: '100.00000000',
        currency: order.currency,
        label: null,
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-01',
        endDate: null,
        status: 'active',
        lastRunAt: null,
        lastPeriodKey: null,
        createdAt: editedAt,
        updatedAt: editedAt,
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects a dividend without its required gross cash movement before writing', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000e', 'dividend', {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        cashSourceId: CASH_SOURCE_ID,
        grossAmountEur: '10.000000',
        executedAt: editedAt,
        createdAt: editedAt,
        note: null,
        taxMode: 'none',
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
        source: 'manual',
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects duplicate tax settings before writing any restored rows', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const taxSetting = {
      userId: restoreUserId,
      mode: 'none' as const,
      country: null,
      manualDefaultAmountEur: null,
      manualDefaultRatePct: null,
      customParams: null,
      updatedAt: editedAt,
    };
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'taxSetting', taxSetting),
      entity('018f0000-0000-7000-8000-00000000000e', 'taxSetting', taxSetting),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects an untrusted linked trade cash amount before it can write', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const movement = input.document.entities.find((entry) => entry.kind === 'cashMovement')!;
    if (movement.kind !== 'cashMovement') throw new Error('expected cash movement');
    movement.data.kind = 'buy';
    movement.data.amountEur = '-1.000000';
    movement.data.transactionId = TRANSACTION_ID;
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'deposit',
        amountEur: '1.000000',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-24T09:59:59.000Z',
        createdAt: '2026-07-24T09:59:59.000Z',
        note: null,
        source: 'manual',
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('uses the historical conversion and normal cash rounding for a linked foreign-currency trade', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const asset = input.document.entities.find((entry) => entry.kind === 'customAsset')!;
    const movement = input.document.entities.find((entry) => entry.kind === 'cashMovement')!;
    if (asset.kind !== 'customAsset' || movement.kind !== 'cashMovement') {
      throw new Error('expected custom asset and cash movement');
    }
    asset.data.currency = 'USD';
    movement.data.kind = 'buy';
    movement.data.amountEur = '-75.000000';
    movement.data.transactionId = TRANSACTION_ID;
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'deposit',
        amountEur: '75.000000',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-24T09:59:59.000Z',
        createdAt: '2026-07-24T09:59:59.000Z',
        note: null,
        source: 'manual',
      }),
    );
    const conversion = async (amount: number, currency: string, day: string) => {
      expect({ amount, currency, day }).toEqual({
        amount: 100,
        currency: 'USD',
        day: '2026-07-24',
      });
      return 75.009;
    };
    const service = createParanoidRehydrationService({ db, toCashEur: conversion });

    await expect(service.rehydrate(user.id, input)).resolves.toMatchObject({ idempotent: false });
  });

  it('rejects a linked foreign-currency trade when the historical conversion is unavailable', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const asset = input.document.entities.find((entry) => entry.kind === 'customAsset')!;
    const movement = input.document.entities.find((entry) => entry.kind === 'cashMovement')!;
    if (asset.kind !== 'customAsset' || movement.kind !== 'cashMovement') {
      throw new Error('expected custom asset and cash movement');
    }
    asset.data.currency = 'USD';
    movement.data.kind = 'buy';
    movement.data.amountEur = '-75.000000';
    movement.data.transactionId = TRANSACTION_ID;
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'deposit',
        amountEur: '75.000000',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-24T09:59:59.000Z',
        createdAt: '2026-07-24T09:59:59.000Z',
        note: null,
        source: 'manual',
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('replays equal-time cash movements in persisted id order', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities = input.document.entities.filter(
      (entry) => entry.kind !== 'cashMovement',
    );
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000f', 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'deposit',
        amountEur: '100.000000',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: editedAt,
        createdAt: editedAt,
        note: null,
        source: 'manual',
      }),
      entity('018f0000-0000-7000-8000-000000000000', 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'withdrawal',
        amountEur: '-100.000000',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: editedAt,
        createdAt: editedAt,
        note: null,
        source: 'manual',
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_CASH_LEDGER',
    });
    expect(await db.select().from(portfolioCashMovements)).toEqual([]);
  });

  it('replays equal-time transactions in persisted id order before writing', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities = input.document.entities.filter(
      (entry) => entry.kind !== 'transaction',
    );
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000f', 'transaction', {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: '1.00000000',
        price: '100.000000',
        fee: '0.000000',
        executedAt: editedAt,
        note: null,
        taxMode: null,
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
        allowUncovered: false,
        uncoveredEntryPrice: null,
        source: 'manual',
      }),
      entity('018f0000-0000-7000-8000-000000000000', 'transaction', {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'sell',
        quantity: '1.00000000',
        price: '100.000000',
        fee: '0.000000',
        executedAt: editedAt,
        note: null,
        taxMode: null,
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
        allowUncovered: false,
        uncoveredEntryPrice: null,
        source: 'manual',
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_CASH_LEDGER',
    });
    expect(await db.select().from(transactions)).toEqual([]);
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects existing uncategorized expense rows before it can write', async () => {
    const { db, user } = await makeParanoid();
    await db.insert(expenseTransactions).values({
      userId: user.id,
      direction: 'expense',
      amount: '1.00',
      currency: 'EUR',
      bookedOn: '2026-07-23',
      description: 'Existing manual expense',
      source: 'manual',
    });
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, request())).rejects.toMatchObject({
      code: 'REHYDRATION_CONFLICT',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects a cash movement linked to a transaction in another portfolio', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity(SECOND_PORTFOLIO_ID, 'portfolio', {
        userId: restoreUserId,
        name: 'Second',
        visibility: 'private',
        sortOrder: 1,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
      entity(SECOND_CASH_SOURCE_ID, 'cashSource', {
        portfolioId: SECOND_PORTFOLIO_ID,
        name: 'Main',
        type: 'cash',
        isMain: true,
        archivedAt: null,
        createdAt: editedAt,
      }),
      entity(TRANSFER_OUT_ID, 'cashMovement', {
        portfolioId: SECOND_PORTFOLIO_ID,
        sourceId: SECOND_CASH_SOURCE_ID,
        kind: 'buy',
        amountEur: '-100.000000',
        transactionId: TRANSACTION_ID,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: editedAt,
        createdAt: editedAt,
        note: null,
        source: 'manual',
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects a lone transfer even when its counterpart source exists', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity(SECOND_CASH_SOURCE_ID, 'cashSource', {
        portfolioId: PORTFOLIO_ID,
        name: 'Savings',
        type: 'cash',
        isMain: false,
        archivedAt: null,
        createdAt: editedAt,
      }),
      entity(TRANSFER_OUT_ID, 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'transfer_out',
        amountEur: '-100.000000',
        transactionId: null,
        transferId: TRANSFER_ID,
        counterpartSourceId: SECOND_CASH_SOURCE_ID,
        dividendId: null,
        taxYear: null,
        executedAt: editedAt,
        createdAt: editedAt,
        note: null,
        source: 'manual',
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });
});
