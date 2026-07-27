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
  type VaultDocumentV1,
  type VaultEntity,
  type VaultEnvelopeHeader,
} from '@bettertrack/contracts';
import { InsufficientCashError } from '@bettertrack/domain/cashLedger';

import * as portfolioApi from '../../lib/portfolioApi';

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
        (document: VaultDocumentV1) => {
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
        (document: VaultDocumentV1) => {
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
    const local: VaultDocumentV1 = {
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
});

function initialDocument(): VaultDocumentV1 {
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
  };
}

function strictDocumentFrom(document: VaultDocumentV1) {
  return vaultStrictDocumentV1Schema.parse({
    schemaVersion: document.schemaVersion,
    entities: Object.entries(document.entities).flatMap(([kind, entities]) =>
      entities.map((entity) => ({ ...entity, kind })),
    ),
    mergeLog: document.mergeLog,
  });
}

function documentFromStrictDocument(
  strict: ReturnType<typeof vaultStrictDocumentV1Schema.parse>,
): VaultDocumentV1 {
  const entities: VaultDocumentV1['entities'] = {};
  for (const strictEntity of strict.entities) {
    const { kind, ...entity } = strictEntity;
    entities[kind] = [...(entities[kind] ?? []), entity];
  }
  return { schemaVersion: strict.schemaVersion, entities, mergeLog: strict.mergeLog };
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
  document: VaultDocumentV1,
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
  document: VaultDocumentV1,
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
