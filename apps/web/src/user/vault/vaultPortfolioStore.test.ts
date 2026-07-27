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
import { createVaultPortfolioStore, VaultPortfolioStoreError } from './vaultPortfolioStore';
import { deterministicRandom, VECTOR_DEVICE_ID, VECTOR_KEY_ID, VECTOR_WRITE_ID } from './vectors';

const DEVICE_ID = VECTOR_DEVICE_ID;
const REMOTE_DEVICE_ID = '018f0000-0000-7000-8000-00000000000e';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000020';
const CASH_SOURCE_ID = '018f0000-0000-7000-8000-000000000021';
const ASSET_ID = '018f0000-0000-7000-8000-000000000022';
const USER_ID = '018f0000-0000-7000-8000-000000000023';
const GENERATED_IDS = [
  '018f0000-0000-7000-8000-000000000030',
  '018f0000-0000-7000-8000-000000000031',
  '018f0000-0000-7000-8000-000000000032',
  '018f0000-0000-7000-8000-000000000033',
  '018f0000-0000-7000-8000-000000000034',
  '018f0000-0000-7000-8000-000000000035',
  '018f0000-0000-7000-8000-000000000036',
  '018f0000-0000-7000-8000-000000000037',
] as const;
const AT = '2026-07-25T10:00:00.000Z';
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
          },
        ]),
      ).resolves.toHaveLength(1);

      expect(engine.mutate).toHaveBeenCalledOnce();
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
}

function memoryRemote(initial: Uint8Array, initialVersion: number): MemoryRemote {
  let envelope = initial.slice();
  let version = initialVersion;
  const expectedVersions: (number | null)[] = [];
  return {
    medium: 'server',
    expectedVersions,
    async read(): Promise<DataHomeReadResult> {
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

function writeIdSequence(): () => string {
  let value = 0x40;
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
