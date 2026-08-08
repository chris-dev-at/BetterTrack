import type {
  ParanoidDisableRehydrationRequest,
  VaultMirrorProvenance,
} from '@bettertrack/contracts';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { createTransactionRepository } from '../../../data/repositories/transactionRepository';
import {
  assets,
  dividends,
  mirrorChainMembers,
  mirrorRows,
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
type StrictDividendEntity = Extract<StrictEntity, { kind: 'dividend' }>;
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

    vaultId: null,
    alias: null,
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
    vaultId: row.vaultId,
    alias: row.alias,
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
    // V5 cash fusion columns — mirrored from the row like every other field, so
    // the conformance fixture keeps matching what the repository actually reads.
    dedupHash: row.dedupHash,
    originalCurrency: row.originalCurrency,
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

function strictDividendEntity(row: typeof dividends.$inferSelect): StrictDividendEntity {
  return entity(row.id, 'dividend', {
    portfolioId: row.portfolioId,
    assetId: row.assetId,
    cashSourceId: row.cashSourceId,
    grossAmountEur: row.grossAmountEur,
    executedAt: row.executedAt.toISOString(),
    note: row.note,
    taxMode: row.taxMode,
    taxCountry: row.taxCountry as StrictDividendEntity['data']['taxCountry'],
    taxAmountEur: row.taxAmountEur,
    taxParams: row.taxParams as StrictDividendEntity['data']['taxParams'],
    source: row.source,
    createdAt: row.createdAt.toISOString(),
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
    mirrorProvenance: [],
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
  const dividendRows = await harness.db
    .select()
    .from(dividends)
    .where(eq(dividends.portfolioId, portfolioId));
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
    ...dividendRows.map(strictDividendEntity),
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

/**
 * Severed-fork MIRRORCHAIN provenance (`docs/paranoid-design.md` §7.1). Every
 * state below is produced by the NORMAL mirror/portfolio/tax services — the
 * correction path that repoints `mirror_rows` to a replacement local id, and the
 * force-applied edit that leaves the copy's cash prefix overdrawn — so the
 * documents under test are reachable persisted states, not hand-built graphs.
 */
const FORK_TAX_NOW = Date.parse('2026-07-28T12:00:00.000Z');
const FORK_ASSET_ID = '018f0000-1000-7000-8000-0000000000a0';
const FORK_FLAT_ASSET_ID = '018f0000-1000-7000-8000-0000000000a5';
const FORK_REHYDRATION_ID = '018f0000-1000-7000-8000-0000000000a1';
const FABRICATED_BUY_LEG_ID = '018f0000-1000-7000-8000-0000000000a2';
const FABRICATED_PROCEEDS_LEG_ID = '018f0000-1000-7000-8000-0000000000a3';
const UNKNOWN_CHAIN_ID = '018f0000-1000-7000-8000-0000000000a4';
const UNKNOWN_MEMBERSHIP_ID = '018f0000-1000-7000-8000-0000000000a6';
const MANUAL_WITHDRAWAL_ID = '018f0000-1000-7000-8000-0000000000a7';
const SECOND_FORK_REHYDRATION_ID = '018f0000-1000-7000-8000-0000000000a8';

interface SeveredForkFixture {
  harness: TestHarness;
  memberId: string;
  chainId: string;
  /** The ENDED membership tombstone every retained row is proved against. */
  membershipId: string;
  forkPortfolioId: string;
  ownerPortfolioId: string;
  ownerId: string;
  provenance: VaultMirrorProvenance[];
  /** The cash-linked buy whose financial update went through delete/re-create. */
  correctedMirrorId: string;
  correctedLocalId: string;
  /** A chain buy the origin never funded from cash (its op has payFromCash: false). */
  uncashedBuyLocalId: string;
  /** A chain sell the origin never paid into cash. */
  uncashedSellLocalId: string;
  /** The chain deposit of EUR 200 — a direct, op-bound external cash movement. */
  depositLocalId: string;
  /** The replicated dividend, taxed under the member's own regime. */
  dividendLocalId: string;
  forkBalanceEur: number;
}

/** Capture every portfolio the account owns, exactly as a client vault would. */
async function captureAccountDocument(
  harness: TestHarness,
  userId: string,
  mirrorProvenance: readonly VaultMirrorProvenance[],
): Promise<ParanoidDisableRehydrationRequest['document']> {
  const owned = await harness.db.select().from(portfolios).where(eq(portfolios.userId, userId));
  const entities: StrictEntity[] = [];
  let taxSettingCaptured = false;
  for (const portfolio of owned) {
    const document = await capturePortfolioDocument(harness, portfolio.id);
    for (const captured of document.entities) {
      // The account-wide tax setting rides every per-portfolio capture.
      if (captured.kind === 'taxSetting') {
        if (taxSettingCaptured) continue;
        taxSettingCaptured = true;
      }
      entities.push(captured);
    }
  }
  return { ...strictDocument(entities), mirrorProvenance: [...mirrorProvenance] };
}

async function severedOverdrawnFork(): Promise<SeveredForkFixture> {
  const harness = await createTestApp({ taxNow: () => FORK_TAX_NOW });
  const owner = await harness.seedUser({
    email: 'fork-provenance-owner@bettertrack.test',
    username: 'fork-provenance-owner',
  });
  const member = await harness.seedUser({
    email: 'fork-provenance-member@bettertrack.test',
    username: 'fork-provenance-member',
  });
  await seedGlobalAsset(harness, FORK_ASSET_ID, 'FORK-CORRECTION');
  await seedGlobalAsset(harness, FORK_FLAT_ASSET_ID, 'FORK-FLAT');

  const ownerPortfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
  const { chain } = await harness.ctx.mirror.convertToChain(owner.id, ownerPortfolioId, {
    name: 'Corrected fork',
  });
  const { portfolioId: forkPortfolioId } = await harness.ctx.mirror.attachMemberCopy(
    chain.id,
    member.id,
  );
  await harness.ctx.mirror.replicateChain(chain.id);
  // The member's own regime is what skews the copy: every replicated write is
  // taxed locally, so the copy's cash sits below the origin's from here on.
  await harness.ctx.tax.updateSettings(member.id, { mode: 'country_specific', country: 'AT' });

  const ownerMain = (
    await harness.ctx.portfolio.listCashSources(owner.id, ownerPortfolioId)
  ).sources.find((source) => source.isMain);
  if (!ownerMain) throw new Error('expected owner Main cash source');
  const replicate = async () => {
    await harness.ctx.mirror.replicateChain(chain.id);
  };

  // A dividend can only be recorded on an asset the copy holds.
  await harness.ctx.mirror.submitTransactionsCreate(owner.id, ownerPortfolioId, [
    {
      assetId: FORK_ASSET_ID,
      side: 'buy',
      quantity: 1,
      price: 1,
      fee: 0,
      executedAt: '2026-07-19T10:00:00.000Z',
    },
  ]);
  await replicate();
  await harness.ctx.mirror.submitCashDeposit(owner.id, ownerPortfolioId, {
    amountEur: 200,
    sourceId: ownerMain.id,
    executedAt: '2026-07-20T10:00:00.000Z',
  });
  await replicate();
  // Taxed on the member's copy only (the origin's mode is `none`), which is what
  // makes the two copies' cash balances diverge by exactly the copy-local tax.
  await harness.ctx.mirror.submitDividendRecord(owner.id, ownerPortfolioId, {
    assetId: FORK_ASSET_ID,
    grossAmountEur: 100,
    cashSourceId: ownerMain.id,
    executedAt: '2026-07-21T10:00:00.000Z',
  });
  await replicate();
  const [cashLinkedBuy] = await harness.ctx.mirror.submitTransactionsCreate(
    owner.id,
    ownerPortfolioId,
    [
      {
        assetId: FORK_ASSET_ID,
        side: 'buy',
        quantity: 2,
        price: 100,
        fee: 0,
        executedAt: '2026-07-22T10:00:00.000Z',
        payFromCash: true,
        cashSourceId: ownerMain.id,
      },
    ],
  );
  if (!cashLinkedBuy) throw new Error('expected the cash-linked buy');
  await replicate();

  // The sanctioned correction: a financial update of a cash-linked row is
  // refused in place, so every copy deletes, re-creates and repoints its mirror
  // link to a REPLACEMENT local id. It also overdraws the taxed copy — EUR 290
  // out of the origin's 300 but the copy's 272.50 — which only force apply admits.
  await harness.ctx.mirror.submitTransactionUpdate(owner.id, ownerPortfolioId, cashLinkedBuy.id, {
    quantity: 2.9,
  });
  await replicate();

  // A deposit with no explicit source: its op carries `sourceMirrorId: null`, so
  // every copy books it against ITS OWN Main — the second source-resolution path
  // restore-time validation has to reproduce.
  await harness.ctx.mirror.submitCashDeposit(owner.id, ownerPortfolioId, {
    amountEur: 5,
    executedAt: '2026-07-24T10:00:00.000Z',
  });
  await replicate();

  // A chain buy/sell pair the origin deliberately never routed through cash:
  // their ops carry payFromCash/addProceedsToCash = false. Flat price, so the
  // member's own regime freezes a zero tax and adds no settlement movement.
  const [uncashedBuy] = await harness.ctx.mirror.submitTransactionsCreate(
    owner.id,
    ownerPortfolioId,
    [
      {
        assetId: FORK_FLAT_ASSET_ID,
        side: 'buy',
        quantity: 5,
        price: 2,
        fee: 0,
        executedAt: '2026-07-25T10:00:00.000Z',
      },
    ],
  );
  await replicate();
  const [uncashedSell] = await harness.ctx.mirror.submitTransactionsCreate(
    owner.id,
    ownerPortfolioId,
    [
      {
        assetId: FORK_FLAT_ASSET_ID,
        side: 'sell',
        quantity: 5,
        price: 2,
        fee: 0,
        executedAt: '2026-07-26T10:00:00.000Z',
      },
    ],
  );
  await replicate();
  if (!uncashedBuy || !uncashedSell) throw new Error('expected the uncashed chain pair');

  const forkMovements = await harness.ctx.portfolio.getCashMovements(member.id, forkPortfolioId);
  expect(forkMovements.balanceEur).toBeLessThan(0);
  expect(
    (await harness.ctx.portfolio.getCashMovements(owner.id, ownerPortfolioId)).balanceEur,
  ).toBeGreaterThanOrEqual(0);

  await harness.ctx.mirror.leaveChain(member.id, chain.id);
  await expect(harness.ctx.mirror.syncedMembership(forkPortfolioId)).resolves.toBeNull();

  // §7.1 capture — the production read, while `mirror_rows` still exists.
  const { provenance } = await harness.ctx.paranoidTransitions.forkProvenance(member.id);
  const correctedEntry = provenance.find(
    (entry) => entry.kind === 'transaction' && entry.mirrorId === cashLinkedBuy.id,
  );
  if (!correctedEntry) throw new Error('expected provenance for the corrected buy');
  const localForOwnerTx = (ownerLocalId: string): string => {
    const entry = provenance.find(
      (candidate) => candidate.kind === 'transaction' && candidate.mirrorId === ownerLocalId,
    );
    if (!entry) throw new Error(`expected provenance for chain transaction ${ownerLocalId}`);
    return entry.localId;
  };

  const membershipIds = [...new Set(provenance.map((entry) => entry.membershipId))];
  if (membershipIds.length !== 1) {
    throw new Error(`expected one ended membership, got ${membershipIds.length}`);
  }
  const depositMovement = forkMovements.movements.find(
    (movement) => movement.kind === 'deposit' && movement.amountEur === 200,
  );
  const [forkDividend] = await harness.db
    .select()
    .from(dividends)
    .where(eq(dividends.portfolioId, forkPortfolioId));
  if (!depositMovement || !forkDividend) {
    throw new Error('expected the replicated deposit and dividend on the fork');
  }

  return {
    harness,
    memberId: member.id,
    ownerId: owner.id,
    chainId: chain.id,
    membershipId: membershipIds[0]!,
    forkPortfolioId,
    ownerPortfolioId,
    provenance: [...provenance],
    correctedMirrorId: correctedEntry.mirrorId,
    correctedLocalId: correctedEntry.localId,
    uncashedBuyLocalId: localForOwnerTx(uncashedBuy.id),
    uncashedSellLocalId: localForOwnerTx(uncashedSell.id),
    depositLocalId: depositMovement.id,
    dividendLocalId: forkDividend.id,
    forkBalanceEur: forkMovements.balanceEur,
  };
}

describe('paranoid rehydration severed-fork provenance', () => {
  it('round-trips a corrected, force-overdrawn fork across a Drive-only enable', async () => {
    const fixture = await severedOverdrawnFork();
    const { harness, memberId, forkPortfolioId } = fixture;

    // The replacement local id is what the document carries; the immutable
    // logical id stayed with the oplog. `local_id = mirror_id` is provably false.
    expect(fixture.correctedLocalId).not.toBe(fixture.correctedMirrorId);
    expect(fixture.provenance.some((entry) => entry.localId === entry.mirrorId)).toBe(false);
    const capturedRows = await harness.db
      .select()
      .from(mirrorRows)
      .where(eq(mirrorRows.portfolioId, forkPortfolioId));
    expect(capturedRows.length).toBe(fixture.provenance.length);

    const document = await captureAccountDocument(harness, memberId, fixture.provenance);
    const capturedTransactions = await harness.db
      .select()
      .from(transactions)
      .where(eq(transactions.portfolioId, forkPortfolioId));
    const capturedMovements = await harness.db
      .select()
      .from(portfolioCashMovements)
      .where(eq(portfolioCashMovements.portfolioId, forkPortfolioId));
    const correctedRow = capturedTransactions.find((row) => row.id === fixture.correctedLocalId);
    const correctedLeg = capturedMovements.find(
      (row) => row.transactionId === fixture.correctedLocalId,
    );
    const withholding = capturedMovements.filter((row) => row.kind === 'tax_withholding');
    if (!correctedRow || !correctedLeg) throw new Error('expected the corrected row and its leg');
    expect(correctedRow.quantity).toBe('2.90000000');
    expect(withholding.length).toBeGreaterThan(0);

    // A real Drive-only enable: no server ciphertext, and the identity map dies
    // with the copy. Nothing portfolio-derived is left behind to replace it.
    const { revision } = await harness.ctx.paranoidTransitions.normalDataRevision(memberId);
    await harness.ctx.paranoidTransitions.enable(memberId, {
      mediaSet: ['drive'],
      vaultVersion: 1,
      driveAttestation: { verifiedRoundTrip: true, vaultVersion: 1 },
      normalDataRevision: revision,
    });
    expect(
      await harness.db.select().from(mirrorRows).where(eq(mirrorRows.portfolioId, forkPortfolioId)),
    ).toEqual([]);
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, memberId)),
    ).toEqual([]);
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, memberId)),
    ).toEqual([]);
    // The chain-side proof surface is what survives: the oplog plus the ended
    // membership tombstone with its watermark (its portfolio is now null).
    const tombstones = await harness.db
      .select()
      .from(mirrorChainMembers)
      .where(eq(mirrorChainMembers.userId, memberId));
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ status: 'left', portfolioId: null });
    expect(tombstones[0]!.appliedSeq).toBeGreaterThan(0);

    await createParanoidRehydrationService({
      db: harness.db,
      now: () => new Date(FORK_TAX_NOW),
    }).rehydrate(memberId, { rehydrationId: FORK_REHYDRATION_ID, document });

    const restoredTransactions = await harness.db
      .select()
      .from(transactions)
      .where(eq(transactions.portfolioId, forkPortfolioId));
    const restoredMovements = await harness.db
      .select()
      .from(portfolioCashMovements)
      .where(eq(portfolioCashMovements.portfolioId, forkPortfolioId));
    const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
    expect(restoredTransactions.sort(byId)).toEqual(capturedTransactions.sort(byId));
    expect(restoredMovements.sort(byId)).toEqual(capturedMovements.sort(byId));
    expect(
      (await harness.ctx.portfolio.getCashMovements(memberId, forkPortfolioId)).balanceEur,
    ).toBe(fixture.forkBalanceEur);
  });

  it('rejects a fabricated cash leg whose chain operation never routed through cash', async () => {
    const fixture = await severedOverdrawnFork();
    const { harness, memberId, forkPortfolioId } = fixture;
    const document = await captureAccountDocument(harness, memberId, fixture.provenance);
    const sourceId = document.entities.find(
      (entity): entity is Extract<StrictEntity, { kind: 'cashSource' }> =>
        entity.kind === 'cashSource' &&
        entity.data.isMain &&
        entity.data.portfolioId === forkPortfolioId,
    )?.id;
    const transactionOf = (id: string) =>
      document.entities.find(
        (entity): entity is StrictTransactionEntity =>
          entity.kind === 'transaction' && entity.id === id,
      );
    const buy = transactionOf(fixture.uncashedBuyLocalId);
    const sell = transactionOf(fixture.uncashedSellLocalId);
    if (!sourceId || !buy || !sell)
      throw new Error('expected the uncashed chain pair in the vault');

    const fabricated = (
      id: string,
      kind: 'buy' | 'sell_proceeds',
      parent: StrictTransactionEntity,
      amountEur: string,
    ): StrictCashMovementEntity =>
      entity(id, 'cashMovement', {
        portfolioId: forkPortfolioId,
        sourceId,
        kind,
        amountEur,
        transactionId: parent.id,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: parent.data.executedAt,
        note: null,
        source: parent.data.source,
        dedupHash: null,
        originalCurrency: null,
        createdAt: parent.data.executedAt,
      });

    await replaceNormalRowsWithServerVault(harness, memberId);
    for (const { leg, side, field } of [
      {
        leg: fabricated(FABRICATED_BUY_LEG_ID, 'buy', buy, '-5.000000'),
        side: 'buy',
        field: 'payFromCash',
      },
      {
        leg: fabricated(FABRICATED_PROCEEDS_LEG_ID, 'sell_proceeds', sell, '10.000000'),
        side: 'sell',
        field: 'addProceedsToCash',
      },
    ] as const) {
      const forged = { ...document, entities: [...document.entities, leg] };
      const mutationTransaction = vi.spyOn(harness.db, 'transaction');
      // The message names the exact field and value that makes the leg
      // unreachable, not just "invalid".
      await expect(
        createParanoidRehydrationService({ db: harness.db }).rehydrate(memberId, {
          rehydrationId: FORK_REHYDRATION_ID,
          document: forged,
        }),
      ).rejects.toThrow(
        new RegExp(
          `^cashMovement\\[${leg.id}\\]\\.kind="${leg.data.kind}" requires a chain ${side} ` +
            `operation with ${field}=true, but tx\\.create at seq \\d+ has side="${side}" ` +
            `and ${field}=false$`,
        ),
      );
      expect(mutationTransaction).not.toHaveBeenCalled();
      expect(
        await harness.db
          .select()
          .from(transactions)
          .where(eq(transactions.portfolioId, forkPortfolioId)),
      ).toEqual([]);
      mutationTransaction.mockRestore();
    }
  });

  /**
   * The waiver follows the authenticated MOVEMENTS, not their source: replica
   * apply force-applied exactly the chain's own writes, so a later manual outflow
   * on the same source is still gated by the normal `withdrawCash` rule — even
   * though a genuine chain movement already pushed that source negative.
   */
  it('rejects a manual outflow that rides on an authenticated chain overdraw', async () => {
    const fixture = await severedOverdrawnFork();
    const { harness, memberId, forkPortfolioId } = fixture;
    const document = await captureAccountDocument(harness, memberId, fixture.provenance);
    const sourceId = document.entities.find(
      (entity): entity is Extract<StrictEntity, { kind: 'cashSource' }> =>
        entity.kind === 'cashSource' &&
        entity.data.isMain &&
        entity.data.portfolioId === forkPortfolioId,
    )?.id;
    if (!sourceId) throw new Error('expected the fork Main cash source');

    const manualWithdrawal = entity(MANUAL_WITHDRAWAL_ID, 'cashMovement', {
      portfolioId: forkPortfolioId,
      sourceId,
      kind: 'withdrawal',
      amountEur: '-1.000000',
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId: null,
      taxYear: null,
      // After every chain row, on the source the chain already overdrew.
      executedAt: '2026-07-27T10:00:00.000Z',
      note: null,
      source: 'manual',
      dedupHash: null,
      originalCurrency: null,
      createdAt: '2026-07-27T10:00:00.000Z',
    });

    await replaceNormalRowsWithServerVault(harness, memberId);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    await expect(
      createParanoidRehydrationService({ db: harness.db }).rehydrate(memberId, {
        rehydrationId: FORK_REHYDRATION_ID,
        document: { ...document, entities: [...document.entities, manualWithdrawal] },
      }),
    ).rejects.toThrow(
      `cashMovement[${MANUAL_WITHDRAWAL_ID}].amountEur="-1.000000" would overdraw its cash source`,
    );
    expect(mutationTransaction).not.toHaveBeenCalled();
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, memberId)),
    ).toEqual([]);
  });

  /**
   * Full-state binding (mirrorchain design §3: the highest-seq op ≤ the watermark
   * IS the entity's state). Provenance may only authenticate the row its operation
   * actually produced — otherwise a genuine op would launder a different amount.
   */
  it('rejects a restored row that contradicts its authoritative operation', async () => {
    const fixture = await severedOverdrawnFork();
    const { harness, memberId } = fixture;
    const document = await captureAccountDocument(harness, memberId, fixture.provenance);

    const patch = (
      id: string,
      kind: StrictEntity['kind'],
      data: Record<string, unknown>,
    ): ParanoidDisableRehydrationRequest['document'] => ({
      ...document,
      entities: document.entities.map((row) =>
        row.id === id && row.kind === kind
          ? ({ ...row, data: { ...row.data, ...data } } as StrictEntity)
          : row,
      ),
    });

    const dividendRow = document.entities.find(
      (row): row is StrictDividendEntity =>
        row.kind === 'dividend' && row.id === fixture.dividendLocalId,
    );
    const dividendLeg = document.entities.find(
      (row): row is StrictCashMovementEntity =>
        row.kind === 'cashMovement' &&
        row.data.dividendId === fixture.dividendLocalId &&
        row.data.kind === 'dividend',
    );
    if (!dividendRow || !dividendLeg) throw new Error('expected the replicated dividend and leg');

    const forgeries: readonly {
      name: string;
      document: ParanoidDisableRehydrationRequest['document'];
      message: RegExp;
    }[] = [
      {
        // The reviewed case: a real `cash.withdraw`/`cash.deposit` op must not
        // authenticate a larger movement and hand it the overdraw waiver.
        name: 'an inflated external cash amount',
        document: patch(fixture.depositLocalId, 'cashMovement', { amountEur: '900.000000' }),
        message: new RegExp(
          `cashMovement\\[${fixture.depositLocalId}\\]\\.amountEur="900.000000" contradicts its ` +
            `authoritative cash\\.deposit operation at seq \\d+ \\(amountEur="200.000000"\\)`,
        ),
      },
      {
        name: 'a moved external cash timestamp',
        document: patch(fixture.depositLocalId, 'cashMovement', {
          executedAt: '2026-07-27T09:00:00.000Z',
        }),
        message: new RegExp(
          `cashMovement\\[${fixture.depositLocalId}\\]\\.executedAt="2026-07-27T09:00:00.000Z" ` +
            `contradicts its authoritative cash\\.deposit operation at seq \\d+`,
        ),
      },
      {
        // The corrected buy carries a cash leg, so its financial state is the op's:
        // a quantity a member never reviewed cannot ride the same provenance.
        name: 'a re-priced cash-linked transaction',
        document: patch(fixture.correctedLocalId, 'transaction', { quantity: '9.00000000' }),
        message: new RegExp(
          `transaction\\[${fixture.correctedLocalId}\\]\\.quantity="9.00000000" contradicts its ` +
            `authoritative tx\\.(create|update) operation at seq \\d+ \\(quantity="2.90000000"\\)`,
        ),
      },
      {
        // Raised consistently on the dividend AND its gross leg, so the graph rules
        // pass and only the op binding can catch it.
        name: 'a raised dividend gross amount',
        document: {
          ...patch(fixture.dividendLocalId, 'dividend', { grossAmountEur: '150.000000' }),
          entities: patch(fixture.dividendLocalId, 'dividend', {
            grossAmountEur: '150.000000',
          }).entities.map((row) =>
            row.id === dividendLeg.id
              ? ({ ...row, data: { ...row.data, amountEur: '150.000000' } } as StrictEntity)
              : row,
          ),
        },
        message: new RegExp(
          `dividend\\[${fixture.dividendLocalId}\\]\\.grossAmountEur="150.000000" contradicts its ` +
            `authoritative dividend\\.record operation at seq \\d+ \\(grossAmountEur="100.000000"\\)`,
        ),
      },
    ];

    await replaceNormalRowsWithServerVault(harness, memberId);
    for (const forgery of forgeries) {
      const mutationTransaction = vi.spyOn(harness.db, 'transaction');
      await expect(
        createParanoidRehydrationService({ db: harness.db }).rehydrate(memberId, {
          rehydrationId: FORK_REHYDRATION_ID,
          document: forgery.document,
        }),
        forgery.name,
      ).rejects.toThrow(forgery.message);
      expect(mutationTransaction, forgery.name).not.toHaveBeenCalled();
      expect(
        await harness.db.select().from(portfolios).where(eq(portfolios.userId, memberId)),
        forgery.name,
      ).toEqual([]);
      mutationTransaction.mockRestore();
    }
  });

  /**
   * Re-joining is a normal flow: the account ends up with TWO ended memberships in
   * one chain, two retained forks, and two watermarks. The older fork must be
   * proved against ITS tombstone — a later copy's higher watermark can neither
   * authorize the ops the older fork never received, nor may the pair be collapsed
   * into a "duplicate logical identity" that strands the account at capture.
   */
  it('proves each retained fork of a re-joined chain against its own watermark', async () => {
    const fixture = await severedOverdrawnFork();
    const { harness, memberId, chainId, ownerId, ownerPortfolioId } = fixture;

    const { portfolioId: secondForkId } = await harness.ctx.mirror.attachMemberCopy(
      chainId,
      memberId,
    );
    await harness.ctx.mirror.replicateChain(chainId);
    const [afterRejoin] = await harness.ctx.mirror.submitTransactionsCreate(
      ownerId,
      ownerPortfolioId,
      [
        {
          assetId: FORK_FLAT_ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 2,
          fee: 0,
          executedAt: '2026-07-27T10:00:00.000Z',
        },
      ],
    );
    if (!afterRejoin) throw new Error('expected the post-rejoin chain op');
    await harness.ctx.mirror.replicateChain(chainId);
    await harness.ctx.mirror.leaveChain(memberId, chainId);

    const { provenance } = await harness.ctx.paranoidTransitions.forkProvenance(memberId);
    const memberships = await harness.db
      .select()
      .from(mirrorChainMembers)
      .where(eq(mirrorChainMembers.userId, memberId));
    expect(memberships).toHaveLength(2);
    // Two forks, two tombstones, two watermarks — and the SAME logical entity is
    // carried twice, once per copy, under different local ids.
    const byMembership = new Set(provenance.map((entry) => entry.membershipId));
    expect(byMembership.size).toBe(2);
    const correctedEntries = provenance.filter(
      (entry) => entry.mirrorId === fixture.correctedMirrorId,
    );
    expect(correctedEntries).toHaveLength(2);
    expect(new Set(correctedEntries.map((entry) => entry.localId)).size).toBe(2);
    const olderEntry = correctedEntries.find(
      (entry) => entry.portfolioId === fixture.forkPortfolioId,
    );
    const newerEntry = correctedEntries.find((entry) => entry.portfolioId === secondForkId);
    if (!olderEntry || !newerEntry) throw new Error('expected one entry per retained fork');
    const olderWatermark = memberships.find(
      (membership) => membership.id === olderEntry.membershipId,
    )?.appliedSeq;
    const newerWatermark = memberships.find(
      (membership) => membership.id === newerEntry.membershipId,
    )?.appliedSeq;
    expect(olderWatermark).toBeLessThan(newerWatermark!);

    const document = await captureAccountDocument(harness, memberId, provenance);
    await replaceNormalRowsWithServerVault(harness, memberId);

    // The forgery: the OLDER fork claiming an op only the newer copy received. It
    // sits below the chain's highest watermark, so collapsing per chain would have
    // authorized it.
    const forged = provenance.map((entry) =>
      entry === olderEntry ? { ...entry, mirrorId: afterRejoin.id } : entry,
    );
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    await expect(
      createParanoidRehydrationService({ db: harness.db }).rehydrate(memberId, {
        rehydrationId: FORK_REHYDRATION_ID,
        document: { ...document, mirrorProvenance: forged },
      }),
    ).rejects.toThrow(
      new RegExp(
        `mirrorProvenance\\[transaction:${afterRejoin.id}\\]\\.mirrorId="${afterRejoin.id}" has no chain ` +
          `operation at or below the ended membership watermark ${olderWatermark}`,
      ),
    );
    expect(mutationTransaction).not.toHaveBeenCalled();
    mutationTransaction.mockRestore();

    // ...while the honest two-fork document restores both copies in full.
    await createParanoidRehydrationService({
      db: harness.db,
      now: () => new Date(FORK_TAX_NOW),
    }).rehydrate(memberId, { rehydrationId: SECOND_FORK_REHYDRATION_ID, document });
    const restored = await harness.db
      .select()
      .from(portfolios)
      .where(eq(portfolios.userId, memberId));
    expect(restored.map((row) => row.id)).toEqual(
      expect.arrayContaining([fixture.forkPortfolioId, secondForkId]),
    );
    // Both copies' replacement transactions are back, each proved against its own
    // membership: the same logical entity, restored twice under two local ids.
    const restoredTransactions = await harness.db.select().from(transactions);
    expect(restoredTransactions.map((row) => row.id)).toEqual(
      expect.arrayContaining([olderEntry.localId, newerEntry.localId]),
    );
  });

  it('rejects forged provenance before the first write and restores zero rows', async () => {
    const fixture = await severedOverdrawnFork();
    const { harness, memberId } = fixture;

    // A chain the account never belonged to, and an op appended after it left.
    const foreignChain = await harness.ctx.mirror.createChain(fixture.ownerId, 'Owner-only chain');
    const [aboveWatermark] = await harness.ctx.mirror.submitTransactionsCreate(
      fixture.ownerId,
      fixture.ownerPortfolioId,
      [
        {
          assetId: FORK_ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 1,
          fee: 0,
          executedAt: '2026-07-28T10:00:00.000Z',
        },
      ],
    );
    if (!aboveWatermark) throw new Error('expected the post-departure chain op');

    const document = await captureAccountDocument(harness, memberId, fixture.provenance);
    const corrected = fixture.provenance.find(
      (entry) => entry.mirrorId === fixture.correctedMirrorId,
    )!;
    const movementEntry = fixture.provenance.find((entry) => entry.kind === 'cash_movement')!;
    const without = (entry: VaultMirrorProvenance) =>
      fixture.provenance.filter((candidate) => candidate !== entry);

    const forgeries: readonly {
      name: string;
      provenance: VaultMirrorProvenance[];
      message: RegExp;
    }[] = [
      {
        name: 'a membership the account never held',
        provenance: fixture.provenance.map((entry) => ({
          ...entry,
          membershipId: UNKNOWN_MEMBERSHIP_ID,
        })),
        message: new RegExp(
          `membershipId="${UNKNOWN_MEMBERSHIP_ID}" is not an ended MIRRORCHAIN membership of the rehydrated account`,
        ),
      },
      {
        name: "another account's chain under a real membership",
        provenance: fixture.provenance.map((entry) => ({
          ...entry,
          chainId: foreignChain.chainId,
        })),
        message: new RegExp(
          `chainId="${foreignChain.chainId}" is not the chain of ended membership ${fixture.membershipId}`,
        ),
      },
      {
        name: 'a second membership claiming one copy',
        provenance: [...without(corrected), { ...corrected, membershipId: UNKNOWN_MEMBERSHIP_ID }],
        message: /claims a copy another membership already owns/,
      },
      {
        name: 'a row kind its operation cannot produce',
        provenance: [
          ...without(movementEntry),
          { ...movementEntry, mirrorId: fixture.correctedMirrorId },
        ],
        message: new RegExp(
          `mirrorProvenance\\[cash_movement:${fixture.correctedMirrorId}\\]\\.kind="cash_movement" contradicts its authoritative tx\\.(create|update) operation at seq \\d+`,
        ),
      },
      {
        name: 'an operation above the ended membership watermark',
        provenance: [...without(corrected), { ...corrected, mirrorId: aboveWatermark.id }],
        message: new RegExp(
          `mirrorProvenance\\[transaction:${aboveWatermark.id}\\]\\.mirrorId="${aboveWatermark.id}" has no chain operation at or below the ended membership watermark \\d+`,
        ),
      },
      {
        name: 'two local rows claiming one logical identity',
        provenance: [...fixture.provenance, { ...corrected, localId: fixture.uncashedBuyLocalId }],
        message: /duplicates a logical identity another local row already claims/,
      },
      {
        name: 'one local row claiming two logical identities',
        provenance: [...fixture.provenance, { ...corrected, mirrorId: UNKNOWN_CHAIN_ID }],
        message: /claims a local row already bound to another logical identity/,
      },
    ];

    await replaceNormalRowsWithServerVault(harness, memberId);
    for (const forgery of forgeries) {
      const mutationTransaction = vi.spyOn(harness.db, 'transaction');
      await expect(
        createParanoidRehydrationService({ db: harness.db }).rehydrate(memberId, {
          rehydrationId: FORK_REHYDRATION_ID,
          document: { ...document, mirrorProvenance: forgery.provenance },
        }),
        forgery.name,
      ).rejects.toThrow(forgery.message);
      expect(mutationTransaction, forgery.name).not.toHaveBeenCalled();
      expect(
        await harness.db.select().from(portfolios).where(eq(portfolios.userId, memberId)),
        forgery.name,
      ).toEqual([]);
      mutationTransaction.mockRestore();
    }
  });
});
