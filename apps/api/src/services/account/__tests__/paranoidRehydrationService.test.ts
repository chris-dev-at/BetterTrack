import type { ParanoidDisableRehydrationRequest } from '@bettertrack/contracts';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  assets,
  paranoidRehydrationReceipts,
  paranoidVaultHistory,
  paranoidVaults,
  portfolios,
  users,
} from '../../../data/schema';
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
});
