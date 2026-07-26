import { webcrypto } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  createPortfolio: vi.fn(),
  getPortfolio: vi.fn(),
  updatePortfolio: vi.fn(),
  deletePortfolio: vi.fn(),
  listTransactions: vi.fn(),
  createTransactions: vi.fn(),
  updateTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
  depositCash: vi.fn(),
  withdrawCash: vi.fn(),
}));

import {
  decodeVaultEnvelope,
  vaultEnvelopeHeaderSchema,
  type PortfolioAsset,
  type PortfolioSummary,
  type Transaction,
  type VaultDocumentV1,
  type VaultEntity,
  type VaultEnvelopeHeader,
} from '@bettertrack/contracts';
import { InsufficientCashError } from '@bettertrack/domain/cashLedger';
import { OversellError, reducePosition } from '@bettertrack/domain/holdings';

import * as portfolioApi from '../../lib/portfolioApi';
import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';

import { encryptVaultDocument } from './crypto';
import type {
  DataHome,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from './dataHome';
import {
  createLocalDataHome,
  type LocalDataHome,
  type LocalDataHomeStorage,
  type LocalVaultRecord,
} from './localDataHome';
import { createMemoryVaultQuarantineStore } from './quarantine';
import { createVaultSyncEngine, type VaultSyncEngine, type VaultSyncState } from './sync';
import {
  createVaultPortfolioStore,
  reconcilePortfolioDocument,
  VaultPortfolioStoreError,
} from './vaultPortfolioStore';
import { deterministicRandom, VECTOR_DEVICE_ID, VECTOR_KEY_ID, VECTOR_WRITE_ID } from './vectors';

const DEVICE_ID = VECTOR_DEVICE_ID;
const REMOTE_DEVICE_ID = '018f0000-0000-7000-8000-00000000000e';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000020';
const CASH_SOURCE_ID = '018f0000-0000-7000-8000-000000000021';
const ASSET_ID = '018f0000-0000-7000-8000-000000000022';
const GENERATED_IDS = [
  '018f0000-0000-7000-8000-000000000030',
  '018f0000-0000-7000-8000-000000000031',
  '018f0000-0000-7000-8000-000000000032',
  '018f0000-0000-7000-8000-000000000033',
  '018f0000-0000-7000-8000-000000000034',
  '018f0000-0000-7000-8000-000000000035',
  '018f0000-0000-7000-8000-000000000036',
  '018f0000-0000-7000-8000-000000000037',
  '018f0000-0000-7000-8000-000000000038',
  '018f0000-0000-7000-8000-000000000039',
  '018f0000-0000-7000-8000-00000000003a',
  '018f0000-0000-7000-8000-00000000003b',
] as const;
const AT = '2026-07-25T10:00:00.000Z';
const COMPETING_AT = '2026-07-25T10:00:01.000Z';
const KEY = new Uint8Array(32).fill(9);
const WRAPPED_KEY = {
  keyId: VECTOR_KEY_ID,
  kdf: {
    alg: 'argon2id' as const,
    m: 65536,
    t: 3,
    p: 1,
    salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
  },
  wrappedVk: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

const portfolio: PortfolioSummary = {
  id: PORTFOLIO_ID,
  name: 'Main',
  visibility: 'private',
  sortOrder: 0,
  isDefault: true,
  defaultPayFromCash: false,
  archivedAt: null,
};

const asset: PortfolioAsset = {
  id: ASSET_ID,
  symbol: 'LOCAL',
  name: 'Local Asset',
  exchange: null,
  currency: 'EUR',
  type: 'stock',
  isCustom: true,
  category: 'stock',
  smoothing: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shared PortfolioStore conformance', () => {
  it('runs against the normal-account API implementation', async () => {
    const model = createMemoryPortfolioStore();
    wireApiModel(model);
    await assertPortfolioStoreConformance(apiPortfolioStore);
  });

  it('runs against the authenticated vault implementation', async () => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });
    await assertPortfolioStoreConformance(store);
  });
});

describe('vaultPortfolioStore privacy and correctness boundaries', () => {
  it.each(['locked', 'corrupt'] as const)(
    'fails closed while %s and makes no API or fetch request',
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal('fetch', fetch);
      const engine = createUnavailableEngine(status);
      const store = createVaultPortfolioStore(engine);

      const expectedCode = status === 'locked' ? 'VAULT_LOCKED' : 'VAULT_CORRUPT';
      const readError = await captureError(() => store.listPortfolios());
      const writeError = await captureError(() => store.createPortfolio('Private'));

      expect(readError).toBeInstanceOf(VaultPortfolioStoreError);
      expect(readError).toMatchObject({ code: expectedCode });
      expect(writeError).toBeInstanceOf(VaultPortfolioStoreError);
      expect(writeError).toMatchObject({ code: expectedCode });
      expect(engine.mutate).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expectPortfolioApiUnused();
    },
  );

  it('returns truthful cash balances and rejects an overdraft before mutation', async () => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    await expect(
      store.withdrawCash(PORTFOLIO_ID, { amountEur: 1, sourceId: CASH_SOURCE_ID }),
    ).rejects.toBeInstanceOf(InsufficientCashError);
    expect(engine.state.active?.document.entities.cashMovement).toBeUndefined();

    await expect(
      store.depositCash(PORTFOLIO_ID, { amountEur: 100, sourceId: CASH_SOURCE_ID }),
    ).resolves.toMatchObject({ sourceBalanceEur: 100, balanceEur: 100 });
    await expect(
      store.withdrawCash(PORTFOLIO_ID, { amountEur: 35, sourceId: CASH_SOURCE_ID }),
    ).resolves.toMatchObject({
      movement: { kind: 'withdrawal', amountEur: -35 },
      sourceBalanceEur: 65,
      balanceEur: 65,
    });
  });

  it('orders equal-time cash writes by UUID before validating solvency', async () => {
    const withdrawalId = GENERATED_IDS[0];
    const depositId = GENERATED_IDS[5];
    const document = initialDocument();
    document.entities.cashMovement = [
      vaultEntity(depositId, {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'deposit',
        amountEur: 100,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: AT,
        note: null,
        source: 'manual',
        createdAt: AT,
      }),
    ];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: () => withdrawalId,
    });

    await expect(
      store.withdrawCash(PORTFOLIO_ID, {
        amountEur: 50,
        sourceId: CASH_SOURCE_ID,
        executedAt: AT,
      }),
    ).rejects.toBeInstanceOf(InsufficientCashError);

    expect(engine.state.active?.header.vaultVersion).toBe(1);
    expect(engine.state.active?.document.entities.cashMovement).toEqual([
      expect.objectContaining({ id: depositId, deletedAt: null }),
    ]);
    await expect(store.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      totals: { cashEur: 100, totalValueEur: 100 },
    });
  });

  it('quantizes fractional deposits and floating-point balance residue to exact cents', async () => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    await expect(
      store.depositCash(PORTFOLIO_ID, { amountEur: 0.109, sourceId: CASH_SOURCE_ID }),
    ).resolves.toMatchObject({
      movement: { amountEur: 0.1 },
      sourceBalanceEur: 0.1,
      balanceEur: 0.1,
    });
    await expect(
      store.depositCash(PORTFOLIO_ID, { amountEur: 0.209, sourceId: CASH_SOURCE_ID }),
    ).resolves.toMatchObject({
      movement: { amountEur: 0.2 },
      sourceBalanceEur: 0.3,
      balanceEur: 0.3,
    });
    await expect(store.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      totals: { cashEur: 0.3, totalValueEur: 0.3 },
    });
  });

  it('rejects deleting cash-linked proceeds that fund a later outflow', async () => {
    const buyId = GENERATED_IDS[0];
    const sellId = GENERATED_IDS[1];
    const proceedsId = GENERATED_IDS[2];
    const withdrawalId = GENERATED_IDS[3];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(buyId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 50,
        fee: 0,
        executedAt: '2026-07-25T08:00:00.000Z',
        note: null,
        source: 'manual',
      }),
      vaultEntity(sellId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'sell',
        quantity: 1,
        price: 100,
        fee: 0,
        executedAt: '2026-07-25T09:00:00.000Z',
        note: null,
        source: 'manual',
      }),
    ];
    document.entities.cashMovement = [
      vaultEntity(proceedsId, {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'sell_proceeds',
        amountEur: 100,
        transactionId: sellId,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-25T09:00:00.000Z',
        note: null,
        source: 'manual',
        createdAt: '2026-07-25T09:00:00.000Z',
      }),
      vaultEntity(withdrawalId, {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'withdrawal',
        amountEur: -100,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: AT,
        note: null,
        source: 'manual',
        createdAt: AT,
      }),
    ];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, { now: () => AT });

    await expect(store.deleteTransaction(PORTFOLIO_ID, sellId)).rejects.toBeInstanceOf(
      InsufficientCashError,
    );

    expect(engine.state.active?.header.vaultVersion).toBe(1);
    expect(
      engine.state.active?.document.entities.transaction?.find((row) => row.id === sellId)
        ?.deletedAt,
    ).toBeNull();
    expect(
      engine.state.active?.document.entities.cashMovement?.find((row) => row.id === proceedsId)
        ?.deletedAt,
    ).toBeNull();
  });

  it('tombstones a deleted portfolio and all of its portfolio-scoped children', async () => {
    const secondaryId = GENERATED_IDS[0];
    const transactionId = GENERATED_IDS[1];
    const movementId = GENERATED_IDS[2];
    const standingOrderId = GENERATED_IDS[3];
    const standingOrderRunId = GENERATED_IDS[4];
    const importBatchId = GENERATED_IDS[5];
    const importRowId = GENERATED_IDS[6];
    const dailySnapshotId = GENERATED_IDS[7];
    const snapshotStateId = GENERATED_IDS[8];
    const document = initialDocument();
    document.entities.portfolio = [
      ...(document.entities.portfolio ?? []),
      vaultEntity(secondaryId, {
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
        isDefault: false,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
    ];
    document.entities.transaction = [
      vaultEntity(transactionId, {
        portfolioId: secondaryId,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: AT,
        note: null,
        source: 'manual',
      }),
    ];
    document.entities.cashMovement = [
      vaultEntity(movementId, {
        portfolioId: secondaryId,
        sourceId: CASH_SOURCE_ID,
        kind: 'buy',
        amountEur: -10,
        transactionId,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: AT,
        note: null,
        source: 'manual',
        createdAt: AT,
      }),
    ];
    document.entities.standingOrder = [
      vaultEntity(standingOrderId, {
        portfolioId: secondaryId,
      }),
    ];
    document.entities.standingOrderRun = [
      vaultEntity(standingOrderRunId, {
        standingOrderId,
      }),
    ];
    document.entities.importBatch = [
      vaultEntity(importBatchId, {
        portfolioId: secondaryId,
      }),
    ];
    document.entities.importRow = [
      vaultEntity(importRowId, {
        batchId: importBatchId,
      }),
    ];
    document.entities.portfolioDailySnapshot = [
      vaultEntity(dailySnapshotId, {
        portfolioId: secondaryId,
      }),
    ];
    document.entities.portfolioSnapshotState = [
      vaultEntity(snapshotStateId, {
        portfolioId: secondaryId,
      }),
    ];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    await store.deletePortfolio(secondaryId);

    expect(
      engine.state.active?.document.entities.portfolio?.find((row) => row.id === secondaryId)
        ?.deletedAt,
    ).toBe(AT);
    expect(engine.state.active?.document.entities.transaction?.[0]?.deletedAt).toBe(AT);
    expect(engine.state.active?.document.entities.cashMovement?.[0]?.deletedAt).toBe(AT);
    for (const [kind, id] of [
      ['standingOrder', standingOrderId],
      ['standingOrderRun', standingOrderRunId],
      ['importBatch', importBatchId],
      ['importRow', importRowId],
      ['portfolioDailySnapshot', dailySnapshotId],
      ['portfolioSnapshotState', snapshotStateId],
    ] as const) {
      expect(
        engine.state.active?.document.entities[kind]?.find((entity) => entity.id === id),
      ).toMatchObject({
        deletedAt: AT,
      });
    }
    await expect(store.deletePortfolio(PORTFOLIO_ID)).rejects.toMatchObject({
      code: 'VAULT_LAST_ACTIVE_PORTFOLIO',
    });
  });

  it('promotes the next active portfolio when the default is deleted', async () => {
    const secondaryId = GENERATED_IDS[0];
    const document = initialDocument();
    document.entities.portfolio = [
      ...(document.entities.portfolio ?? []),
      vaultEntity(secondaryId, {
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
        isDefault: false,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
    ];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    await store.deletePortfolio(PORTFOLIO_ID);

    await expect(store.listPortfolios()).resolves.toEqual({
      portfolios: [
        expect.objectContaining({
          id: secondaryId,
          isDefault: true,
        }),
      ],
    });
  });

  it('rejects a complete default-delete group when its successor promotion loses', async () => {
    const secondaryId = GENERATED_IDS[0];
    const document = initialDocument();
    document.entities.portfolio = [
      ...(document.entities.portfolio ?? []),
      vaultEntity(secondaryId, {
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
        isDefault: false,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
    ];
    const { first, second } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-default-delete-race',
    );
    const deletingStore = createVaultPortfolioStore(first, { now: () => AT });
    const editingStore = createVaultPortfolioStore(second, { now: () => AT });

    await expect(
      editingStore.updatePortfolio(secondaryId, { name: 'Concurrent edit' }),
    ).resolves.toMatchObject({ name: 'Concurrent edit', isDefault: false });
    await expect(deletingStore.deletePortfolio(PORTFOLIO_ID)).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });

    await expect(deletingStore.listPortfolios()).resolves.toEqual({
      portfolios: [
        expect.objectContaining({
          id: PORTFOLIO_ID,
          isDefault: true,
        }),
        expect.objectContaining({
          id: secondaryId,
          name: 'Concurrent edit',
          isDefault: false,
        }),
      ],
    });
    expect(
      first.state.active?.document.entities.portfolio?.find((row) => row.id === secondaryId),
    ).toMatchObject({
      rev: 2,
      data: { name: 'Concurrent edit', isDefault: false },
    });

    await second.reconnect();
    await expect(editingStore.listPortfolios()).resolves.toEqual({
      portfolios: [
        expect.objectContaining({
          id: PORTFOLIO_ID,
          isDefault: true,
        }),
        expect.objectContaining({
          id: secondaryId,
          name: 'Concurrent edit',
          isDefault: false,
        }),
      ],
    });
  });

  it('pages transactions from the last emitted row without gaps or duplicates', async () => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });
    const created = await store.createTransactions(
      PORTFOLIO_ID,
      Array.from({ length: 5 }, (_, index) => ({
        assetId: ASSET_ID,
        side: 'buy' as const,
        quantity: index + 1,
        price: 10,
        fee: 0,
        executedAt: `2026-07-25T10:0${index}:00.000Z`,
      })),
    );

    const first = await store.listTransactions(PORTFOLIO_ID, { limit: 2 });
    const second = await store.listTransactions(PORTFOLIO_ID, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    const terminal = await store.listTransactions(PORTFOLIO_ID, {
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    });
    const pagedIds = [...first.items, ...second.items, ...terminal.items].map((row) => row.id);

    expect(first.nextCursor).toBe(first.items.at(-1)?.id);
    expect(second.nextCursor).toBe(second.items.at(-1)?.id);
    expect(terminal.nextCursor).toBeNull();
    expect(pagedIds).toEqual(created.map((row) => row.id).reverse());
    expect(new Set(pagedIds).size).toBe(created.length);
  });

  it('matches API UUIDv7 keysets for backdated rows and a tombstoned cursor', async () => {
    const transactionIds = [GENERATED_IDS[0], GENERATED_IDS[1], GENERATED_IDS[2]] as const;
    const document = initialDocument();
    const transactionData = (executedAt: string) => ({
      portfolioId: PORTFOLIO_ID,
      assetId: ASSET_ID,
      side: 'buy',
      quantity: 1,
      price: 10,
      fee: 0,
      executedAt,
      note: null,
      source: 'manual',
    });
    document.entities.transaction = [
      vaultEntity(transactionIds[0], transactionData('2026-07-25T12:00:00.000Z')),
      vaultEntity(transactionIds[1], transactionData('2020-01-01T00:00:00.000Z')),
      vaultEntity(transactionIds[2], transactionData('2024-01-01T00:00:00.000Z')),
    ];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, { now: () => AT });

    const first = await store.listTransactions(PORTFOLIO_ID, { limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual([transactionIds[2], transactionIds[1]]);
    expect(first.nextCursor).toBe(transactionIds[1]);

    await store.deleteTransaction(PORTFOLIO_ID, transactionIds[1]);
    const second = await store.listTransactions(PORTFOLIO_ID, {
      limit: 2,
      cursor: transactionIds[1],
    });

    expect(second).toEqual({
      items: [expect.objectContaining({ id: transactionIds[0] })],
      nextCursor: null,
    });
  });

  it('rejects a transaction before commit when its local asset snapshot is missing', async () => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    await expect(
      store.createTransactions(PORTFOLIO_ID, [
        {
          assetId: '018f0000-0000-7000-8000-000000000099',
          side: 'buy',
          quantity: 1,
          price: 10,
          fee: 0,
          executedAt: AT,
        },
      ]),
    ).rejects.toMatchObject({ code: 'VAULT_OPERATION_UNAVAILABLE' });
    expect(engine.state.active?.document.entities.transaction).toBeUndefined();
    expect(engine.state.active?.header.vaultVersion).toBe(1);
  });

  it('orders equal-time transactions by UUID before validating holdings', async () => {
    const sellId = GENERATED_IDS[0];
    const buyId = GENERATED_IDS[5];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(buyId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: AT,
        note: null,
        source: 'manual',
      }),
    ];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: () => sellId,
    });

    await expect(
      store.createTransactions(PORTFOLIO_ID, [
        {
          assetId: ASSET_ID,
          side: 'sell',
          quantity: 1,
          price: 12,
          fee: 0,
          executedAt: AT,
        },
      ]),
    ).rejects.toBeInstanceOf(OversellError);

    expect(engine.state.active?.header.vaultVersion).toBe(1);
    expect(engine.state.active?.document.entities.transaction).toEqual([
      expect.objectContaining({ id: buyId, deletedAt: null }),
    ]);
    await expect(store.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      holdings: [expect.objectContaining({ quantity: 1 })],
    });
  });

  it.each([
    [
      'country-specific user default',
      (document: VaultDocumentV1) => {
        document.entities.taxSetting = [
          vaultEntity(GENERATED_IDS[1], {
            userId: GENERATED_IDS[2],
            mode: 'country_specific',
            country: 'DE',
            manualDefaultAmountEur: null,
            manualDefaultRatePct: null,
            customParams: null,
            updatedAt: AT,
          }),
        ];
      },
    ],
    [
      'custom portfolio override',
      (document: VaultDocumentV1) => {
        document.entities.portfolioSetting = [
          vaultEntity(GENERATED_IDS[1], {
            portfolioId: PORTFOLIO_ID,
            key: 'tax',
            value: {
              mode: 'custom',
              custom: {
                ratePct: 25,
                lossOffset: true,
                refund: true,
                yearReset: true,
                carryForward: false,
                costBasis: 'fifo',
              },
            },
            updatedAt: AT,
          }),
        ];
      },
    ],
  ])('rejects an ordinary sell under an effective %s before CAS', async (_label, configure) => {
    const buyId = GENERATED_IDS[0];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(buyId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: '2026-07-25T09:00:00.000Z',
        note: null,
        source: 'manual',
      }),
    ];
    configure(document);
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    await expect(
      store.createTransactions(PORTFOLIO_ID, [
        {
          assetId: ASSET_ID,
          side: 'sell',
          quantity: 1,
          price: 12,
          fee: 0,
          executedAt: AT,
        },
      ]),
    ).rejects.toMatchObject({ code: 'VAULT_OPERATION_UNAVAILABLE' });

    expect(engine.mutate).not.toHaveBeenCalled();
    expect(engine.state.active?.header.vaultVersion).toBe(1);
    expect(engine.state.active?.document.entities.transaction).toHaveLength(1);
  });

  it.each(['country_specific', 'custom'] as const)(
    'rejects turning a covered open-year buy into a sell under effective %s before CAS',
    async (effectiveMode) => {
      const firstBuyId = GENERATED_IDS[0];
      const laterBuyId = GENERATED_IDS[1];
      const document = initialDocument();
      document.entities.transaction = [
        vaultEntity(firstBuyId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 2,
          price: 10,
          fee: 0,
          executedAt: '2026-07-25T08:00:00.000Z',
          note: null,
          source: 'manual',
        }),
        vaultEntity(laterBuyId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 12,
          fee: 0,
          executedAt: '2026-07-25T09:00:00.000Z',
          note: null,
          source: 'manual',
        }),
      ];
      configureEffectiveEngineTaxMode(document, effectiveMode);
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, { now: () => AT });

      await expect(
        store.updateTransaction(PORTFOLIO_ID, laterBuyId, { side: 'sell' }),
      ).rejects.toMatchObject({ code: 'VAULT_OPERATION_UNAVAILABLE' });

      expect(engine.mutate).not.toHaveBeenCalled();
      expect(engine.state.active?.header.vaultVersion).toBe(1);
      expect(
        engine.state.active?.document.entities.transaction?.find(
          (entity) => entity.id === laterBuyId,
        )?.data,
      ).toMatchObject({ side: 'buy', executedAt: '2026-07-25T09:00:00.000Z' });
    },
  );

  it.each([
    ['none', 'country_specific'],
    ['legacy null', 'country_specific'],
    ['none', 'custom'],
    ['legacy null', 'custom'],
  ] as const)(
    'rejects moving a closed %s sell into the open year under effective %s before CAS',
    async (frozenLabel, effectiveMode) => {
      const buyId = GENERATED_IDS[0];
      const sellId = GENERATED_IDS[1];
      const closedExecutedAt = '2025-07-25T09:00:00.000Z';
      const document = initialDocument();
      document.entities.transaction = [
        vaultEntity(buyId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 2,
          price: 10,
          fee: 0,
          executedAt: '2025-07-25T08:00:00.000Z',
          note: null,
          source: 'manual',
        }),
        vaultEntity(sellId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'sell',
          quantity: 1,
          price: 12,
          fee: 0,
          executedAt: closedExecutedAt,
          note: null,
          taxMode: frozenLabel === 'none' ? 'none' : null,
          source: 'manual',
        }),
      ];
      configureEffectiveEngineTaxMode(document, effectiveMode);
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, { now: () => AT });

      await expect(
        store.updateTransaction(PORTFOLIO_ID, sellId, { executedAt: AT }),
      ).rejects.toMatchObject({ code: 'VAULT_OPERATION_UNAVAILABLE' });

      expect(engine.mutate).not.toHaveBeenCalled();
      expect(engine.state.active?.header.vaultVersion).toBe(1);
      expect(
        engine.state.active?.document.entities.transaction?.find((entity) => entity.id === sellId)
          ?.data,
      ).toMatchObject({ side: 'sell', executedAt: closedExecutedAt });
    },
  );

  it.each([
    ['none', 'country_specific'],
    ['legacy null', 'country_specific'],
    ['none', 'custom'],
    ['legacy null', 'custom'],
  ] as const)(
    'rejects an open-year sell frozen as %s after switching to %s across every transaction mutation',
    async (frozenLabel, effectiveMode) => {
      const buyId = GENERATED_IDS[0];
      const sellId = GENERATED_IDS[1];
      const document = initialDocument();
      document.entities.transaction = [
        vaultEntity(buyId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 2,
          price: 10,
          fee: 0,
          executedAt: '2026-07-25T08:00:00.000Z',
          note: null,
          source: 'manual',
        }),
        vaultEntity(sellId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'sell',
          quantity: 1,
          price: 12,
          fee: 0,
          executedAt: '2026-07-25T09:00:00.000Z',
          note: null,
          taxMode: frozenLabel === 'none' ? 'none' : null,
          source: 'manual',
        }),
      ];
      if (effectiveMode === 'country_specific') {
        document.entities.taxSetting = [
          vaultEntity(GENERATED_IDS[2], {
            userId: GENERATED_IDS[3],
            mode: 'country_specific',
            country: 'DE',
            manualDefaultAmountEur: null,
            manualDefaultRatePct: null,
            customParams: null,
            updatedAt: AT,
          }),
        ];
      } else {
        document.entities.portfolioSetting = [
          vaultEntity(GENERATED_IDS[2], {
            portfolioId: PORTFOLIO_ID,
            key: 'tax',
            value: {
              mode: 'custom',
              custom: {
                ratePct: 25,
                lossOffset: true,
                refund: true,
                yearReset: true,
                carryForward: false,
                costBasis: 'fifo',
              },
            },
            updatedAt: AT,
          }),
        ];
      }
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, {
        now: () => AT,
        newId: () => GENERATED_IDS[4],
      });
      const unavailable = { code: 'VAULT_OPERATION_UNAVAILABLE' };

      await expect(
        store.createTransactions(PORTFOLIO_ID, [
          {
            assetId: ASSET_ID,
            side: 'buy',
            quantity: 1,
            price: 9,
            fee: 0,
            executedAt: '2026-07-25T07:00:00.000Z',
          },
        ]),
      ).rejects.toMatchObject(unavailable);
      await expect(
        store.updateTransaction(PORTFOLIO_ID, buyId, { price: 11 }),
      ).rejects.toMatchObject(unavailable);
      await expect(store.deleteTransaction(PORTFOLIO_ID, sellId)).rejects.toMatchObject(
        unavailable,
      );

      expect(engine.mutate).not.toHaveBeenCalled();
      expect(engine.state.active?.header.vaultVersion).toBe(1);
      expect(engine.state.active?.document.entities.transaction).toEqual(
        document.entities.transaction,
      );
    },
  );

  it('keeps closed pre-engine rows available after switching to an engine tax mode', async () => {
    const buyId = GENERATED_IDS[0];
    const sellId = GENERATED_IDS[1];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(buyId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 2,
        price: 10,
        fee: 0,
        executedAt: '2025-07-25T08:00:00.000Z',
        note: null,
        source: 'manual',
      }),
      vaultEntity(sellId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'sell',
        quantity: 1,
        price: 12,
        fee: 0,
        executedAt: '2025-07-25T09:00:00.000Z',
        note: null,
        taxMode: null,
        source: 'manual',
      }),
    ];
    document.entities.portfolioSetting = [
      vaultEntity(GENERATED_IDS[2], {
        portfolioId: PORTFOLIO_ID,
        key: 'tax',
        value: {
          mode: 'custom',
          custom: {
            ratePct: 25,
            lossOffset: true,
            refund: true,
            yearReset: true,
            carryForward: false,
            costBasis: 'fifo',
          },
        },
        updatedAt: AT,
      }),
    ];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: () => GENERATED_IDS[3],
    });

    await expect(
      store.createTransactions(PORTFOLIO_ID, [
        {
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 9,
          fee: 0,
          executedAt: '2025-07-25T07:00:00.000Z',
        },
      ]),
    ).resolves.toHaveLength(1);
    await expect(
      store.updateTransaction(PORTFOLIO_ID, buyId, { price: 11 }),
    ).resolves.toMatchObject({ id: buyId, price: 11 });
    await expect(store.deleteTransaction(PORTFOLIO_ID, sellId)).resolves.toBeUndefined();

    expect(engine.mutate).toHaveBeenCalledTimes(3);
    expectPortfolioApiUnused();
  });

  it.each(['country_specific', 'custom'] as const)(
    'keeps a buy after the final frozen %s sell available across create, update, and delete',
    async (frozenMode) => {
      const firstBuyId = GENERATED_IDS[0];
      const sellId = GENERATED_IDS[1];
      const laterBuyId = GENERATED_IDS[2];
      const document = initialDocument();
      document.entities.transaction = [
        vaultEntity(firstBuyId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 2,
          price: 10,
          fee: 0,
          executedAt: '2026-07-25T08:00:00.000Z',
          note: null,
          source: 'manual',
        }),
        vaultEntity(sellId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'sell',
          quantity: 1,
          price: 12,
          fee: 0,
          executedAt: '2026-07-25T09:00:00.000Z',
          note: null,
          taxMode: frozenMode,
          taxCountry: frozenMode === 'country_specific' ? 'DE' : null,
          taxAmountEur: 1,
          taxParams: frozenMode === 'custom' ? { ratePct: 25 } : null,
          source: 'manual',
        }),
      ];
      configureEffectiveEngineTaxMode(document, frozenMode);
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, {
        now: () => AT,
        newId: () => laterBuyId,
      });

      await expect(
        store.createTransactions(PORTFOLIO_ID, [
          {
            assetId: ASSET_ID,
            side: 'buy',
            quantity: 1,
            price: 9,
            fee: 0,
            executedAt: AT,
          },
        ]),
      ).resolves.toEqual([expect.objectContaining({ id: laterBuyId, price: 9 })]);
      await expect(
        store.updateTransaction(PORTFOLIO_ID, laterBuyId, { price: 11 }),
      ).resolves.toMatchObject({ id: laterBuyId, price: 11 });
      await expect(store.deleteTransaction(PORTFOLIO_ID, laterBuyId)).resolves.toBeUndefined();

      expect(engine.mutate).toHaveBeenCalledTimes(3);
      expect(
        engine.state.active?.document.entities.transaction?.find(
          (entity) => entity.id === laterBuyId,
        ),
      ).toMatchObject({ deletedAt: AT });
      expectPortfolioApiUnused();
    },
  );

  it.each(['country_specific', 'custom'] as const)(
    'creates an equal-time buy ordered after a frozen %s sell by id',
    async (frozenMode) => {
      const firstBuyId = GENERATED_IDS[0];
      const sellId = GENERATED_IDS[1];
      const laterBuyId = GENERATED_IDS[2];
      const document = initialDocument();
      document.entities.transaction = [
        vaultEntity(firstBuyId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 2,
          price: 10,
          fee: 0,
          executedAt: '2026-07-25T08:00:00.000Z',
          note: null,
          source: 'manual',
        }),
        vaultEntity(sellId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'sell',
          quantity: 1,
          price: 12,
          fee: 0,
          executedAt: AT,
          note: null,
          taxMode: frozenMode,
          taxCountry: frozenMode === 'country_specific' ? 'DE' : null,
          taxAmountEur: 1,
          taxParams: frozenMode === 'custom' ? { ratePct: 25 } : null,
          source: 'manual',
        }),
      ];
      configureEffectiveEngineTaxMode(document, frozenMode);
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, {
        now: () => AT,
        newId: () => laterBuyId,
      });

      await expect(
        store.createTransactions(PORTFOLIO_ID, [
          {
            assetId: ASSET_ID,
            side: 'buy',
            quantity: 1,
            price: 9,
            fee: 0,
            executedAt: AT,
          },
        ]),
      ).resolves.toEqual([expect.objectContaining({ id: laterBuyId })]);

      expect(engine.mutate).toHaveBeenCalledOnce();
      expectPortfolioApiUnused();
    },
  );

  it.each(['country_specific', 'custom'] as const)(
    'rejects an equal-time buy ordered before a frozen %s sell by id before CAS',
    async (frozenMode) => {
      const firstBuyId = GENERATED_IDS[0];
      const earlierBuyId = GENERATED_IDS[1];
      const sellId = GENERATED_IDS[2];
      const document = initialDocument();
      document.entities.transaction = [
        vaultEntity(firstBuyId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 2,
          price: 10,
          fee: 0,
          executedAt: '2026-07-25T08:00:00.000Z',
          note: null,
          source: 'manual',
        }),
        vaultEntity(sellId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'sell',
          quantity: 1,
          price: 12,
          fee: 0,
          executedAt: AT,
          note: null,
          taxMode: frozenMode,
          taxCountry: frozenMode === 'country_specific' ? 'DE' : null,
          taxAmountEur: 1,
          taxParams: frozenMode === 'custom' ? { ratePct: 25 } : null,
          source: 'manual',
        }),
      ];
      configureEffectiveEngineTaxMode(document, frozenMode);
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, {
        now: () => AT,
        newId: () => earlierBuyId,
      });

      await expect(
        store.createTransactions(PORTFOLIO_ID, [
          {
            assetId: ASSET_ID,
            side: 'buy',
            quantity: 1,
            price: 9,
            fee: 0,
            executedAt: AT,
          },
        ]),
      ).rejects.toMatchObject({ code: 'VAULT_OPERATION_UNAVAILABLE' });

      expect(engine.mutate).not.toHaveBeenCalled();
      expect(engine.state.active?.header.vaultVersion).toBe(1);
      expect(
        engine.state.active?.document.entities.transaction?.some(
          (entity) => entity.id === earlierBuyId,
        ),
      ).toBe(false);
      expectPortfolioApiUnused();
    },
  );

  it.each(['country_specific', 'custom'] as const)(
    'rejects moving a later buy across a frozen %s sell before CAS',
    async (frozenMode) => {
      const firstBuyId = GENERATED_IDS[0];
      const sellId = GENERATED_IDS[1];
      const laterBuyId = GENERATED_IDS[2];
      const laterExecutedAt = '2026-07-25T11:00:00.000Z';
      const document = initialDocument();
      document.entities.transaction = [
        vaultEntity(firstBuyId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 2,
          price: 10,
          fee: 0,
          executedAt: '2026-07-25T08:00:00.000Z',
          note: null,
          source: 'manual',
        }),
        vaultEntity(sellId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'sell',
          quantity: 1,
          price: 12,
          fee: 0,
          executedAt: '2026-07-25T09:00:00.000Z',
          note: null,
          taxMode: frozenMode,
          taxCountry: frozenMode === 'country_specific' ? 'DE' : null,
          taxAmountEur: 1,
          taxParams: frozenMode === 'custom' ? { ratePct: 25 } : null,
          source: 'manual',
        }),
        vaultEntity(laterBuyId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 9,
          fee: 0,
          executedAt: laterExecutedAt,
          note: null,
          source: 'manual',
        }),
      ];
      configureEffectiveEngineTaxMode(document, frozenMode);
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, { now: () => AT });

      await expect(
        store.updateTransaction(PORTFOLIO_ID, laterBuyId, {
          executedAt: '2026-07-25T08:30:00.000Z',
        }),
      ).rejects.toMatchObject({ code: 'VAULT_OPERATION_UNAVAILABLE' });

      expect(engine.mutate).not.toHaveBeenCalled();
      expect(
        engine.state.active?.document.entities.transaction?.find(
          (entity) => entity.id === laterBuyId,
        )?.data.executedAt,
      ).toBe(laterExecutedAt);
      expectPortfolioApiUnused();
    },
  );

  it('rejects frozen-tax reshapes before CAS even after settings change', async () => {
    const buyId = GENERATED_IDS[0];
    const sellId = GENERATED_IDS[1];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(buyId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 2,
        price: 10,
        fee: 0,
        executedAt: '2026-07-25T08:00:00.000Z',
        note: null,
        source: 'manual',
      }),
      vaultEntity(sellId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'sell',
        quantity: 1,
        price: 12,
        fee: 0,
        executedAt: '2026-07-25T09:00:00.000Z',
        note: null,
        taxMode: 'country_specific',
        taxCountry: 'DE',
        taxAmountEur: 0,
        taxParams: null,
        source: 'manual',
      }),
    ];
    document.entities.portfolioSetting = [
      vaultEntity(GENERATED_IDS[2], {
        portfolioId: PORTFOLIO_ID,
        key: 'tax',
        value: { mode: 'none' },
        updatedAt: AT,
      }),
    ];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: () => GENERATED_IDS[3],
    });
    const unavailable = { code: 'VAULT_OPERATION_UNAVAILABLE' };

    await expect(
      store.createTransactions(PORTFOLIO_ID, [
        {
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 9,
          fee: 0,
          executedAt: '2026-07-25T07:00:00.000Z',
        },
      ]),
    ).rejects.toMatchObject(unavailable);
    await expect(store.updateTransaction(PORTFOLIO_ID, buyId, { price: 11 })).rejects.toMatchObject(
      unavailable,
    );
    await expect(store.deleteTransaction(PORTFOLIO_ID, buyId)).rejects.toMatchObject(unavailable);
    await expect(
      store.updateTransaction(PORTFOLIO_ID, sellId, { price: 13 }),
    ).rejects.toMatchObject(unavailable);
    await expect(store.deleteTransaction(PORTFOLIO_ID, sellId)).rejects.toMatchObject(unavailable);

    expect(engine.mutate).not.toHaveBeenCalled();
    expect(engine.state.active?.header.vaultVersion).toBe(1);
  });

  it('keeps note-only edits on frozen-tax rows available without API fallback', async () => {
    const buyId = GENERATED_IDS[0];
    const sellId = GENERATED_IDS[1];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(buyId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: '2026-07-25T08:00:00.000Z',
        note: null,
        source: 'manual',
      }),
      vaultEntity(sellId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'sell',
        quantity: 1,
        price: 12,
        fee: 0,
        executedAt: '2026-07-25T09:00:00.000Z',
        note: null,
        taxMode: 'custom',
        taxCountry: null,
        taxAmountEur: 1,
        taxParams: { ratePct: 25 },
        source: 'manual',
      }),
    ];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, { now: () => AT });

    await expect(
      store.updateTransaction(PORTFOLIO_ID, sellId, { note: 'Still frozen' }),
    ).resolves.toMatchObject({ id: sellId, note: 'Still frozen' });

    expect(engine.mutate).toHaveBeenCalledTimes(1);
    expect(
      engine.state.active?.document.entities.transaction?.find((row) => row.id === sellId)?.data,
    ).toMatchObject({ taxMode: 'custom', taxAmountEur: 1, note: 'Still frozen' });
    expectPortfolioApiUnused();
  });

  it.each([
    ['side', { side: 'sell' as const }],
    ['quantity', { quantity: 2 }],
    ['price', { price: 20 }],
    ['fee', { fee: 1 }],
    ['execution time', { executedAt: '2026-07-26T10:00:00.000Z' }],
  ])('rejects a cash-linked %s edit without starting a CAS mutation', async (_label, patch) => {
    const transactionId = GENERATED_IDS[0];
    const depositId = GENERATED_IDS[1];
    const buyMovementId = GENERATED_IDS[2];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(transactionId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: AT,
        note: null,
        source: 'manual',
      }),
    ];
    document.entities.cashMovement = [
      vaultEntity(depositId, {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'deposit',
        amountEur: 10,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-25T09:00:00.000Z',
        note: null,
        source: 'manual',
        createdAt: '2026-07-25T09:00:00.000Z',
      }),
      vaultEntity(buyMovementId, {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'buy',
        amountEur: -10,
        transactionId,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: AT,
        note: null,
        source: 'manual',
        createdAt: AT,
      }),
    ];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, { now: () => AT });

    await expect(store.updateTransaction(PORTFOLIO_ID, transactionId, patch)).rejects.toMatchObject(
      {
        code: 'VAULT_OPERATION_UNAVAILABLE',
      },
    );

    expect(engine.mutate).not.toHaveBeenCalled();
    expect(engine.state.active?.header.vaultVersion).toBe(1);
    expect(
      engine.state.active?.document.entities.transaction?.find((row) => row.id === transactionId)
        ?.data,
    ).toMatchObject({ side: 'buy', quantity: 1, price: 10, fee: 0, executedAt: AT });
  });

  it('drops optional undefined patch fields instead of persisting JSON-damaged entities', async () => {
    const transactionId = GENERATED_IDS[0];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(transactionId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 7,
        executedAt: AT,
        note: 'Original',
        source: 'manual',
      }),
    ];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, { now: () => AT });

    await expect(
      store.updatePortfolio(PORTFOLIO_ID, {
        name: undefined,
        visibility: undefined,
        defaultPayFromCash: undefined,
      }),
    ).resolves.toEqual(portfolio);
    await expect(
      store.updateTransaction(PORTFOLIO_ID, transactionId, {
        fee: undefined,
        note: undefined,
      }),
    ).resolves.toMatchObject({ fee: 7, note: 'Original' });

    expect(engine.mutate).not.toHaveBeenCalled();
    expect(engine.state.active?.document.entities.portfolio?.[0]?.data).toEqual(portfolio);
    expect(engine.state.active?.document.entities.transaction?.[0]?.data).toMatchObject({
      fee: 7,
      note: 'Original',
    });
  });

  it('rejects a divergent sell before publishing an oversold merged vault', async () => {
    const buyId = GENERATED_IDS[0];
    const firstSellId = GENERATED_IDS[1];
    const secondSellId = GENERATED_IDS[2];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(buyId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: '2026-07-25T09:00:00.000Z',
        note: null,
        source: 'manual',
      }),
    ];
    const { first, second } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-divergent-sells',
    );
    const firstStore = createVaultPortfolioStore(first, {
      now: () => AT,
      newId: () => firstSellId,
    });
    const secondStore = createVaultPortfolioStore(second, {
      now: () => AT,
      newId: () => secondSellId,
    });
    const sell = {
      assetId: ASSET_ID,
      side: 'sell' as const,
      quantity: 1,
      price: 12,
      fee: 0,
      executedAt: AT,
    };

    await expect(firstStore.createTransactions(PORTFOLIO_ID, [sell])).resolves.toMatchObject([
      { id: firstSellId },
    ]);
    await expect(secondStore.createTransactions(PORTFOLIO_ID, [sell])).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });

    expect(
      second.state.active?.document.entities.transaction?.find((row) => row.id === secondSellId),
    ).toMatchObject({ deletedAt: AT, rev: 1 });
    await expect(secondStore.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      holdings: [expect.objectContaining({ quantity: 0 })],
    });
    await first.reconnect();
    await expect(firstStore.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      holdings: [expect.objectContaining({ quantity: 0 })],
    });
  });

  it('repairs an overselling offline branch before publishing it on reconnect', async () => {
    const buyId = GENERATED_IDS[0];
    const remoteSellId = GENERATED_IDS[1];
    const offlineSellId = GENERATED_IDS[2];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(buyId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: '2026-07-25T09:00:00.000Z',
        note: null,
        source: 'manual',
      }),
    ];
    const { first, second, remote } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-offline-sells',
    );
    const firstStore = createVaultPortfolioStore(first, {
      now: () => AT,
      newId: () => remoteSellId,
    });
    const secondStore = createVaultPortfolioStore(second, {
      now: () => AT,
      newId: () => offlineSellId,
    });
    const sell = {
      assetId: ASSET_ID,
      side: 'sell' as const,
      quantity: 1,
      price: 12,
      fee: 0,
      executedAt: AT,
    };

    remote.setOnline(false);
    await expect(secondStore.createTransactions(PORTFOLIO_ID, [sell])).resolves.toMatchObject([
      { id: offlineSellId },
    ]);
    remote.setOnline(true);
    await expect(firstStore.createTransactions(PORTFOLIO_ID, [sell])).resolves.toMatchObject([
      { id: remoteSellId },
    ]);

    await expect(second.reconnect()).resolves.toMatchObject({ status: 'synced' });
    expect(
      second.state.active?.document.entities.transaction?.find((row) => row.id === offlineSellId),
    ).toMatchObject({ deletedAt: AT, rev: 1 });
    await expect(secondStore.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      holdings: [expect.objectContaining({ quantity: 0 })],
    });
    await first.reconnect();
    await expect(firstStore.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      holdings: [expect.objectContaining({ quantity: 0 })],
    });
  });

  it('reconciles a persisted atomic batch before a restarted engine can publish it', async () => {
    const buyId = GENERATED_IDS[0];
    const remoteSellId = GENERATED_IDS[1];
    const firstOfflineSellId = GENERATED_IDS[2];
    const secondOfflineSellId = GENERATED_IDS[3];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(buyId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 2,
        price: 10,
        fee: 0,
        executedAt: '2026-07-25T09:00:00.000Z',
        note: null,
        source: 'manual',
      }),
    ];
    const envelope = await encrypted(document, 1);
    const remoteLocal = createLocalDataHome({
      scope: 'portfolio-store-restart-atomic-remote',
      storage: memoryLocalStorage(),
    });
    const pendingLocal = createLocalDataHome({
      scope: 'portfolio-store-restart-atomic-pending',
      storage: memoryLocalStorage(),
    });
    await Promise.all([seedLocal(remoteLocal, envelope), seedLocal(pendingLocal, envelope)]);
    const remote = memoryRemote(envelope, 1);
    const remoteEngine = createVaultSyncEngine({
      local: remoteLocal,
      primary: remote,
      vaultKey: KEY,
      deviceId: DEVICE_ID,
      writeId: writeIdSequence(0x20),
      now: () => AT,
      quarantine: createMemoryVaultQuarantineStore(),
      documentReconciler: reconcilePortfolioDocument,
    });
    const offlineEngine = createVaultSyncEngine({
      local: pendingLocal,
      primary: remote,
      vaultKey: KEY,
      deviceId: REMOTE_DEVICE_ID,
      writeId: writeIdSequence(0x60),
      now: () => AT,
      quarantine: createMemoryVaultQuarantineStore(),
      documentReconciler: reconcilePortfolioDocument,
    });
    await Promise.all([remoteEngine.start(), offlineEngine.start()]);
    const remoteStore = createVaultPortfolioStore(remoteEngine, {
      now: () => AT,
      newId: () => remoteSellId,
    });
    let offlineNow = AT;
    const offlineStore = createVaultPortfolioStore(offlineEngine, {
      now: () => offlineNow,
      newId: idSequenceFrom(firstOfflineSellId, secondOfflineSellId),
    });
    const sell = {
      assetId: ASSET_ID,
      side: 'sell' as const,
      quantity: 1,
      price: 12,
      fee: 0,
      executedAt: AT,
    };

    remote.setOnline(false);
    await expect(
      offlineStore.createTransactions(PORTFOLIO_ID, [sell, sell]),
    ).resolves.toMatchObject([{ id: firstOfflineSellId }, { id: secondOfflineSellId }]);
    offlineNow = COMPETING_AT;
    await expect(
      offlineStore.updateTransaction(PORTFOLIO_ID, firstOfflineSellId, {
        note: 'Edited after the atomic batch',
      }),
    ).resolves.toMatchObject({
      id: firstOfflineSellId,
      note: 'Edited after the atomic batch',
    });

    remote.setOnline(true);
    await expect(remoteStore.createTransactions(PORTFOLIO_ID, [sell])).resolves.toMatchObject([
      { id: remoteSellId },
    ]);

    const restarted = createVaultSyncEngine({
      local: pendingLocal,
      primary: remote,
      vaultKey: KEY,
      deviceId: REMOTE_DEVICE_ID,
      writeId: writeIdSequence(0xa0),
      now: () => AT,
      quarantine: createMemoryVaultQuarantineStore(),
      documentReconciler: reconcilePortfolioDocument,
    });
    await expect(restarted.start()).resolves.toMatchObject({ status: 'synced' });

    const restartedTransactions = restarted.state.active?.document.entities.transaction ?? [];
    expect(restartedTransactions.find((row) => row.id === firstOfflineSellId)).toMatchObject({
      deletedAt: AT,
    });
    expect(restartedTransactions.find((row) => row.id === secondOfflineSellId)).toMatchObject({
      deletedAt: AT,
    });
    const restartedStore = createVaultPortfolioStore(restarted, { now: () => AT });
    await expect(restartedStore.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      holdings: [expect.objectContaining({ quantity: 1 })],
    });

    await remoteEngine.reconnect();
    await expect(remoteStore.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      holdings: [expect.objectContaining({ quantity: 1 })],
    });
  });

  it('keeps independent same-millisecond mutations in separate reconciliation groups', async () => {
    const buyId = GENERATED_IDS[0];
    const remoteSellId = GENERATED_IDS[1];
    const firstOfflineSellId = GENERATED_IDS[2];
    const secondOfflineSellId = GENERATED_IDS[3];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(buyId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 2,
        price: 10,
        fee: 0,
        executedAt: '2026-07-25T09:00:00.000Z',
        note: null,
        source: 'manual',
      }),
    ];
    const { first, second, remote } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-same-millisecond-independent-sells',
    );
    const remoteStore = createVaultPortfolioStore(first, {
      now: () => AT,
      newId: () => remoteSellId,
    });
    const offlineStore = createVaultPortfolioStore(second, {
      now: () => AT,
      newId: idSequenceFrom(firstOfflineSellId, secondOfflineSellId),
    });
    const sell = {
      assetId: ASSET_ID,
      side: 'sell' as const,
      quantity: 1,
      price: 12,
      fee: 0,
      executedAt: AT,
    };

    remote.setOnline(false);
    await expect(offlineStore.createTransactions(PORTFOLIO_ID, [sell])).resolves.toMatchObject([
      { id: firstOfflineSellId },
    ]);
    await expect(offlineStore.createTransactions(PORTFOLIO_ID, [sell])).resolves.toMatchObject([
      { id: secondOfflineSellId },
    ]);
    remote.setOnline(true);
    await expect(remoteStore.createTransactions(PORTFOLIO_ID, [sell])).resolves.toMatchObject([
      { id: remoteSellId },
    ]);

    await expect(second.reconnect()).resolves.toMatchObject({ status: 'synced' });
    const localRows = second.state.active?.document.entities.transaction ?? [];
    expect(
      [firstOfflineSellId, secondOfflineSellId].filter(
        (id) => localRows.find((row) => row.id === id)?.deletedAt === null,
      ),
    ).toHaveLength(1);
    expect(
      [firstOfflineSellId, secondOfflineSellId].filter(
        (id) => localRows.find((row) => row.id === id)?.deletedAt !== null,
      ),
    ).toHaveLength(1);
    await expect(offlineStore.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      holdings: [expect.objectContaining({ quantity: 0 })],
    });
  });

  it('rejects a divergent withdrawal before any negative merged ledger is persisted', async () => {
    const depositId = GENERATED_IDS[0];
    const firstWithdrawalId = GENERATED_IDS[1];
    const secondWithdrawalId = GENERATED_IDS[2];
    const document = initialDocument();
    document.entities.cashMovement = [
      vaultEntity(depositId, {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'deposit',
        amountEur: 100,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-25T09:00:00.000Z',
        note: null,
        source: 'manual',
        createdAt: '2026-07-25T09:00:00.000Z',
      }),
    ];
    const { first, second } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-divergent-withdrawals',
    );
    const firstStore = createVaultPortfolioStore(first, {
      now: () => AT,
      newId: () => firstWithdrawalId,
    });
    const secondStore = createVaultPortfolioStore(second, {
      now: () => AT,
      newId: () => secondWithdrawalId,
    });

    await expect(
      firstStore.withdrawCash(PORTFOLIO_ID, {
        amountEur: 80,
        sourceId: CASH_SOURCE_ID,
      }),
    ).resolves.toMatchObject({ sourceBalanceEur: 20, balanceEur: 20 });
    await expect(
      secondStore.withdrawCash(PORTFOLIO_ID, {
        amountEur: 80,
        sourceId: CASH_SOURCE_ID,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_DATA_UNAVAILABLE' });

    expect(
      second.state.active?.document.entities.cashMovement?.find(
        (row) => row.id === secondWithdrawalId,
      ),
    ).toMatchObject({ deletedAt: AT, rev: 1 });
    await expect(secondStore.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      totals: { cashEur: 20, totalValueEur: 20 },
    });
    await first.reconnect();
    await expect(firstStore.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      totals: { cashEur: 20, totalValueEur: 20 },
    });
  });

  it('collapses concurrent first deposits onto one reachable Main cash source', async () => {
    const firstSourceId = GENERATED_IDS[0];
    const firstDepositId = GENERATED_IDS[1];
    const secondSourceId = GENERATED_IDS[2];
    const secondDepositId = GENERATED_IDS[3];
    const withdrawalId = GENERATED_IDS[4];
    const document = initialDocument();
    delete document.entities.cashSource;
    const { first, second } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-concurrent-main-source',
    );
    const firstStore = createVaultPortfolioStore(first, {
      now: () => AT,
      newId: idSequenceFrom(firstSourceId, firstDepositId),
    });
    const secondStore = createVaultPortfolioStore(second, {
      now: () => AT,
      newId: idSequenceFrom(secondSourceId, secondDepositId, withdrawalId),
    });

    await expect(firstStore.depositCash(PORTFOLIO_ID, { amountEur: 40 })).resolves.toMatchObject({
      movement: { id: firstDepositId, sourceId: firstSourceId },
      sourceBalanceEur: 40,
      balanceEur: 40,
    });
    await expect(secondStore.depositCash(PORTFOLIO_ID, { amountEur: 60 })).resolves.toMatchObject({
      movement: { id: secondDepositId, sourceId: firstSourceId },
      sourceBalanceEur: 100,
      balanceEur: 100,
    });

    const cashSources = second.state.active?.document.entities.cashSource ?? [];
    expect(cashSources.filter((row) => row.deletedAt === null)).toEqual([
      expect.objectContaining({
        id: firstSourceId,
        data: expect.objectContaining({ isMain: true }),
      }),
    ]);
    expect(cashSources.find((row) => row.id === secondSourceId)).toMatchObject({
      deletedAt: AT,
      rev: 1,
    });
    expect(
      second.state.active?.document.entities.cashMovement
        ?.filter((row) => row.deletedAt === null)
        .map((row) => row.data.sourceId),
    ).toEqual([firstSourceId, firstSourceId]);

    await expect(secondStore.withdrawCash(PORTFOLIO_ID, { amountEur: 90 })).resolves.toMatchObject({
      movement: { id: withdrawalId, sourceId: firstSourceId },
      sourceBalanceEur: 10,
      balanceEur: 10,
    });
    await first.reconnect();
    await expect(firstStore.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      totals: { cashEur: 10, totalValueEur: 10 },
    });
  });

  it('keeps one active portfolio when two devices delete distinct final portfolios', async () => {
    const secondaryId = GENERATED_IDS[0];
    const document = initialDocument();
    document.entities.portfolio = [
      vaultEntity(PORTFOLIO_ID, { ...portfolio, isDefault: false }),
      vaultEntity(secondaryId, {
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
        isDefault: false,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
    ];
    const { first, second } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-divergent-deletes',
    );
    const firstStore = createVaultPortfolioStore(first, { now: () => AT });
    const secondStore = createVaultPortfolioStore(second, { now: () => AT });

    await expect(firstStore.deletePortfolio(PORTFOLIO_ID)).resolves.toBeUndefined();
    await expect(secondStore.deletePortfolio(secondaryId)).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });

    await expect(secondStore.listPortfolios()).resolves.toEqual({
      portfolios: [expect.objectContaining({ id: secondaryId })],
    });
    await first.reconnect();
    await expect(firstStore.listPortfolios()).resolves.toEqual({
      portfolios: [expect.objectContaining({ id: secondaryId })],
    });
  });

  it('rejects a complete portfolio-delete group when a concurrent child edit wins', async () => {
    const secondaryId = GENERATED_IDS[0];
    const transactionId = GENERATED_IDS[1];
    const document = initialDocument();
    document.entities.portfolio = [
      ...(document.entities.portfolio ?? []),
      vaultEntity(secondaryId, {
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
        isDefault: false,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
    ];
    document.entities.transaction = [
      vaultEntity(transactionId, {
        portfolioId: secondaryId,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: AT,
        note: null,
        source: 'manual',
      }),
    ];
    const { first, second } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-delete-child-race',
    );
    const firstStore = createVaultPortfolioStore(first, { now: () => AT });
    const secondStore = createVaultPortfolioStore(second, { now: () => AT });

    await expect(
      firstStore.updateTransaction(secondaryId, transactionId, { note: 'Concurrent edit' }),
    ).resolves.toMatchObject({ note: 'Concurrent edit' });
    await expect(secondStore.deletePortfolio(secondaryId)).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });

    expect(
      second.state.active?.document.entities.portfolio?.find((row) => row.id === secondaryId),
    ).toMatchObject({ deletedAt: null, rev: 2 });
    expect(
      second.state.active?.document.entities.transaction?.find((row) => row.id === transactionId),
    ).toMatchObject({
      deletedAt: null,
      rev: 2,
      data: expect.objectContaining({ note: 'Concurrent edit' }),
    });
    await expect(secondStore.listTransactions(secondaryId)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: transactionId, note: 'Concurrent edit' })],
    });
    await first.reconnect();
    await expect(firstStore.listPortfolios()).resolves.toEqual({
      portfolios: [
        expect.objectContaining({ id: PORTFOLIO_ID }),
        expect.objectContaining({ id: secondaryId }),
      ],
    });
  });

  it('rejects child tombstones when a concurrent parent edit beats the delete cascade', async () => {
    const secondaryId = GENERATED_IDS[0];
    const transactionId = GENERATED_IDS[1];
    const document = initialDocument();
    document.entities.portfolio = [
      ...(document.entities.portfolio ?? []),
      vaultEntity(secondaryId, {
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
        isDefault: false,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
    ];
    document.entities.transaction = [
      vaultEntity(transactionId, {
        portfolioId: secondaryId,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: AT,
        note: null,
        source: 'manual',
      }),
    ];
    const { first, second } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-delete-parent-race',
    );
    const editingStore = createVaultPortfolioStore(first, { now: () => COMPETING_AT });
    const deletingStore = createVaultPortfolioStore(second, { now: () => AT });

    await expect(
      editingStore.updatePortfolio(secondaryId, { name: 'Remote parent edit' }),
    ).resolves.toMatchObject({ name: 'Remote parent edit' });
    await expect(deletingStore.deletePortfolio(secondaryId)).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });

    const localDocument = second.state.active?.document;
    expect(localDocument?.entities.portfolio?.find((row) => row.id === secondaryId)).toMatchObject({
      deletedAt: null,
      rev: 2,
      data: expect.objectContaining({ name: 'Remote parent edit' }),
    });
    expect(
      localDocument?.entities.transaction?.find((row) => row.id === transactionId),
    ).toMatchObject({ deletedAt: null, rev: 2 });
    await expect(deletingStore.listTransactions(secondaryId)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: transactionId })],
    });

    await first.reconnect();
    await second.reconnect();
    expect(first.state.active?.document.entities.portfolio).toEqual(
      second.state.active?.document.entities.portfolio,
    );
    expect(first.state.active?.document.entities.transaction).toEqual(
      second.state.active?.document.entities.transaction,
    );
    await expect(editingStore.listTransactions(secondaryId)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: transactionId })],
    });
  });

  it('rejects a portfolio delete when direct or recursive snapshot/import/order descendants win', async () => {
    const secondaryId = GENERATED_IDS[0];
    const standingOrderId = GENERATED_IDS[1];
    const standingOrderRunId = GENERATED_IDS[2];
    const importBatchId = GENERATED_IDS[3];
    const importRowId = GENERATED_IDS[4];
    const dailySnapshotId = GENERATED_IDS[5];
    const snapshotStateId = GENERATED_IDS[6];
    const document = initialDocument();
    document.entities.portfolio = [
      ...(document.entities.portfolio ?? []),
      vaultEntity(secondaryId, {
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
        isDefault: false,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
    ];
    document.entities.standingOrder = [
      vaultEntity(standingOrderId, {
        portfolioId: secondaryId,
        marker: 'initial',
      }),
    ];
    document.entities.standingOrderRun = [
      vaultEntity(standingOrderRunId, {
        standingOrderId,
        marker: 'initial',
      }),
    ];
    document.entities.importBatch = [
      vaultEntity(importBatchId, {
        portfolioId: secondaryId,
        marker: 'initial',
      }),
    ];
    document.entities.importRow = [
      vaultEntity(importRowId, {
        batchId: importBatchId,
        marker: 'initial',
      }),
    ];
    document.entities.portfolioDailySnapshot = [
      vaultEntity(dailySnapshotId, {
        portfolioId: secondaryId,
        marker: 'initial',
      }),
    ];
    document.entities.portfolioSnapshotState = [
      vaultEntity(snapshotStateId, {
        portfolioId: secondaryId,
        marker: 'initial',
      }),
    ];
    const { first, second } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-complete-descendant-race',
    );
    const deletingStore = createVaultPortfolioStore(second, { now: () => AT });

    const descendantIds = new Set<string>([
      standingOrderId,
      standingOrderRunId,
      importBatchId,
      importRowId,
      dailySnapshotId,
      snapshotStateId,
    ]);
    await expect(
      first.mutate(({ document: current }) => ({
        ...current,
        entities: Object.fromEntries(
          Object.entries(current.entities).map(([kind, entities]) => [
            kind,
            entities.map((entity) =>
              descendantIds.has(entity.id)
                ? {
                    ...entity,
                    rev: entity.rev + 1,
                    editedAt: COMPETING_AT,
                    editedBy: first.deviceId,
                    data: { ...entity.data, marker: 'concurrent' },
                  }
                : entity,
            ),
          ]),
        ),
      })),
    ).resolves.toMatchObject({ status: 'synced' });

    await expect(deletingStore.deletePortfolio(secondaryId)).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });
    for (const [kind, id] of [
      ['standingOrder', standingOrderId],
      ['standingOrderRun', standingOrderRunId],
      ['importBatch', importBatchId],
      ['importRow', importRowId],
      ['portfolioDailySnapshot', dailySnapshotId],
      ['portfolioSnapshotState', snapshotStateId],
    ] as const) {
      expect(
        second.state.active?.document.entities[kind]?.find((entity) => entity.id === id),
      ).toMatchObject({
        deletedAt: null,
        data: expect.objectContaining({ marker: 'concurrent' }),
      });
    }

    await first.reconnect();
    await second.reconnect();
    for (const kind of [
      'portfolio',
      'standingOrder',
      'standingOrderRun',
      'importBatch',
      'importRow',
      'portfolioDailySnapshot',
      'portfolioSnapshotState',
    ] as const) {
      expect(first.state.active?.document.entities[kind]).toEqual(
        second.state.active?.document.entities[kind],
      );
    }
  });

  it.each(['transaction', 'cash movement'] as const)(
    'rejects a linked transaction deletion when the concurrent %s member wins',
    async (winner) => {
      const transactionId = GENERATED_IDS[0];
      const depositId = GENERATED_IDS[1];
      const buyMovementId = GENERATED_IDS[2];
      const document = initialDocument();
      document.entities.transaction = [
        vaultEntity(transactionId, {
          portfolioId: PORTFOLIO_ID,
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 10,
          fee: 0,
          executedAt: '2026-07-25T09:00:00.000Z',
          note: null,
          source: 'manual',
        }),
      ];
      document.entities.cashMovement = [
        vaultEntity(depositId, {
          portfolioId: PORTFOLIO_ID,
          sourceId: CASH_SOURCE_ID,
          kind: 'deposit',
          amountEur: 20,
          transactionId: null,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: '2026-07-25T08:00:00.000Z',
          note: null,
          source: 'manual',
          createdAt: '2026-07-25T08:00:00.000Z',
        }),
        vaultEntity(buyMovementId, {
          portfolioId: PORTFOLIO_ID,
          sourceId: CASH_SOURCE_ID,
          kind: 'buy',
          amountEur: -10,
          transactionId,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: '2026-07-25T09:00:00.000Z',
          note: null,
          source: 'manual',
          createdAt: '2026-07-25T09:00:00.000Z',
        }),
      ];
      const { first, second } = await createConcurrentSyncEngines(
        document,
        `portfolio-store-linked-delete-${winner.replace(' ', '-')}`,
      );
      const editingStore = createVaultPortfolioStore(first, { now: () => COMPETING_AT });
      const deletingStore = createVaultPortfolioStore(second, { now: () => AT });

      if (winner === 'transaction') {
        await expect(
          editingStore.updateTransaction(PORTFOLIO_ID, transactionId, {
            note: 'Remote transaction edit',
          }),
        ).resolves.toMatchObject({ note: 'Remote transaction edit' });
      } else {
        await expect(
          first.mutate(({ document: current }) => ({
            ...current,
            entities: {
              ...current.entities,
              cashMovement: (current.entities.cashMovement ?? []).map((entity) =>
                entity.id === buyMovementId
                  ? {
                      ...entity,
                      rev: entity.rev + 1,
                      editedAt: COMPETING_AT,
                      editedBy: first.deviceId,
                      data: { ...entity.data, note: 'Remote cash edit' },
                    }
                  : entity,
              ),
            },
          })),
        ).resolves.toMatchObject({ status: 'synced' });
      }

      await expect(
        deletingStore.deleteTransaction(PORTFOLIO_ID, transactionId),
      ).rejects.toMatchObject({
        code: 'VAULT_DATA_UNAVAILABLE',
      });

      const localDocument = second.state.active?.document;
      expect(
        localDocument?.entities.transaction?.find((row) => row.id === transactionId),
      ).toMatchObject({
        deletedAt: null,
        rev: 2,
        data: expect.objectContaining({
          note: winner === 'transaction' ? 'Remote transaction edit' : null,
        }),
      });
      expect(
        localDocument?.entities.cashMovement?.find((row) => row.id === buyMovementId),
      ).toMatchObject({
        deletedAt: null,
        rev: 2,
        data: expect.objectContaining({
          note: winner === 'cash movement' ? 'Remote cash edit' : null,
        }),
      });
      await expect(deletingStore.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
        holdings: [expect.objectContaining({ quantity: 1 })],
        totals: { cashEur: 10, totalValueEur: 10 },
      });

      await first.reconnect();
      await second.reconnect();
      expect(first.state.active?.document.entities.transaction).toEqual(
        second.state.active?.document.entities.transaction,
      );
      expect(first.state.active?.document.entities.cashMovement).toEqual(
        second.state.active?.document.entities.cashMovement,
      );
      await expect(editingStore.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
        holdings: [expect.objectContaining({ quantity: 1 })],
        totals: { cashEur: 10, totalValueEur: 10 },
      });
    },
  );

  it('uses browser-safe UUIDv7 identities and never serves vault reads from the API', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, { now: () => AT });

    const created = await store.createPortfolio('Generated id');
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await expect(store.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
      baseCurrency: 'EUR',
      holdings: [],
      totals: { cashEur: 0, totalValueEur: 0 },
    });
    expect(fetch).not.toHaveBeenCalled();
    expectPortfolioApiUnused();
  });

  it('reads positions and cash from the authenticated vault without API fallback', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });
    await store.createTransactions(PORTFOLIO_ID, [
      {
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 2,
        price: 10,
        fee: 2,
        executedAt: AT,
      },
    ]);
    await store.depositCash(PORTFOLIO_ID, {
      amountEur: 12.34,
      sourceId: CASH_SOURCE_ID,
    });

    await expect(store.getPortfolio(PORTFOLIO_ID)).resolves.toEqual({
      baseCurrency: 'EUR',
      holdings: [
        {
          asset,
          quantity: 2,
          avgCost: 11,
          realizedPnl: 0,
          price: null,
          marketValueEur: null,
          costBasisEur: null,
          unrealizedPnlEur: null,
          unrealizedPnlPct: null,
          dayChangeEur: null,
          dayChangePct: null,
        },
      ],
      totals: {
        marketValueEur: 0,
        investedEur: 0,
        unrealizedPnlEur: 0,
        unrealizedPnlPct: null,
        dayChangeEur: 0,
        dayChangePct: null,
        cashEur: 12.34,
        totalValueEur: 12.34,
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    expectPortfolioApiUnused();
  });

  it('writes every mutation through consecutive local and remote CAS versions', async () => {
    const initial = initialDocument();
    const envelope = await encrypted(initial, 1);
    const storage = memoryLocalStorage();
    const durableLocal = createLocalDataHome({ scope: 'portfolio-store-cas', storage });
    await seedLocal(durableLocal, envelope);
    const localExpectedVersions: (number | null)[] = [];
    const local: LocalDataHome = {
      ...durableLocal,
      async write(next, options) {
        localExpectedVersions.push(options.ifVersion);
        return durableLocal.write(next, options);
      },
    };
    const remote = memoryRemote(envelope, 1);
    const engine = createVaultSyncEngine({
      local,
      primary: remote,
      vaultKey: KEY,
      deviceId: DEVICE_ID,
      writeId: writeIdSequence(),
      now: () => AT,
      quarantine: createMemoryVaultQuarantineStore(),
      documentReconciler: reconcilePortfolioDocument,
    });
    await expect(engine.start()).resolves.toMatchObject({ status: 'synced' });
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    const createdPortfolio = await store.createPortfolio('Secondary');
    await store.updatePortfolio(createdPortfolio.id, { name: 'Renamed' });
    await store.deletePortfolio(createdPortfolio.id);
    const [createdTransaction] = await store.createTransactions(PORTFOLIO_ID, [
      {
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 2,
        price: 10,
        fee: 0,
        executedAt: AT,
      },
    ]);
    expect(createdTransaction?.asset).toEqual(asset);
    expect(
      engine.state.active?.document.entities.transaction?.find(
        (row) => row.id === createdTransaction?.id,
      )?.editedBy,
    ).toBe(DEVICE_ID);
    await store.updateTransaction(PORTFOLIO_ID, createdTransaction!.id, { note: 'Edited' });
    await store.deleteTransaction(PORTFOLIO_ID, createdTransaction!.id);
    await store.depositCash(PORTFOLIO_ID, { amountEur: 50, sourceId: CASH_SOURCE_ID });
    await store.withdrawCash(PORTFOLIO_ID, { amountEur: 20, sourceId: CASH_SOURCE_ID });

    expect(localExpectedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(remote.expectedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(engine.state.active?.header.vaultVersion).toBe(9);
  });

  it('does not report success when existing portfolio and transaction updates are uncommitted', async () => {
    const transactionId = GENERATED_IDS[0];
    const document = initialDocument();
    document.entities.transaction = [
      vaultEntity(transactionId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: AT,
        note: null,
        source: 'manual',
      }),
    ];
    const stable = createMutableEngine(document, false);
    const store = createVaultPortfolioStore(stable, {
      now: () => AT,
      newId: idSequence(),
    });

    await expect(store.createPortfolio('Not committed')).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });
    await expect(
      store.updatePortfolio(PORTFOLIO_ID, { name: 'Not committed' }),
    ).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });
    await expect(
      store.updateTransaction(PORTFOLIO_ID, transactionId, { note: 'Not committed' }),
    ).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });

    await expect(store.listPortfolios()).resolves.toEqual({ portfolios: [portfolio] });
    await expect(store.listTransactions(PORTFOLIO_ID)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: transactionId, note: null })],
    });
  });

  it('rejects a portfolio update when competing edit metadata wins for the same payload', async () => {
    const initial = initialDocument();
    const competing = initialDocument();
    const competingPortfolio = competing.entities.portfolio?.[0];
    if (competingPortfolio == null) throw new Error('Missing portfolio fixture.');
    competing.entities.portfolio = [
      {
        ...competingPortfolio,
        rev: 1,
        editedAt: COMPETING_AT,
        editedBy: REMOTE_DEVICE_ID,
        data: { ...competingPortfolio.data, name: 'Requested' },
      },
    ];
    const { engine, remote } = await createRacingSyncEngine(
      initial,
      competing,
      'portfolio-store-portfolio-race',
    );
    const store = createVaultPortfolioStore(engine, { now: () => AT });

    await expect(store.updatePortfolio(PORTFOLIO_ID, { name: 'Requested' })).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });

    expect(remote.expectedVersions).toEqual([1, 2]);
    expect(engine.state.active?.document.entities.portfolio?.[0]).toMatchObject({
      rev: 2,
      editedAt: AT,
      editedBy: DEVICE_ID,
      data: { name: 'Requested' },
    });
    await expect(store.listPortfolios()).resolves.toEqual({
      portfolios: [{ ...portfolio, name: 'Requested' }],
    });
  });

  it('rejects a transaction update when a competing same-id edit wins reconciliation', async () => {
    const transactionId = GENERATED_IDS[0];
    const transaction = vaultEntity(transactionId, {
      portfolioId: PORTFOLIO_ID,
      assetId: ASSET_ID,
      side: 'buy',
      quantity: 1,
      price: 10,
      fee: 0,
      executedAt: AT,
      note: null,
      source: 'manual',
    });
    const initial = initialDocument();
    initial.entities.transaction = [transaction];
    const competing = initialDocument();
    competing.entities.transaction = [
      {
        ...transaction,
        rev: 1,
        editedAt: COMPETING_AT,
        editedBy: REMOTE_DEVICE_ID,
        data: { ...transaction.data, note: 'Competing' },
      },
    ];
    const { engine, remote } = await createRacingSyncEngine(
      initial,
      competing,
      'portfolio-store-transaction-race',
    );
    const store = createVaultPortfolioStore(engine, { now: () => AT });

    await expect(
      store.updateTransaction(PORTFOLIO_ID, transactionId, { note: 'Requested' }),
    ).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });

    expect(remote.expectedVersions).toEqual([1, 2]);
    expect(engine.state.active?.document.entities.transaction?.[0]).toMatchObject({
      rev: 2,
      editedAt: AT,
      editedBy: DEVICE_ID,
      data: { note: 'Competing' },
    });
    await expect(store.listTransactions(PORTFOLIO_ID)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: transactionId, note: 'Competing' })],
    });
  });
});

async function assertPortfolioStoreConformance(store: PortfolioStore): Promise<void> {
  await expect(store.listPortfolios()).resolves.toEqual({ portfolios: [portfolio] });
  await expect(store.getPortfolio(PORTFOLIO_ID)).resolves.toEqual({
    baseCurrency: 'EUR',
    holdings: [],
    totals: {
      marketValueEur: 0,
      investedEur: 0,
      unrealizedPnlEur: 0,
      unrealizedPnlPct: null,
      dayChangeEur: 0,
      dayChangePct: null,
      cashEur: 0,
      totalValueEur: 0,
    },
  });

  const createdPortfolio = await store.createPortfolio('Secondary');
  expect(createdPortfolio).toMatchObject({ name: 'Secondary', visibility: 'private' });
  await expect(store.depositCash(createdPortfolio.id, { amountEur: 25 })).resolves.toMatchObject({
    movement: {
      kind: 'deposit',
      amountEur: 25,
      sourceId: expect.any(String),
    },
    sourceBalanceEur: 25,
    balanceEur: 25,
  });
  await expect(store.getPortfolio(createdPortfolio.id)).resolves.toMatchObject({
    totals: { cashEur: 25, totalValueEur: 25 },
  });
  const updatedPortfolio = await store.updatePortfolio(createdPortfolio.id, { name: 'Renamed' });
  expect(updatedPortfolio.name).toBe('Renamed');
  expect((await store.listPortfolios()).portfolios.map((row) => row.id)).toContain(
    createdPortfolio.id,
  );
  await store.deletePortfolio(createdPortfolio.id);
  expect((await store.listPortfolios()).portfolios.map((row) => row.id)).not.toContain(
    createdPortfolio.id,
  );

  await expect(
    store.createTransactions(PORTFOLIO_ID, [
      {
        assetId: ASSET_ID,
        side: 'sell',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: AT,
      },
    ]),
  ).rejects.toBeDefined();
  await expect(store.listTransactions(PORTFOLIO_ID)).resolves.toMatchObject({ items: [] });

  const [createdTransaction] = await store.createTransactions(PORTFOLIO_ID, [
    {
      assetId: ASSET_ID,
      side: 'buy',
      quantity: 2,
      price: 10,
      fee: 0,
      executedAt: AT,
    },
  ]);
  expect(createdTransaction).toMatchObject({
    assetId: ASSET_ID,
    source: 'manual',
    asset,
  });
  const listed = await store.listTransactions(PORTFOLIO_ID, { source: 'manual' });
  expect(listed.items.map((row) => row.id)).toEqual([createdTransaction!.id]);
  await expect(
    store.updateTransaction(PORTFOLIO_ID, createdTransaction!.id, { note: 'Edited' }),
  ).resolves.toMatchObject({ note: 'Edited' });
  const [createdSell] = await store.createTransactions(PORTFOLIO_ID, [
    {
      assetId: ASSET_ID,
      side: 'sell',
      quantity: 2,
      price: 12,
      fee: 0,
      executedAt: '2026-07-25T11:00:00.000Z',
    },
  ]);
  await expect(
    store.updateTransaction(PORTFOLIO_ID, createdSell!.id, { quantity: 3 }),
  ).rejects.toBeDefined();
  expect(
    (await store.listTransactions(PORTFOLIO_ID)).items.find((row) => row.id === createdSell!.id),
  ).toMatchObject({ quantity: 2 });
  await expect(store.deleteTransaction(PORTFOLIO_ID, createdTransaction!.id)).rejects.toBeDefined();
  expect((await store.listTransactions(PORTFOLIO_ID)).items).toHaveLength(2);
  await store.deleteTransaction(PORTFOLIO_ID, createdSell!.id);
  await store.deleteTransaction(PORTFOLIO_ID, createdTransaction!.id);
  await expect(store.listTransactions(PORTFOLIO_ID)).resolves.toMatchObject({ items: [] });

  await expect(
    store.depositCash(PORTFOLIO_ID, { amountEur: 100, sourceId: CASH_SOURCE_ID }),
  ).resolves.toMatchObject({
    movement: { kind: 'deposit', amountEur: 100, sourceId: CASH_SOURCE_ID },
    sourceBalanceEur: 100,
    balanceEur: 100,
  });
  await expect(
    store.withdrawCash(PORTFOLIO_ID, { amountEur: 35, sourceId: CASH_SOURCE_ID }),
  ).resolves.toMatchObject({
    movement: { kind: 'withdrawal', amountEur: -35, sourceId: CASH_SOURCE_ID },
    sourceBalanceEur: 65,
    balanceEur: 65,
  });
  await expect(store.getPortfolio(PORTFOLIO_ID)).resolves.toMatchObject({
    totals: { cashEur: 65, totalValueEur: 65 },
  });
}

function createMemoryPortfolioStore(): PortfolioStore {
  let portfolios = [portfolio];
  let transactions: Transaction[] = [];
  const cashBalances = new Map<string, number>([[PORTFOLIO_ID, 0]]);
  const mainCashSources = new Map<string, string>([[PORTFOLIO_ID, CASH_SOURCE_ID]]);
  const ids = idSequence();

  return {
    async listPortfolios(_signal, includeArchived = false) {
      return {
        portfolios: portfolios.filter((row) => includeArchived || row.archivedAt === null),
      };
    },
    async createPortfolio(name) {
      const created: PortfolioSummary = {
        id: ids(),
        name,
        visibility: 'private',
        sortOrder: portfolios.length,
        isDefault: false,
        defaultPayFromCash: false,
        archivedAt: null,
      };
      portfolios = [...portfolios, created];
      cashBalances.set(created.id, 0);
      mainCashSources.set(created.id, ids());
      return created;
    },
    async getPortfolio(portfolioId) {
      const cashBalance = cashBalances.get(portfolioId);
      if (cashBalance == null) throw new Error('Portfolio not found.');
      return {
        baseCurrency: 'EUR',
        holdings: [],
        totals: {
          marketValueEur: 0,
          investedEur: 0,
          unrealizedPnlEur: 0,
          unrealizedPnlPct: null,
          dayChangeEur: 0,
          dayChangePct: null,
          cashEur: cashBalance,
          totalValueEur: cashBalance,
        },
      };
    },
    async updatePortfolio(id, patch) {
      const current = portfolios.find((row) => row.id === id);
      if (current == null) throw new Error('Portfolio not found.');
      const updated = { ...current, ...patch };
      portfolios = portfolios.map((row) => (row.id === id ? updated : row));
      return updated;
    },
    async deletePortfolio(id) {
      portfolios = portfolios.filter((row) => row.id !== id);
      cashBalances.delete(id);
      mainCashSources.delete(id);
    },
    async listTransactions(portfolioId, params = {}) {
      const filtered = transactions.filter(
        (row) =>
          portfolioId === PORTFOLIO_ID && (params.source == null || row.source === params.source),
      );
      return { items: filtered.slice(0, params.limit), nextCursor: null };
    },
    async createTransactions(portfolioId, inputs) {
      if (portfolioId !== PORTFOLIO_ID) throw new Error('Portfolio not found.');
      const created = inputs.map(
        (input): Transaction => ({
          id: ids(),
          assetId: input.assetId,
          side: input.side,
          quantity: input.quantity,
          price: input.price,
          fee: input.fee,
          executedAt: input.executedAt,
          note: input.note ?? null,
          allowUncovered: input.allowUncovered ?? false,
          uncoveredEntryPrice: input.uncoveredEntryPrice ?? null,
          source: 'manual',
          asset,
        }),
      );
      const candidate = [...created, ...transactions];
      for (const assetId of new Set(created.map((row) => row.assetId))) {
        reducePosition(candidate.filter((row) => row.assetId === assetId));
      }
      transactions = candidate;
      return created;
    },
    async updateTransaction(portfolioId, id, patch) {
      const current = transactions.find((row) => portfolioId === PORTFOLIO_ID && row.id === id);
      if (current == null) throw new Error('Transaction not found.');
      const { baseSeq: _baseSeq, ...dataPatch } = patch;
      const updated = { ...current, ...dataPatch };
      const candidate = transactions.map((row) => (row.id === id ? updated : row));
      reducePosition(candidate.filter((row) => row.assetId === current.assetId));
      transactions = candidate;
      return updated;
    },
    async deleteTransaction(portfolioId, id) {
      const current = transactions.find((row) => portfolioId === PORTFOLIO_ID && row.id === id);
      if (current == null) throw new Error('Transaction not found.');
      const candidate = transactions.filter((row) => portfolioId !== PORTFOLIO_ID || row.id !== id);
      reducePosition(candidate.filter((row) => row.assetId === current.assetId));
      transactions = candidate;
    },
    async depositCash(portfolioId, body) {
      const cashBalance = cashBalances.get(portfolioId);
      const sourceId = body.sourceId ?? mainCashSources.get(portfolioId);
      if (cashBalance == null || sourceId == null) throw new Error('Portfolio not found.');
      const nextBalance = cashBalance + body.amountEur;
      cashBalances.set(portfolioId, nextBalance);
      return {
        movement: memoryMovement(ids(), 'deposit', body.amountEur, { ...body, sourceId }),
        sourceBalanceEur: nextBalance,
        balanceEur: nextBalance,
      };
    },
    async withdrawCash(portfolioId, body) {
      const cashBalance = cashBalances.get(portfolioId);
      const sourceId = body.sourceId ?? mainCashSources.get(portfolioId);
      if (cashBalance == null || sourceId == null) throw new Error('Portfolio not found.');
      if (body.amountEur > cashBalance) throw new Error('Insufficient cash.');
      const nextBalance = cashBalance - body.amountEur;
      cashBalances.set(portfolioId, nextBalance);
      return {
        movement: memoryMovement(ids(), 'withdrawal', -body.amountEur, { ...body, sourceId }),
        sourceBalanceEur: nextBalance,
        balanceEur: nextBalance,
      };
    },
  };
}

function memoryMovement(
  id: string,
  kind: 'deposit' | 'withdrawal',
  amountEur: number,
  body: { sourceId?: string; executedAt?: string; note?: string | null },
) {
  return {
    id,
    kind,
    amountEur,
    sourceId: body.sourceId ?? CASH_SOURCE_ID,
    transactionId: null,
    transferId: null,
    counterpartSourceId: null,
    dividendId: null,
    taxYear: null,
    executedAt: body.executedAt ?? AT,
    note: body.note ?? null,
    source: 'manual' as const,
    createdAt: AT,
  };
}

function wireApiModel(model: PortfolioStore): void {
  vi.mocked(portfolioApi.listPortfolios).mockImplementation(model.listPortfolios);
  vi.mocked(portfolioApi.createPortfolio).mockImplementation(model.createPortfolio);
  vi.mocked(portfolioApi.getPortfolio).mockImplementation(model.getPortfolio);
  vi.mocked(portfolioApi.updatePortfolio).mockImplementation(model.updatePortfolio);
  vi.mocked(portfolioApi.deletePortfolio).mockImplementation(model.deletePortfolio);
  vi.mocked(portfolioApi.listTransactions).mockImplementation(model.listTransactions);
  vi.mocked(portfolioApi.createTransactions).mockImplementation(model.createTransactions);
  vi.mocked(portfolioApi.updateTransaction).mockImplementation(model.updateTransaction);
  vi.mocked(portfolioApi.deleteTransaction).mockImplementation(model.deleteTransaction);
  vi.mocked(portfolioApi.depositCash).mockImplementation(model.depositCash);
  vi.mocked(portfolioApi.withdrawCash).mockImplementation(model.withdrawCash);
}

function configureEffectiveEngineTaxMode(
  document: VaultDocumentV1,
  mode: 'country_specific' | 'custom',
): void {
  if (mode === 'country_specific') {
    document.entities.taxSetting = [
      vaultEntity(GENERATED_IDS[10], {
        userId: GENERATED_IDS[11],
        mode,
        country: 'DE',
        manualDefaultAmountEur: null,
        manualDefaultRatePct: null,
        customParams: null,
        updatedAt: AT,
      }),
    ];
    return;
  }
  document.entities.portfolioSetting = [
    vaultEntity(GENERATED_IDS[10], {
      portfolioId: PORTFOLIO_ID,
      key: 'tax',
      value: {
        mode,
        custom: {
          ratePct: 25,
          lossOffset: true,
          refund: true,
          yearReset: true,
          carryForward: false,
          costBasis: 'fifo',
        },
      },
      updatedAt: AT,
    }),
  ];
}

function initialDocument(): VaultDocumentV1 {
  return {
    schemaVersion: 1,
    entities: {
      portfolio: [vaultEntity(PORTFOLIO_ID, portfolio)],
      cashSource: [
        vaultEntity(CASH_SOURCE_ID, {
          portfolioId: PORTFOLIO_ID,
          name: 'Main',
          type: 'cash',
          isMain: true,
          archivedAt: null,
          createdAt: AT,
        }),
      ],
      customAsset: [vaultEntity(ASSET_ID, asset)],
    },
    mergeLog: [],
  };
}

function vaultEntity(id: string, data: Record<string, unknown>): VaultEntity {
  return {
    id,
    rev: 0,
    editedAt: AT,
    editedBy: REMOTE_DEVICE_ID,
    deletedAt: null,
    data,
  };
}

function createMutableEngine(document: VaultDocumentV1, commit = true): VaultSyncEngine {
  const home = inertHome();
  let version = 1;
  let state: VaultSyncState = {
    status: 'synced',
    active: {
      home,
      envelope: new Uint8Array(),
      header: fullHeader(version),
      document,
    },
    pending: null,
  };
  const mutate = vi.fn<VaultSyncEngine['mutate']>(async (mutator) => {
    const next = mutator({ document: state.active!.document, currentVersion: version });
    if (commit) {
      version += 1;
      state = {
        status: 'synced',
        active: {
          home,
          envelope: new Uint8Array(),
          header: fullHeader(version),
          document: next,
        },
        pending: null,
      };
    }
    return state;
  });

  return {
    deviceId: DEVICE_ID,
    get state() {
      return state;
    },
    async start() {
      return state;
    },
    async reconnect() {
      return state;
    },
    mutate,
  };
}

function createUnavailableEngine(status: 'locked' | 'corrupt'): VaultSyncEngine {
  const base = createMutableEngine(initialDocument());
  const state: VaultSyncState = {
    ...base.state,
    status,
    active: status === 'locked' ? null : base.state.active,
  };
  return {
    deviceId: base.deviceId,
    state,
    start: vi.fn(async () => state),
    reconnect: vi.fn(async () => state),
    mutate: vi.fn(async () => state),
  };
}

function inertHome(): DataHome {
  return {
    medium: 'local',
    async read() {
      return { status: 'absent', medium: 'local' };
    },
    async info() {
      return { status: 'absent', medium: 'local' };
    },
    async write() {
      return { status: 'conflict', medium: 'local', currentVersion: null };
    },
  };
}

function fullHeader(version: number): VaultEnvelopeHeader {
  return {
    formatVersion: 1,
    cipher: 'A256GCM',
    iv: 'AAAAAAAAAAAAAAAA',
    keyId: VECTOR_KEY_ID,
    wrappedKeys: [WRAPPED_KEY],
    vaultVersion: version,
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    writeId: VECTOR_WRITE_ID,
    writtenAt: AT,
  };
}

async function encrypted(document: VaultDocumentV1, version: number): Promise<Uint8Array> {
  return (
    await encryptVaultDocument({
      document,
      vaultKey: KEY,
      header: {
        keyId: VECTOR_KEY_ID,
        wrappedKeys: [WRAPPED_KEY],
        vaultVersion: version,
        deviceId: DEVICE_ID,
        writeId: VECTOR_WRITE_ID,
        writtenAt: AT,
      },
      randomBytes: deterministicRandom(version * 17),
    })
  ).envelope;
}

interface MemoryRemote extends DataHome {
  expectedVersions: (number | null)[];
  setOnline(online: boolean): void;
}

interface MemoryRemoteRace {
  envelope: Uint8Array;
  version: number;
}

function memoryRemote(
  initial: Uint8Array,
  initialVersion: number,
  race?: MemoryRemoteRace,
): MemoryRemote {
  let envelope = initial.slice();
  let version = initialVersion;
  let pendingRace =
    race == null ? null : { envelope: race.envelope.slice(), version: race.version };
  let online = true;
  const expectedVersions: (number | null)[] = [];
  return {
    medium: 'server',
    expectedVersions,
    setOnline(value) {
      online = value;
    },
    async read(): Promise<DataHomeReadResult> {
      if (!online) {
        return {
          status: 'transport-failure',
          medium: 'server',
          failure: { message: 'Remote is offline.' },
        };
      }
      return {
        status: 'ok',
        medium: 'server',
        envelope: envelope.slice(),
        info: {
          medium: 'server',
          version,
          sizeBytes: envelope.byteLength,
          updatedAt: AT,
        },
      };
    },
    async info() {
      if (!online) {
        return {
          status: 'transport-failure' as const,
          medium: 'server' as const,
          failure: { message: 'Remote is offline.' },
        };
      }
      return {
        status: 'ok' as const,
        medium: 'server' as const,
        info: {
          medium: 'server' as const,
          version,
          sizeBytes: envelope.byteLength,
          updatedAt: AT,
        },
      };
    },
    async write(next: Uint8Array, options: DataHomeWriteOptions): Promise<DataHomeWriteResult> {
      expectedVersions.push(options.ifVersion);
      if (!online) {
        return {
          status: 'transport-failure',
          medium: 'server',
          failure: { message: 'Remote is offline.' },
        };
      }
      if (pendingRace != null) {
        envelope = pendingRace.envelope;
        version = pendingRace.version;
        pendingRace = null;
        return { status: 'conflict', medium: 'server', currentVersion: version };
      }
      if (options.ifVersion !== version) {
        return { status: 'conflict', medium: 'server', currentVersion: version };
      }
      const header = vaultEnvelopeHeaderSchema.parse(decodeVaultEnvelope(next).header);
      envelope = next.slice();
      version = header.vaultVersion;
      return {
        status: 'ok',
        medium: 'server',
        info: {
          medium: 'server',
          version,
          sizeBytes: envelope.byteLength,
          updatedAt: AT,
        },
      };
    },
  };
}

async function createRacingSyncEngine(
  initial: VaultDocumentV1,
  competing: VaultDocumentV1,
  scope: string,
): Promise<{ engine: VaultSyncEngine; remote: MemoryRemote }> {
  const initialEnvelope = await encrypted(initial, 1);
  const competingEnvelope = await encrypted(competing, 2);
  const local = createLocalDataHome({ scope, storage: memoryLocalStorage() });
  await seedLocal(local, initialEnvelope);
  const remote = memoryRemote(initialEnvelope, 1, {
    envelope: competingEnvelope,
    version: 2,
  });
  const engine = createVaultSyncEngine({
    local,
    primary: remote,
    vaultKey: KEY,
    deviceId: DEVICE_ID,
    writeId: writeIdSequence(),
    now: () => AT,
    quarantine: createMemoryVaultQuarantineStore(),
    documentReconciler: reconcilePortfolioDocument,
  });
  await engine.start();
  return { engine, remote };
}

async function createConcurrentSyncEngines(
  document: VaultDocumentV1,
  scope: string,
): Promise<{ first: VaultSyncEngine; second: VaultSyncEngine; remote: MemoryRemote }> {
  const envelope = await encrypted(document, 1);
  const firstLocal = createLocalDataHome({
    scope: `${scope}-first`,
    storage: memoryLocalStorage(),
  });
  const secondLocal = createLocalDataHome({
    scope: `${scope}-second`,
    storage: memoryLocalStorage(),
  });
  await Promise.all([seedLocal(firstLocal, envelope), seedLocal(secondLocal, envelope)]);
  const remote = memoryRemote(envelope, 1);
  const first = createVaultSyncEngine({
    local: firstLocal,
    primary: remote,
    vaultKey: KEY,
    deviceId: DEVICE_ID,
    writeId: writeIdSequence(0x40),
    now: () => AT,
    quarantine: createMemoryVaultQuarantineStore(),
    documentReconciler: reconcilePortfolioDocument,
  });
  const second = createVaultSyncEngine({
    local: secondLocal,
    primary: remote,
    vaultKey: KEY,
    deviceId: REMOTE_DEVICE_ID,
    writeId: writeIdSequence(0x80),
    now: () => AT,
    quarantine: createMemoryVaultQuarantineStore(),
    documentReconciler: reconcilePortfolioDocument,
  });
  await Promise.all([first.start(), second.start()]);
  return { first, second, remote };
}

function memoryLocalStorage(): LocalDataHomeStorage {
  let record: LocalVaultRecord | null = null;
  return {
    async read() {
      return cloneRecord(record);
    },
    async compareAndSwap(_scope, ifVersion, build) {
      const currentVersion = record?.version ?? null;
      if (currentVersion !== ifVersion) return { status: 'conflict', currentVersion };
      record = cloneRecord(build(cloneRecord(record)));
      return { status: 'ok' };
    },
  };
}

async function seedLocal(local: LocalDataHome, envelope: Uint8Array): Promise<void> {
  const written = await local.write(envelope, { ifVersion: null });
  if (written.status !== 'ok') throw new Error('Could not seed local vault.');
  const version = written.info.version;
  const knownGood = await local.markLastKnownGood(envelope, { ifVersion: version });
  if (knownGood.status !== 'ok') throw new Error('Could not seed last-known-good vault.');
  const acknowledged = await local.setPendingRemote(false, { ifVersion: version });
  if (acknowledged.status !== 'ok') throw new Error('Could not seed local acknowledgement.');
}

function cloneRecord(record: LocalVaultRecord | null): LocalVaultRecord | null {
  return record == null
    ? null
    : {
        ...record,
        envelope: record.envelope.slice(0),
        lastKnownGood: record.lastKnownGood?.slice(0),
      };
}

function idSequence(): () => string {
  let index = 0;
  return () => {
    const id = GENERATED_IDS[index];
    index += 1;
    if (id == null) throw new Error('Test id sequence exhausted.');
    return id;
  };
}

function idSequenceFrom(...ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (id == null) throw new Error('Selected test id sequence exhausted.');
    return id;
  };
}

function writeIdSequence(start = 0x40): () => string {
  let value = start;
  return () => `018f0000-0000-7000-8000-0000000000${(value++).toString(16)}`;
}

function expectPortfolioApiUnused(): void {
  expect(portfolioApi.listPortfolios).not.toHaveBeenCalled();
  expect(portfolioApi.createPortfolio).not.toHaveBeenCalled();
  expect(portfolioApi.getPortfolio).not.toHaveBeenCalled();
  expect(portfolioApi.updatePortfolio).not.toHaveBeenCalled();
  expect(portfolioApi.deletePortfolio).not.toHaveBeenCalled();
  expect(portfolioApi.listTransactions).not.toHaveBeenCalled();
  expect(portfolioApi.createTransactions).not.toHaveBeenCalled();
  expect(portfolioApi.updateTransaction).not.toHaveBeenCalled();
  expect(portfolioApi.deleteTransaction).not.toHaveBeenCalled();
  expect(portfolioApi.depositCash).not.toHaveBeenCalled();
  expect(portfolioApi.withdrawCash).not.toHaveBeenCalled();
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject.');
}
