import type { ParanoidDisableRehydrationRequest } from '@bettertrack/contracts';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { createTransactionRepository } from '../../../data/repositories/transactionRepository';
import {
  assets,
  paranoidRehydrationReceipts,
  paranoidVaults,
  portfolioCashMovements,
  portfolioCashSources,
  portfolios,
  transactions,
  userTaxSettings,
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
const FIRST_REHYDRATION_ID = '018f0000-0000-7000-8000-00000000010b';
const SECOND_REHYDRATION_ID = '018f0000-0000-7000-8000-00000000010c';
const LEGACY_CASH_SOURCE_ID = '018f0000-0000-7000-8000-00000000010d';
const NORMAL_HISTORY_TRANSACTION_COUNT = 2_047;
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

function cashSourceEntity(id: string, portfolioId: string) {
  return entity(id, 'cashSource', {
    portfolioId,
    name: 'Main',
    type: 'cash',
    isMain: true,
    archivedAt: null,
    createdAt: EDITED_AT,
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

function strictCashMovementEntity(row: typeof portfolioCashMovements.$inferSelect) {
  return entity(row.id, 'cashMovement', {
    portfolioId: row.portfolioId,
    sourceId: row.sourceId,
    kind: row.kind,
    amountEur: row.amountEur,
    transactionId: row.transactionId,
    transferId: row.transferId,
    counterpartSourceId: row.counterpartSourceId,
    dividendId: row.dividendId,
    taxYear: row.taxYear,
    executedAt: row.executedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    note: row.note,
    source: row.source,
  });
}

function strictTaxSettingEntity(row: typeof userTaxSettings.$inferSelect) {
  return entity(row.userId, 'taxSetting', {
    userId: row.userId,
    mode: row.mode,
    country: row.country as Extract<StrictEntity, { kind: 'taxSetting' }>['data']['country'],
    manualDefaultAmountEur: row.manualDefaultAmountEur,
    manualDefaultRatePct: row.manualDefaultRatePct,
    customParams: row.customParams as Extract<
      StrictEntity,
      { kind: 'taxSetting' }
    >['data']['customParams'],
    updatedAt: row.updatedAt.toISOString(),
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

function nextUuidV7WriteId(id: string): string {
  const timestamp = id.slice(0, 8) + id.slice(9, 13);
  const nextTimestamp = (BigInt(`0x${timestamp}`) + 1n).toString(16).padStart(12, '0');
  return nextTimestamp.slice(0, 8) + '-' + nextTimestamp.slice(8) + id.slice(13);
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
  await harness.db.delete(userTaxSettings).where(eq(userTaxSettings.userId, userId));
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
  const cashMovements = await harness.db
    .select()
    .from(portfolioCashMovements)
    .where(eq(portfolioCashMovements.portfolioId, portfolioId));
  const [taxSetting] = await harness.db
    .select()
    .from(userTaxSettings)
    .where(eq(userTaxSettings.userId, portfolio.userId));

  return strictDocument([
    strictPortfolioEntity(portfolio),
    ...cashSources.map(strictCashSourceEntity),
    ...transactionRows.map(strictTransactionEntity),
    ...cashMovements.map(strictCashMovementEntity),
    ...(taxSetting ? [strictTaxSettingEntity(taxSetting)] : []),
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
  it('rehydrates a solvent strict-v1 timeline whose valid timestamps omit milliseconds', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = '018f0000-0100-7000-8000-000000000111';
    const assetId = '018f0000-0100-7000-8000-000000000112';
    // UUIDv4 is contract-valid but cannot carry the UUIDv7 provenance required
    // by the insolvent direct proof, so success also proves that branch stayed
    // unnecessary for this solvent timeline.
    const buyId = '018f0000-0100-4000-8000-000000000113';
    const sellId = '018f0000-0100-4000-8000-000000000114';
    await seedGlobalAsset(harness, assetId, 'SOLVENT-NO-MILLISECONDS');

    const document = strictDocument([
      portfolioEntity(user.id, portfolioId),
      transactionEntity({
        id: buyId,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '1.00000000',
        executedAt: '2026-07-23T10:00:00Z',
      }),
      transactionEntity({
        id: sellId,
        portfolioId,
        assetId,
        side: 'sell',
        quantity: '1.00000000',
        executedAt: '2026-07-23T10:01:00Z',
      }),
    ]);
    expect(quantityEntities(document).map((row) => row.data.executedAt)).toEqual([
      '2026-07-23T10:00:00Z',
      '2026-07-23T10:01:00Z',
    ]);

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      document,
      FIRST_REHYDRATION_ID,
      'solvent strict-v1 timeline without millisecond spelling',
    );

    const restored = await harness.db
      .select({ id: transactions.id, quantity: transactions.quantity })
      .from(transactions)
      .where(eq(transactions.portfolioId, portfolioId));
    expect(restored.sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: buyId, quantity: '1.00000000' },
      { id: sellId, quantity: '1.00000000' },
    ]);
  });

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

  it('rehydrates a normal rounding batch across a persisted-flat raw residual', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const assetId = '018f0000-0c00-7000-8000-000000000c02';
    await seedGlobalAsset(harness, assetId, 'RAW-EPOCH-RESIDUAL');

    // The first stored sell flattens numeric(20,8), but its normal public
    // inputs retain about 9.8e-9 shares. The final sell is valid within the
    // normal reducer epsilon and clamps that raw residual to zero, while
    // storage records the one-quantum oversell that needs the same witness.
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId,
        side: 'buy',
        quantity: 1.0000000049,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:00:00.000Z',
      },
      {
        assetId,
        side: 'sell',
        quantity: 0.9999999951,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:01:00.000Z',
      },
      {
        assetId,
        side: 'sell',
        quantity: 0.00000001,
        price: 12,
        fee: 0,
        executedAt: '2026-07-23T10:02:00.000Z',
      },
    ]);

    const document = await capturePortfolioDocument(harness, portfolioId);
    expect(
      quantityEntities(document)
        .map((transaction) => ({
          side: transaction.data.side,
          quantity: transaction.data.quantity,
          executedAt: transaction.data.executedAt,
        }))
        .sort((left, right) => left.executedAt.localeCompare(right.executedAt)),
    ).toEqual([
      { side: 'buy', quantity: '1.00000000', executedAt: '2026-07-23T10:00:00.000Z' },
      { side: 'sell', quantity: '1.00000000', executedAt: '2026-07-23T10:01:00.000Z' },
      { side: 'sell', quantity: '0.00000001', executedAt: '2026-07-23T10:02:00.000Z' },
    ]);

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      document,
      FIRST_REHYDRATION_ID,
      'normal rounding batch across a persisted-flat raw residual',
    );
  });

  it('rehydrates a normal rounding CREATE batch from a strict-prefix holding', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = '018f0000-0b00-7000-8000-000000000b01';
    const assetId = '018f0000-0b00-7000-8000-000000000b02';
    const cutoffAssetId = '018f0000-0b00-7000-8000-000000000b03';
    await seedGlobalAsset(harness, assetId, 'PREFIX-SEEDED-ROUNDING');
    await seedGlobalAsset(harness, cutoffAssetId, 'PREFIX-SEEDED-CUTOFF');

    const writeIds = ['018f0000-0b00-7000-8000-000000000b04'];
    writeIds.push(nextUuidV7WriteId(writeIds[0]!));
    const legacyDocument = strictDocument([
      portfolioEntity(user.id, portfolioId),
      transactionEntity({
        id: writeIds[0]!,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '1.00000000',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
      // This unrelated exact row has no public-number preimage, so the later
      // normal batch must be proven after the document-wide strict prefix.
      transactionEntity({
        id: writeIds[1]!,
        portfolioId,
        assetId: cutoffAssetId,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:01:00.000Z',
      }),
    ]);
    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      legacyDocument,
      FIRST_REHYDRATION_ID,
      'strict prefix before a normal rounding CREATE batch',
    );

    // The public reducer starts from the persisted holding of 1. The raw
    // inputs differ by only five tenths of a nanoshare, so this is a legal
    // normal request even though numeric(20,8) persists its sell one quantum
    // above the two stored buys.
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId,
        side: 'buy',
        quantity: 1.0000000046,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:02:00.000Z',
      },
      {
        assetId,
        side: 'sell',
        quantity: 2.0000000051,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:03:00.000Z',
      },
    ]);

    const resultingDocument = await capturePortfolioDocument(harness, portfolioId);
    const normalRows = quantityEntities(resultingDocument).filter(
      (transaction) => transaction.data.assetId === assetId && transaction.id !== writeIds[0],
    );
    expect(normalRows).toHaveLength(2);
    expect(normalRows.every((transaction) => transaction.id > writeIds[1]!)).toBe(true);
    expect(normalRows.find((transaction) => transaction.data.side === 'sell')?.data.quantity).toBe(
      '2.00000001',
    );

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      resultingDocument,
      SECOND_REHYDRATION_ID,
      'normal rounding CREATE batch seeded from a strict-prefix holding',
    );
  });

  it('rehydrates a later rounding CREATE batch from prior normal repository readback', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const assetId = '018f0000-0b10-7000-8000-000000000b02';
    await seedGlobalAsset(harness, assetId, 'LATER-READBACK-ROUNDING');

    // These are two ordinary legal requests. Their 501 persisted buys establish
    // the holding that the final CREATE call reads back; they are not members of
    // that final two-row request merely because the position never goes flat.
    const earlierBuys = Array.from({ length: 501 }, (_, index) => ({
      assetId,
      side: 'buy' as const,
      quantity: 1,
      price: 10,
      fee: 0,
      executedAt: new Date(Date.parse('2026-07-23T10:00:00.000Z') + index).toISOString(),
    }));
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, earlierBuys.slice(0, 500));
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, earlierBuys.slice(500));

    // The final request begins from the repository-readback holding of 501. Its
    // raw quantities are epsilon-valid, while numeric(20,8) stores the sell a
    // quantum above the resulting 502 stored buys.
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId,
        side: 'buy',
        quantity: 1.0000000046,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:00:01.000Z',
      },
      {
        assetId,
        side: 'sell',
        quantity: 502.0000000051,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:00:02.000Z',
      },
    ]);

    const document = await capturePortfolioDocument(harness, portfolioId);
    expect(quantityEntities(document)).toHaveLength(503);
    expect(
      quantityEntities(document).find((transaction) => transaction.data.side === 'sell')?.data
        .quantity,
    ).toBe('502.00000001');

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      document,
      FIRST_REHYDRATION_ID,
      'later rounding CREATE batch seeded from prior normal repository readback',
    );
    expect(
      await harness.db.select().from(transactions).where(eq(transactions.portfolioId, portfolioId)),
    ).toHaveLength(503);
  });

  it('rejects a multi-quantum normal batch before restore writes when repository replay cannot represent it', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const assetId = '018f0000-0000-7000-8000-000000000110';
    await seedGlobalAsset(harness, assetId, 'ACCUMULATING-ROUNDING');

    // The normal reducer sees the total buys and sell as equal. PostgreSQL
    // persists the buys at 1.00000000 and the sell at 4.00000002. The existing
    // tax replay intentionally handles only its one-quantum storage seam, so
    // rehydration must reject this wider candidate before restore writes begin.
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId,
        side: 'buy',
        quantity: 1.0000000049,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:00:00.000Z',
      },
      {
        assetId,
        side: 'buy',
        quantity: 1.0000000049,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:01:00.000Z',
      },
      {
        assetId,
        side: 'buy',
        quantity: 1.0000000049,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:02:00.000Z',
      },
      {
        assetId,
        side: 'buy',
        quantity: 1.0000000049,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:03:00.000Z',
      },
      {
        assetId,
        side: 'sell',
        quantity: 4.0000000196,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:04:00.000Z',
      },
    ]);

    const persisted = await harness.db
      .select({
        side: transactions.side,
        quantity: transactions.quantity,
      })
      .from(transactions)
      .where(eq(transactions.portfolioId, portfolioId));
    const persistedBuys = persisted.filter((transaction) => transaction.side === 'buy');
    expect(persistedBuys).toHaveLength(4);
    expect(persistedBuys.every((transaction) => transaction.quantity === '1.00000000')).toBe(true);
    const persistedSell = persisted.find((transaction) => transaction.side === 'sell');
    expect(persistedSell).toMatchObject({
      side: 'sell',
      quantity: '4.00000002',
    });

    const document = await capturePortfolioDocument(harness, portfolioId);
    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    try {
      await expect(
        createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
          rehydrationId: FIRST_REHYDRATION_ID,
          document,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CASH_LEDGER',
        message: expect.stringContaining('cannot replay from repository readback'),
      });
      expect(mutationTransaction).not.toHaveBeenCalled();
      expect(await harness.db.select().from(transactions)).toEqual([]);
    } finally {
      mutationTransaction.mockRestore();
    }
  });

  it('rejects an apparent oversell whose favorable inputs cannot fit one normal batch', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const assetId = '018f0000-0000-7000-8000-000000000111';
    await seedGlobalAsset(harness, assetId, 'BATCH-BOUNDARY');

    // Every buy can use its favorable public-number edge, and the sell can use
    // its favorable lower edge, so an unlimited all-raw replay would accept
    // this state. The public endpoint permits at most 500 rows per batch,
    // though: with 501 buys, every legal recording sequence has at least two
    // repository-readback quantities when the sale is admitted.
    const writeIds = ['018f0000-0600-7000-8000-000000000601'];
    for (let index = 1; index <= 501; index += 1) {
      writeIds.push(nextUuidV7WriteId(writeIds[index - 1]!));
    }
    const firstExecutedAt = Date.parse('2026-07-23T10:00:00.000Z');
    const document = strictDocument([
      portfolioEntity(user.id, portfolioId),
      ...writeIds.slice(0, 501).map((id, index) =>
        transactionEntity({
          id,
          portfolioId,
          assetId,
          side: 'buy',
          quantity: '1.00000000',
          executedAt: new Date(firstExecutedAt + index).toISOString(),
        }),
      ),
      transactionEntity({
        id: writeIds[501]!,
        portfolioId,
        assetId,
        side: 'sell',
        quantity: '501.00000251',
        executedAt: new Date(firstExecutedAt + 501).toISOString(),
      }),
    ]);
    const persistedSell = quantityEntities(document).find(
      (transaction) => transaction.data.side === 'sell',
    );
    if (!persistedSell) throw new Error('expected batch-boundary sell');
    expect(writeIds).toEqual([...writeIds].sort());

    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    try {
      await expect(
        createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
          rehydrationId: FIRST_REHYDRATION_ID,
          document,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CASH_LEDGER',
        message: expect.stringContaining(quantityField(persistedSell)),
      });
      expect(mutationTransaction).not.toHaveBeenCalled();
      expect(await harness.db.select().from(transactions)).toEqual([]);
    } finally {
      mutationTransaction.mockRestore();
    }
  });

  it('rejects inverse-backdated funding outside the bounded CREATE witness before restore writes', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const assetId = '018f0000-0610-7000-8000-000000000611';
    const fillerAssetId = '018f0000-0610-7000-8000-000000000612';
    const fillerCount = 501;
    await seedGlobalAsset(harness, assetId, 'INVERSE-BACKDATED-FUNDING');
    await seedGlobalAsset(harness, fillerAssetId, 'INVERSE-BACKDATED-FILLER');

    const writeIds = ['018f0000-0610-7000-8000-000000000613'];
    for (let index = 1; index < fillerCount + 3; index += 1) {
      writeIds.push(nextUuidV7WriteId(writeIds[index - 1]!));
    }
    const firstExecutedAt = Date.parse('2026-07-23T10:00:01.000Z');
    const impossibleSell = transactionEntity({
      id: writeIds[1]!,
      portfolioId,
      assetId,
      side: 'sell',
      quantity: '101.00000001',
      executedAt: '2026-07-23T10:00:02.000Z',
    });
    const document = strictDocument([
      portfolioEntity(user.id, portfolioId),
      transactionEntity({
        id: writeIds[0]!,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '1.00000000',
        executedAt: '2026-07-23T10:00:01.000Z',
      }),
      impossibleSell,
      ...writeIds.slice(2, -1).map((id, index) =>
        transactionEntity({
          id,
          portfolioId,
          assetId: fillerAssetId,
          side: 'buy',
          quantity: '1.00000000',
          executedAt: new Date(firstExecutedAt + index + 2_000).toISOString(),
        }),
      ),
      // This buy is written only after the sell and more than 500 intervening
      // rows, but its backdated execution time makes chronological replay visit
      // it first. It cannot fund the earlier sell in any legal CREATE request.
      transactionEntity({
        id: writeIds.at(-1)!,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '100.00000000',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
    ]);
    expect(writeIds).toEqual([...writeIds].sort());
    expect(writeIds).toHaveLength(fillerCount + 3);

    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    try {
      await expect(
        createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
          rehydrationId: FIRST_REHYDRATION_ID,
          document,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CASH_LEDGER',
        message: expect.stringContaining(quantityField(impossibleSell)),
      });
      expect(mutationTransaction).not.toHaveBeenCalled();
      expect(await harness.db.select().from(transactions)).toEqual([]);
    } finally {
      mutationTransaction.mockRestore();
    }
  });

  it('rejects cross-asset rounding windows that cannot share one legal create partition', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const assetAId = '018f0000-0000-7000-8000-000000000112';
    const assetBId = '018f0000-0000-7000-8000-000000000113';
    const fillerAssetId = '018f0000-0000-7000-8000-000000000114';
    await seedGlobalAsset(harness, assetAId, 'PARTITION-A');
    await seedGlobalAsset(harness, assetBId, 'PARTITION-B');
    await seedGlobalAsset(harness, fillerAssetId, 'PARTITION-FILLER');

    // A needs the raw-input span 0..499, while B needs 1..500. Both pairs
    // separately fit a 500-row CREATE witness, but no partition can keep both
    // pairs in legal calls: either A's or B's sell sees its buy after database
    // readback at 1.00000000.
    const writeIds = ['018f0000-0700-7000-8000-000000000701'];
    for (let index = 1; index <= 500; index += 1) {
      writeIds.push(nextUuidV7WriteId(writeIds[index - 1]!));
    }
    const firstExecutedAt = Date.parse('2026-07-23T10:00:00.000Z');
    const aSell = transactionEntity({
      id: writeIds[499]!,
      portfolioId,
      assetId: assetAId,
      side: 'sell',
      quantity: '1.00000001',
      executedAt: new Date(firstExecutedAt + 499).toISOString(),
    });
    const document = strictDocument([
      portfolioEntity(user.id, portfolioId),
      transactionEntity({
        id: writeIds[0]!,
        portfolioId,
        assetId: assetAId,
        side: 'buy',
        quantity: '1.00000000',
        executedAt: new Date(firstExecutedAt).toISOString(),
      }),
      transactionEntity({
        id: writeIds[1]!,
        portfolioId,
        assetId: assetBId,
        side: 'buy',
        quantity: '1.00000000',
        executedAt: new Date(firstExecutedAt + 1).toISOString(),
      }),
      ...writeIds.slice(2, 499).map((id, index) =>
        transactionEntity({
          id,
          portfolioId,
          assetId: fillerAssetId,
          side: 'buy',
          quantity: '1.00000000',
          executedAt: new Date(firstExecutedAt + index + 2).toISOString(),
        }),
      ),
      aSell,
      transactionEntity({
        id: writeIds[500]!,
        portfolioId,
        assetId: assetBId,
        side: 'sell',
        quantity: '1.00000001',
        executedAt: new Date(firstExecutedAt + 500).toISOString(),
      }),
    ]);
    expect(writeIds).toEqual([...writeIds].sort());

    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    try {
      await expect(
        createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
          rehydrationId: FIRST_REHYDRATION_ID,
          document,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CASH_LEDGER',
        message: expect.stringContaining(quantityField(aSell)),
      });
      expect(mutationTransaction).not.toHaveBeenCalled();
      expect(await harness.db.select().from(transactions)).toEqual([]);
    } finally {
      mutationTransaction.mockRestore();
    }
  });

  it('keeps the normal-readback tax basis for an exact legacy prefix and later sale', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    await seedGlobalAsset(harness, LEGACY_ASSET_ID, 'LEGACY');

    const legacyDocument = strictDocument([
      portfolioEntity(user.id, LEGACY_PORTFOLIO_ID),
      cashSourceEntity(LEGACY_CASH_SOURCE_ID, LEGACY_PORTFOLIO_ID),
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

    await harness.ctx.tax.updateSettings(user.id, { mode: 'country_specific', country: 'AT' });
    const [mainCashSource] = await harness.db
      .select()
      .from(portfolioCashSources)
      .where(eq(portfolioCashSources.portfolioId, LEGACY_PORTFOLIO_ID));
    if (!mainCashSource) throw new Error('expected legacy Main cash source');

    await harness.ctx.portfolio.createTransactions(user.id, LEGACY_PORTFOLIO_ID, [
      {
        assetId: LEGACY_ASSET_ID,
        side: 'sell',
        quantity: legacyBuy.quantity,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:01:00.000Z',
        cashSourceId: mainCashSource.id,
        addProceedsToCash: true,
      },
    ]);

    const persisted = await harness.db
      .select({ id: transactions.id, side: transactions.side, quantity: transactions.quantity })
      .from(transactions)
      .where(eq(transactions.portfolioId, LEGACY_PORTFOLIO_ID));
    expect(
      persisted
        .map((transaction) => ({ side: transaction.side, quantity: transaction.quantity }))
        .sort((left, right) => left.side.localeCompare(right.side)),
    ).toEqual([
      { side: 'buy', quantity: '90071992547.12345678' },
      { side: 'sell', quantity: '90071992547.12346000' },
    ]);

    const normalSell = persisted.find((transaction) => transaction.side === 'sell');
    if (!normalSell) throw new Error('expected normal sale');
    const [normalTaxedSell] = await harness.db
      .select({
        id: transactions.id,
        taxMode: transactions.taxMode,
        taxCountry: transactions.taxCountry,
        taxAmountEur: transactions.taxAmountEur,
      })
      .from(transactions)
      .where(eq(transactions.id, normalSell.id));
    expect(normalTaxedSell).toMatchObject({ taxMode: 'country_specific', taxCountry: 'AT' });
    expect(normalTaxedSell?.taxAmountEur).not.toBeNull();

    const beforeReport = await harness.ctx.tax.getYearReport(user.id, LEGACY_PORTFOLIO_ID, 2026);
    const beforeMovements = await harness.db
      .select({
        id: portfolioCashMovements.id,
        kind: portfolioCashMovements.kind,
        amountEur: portfolioCashMovements.amountEur,
        transactionId: portfolioCashMovements.transactionId,
        taxYear: portfolioCashMovements.taxYear,
      })
      .from(portfolioCashMovements)
      .where(eq(portfolioCashMovements.portfolioId, LEGACY_PORTFOLIO_ID));

    const resultingDocument = await capturePortfolioDocument(harness, LEGACY_PORTFOLIO_ID);
    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      resultingDocument,
      SECOND_REHYDRATION_ID,
      'composed legacy/readback lifecycle',
    );

    expect(await harness.ctx.tax.getYearReport(user.id, LEGACY_PORTFOLIO_ID, 2026)).toEqual(
      beforeReport,
    );
    const afterMovements = await harness.db
      .select({
        id: portfolioCashMovements.id,
        kind: portfolioCashMovements.kind,
        amountEur: portfolioCashMovements.amountEur,
        transactionId: portfolioCashMovements.transactionId,
        taxYear: portfolioCashMovements.taxYear,
      })
      .from(portfolioCashMovements)
      .where(eq(portfolioCashMovements.portfolioId, LEGACY_PORTFOLIO_ID));
    expect(afterMovements.sort((left, right) => left.id.localeCompare(right.id))).toEqual(
      beforeMovements.sort((left, right) => left.id.localeCompare(right.id)),
    );
  });

  it('keeps a composed legacy sale reachable after 501 later same-asset buys', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = '018f0000-0200-7000-8000-000000000301';
    const assetId = '018f0000-0200-7000-8000-000000000302';
    const legacyBuyId = '018f0000-0200-7000-8000-000000000303';
    await seedGlobalAsset(harness, assetId, 'COMPOSED-LATER-HISTORY');

    const legacyDocument = strictDocument([
      portfolioEntity(user.id, portfolioId),
      transactionEntity({
        id: legacyBuyId,
        portfolioId,
        assetId,
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
      'legacy prefix before later same-asset history',
    );

    const transactionRepo = createTransactionRepository(harness.db);
    const [legacyBuy] = await transactionRepo.listForAsset(portfolioId, assetId);
    if (!legacyBuy) throw new Error('expected legacy transaction readback');
    expect(legacyBuy.quantity).toBe(90071992547.12346);

    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId,
        side: 'sell',
        quantity: legacyBuy.quantity,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:01:00.000Z',
      },
    ]);

    const laterBuys = Array.from({ length: 501 }, (_, index) => ({
      assetId,
      side: 'buy' as const,
      quantity: 1,
      price: 10,
      fee: 0,
      executedAt: new Date(Date.parse('2026-07-23T10:02:00.000Z') + index).toISOString(),
    }));
    // These are two legal public requests. Their rows are persisted and read
    // back before the next request; they are not part of the earlier sale's
    // raw-input witness merely because they share its asset.
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, laterBuys.slice(0, 500));
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, laterBuys.slice(500));

    const resultingDocument = await capturePortfolioDocument(harness, portfolioId);
    expect(quantityEntities(resultingDocument)).toHaveLength(503);

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      resultingDocument,
      SECOND_REHYDRATION_ID,
      'composed lifecycle followed by legal 500-plus-1 requests',
    );
    expect(
      await harness.db.select().from(transactions).where(eq(transactions.portfolioId, portfolioId)),
    ).toHaveLength(503);
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

  it('accepts a normal update of a pre-transition row without moving its UUID past the legacy cutoff', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = '018f0000-0300-7000-8000-000000000401';
    const assetId = '018f0000-0300-7000-8000-000000000402';
    await seedGlobalAsset(harness, assetId, 'PATCHED-LEGACY');

    const writeIds = ['018f0000-0300-7000-8000-000000000403'];
    writeIds.push(nextUuidV7WriteId(writeIds[0]!));
    writeIds.push(nextUuidV7WriteId(writeIds[1]!));

    // This is a solvent exact strict-v1 history. The last buy has no public
    // number preimage, so the second rehydration must place the UUID cutoff
    // after it even though the older sell is subsequently patched in normal
    // mode.
    const legacyDocument = strictDocument([
      portfolioEntity(user.id, portfolioId),
      transactionEntity({
        id: writeIds[0]!,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
      transactionEntity({
        id: writeIds[1]!,
        portfolioId,
        assetId,
        side: 'sell',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:01:00.000Z',
      }),
      transactionEntity({
        id: writeIds[2]!,
        portfolioId,
        assetId,
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
      'initial exact history before normal update',
    );

    const transactionRepo = createTransactionRepository(harness.db);
    const legacyRows = await transactionRepo.listForAsset(portfolioId, assetId);
    const legacySell = legacyRows.find((transaction) => transaction.id === writeIds[1]);
    if (!legacySell) throw new Error('expected pre-transition legacy sell');
    expect(legacySell.quantity).toBe(90071992547.12346);

    // Exercise the real normal PATCH path. It retains the old UUID but writes
    // the repository-readback number as numeric(20,8).
    await harness.ctx.portfolio.updateTransaction(user.id, portfolioId, legacySell.id, {
      quantity: legacySell.quantity,
    });
    const [patchedSell] = await harness.db
      .select({ id: transactions.id, quantity: transactions.quantity })
      .from(transactions)
      .where(eq(transactions.id, legacySell.id));
    expect(patchedSell).toEqual({ id: legacySell.id, quantity: '90071992547.12346000' });

    const resultingDocument = await capturePortfolioDocument(harness, portfolioId);
    const revisedSell = quantityEntities(resultingDocument).find(
      (transaction) => transaction.id === legacySell.id,
    );
    if (!revisedSell) throw new Error('expected patched sell in the strict document');
    // Vault metadata is the only durable per-entity edit signal: rev bumps on
    // every edit, including a normal-mode PATCH that keeps its original UUID.
    revisedSell.rev = 1;
    revisedSell.editedAt = '2026-07-25T10:00:00.000Z';
    expect(revisedSell.id < writeIds[2]!).toBe(true);

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      resultingDocument,
      SECOND_REHYDRATION_ID,
      'normal update of a pre-transition row',
    );
  });

  it('keeps a solvent exact prefix after sequential quantity and metadata edits', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = '018f0000-0a00-7000-8000-000000000a01';
    const assetId = '018f0000-0a00-7000-8000-000000000a02';
    const cutoffAssetId = '018f0000-0a00-7000-8000-000000000a03';
    const roundingAssetId = '018f0000-0a00-7000-8000-000000000a04';
    await seedGlobalAsset(harness, assetId, 'SEQUENTIAL-PATCHES');
    await seedGlobalAsset(harness, cutoffAssetId, 'SEQUENTIAL-PATCHES-CUTOFF');
    await seedGlobalAsset(harness, roundingAssetId, 'SEQUENTIAL-PATCHES-ROUNDING');

    const writeIds = ['018f0000-0a00-7000-8000-000000000a05'];
    writeIds.push(nextUuidV7WriteId(writeIds[0]!));
    writeIds.push(nextUuidV7WriteId(writeIds[1]!));
    writeIds.push(nextUuidV7WriteId(writeIds[2]!));
    const legacyDocument = strictDocument([
      portfolioEntity(user.id, portfolioId),
      transactionEntity({
        id: writeIds[0]!,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '1.00000000',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
      transactionEntity({
        id: writeIds[1]!,
        portfolioId,
        assetId,
        side: 'sell',
        quantity: '1.00000000',
        executedAt: '2026-07-23T10:01:00.000Z',
      }),
      transactionEntity({
        id: writeIds[2]!,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '3.00000000',
        executedAt: '2026-07-23T10:02:00.000Z',
      }),
      // This later exact row has no public-number preimage, fixing the final
      // document's strict-v1 cutoff after every edited row above.
      transactionEntity({
        id: writeIds[3]!,
        portfolioId,
        assetId: cutoffAssetId,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:03:00.000Z',
      }),
    ]);
    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      legacyDocument,
      FIRST_REHYDRATION_ID,
      'initial exact history before sequential edits',
    );

    const transactionRepo = createTransactionRepository(harness.db);
    const legacyRows = await transactionRepo.listForAsset(portfolioId, assetId);
    const legacyBuy = legacyRows.find((transaction) => transaction.id === writeIds[0]);
    const legacySell = legacyRows.find((transaction) => transaction.id === writeIds[1]);
    const metadataBuy = legacyRows.find((transaction) => transaction.id === writeIds[2]);
    if (!legacyBuy || !legacySell || !metadataBuy) {
      throw new Error('expected all pre-transition edit fixtures');
    }

    // Exercise the unchanged update oracle one PATCH at a time. The
    // intermediate 2-buy / 1-sell state is solvent before the sell is patched.
    await harness.ctx.portfolio.updateTransaction(user.id, portfolioId, legacyBuy.id, {
      quantity: 2,
    });
    const afterBuyPatch = await transactionRepo.listForAsset(portfolioId, assetId);
    expect(afterBuyPatch.find((transaction) => transaction.id === legacyBuy.id)?.quantity).toBe(2);
    expect(afterBuyPatch.find((transaction) => transaction.id === legacySell.id)?.quantity).toBe(1);

    await harness.ctx.portfolio.updateTransaction(user.id, portfolioId, legacySell.id, {
      quantity: 2,
    });
    // This edit bumps strict-vault revision metadata without changing quantity.
    await harness.ctx.portfolio.updateTransaction(user.id, portfolioId, metadataBuy.id, {
      note: 'metadata-only edit',
    });
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId: roundingAssetId,
        side: 'buy',
        quantity: 1.0000000046,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:04:00.000Z',
      },
      {
        assetId: roundingAssetId,
        side: 'sell',
        quantity: 1.0000000051,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:05:00.000Z',
      },
    ]);

    const resultingDocument = await capturePortfolioDocument(harness, portfolioId);
    const resultingTransactions = quantityEntities(resultingDocument);
    const revisedBuy = resultingTransactions.find((transaction) => transaction.id === legacyBuy.id);
    const revisedSell = resultingTransactions.find(
      (transaction) => transaction.id === legacySell.id,
    );
    const metadataRevision = resultingTransactions.find(
      (transaction) => transaction.id === metadataBuy.id,
    );
    if (!revisedBuy || !revisedSell || !metadataRevision) {
      throw new Error('expected all edited rows in the strict document');
    }
    revisedBuy.rev = 1;
    revisedSell.rev = 1;
    metadataRevision.rev = 1;
    revisedBuy.editedAt = '2026-07-25T10:00:00.000Z';
    revisedSell.editedAt = '2026-07-25T10:01:00.000Z';
    metadataRevision.editedAt = '2026-07-25T10:02:00.000Z';

    expect(revisedBuy.data.quantity).toBe('2.00000000');
    expect(revisedSell.data.quantity).toBe('2.00000000');
    expect(metadataRevision.data).toMatchObject({
      quantity: '3.00000000',
      note: 'metadata-only edit',
    });
    const roundingSell = resultingTransactions.find(
      (transaction) =>
        transaction.data.assetId === roundingAssetId && transaction.data.side === 'sell',
    );
    if (!roundingSell) throw new Error('expected appended rounding sell');
    expect(roundingSell.data.quantity).toBe('1.00000001');
    expect(roundingSell.id > writeIds[3]!).toBe(true);

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      resultingDocument,
      SECOND_REHYDRATION_ID,
      'solvent exact prefix after sequential quantity and metadata edits',
    );
  });

  it('composes a pre-transition normal PATCH before a later rounding CREATE batch', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = '018f0000-0900-7000-8000-000000000901';
    const assetId = '018f0000-0900-7000-8000-000000000902';
    const cutoffAssetId = '018f0000-0900-7000-8000-000000000903';
    await seedGlobalAsset(harness, assetId, 'PATCH-BEFORE-CREATE');
    await seedGlobalAsset(harness, cutoffAssetId, 'PATCH-BEFORE-CREATE-CUTOFF');

    const writeIds = ['018f0000-0900-7000-8000-000000000904'];
    writeIds.push(nextUuidV7WriteId(writeIds[0]!));
    writeIds.push(nextUuidV7WriteId(writeIds[1]!));
    const legacyDocument = strictDocument([
      portfolioEntity(user.id, portfolioId),
      transactionEntity({
        id: writeIds[0]!,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
      transactionEntity({
        id: writeIds[1]!,
        portfolioId,
        assetId,
        side: 'sell',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:01:00.000Z',
      }),
      // This unrelated exact legacy row has no public-number preimage, so the
      // final document must model the earlier sell as a pre-cutoff PATCH.
      transactionEntity({
        id: writeIds[2]!,
        portfolioId,
        assetId: cutoffAssetId,
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
      'initial exact history before PATCH and CREATE operations',
    );

    const transactionRepo = createTransactionRepository(harness.db);
    const legacyRows = await transactionRepo.listForAsset(portfolioId, assetId);
    const legacySell = legacyRows.find((transaction) => transaction.id === writeIds[1]);
    if (!legacySell) throw new Error('expected pre-transition legacy sell');
    expect(legacySell.quantity).toBe(90071992547.12346);

    // This real PATCH runs while the original exact buy/sell are the only rows
    // for the asset. It remains valid because both values read back as the same
    // public number.
    await harness.ctx.portfolio.updateTransaction(user.id, portfolioId, legacySell.id, {
      quantity: legacySell.quantity,
    });
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId,
        side: 'buy',
        quantity: 1.0000000046,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:03:00.000Z',
      },
      {
        assetId,
        side: 'sell',
        quantity: 1.0000000051,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:04:00.000Z',
      },
    ]);

    const resultingDocument = await capturePortfolioDocument(harness, portfolioId);
    const revisedSell = quantityEntities(resultingDocument).find(
      (transaction) => transaction.id === legacySell.id,
    );
    if (!revisedSell) throw new Error('expected patched sell in the strict document');
    revisedSell.rev = 1;
    revisedSell.editedAt = '2026-07-25T10:00:00.000Z';
    expect(revisedSell.data.quantity).toBe('90071992547.12346000');
    expect(
      quantityEntities(resultingDocument).some(
        (transaction) =>
          transaction.data.side === 'sell' && transaction.data.quantity === '1.00000001',
      ),
    ).toBe(true);

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      resultingDocument,
      SECOND_REHYDRATION_ID,
      'PATCH before later normal rounding batch',
    );
  });

  it('rejects multiple revised pre-cutoff rows that only pass as simultaneous raw inputs', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = '018f0000-0400-7000-8000-000000000501';
    const assetId = '018f0000-0400-7000-8000-000000000502';
    await seedGlobalAsset(harness, assetId, 'SEQUENTIAL-PATCH');

    const writeIds = ['018f0000-0400-7000-8000-000000000503'];
    writeIds.push(nextUuidV7WriteId(writeIds[0]!));
    writeIds.push(nextUuidV7WriteId(writeIds[1]!));
    const revisedBuy = transactionEntity({
      id: writeIds[0]!,
      portfolioId,
      assetId,
      side: 'buy',
      quantity: '1.00000000',
      executedAt: '2026-07-23T10:00:00.000Z',
    });
    const revisedSell = transactionEntity({
      id: writeIds[1]!,
      portfolioId,
      assetId,
      side: 'sell',
      quantity: '1.00000001',
      executedAt: '2026-07-23T10:01:00.000Z',
    });
    revisedBuy.rev = 1;
    revisedSell.rev = 1;
    const document = strictDocument([
      portfolioEntity(user.id, portfolioId),
      revisedBuy,
      revisedSell,
      // This later exact quantity has no public-number preimage, fixing the
      // one document-level legacy cutoff after both revised rows.
      transactionEntity({
        id: writeIds[2]!,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:02:00.000Z',
      }),
    ]);

    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    try {
      await expect(
        createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
          rehydrationId: FIRST_REHYDRATION_ID,
          document,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CASH_LEDGER',
        message: expect.stringContaining(quantityField(revisedSell)),
      });
      expect(mutationTransaction).not.toHaveBeenCalled();
      expect(
        await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
      ).toEqual([]);
      expect(await harness.db.select().from(transactions)).toEqual([]);
    } finally {
      mutationTransaction.mockRestore();
    }
  });

  it('rejects a later unexplainable exact-prefix deficit in the same asset group before restore writes', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = '018f0000-0e00-7000-8000-000000000e01';
    const assetId = '018f0000-0e00-7000-8000-000000000e02';
    await seedGlobalAsset(harness, assetId, 'PREFIX-SAME-GROUP-DEFICITS');

    const writeIds = ['018f0000-0e00-7000-8000-000000000e03'];
    for (let index = 1; index < 5; index += 1) {
      writeIds.push(nextUuidV7WriteId(writeIds[index - 1]!));
    }
    const patchSell = transactionEntity({
      id: writeIds[1]!,
      portfolioId,
      assetId,
      side: 'sell',
      quantity: '999999999999.00000000',
      executedAt: '2026-07-23T10:01:00.000Z',
    });
    // This first deficit has the one permitted inferred PATCH witness: its
    // surrounding quantities both read back as 999999999999 in normal mode.
    patchSell.rev = 1;
    const invalidSell = transactionEntity({
      id: writeIds[3]!,
      portfolioId,
      assetId,
      side: 'sell',
      quantity: '999999999999.00000000',
      executedAt: '2026-07-23T10:03:00.000Z',
    });
    const document = strictDocument([
      portfolioEntity(user.id, portfolioId),
      transactionEntity({
        id: writeIds[0]!,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '999999999998.99999999',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
      patchSell,
      transactionEntity({
        id: writeIds[2]!,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '999999999998.99995000',
        executedAt: '2026-07-23T10:02:00.000Z',
      }),
      invalidSell,
      // This no-preimage row fixes the one global strict-v1 cutoff after both
      // deficits. The later unrevised sell must not be hidden by the first
      // row's valid singleton PATCH witness.
      transactionEntity({
        id: writeIds[4]!,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:04:00.000Z',
      }),
    ]);

    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    try {
      await expect(
        createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
          rehydrationId: FIRST_REHYDRATION_ID,
          document,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CASH_LEDGER',
        message: expect.stringContaining(quantityField(invalidSell)),
      });
      expect(mutationTransaction).not.toHaveBeenCalled();
      expect(
        await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
      ).toEqual([]);
      expect(await harness.db.select().from(transactions)).toEqual([]);
    } finally {
      mutationTransaction.mockRestore();
    }
  });

  it('validates many singleton exact-prefix PATCH witnesses in a fixed streaming pass', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = '018f0000-0f00-7000-8000-000000000f01';
    const assetId = '018f0000-0f00-7000-8000-000000000f02';
    const cutoffAssetId = '018f0000-0f00-7000-8000-000000000f03';
    const pairCount = 64;
    await seedGlobalAsset(harness, assetId, 'PREFIX-STREAMING-PATCH');
    await seedGlobalAsset(harness, cutoffAssetId, 'PREFIX-STREAMING-CUTOFF');

    const writeIds = ['018f0000-0f00-7000-8000-000000000f04'];
    for (let index = 1; index < pairCount * 2 + 1; index += 1) {
      writeIds.push(nextUuidV7WriteId(writeIds[index - 1]!));
    }
    const entities: StrictEntity[] = [portfolioEntity(user.id, portfolioId)];
    for (let index = 0; index < pairCount; index += 1) {
      const buyAt = new Date(Date.parse('2026-07-23T10:00:00.000Z') + index * 2_000).toISOString();
      const sellAt = new Date(Date.parse(buyAt) + 1_000).toISOString();
      entities.push(
        transactionEntity({
          id: writeIds[index * 2]!,
          portfolioId,
          assetId,
          side: 'buy',
          quantity: '999999999998.99999999',
          executedAt: buyAt,
        }),
      );
      const revisedSell = transactionEntity({
        id: writeIds[index * 2 + 1]!,
        portfolioId,
        assetId,
        side: 'sell',
        quantity: '999999999999.00000000',
        executedAt: sellAt,
      });
      // Each persisted pair has a one-quantum exact deficit, but both values
      // read back as the same public number. It is therefore independently
      // reachable as one normal PATCH, never as a cooperative raw batch.
      revisedSell.rev = 1;
      entities.push(revisedSell);
    }
    entities.push(
      // This later no-preimage row fixes the document-wide strict prefix after
      // every pair, so every revised sell must receive its own PATCH witness.
      transactionEntity({
        id: writeIds[pairCount * 2]!,
        portfolioId,
        assetId: cutoffAssetId,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:03:00.000Z',
      }),
    );
    const document = strictDocument(entities);
    expect(quantityEntities(document)).toHaveLength(pairCount * 2 + 1);

    await replaceNormalRowsWithServerVault(harness, user.id);
    const orderTraces: Array<{
      transactionRows: number;
      writeOrderKeyPasses: number;
      replayTimelineKeyPasses: number;
      prefixRevisionRows: number;
      prefixRevisionWitnesses: number;
    }> = [];
    await createParanoidRehydrationService({
      db: harness.db,
      testOnlyObserveQuantityReachabilityOrder(trace) {
        orderTraces.push(trace);
      },
    }).rehydrate(user.id, {
      rehydrationId: FIRST_REHYDRATION_ID,
      document,
    });

    // This is structural rather than timing-based: every prefix row gets one
    // forward witness visit even though all 64 revised sells need validation.
    expect(orderTraces).toEqual([
      {
        transactionRows: pairCount * 2 + 1,
        writeOrderKeyPasses: 32,
        replayTimelineKeyPasses: 49,
        prefixRevisionRows: pairCount * 2 + 1,
        prefixRevisionWitnesses: pairCount,
      },
    ]);
    expect(
      await harness.db.select().from(transactions).where(eq(transactions.portfolioId, portfolioId)),
    ).toHaveLength(pairCount * 2 + 1);
  });

  it('rejects every unexplainable exact-prefix deficit before restore writes', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = '018f0000-0d00-7000-8000-000000000d01';
    const patchAssetId = '018f0000-0d00-7000-8000-000000000d02';
    const invalidAssetId = '018f0000-0d00-7000-8000-000000000d03';
    const cutoffAssetId = '018f0000-0d00-7000-8000-000000000d04';
    await seedGlobalAsset(harness, patchAssetId, 'PREFIX-PATCH-WITNESS');
    await seedGlobalAsset(harness, invalidAssetId, 'PREFIX-INVALID-GROUP');
    await seedGlobalAsset(harness, cutoffAssetId, 'PREFIX-INVALID-CUTOFF');

    const writeIds = ['018f0000-0d00-7000-8000-000000000d05'];
    for (let index = 1; index < 5; index += 1) {
      writeIds.push(nextUuidV7WriteId(writeIds[index - 1]!));
    }
    const patchSell = transactionEntity({
      id: writeIds[1]!,
      portfolioId,
      assetId: patchAssetId,
      side: 'sell',
      quantity: '999999999999.00000000',
      executedAt: '2026-07-23T10:01:00.000Z',
    });
    // This first group has the one legal inferred PATCH witness: both rows
    // read back as 999999999999 through the normal repository seam.
    patchSell.rev = 1;
    const invalidSell = transactionEntity({
      id: writeIds[3]!,
      portfolioId,
      assetId: invalidAssetId,
      side: 'sell',
      quantity: '999999999999.00000000',
      executedAt: '2026-07-23T10:01:00.000Z',
    });
    const document = strictDocument([
      portfolioEntity(user.id, portfolioId),
      transactionEntity({
        id: writeIds[0]!,
        portfolioId,
        assetId: patchAssetId,
        side: 'buy',
        quantity: '999999999998.99999999',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
      patchSell,
      transactionEntity({
        id: writeIds[2]!,
        portfolioId,
        assetId: invalidAssetId,
        side: 'buy',
        quantity: '999999999998.99995000',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
      invalidSell,
      // The later exact row fixes one document-wide strict prefix after both
      // groups, so neither deficit can be treated as a new normal CREATE.
      transactionEntity({
        id: writeIds[4]!,
        portfolioId,
        assetId: cutoffAssetId,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:02:00.000Z',
      }),
    ]);

    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    try {
      await expect(
        createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
          rehydrationId: FIRST_REHYDRATION_ID,
          document,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CASH_LEDGER',
        message: expect.stringContaining(quantityField(invalidSell)),
      });
      expect(mutationTransaction).not.toHaveBeenCalled();
      expect(
        await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
      ).toEqual([]);
      expect(await harness.db.select().from(transactions)).toEqual([]);
    } finally {
      mutationTransaction.mockRestore();
    }
  });

  it('rejects a revised row that the normal tax guard makes financially immutable', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const assetId = '018f0000-0000-7000-8000-000000000115';
    const unrelatedAssetId = '018f0000-0000-7000-8000-000000000116';
    await seedGlobalAsset(harness, assetId, 'IMMUTABLE-PATCH');
    await seedGlobalAsset(harness, unrelatedAssetId, 'IMMUTABLE-PATCH-CUTOFF');

    const writeIds = ['018f0000-0800-7000-8000-000000000801'];
    writeIds.push(nextUuidV7WriteId(writeIds[0]!));
    writeIds.push(nextUuidV7WriteId(writeIds[1]!));
    const revisedSell = transactionEntity({
      id: writeIds[1]!,
      portfolioId,
      assetId,
      side: 'sell',
      quantity: '999999999999.00000000',
      executedAt: '2026-07-23T10:01:00.000Z',
    });
    // The rows have equal Number(numeric) readbacks, but this is not a legal
    // normal PATCH: manual-per-trade rows are financially frozen by the public
    // update guard. The later exact row fixes the document cutoff after it.
    revisedSell.rev = 1;
    revisedSell.data.taxMode = 'manual_per_trade';
    const document = strictDocument([
      portfolioEntity(user.id, portfolioId),
      transactionEntity({
        id: writeIds[0]!,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '999999999998.99999999',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
      revisedSell,
      transactionEntity({
        id: writeIds[2]!,
        portfolioId,
        assetId: unrelatedAssetId,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:02:00.000Z',
      }),
    ]);

    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    try {
      await expect(
        createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
          rehydrationId: FIRST_REHYDRATION_ID,
          document,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CASH_LEDGER',
        message: expect.stringContaining(quantityField(revisedSell)),
      });
      expect(mutationTransaction).not.toHaveBeenCalled();
      expect(
        await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
      ).toEqual([]);
      expect(await harness.db.select().from(transactions)).toEqual([]);
    } finally {
      mutationTransaction.mockRestore();
    }
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
    const highMagnitudeSellId = nextUuidV7WriteId(normalBuy.id);
    expect(highMagnitudeSellId > normalBuy.id).toBe(true);
    highMagnitudeDocument.entities.push(
      transactionEntity({
        id: highMagnitudeSellId,
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
            id: highMagnitudeSellId,
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

  it('rejects interleaved asset provenance when no single document write cutoff can explain it', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const assetAId = '018f0000-0000-7000-8000-000000000109';
    const assetBId = '018f0000-0000-7000-8000-00000000010a';
    await seedGlobalAsset(harness, assetAId, 'INTERLEAVED-A');
    await seedGlobalAsset(harness, assetBId, 'INTERLEAVED-B');

    const writeIds = ['018f0000-0100-7000-8000-000000000201'];
    for (let index = 1; index < 5; index += 1) {
      writeIds.push(nextUuidV7WriteId(writeIds[index - 1]!));
    }
    expect(writeIds).toEqual([...writeIds].sort());

    const document = strictDocument([
      portfolioEntity(user.id, portfolioId),
      // A's first legacy buy.
      transactionEntity({
        id: writeIds[0]!,
        portfolioId,
        assetId: assetAId,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
      // B's legacy buy, then an unrevised readback-shaped sale. Its UUID and
      // rev=0 mean it cannot pose as a later in-place normal PATCH.
      transactionEntity({
        id: writeIds[1]!,
        portfolioId,
        assetId: assetBId,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
      transactionEntity({
        id: writeIds[2]!,
        portfolioId,
        assetId: assetBId,
        side: 'sell',
        quantity: '90071992547.12346000',
        executedAt: '2026-07-23T10:01:00.000Z',
      }),
      // A then receives another exact, non-public-number buy before its own
      // normal repository-readback sale.
      transactionEntity({
        id: writeIds[3]!,
        portfolioId,
        assetId: assetAId,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:02:00.000Z',
      }),
      transactionEntity({
        id: writeIds[4]!,
        portfolioId,
        assetId: assetAId,
        side: 'sell',
        quantity: '90071992547.12346000',
        executedAt: '2026-07-23T10:03:00.000Z',
      }),
    ]);

    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    try {
      await expect(
        createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
          rehydrationId: FIRST_REHYDRATION_ID,
          document,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CASH_LEDGER' });
      expect(mutationTransaction).not.toHaveBeenCalled();
      expect(await harness.db.select().from(transactions)).toEqual([]);
    } finally {
      mutationTransaction.mockRestore();
    }
  });

  it('rehydrates a normal history larger than the old whole-document proof cap', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const roundingAssetId = '018f0000-0000-7000-8000-00000000010e';
    const historyAssetId = '018f0000-0000-7000-8000-00000000010f';
    await seedGlobalAsset(harness, roundingAssetId, 'LARGE-PROOF-ROUNDING');
    await seedGlobalAsset(harness, historyAssetId, 'LARGE-PROOF-HISTORY');

    // This accepted normal batch persists one scale-8 quantum apart, so the
    // final strict document enters the composed reachability proof.
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId: roundingAssetId,
        side: 'buy',
        quantity: 1.0000000046,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:00:00.000Z',
      },
      {
        assetId: roundingAssetId,
        side: 'sell',
        quantity: 1.0000000051,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:01:00.000Z',
      },
    ]);

    const normalHistory = Array.from({ length: NORMAL_HISTORY_TRANSACTION_COUNT }, (_, index) => ({
      assetId: historyAssetId,
      side: 'buy' as const,
      quantity: 1,
      price: 10,
      fee: 0,
      executedAt: new Date(Date.parse('2026-07-23T10:02:00.000Z') + index).toISOString(),
    }));
    // The HTTP contract caps one request at 500, while ordinary user history
    // can accumulate indefinitely across requests.
    for (let offset = 0; offset < normalHistory.length; offset += 500) {
      await harness.ctx.portfolio.createTransactions(
        user.id,
        portfolioId,
        normalHistory.slice(offset, offset + 500),
      );
    }

    const document = await capturePortfolioDocument(harness, portfolioId);
    expect(quantityEntities(document)).toHaveLength(NORMAL_HISTORY_TRANSACTION_COUNT + 2);

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrateReachableState(
      harness,
      user.id,
      document,
      FIRST_REHYDRATION_ID,
      'large normal-write history with a local rounding boundary',
    );
    expect(
      await harness.db.select().from(transactions).where(eq(transactions.portfolioId, portfolioId)),
    ).toHaveLength(NORMAL_HISTORY_TRANSACTION_COUNT + 2);
  });

  it('keeps a local rounding witness within the fixed linear ordering bound with 2,047 later same-asset rows', async () => {
    const arranged = await arrangeScaleEightRoundingBatch();
    const pairRows = quantityEntities(arranged.document);
    const latestPairId = [...pairRows].sort((left, right) => right.id.localeCompare(left.id))[0]
      ?.id;
    if (!latestPairId) throw new Error('expected the normal rounding pair');

    // The persisted pair is produced through the public normal path above. A
    // strict restore document can be arbitrarily long, so append a same-asset
    // tail to exercise the bounded proof without letting it repeatedly revisit
    // the pair's two-row CREATE witness.
    const laterRows: StrictTransactionEntity[] = [];
    let id = latestPairId;
    for (let index = 0; index < NORMAL_HISTORY_TRANSACTION_COUNT; index += 1) {
      id = nextUuidV7WriteId(id);
      laterRows.push(
        transactionEntity({
          id,
          portfolioId: arranged.portfolioId,
          assetId: NORMAL_ASSET_ID,
          side: 'buy',
          quantity: '1.00000000',
          executedAt: new Date(Date.parse('2026-07-23T10:02:00.000Z') + index).toISOString(),
        }),
      );
    }
    const document = strictDocument([...arranged.document.entities, ...laterRows]);
    expect(quantityEntities(document)).toHaveLength(NORMAL_HISTORY_TRANSACTION_COUNT + 2);

    const orderTraces: Array<{
      transactionRows: number;
      writeOrderKeyPasses: number;
      replayTimelineKeyPasses: number;
      prefixRevisionRows: number;
      prefixRevisionWitnesses: number;
    }> = [];
    await createParanoidRehydrationService({
      db: arranged.harness.db,
      testOnlyObserveQuantityReachabilityOrder(trace) {
        orderTraces.push(trace);
      },
    }).rehydrate(arranged.userId, {
      rehydrationId: FIRST_REHYDRATION_ID,
      document,
    });
    // This assertion is deliberately structural rather than a timing threshold:
    // the actual fixed-radix loops take the same 32 write-order keys and 49
    // chronological replay keys, regardless of the 2,047-row same-asset tail.
    expect(orderTraces).toEqual([
      {
        transactionRows: NORMAL_HISTORY_TRANSACTION_COUNT + 2,
        writeOrderKeyPasses: 32,
        replayTimelineKeyPasses: 49,
        prefixRevisionRows: 0,
        prefixRevisionWitnesses: 0,
      },
    ]);
    expect(
      await arranged.harness.db
        .select()
        .from(transactions)
        .where(eq(transactions.portfolioId, arranged.portfolioId)),
    ).toHaveLength(NORMAL_HISTORY_TRANSACTION_COUNT + 2);
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
