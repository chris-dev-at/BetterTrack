import { describe, expect, it, vi } from 'vitest';

import {
  VAULT_DOC_FORMAT_VERSION,
  portfolioVaultMoveOutRequestSchema,
  vaultStrictDocumentV1Schema,
  type VaultCommonDoc,
  type VaultDocEnvelopeHeader,
  type VaultDocKind,
  type VaultEntity,
  type VaultPortfolioDoc,
} from '@bettertrack/contracts';

import {
  PortfolioVaultRestoreDocumentError,
  buildPortfolioVaultRestoreDocument,
  type PortfolioVaultRestoreDocumentDependencies,
  type PortfolioVaultRestoreDocumentInput,
} from './portfolioRestoreDocument';
import type {
  DecryptedPortfolioDocumentSet,
  VaultContentKeyBorrower,
} from './engine/portfolioDocumentSet';

const USER_ID = '018f0000-0000-7000-8000-000000000001';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000010';
const OTHER_PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000011';
const DEVICE_ID = '018f0000-0000-7000-8000-0000000000d1';
const VAULT_ID = '018f0000-0000-7000-8000-000000000020';
const MOVE_OUT_ID = '018f0000-0000-7000-8000-000000000021';
const MARKET_ASSET_ID = '018f0000-0000-7000-8000-000000000030';
const MANUAL_ASSET_ID = '018f0000-0000-7000-8000-000000000031';
const UNRELATED_ASSET_ID = '018f0000-0000-7000-8000-000000000032';
const MARKET_TRANSACTION_ID = '018f0000-0000-7000-8000-000000000040';
const MANUAL_TRANSACTION_ID = '018f0000-0000-7000-8000-000000000041';
const SOURCE_ID = '018f0000-0000-7000-8000-000000000050';
const MOVEMENT_ID = '018f0000-0000-7000-8000-000000000051';
const MOVEMENT_TAG_ID = '018f0000-0000-7000-8000-000000000052';
const BUDGET_ID = '018f0000-0000-7000-8000-000000000053';
const TAG_ID = '018f0000-0000-7000-8000-000000000070';
const UNRELATED_TAG_ID = '018f0000-0000-7000-8000-000000000071';
const CURRENT_MANUAL_VALUE_ID = '018f0000-0000-7000-8000-000000000083';
const CURRENT_MANUAL_VALUE_2_ID = '018f0000-0000-7000-8000-000000000084';
const KEY_ID = '018f0000-0000-7000-8000-0000000000a0';
const HEADER_DOC_ID = '018f0000-0000-7000-8000-0000000000a1';
const COMMON_DOC_ID = '018f0000-0000-7000-8000-0000000000a2';
const HEADER_WRITE_ID = '018f0000-0000-7000-8000-0000000000a3';
const COMMON_WRITE_ID = '018f0000-0000-7000-8000-0000000000a4';
const PORTFOLIO_WRITE_ID = '018f0000-0000-7000-8000-0000000000a5';
const ACCOUNT_BINDING = 'A'.repeat(43);
const AT = '2026-08-21T08:00:00.000Z';
const CURRENT_TAG_AT = '2026-08-21T09:00:00.000Z';
const CURRENT_MANUAL_AT = '2026-08-21T10:00:00.000Z';
const PUBLIC_KEY = 'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PRIVATE_KEY = 'MC4CAQAwBQYDK2VwBCIEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function entity(id: string, data: Record<string, unknown>): VaultEntity {
  return { id, rev: 1, editedAt: AT, editedBy: DEVICE_ID, deletedAt: null, data };
}

function portfolioRow() {
  return {
    userId: USER_ID,
    name: 'TEST VECTOR vaulted portfolio',
    visibility: 'private',
    sortOrder: 2,
    defaultPayFromCash: false,
    archivedAt: null,
    kind: null,
    vaultId: null,
    alias: null,
    vaultAlias: null,
  };
}

function transactionRow(assetId: string) {
  return {
    portfolioId: PORTFOLIO_ID,
    assetId,
    side: 'buy',
    quantity: '1.25000000',
    price: '12.340000',
    fee: '0.010000',
    executedAt: AT,
    note: null,
    taxMode: null,
    taxCountry: null,
    taxAmountEur: null,
    taxParams: null,
    allowUncovered: false,
    uncoveredEntryPrice: null,
    source: 'manual',
  };
}

function customAssetRow(ownerId: string | null, symbol: string) {
  return {
    // TEST VECTOR: owner-manual identity fields are intentionally stale. The
    // established strict converter must restate them from the entity UUID.
    providerId: ownerId === null ? 'market' : 'old-manual-provider',
    providerRef: ownerId === null ? symbol : `legacy-${symbol}`,
    ownerId,
    type: ownerId === null ? 'stock' : 'custom',
    symbol,
    name: `${symbol} asset`,
    exchange: ownerId === null ? 'XETRA' : null,
    currency: 'EUR',
    meta: { exact: true },
    searchText: `${symbol} asset`,
  };
}

function fixture(): { portfolioDocument: VaultPortfolioDoc; commonDocument: VaultCommonDoc } {
  const portfolioDocument: VaultPortfolioDoc = {
    schemaVersion: 1,
    portfolioId: PORTFOLIO_ID,
    entities: {
      portfolio: [entity(PORTFOLIO_ID, portfolioRow())],
      transaction: [
        entity(MARKET_TRANSACTION_ID, transactionRow(MARKET_ASSET_ID)),
        entity(MANUAL_TRANSACTION_ID, transactionRow(MANUAL_ASSET_ID)),
      ],
      cashSource: [
        entity(SOURCE_ID, {
          portfolioId: PORTFOLIO_ID,
          name: 'TEST VECTOR Main',
          type: 'cash',
          isMain: true,
          archivedAt: null,
          createdAt: AT,
        }),
      ],
      cashMovement: [
        entity(MOVEMENT_ID, {
          portfolioId: PORTFOLIO_ID,
          sourceId: SOURCE_ID,
          kind: 'deposit',
          amountEur: '100.000000',
          transactionId: null,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: AT,
          note: 'TEST VECTOR seed cash',
          source: 'manual',
          dedupHash: null,
          originalCurrency: null,
          createdAt: AT,
        }),
      ],
      cashMovementTag: [
        entity(MOVEMENT_TAG_ID, { movementId: MOVEMENT_ID, tagId: TAG_ID, createdAt: AT }),
      ],
      cashBudget: [
        entity(BUDGET_ID, {
          portfolioId: PORTFOLIO_ID,
          tagId: TAG_ID,
          periodKey: null,
          amount: '50.000000',
          currency: 'EUR',
          createdAt: AT,
          updatedAt: AT,
        }),
      ],
      // TEST VECTOR: malformed payloads are intentional. These are derived
      // caches/fire records and must be dropped before strict restoration.
      portfolioDailySnapshot: [entity('018f0000-0000-7000-8000-000000000060', { derived: true })],
      portfolioSnapshotState: [entity('018f0000-0000-7000-8000-000000000061', { derived: true })],
      cashBudgetFire: [entity('018f0000-0000-7000-8000-000000000062', { derived: true })],
    },
    mergeLog: [{ mergedAt: AT, parents: [1, 2], into: 3, deviceId: DEVICE_ID }],
  };

  const commonDocument: VaultCommonDoc = {
    schemaVersion: 1,
    entities: {
      customAsset: [
        entity(MARKET_ASSET_ID, customAssetRow(null, 'MARKET')),
        entity(MANUAL_ASSET_ID, customAssetRow(USER_ID, 'MANUAL')),
        entity(UNRELATED_ASSET_ID, customAssetRow(USER_ID, 'UNRELATED')),
      ],
      customAssetValue: [
        entity('018f0000-0000-7000-8000-000000000080', {
          assetId: MANUAL_ASSET_ID,
          date: '2026-08-20',
          // TEST VECTOR: exact persisted decimal; never pass through Number.
          close: '12345678901234.123456',
        }),
        entity('018f0000-0000-7000-8000-000000000081', {
          assetId: MARKET_ASSET_ID,
          date: '2026-08-20',
          close: '9.990000',
        }),
        entity('018f0000-0000-7000-8000-000000000082', {
          assetId: UNRELATED_ASSET_ID,
          date: '2026-08-20',
          close: '1.000000',
        }),
      ],
      cashTag: [
        entity(TAG_ID, {
          userId: USER_ID,
          name: 'TEST VECTOR stale encrypted name',
          color: '#111111',
          system: false,
          systemKey: null,
          createdAt: AT,
          updatedAt: AT,
        }),
        entity(UNRELATED_TAG_ID, {
          userId: USER_ID,
          name: 'TEST VECTOR unrelated',
          color: '#222222',
          system: false,
          systemKey: null,
          createdAt: AT,
          updatedAt: AT,
        }),
      ],
      // Account-common tax/rule facts are forbidden in a per-portfolio restore.
      // Loose doc payloads let the test prove they are dropped before strict parse.
      taxSetting: [entity('018f0000-0000-7000-8000-000000000090', { forbidden: true })],
      cashRule: [entity('018f0000-0000-7000-8000-000000000091', { forbidden: true })],
    },
    mergeLog: [{ mergedAt: AT, parents: [9], into: 10, deviceId: DEVICE_ID }],
    mirrorProvenance: [
      {
        chainId: '018f0000-0000-7000-8000-0000000000c1',
        membershipId: '018f0000-0000-7000-8000-0000000000c2',
        kind: 'transaction',
        mirrorId: '018f0000-0000-7000-8000-0000000000c3',
        portfolioId: PORTFOLIO_ID,
        localId: MANUAL_TRANSACTION_ID,
      },
      {
        chainId: '018f0000-0000-7000-8000-0000000000c4',
        membershipId: '018f0000-0000-7000-8000-0000000000c5',
        kind: 'transaction',
        mirrorId: '018f0000-0000-7000-8000-0000000000c6',
        portfolioId: OTHER_PORTFOLIO_ID,
        localId: MARKET_TRANSACTION_ID,
      },
    ],
    clientSecurity: {
      retirementProof: { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY },
    },
  };
  return { portfolioDocument, commonDocument };
}

function restoreInput(
  documents: ReturnType<typeof fixture>,
  signal?: AbortSignal,
): PortfolioVaultRestoreDocumentInput {
  return {
    userId: USER_ID,
    portfolioId: PORTFOLIO_ID,
    deviceId: DEVICE_ID,
    documentSet: decryptedDocumentSet(documents),
    ...(signal === undefined ? {} : { signal }),
  };
}

function decryptedDocumentSet(
  documents: ReturnType<typeof fixture>,
): DecryptedPortfolioDocumentSet {
  const keySlots: VaultDocEnvelopeHeader['keySlots'] = [
    { keyId: KEY_ID, slot: 'seed-v1', wrappedKc: 'VEVTVF9WRUNUT1JfV1JBUFBFRF9LQw' },
  ];
  return {
    vaultId: VAULT_ID,
    portfolioId: PORTFOLIO_ID,
    header: {
      envelope: envelope(HEADER_DOC_ID, 'header', HEADER_WRITE_ID, keySlots),
      document: {
        schemaVersion: 1,
        name: 'TEST VECTOR restore vault',
        portfolios: [{ id: PORTFOLIO_ID, name: 'TEST VECTOR vaulted portfolio' }],
        keySlots,
        driveConnection: null,
        created: { at: AT, deviceId: DEVICE_ID },
      },
    },
    common: {
      envelope: envelope(COMMON_DOC_ID, 'common', COMMON_WRITE_ID, keySlots),
      document: documents.commonDocument,
    },
    portfolio: {
      envelope: envelope(PORTFOLIO_ID, 'portfolio', PORTFOLIO_WRITE_ID, keySlots),
      document: documents.portfolioDocument,
    },
  };
}

function envelope(
  docId: string,
  docKind: VaultDocKind,
  writeId: string,
  keySlots: VaultDocEnvelopeHeader['keySlots'],
): VaultDocEnvelopeHeader {
  return {
    formatVersion: VAULT_DOC_FORMAT_VERSION,
    cipher: 'A256GCM',
    iv: 'AAAAAAAAAAAAAAAA',
    keyId: KEY_ID,
    keySlots,
    vaultId: VAULT_ID,
    docId,
    docKind,
    accountBinding: ACCOUNT_BINDING,
    docVersion: 4,
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    writeId,
    writtenAt: AT,
  };
}

interface AuthoringState {
  sessionCurrent: boolean;
  documentSetCurrent: boolean;
  assertSessionCurrentCalls: number;
  borrowedKey: Uint8Array | null;
}

function currentAuthoringState(): AuthoringState {
  return {
    sessionCurrent: true,
    documentSetCurrent: true,
    assertSessionCurrentCalls: 0,
    borrowedKey: null,
  };
}

type ResolverDependencies = Partial<
  Omit<PortfolioVaultRestoreDocumentDependencies, 'keys' | 'isDocumentSetCurrent'>
>;

function authoringDependencies(
  overrides: ResolverDependencies = {},
  state: AuthoringState = currentAuthoringState(),
): PortfolioVaultRestoreDocumentDependencies {
  const keys: VaultContentKeyBorrower = {
    async withContentKey(vaultId, operation) {
      if (vaultId !== VAULT_ID) throw new Error(`Unexpected vault borrow ${vaultId}.`);
      const borrowedKey = Uint8Array.of(1, 2, 3, 4);
      state.borrowedKey = borrowedKey;
      const assertSessionCurrent = (): void => {
        state.assertSessionCurrentCalls += 1;
        if (!state.sessionCurrent) {
          throw Object.assign(new Error('Vault session ended during restore authoring.'), {
            name: 'EndpointKeystoreError',
            code: 'session-ended',
          });
        }
      };
      try {
        assertSessionCurrent();
        const result = await operation(borrowedKey, KEY_ID, assertSessionCurrent);
        assertSessionCurrent();
        return result;
      } finally {
        borrowedKey.fill(0);
      }
    },
  };
  return {
    keys,
    isDocumentSetCurrent: () => state.documentSetCurrent,
    ...overrides,
  };
}

function currentCashTag() {
  return {
    id: TAG_ID,
    name: 'TEST VECTOR current server name',
    color: '#abcdef',
    system: false,
    systemKey: null,
    createdAt: AT,
    updatedAt: CURRENT_TAG_AT,
  };
}

function currentManualAssetSnapshot() {
  return {
    asset: {
      ...entity(MANUAL_ASSET_ID, {
        providerId: 'manual',
        providerRef: MANUAL_ASSET_ID,
        ownerId: USER_ID,
        type: 'custom',
        symbol: 'CURRENT-MANUAL',
        name: 'TEST VECTOR current exact manual asset',
        exchange: null,
        currency: 'EUR',
        meta: {
          category: 'property',
          valuation: { source: 'owner', smoothing: false },
        },
        searchText: 'current manual asset',
      }),
      rev: 7,
      editedAt: CURRENT_MANUAL_AT,
    },
    values: [
      {
        ...entity(CURRENT_MANUAL_VALUE_ID, {
          assetId: MANUAL_ASSET_ID,
          date: '2026-08-20',
          // TEST VECTOR: this exact current DB decimal replaces the stale
          // encrypted value without ever crossing Number.
          close: '98765432109876.654321',
        }),
        rev: 8,
        editedAt: CURRENT_MANUAL_AT,
      },
      {
        ...entity(CURRENT_MANUAL_VALUE_2_ID, {
          assetId: MANUAL_ASSET_ID,
          date: '2026-08-21',
          close: '0.000001',
        }),
        rev: 1,
        editedAt: CURRENT_MANUAL_AT,
      },
    ],
  };
}

function currentManualResolution() {
  return {
    serverPresent: [currentManualAssetSnapshot()],
    detachedAssetIds: [],
  };
}

function detachedManualResolution() {
  return {
    serverPresent: [],
    detachedAssetIds: [MANUAL_ASSET_ID],
  };
}

describe('buildPortfolioVaultRestoreDocument', () => {
  it('authors the strict target graph with exact current manual metadata and date-decimal values', async () => {
    const documents = fixture();
    const { portfolioDocument, commonDocument } = documents;
    const controller = new AbortController();
    const authoringState = currentAuthoringState();
    const resolveCashTags = vi.fn(async () => ({
      tags: [currentCashTag(), { ...currentCashTag(), id: UNRELATED_TAG_ID }],
    }));
    const resolveManualAssetSnapshots = vi.fn(async () => currentManualResolution());

    const document = await buildPortfolioVaultRestoreDocument(
      restoreInput(documents, controller.signal),
      authoringDependencies({ resolveCashTags, resolveManualAssetSnapshots }, authoringState),
    );

    expect(resolveManualAssetSnapshots).toHaveBeenCalledWith({
      assetIds: [MANUAL_ASSET_ID],
      signal: controller.signal,
    });
    expect(resolveCashTags).toHaveBeenCalledWith(controller.signal);
    expect(authoringState.assertSessionCurrentCalls).toBeGreaterThanOrEqual(7);
    expect(authoringState.borrowedKey).toEqual(new Uint8Array(4));
    expect(vaultStrictDocumentV1Schema.parse(document)).toEqual(document);
    expect(
      portfolioVaultMoveOutRequestSchema.parse({
        vaultId: VAULT_ID,
        moveOutId: MOVE_OUT_ID,
        lifecycleGeneration: 1,
        documentSetHash: 'h'.repeat(43),
        document,
        vaultProof: { challenge: 'c'.repeat(32), signature: 's'.repeat(86) },
        stepUp: { password: 'hunter2hunter2' },
      }).document,
    ).toEqual(document);

    const kinds = document.entities.map(({ kind }) => kind);
    expect(kinds).not.toEqual(
      expect.arrayContaining([
        'portfolioDailySnapshot',
        'portfolioSnapshotState',
        'cashBudgetFire',
        'taxSetting',
        'cashRule',
      ]),
    );

    const assets = document.entities.filter((row) => row.kind === 'customAsset');
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: MANUAL_ASSET_ID,
      rev: 7,
      editedAt: CURRENT_MANUAL_AT,
      data: {
        ownerId: USER_ID,
        providerId: 'manual',
        providerRef: MANUAL_ASSET_ID,
        symbol: 'CURRENT-MANUAL',
        name: 'TEST VECTOR current exact manual asset',
        meta: {
          category: 'property',
          valuation: { source: 'owner', smoothing: false },
        },
      },
    });
    expect(document.entities.filter((row) => row.kind === 'customAssetValue')).toEqual([
      expect.objectContaining({
        data: {
          assetId: MANUAL_ASSET_ID,
          date: '2026-08-20',
          close: '98765432109876.654321',
        },
      }),
      expect.objectContaining({
        data: {
          assetId: MANUAL_ASSET_ID,
          date: '2026-08-21',
          close: '0.000001',
        },
      }),
    ]);

    expect(document.entities.filter((row) => row.kind === 'cashTag')).toEqual([
      expect.objectContaining({
        id: TAG_ID,
        editedAt: CURRENT_TAG_AT,
        editedBy: DEVICE_ID,
        data: {
          userId: USER_ID,
          name: 'TEST VECTOR current server name',
          color: '#abcdef',
          system: false,
          systemKey: null,
          createdAt: AT,
          updatedAt: CURRENT_TAG_AT,
        },
      }),
    ]);
    // The authoring snapshot must not mutate the still-encrypted common doc.
    expect(commonDocument.entities.cashTag?.[0]?.data.name).toBe(
      'TEST VECTOR stale encrypted name',
    );
    expect(commonDocument.entities.customAsset?.[1]?.data.symbol).toBe('MANUAL');
    expect(commonDocument.entities.customAssetValue?.[0]?.data.close).toBe('12345678901234.123456');
    expect(document.mergeLog).toEqual(portfolioDocument.mergeLog);
    expect(document.mirrorProvenance).toEqual([commonDocument.mirrorProvenance[0]]);
  });

  it('fails with the typed missing-tag result when a referenced common row disappeared', async () => {
    const documents = fixture();
    const error = await buildPortfolioVaultRestoreDocument(
      restoreInput(documents),
      authoringDependencies({
        resolveCashTags: async () => ({ tags: [] }),
        resolveManualAssetSnapshots: async () => currentManualResolution(),
      }),
    ).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(PortfolioVaultRestoreDocumentError);
    expect(error).toMatchObject({
      code: 'VAULT_RESTORE_CASH_TAG_MISSING',
      missingCashTagIds: [TAG_ID],
    });
  });

  it('fails closed before common-tag resolution when the exact manual resolver is absent', async () => {
    const documents = fixture();
    const resolveCashTags = vi.fn(async () => ({ tags: [currentCashTag()] }));

    await expect(
      buildPortfolioVaultRestoreDocument(
        restoreInput(documents),
        authoringDependencies({ resolveCashTags }),
      ),
    ).rejects.toMatchObject({ code: 'VAULT_RESTORE_MANUAL_SNAPSHOT_UNAVAILABLE' });
    expect(resolveCashTags).not.toHaveBeenCalled();
  });

  it('retains encrypted manual snapshots only when the resolver confirms detachment', async () => {
    const documents = fixture();

    const document = await buildPortfolioVaultRestoreDocument(
      restoreInput(documents),
      authoringDependencies({
        resolveCashTags: async () => ({ tags: [currentCashTag()] }),
        resolveManualAssetSnapshots: async () => detachedManualResolution(),
      }),
    );

    expect(document.entities.filter((row) => row.kind === 'customAsset')).toEqual([
      expect.objectContaining({
        id: MANUAL_ASSET_ID,
        data: expect.objectContaining({
          providerId: 'manual',
          providerRef: MANUAL_ASSET_ID,
          symbol: 'MANUAL',
          meta: { exact: true },
        }),
      }),
    ]);
    expect(document.entities.filter((row) => row.kind === 'customAssetValue')).toEqual([
      expect.objectContaining({
        data: {
          assetId: MANUAL_ASSET_ID,
          date: '2026-08-20',
          close: '12345678901234.123456',
        },
      }),
    ]);
  });

  it.each([
    ['incomplete', { serverPresent: [], detachedAssetIds: [] }],
    [
      'overlapping',
      {
        serverPresent: [currentManualAssetSnapshot()],
        detachedAssetIds: [MANUAL_ASSET_ID],
      },
    ],
    [
      'unknown',
      {
        serverPresent: [currentManualAssetSnapshot()],
        detachedAssetIds: [UNRELATED_ASSET_ID],
      },
    ],
  ])('rejects an %s manual snapshot classification', async (_case, resolution) => {
    const documents = fixture();

    await expect(
      buildPortfolioVaultRestoreDocument(
        restoreInput(documents),
        authoringDependencies({
          resolveCashTags: async () => ({ tags: [currentCashTag()] }),
          resolveManualAssetSnapshots: async () => resolution,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VAULT_RESTORE_MANUAL_SNAPSHOT_INVALID' });
  });

  it('discards authoring when custody locks during manual-snapshot resolution', async () => {
    const documents = fixture();
    const authoringState = currentAuthoringState();
    const resolveCashTags = vi.fn(async () => ({ tags: [currentCashTag()] }));
    let announceStarted!: () => void;
    let finishResolution!: (resolution: ReturnType<typeof currentManualResolution>) => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const resolveManualAssetSnapshots = vi.fn(
      () =>
        new Promise<ReturnType<typeof currentManualResolution>>((resolve) => {
          finishResolution = resolve;
          announceStarted();
        }),
    );

    const pending = buildPortfolioVaultRestoreDocument(
      restoreInput(documents),
      authoringDependencies({ resolveCashTags, resolveManualAssetSnapshots }, authoringState),
    );
    await started;
    authoringState.sessionCurrent = false;
    finishResolution(currentManualResolution());

    await expect(pending).rejects.toMatchObject({ code: 'session-ended' });
    expect(resolveCashTags).not.toHaveBeenCalled();
    expect(authoringState.borrowedKey).toEqual(new Uint8Array(4));
  });

  it('discards authoring when the exact doc-set CAS changes during cash-tag resolution', async () => {
    const documents = fixture();
    const authoringState = currentAuthoringState();
    let announceStarted!: () => void;
    let finishResolution!: (response: { tags: ReturnType<typeof currentCashTag>[] }) => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const resolveCashTags = vi.fn(
      () =>
        new Promise<{ tags: ReturnType<typeof currentCashTag>[] }>((resolve) => {
          finishResolution = resolve;
          announceStarted();
        }),
    );

    const pending = buildPortfolioVaultRestoreDocument(
      restoreInput(documents),
      authoringDependencies(
        {
          resolveCashTags,
          resolveManualAssetSnapshots: async () => currentManualResolution(),
        },
        authoringState,
      ),
    );
    await started;
    authoringState.documentSetCurrent = false;
    finishResolution({ tags: [currentCashTag()] });

    await expect(pending).rejects.toMatchObject({
      code: 'VAULT_RESTORE_DOCUMENT_SET_CHANGED',
    });
    expect(authoringState.borrowedKey).toEqual(new Uint8Array(4));
  });

  it('rejects a sibling live row before resolving account-common snapshots', async () => {
    const documents = fixture();
    const transaction = documents.portfolioDocument.entities.transaction![0]!;
    documents.portfolioDocument.entities.transaction![0] = {
      ...transaction,
      data: { ...transaction.data, portfolioId: OTHER_PORTFOLIO_ID },
    };
    const resolveCashTags = vi.fn(async () => ({ tags: [currentCashTag()] }));
    const resolveManualAssetSnapshots = vi.fn(async () => currentManualResolution());

    await expect(
      buildPortfolioVaultRestoreDocument(
        restoreInput(documents),
        authoringDependencies({ resolveCashTags, resolveManualAssetSnapshots }),
      ),
    ).rejects.toMatchObject({ code: 'VAULT_RESTORE_SCOPE_INVALID' });
    expect(resolveManualAssetSnapshots).not.toHaveBeenCalled();
    expect(resolveCashTags).not.toHaveBeenCalled();
  });
});
