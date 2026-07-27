import type { ParanoidDisableRehydrationRequest } from '@bettertrack/contracts';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { createTransactionRepository } from '../../../data/repositories/transactionRepository';
import {
  assets,
  paranoidRehydrationReceipts,
  paranoidVaults,
  portfolioCashSources,
  portfolios,
  transactions,
  users,
} from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  createParanoidRehydrationService,
  type ParanoidRehydrationStage,
} from '../paranoidRehydrationService';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000101';
const LEGACY_PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000102';
const LEGACY_ASSET_ID = '018f0000-0000-7000-8000-000000000103';
const LEGACY_BUY_ID = '018f0000-0000-7000-8000-000000000104';
const BACKDATED_LEGACY_BUY_FIRST_ID = '018f0000-0000-7000-8000-000000000105';
const NORMAL_ASSET_ID = '018f0000-0000-7000-8000-000000000106';
const BACKDATED_LEGACY_BUY_SECOND_ID = '018f0000-0000-7000-8000-000000000107';
const HIGH_MAGNITUDE_ASSET_ID = '018f0000-0000-7000-8000-000000000108';
const HIGH_MAGNITUDE_SELL_ID = '018f0000-0000-7000-8000-00000000010a';
const FIRST_REHYDRATION_ID = '018f0000-0000-7000-8000-00000000010b';
const SECOND_REHYDRATION_ID = '018f0000-0000-7000-8000-00000000010c';
const EDITED_AT = '2026-07-24T10:00:00.000Z';

type StrictEntity = ParanoidDisableRehydrationRequest['document']['entities'][number];
type StrictTransactionEntity = Extract<StrictEntity, { kind: 'transaction' }>;

function entity<K extends StrictEntity['kind']>(
  id: string,
  kind: K,
  data: Extract<StrictEntity, { kind: K }>['data'],
): Extract<StrictEntity, { kind: K }> {
  return {
    id,
    kind,
    rev: 0,
    editedAt: EDITED_AT,
    editedBy: DEVICE_ID,
    deletedAt: null,
    data,
  } as Extract<StrictEntity, { kind: K }>;
}

function portfolioEntity(userId: string, portfolioId: string) {
  return entity(portfolioId, 'portfolio', {
    userId,
    name: 'Main',
    visibility: 'private',
    sortOrder: 0,
    defaultPayFromCash: false,
    archivedAt: null,
  });
}

function transactionEntity(input: {
  id: string;
  portfolioId: string;
  assetId: string;
  side: StrictTransactionEntity['data']['side'];
  quantity: string;
  executedAt: string;
}): StrictTransactionEntity {
  return entity(input.id, 'transaction', {
    portfolioId: input.portfolioId,
    assetId: input.assetId,
    side: input.side,
    quantity: input.quantity,
    price: '10.000000',
    fee: '0.000000',
    executedAt: input.executedAt,
    note: null,
    taxMode: null,
    taxCountry: null,
    taxAmountEur: null,
    taxParams: null,
    allowUncovered: false,
    uncoveredEntryPrice: null,
    source: 'manual',
  });
}

function strictPortfolioEntity(row: typeof portfolios.$inferSelect) {
  return entity(row.id, 'portfolio', {
    userId: row.userId,
    name: row.name,
    visibility: row.visibility,
    sortOrder: row.sortOrder,
    defaultPayFromCash: row.defaultPayFromCash,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  });
}

function strictCashSourceEntity(row: typeof portfolioCashSources.$inferSelect) {
  return entity(row.id, 'cashSource', {
    portfolioId: row.portfolioId,
    name: row.name,
    type: row.type,
    isMain: row.isMain,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

function strictTransactionEntity(row: typeof transactions.$inferSelect): StrictTransactionEntity {
  return entity(row.id, 'transaction', {
    portfolioId: row.portfolioId,
    assetId: row.assetId,
    side: row.side,
    quantity: row.quantity,
    price: row.price,
    fee: row.fee,
    executedAt: row.executedAt.toISOString(),
    note: row.note,
    taxMode: row.taxMode,
    taxCountry: row.taxCountry as StrictTransactionEntity['data']['taxCountry'],
    taxAmountEur: row.taxAmountEur,
    taxParams: row.taxParams as StrictTransactionEntity['data']['taxParams'],
    allowUncovered: row.allowUncovered,
    uncoveredEntryPrice: row.uncoveredEntryPrice,
    source: row.source,
  });
}

function strictDocument(entities: readonly StrictEntity[]) {
  return {
    schemaVersion: 1,
    entities: [...entities],
    mergeLog: [],
  } satisfies ParanoidDisableRehydrationRequest['document'];
}

function quantityEntities(
  document: ParanoidDisableRehydrationRequest['document'],
): StrictTransactionEntity[] {
  return document.entities.filter(
    (entry): entry is StrictTransactionEntity => entry.kind === 'transaction',
  );
}

function quantityField(transaction: StrictTransactionEntity): string {
  return (
    'transaction[' + transaction.id + '].quantity=' + JSON.stringify(transaction.data.quantity)
  );
}

async function seedGlobalAsset(harness: TestHarness, id: string, symbol: string): Promise<void> {
  await harness.db.insert(assets).values({
    id,
    providerId: 'conformance',
    providerRef: symbol,
    ownerId: null,
    type: 'stock',
    symbol,
    name: symbol + ' quantity fixture',
    exchange: null,
    currency: 'EUR',
  });
}

async function replaceNormalRowsWithServerVault(
  harness: TestHarness,
  userId: string,
): Promise<void> {
  await harness.db.delete(portfolios).where(eq(portfolios.userId, userId));
  await harness.db
    .delete(paranoidRehydrationReceipts)
    .where(eq(paranoidRehydrationReceipts.userId, userId));
  await harness.db.delete(paranoidVaults).where(eq(paranoidVaults.userId, userId));
  await harness.db
    .update(users)
    .set({
      privacyMode: 'paranoid',
      paranoidMediaSet: ['server'],
      paranoidDriveAttestedVersion: null,
    })
    .where(eq(users.id, userId));
  await harness.db.insert(paranoidVaults).values({
    userId,
    version: 1,
    formatVersion: 1,
    sizeBytes: 10,
    blob: Buffer.from('quantity-conformance-ciphertext'),
  });
}

async function capturePortfolioDocument(
  harness: TestHarness,
  portfolioId: string,
): Promise<ParanoidDisableRehydrationRequest['document']> {
  const [portfolio] = await harness.db
    .select()
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId));
  if (!portfolio) throw new Error('expected portfolio');
  const cashSources = await harness.db
    .select()
    .from(portfolioCashSources)
    .where(eq(portfolioCashSources.portfolioId, portfolioId));
  const transactionRows = await harness.db
    .select()
    .from(transactions)
    .where(eq(transactions.portfolioId, portfolioId));

  return strictDocument([
    strictPortfolioEntity(portfolio),
    ...cashSources.map(strictCashSourceEntity),
    ...transactionRows.map(strictTransactionEntity),
  ]);
}

async function rehydrateReachableState(
  harness: TestHarness,
  userId: string,
  document: ParanoidDisableRehydrationRequest['document'],
  rehydrationId: string,
  name: string,
): Promise<void> {
  try {
    await createParanoidRehydrationService({ db: harness.db }).rehydrate(userId, {
      rehydrationId,
      document,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name + ': ' + error.message : String(error);
    throw new Error(
      name +
        ' rejected a normal-write persisted state; transaction quantities: ' +
        quantityEntities(document).map(quantityField).join(', ') +
        '; ' +
        reason,
    );
  }
}

async function arrangeScaleEightRoundingBatch(): Promise<{
  harness: TestHarness;
  userId: string;
  portfolioId: string;
  document: ParanoidDisableRehydrationRequest['document'];
  sell: StrictTransactionEntity;
}> {
  const harness = await createTestApp();
  const user = await harness.seedUser();
  const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
  await seedGlobalAsset(harness, NORMAL_ASSET_ID, 'ROUNDING');

  await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
    {
      assetId: NORMAL_ASSET_ID,
      side: 'buy',
      quantity: 1.0000000046,
      price: 10,
      fee: 0,
      executedAt: '2026-07-23T10:00:00.000Z',
    },
    {
      assetId: NORMAL_ASSET_ID,
      side: 'sell',
      quantity: 1.0000000051,
      price: 11,
      fee: 0,
      executedAt: '2026-07-23T10:01:00.000Z',
    },
  ]);

  const document = await capturePortfolioDocument(harness, portfolioId);
  const sell = quantityEntities(document).find((transaction) => transaction.data.side === 'sell');
  if (!sell) throw new Error('expected persisted sell');
  expect(sell.data.quantity).toBe('1.00000001');

  await replaceNormalRowsWithServerVault(harness, user.id);
  return { harness, userId: user.id, portfolioId, document, sell };
}

describe('paranoid rehydration transaction-quantity differential conformance', () => {
  it('round-trips an epsilon-valid normal batch after numeric(20,8) rounds its quantities apart', async () => {
    const arranged = await arrangeScaleEightRoundingBatch();

    await rehydrateReachableState(
      arranged.harness,
      arranged.userId,
      arranged.document,
      FIRST_REHYDRATION_ID,
      'scale-8 rounding batch',
    );

    const restored = await arranged.harness.db
      .select({ side: transactions.side, quantity: transactions.quantity })
      .from(transactions)
      .where(eq(transactions.portfolioId, arranged.portfolioId));
    expect(restored.sort((left, right) => left.side.localeCompare(right.side))).toEqual([
      { side: 'buy', quantity: '1.00000000' },
      { side: 'sell', quantity: '1.00000001' },
    ]);
  });

  it('keeps an exact legacy prefix and accepts the later repository-readback sale', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    await seedGlobalAsset(harness, LEGACY_ASSET_ID, 'LEGACY');

    const legacyDocument = strictDocument([
      portfolioEntity(user.id, LEGACY_PORTFOLIO_ID),
      transactionEntity({
        id: LEGACY_BUY_ID,
        portfolioId: LEGACY_PORTFOLIO_ID,
        assetId: LEGACY_ASSET_ID,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
    ]);
    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      legacyDocument,
      FIRST_REHYDRATION_ID,
      'exact legacy prefix',
    );

    const transactionRepo = createTransactionRepository(harness.db);
    const [legacyBuy] = await transactionRepo.listForAsset(LEGACY_PORTFOLIO_ID, LEGACY_ASSET_ID);
    if (!legacyBuy) throw new Error('expected legacy transaction readback');
    expect(legacyBuy.quantity).toBe(90071992547.12346);

    await harness.ctx.portfolio.createTransactions(user.id, LEGACY_PORTFOLIO_ID, [
      {
        assetId: LEGACY_ASSET_ID,
        side: 'sell',
        quantity: legacyBuy.quantity,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:01:00.000Z',
      },
    ]);

    const persisted = await harness.db
      .select({ side: transactions.side, quantity: transactions.quantity })
      .from(transactions)
      .where(eq(transactions.portfolioId, LEGACY_PORTFOLIO_ID));
    expect(persisted.sort((left, right) => left.side.localeCompare(right.side))).toEqual([
      { side: 'buy', quantity: '90071992547.12345678' },
      { side: 'sell', quantity: '90071992547.12346000' },
    ]);

    const resultingDocument = await capturePortfolioDocument(harness, LEGACY_PORTFOLIO_ID);
    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      resultingDocument,
      SECOND_REHYDRATION_ID,
      'composed legacy/readback lifecycle',
    );
  });

  it('keeps backdated legacy members in write history before a later normal sale', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    await seedGlobalAsset(harness, LEGACY_ASSET_ID, 'BACKDATED-LEGACY');

    const legacyDocument = strictDocument([
      portfolioEntity(user.id, LEGACY_PORTFOLIO_ID),
      transactionEntity({
        id: BACKDATED_LEGACY_BUY_FIRST_ID,
        portfolioId: LEGACY_PORTFOLIO_ID,
        assetId: LEGACY_ASSET_ID,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
      transactionEntity({
        id: BACKDATED_LEGACY_BUY_SECOND_ID,
        portfolioId: LEGACY_PORTFOLIO_ID,
        assetId: LEGACY_ASSET_ID,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:02:00.000Z',
      }),
    ]);
    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      legacyDocument,
      FIRST_REHYDRATION_ID,
      'backdated exact legacy history',
    );

    const transactionRepo = createTransactionRepository(harness.db);
    const legacyBuys = await transactionRepo.listForAsset(LEGACY_PORTFOLIO_ID, LEGACY_ASSET_ID);
    expect(legacyBuys).toHaveLength(2);
    expect(legacyBuys.every((transaction) => transaction.quantity === 90071992547.12346)).toBe(
      true,
    );

    await harness.ctx.portfolio.createTransactions(user.id, LEGACY_PORTFOLIO_ID, [
      {
        assetId: LEGACY_ASSET_ID,
        side: 'sell',
        quantity: legacyBuys[0]!.quantity,
        price: 11,
        fee: 0,
        // The normal write is backdated between its two exact-v1 predecessors.
        executedAt: '2026-07-23T10:01:00.000Z',
      },
    ]);

    const persisted = await harness.db
      .select({ id: transactions.id, side: transactions.side, quantity: transactions.quantity })
      .from(transactions)
      .where(eq(transactions.portfolioId, LEGACY_PORTFOLIO_ID));
    const normalSell = persisted.find((transaction) => transaction.side === 'sell');
    if (!normalSell) throw new Error('expected normal backdated sell');
    expect(normalSell.id > BACKDATED_LEGACY_BUY_SECOND_ID).toBe(true);
    expect(
      persisted
        .map((transaction) => ({ side: transaction.side, quantity: transaction.quantity }))
        .sort((left, right) => left.side.localeCompare(right.side)),
    ).toEqual([
      { side: 'buy', quantity: '90071992547.12345678' },
      { side: 'buy', quantity: '90071992547.12345678' },
      { side: 'sell', quantity: '90071992547.12346000' },
    ]);

    const resultingDocument = await capturePortfolioDocument(harness, LEGACY_PORTFOLIO_ID);
    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      resultingDocument,
      SECOND_REHYDRATION_ID,
      'backdated composed legacy/readback lifecycle',
    );
  });

  it('rejects a high-magnitude apparent oversell with no normal-write preimage before restore writes', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    await seedGlobalAsset(harness, HIGH_MAGNITUDE_ASSET_ID, 'NO-PREIMAGE');
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId: HIGH_MAGNITUDE_ASSET_ID,
        side: 'buy',
        quantity: 999_999_999_999,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:00:00.000Z',
      },
    ]);
    const highMagnitudeDocument = await capturePortfolioDocument(harness, portfolioId);
    const normalBuy = quantityEntities(highMagnitudeDocument).find(
      (transaction) => transaction.data.side === 'buy',
    );
    if (!normalBuy) throw new Error('expected normal high-magnitude buy');
    expect(normalBuy.data.quantity).toBe('999999999999.00000000');
    highMagnitudeDocument.entities.push(
      transactionEntity({
        id: HIGH_MAGNITUDE_SELL_ID,
        portfolioId,
        assetId: HIGH_MAGNITUDE_ASSET_ID,
        side: 'sell',
        quantity: '999999999999.00006000',
        executedAt: '2026-07-23T10:01:00.000Z',
      }),
    );
    const stages: ParanoidRehydrationStage[] = [];
    await replaceNormalRowsWithServerVault(harness, user.id);
    // Preflight must fail before the mutation transaction opens. That proves no
    // restore write was merely rolled back after the fact.
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');

    await expect(
      createParanoidRehydrationService({
        db: harness.db,
        afterStage(stage) {
          stages.push(stage);
        },
      }).rehydrate(user.id, {
        rehydrationId: FIRST_REHYDRATION_ID,
        document: highMagnitudeDocument,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_CASH_LEDGER',
      message: expect.stringContaining(
        quantityField(
          transactionEntity({
            id: HIGH_MAGNITUDE_SELL_ID,
            portfolioId,
            assetId: HIGH_MAGNITUDE_ASSET_ID,
            side: 'sell',
            quantity: '999999999999.00006000',
            executedAt: '2026-07-23T10:01:00.000Z',
          }),
        ),
      ),
    });
    expect(mutationTransaction).not.toHaveBeenCalled();
    expect(stages).toEqual([]);
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toEqual([]);
    expect(await harness.db.select().from(transactions)).toEqual([]);
    mutationTransaction.mockRestore();
  });

  it('negative control: a temporarily tightened quantity rule rejects in rehydration preflight with the persisted entity path and value', async () => {
    const arranged = await arrangeScaleEightRoundingBatch();
    const mutationTransaction = vi.spyOn(arranged.harness.db, 'transaction');
    let checkedSell = false;

    try {
      await expect(
        createParanoidRehydrationService({
          db: arranged.harness.db,
          // Tighten the normal scale-8 ceiling from 1.00000001 to
          // 1.00000000 inside the service's real quantity preflight.
          testOnlyRejectPersistedTransactionQuantity({ transactionId, quantity }) {
            if (transactionId === arranged.sell.id) checkedSell = true;
            return quantity > 100_000_000n;
          },
        }).rehydrate(arranged.userId, {
          rehydrationId: FIRST_REHYDRATION_ID,
          document: arranged.document,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CASH_LEDGER',
        message: expect.stringContaining(quantityField(arranged.sell)),
      });
      expect(checkedSell).toBe(true);
      expect(mutationTransaction).not.toHaveBeenCalled();
      expect(await arranged.harness.db.select().from(transactions)).toEqual([]);
    } finally {
      mutationTransaction.mockRestore();
    }
  });
});
