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
  vaultStrictDocumentV1Schema,
  type PortfolioAsset,
  type PortfolioSummary,
  type VaultDocument,
  type VaultEntity,
  type VaultEnvelopeHeader,
} from '@bettertrack/contracts';
import { InsufficientCashError } from '@bettertrack/domain/cashLedger';

import * as portfolioApi from '../../lib/portfolioApi';

import { decryptVaultDocument, encryptVaultDocument } from './crypto';
import type {
  DataHome,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from './dataHome';
import { VaultCryptoError } from './errors';
import {
  createLocalDataHome,
  type LocalDataHome,
  type LocalDataHomeStorage,
  type LocalVaultRecord,
} from './localDataHome';
import { vaultStoreErrorKey } from './engine/errorCopy';
import { openVaultSession } from './engine/session';
import { toStrictRestoreDocument } from './paranoidDisable';
import { createMemoryVaultQuarantineStore } from './quarantine';
import { createVaultSyncEngine, type VaultSyncEngine, type VaultSyncState } from './sync';
import {
  createVaultPortfolioStore,
  reconcilePortfolioDocument,
  VaultPortfolioStoreError,
} from './vaultPortfolioStore';
import {
  deterministicRandom,
  VECTOR_DEVICE_ID,
  VECTOR_KEY_ID,
  VECTOR_WRITE_ID,
} from '@bettertrack/domain/vaultVectors';

const DEVICE_ID = VECTOR_DEVICE_ID;
const REMOTE_DEVICE_ID = '018f0000-0000-7000-8000-00000000000e';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000020';
const CASH_SOURCE_ID = '018f0000-0000-7000-8000-000000000021';
const ASSET_ID = '018f0000-0000-7000-8000-000000000022';
const USER_ID = '018f0000-0000-7000-8000-000000000023';
const SECOND_ASSET_ID = '018f0000-0000-7000-8000-000000000024';
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
  // Board #69: a vault entity written before the column existed carries no
  // `kind` key, and the summary surfaces that as "unclassified".
  kind: null,
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

  it('floors summed cash response balances to cents without changing stored movements', async () => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    await store.depositCash(PORTFOLIO_ID, { amountEur: 0.1, sourceId: CASH_SOURCE_ID });
    const response = await store.depositCash(PORTFOLIO_ID, {
      amountEur: 0.2,
      sourceId: CASH_SOURCE_ID,
    });

    expect(response.sourceBalanceEur).toBe(0.3);
    expect(response.balanceEur).toBe(0.3);
    expect(engine.state.active?.document.entities.cashMovement).toMatchObject([
      { data: { amountEur: '0.1' } },
      { data: { amountEur: '0.2' } },
    ]);
  });

  it('floors every cash balance it reports back, not just the write responses', async () => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    // 0.1 + 0.2 = 0.30000000000000004 in binary floating point. The server
    // floors both the per-source and the total roll-up at its service boundary
    // (`loadCashState`), so every read path here has to as well.
    await store.depositCash(PORTFOLIO_ID, { amountEur: 0.1, sourceId: CASH_SOURCE_ID });
    await store.depositCash(PORTFOLIO_ID, { amountEur: 0.2, sourceId: CASH_SOURCE_ID });

    const movements = await store.getCashMovements(PORTFOLIO_ID);
    expect(movements.balanceEur).toBe(0.3);
    expect(movements.sources.map((source) => source.balanceEur)).toEqual([0.3]);
    const sources = await store.listCashSources(PORTFOLIO_ID);
    expect(sources.sources.map((source) => source.balanceEur)).toEqual([0.3]);
  });

  it('empties the vault by tombstoning every entity and keeps the merge log', async () => {
    const document = initialDocument();
    document.mergeLog = [
      { mergedAt: AT, parents: [1, 2], into: 3, deviceId: REMOTE_DEVICE_ID },
    ] as VaultDocument['mergeLog'];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });
    await store.depositCash(PORTFOLIO_ID, { amountEur: 100, sourceId: CASH_SOURCE_ID });

    await store.discardAllData();

    const wiped = engine.state.active!.document;
    // Every bucket survives with its rows TOMBSTONED — an absent row carries no
    // delete signal through the entity-union merge, so a second device holding
    // the pre-wipe document would union its copy straight back in. The only
    // live rows anywhere are the seeded replacement portfolio and its default
    // tax setting.
    for (const [kind, rows] of Object.entries(wiped.entities)) {
      expect(rows.length, `${kind} rows must be kept as tombstones`).toBeGreaterThan(0);
      for (const row of rows) {
        if ((kind === 'portfolio' || kind === 'taxSetting') && row.deletedAt === null) continue;
        expect(row.deletedAt, `${kind}/${row.id} must be tombstoned`).toBe(AT);
        expect(row.rev).toBeGreaterThan(0);
      }
    }
    expect(wiped.mergeLog).toHaveLength(1);
    // §6.8: the account keeps exactly one active portfolio, the same guarantee
    // `portfolioRepository.getOrCreateMain` gives a normal account — without it
    // the emptied vault could neither create a portfolio nor be rehydrated.
    const livePortfolios = (wiped.entities.portfolio ?? []).filter((row) => row.deletedAt === null);
    const liveTaxSettings = (wiped.entities.taxSetting ?? []).filter(
      (row) => row.deletedAt === null,
    );
    expect(
      Object.values(wiped.entities)
        .flat()
        .filter((row) => row.deletedAt === null),
    ).toHaveLength(2);
    expect(livePortfolios[0]?.data).toMatchObject({
      userId: USER_ID,
      name: 'Main',
      archivedAt: null,
    });
    // The owner id is readable from a LIVE row rather than only from a
    // tombstone, so deleting the seeded portfolio later cannot orphan the vault.
    expect(liveTaxSettings[0]?.data).toMatchObject({ userId: USER_ID, mode: 'none' });
    await expect(store.listPortfolios()).resolves.toEqual({
      portfolios: [
        {
          id: livePortfolios[0]!.id,
          name: 'Main',
          visibility: 'private',
          sortOrder: 0,
          isDefault: true,
          defaultPayFromCash: false,
          archivedAt: null,
          kind: null,
        },
      ],
    });
    await expect(store.getTaxSettings()).resolves.toMatchObject({ mode: 'none', country: null });
  });

  it('keeps the emptied vault usable: a new portfolio, tax settings and disable all work', async () => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });
    await store.depositCash(PORTFOLIO_ID, { amountEur: 100, sourceId: CASH_SOURCE_ID });

    await store.discardAllData();

    // The owner id survives the wipe, so every write that needs it still works.
    await expect(store.createPortfolio('Second')).resolves.toMatchObject({
      name: 'Second',
      sortOrder: 1,
    });
    await expect(store.updateTaxSettings({ mode: 'none' })).resolves.toMatchObject({
      mode: 'none',
    });
    await expect(store.listPortfolios()).resolves.toMatchObject({
      portfolios: [{ name: 'Main' }, { name: 'Second' }],
    });

    // And the exit stays open: the restore document the disable call ships
    // carries the active portfolio the server's rehydration graph demands.
    const restore = toStrictRestoreDocument(engine.state.active!.document);
    const activePortfolios = restore.entities.filter(
      (entity) => entity.kind === 'portfolio' && entity.deletedAt === null,
    );
    expect(activePortfolios).toHaveLength(2);
  });

  it('provisions the Main cash source on first implicit cash touch like the server', async () => {
    const document = initialDocument();
    document.entities.cashSource = [];
    const engine = createMutableEngine(document);
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    await expect(store.depositCash(PORTFOLIO_ID, { amountEur: 100 })).resolves.toMatchObject({
      sourceBalanceEur: 100,
      balanceEur: 100,
    });

    const sources = (engine.state.active?.document.entities.cashSource ?? []).filter(
      (entity) => entity.deletedAt === null,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]?.data).toMatchObject({
      portfolioId: PORTFOLIO_ID,
      name: 'Main',
      type: 'cash',
      isMain: true,
      archivedAt: null,
    });
    expect(engine.state.active?.document.entities.cashMovement).toMatchObject([
      { data: { amountEur: '100', sourceId: sources[0]!.id } },
    ]);

    // Only the implicit Main provisions; an explicit unknown source still fails.
    await expect(
      store.depositCash(PORTFOLIO_ID, { amountEur: 1, sourceId: REMOTE_DEVICE_ID }),
    ).rejects.toMatchObject({ code: 'VAULT_ENTITY_NOT_FOUND' });
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
        userId: USER_ID,
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
    ];
    document.entities.transaction = [
      transactionEntity(transactionId, {
        portfolioId: secondaryId,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: AT,
      }),
    ];
    document.entities.cashMovement = [
      vaultEntity(movementId, {
        portfolioId: secondaryId,
        sourceId: CASH_SOURCE_ID,
        kind: 'buy',
        amountEur: '-10',
        transactionId,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: AT,
        note: null,
        source: 'manual',
        dedupHash: null,
        originalCurrency: null,
        createdAt: AT,
      }),
    ];
    document.entities.standingOrder = [vaultEntity(standingOrderId, { portfolioId: secondaryId })];
    document.entities.standingOrderRun = [vaultEntity(standingOrderRunId, { standingOrderId })];
    document.entities.importBatch = [vaultEntity(importBatchId, { portfolioId: secondaryId })];
    document.entities.importRow = [vaultEntity(importRowId, { batchId: importBatchId })];
    document.entities.portfolioDailySnapshot = [
      vaultEntity(dailySnapshotId, { portfolioId: secondaryId }),
    ];
    document.entities.portfolioSnapshotState = [
      vaultEntity(snapshotStateId, { portfolioId: secondaryId }),
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
      ).toMatchObject({ deletedAt: AT });
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
        userId: USER_ID,
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
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

  it('uses a compound cursor for executed-time pages and returns the requested source facet', async () => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });
    const created = await store.createTransactions(PORTFOLIO_ID, [
      {
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: '2026-07-25T10:03:00.000Z',
      },
      {
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 2,
        price: 10,
        fee: 0,
        executedAt: '2026-07-25T10:01:00.000Z',
      },
      {
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 3,
        price: 10,
        fee: 0,
        executedAt: '2026-07-25T10:02:00.000Z',
      },
    ]);

    const first = await store.listTransactions(PORTFOLIO_ID, {
      limit: 2,
      order: 'executedAt',
      includeSourceTags: true,
    });
    const second = await store.listTransactions(PORTFOLIO_ID, {
      limit: 2,
      order: 'executedAt',
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.items.map((row) => row.id)).toEqual([created[0]?.id, created[2]?.id]);
    expect(first.sourceTags).toEqual(['manual']);
    expect(first.nextCursor).not.toBe(first.items.at(-1)?.id);
    expect(second.items.map((row) => row.id)).toEqual([created[1]?.id]);
    expect(second.nextCursor).toBeNull();
  });

  it('persists a supported transaction in strict restore form and reads it back unchanged', async () => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    const [created] = await store.createTransactions(PORTFOLIO_ID, [
      {
        assetId: ASSET_ID,
        side: 'buy',
        quantity: 1e-7,
        price: 2e-7,
        fee: 1e-8,
        executedAt: AT,
      },
    ]);
    await store.updateTransaction(PORTFOLIO_ID, created!.id, { price: 3e-7, fee: 2e-8 });

    const entity = engine.state.active?.document.entities.transaction?.find(
      (candidate) => candidate.id === created!.id,
    );
    expect(entity).toBeDefined();
    const strict = vaultStrictDocumentV1Schema.parse({
      schemaVersion: 1,
      entities: [{ ...entity!, kind: 'transaction' }],
      mergeLog: [],
      mirrorProvenance: [],
    });
    const strictTransaction = strict.entities[0];
    if (strictTransaction?.kind !== 'transaction') {
      throw new Error('Expected the strict transaction row.');
    }
    expect(strictTransaction.data).toMatchObject({
      quantity: '0.0000001',
      price: '0.0000003',
      fee: '0.00000002',
      taxMode: null,
      taxCountry: null,
      taxAmountEur: null,
      taxParams: null,
    });

    const restoredDocument = initialDocument();
    const { kind: _kind, ...restoredEntity } = strictTransaction;
    restoredDocument.entities.transaction = [restoredEntity];
    const restoredStore = createVaultPortfolioStore(createMutableEngine(restoredDocument), {
      now: () => AT,
    });
    await expect(restoredStore.listTransactions(PORTFOLIO_ID)).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          id: created!.id,
          quantity: 1e-7,
          price: 3e-7,
          fee: 2e-8,
        }),
      ],
    });
  });

  it('persists created portfolios and cash movements through a strict restore round trip', async () => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    const createdPortfolio = await store.createPortfolio('Secondary');
    await store.depositCash(PORTFOLIO_ID, {
      amountEur: 12.34,
      sourceId: CASH_SOURCE_ID,
      executedAt: AT,
    });

    const strict = strictDocumentFrom(engine.state.active!.document);
    const strictPortfolio = strict.entities.find(
      (entity) => entity.kind === 'portfolio' && entity.id === createdPortfolio.id,
    );
    const strictMovement = strict.entities.find((entity) => entity.kind === 'cashMovement');
    expect(strictPortfolio).toMatchObject({
      kind: 'portfolio',
      data: {
        userId: USER_ID,
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
        defaultPayFromCash: false,
        archivedAt: null,
      },
    });
    expect(strictPortfolio?.data).not.toHaveProperty('isDefault');
    expect(strictMovement).toMatchObject({
      kind: 'cashMovement',
      data: { amountEur: '12.34' },
    });

    const restoredStore = createVaultPortfolioStore(
      createMutableEngine(documentFromStrictDocument(strict)),
      { now: () => AT },
    );
    await expect(restoredStore.listPortfolios()).resolves.toEqual({
      portfolios: [
        portfolio,
        {
          ...portfolio,
          id: createdPortfolio.id,
          name: 'Secondary',
          sortOrder: 1,
          isDefault: false,
        },
      ],
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

  describe('transaction tax fence', () => {
    it('rejects a future effective tax mode after an encrypted round trip before CAS', async () => {
      const newerClientDocument = initialDocument();
      newerClientDocument.entities.transaction = [
        transactionEntity(GENERATED_IDS[0], {
          side: 'buy',
          quantity: 2,
          executedAt: '2026-07-25T08:00:00.000Z',
        }),
      ];
      newerClientDocument.entities.portfolioSetting = [
        vaultEntity(GENERATED_IDS[6], {
          portfolioId: PORTFOLIO_ID,
          key: 'tax',
          value: { mode: 'future_automatic' },
          updatedAt: AT,
        }),
      ];
      const { document } = await decryptVaultDocument(await encrypted(newerClientDocument, 1), KEY);
      expect(document.entities.portfolioSetting?.[0]?.data.value).toEqual({
        mode: 'future_automatic',
      });
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, {
        now: () => AT,
        newId: () => GENERATED_IDS[7],
      });

      const error = await captureError(() =>
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
      );

      expect(error).toBeInstanceOf(VaultCryptoError);
      expect(error).toMatchObject({
        code: 'update-required',
        message: 'This vault was written by a newer app version.',
      });
      expect(engine.mutate).not.toHaveBeenCalled();
      expect(engine.state.active?.header.vaultVersion).toBe(1);
      expect(engine.state.active?.document.entities.transaction).toHaveLength(1);
      expectPortfolioApiUnused();
    });

    it('rejects updates and deletes of a sell frozen with a future tax mode before CAS', async () => {
      const frozenSellId = GENERATED_IDS[1];
      const document = initialDocument();
      document.entities.transaction = [
        transactionEntity(GENERATED_IDS[0], {
          side: 'buy',
          quantity: 2,
          executedAt: '2026-07-25T08:00:00.000Z',
        }),
        transactionEntity(frozenSellId, {
          side: 'sell',
          executedAt: '2026-07-25T09:00:00.000Z',
          taxMode: 'future_automatic',
        }),
      ];
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, { now: () => AT });

      await expect(
        store.updateTransaction(PORTFOLIO_ID, frozenSellId, { note: 'Explanation only' }),
      ).rejects.toMatchObject({ code: 'update-required' });
      await expect(store.deleteTransaction(PORTFOLIO_ID, frozenSellId)).rejects.toMatchObject({
        code: 'update-required',
      });

      expect(engine.mutate).not.toHaveBeenCalled();
      expect(engine.state.active?.header.vaultVersion).toBe(1);
      expectPortfolioApiUnused();
    });

    it('keeps an untaxed manual-per-trade sell on the vault path', async () => {
      const document = initialDocument();
      document.entities.taxSetting = [
        vaultEntity(GENERATED_IDS[6], {
          userId: USER_ID,
          mode: 'manual_per_trade',
          country: null,
          manualDefaultAmountEur: null,
          manualDefaultRatePct: null,
          customParams: null,
          updatedAt: AT,
        }),
      ];
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, {
        now: () => AT,
        newId: () => GENERATED_IDS[7],
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
            allowUncovered: true,
          },
        ]),
      ).resolves.toHaveLength(1);

      expect(engine.mutate).toHaveBeenCalledOnce();
      expectPortfolioApiUnused();
    });

    it.each([
      [
        'an inherited manual amount default',
        (document: VaultDocument) => {
          document.entities.taxSetting = [
            vaultEntity(GENERATED_IDS[6], {
              userId: USER_ID,
              mode: 'manual_per_trade',
              country: null,
              manualDefaultAmountEur: '1.25',
              manualDefaultRatePct: null,
              customParams: null,
              updatedAt: AT,
            }),
          ];
        },
      ],
      [
        'a portfolio manual rate default',
        (document: VaultDocument) => {
          document.entities.portfolioSetting = [
            vaultEntity(GENERATED_IDS[6], {
              portfolioId: PORTFOLIO_ID,
              key: 'tax',
              value: { mode: 'manual_per_trade', manualDefaultRatePct: 25 },
              updatedAt: AT,
            }),
          ];
        },
      ],
    ])('rejects a sell with %s before CAS', async (_description, configure) => {
      const document = initialDocument();
      configure(document);
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, {
        now: () => AT,
        newId: () => GENERATED_IDS[7],
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
      expectPortfolioApiUnused();
    });

    it.each(['country_specific', 'custom'] as const)(
      'rejects an ordinary sell under effective %s tax before CAS without explicit tax fields',
      async (mode) => {
        const document = initialDocument();
        document.entities.transaction = [
          transactionEntity(GENERATED_IDS[0], {
            side: 'buy',
            quantity: 2,
            executedAt: '2026-07-25T08:00:00.000Z',
          }),
        ];
        configureEffectiveEngineTaxMode(document, mode);
        const engine = createMutableEngine(document);
        const store = createVaultPortfolioStore(engine, {
          now: () => AT,
          newId: () => GENERATED_IDS[7],
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
        expectPortfolioApiUnused();
      },
    );

    it.each(['country_specific', 'custom'] as const)(
      'rejects frozen and post-settings-change sells under effective %s tax before CAS',
      async (mode) => {
        const frozenSellId = GENERATED_IDS[1];
        const preEngineSellId = GENERATED_IDS[2];
        const document = initialDocument();
        document.entities.transaction = [
          transactionEntity(GENERATED_IDS[0], {
            side: 'buy',
            quantity: 3,
            executedAt: '2026-07-25T08:00:00.000Z',
          }),
          transactionEntity(frozenSellId, {
            side: 'sell',
            executedAt: '2026-07-25T09:00:00.000Z',
            taxMode: mode,
            taxCountry: mode === 'country_specific' ? 'DE' : null,
            taxAmountEur: 1,
            taxParams: mode === 'custom' ? { ratePct: 25 } : null,
          }),
          transactionEntity(preEngineSellId, {
            side: 'sell',
            executedAt: '2026-07-25T10:00:00.000Z',
            taxMode: 'none',
          }),
        ];
        // These rows predate the effective-mode change; their frozen state and
        // the current open-year sell must both remain fail-closed.
        configureEffectiveEngineTaxMode(document, mode);
        const engine = createMutableEngine(document);
        const store = createVaultPortfolioStore(engine, { now: () => AT });

        await expect(
          store.updateTransaction(PORTFOLIO_ID, frozenSellId, { price: 13 }),
        ).rejects.toMatchObject({ code: 'VAULT_OPERATION_UNAVAILABLE' });
        await expect(store.deleteTransaction(PORTFOLIO_ID, frozenSellId)).rejects.toMatchObject({
          code: 'VAULT_OPERATION_UNAVAILABLE',
        });
        await expect(store.deleteTransaction(PORTFOLIO_ID, preEngineSellId)).rejects.toMatchObject({
          code: 'VAULT_OPERATION_UNAVAILABLE',
        });

        expect(engine.mutate).not.toHaveBeenCalled();
        expect(engine.state.active?.header.vaultVersion).toBe(1);
        expectPortfolioApiUnused();
      },
    );

    it.each(['country_specific', 'custom'] as const)(
      'rejects a pre-open-year sell introduction and deletion under effective %s tax before CAS',
      async (mode) => {
        const editableBuyId = GENERATED_IDS[0];
        const preEngineSellId = GENERATED_IDS[1];
        const document = initialDocument();
        document.entities.transaction = [
          transactionEntity(editableBuyId, {
            side: 'buy',
            executedAt: '2025-12-31T10:00:00.000Z',
          }),
          transactionEntity(preEngineSellId, {
            side: 'sell',
            executedAt: '2025-12-31T11:00:00.000Z',
            taxMode: 'none',
          }),
        ];
        configureEffectiveEngineTaxMode(document, mode);
        const engine = createMutableEngine(document);
        const store = createVaultPortfolioStore(engine, { now: () => AT });

        await expect(
          store.updateTransaction(PORTFOLIO_ID, editableBuyId, { side: 'sell' }),
        ).rejects.toMatchObject({ code: 'VAULT_OPERATION_UNAVAILABLE' });
        await expect(store.deleteTransaction(PORTFOLIO_ID, preEngineSellId)).rejects.toMatchObject({
          code: 'VAULT_OPERATION_UNAVAILABLE',
        });

        expect(engine.mutate).not.toHaveBeenCalled();
        expect(engine.state.active?.header.vaultVersion).toBe(1);
        expectPortfolioApiUnused();
      },
    );

    it.each(['country_specific', 'custom'] as const)(
      'rejects creates, edits, deletes, and moves that can replay a later frozen %s sell before CAS',
      async (mode) => {
        const earlierBuyId = GENERATED_IDS[0];
        const frozenSellId = GENERATED_IDS[1];
        const laterBuyId = GENERATED_IDS[2];
        const document = initialDocument();
        document.entities.transaction = [
          transactionEntity(earlierBuyId, {
            side: 'buy',
            quantity: 3,
            executedAt: '2026-07-25T08:00:00.000Z',
          }),
          transactionEntity(frozenSellId, {
            side: 'sell',
            executedAt: '2026-07-25T09:00:00.000Z',
            taxMode: mode,
            taxCountry: mode === 'country_specific' ? 'DE' : null,
            taxAmountEur: 1,
            taxParams: mode === 'custom' ? { ratePct: 25 } : null,
          }),
          transactionEntity(laterBuyId, {
            side: 'buy',
            executedAt: '2026-07-25T10:00:00.000Z',
          }),
        ];
        const engine = createMutableEngine(document);
        const store = createVaultPortfolioStore(engine, {
          now: () => AT,
          newId: () => GENERATED_IDS[7],
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
              executedAt: '2026-07-25T08:30:00.000Z',
            },
          ]),
        ).rejects.toMatchObject(unavailable);
        await expect(
          store.updateTransaction(PORTFOLIO_ID, earlierBuyId, { price: 11 }),
        ).rejects.toMatchObject(unavailable);
        await expect(store.deleteTransaction(PORTFOLIO_ID, earlierBuyId)).rejects.toMatchObject(
          unavailable,
        );
        await expect(
          store.updateTransaction(PORTFOLIO_ID, laterBuyId, {
            executedAt: '2026-07-25T08:30:00.000Z',
          }),
        ).rejects.toMatchObject(unavailable);
        await expect(
          store.updateTransaction(PORTFOLIO_ID, earlierBuyId, {
            executedAt: '2026-07-25T10:30:00.000Z',
          }),
        ).rejects.toMatchObject(unavailable);

        expect(engine.mutate).not.toHaveBeenCalled();
        expect(engine.state.active?.header.vaultVersion).toBe(1);
        expectPortfolioApiUnused();
      },
    );

    it.each(['country_specific', 'custom'] as const)(
      'keeps a buy strictly after every frozen %s sell on the vault path',
      async (mode) => {
        const frozenSellId = GENERATED_IDS[1];
        const laterBuyId = GENERATED_IDS[2];
        const document = initialDocument();
        document.entities.transaction = [
          transactionEntity(GENERATED_IDS[0], {
            side: 'buy',
            quantity: 3,
            executedAt: '2026-07-25T08:00:00.000Z',
          }),
          transactionEntity(frozenSellId, {
            side: 'sell',
            executedAt: '2026-07-25T09:00:00.000Z',
            taxMode: mode,
            taxCountry: mode === 'country_specific' ? 'DE' : null,
            taxAmountEur: 1,
            taxParams: mode === 'custom' ? { ratePct: 25 } : null,
          }),
          transactionEntity(laterBuyId, {
            side: 'buy',
            executedAt: '2026-07-25T10:00:00.000Z',
          }),
        ];
        configureEffectiveEngineTaxMode(document, mode);
        const engine = createMutableEngine(document);
        const store = createVaultPortfolioStore(engine, {
          now: () => AT,
          newId: () => GENERATED_IDS[7],
        });

        await expect(
          store.createTransactions(PORTFOLIO_ID, [
            {
              assetId: ASSET_ID,
              side: 'buy',
              quantity: 1,
              price: 9,
              fee: 0,
              executedAt: '2026-07-25T11:00:00.000Z',
            },
          ]),
        ).resolves.toHaveLength(1);
        await expect(
          store.updateTransaction(PORTFOLIO_ID, laterBuyId, { price: 11 }),
        ).resolves.toMatchObject({ id: laterBuyId, price: 11 });
        await expect(store.deleteTransaction(PORTFOLIO_ID, laterBuyId)).resolves.toBeUndefined();

        expect(engine.mutate).toHaveBeenCalledTimes(3);
        expectPortfolioApiUnused();
      },
    );

    it('rejects note-only edits on frozen taxed rows before CAS', async () => {
      const frozenSellId = GENERATED_IDS[1];
      const document = initialDocument();
      document.entities.transaction = [
        transactionEntity(GENERATED_IDS[0], {
          side: 'buy',
          quantity: 2,
          executedAt: '2026-07-25T08:00:00.000Z',
        }),
        transactionEntity(frozenSellId, {
          side: 'sell',
          executedAt: '2026-07-25T09:00:00.000Z',
          taxMode: 'custom',
          taxAmountEur: 1,
          taxParams: { ratePct: 25 },
        }),
      ];
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, { now: () => AT });

      await expect(
        store.updateTransaction(PORTFOLIO_ID, frozenSellId, { note: 'Explanation only' }),
      ).rejects.toMatchObject({ code: 'VAULT_OPERATION_UNAVAILABLE' });

      expect(engine.mutate).not.toHaveBeenCalled();
      expect(engine.state.active?.header.vaultVersion).toBe(1);
      expectPortfolioApiUnused();
    });

    it('rejects updates and deletes of a settled tax row with no persisted tax mode before CAS', async () => {
      const frozenSellId = GENERATED_IDS[1];
      const document = initialDocument();
      document.entities.transaction = [
        transactionEntity(GENERATED_IDS[0], {
          side: 'buy',
          quantity: 2,
          executedAt: '2026-07-25T08:00:00.000Z',
        }),
        transactionEntity(frozenSellId, {
          side: 'sell',
          executedAt: '2026-07-25T09:00:00.000Z',
          taxMode: null,
          taxAmountEur: 1,
          taxParams: null,
        }),
      ];
      document.entities.cashMovement = [
        vaultEntity(GENERATED_IDS[2], {
          portfolioId: PORTFOLIO_ID,
          sourceId: CASH_SOURCE_ID,
          kind: 'deposit',
          amountEur: '1',
          transactionId: null,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: '2026-07-25T07:00:00.000Z',
          note: null,
          source: 'manual',
          dedupHash: null,
          originalCurrency: null,
          createdAt: AT,
        }),
        vaultEntity(GENERATED_IDS[3], {
          portfolioId: PORTFOLIO_ID,
          sourceId: CASH_SOURCE_ID,
          kind: 'tax_withholding',
          amountEur: '-1',
          transactionId: frozenSellId,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: 2026,
          executedAt: '2026-07-25T09:00:00.000Z',
          note: null,
          source: 'manual',
          dedupHash: null,
          originalCurrency: null,
          createdAt: AT,
        }),
      ];
      expect(() => strictDocumentFrom(document)).not.toThrow();

      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, { now: () => AT });

      await expect(
        store.updateTransaction(PORTFOLIO_ID, frozenSellId, { note: 'Explanation only' }),
      ).rejects.toMatchObject({ code: 'VAULT_OPERATION_UNAVAILABLE' });
      await expect(store.deleteTransaction(PORTFOLIO_ID, frozenSellId)).rejects.toMatchObject({
        code: 'VAULT_OPERATION_UNAVAILABLE',
      });

      expect(engine.mutate).not.toHaveBeenCalled();
      expect(engine.state.active?.header.vaultVersion).toBe(1);
      expectPortfolioApiUnused();
    });

    it('scopes frozen-sell replay checks to the matching portfolio and asset', async () => {
      const editableBuyId = GENERATED_IDS[0];
      const document = initialDocument();
      document.entities.transaction = [
        transactionEntity(editableBuyId, {
          side: 'buy',
          executedAt: '2026-07-25T08:00:00.000Z',
        }),
        transactionEntity(GENERATED_IDS[1], {
          assetId: '018f0000-0000-7000-8000-000000000040',
          side: 'sell',
          executedAt: '2026-07-25T09:00:00.000Z',
          taxMode: 'country_specific',
          taxCountry: 'DE',
          taxAmountEur: 1,
        }),
        transactionEntity(GENERATED_IDS[2], {
          portfolioId: '018f0000-0000-7000-8000-000000000041',
          side: 'sell',
          executedAt: '2026-07-25T09:00:00.000Z',
          taxMode: 'custom',
          taxAmountEur: 1,
          taxParams: { ratePct: 25 },
        }),
      ];
      const engine = createMutableEngine(document);
      const store = createVaultPortfolioStore(engine, { now: () => AT });

      await expect(
        store.updateTransaction(PORTFOLIO_ID, editableBuyId, { price: 11 }),
      ).resolves.toMatchObject({ id: editableBuyId, price: 11 });

      expect(engine.mutate).toHaveBeenCalledTimes(1);
      expectPortfolioApiUnused();
    });
  });

  it('rejects child tombstones when a concurrent parent edit beats a portfolio delete', async () => {
    const secondaryId = GENERATED_IDS[0];
    const transactionId = GENERATED_IDS[1];
    const document = initialDocument();
    document.entities.portfolio = [
      ...(document.entities.portfolio ?? []),
      vaultEntity(secondaryId, {
        userId: USER_ID,
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
    ];
    document.entities.transaction = [
      transactionEntity(transactionId, {
        portfolioId: secondaryId,
        side: 'buy',
        quantity: 1,
        executedAt: '2026-07-25T09:00:00.000Z',
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

    const rejected = second.state.active?.document;
    expect(rejected?.entities.portfolio?.find((row) => row.id === secondaryId)).toMatchObject({
      deletedAt: null,
      rev: 2,
      data: expect.objectContaining({ name: 'Remote parent edit' }),
    });
    expect(rejected?.entities.transaction?.find((row) => row.id === transactionId)).toMatchObject({
      deletedAt: null,
      rev: 2,
    });
    await expect(deletingStore.listTransactions(secondaryId)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: transactionId })],
    });

    await first.reconnect();
    await second.reconnect();
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

  it('surfaces unresolved overlapping mutations after restart without publishing a guess', async () => {
    const transactionId = GENERATED_IDS[0];
    const { first, second, secondLocal, remote } = await createConcurrentSyncEngines(
      initialDocument(),
      'portfolio-store-restart-overlapping-mutations',
    );
    const durableStore = createVaultPortfolioStore(first, { now: () => COMPETING_AT });
    const pendingStore = createVaultPortfolioStore(second, {
      now: () => AT,
      newId: () => transactionId,
    });

    remote.setOnline(false);
    await expect(
      pendingStore.createTransactions(PORTFOLIO_ID, [
        {
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 10,
          fee: 0,
          executedAt: AT,
        },
      ]),
    ).resolves.toMatchObject([{ id: transactionId }]);
    await expect(
      pendingStore.updateTransaction(PORTFOLIO_ID, transactionId, {
        note: 'Overlapping edit',
      }),
    ).resolves.toMatchObject({ id: transactionId, note: 'Overlapping edit' });
    const localBeforeRestart = await secondLocal.read();
    expect(localBeforeRestart.status).toBe('ok');

    remote.setOnline(true);
    await expect(
      durableStore.updatePortfolio(PORTFOLIO_ID, { name: 'Durable remote edit' }),
    ).resolves.toMatchObject({ name: 'Durable remote edit' });
    const remoteWritesBeforeRestart = remote.expectedVersions.length;
    const documentReconciler = vi.fn(reconcilePortfolioDocument);

    const restarted = createVaultSyncEngine({
      local: secondLocal,
      primary: remote,
      vaultKey: KEY,
      deviceId: REMOTE_DEVICE_ID,
      writeId: writeIdSequence(0xa0),
      now: () => AT,
      quarantine: createMemoryVaultQuarantineStore(),
      documentReconciler,
      requiresCompleteMutationProvenance: true,
    });
    await expect(restarted.start()).resolves.toMatchObject({
      status: 'unresolved',
      pending: { document: { entities: { transaction: expect.any(Array) } } },
      lastFailure: expect.stringContaining('provenance'),
    });
    expect(
      restarted.state.active?.document.entities.transaction?.find(
        (row) => row.id === transactionId,
      ),
    ).toMatchObject({
      deletedAt: null,
      data: expect.objectContaining({ note: 'Overlapping edit' }),
    });
    expect(documentReconciler).not.toHaveBeenCalled();
    expect(remote.expectedVersions).toHaveLength(remoteWritesBeforeRestart);
    await expect(restarted.reconnect()).resolves.toMatchObject({ status: 'unresolved' });
    expect(documentReconciler).not.toHaveBeenCalled();
    expect(remote.expectedVersions).toHaveLength(remoteWritesBeforeRestart);

    const localAfterRestart = await secondLocal.read();
    expect(localAfterRestart.status).toBe('ok');
    if (localBeforeRestart.status !== 'ok' || localAfterRestart.status !== 'ok') {
      throw new Error('Expected readable local vault candidates.');
    }
    expect(localAfterRestart.envelope).toEqual(localBeforeRestart.envelope);
  });

  it('keeps pending provenance incomplete after a new offline post-restart mutation', async () => {
    const secondaryId = GENERATED_IDS[0];
    const transactionId = GENERATED_IDS[1];
    const document = initialDocument();
    document.entities.portfolio = [
      ...(document.entities.portfolio ?? []),
      vaultEntity(secondaryId, {
        userId: USER_ID,
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
    ];
    document.entities.transaction = [
      transactionEntity(transactionId, {
        portfolioId: secondaryId,
        side: 'buy',
        quantity: 1,
        executedAt: '2026-07-25T09:00:00.000Z',
      }),
    ];
    const { first, second, secondLocal, remote } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-restart-post-mutation',
    );
    const durableStore = createVaultPortfolioStore(first, { now: () => COMPETING_AT });
    const pendingStore = createVaultPortfolioStore(second, { now: () => AT });

    remote.setOnline(false);
    await expect(pendingStore.deletePortfolio(secondaryId)).resolves.toBeUndefined();

    const documentReconciler = vi.fn(reconcilePortfolioDocument);
    const restarted = createVaultSyncEngine({
      local: secondLocal,
      primary: remote,
      vaultKey: KEY,
      deviceId: REMOTE_DEVICE_ID,
      writeId: writeIdSequence(0xa0),
      now: () => AT,
      quarantine: createMemoryVaultQuarantineStore(),
      documentReconciler,
      requiresCompleteMutationProvenance: true,
    });
    await expect(restarted.start()).resolves.toMatchObject({
      status: 'pending-offline',
      pending: { document: { entities: { portfolio: expect.any(Array) } } },
    });

    const restartedStore = createVaultPortfolioStore(restarted, { now: () => AT });
    const remoteWritesBeforeLocalEdit = remote.expectedVersions.length;
    await expect(
      restartedStore.updatePortfolio(PORTFOLIO_ID, { name: 'Post-restart local edit' }),
    ).resolves.toMatchObject({ name: 'Post-restart local edit' });
    expect(documentReconciler).not.toHaveBeenCalled();
    expect(remote.expectedVersions).toHaveLength(remoteWritesBeforeLocalEdit);
    const localBeforeReconnect = await secondLocal.read();
    expect(localBeforeReconnect.status).toBe('ok');

    remote.setOnline(true);
    await expect(
      durableStore.updateTransaction(secondaryId, transactionId, {
        note: 'Durable child edit',
      }),
    ).resolves.toMatchObject({ note: 'Durable child edit' });
    const remoteWritesBeforeReconnect = remote.expectedVersions.length;

    await expect(restarted.reconnect()).resolves.toMatchObject({
      status: 'unresolved',
      lastFailure: expect.stringContaining('provenance'),
    });
    expect(documentReconciler).not.toHaveBeenCalled();
    expect(remote.expectedVersions).toHaveLength(remoteWritesBeforeReconnect);

    const localAfterReconnect = await secondLocal.read();
    expect(localAfterReconnect.status).toBe('ok');
    if (localBeforeReconnect.status !== 'ok' || localAfterReconnect.status !== 'ok') {
      throw new Error('Expected readable local vault candidates.');
    }
    expect(localAfterReconnect.envelope).toEqual(localBeforeReconnect.envelope);
  });

  it('keeps a local transaction separate from an unrelated remote portfolio edit', async () => {
    const transactionId = GENERATED_IDS[0];
    const { first, second, remote } = await createConcurrentSyncEngines(
      initialDocument(),
      'portfolio-store-unrelated-remote-winner',
    );
    const remoteStore = createVaultPortfolioStore(first, { now: () => COMPETING_AT });
    const localStore = createVaultPortfolioStore(second, {
      now: () => AT,
      newId: () => transactionId,
    });

    remote.setOnline(false);
    await expect(
      localStore.createTransactions(PORTFOLIO_ID, [
        {
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 10,
          fee: 0,
          executedAt: AT,
        },
      ]),
    ).resolves.toMatchObject([{ id: transactionId }]);

    remote.setOnline(true);
    await expect(
      remoteStore.updatePortfolio(PORTFOLIO_ID, { name: 'Remote winner' }),
    ).resolves.toMatchObject({ name: 'Remote winner' });
    await expect(second.reconnect()).resolves.toMatchObject({ status: 'synced' });

    expect(
      second.state.active?.document.entities.portfolio?.find((row) => row.id === PORTFOLIO_ID),
    ).toMatchObject({
      deletedAt: null,
      data: expect.objectContaining({ name: 'Remote winner' }),
    });
    expect(
      second.state.active?.document.entities.transaction?.find((row) => row.id === transactionId),
    ).toMatchObject({ deletedAt: null });
    await expect(localStore.listTransactions(PORTFOLIO_ID)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: transactionId, side: 'buy' })],
    });

    await first.reconnect();
    expect(first.state.active?.document.entities.portfolio).toEqual(
      second.state.active?.document.entities.portfolio,
    );
    expect(first.state.active?.document.entities.transaction).toEqual(
      second.state.active?.document.entities.transaction,
    );
  });

  it('preserves an unobserved cash edit that races a rejected deletion compensation', async () => {
    const transactionId = GENERATED_IDS[0];
    const depositId = GENERATED_IDS[1];
    const buyMovementId = GENERATED_IDS[2];
    const document = initialDocument();
    document.entities.transaction = [
      transactionEntity(transactionId, {
        side: 'buy',
        quantity: 1,
        price: 10,
        executedAt: '2026-07-25T09:00:00.000Z',
      }),
    ];
    document.entities.cashMovement = [
      vaultEntity(depositId, {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'deposit',
        amountEur: '20',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-25T08:00:00.000Z',
        note: null,
        source: 'manual',
        dedupHash: null,
        originalCurrency: null,
        createdAt: '2026-07-25T08:00:00.000Z',
      }),
      vaultEntity(buyMovementId, {
        portfolioId: PORTFOLIO_ID,
        sourceId: CASH_SOURCE_ID,
        kind: 'buy',
        amountEur: '-10',
        transactionId,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-25T09:00:00.000Z',
        note: null,
        source: 'manual',
        dedupHash: null,
        originalCurrency: null,
        createdAt: '2026-07-25T09:00:00.000Z',
      }),
    ];
    const { first, second, remote } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-compensation-cas-race',
    );
    const editingStore = createVaultPortfolioStore(first, { now: () => COMPETING_AT });
    const deletingStore = createVaultPortfolioStore(second, { now: () => AT });

    await expect(
      editingStore.updateTransaction(PORTFOLIO_ID, transactionId, {
        note: 'Durable transaction edit',
      }),
    ).resolves.toMatchObject({ note: 'Durable transaction edit' });

    let subjectWriteAttempts = 0;
    let interleaved = false;
    remote.setBeforeWrite(async (envelope) => {
      const header = vaultEnvelopeHeaderSchema.parse(decodeVaultEnvelope(envelope).header);
      if (header.deviceId !== REMOTE_DEVICE_ID) return;
      subjectWriteAttempts += 1;
      if (subjectWriteAttempts !== 2) return;

      remote.setBeforeWrite(null);
      interleaved = true;
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
                    data: { ...entity.data, note: 'Concurrent cash edit' },
                  }
                : entity,
            ),
          },
        })),
      ).resolves.toMatchObject({ status: 'synced' });
    });

    await expect(
      deletingStore.deleteTransaction(PORTFOLIO_ID, transactionId),
    ).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });

    expect(interleaved).toBe(true);
    expect(subjectWriteAttempts).toBe(2);
    expect(
      second.state.active?.document.entities.cashMovement?.find(
        (movement) => movement.id === buyMovementId,
      ),
    ).toMatchObject({
      deletedAt: null,
      rev: 2,
      data: expect.objectContaining({ note: 'Concurrent cash edit' }),
    });

    await first.reconnect();
    expect(first.state.active?.document.entities.transaction).toEqual(
      second.state.active?.document.entities.transaction,
    );
    expect(first.state.active?.document.entities.cashMovement).toEqual(
      second.state.active?.document.entities.cashMovement,
    );
  });

  it('keeps independent mutation groups separate through a second CAS conflict', async () => {
    const transactionId = GENERATED_IDS[0];
    const secondaryId = GENERATED_IDS[1];
    const document = initialDocument();
    document.entities.portfolio = [
      ...(document.entities.portfolio ?? []),
      vaultEntity(secondaryId, {
        userId: USER_ID,
        name: 'Secondary',
        visibility: 'private',
        sortOrder: 1,
        defaultPayFromCash: false,
        archivedAt: null,
      }),
    ];
    const { first, second, remote } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-repeated-cas-lineage',
    );
    const durableStore = createVaultPortfolioStore(first, { now: () => COMPETING_AT });
    const pendingStore = createVaultPortfolioStore(second, {
      now: () => AT,
      newId: () => transactionId,
    });

    remote.setOnline(false);
    await expect(
      pendingStore.updatePortfolio(PORTFOLIO_ID, { name: 'Pending local edit' }),
    ).resolves.toMatchObject({ name: 'Pending local edit' });
    await expect(
      pendingStore.createTransactions(PORTFOLIO_ID, [
        {
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 10,
          fee: 0,
          executedAt: AT,
        },
      ]),
    ).resolves.toMatchObject([{ id: transactionId }]);

    remote.setOnline(true);
    await expect(
      durableStore.updatePortfolio(secondaryId, { name: 'First remote edit' }),
    ).resolves.toMatchObject({ name: 'First remote edit' });

    let subjectWriteAttempts = 0;
    remote.setBeforeWrite(async (envelope) => {
      const header = vaultEnvelopeHeaderSchema.parse(decodeVaultEnvelope(envelope).header);
      if (header.deviceId !== REMOTE_DEVICE_ID) return;
      subjectWriteAttempts += 1;
      if (subjectWriteAttempts === 1) {
        await expect(
          durableStore.updatePortfolio(PORTFOLIO_ID, {
            name: 'Second-conflict remote winner',
          }),
        ).resolves.toMatchObject({ name: 'Second-conflict remote winner' });
      } else if (subjectWriteAttempts === 2) {
        remote.setBeforeWrite(null);
        await expect(
          durableStore.updatePortfolio(PORTFOLIO_ID, {
            name: 'Third-conflict remote winner',
          }),
        ).resolves.toMatchObject({ name: 'Third-conflict remote winner' });
      }
    });

    await expect(second.reconnect()).resolves.toMatchObject({ status: 'synced' });
    expect(subjectWriteAttempts).toBe(2);
    expect(
      second.state.active?.document.entities.portfolio?.find((row) => row.id === PORTFOLIO_ID),
    ).toMatchObject({
      deletedAt: null,
      data: expect.objectContaining({ name: 'Third-conflict remote winner' }),
    });
    expect(
      second.state.active?.document.entities.portfolio?.find((row) => row.id === secondaryId),
    ).toMatchObject({
      deletedAt: null,
      data: expect.objectContaining({ name: 'First remote edit' }),
    });
    expect(
      second.state.active?.document.entities.transaction?.find((row) => row.id === transactionId),
    ).toMatchObject({ deletedAt: null });
    await expect(pendingStore.listTransactions(PORTFOLIO_ID)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: transactionId, side: 'buy' })],
    });

    await first.reconnect();
    expect(first.state.active?.document.entities.portfolio).toEqual(
      second.state.active?.document.entities.portfolio,
    );
    expect(first.state.active?.document.entities.transaction).toEqual(
      second.state.active?.document.entities.transaction,
    );
  });

  it('retains an original atomic batch after a later edit and rejects the whole batch', async () => {
    const buyId = GENERATED_IDS[0];
    const remoteSellId = GENERATED_IDS[1];
    const firstOfflineSellId = GENERATED_IDS[2];
    const secondOfflineSellId = GENERATED_IDS[3];
    const document = initialDocument();
    document.entities.transaction = [
      transactionEntity(buyId, {
        side: 'buy',
        quantity: 2,
        price: 10,
        executedAt: '2026-07-25T08:00:00.000Z',
      }),
    ];
    const { first, second, remote } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-original-atomic-batch',
    );
    const remoteStore = createVaultPortfolioStore(first, {
      now: () => AT,
      newId: () => remoteSellId,
    });
    let offlineNow = AT;
    const offlineStore = createVaultPortfolioStore(second, {
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
        note: 'Edited after the batch',
      }),
    ).resolves.toMatchObject({ note: 'Edited after the batch' });

    remote.setOnline(true);
    await expect(remoteStore.createTransactions(PORTFOLIO_ID, [sell])).resolves.toMatchObject([
      { id: remoteSellId },
    ]);
    await expect(second.reconnect()).resolves.toMatchObject({ status: 'synced' });

    const reconciledRows = second.state.active?.document.entities.transaction ?? [];
    expect(reconciledRows.find((row) => row.id === firstOfflineSellId)).toMatchObject({
      deletedAt: AT,
    });
    expect(reconciledRows.find((row) => row.id === secondOfflineSellId)).toMatchObject({
      deletedAt: AT,
    });
    await expect(offlineStore.listTransactions(PORTFOLIO_ID)).resolves.toMatchObject({
      items: [
        expect.objectContaining({ id: remoteSellId, side: 'sell' }),
        expect.objectContaining({ id: buyId, side: 'buy' }),
      ],
    });

    await first.reconnect();
    await second.reconnect();
    expect(first.state.active?.document.entities.transaction).toEqual(
      second.state.active?.document.entities.transaction,
    );
  });

  it('replays an intervening backdated buy before a later financial edit', async () => {
    const originalXBuyId = GENERATED_IDS[0];
    const originalYBuyId = GENERATED_IDS[1];
    const backdatedXBuyId = GENERATED_IDS[2];
    const document = initialDocument();
    document.entities.customAsset = [
      ...(document.entities.customAsset ?? []),
      vaultEntity(SECOND_ASSET_ID, {
        providerId: 'manual',
        providerRef: 'SECOND',
        ownerId: USER_ID,
        type: 'stock',
        symbol: 'SECOND',
        name: 'Second local asset',
        exchange: null,
        currency: 'EUR',
        meta: { category: 'stock', smoothing: false },
        searchText: 'SECOND Second local asset',
      }),
    ];
    const { first, second, remote } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-sequenced-financial-edit',
    );
    const offlineStore = createVaultPortfolioStore(second, {
      now: () => AT,
      newId: idSequenceFrom(originalXBuyId, originalYBuyId, backdatedXBuyId),
    });

    remote.setOnline(false);
    await expect(
      offlineStore.createTransactions(PORTFOLIO_ID, [
        {
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 10,
          fee: 0,
          executedAt: '2026-07-25T09:00:00.000Z',
        },
        {
          assetId: SECOND_ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 20,
          fee: 0,
          executedAt: '2026-07-25T09:00:00.000Z',
        },
      ]),
    ).resolves.toMatchObject([{ id: originalXBuyId }, { id: originalYBuyId }]);
    await expect(
      offlineStore.createTransactions(PORTFOLIO_ID, [
        {
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 9,
          fee: 0,
          executedAt: '2026-07-25T08:00:00.000Z',
        },
      ]),
    ).resolves.toMatchObject([{ id: backdatedXBuyId }]);
    await expect(
      offlineStore.updateTransaction(PORTFOLIO_ID, originalXBuyId, { side: 'sell' }),
    ).resolves.toMatchObject({ id: originalXBuyId, side: 'sell' });

    remote.setOnline(true);
    await expect(second.reconnect()).resolves.toMatchObject({ status: 'synced' });

    const rows = second.state.active?.document.entities.transaction ?? [];
    expect(rows.find((row) => row.id === originalXBuyId)).toMatchObject({
      deletedAt: null,
      data: expect.objectContaining({ side: 'sell' }),
    });
    expect(rows.find((row) => row.id === originalYBuyId)).toMatchObject({
      deletedAt: null,
      data: expect.objectContaining({ assetId: SECOND_ASSET_ID, side: 'buy' }),
    });
    expect(rows.find((row) => row.id === backdatedXBuyId)).toMatchObject({
      deletedAt: null,
      data: expect.objectContaining({ side: 'buy' }),
    });
    await expect(offlineStore.listTransactions(PORTFOLIO_ID)).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: originalXBuyId, side: 'sell' }),
        expect.objectContaining({ id: originalYBuyId, side: 'buy' }),
        expect.objectContaining({ id: backdatedXBuyId, side: 'buy' }),
      ]),
    });

    await first.reconnect();
    expect(first.state.active?.document.entities.transaction).toEqual(
      second.state.active?.document.entities.transaction,
    );
  });

  it('rejects equivalent-instant oversells before encryption or publication', async () => {
    const sellId = GENERATED_IDS[0];
    const buyId = GENERATED_IDS[1];
    const { second, remote } = await createConcurrentSyncEngines(
      initialDocument(),
      'portfolio-store-equivalent-instant-order',
    );
    const store = createVaultPortfolioStore(second, {
      now: () => AT,
      newId: idSequenceFrom(sellId, buyId),
    });
    const mutate = vi.spyOn(second, 'mutate');

    await expect(
      store.createTransactions(PORTFOLIO_ID, [
        {
          assetId: ASSET_ID,
          side: 'sell',
          quantity: 1,
          price: 12,
          fee: 0,
          executedAt: '2026-07-25T10:00:00Z',
        },
        {
          assetId: ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 10,
          fee: 0,
          executedAt: '2026-07-25T10:00:00.000Z',
        },
      ]),
    ).rejects.toMatchObject({ code: 'VAULT_DATA_INVALID' });

    expect(mutate).not.toHaveBeenCalled();
    expect(second.state.active?.header.vaultVersion).toBe(1);
    expect(second.state.active?.document.entities.transaction ?? []).toEqual([]);
    expect(remote.expectedVersions).toEqual([]);
  });

  it('rejects a financial update that would oversell before encryption', async () => {
    const buyId = GENERATED_IDS[0];
    const document = initialDocument();
    document.entities.transaction = [
      transactionEntity(buyId, {
        side: 'buy',
        quantity: 1,
        executedAt: AT,
      }),
    ];
    const { second, remote } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-update-oversell',
    );
    const store = createVaultPortfolioStore(second, { now: () => AT });
    const mutate = vi.spyOn(second, 'mutate');

    await expect(
      store.updateTransaction(PORTFOLIO_ID, buyId, { side: 'sell' }),
    ).rejects.toMatchObject({ code: 'VAULT_DATA_INVALID' });

    expect(mutate).not.toHaveBeenCalled();
    expect(second.state.active?.header.vaultVersion).toBe(1);
    expect(
      second.state.active?.document.entities.transaction?.find((row) => row.id === buyId),
    ).toMatchObject({ deletedAt: null, data: expect.objectContaining({ side: 'buy' }) });
    expect(remote.expectedVersions).toEqual([]);
  });

  it('rejects deleting a funding buy before encryption when a later sell would oversell', async () => {
    const buyId = GENERATED_IDS[0];
    const sellId = GENERATED_IDS[1];
    const document = initialDocument();
    document.entities.transaction = [
      transactionEntity(buyId, {
        side: 'buy',
        quantity: 1,
        executedAt: '2026-07-25T09:00:00.000Z',
      }),
      transactionEntity(sellId, {
        side: 'sell',
        quantity: 1,
        executedAt: AT,
      }),
    ];
    const { second, remote } = await createConcurrentSyncEngines(
      document,
      'portfolio-store-delete-oversell',
    );
    const store = createVaultPortfolioStore(second, { now: () => AT });
    const mutate = vi.spyOn(second, 'mutate');

    await expect(store.deleteTransaction(PORTFOLIO_ID, buyId)).rejects.toMatchObject({
      code: 'VAULT_DATA_INVALID',
    });

    expect(mutate).not.toHaveBeenCalled();
    expect(second.state.active?.header.vaultVersion).toBe(1);
    expect(
      second.state.active?.document.entities.transaction?.find((row) => row.id === buyId),
    ).toMatchObject({ deletedAt: null });
    expect(
      second.state.active?.document.entities.transaction?.find((row) => row.id === sellId),
    ).toMatchObject({ deletedAt: null });
    expect(remote.expectedVersions).toEqual([]);
  });

  it('fails closed when holdings reconciliation receives an invalid instant', () => {
    const transactionId = GENERATED_IDS[0];
    const remote = initialDocument();
    const invalid = transactionEntity(transactionId, {
      side: 'buy',
      executedAt: 'not-an-instant',
    });
    const local: VaultDocument = {
      ...remote,
      entities: {
        ...remote.entities,
        transaction: [invalid],
      },
    };

    let error: unknown;
    try {
      reconcilePortfolioDocument(local, {
        local,
        remote,
        mutations: [
          {
            sequence: 0,
            changes: [
              {
                kind: 'transaction',
                id: transactionId,
                before: undefined,
                after: invalid,
              },
            ],
          },
        ],
        deviceId: DEVICE_ID,
        reconciledAt: AT,
      });
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(VaultPortfolioStoreError);
    expect(error).toMatchObject({ code: 'VAULT_DATA_INVALID' });
  });

  it.each(['transaction', 'cash movement'] as const)(
    'rejects a linked transaction deletion when the concurrent %s member wins',
    async (winner) => {
      const transactionId = GENERATED_IDS[0];
      const depositId = GENERATED_IDS[1];
      const buyMovementId = GENERATED_IDS[2];
      const document = initialDocument();
      document.entities.transaction = [
        transactionEntity(transactionId, {
          side: 'buy',
          quantity: 1,
          price: 10,
          executedAt: '2026-07-25T09:00:00.000Z',
        }),
      ];
      document.entities.cashMovement = [
        vaultEntity(depositId, {
          portfolioId: PORTFOLIO_ID,
          sourceId: CASH_SOURCE_ID,
          kind: 'deposit',
          amountEur: '20',
          transactionId: null,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: '2026-07-25T08:00:00.000Z',
          note: null,
          source: 'manual',
          dedupHash: null,
          originalCurrency: null,
          createdAt: '2026-07-25T08:00:00.000Z',
        }),
        vaultEntity(buyMovementId, {
          portfolioId: PORTFOLIO_ID,
          sourceId: CASH_SOURCE_ID,
          kind: 'buy',
          amountEur: '-10',
          transactionId,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: '2026-07-25T09:00:00.000Z',
          note: null,
          source: 'manual',
          dedupHash: null,
          originalCurrency: null,
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

      const rejected = second.state.active?.document;
      expect(rejected?.entities.transaction?.find((row) => row.id === transactionId)).toMatchObject(
        {
          deletedAt: null,
          rev: 2,
          data: expect.objectContaining({
            note: winner === 'transaction' ? 'Remote transaction edit' : null,
          }),
        },
      );
      expect(
        rejected?.entities.cashMovement?.find((row) => row.id === buyMovementId),
      ).toMatchObject({
        deletedAt: null,
        rev: 2,
        data: expect.objectContaining({
          note: winner === 'cash movement' ? 'Remote cash edit' : null,
        }),
      });
      await expect(deletingStore.listTransactions(PORTFOLIO_ID)).resolves.toMatchObject({
        items: [expect.objectContaining({ id: transactionId, side: 'buy', quantity: 1 })],
      });
      const liveMovements = (rejected?.entities.cashMovement ?? []).filter(
        (movement) => movement.deletedAt === null,
      );
      expect(
        liveMovements.reduce((total, movement) => total + Number(movement.data.amountEur), 0),
      ).toBe(10);

      await first.reconnect();
      await second.reconnect();
      await first.reconnect();
      expect(first.state.active?.document.entities.transaction).toEqual(
        second.state.active?.document.entities.transaction,
      );
      expect(first.state.active?.document.entities.cashMovement).toEqual(
        second.state.active?.document.entities.cashMovement,
      );
      expectPortfolioApiUnused();
    },
  );

  it('uses browser-safe UUIDv7 identities and never serves derived reads from the API', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, { now: () => AT });

    const created = await store.createPortfolio('Generated id');
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await expect(store.getPortfolio(PORTFOLIO_ID)).rejects.toMatchObject({
      code: 'VAULT_OPERATION_UNAVAILABLE',
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
      requiresCompleteMutationProvenance: true,
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

  it('does not report success when a sync engine leaves a mutation uncommitted', async () => {
    const stable = createMutableEngine(initialDocument(), false);
    const store = createVaultPortfolioStore(stable, {
      now: () => AT,
      newId: idSequence(),
    });

    await expect(store.createPortfolio('Not committed')).rejects.toMatchObject({
      code: 'VAULT_DATA_UNAVAILABLE',
    });
    await expect(store.listPortfolios()).resolves.toEqual({ portfolios: [portfolio] });
  });

  it('keeps portfolio settings, custom values, cash sources, and standing orders inside the vault', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    const secondary = await store.createPortfolio('Secondary');
    await expect(store.archivePortfolio(secondary.id)).resolves.toMatchObject({
      archivedAt: AT,
    });
    await expect(store.listPortfolios()).resolves.toEqual({ portfolios: [portfolio] });
    await expect(store.restorePortfolio(secondary.id)).resolves.toMatchObject({
      archivedAt: null,
    });

    await expect(
      store.setPortfolioTaxOverride(PORTFOLIO_ID, {
        mode: 'manual_per_trade',
        manualDefaultRatePct: 27.5,
      }),
    ).resolves.toMatchObject({
      effective: { mode: 'manual_per_trade', manualDefaultRatePct: 27.5 },
      source: 'portfolio',
    });
    await expect(store.clearPortfolioTaxOverride(PORTFOLIO_ID)).resolves.toMatchObject({
      effective: { mode: 'none', country: null },
      override: null,
      source: 'system',
    });
    await expect(
      store.updateTaxSettings({
        mode: 'country_specific',
        country: 'DE',
      }),
    ).resolves.toEqual({
      mode: 'country_specific',
      country: 'DE',
    });
    await expect(store.getTaxSettings()).resolves.toEqual({
      mode: 'country_specific',
      country: 'DE',
    });
    await expect(store.getPortfolioTaxSettings(PORTFOLIO_ID)).resolves.toMatchObject({
      effective: { mode: 'country_specific', country: 'DE' },
      source: 'user',
    });

    const createdAsset = await store.createCustomAsset({
      name: 'Private Holding',
      category: 'other',
      currency: 'EUR',
      smoothing: true,
    });
    // The manual-asset identity the server writes for its own custom assets and
    // re-checks on every restored row (`validateCustomAssetFacts`): a reference
    // that is anything but the entity id blocks the vault's only
    // non-destructive exit.
    expect(
      engine.state.active?.document.entities.customAsset?.find(
        (row) => row.id === createdAsset.asset.id,
      )?.data,
    ).toMatchObject({
      providerId: 'manual',
      providerRef: createdAsset.asset.id,
      ownerId: USER_ID,
    });
    await expect(
      store.putValuePoints(createdAsset.asset.id, [
        { date: '2026-07-01', value: 1_000 },
        { date: '2026-07-30', value: 1_100 },
      ]),
    ).resolves.toEqual({
      points: [
        { date: '2026-07-01', value: 1_000 },
        { date: '2026-07-30', value: 1_100 },
      ],
    });
    await expect(store.listCustomAssets()).resolves.toMatchObject({
      assets: [
        expect.objectContaining({
          id: ASSET_ID,
        }),
        expect.objectContaining({
          id: createdAsset.asset.id,
          latestValue: { date: '2026-07-30', value: 1_100 },
        }),
      ],
    });

    const reserve = await store.createCashSource(PORTFOLIO_ID, {
      name: 'Reserve',
      type: 'bank',
    });
    await expect(store.archiveCashSource(PORTFOLIO_ID, reserve.id)).resolves.toMatchObject({
      archivedAt: AT,
    });
    await expect(store.restoreCashSource(PORTFOLIO_ID, reserve.id)).resolves.toMatchObject({
      archivedAt: null,
    });

    const order = await store.createStandingOrder({
      portfolioId: PORTFOLIO_ID,
      kind: 'cash-add',
      amount: 500,
      label: 'Salary',
      cadence: 'monthly',
      anchorDay: 25,
      startDate: '2026-07-25',
    });
    await expect(store.pauseStandingOrder(order.id)).resolves.toMatchObject({
      status: 'paused',
    });
    await expect(store.resumeStandingOrder(order.id)).resolves.toMatchObject({
      status: 'active',
    });
    await store.deleteStandingOrder(order.id);
    await expect(store.listStandingOrders(PORTFOLIO_ID)).resolves.toEqual({ orders: [] });

    expect(fetch).not.toHaveBeenCalled();
    expectPortfolioApiUnused();
  });

  it('snapshots a never-held market asset on first transaction reference, client-only', async () => {
    const engine = createMutableEngine(initialDocument());
    const resolveMarketAsset = vi.fn(async (assetId: string) => ({
      id: assetId,
      providerId: 'yahoo',
      providerRef: 'ACME.DE',
      symbol: 'ACME',
      name: 'Acme',
      exchange: 'XETRA',
      currency: 'EUR',
      type: 'stock' as const,
      isCustom: false,
    }));
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
      resolveMarketAsset,
    });

    const [transaction] = await store.createTransactions(PORTFOLIO_ID, [
      {
        assetId: SECOND_ASSET_ID,
        side: 'buy',
        quantity: 2,
        price: 10,
        fee: 0,
        executedAt: AT,
        note: null,
      },
    ]);

    expect(resolveMarketAsset).toHaveBeenCalledTimes(1);
    expect(transaction).toMatchObject({
      assetId: SECOND_ASSET_ID,
      asset: { symbol: 'ACME', isCustom: false, currency: 'EUR' },
    });
    const document = engine.state.active!.document;
    // The snapshot carries the catalog identity — never an owner claim.
    expect(
      document.entities.customAsset?.find((row) => row.id === SECOND_ASSET_ID)?.data,
    ).toMatchObject({
      providerId: 'yahoo',
      providerRef: 'ACME.DE',
      ownerId: null,
      type: 'stock',
    });
    // The owned asset's identity rules stay intact next to it.
    expect(document.entities.customAsset?.find((row) => row.id === ASSET_ID)?.data).toMatchObject({
      ownerId: USER_ID,
      providerId: 'manual',
    });
    // At the restore boundary the snapshot stops while the transaction crosses.
    const restore = toStrictRestoreDocument(document);
    expect(
      restore.entities.some(
        (entity) => entity.kind === 'customAsset' && entity.id === SECOND_ASSET_ID,
      ),
    ).toBe(false);
    expect(
      restore.entities.some(
        (entity) => entity.kind === 'transaction' && entity.data.assetId === SECOND_ASSET_ID,
      ),
    ).toBe(true);
    expectPortfolioApiUnused();
  });

  it('creates a buy-asset standing order against an asset the vault has never seen', async () => {
    const engine = createMutableEngine(initialDocument());
    const resolveMarketAsset = vi.fn(async (assetId: string) => ({
      id: assetId,
      providerId: 'yahoo',
      providerRef: 'NVDA',
      symbol: 'NVDA',
      name: 'NVIDIA',
      exchange: 'NASDAQ',
      currency: 'USD',
      type: 'stock' as const,
      isCustom: false,
    }));
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
      resolveMarketAsset,
    });

    const order = await store.createStandingOrder({
      portfolioId: PORTFOLIO_ID,
      kind: 'buy-asset',
      assetId: SECOND_ASSET_ID,
      amount: 1,
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-08-01',
    });

    // The order adopts the snapshotted asset's native currency.
    expect(order).toMatchObject({
      kind: 'buy-asset',
      assetId: SECOND_ASSET_ID,
      currency: 'USD',
      assetSymbol: 'NVDA',
    });
    const document = engine.state.active!.document;
    expect(
      document.entities.customAsset?.find((row) => row.id === SECOND_ASSET_ID)?.data,
    ).toMatchObject({ providerId: 'yahoo', providerRef: 'NVDA', ownerId: null });
    const restore = toStrictRestoreDocument(document);
    expect(
      restore.entities.some(
        (entity) => entity.kind === 'customAsset' && entity.id === SECOND_ASSET_ID,
      ),
    ).toBe(false);
    expect(
      restore.entities.some(
        (entity) => entity.kind === 'standingOrder' && entity.data.assetId === SECOND_ASSET_ID,
      ),
    ).toBe(true);
  });

  it('fails closed with the typed unavailable code when no snapshot can be proven', async () => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
      resolveMarketAsset: async () => null,
    });

    const failure = await store
      .createTransactions(PORTFOLIO_ID, [
        {
          assetId: SECOND_ASSET_ID,
          side: 'buy',
          quantity: 1,
          price: 10,
          fee: 0,
          executedAt: AT,
          note: null,
        },
      ])
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(VaultPortfolioStoreError);
    expect(failure).toMatchObject({ code: 'VAULT_OPERATION_UNAVAILABLE' });
    // Never a bare code in the UI: the copy map answers a real i18n key
    // (registry.test.ts proves both locales carry it).
    expect(vaultStoreErrorKey(failure as VaultPortfolioStoreError)).toBe(
      'vaultMoney.error.operationUnavailable',
    );
    // Nothing was written into the vault.
    expect(
      engine.state.active!.document.entities.customAsset?.some((row) => row.id === SECOND_ASSET_ID),
    ).toBe(false);
  });

  it('revives a tombstoned snapshot instead of duplicating its entity id', async () => {
    // discardAllData tombstones every row — market snapshots included. Buying
    // the same asset again must not append a second entity with the same id;
    // `validateStrictEntities` would refuse the whole vault as corrupt.
    const engine = createMutableEngine(initialDocument());
    const resolveMarketAsset = vi.fn(async (assetId: string) => ({
      id: assetId,
      providerId: 'yahoo',
      providerRef: 'ACME',
      symbol: 'ACME',
      name: 'Acme',
      exchange: null,
      currency: 'EUR',
      type: 'stock' as const,
      isCustom: false,
    }));
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
      resolveMarketAsset,
    });
    await store.createTransactions(PORTFOLIO_ID, [
      { assetId: SECOND_ASSET_ID, side: 'buy', quantity: 1, price: 5, fee: 0, executedAt: AT },
    ]);
    await store.discardAllData();

    await store.createTransactions(PORTFOLIO_ID2(engine), [
      { assetId: SECOND_ASSET_ID, side: 'buy', quantity: 1, price: 5, fee: 0, executedAt: AT },
    ]);

    const rows = (engine.state.active!.document.entities.customAsset ?? []).filter(
      (row) => row.id === SECOND_ASSET_ID,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deletedAt: null, rev: 2 });
  });

  it.each([
    ['a vault-created portfolio', 'created'] as const,
    ['the portfolio discardAllData seeds', 'discarded'] as const,
  ])('provisions Main with the first sibling cash source on %s', async (_label, origin) => {
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    // Both origins start with a portfolio that owns NO cash source at all.
    let portfolioId: string;
    if (origin === 'created') {
      portfolioId = (await store.createPortfolio('Side')).id;
    } else {
      await store.discardAllData();
      portfolioId = PORTFOLIO_ID2(engine);
    }
    expect(await store.listCashSources(portfolioId)).toEqual({ sources: [] });

    const reserve = await store.createCashSource(portfolioId, { name: 'Reserve', type: 'bank' });

    // Main is materialised first, in the same mutation as its sibling — the
    // server's `getOrCreateMain`-before-`createSource` order.
    await expect(store.listCashSources(portfolioId)).resolves.toMatchObject({
      sources: [
        { name: 'Main', isMain: true, archivedAt: null },
        { id: reserve.id, name: 'Reserve', isMain: false },
      ],
    });
    const document = engine.state.active!.document;
    expect(() => openVaultSession(document)).not.toThrow();
    // The client validators never enforced this; the SERVER's restore boundary
    // does, and a vault that fails it opens but can never be disabled.
    const restore = toStrictRestoreDocument(document);
    expectExactlyOneActiveMainPerPortfolio(restore);
    // Negative control — the pre-fix shape (a sibling, no Main) is exactly what
    // that rule refuses, so the assertion above is not vacuous.
    expect(() =>
      expectExactlyOneActiveMainPerPortfolio({
        ...restore,
        entities: restore.entities.filter(
          (entity) => !(entity.kind === 'cashSource' && entity.data.isMain),
        ),
      }),
    ).toThrow();
    expectPortfolioApiUnused();
  });

  it('refuses duplicate value-point dates before anything is written', async () => {
    // The server rejects them outright (`DUPLICATE_VALUE_POINT`); it has to here
    // too, because this producer writes one entity per row and two points for
    // the same day would be durably encrypted under distinct ids — a duplicate
    // (assetId, date) key `validateRelationships` refuses as VAULT_CORRUPT on
    // the next unlock, with no way back out of the vault.
    const engine = createMutableEngine(initialDocument());
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
    });

    const failure = await captureError(() =>
      store.putValuePoints(ASSET_ID, [
        { date: '2026-07-01', value: 1_000 },
        { date: '2026-07-30', value: 1_050 },
        { date: '2026-07-01', value: 1_100 },
      ]),
    );

    expect(failure).toBeInstanceOf(VaultPortfolioStoreError);
    expect(failure).toMatchObject({ code: 'VAULT_DATA_INVALID' });
    expect(vaultStoreErrorKey(failure as VaultPortfolioStoreError)).toBe(
      'vaultMoney.error.dataInvalid',
    );
    // No write at all: the mutation never opened, so not even the tombstoning
    // of the previous points ran.
    expect(engine.mutate).not.toHaveBeenCalled();
    expect(engine.state.active!.document.entities.customAssetValue).toBeUndefined();
    expect(() => openVaultSession(engine.state.active!.document)).not.toThrow();

    // The same call without the duplicate still writes one row per day.
    await expect(
      store.putValuePoints(ASSET_ID, [
        { date: '2026-07-01', value: 1_000 },
        { date: '2026-07-30', value: 1_050 },
      ]),
    ).resolves.toEqual({
      points: [
        { date: '2026-07-01', value: 1_000 },
        { date: '2026-07-30', value: 1_050 },
      ],
    });
    expect(() => openVaultSession(engine.state.active!.document)).not.toThrow();
  });

  it('takes the standing-order currency from the snapshot that wins the race', async () => {
    // Two first references to the same never-seen asset. The first order's
    // catalog read is still in flight when the second one installs the asset
    // snapshot, so `appendMarketSnapshots` keeps THAT row — and the late order
    // has to adopt the winner's currency, not the one its own resolver returned.
    // Disagreement is refused by `validatePersistedStandingOrder` on the next
    // unlock ("the buy currency does not match its asset").
    const engine = createMutableEngine(initialDocument());
    let releaseFirstRead: (() => void) | null = null;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let reads = 0;
    const resolveMarketAsset = vi.fn(async (assetId: string) => {
      reads += 1;
      const stale = reads === 1;
      if (stale) await firstRead;
      return {
        id: assetId,
        providerId: 'yahoo',
        providerRef: 'NVDA',
        symbol: 'NVDA',
        name: 'NVIDIA',
        exchange: 'NASDAQ',
        // The loser's catalog read disagrees with the winner's.
        currency: stale ? 'USD' : 'EUR',
        type: 'stock' as const,
        isCustom: false,
      };
    });
    const store = createVaultPortfolioStore(engine, {
      now: () => AT,
      newId: idSequence(),
      resolveMarketAsset,
    });
    const order = {
      portfolioId: PORTFOLIO_ID,
      kind: 'buy-asset' as const,
      assetId: SECOND_ASSET_ID,
      amount: 1,
      cadence: 'monthly' as const,
      anchorDay: 1,
      startDate: '2026-08-01',
    };

    const late = store.createStandingOrder({ ...order, label: 'Late' });
    expect(reads).toBe(1);
    const winner = await store.createStandingOrder({ ...order, label: 'Winner' });
    releaseFirstRead!();
    const loser = await late;

    expect(resolveMarketAsset).toHaveBeenCalledTimes(2);
    expect(winner).toMatchObject({ currency: 'EUR', assetSymbol: 'NVDA' });
    // The late order agrees with the snapshot that is actually in the vault.
    expect(loser).toMatchObject({ currency: 'EUR', assetSymbol: 'NVDA' });
    const document = engine.state.active!.document;
    expect(
      document.entities.customAsset?.filter((row) => row.id === SECOND_ASSET_ID),
    ).toMatchObject([{ deletedAt: null, data: { currency: 'EUR' } }]);
    expect(() => openVaultSession(document)).not.toThrow();
  });
});

/**
 * The rule the SERVER applies at the restore boundary
 * (`paranoidRehydrationService.validateGraph`: "portfolio <id> must have exactly
 * one active main cash source"), over live rows only — the same set it builds
 * the restore graph from. Neither `openVaultSession` nor
 * `toStrictRestoreDocument` checks it, which is why a producer that breaks it
 * yields a vault that opens and can never be left.
 */
function expectExactlyOneActiveMainPerPortfolio(
  strict: ReturnType<typeof vaultStrictDocumentV1Schema.parse>,
): void {
  const byPortfolio = new Map<string, { isMain: boolean; archivedAt: string | null }[]>();
  for (const entity of strict.entities) {
    if (entity.kind !== 'cashSource' || entity.deletedAt !== null) continue;
    const group = byPortfolio.get(entity.data.portfolioId) ?? [];
    group.push({ isMain: entity.data.isMain, archivedAt: entity.data.archivedAt });
    byPortfolio.set(entity.data.portfolioId, group);
  }
  for (const [portfolioId, sources] of byPortfolio) {
    const mains = sources.filter((source) => source.isMain);
    if (mains.length !== 1 || mains[0]!.archivedAt !== null) {
      throw new Error(`portfolio ${portfolioId} must have exactly one active main cash source`);
    }
  }
}

/** The live replacement portfolio a discardAllData wipe seeds. */
function PORTFOLIO_ID2(engine: VaultSyncEngine): string {
  const live = (engine.state.active!.document.entities.portfolio ?? []).find(
    (row) => row.deletedAt === null,
  );
  if (live == null) throw new Error('Expected a live portfolio after the wipe.');
  return live.id;
}

function initialDocument(): VaultDocument {
  return {
    schemaVersion: 1,
    entities: {
      portfolio: [
        vaultEntity(PORTFOLIO_ID, {
          userId: USER_ID,
          name: portfolio.name,
          visibility: portfolio.visibility,
          sortOrder: portfolio.sortOrder,
          defaultPayFromCash: portfolio.defaultPayFromCash,
          archivedAt: portfolio.archivedAt,
        }),
      ],
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
      customAsset: [
        vaultEntity(ASSET_ID, {
          providerId: 'manual',
          providerRef: asset.symbol,
          ownerId: USER_ID,
          type: asset.type,
          symbol: asset.symbol,
          name: asset.name,
          exchange: asset.exchange,
          currency: asset.currency,
          meta: { category: asset.category, smoothing: asset.smoothing },
          searchText: `${asset.symbol} ${asset.name}`,
        }),
      ],
    },
    mergeLog: [],
    mirrorProvenance: [],
  };
}

/**
 * The PRODUCTION disable carriage, not a test-local re-implementation: the same
 * function the disable request is built from, so this round trip fails if the
 * conversion (including §7.1 provenance carriage) ever drifts.
 */
function strictDocumentFrom(document: VaultDocument) {
  return toStrictRestoreDocument(document);
}

function documentFromStrictDocument(
  strict: ReturnType<typeof vaultStrictDocumentV1Schema.parse>,
): VaultDocument {
  const entities: VaultDocument['entities'] = {};
  for (const strictEntity of strict.entities) {
    const { kind, ...entity } = strictEntity;
    entities[kind] = [...(entities[kind] ?? []), entity];
  }
  return {
    schemaVersion: strict.schemaVersion,
    entities,
    mergeLog: strict.mergeLog,
    mirrorProvenance: strict.mirrorProvenance,
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

function transactionEntity(id: string, data: Record<string, unknown>): VaultEntity {
  const {
    quantity = 1,
    price = 10,
    fee = 0,
    taxAmountEur = null,
    uncoveredEntryPrice = null,
    ...rest
  } = data;
  return vaultEntity(id, {
    portfolioId: PORTFOLIO_ID,
    assetId: ASSET_ID,
    side: 'buy',
    quantity: fixtureDecimal(quantity),
    price: fixtureDecimal(price),
    fee: fixtureDecimal(fee),
    executedAt: AT,
    note: null,
    taxMode: null,
    taxCountry: null,
    taxAmountEur: fixtureDecimal(taxAmountEur),
    taxParams: null,
    allowUncovered: false,
    uncoveredEntryPrice: fixtureDecimal(uncoveredEntryPrice),
    source: 'manual',
    ...rest,
  });
}

function fixtureDecimal(value: unknown): unknown {
  return typeof value === 'number' ? String(value) : value;
}

function configureEffectiveEngineTaxMode(
  document: VaultDocument,
  mode: 'country_specific' | 'custom',
): void {
  if (mode === 'country_specific') {
    document.entities.taxSetting = [
      vaultEntity(GENERATED_IDS[6], {
        userId: USER_ID,
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
    vaultEntity(GENERATED_IDS[6], {
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

function createMutableEngine(document: VaultDocument, commit = true): VaultSyncEngine {
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

async function encrypted(document: VaultDocument, version: number): Promise<Uint8Array> {
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
  setBeforeWrite(
    listener: ((envelope: Uint8Array, options: DataHomeWriteOptions) => Promise<void>) | null,
  ): void;
  setOnline(online: boolean): void;
}

function memoryRemote(initial: Uint8Array, initialVersion: number): MemoryRemote {
  let envelope = initial.slice();
  let version = initialVersion;
  let online = true;
  let beforeWrite: ((envelope: Uint8Array, options: DataHomeWriteOptions) => Promise<void>) | null =
    null;
  const expectedVersions: (number | null)[] = [];
  return {
    medium: 'server',
    expectedVersions,
    setBeforeWrite(listener) {
      beforeWrite = listener;
    },
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
      await beforeWrite?.(next.slice(), options);
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

async function createConcurrentSyncEngines(
  document: VaultDocument,
  scope: string,
): Promise<{
  first: VaultSyncEngine;
  second: VaultSyncEngine;
  secondLocal: LocalDataHome;
  remote: MemoryRemote;
}> {
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
    requiresCompleteMutationProvenance: true,
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
    requiresCompleteMutationProvenance: true,
  });
  await Promise.all([first.start(), second.start()]);
  return { first, second, secondLocal, remote };
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
