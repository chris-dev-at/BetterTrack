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
import { reducePosition } from '@bettertrack/domain/holdings';

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
import { createVaultPortfolioStore, VaultPortfolioStoreError } from './vaultPortfolioStore';
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

  it('keeps the successor default when its concurrent edit wins a default-delete race', async () => {
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
    await expect(deletingStore.deletePortfolio(PORTFOLIO_ID)).resolves.toBeUndefined();

    await expect(deletingStore.listPortfolios()).resolves.toEqual({
      portfolios: [
        expect.objectContaining({
          id: secondaryId,
          name: 'Concurrent edit',
          isDefault: true,
        }),
      ],
    });
    expect(
      first.state.active?.document.entities.portfolio?.find((row) => row.id === secondaryId),
    ).toMatchObject({
      rev: 2,
      data: { name: 'Concurrent edit', isDefault: true },
    });

    await second.reconnect();
    await expect(editingStore.listPortfolios()).resolves.toEqual({
      portfolios: [
        expect.objectContaining({
          id: secondaryId,
          name: 'Concurrent edit',
          isDefault: true,
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

  it('re-applies a portfolio delete cascade when a concurrent child edit wins atomically', async () => {
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
    await expect(secondStore.deletePortfolio(secondaryId)).resolves.toBeUndefined();

    expect(
      second.state.active?.document.entities.portfolio?.find((row) => row.id === secondaryId),
    ).toMatchObject({ deletedAt: AT });
    expect(
      second.state.active?.document.entities.transaction?.find((row) => row.id === transactionId),
    ).toMatchObject({ deletedAt: AT, rev: 2 });
    await expect(secondStore.listTransactions(secondaryId)).rejects.toMatchObject({
      code: 'VAULT_ENTITY_NOT_FOUND',
    });
    await first.reconnect();
    await expect(firstStore.listPortfolios()).resolves.toEqual({
      portfolios: [expect.objectContaining({ id: PORTFOLIO_ID })],
    });
  });

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
      rev: 1,
      editedAt: COMPETING_AT,
      editedBy: REMOTE_DEVICE_ID,
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
      rev: 1,
      editedAt: COMPETING_AT,
      editedBy: REMOTE_DEVICE_ID,
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
    setDocumentReconciler: vi.fn(),
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
    setDocumentReconciler: vi.fn(),
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
  });
  const second = createVaultSyncEngine({
    local: secondLocal,
    primary: remote,
    vaultKey: KEY,
    deviceId: REMOTE_DEVICE_ID,
    writeId: writeIdSequence(0x80),
    now: () => AT,
    quarantine: createMemoryVaultQuarantineStore(),
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
