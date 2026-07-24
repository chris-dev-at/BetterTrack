import type { ParanoidDisableRehydrationRequest } from '@bettertrack/contracts';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  assets,
  expenseTransactions,
  priceHistory,
  paranoidRehydrationReceipts,
  paranoidVaultHistory,
  paranoidVaults,
  portfolioCashMovements,
  portfolios,
  standingOrderRuns,
  standingOrders,
  transactions,
  users,
} from '../../../data/schema';
import { expenseDedupHash } from '../../../data/expenseDedup';
import { createTestApp } from '../../../testing/createTestApp';
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
const editedAt = '2026-07-24T10:00:00.000Z';

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
          name: 'Main',
          visibility: 'private',
          sortOrder: 0,
          defaultPayFromCash: false,
          archivedAt: null,
        }),
        entity(ASSET_ID, 'customAsset', {
          providerId: 'manual',
          providerRef: ASSET_ID,
          type: 'custom',
          symbol: 'HOME',
          name: 'House',
          exchange: null,
          currency: 'EUR',
          category: 'other',
          smoothing: false,
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
          quantity: 1,
          price: 100,
          fee: 0,
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
          amountEur: 100,
          transactionId: null,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: editedAt,
          note: null,
          source: 'manual',
        }),
      ],
      mergeLog: [],
    },
  };
}

async function makeParanoid() {
  const harness = await createTestApp();
  const user = await harness.seedUser();
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

  it('restores a custom-asset value point with precision beyond transaction money', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'customAssetValue', {
        assetId: ASSET_ID,
        date: '2026-07-24',
        close: 0.1234567,
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

  it.each([
    'customAssets',
    'portfolios',
    'cashSources',
    'taxSettings',
    'portfolioSettings',
    'transactions',
    'dividends',
    'cashMovements',
    'standingOrders',
    'expenseCategories',
    'expenseTransactions',
    'expenseRules',
    'expenseBudgets',
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

      await expect(service.rehydrate(user.id, request())).rejects.toMatchObject({
        code: 'INJECTED_FAILURE',
      });
      expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
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
        .select({ mode: users.privacyMode })
        .from(users)
        .where(eq(users.id, user.id));
      expect(account?.mode).toBe('paranoid');
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

  it('rejects country-tax history before the restore transaction', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    const transaction = input.document.entities.find((entry) => entry.kind === 'transaction')!;
    if (transaction.kind !== 'transaction') throw new Error('expected transaction');
    transaction.data.side = 'sell';
    transaction.data.allowUncovered = true;
    transaction.data.uncoveredEntryPrice = null;
    transaction.data.taxMode = 'country_specific';
    transaction.data.taxCountry = 'AT';
    transaction.data.taxAmountEur = 0;
    const service = createParanoidRehydrationService({ db });

    await expect(service.rehydrate(user.id, input)).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(await db.select().from(portfolios).where(eq(portfolios.userId, user.id))).toEqual([]);
  });

  it('rejects a tax override before the restore transaction', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'portfolioSetting', {
        portfolioId: PORTFOLIO_ID,
        key: 'tax',
        value: { mode: 'country_specific', country: 'AT' },
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
        quantity: 1,
        price: 100,
        fee: 0,
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
        amountEur: 10,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: editedAt,
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

  it('rebuilds imported expense deduplication markers from restored facts', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'expenseTransaction', {
        categoryId: null,
        direction: 'expense',
        amount: 12.5,
        currency: 'EUR',
        bookedOn: '2026-07-23',
        description: 'Coffee Shop',
        source: 'import:n26',
        createdAt: editedAt,
        updatedAt: editedAt,
      }),
    );
    const service = createParanoidRehydrationService({ db });

    await service.rehydrate(user.id, input);

    const [expense] = await db
      .select({ dedupHash: expenseTransactions.dedupHash })
      .from(expenseTransactions);
    const dedupHash = expenseDedupHash({
      bookedOn: '2026-07-23',
      direction: 'expense',
      amount: 12.5,
      currency: 'EUR',
      description: 'Coffee Shop',
    });
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

  it('rebuilds standing-order watermark and no-replay run marker', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'standingOrder', {
        portfolioId: PORTFOLIO_ID,
        kind: 'cash-add',
        assetId: null,
        amount: 100,
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
    );
    const service = createParanoidRehydrationService({ db });

    await service.rehydrate(user.id, input);

    const [order] = await db
      .select({ lastRunAt: standingOrders.lastRunAt, lastPeriodKey: standingOrders.lastPeriodKey })
      .from(standingOrders);
    expect(order?.lastRunAt?.toISOString()).toBe(editedAt);
    expect(order?.lastPeriodKey).toBe('2026-07-24');
    expect(await db.select().from(standingOrderRuns)).toMatchObject([
      { standingOrderId: '018f0000-0000-7000-8000-00000000000d', periodKey: '2026-07-24' },
    ]);
  });

  it('rejects a dividend without its required gross cash movement before writing', async () => {
    const { db, user } = await makeParanoid();
    const input = request();
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000e', 'dividend', {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        cashSourceId: CASH_SOURCE_ID,
        grossAmountEur: 10,
        executedAt: editedAt,
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
    movement.data.amountEur = -1;
    movement.data.transactionId = TRANSACTION_ID;
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'deposit',
        amountEur: 1,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-24T09:59:59.000Z',
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
    movement.data.amountEur = -75;
    movement.data.transactionId = TRANSACTION_ID;
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'deposit',
        amountEur: 75,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-24T09:59:59.000Z',
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
    movement.data.amountEur = -75;
    movement.data.transactionId = TRANSACTION_ID;
    input.document.entities.push(
      entity('018f0000-0000-7000-8000-00000000000d', 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'deposit',
        amountEur: 75,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-24T09:59:59.000Z',
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
        amountEur: 100,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: editedAt,
        note: null,
        source: 'manual',
      }),
      entity('018f0000-0000-7000-8000-000000000000', 'cashMovement', {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'withdrawal',
        amountEur: -100,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: editedAt,
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
        amountEur: -100,
        transactionId: TRANSACTION_ID,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: editedAt,
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
        amountEur: -100,
        transactionId: null,
        transferId: TRANSFER_ID,
        counterpartSourceId: SECOND_CASH_SOURCE_ID,
        dividendId: null,
        taxYear: null,
        executedAt: editedAt,
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
