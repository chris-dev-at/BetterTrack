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
import { createParanoidRehydrationService } from '../paranoidRehydrationService';

const DEVICE_ID = '018f0000-1000-7000-8000-000000000001';
const FIRST_REHYDRATION_ID = '018f0000-1000-7000-8000-000000000002';
const SECOND_REHYDRATION_ID = '018f0000-1000-7000-8000-000000000003';
const EXACT_PORTFOLIO_ID = '018f0000-1000-7000-8000-000000000004';
const EXACT_CASH_SOURCE_ID = '018f0000-1000-7000-8000-000000000005';
const EXACT_ASSET_ID = '018f0000-1000-7000-8000-000000000006';
const EXACT_BUY_ID = '018f0000-1000-7000-8000-000000000007';
const NO_PREIMAGE_ASSET_ID = '018f0000-1000-7000-8000-000000000008';
const NO_PREIMAGE_SELL_ID = '018f0000-1000-7000-8000-000000000009';
const NORMAL_HISTORY_TRANSACTION_COUNT = 2_047;
const EDITED_AT = '2026-07-24T10:00:00.000Z';

type StrictEntity = ParanoidDisableRehydrationRequest['document']['entities'][number];
type StrictTransactionEntity = Extract<StrictEntity, { kind: 'transaction' }>;
type StrictCashMovementEntity = Extract<StrictEntity, { kind: 'cashMovement' }>;

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
  source?: string;
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
    source: input.source ?? 'manual',
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

function strictCashMovementEntity(
  row: typeof portfolioCashMovements.$inferSelect,
): StrictCashMovementEntity {
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

function strictDocument(entities: readonly StrictEntity[]) {
  return {
    schemaVersion: 1,
    entities: [...entities],
    mergeLog: [],
  } satisfies ParanoidDisableRehydrationRequest['document'];
}

function orderedMovements(
  document: ParanoidDisableRehydrationRequest['document'],
): StrictCashMovementEntity[] {
  return document.entities
    .filter((row): row is StrictCashMovementEntity => row.kind === 'cashMovement')
    .sort((left, right) => left.data.executedAt.localeCompare(right.data.executedAt));
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
    name: `${symbol} solvency fixture`,
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
    blob: Buffer.from('solvency-conformance-ciphertext'),
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

async function rehydrate(
  harness: TestHarness,
  userId: string,
  document: ParanoidDisableRehydrationRequest['document'],
  rehydrationId = FIRST_REHYDRATION_ID,
): Promise<void> {
  await createParanoidRehydrationService({ db: harness.db }).rehydrate(userId, {
    rehydrationId,
    document,
  });
}

describe('paranoid rehydration solvency conformance', () => {
  it('accepts an exact prefix sold through repository readback under a later tax regime', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    await seedGlobalAsset(harness, EXACT_ASSET_ID, 'EXACT-PREFIX');

    const exactDocument = strictDocument([
      portfolioEntity(user.id, EXACT_PORTFOLIO_ID),
      cashSourceEntity(EXACT_CASH_SOURCE_ID, EXACT_PORTFOLIO_ID),
      transactionEntity({
        id: EXACT_BUY_ID,
        portfolioId: EXACT_PORTFOLIO_ID,
        assetId: EXACT_ASSET_ID,
        side: 'buy',
        quantity: '90071992547.12345678',
        executedAt: '2026-07-23T10:00:00.000Z',
      }),
    ]);
    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrate(harness, user.id, exactDocument);

    const transactionRepo = createTransactionRepository(harness.db);
    const [exactBuy] = await transactionRepo.listForAsset(EXACT_PORTFOLIO_ID, EXACT_ASSET_ID);
    if (!exactBuy) throw new Error('expected exact-prefix buy');
    expect(exactBuy.quantity).toBe(90071992547.12346);

    await harness.ctx.tax.updateSettings(user.id, {
      mode: 'country_specific',
      country: 'AT',
    });
    await harness.ctx.portfolio.createTransactions(user.id, EXACT_PORTFOLIO_ID, [
      {
        assetId: EXACT_ASSET_ID,
        side: 'sell',
        quantity: exactBuy.quantity,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:01:00.000Z',
        cashSourceId: EXACT_CASH_SOURCE_ID,
        addProceedsToCash: true,
      },
    ]);

    const composedDocument = await capturePortfolioDocument(harness, EXACT_PORTFOLIO_ID);
    const quantities = composedDocument.entities
      .filter((row): row is StrictTransactionEntity => row.kind === 'transaction')
      .map((row) => ({ side: row.data.side, quantity: row.data.quantity }))
      .sort((left, right) => left.side.localeCompare(right.side));
    expect(quantities).toEqual([
      { side: 'buy', quantity: '90071992547.12345678' },
      { side: 'sell', quantity: '90071992547.12346000' },
    ]);

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrate(harness, user.id, composedDocument, SECOND_REHYDRATION_ID);
    expect(
      await harness.db
        .select()
        .from(transactions)
        .where(eq(transactions.portfolioId, EXACT_PORTFOLIO_ID)),
    ).toHaveLength(2);
  });

  it('accepts backdated rows and sequential patches across mixed sources and asset groups', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const assetA = '018f0000-1000-7000-8000-000000000010';
    const assetB = '018f0000-1000-7000-8000-000000000011';
    await seedGlobalAsset(harness, assetA, 'SOLVENT-A');
    await seedGlobalAsset(harness, assetB, 'SOLVENT-B');

    const [firstBuy] = await harness.ctx.portfolio.createTransactions(
      user.id,
      portfolioId,
      [
        {
          assetId: assetA,
          side: 'buy',
          quantity: 2,
          price: 10,
          fee: 0,
          executedAt: '2026-07-10T10:00:00.000Z',
        },
      ],
      { source: 'import:flatex' },
    );
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId: assetB,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: '2026-07-12T10:00:00.000Z',
      },
    ]);
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId: assetA,
        side: 'buy',
        quantity: 1,
        price: 9,
        fee: 0,
        executedAt: '2026-07-01T10:00:00.000Z',
      },
    ]);
    const [sell] = await harness.ctx.portfolio.createTransactions(
      user.id,
      portfolioId,
      [
        {
          assetId: assetA,
          side: 'sell',
          quantity: 2,
          price: 11,
          fee: 0,
          executedAt: '2026-07-11T10:00:00.000Z',
        },
      ],
      { source: 'import:ibkr' },
    );
    if (!firstBuy || !sell) throw new Error('expected normal transaction rows');

    await harness.ctx.portfolio.updateTransaction(user.id, portfolioId, firstBuy.id, {
      quantity: 3,
    });
    await harness.ctx.portfolio.updateTransaction(user.id, portfolioId, sell.id, {
      quantity: 3,
    });
    await harness.ctx.portfolio.updateTransaction(user.id, portfolioId, firstBuy.id, {
      note: 'patched twice',
    });

    const document = await capturePortfolioDocument(harness, portfolioId);
    for (const row of document.entities) {
      if (row.kind === 'transaction' && (row.id === firstBuy.id || row.id === sell.id)) {
        row.rev = 2;
      }
    }
    expect(
      new Set(
        document.entities
          .filter((row): row is StrictTransactionEntity => row.kind === 'transaction')
          .map((row) => row.data.source),
      ),
    ).toEqual(new Set(['manual', 'import:flatex', 'import:ibkr']));

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrate(harness, user.id, document);
    expect(
      await harness.db.select().from(transactions).where(eq(transactions.portfolioId, portfolioId)),
    ).toHaveLength(4);
  });

  it('accepts a covered sell flagged allowUncovered followed by the sell that closes the rest', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const assetId = '018f0000-1000-7000-8000-000000000013';
    await seedGlobalAsset(harness, assetId, 'FLAGGED-COVERED');

    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId,
        side: 'buy',
        quantity: 10,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:00:00.000Z',
      },
    ]);
    // Covered sell carrying the acknowledgment: the write path ignores the flag
    // (`reducePosition` keeps `held -= quantity` → 7 left) but persists it.
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId,
        side: 'sell',
        quantity: 3,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:01:00.000Z',
        allowUncovered: true,
      },
    ]);
    // Only reachable while the remaining 7 survives the replay.
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId,
        side: 'sell',
        quantity: 7,
        price: 12,
        fee: 0,
        executedAt: '2026-07-23T10:02:00.000Z',
      },
    ]);

    const document = await capturePortfolioDocument(harness, portfolioId);
    expect(
      document.entities
        .filter((row): row is StrictTransactionEntity => row.kind === 'transaction')
        .map((row) => ({ quantity: row.data.quantity, allowUncovered: row.data.allowUncovered }))
        .sort((left, right) => left.quantity.localeCompare(right.quantity)),
    ).toEqual([
      { quantity: '10.00000000', allowUncovered: false },
      { quantity: '3.00000000', allowUncovered: true },
      { quantity: '7.00000000', allowUncovered: false },
    ]);

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrate(harness, user.id, document);
    expect(
      await harness.db.select().from(transactions).where(eq(transactions.portfolioId, portfolioId)),
    ).toHaveLength(3);
  });

  it('rejects the high-magnitude no-preimage sell as a typed pre-write solvency error', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    await seedGlobalAsset(harness, NO_PREIMAGE_ASSET_ID, 'NO-PREIMAGE');
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId: NO_PREIMAGE_ASSET_ID,
        side: 'buy',
        quantity: 999_999_999_999,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:00:00.000Z',
      },
    ]);
    const document = await capturePortfolioDocument(harness, portfolioId);
    document.entities.push(
      transactionEntity({
        id: NO_PREIMAGE_SELL_ID,
        portfolioId,
        assetId: NO_PREIMAGE_ASSET_ID,
        side: 'sell',
        quantity: '999999999999.00006000',
        executedAt: '2026-07-23T10:01:00.000Z',
      }),
    );
    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');

    await expect(rehydrate(harness, user.id, document)).rejects.toMatchObject({
      code: 'INVALID_CASH_LEDGER',
      message:
        `transaction[${NO_PREIMAGE_SELL_ID}].quantity=` +
        '"999999999999.00006000" would oversell its position',
    });
    expect(mutationTransaction).not.toHaveBeenCalled();
    expect(await harness.db.select().from(transactions)).toEqual([]);
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toEqual([]);
    mutationTransaction.mockRestore();
  });

  it('accepts a cash ledger the normal path drove back to exactly zero', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    await harness.ctx.portfolio.depositCash(user.id, portfolioId, {
      amountEur: 1,
      executedAt: '2026-07-23T10:00:00.000Z',
    });
    await harness.ctx.portfolio.withdrawCash(user.id, portfolioId, {
      amountEur: 1,
      executedAt: '2026-07-23T10:01:00.000Z',
    });
    const document = await capturePortfolioDocument(harness, portfolioId);

    await replaceNormalRowsWithServerVault(harness, user.id);
    await rehydrate(harness, user.id, document);
    expect(
      await harness.db
        .select()
        .from(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, portfolioId)),
    ).toHaveLength(2);
  });

  it('rejects the finest representable cash overdraw — the cash ledger carries no envelope', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    await harness.ctx.portfolio.depositCash(user.id, portfolioId, {
      amountEur: 1,
      executedAt: '2026-07-23T10:00:00.000Z',
    });
    await harness.ctx.portfolio.withdrawCash(user.id, portfolioId, {
      amountEur: 1,
      executedAt: '2026-07-23T10:01:00.000Z',
    });
    const document = await capturePortfolioDocument(harness, portfolioId);
    const withdrawal = document.entities.find(
      (row): row is StrictCashMovementEntity =>
        row.kind === 'cashMovement' && row.data.kind === 'withdrawal',
    );
    if (!withdrawal) throw new Error('expected withdrawal');
    // One scale-6 quantum past the deposit: no writer can produce this (cash is
    // floored to cents) so it is a genuine overdraw, not absorbable drift.
    withdrawal.data.amountEur = '-1.000001';
    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');

    await expect(rehydrate(harness, user.id, document)).rejects.toMatchObject({
      code: 'INVALID_CASH_LEDGER',
      message:
        `cashMovement[${withdrawal.id}].amountEur=` + '"-1.000001" would overdraw its cash source',
    });
    expect(mutationTransaction).not.toHaveBeenCalled();
    expect(await harness.db.select().from(portfolioCashMovements)).toEqual([]);
    mutationTransaction.mockRestore();
  });

  it('quantizes sub-quantum cash drift the way PostgreSQL stores it, in both directions', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    await harness.ctx.portfolio.depositCash(user.id, portfolioId, {
      amountEur: 2,
      executedAt: '2026-07-23T10:00:00.000Z',
    });
    await harness.ctx.portfolio.withdrawCash(user.id, portfolioId, {
      amountEur: 1,
      executedAt: '2026-07-23T10:01:00.000Z',
    });
    await harness.ctx.portfolio.withdrawCash(user.id, portfolioId, {
      amountEur: 1,
      executedAt: '2026-07-23T10:02:00.000Z',
    });
    const document = await capturePortfolioDocument(harness, portfolioId);
    // #918 routes cash through the same rounding as every money column. Drive
    // every branch of it — toward zero, positive half up, negative half away
    // from zero — and let PostgreSQL coerce the same raw strings on insert, so
    // the restored rows are the oracle for what validation accumulated.
    const drift = ['2.0000005', '-1.0000004', '-1.0000005'];
    orderedMovements(document).forEach((movement, index) => {
      movement.data.amountEur = drift[index]!;
    });
    await replaceNormalRowsWithServerVault(harness, user.id);

    await rehydrate(harness, user.id, document);
    const restored = await harness.db
      .select()
      .from(portfolioCashMovements)
      .where(eq(portfolioCashMovements.portfolioId, portfolioId));
    expect(
      [...restored]
        .sort((left, right) => left.executedAt.getTime() - right.executedAt.getTime())
        .map((row) => row.amountEur),
    ).toEqual(['2.000001', '-1.000000', '-1.000001']);
  });

  it('rejects a shortfall produced only by per-row cash rounding — still no envelope', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    await harness.ctx.portfolio.depositCash(user.id, portfolioId, {
      amountEur: 1,
      executedAt: '2026-07-23T10:00:00.000Z',
    });
    await harness.ctx.portfolio.depositCash(user.id, portfolioId, {
      amountEur: 1,
      executedAt: '2026-07-23T10:01:00.000Z',
    });
    await harness.ctx.portfolio.withdrawCash(user.id, portfolioId, {
      amountEur: 2,
      executedAt: '2026-07-23T10:02:00.000Z',
    });
    const document = await capturePortfolioDocument(harness, portfolioId);
    // Two credits round down and their exact-sum debit rounds up, so the
    // replay lands one scale-6 quantum short although the raw amounts balance.
    // No writer produces this — client cash is floored to cents and captured
    // server rows are already scale 6 — so it stays a fail-closed rejection
    // rather than the per-row allowance quantities carry.
    const drift = ['1.0000004', '1.0000004', '-2.0000008'];
    const movements = orderedMovements(document);
    movements.forEach((movement, index) => {
      movement.data.amountEur = drift[index]!;
    });
    const withdrawal = movements[2]!;
    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');

    await expect(rehydrate(harness, user.id, document)).rejects.toMatchObject({
      code: 'INVALID_CASH_LEDGER',
      message:
        `cashMovement[${withdrawal.id}].amountEur=` + '"-2.0000008" would overdraw its cash source',
    });
    expect(mutationTransaction).not.toHaveBeenCalled();
    expect(await harness.db.select().from(portfolioCashMovements)).toEqual([]);
    mutationTransaction.mockRestore();
  });

  it('visits a 2,047-row same-asset tail once under the fixed ordering bound', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const assetId = '018f0000-1000-7000-8000-000000000012';
    await seedGlobalAsset(harness, assetId, 'ORDER-BOUND');
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId,
        side: 'buy',
        quantity: 1.0000000046,
        price: 10,
        fee: 0,
        executedAt: '2026-07-23T10:00:00.000Z',
      },
      {
        assetId,
        side: 'sell',
        quantity: 1.0000000051,
        price: 11,
        fee: 0,
        executedAt: '2026-07-23T10:01:00.000Z',
      },
    ]);

    const document = await capturePortfolioDocument(harness, portfolioId);
    const persistedPair = document.entities.filter(
      (row): row is StrictTransactionEntity => row.kind === 'transaction',
    );
    let nextId = [...persistedPair].sort((left, right) => right.id.localeCompare(left.id))[0]!.id;
    for (let index = 0; index < NORMAL_HISTORY_TRANSACTION_COUNT; index += 1) {
      nextId = nextUuidV7WriteId(nextId);
      document.entities.push(
        transactionEntity({
          id: nextId,
          portfolioId,
          assetId,
          side: 'buy',
          quantity: '1.00000000',
          executedAt: new Date(Date.parse('2026-07-23T10:02:00.000Z') + index).toISOString(),
        }),
      );
    }
    const transactionRows = document.entities.filter(
      (row): row is StrictTransactionEntity => row.kind === 'transaction',
    );
    document.entities = [
      ...document.entities.filter((row) => row.kind !== 'transaction'),
      ...transactionRows.reverse(),
    ];
    await replaceNormalRowsWithServerVault(harness, user.id);
    const traces: Parameters<
      NonNullable<
        Parameters<typeof createParanoidRehydrationService>[0]['testOnlyObserveSolvencyReplay']
      >
    >[0][] = [];

    await createParanoidRehydrationService({
      db: harness.db,
      testOnlyObserveSolvencyReplay(trace) {
        traces.push(trace);
      },
    }).rehydrate(user.id, {
      rehydrationId: FIRST_REHYDRATION_ID,
      document,
    });

    expect(traces).toEqual([
      {
        transactionRows: NORMAL_HISTORY_TRANSACTION_COUNT + 2,
        transactionReplayVisits: NORMAL_HISTORY_TRANSACTION_COUNT + 2,
        cashMovementRows: 0,
        cashMovementReplayVisits: 0,
        replayOrderKeyPasses: 49,
      },
    ]);
    expect(
      await harness.db.select().from(transactions).where(eq(transactions.portfolioId, portfolioId)),
    ).toHaveLength(NORMAL_HISTORY_TRANSACTION_COUNT + 2);
  });
});
