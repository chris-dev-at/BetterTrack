import { describe, expect, it } from 'vitest';

import {
  decodeVaultEnvelope,
  encodeVaultEnvelope,
  parseVaultEtag,
  paranoidDisableRehydrationRequestSchema,
  paranoidDisableRehydrationResultSchema,
  privacyModeSchema,
  readVaultServerHeader,
  VAULT_CONTENT_CIPHER,
  VAULT_DOCUMENT_VERSION,
  VAULT_FORMAT_VERSION,
  VAULT_HISTORY_PAGE_MAX,
  VAULT_MAGIC,
  VAULT_VERSION_MAX,
  vaultDocumentV1Schema,
  vaultEnvelopeHeaderSchema,
  vaultEtag,
  VaultEnvelopeError,
  vaultHistoryListQuerySchema,
  vaultHistoryListResponseSchema,
  vaultHistoryMetadataSchema,
  vaultHistoryVersionParamSchema,
  vaultMediaSetSchema,
  vaultMediaStateSchema,
  vaultServerHeaderSchema,
  vaultVersionSchema,
} from './vault';

const UUID_A = '018f0000-0000-7000-8000-00000000000a';
const UUID_B = '018f0000-0000-7000-8000-00000000000b';
const UUID_C = '018f0000-0000-7000-8000-00000000000c';
const uuid = (value: number) => `018f0000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;

function validHeader(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: VAULT_FORMAT_VERSION,
    cipher: VAULT_CONTENT_CIPHER,
    iv: 'aXYtOTZiaXQ=',
    keyId: UUID_A,
    wrappedKeys: [
      {
        keyId: UUID_A,
        kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: 'c2FsdA==' },
        wrappedVk: 'd3JhcHBlZA==',
      },
    ],
    vaultVersion: 1,
    schemaVersion: VAULT_DOCUMENT_VERSION,
    deviceId: UUID_B,
    writeId: UUID_C,
    writtenAt: '2026-07-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('privacy mode', () => {
  it('accepts the two modes and rejects anything else', () => {
    expect(privacyModeSchema.parse('normal')).toBe('normal');
    expect(privacyModeSchema.parse('paranoid')).toBe('paranoid');
    expect(privacyModeSchema.safeParse('drive-only').success).toBe(false);
  });
});

describe('media set', () => {
  it('accepts every non-empty subset', () => {
    expect(vaultMediaSetSchema.parse(['server'])).toEqual(['server']);
    expect(vaultMediaSetSchema.parse(['drive'])).toEqual(['drive']);
    expect(vaultMediaSetSchema.parse(['server', 'drive'])).toEqual(['server', 'drive']);
  });

  it('rejects an empty set, an unknown medium, and a repeated medium', () => {
    expect(vaultMediaSetSchema.safeParse([]).success).toBe(false);
    expect(vaultMediaSetSchema.safeParse(['icloud']).success).toBe(false);
    expect(vaultMediaSetSchema.safeParse(['server', 'server']).success).toBe(false);
  });

  it('requires Drive when a Drive attestation is present', () => {
    expect(
      vaultMediaStateSchema.safeParse({ mediaSet: ['server'], driveAttestedVersion: 1 }).success,
    ).toBe(false);
    expect(
      vaultMediaStateSchema.safeParse({ mediaSet: ['drive'], driveAttestedVersion: 1 }).success,
    ).toBe(true);
  });
});

describe('blind vault history', () => {
  const metadata = {
    version: 7,
    createdAt: '2026-07-24T10:00:00.000Z',
    sizeBytes: 4096,
    medium: 'server' as const,
  };

  it('accepts only non-sensitive metadata and rejects cleartext-derived fields', () => {
    expect(vaultHistoryMetadataSchema.parse(metadata)).toEqual(metadata);
    for (const leaked of [
      { decryptedRowCount: 12 },
      { entityNames: ['portfolio'] },
      { documentHash: 'cleartext-derived' },
      { plaintext: { balance: 42 } },
    ]) {
      expect(vaultHistoryMetadataSchema.safeParse({ ...metadata, ...leaked }).success).toBe(false);
    }

    expect(
      vaultHistoryListResponseSchema.safeParse({
        items: [metadata],
        nextCursor: null,
        portfolioNames: ['Main'],
      }).success,
    ).toBe(false);
  });

  it('leaves oversized page requests valid so the server can clamp them', () => {
    expect(vaultHistoryListQuerySchema.parse({ limit: VAULT_HISTORY_PAGE_MAX * 100 })).toEqual({
      limit: VAULT_HISTORY_PAGE_MAX * 100,
    });
  });

  it('bounds durable versions, list cursors, and read params to PostgreSQL int4', () => {
    expect(vaultVersionSchema.parse(VAULT_VERSION_MAX)).toBe(VAULT_VERSION_MAX);
    expect(vaultVersionSchema.safeParse(VAULT_VERSION_MAX + 1).success).toBe(false);
    expect(vaultHistoryListQuerySchema.parse({ cursor: String(VAULT_VERSION_MAX) })).toEqual({
      cursor: VAULT_VERSION_MAX,
    });
    expect(
      vaultHistoryListQuerySchema.safeParse({ cursor: String(VAULT_VERSION_MAX + 1) }).success,
    ).toBe(false);
    expect(vaultHistoryVersionParamSchema.parse({ version: String(VAULT_VERSION_MAX) })).toEqual({
      version: VAULT_VERSION_MAX,
    });
    expect(
      vaultHistoryVersionParamSchema.safeParse({ version: String(VAULT_VERSION_MAX + 1) }).success,
    ).toBe(false);
  });
});

describe('envelope header', () => {
  it('validates a well-formed header and pins the format version', () => {
    expect(vaultEnvelopeHeaderSchema.parse(validHeader())).toMatchObject({ vaultVersion: 1 });
    expect(vaultEnvelopeHeaderSchema.safeParse(validHeader({ formatVersion: 2 })).success).toBe(
      false,
    );
    expect(vaultEnvelopeHeaderSchema.safeParse(validHeader({ vaultVersion: 0 })).success).toBe(
      false,
    );
  });

  it('server header view reads only formatVersion + vaultVersion and strips the rest', () => {
    const parsed = vaultServerHeaderSchema.parse(validHeader());
    expect(parsed).toEqual({ formatVersion: 1, vaultVersion: 1 });
    // The crypto material never survives the server-side parse.
    expect(parsed).not.toHaveProperty('wrappedKeys');
    expect(parsed).not.toHaveProperty('iv');
  });
});

describe('envelope codec', () => {
  it('round-trips a header + ciphertext', () => {
    const ciphertext = new Uint8Array([1, 2, 3, 250, 0, 128]);
    const bytes = encodeVaultEnvelope(validHeader(), ciphertext);
    // Magic prefix is intact.
    expect(new TextDecoder().decode(bytes.subarray(0, VAULT_MAGIC.length))).toBe(VAULT_MAGIC);

    const decoded = decodeVaultEnvelope(bytes);
    expect(vaultServerHeaderSchema.parse(decoded.header)).toEqual({
      formatVersion: 1,
      vaultVersion: 1,
    });
    expect(Array.from(decoded.ciphertext)).toEqual(Array.from(ciphertext));
  });

  it('readVaultServerHeader extracts the CAS fields', () => {
    const bytes = encodeVaultEnvelope(validHeader({ vaultVersion: 7 }), new Uint8Array([9]));
    expect(readVaultServerHeader(bytes)).toEqual({ formatVersion: 1, vaultVersion: 7 });
  });

  it('rejects malformed envelopes', () => {
    expect(() => decodeVaultEnvelope(new Uint8Array([1, 2, 3]))).toThrow(VaultEnvelopeError);
    // Right length, wrong magic.
    const wrongMagic = encodeVaultEnvelope(validHeader(), new Uint8Array());
    wrongMagic[0] = 0;
    expect(() => decodeVaultEnvelope(wrongMagic)).toThrow(VaultEnvelopeError);
    // Header length prefix claims more bytes than exist.
    const truncated = encodeVaultEnvelope(validHeader(), new Uint8Array());
    const broken = truncated.subarray(0, truncated.length - 10);
    expect(() => decodeVaultEnvelope(broken)).toThrow(VaultEnvelopeError);
    // A header without the required CAS fields is rejected by the server read.
    const noVersion = encodeVaultEnvelope({ formatVersion: 1 }, new Uint8Array());
    expect(() => readVaultServerHeader(noVersion)).toThrow(VaultEnvelopeError);
  });
});

describe('etag helpers', () => {
  it('formats and parses a version tag', () => {
    expect(vaultEtag(12)).toBe('"12"');
    expect(parseVaultEtag('"12"')).toBe(12);
    expect(parseVaultEtag('W/"12"')).toBe(12);
    expect(parseVaultEtag('  12 ')).toBe(12);
  });

  it('rejects wildcards, lists and non-integers', () => {
    expect(parseVaultEtag('*')).toBeNull();
    expect(parseVaultEtag('"1", "2"')).toBeNull();
    expect(parseVaultEtag('abc')).toBeNull();
    expect(parseVaultEtag(undefined)).toBeNull();
    expect(parseVaultEtag(null)).toBeNull();
  });
});

describe('vault document v1', () => {
  it('parses a minimal document and defaults the merge log', () => {
    const doc = vaultDocumentV1Schema.parse({
      schemaVersion: 1,
      entities: [
        {
          id: UUID_A,
          kind: 'portfolio',
          rev: 0,
          editedAt: '2026-07-24T10:00:00.000Z',
          editedBy: UUID_B,
          deletedAt: null,
          data: {
            name: 'Main',
            visibility: 'private',
            sortOrder: 0,
            defaultPayFromCash: false,
            archivedAt: null,
          },
        },
      ],
    });
    expect(doc.mergeLog).toEqual([]);
    expect(doc.entities[0]?.kind).toBe('portfolio');
    const [portfolio] = doc.entities;
    expect(portfolio?.kind === 'portfolio' && portfolio.data.name).toBe('Main');
  });

  it('round-trips every restore-source kind without losing persisted metadata', () => {
    const at = '2026-07-24T10:00:00.000Z';
    const meta = (id: string) => ({
      id,
      rev: 3,
      editedAt: at,
      editedBy: UUID_B,
      deletedAt: null,
    });
    const portfolioId = uuid(1);
    const assetId = uuid(2);
    const sourceId = uuid(3);
    const categoryId = uuid(4);
    const customParams = {
      ratePct: 27.5,
      lossOffset: true,
      refund: true,
      yearReset: true,
      carryForward: true,
      costBasis: 'fifo',
    } as const;
    const entities = [
      {
        ...meta(portfolioId),
        kind: 'portfolio',
        data: {
          name: 'Main',
          visibility: 'private',
          sortOrder: 2,
          defaultPayFromCash: true,
          archivedAt: null,
        },
      },
      {
        ...meta(uuid(5)),
        kind: 'transaction',
        data: {
          portfolioId,
          assetId,
          side: 'sell',
          quantity: 1.25,
          price: 123.456789,
          fee: 1.25,
          executedAt: at,
          note: 'frozen facts',
          allowUncovered: true,
          uncoveredEntryPrice: 100,
          source: 'import:ibkr',
          taxMode: 'custom',
          taxCountry: null,
          taxAmountEur: 5.5,
          taxParams: customParams,
        },
      },
      {
        ...meta(uuid(6)),
        kind: 'dividend',
        data: {
          portfolioId,
          assetId,
          cashSourceId: sourceId,
          grossAmountEur: 12.5,
          executedAt: at,
          createdAt: '2026-07-23T09:00:00.000Z',
          note: 'quarterly',
          source: 'sync:broker',
          taxMode: 'country_specific',
          taxCountry: 'DE',
          taxAmountEur: 3.296875,
          taxParams: null,
        },
      },
      {
        ...meta(sourceId),
        kind: 'cashSource',
        data: {
          portfolioId,
          name: 'Main',
          type: 'bank',
          isMain: true,
          archivedAt: null,
          createdAt: '2026-07-20T08:00:00.000Z',
        },
      },
      {
        ...meta(uuid(7)),
        kind: 'cashMovement',
        data: {
          portfolioId,
          sourceId,
          kind: 'deposit',
          amountEur: 100,
          transactionId: null,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: at,
          createdAt: '2026-07-22T08:00:00.000Z',
          note: 'seed',
          source: 'manual',
        },
      },
      {
        ...meta(uuid(8)),
        kind: 'portfolioSetting',
        data: { portfolioId, key: 'tax', value: { mode: 'none' }, updatedAt: at },
      },
      {
        ...meta(uuid(9)),
        kind: 'taxSetting',
        data: {
          mode: 'manual_per_trade',
          country: null,
          manualDefaultAmountEur: null,
          manualDefaultRatePct: 12.345678,
          customParams: null,
          updatedAt: at,
        },
      },
      {
        ...meta(assetId),
        kind: 'customAsset',
        data: {
          providerId: 'manual',
          providerRef: assetId,
          type: 'custom',
          symbol: 'HOME',
          name: 'House',
          exchange: null,
          currency: 'EUR',
          category: 'other',
          smoothing: true,
          recategorize: true,
        },
      },
      {
        ...meta(uuid(10)),
        kind: 'customAssetValue',
        data: { assetId, date: '2026-07-24', close: 456789.1234567 },
      },
      {
        ...meta(uuid(11)),
        kind: 'standingOrder',
        data: {
          portfolioId,
          kind: 'buy-asset',
          assetId,
          amount: 0.125,
          currency: 'EUR',
          label: 'Monthly home slice',
          cadence: 'monthly',
          anchorDay: 31,
          startDate: '2026-01-31',
          endDate: null,
          status: 'paused',
          lastRunAt: at,
          lastPeriodKey: '2026-07-24',
          createdAt: '2026-01-01T08:00:00.000Z',
          updatedAt: at,
        },
      },
      {
        ...meta(categoryId),
        kind: 'expenseCategory',
        data: {
          name: 'Groceries',
          direction: 'expense',
          color: '#22c55e',
          createdAt: at,
          updatedAt: at,
        },
      },
      {
        ...meta(uuid(12)),
        kind: 'expenseTransaction',
        data: {
          categoryId,
          direction: 'expense',
          amount: 12.5,
          currency: 'EUR',
          bookedOn: '2026-07-24',
          description: 'Market',
          source: 'import:n26',
          createdAt: at,
          updatedAt: at,
        },
      },
      {
        ...meta(uuid(13)),
        kind: 'expenseRule',
        data: {
          categoryId,
          matchType: 'contains',
          pattern: 'market',
          priority: 7,
          enabled: true,
          createdAt: at,
          updatedAt: at,
        },
      },
      {
        ...meta(uuid(14)),
        kind: 'expenseBudget',
        data: {
          categoryId,
          amount: 350.25,
          currency: 'EUR',
          createdAt: at,
          updatedAt: at,
        },
      },
    ];

    const parsed = vaultDocumentV1Schema.parse({
      schemaVersion: 1,
      entities,
      mergeLog: [],
    });
    expect(parsed.entities).toEqual(entities);
    expect(new Set(parsed.entities.map((entity) => entity.kind))).toEqual(
      new Set([
        'portfolio',
        'transaction',
        'dividend',
        'cashSource',
        'cashMovement',
        'portfolioSetting',
        'taxSetting',
        'customAsset',
        'customAssetValue',
        'standingOrder',
        'expenseCategory',
        'expenseTransaction',
        'expenseRule',
        'expenseBudget',
      ]),
    );
    expect(parsed.entities.find((entity) => entity.kind === 'customAsset')?.data.recategorize).toBe(
      true,
    );
  });

  it('rejects unknown kinds, unknown fields, duplicate ids, and wrong schema versions', () => {
    const valid = {
      schemaVersion: 1,
      entities: [
        {
          id: UUID_A,
          kind: 'portfolio',
          rev: 0,
          editedAt: '2026-07-24T10:00:00.000Z',
          editedBy: UUID_B,
          deletedAt: null,
          data: {
            name: 'Main',
            visibility: 'private',
            sortOrder: 0,
            defaultPayFromCash: false,
            archivedAt: null,
          },
        },
      ],
    };
    expect(vaultDocumentV1Schema.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
    expect(
      vaultDocumentV1Schema.safeParse({
        ...valid,
        entities: [{ ...valid.entities[0]!, kind: 'bogus' }],
      }).success,
    ).toBe(false);
    const first = valid.entities[0]!;
    expect(
      vaultDocumentV1Schema.safeParse({
        ...valid,
        entities: [{ ...first, data: { ...first.data, extra: true } }],
      }).success,
    ).toBe(false);
    expect(
      vaultDocumentV1Schema.safeParse({
        ...valid,
        entities: [valid.entities[0], valid.entities[0]],
      }).success,
    ).toBe(false);
  });

  it('rejects restore money that would be silently rounded or overflow storage', () => {
    const base = {
      id: UUID_A,
      kind: 'expenseTransaction',
      rev: 0,
      editedAt: '2026-07-24T10:00:00.000Z',
      editedBy: UUID_B,
      deletedAt: null,
      data: {
        categoryId: null,
        direction: 'expense',
        amount: 1.001,
        currency: 'EUR',
        bookedOn: '2026-07-24',
        description: 'Rounded by storage',
        source: 'manual',
        createdAt: '2026-07-24T10:00:00.000Z',
        updatedAt: '2026-07-24T10:00:00.000Z',
      },
    };
    expect(vaultDocumentV1Schema.safeParse({ schemaVersion: 1, entities: [base] }).success).toBe(
      false,
    );
    expect(
      vaultDocumentV1Schema.safeParse({
        schemaVersion: 1,
        entities: [{ ...base, data: { ...base.data, amount: 1e50 } }],
      }).success,
    ).toBe(false);
  });

  it('rejects sub-quantum values and accepts the exact storage quantum at every scale', () => {
    const meta = {
      id: UUID_A,
      rev: 0,
      editedAt: '2026-07-24T10:00:00.000Z',
      editedBy: UUID_B,
      deletedAt: null,
    };
    const transaction = {
      ...meta,
      kind: 'transaction',
      data: {
        portfolioId: UUID_A,
        assetId: UUID_B,
        side: 'buy',
        quantity: 1,
        price: 1,
        fee: 0,
        executedAt: '2026-07-24T10:00:00.000Z',
        note: null,
        allowUncovered: false,
        uncoveredEntryPrice: null,
        source: 'manual',
        taxMode: null,
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
      },
    };
    const dividend = {
      ...meta,
      kind: 'dividend',
      data: {
        portfolioId: UUID_A,
        assetId: UUID_B,
        cashSourceId: UUID_C,
        grossAmountEur: 1,
        executedAt: '2026-07-24T10:00:00.000Z',
        createdAt: '2026-07-24T10:00:00.000Z',
        note: null,
        source: 'manual',
        taxMode: 'manual_per_trade',
        taxCountry: null,
        taxAmountEur: 1,
        taxParams: null,
      },
    };
    const standingOrder = {
      ...meta,
      kind: 'standingOrder',
      data: {
        portfolioId: UUID_A,
        kind: 'cash-add',
        assetId: null,
        amount: 1,
        currency: 'EUR',
        label: null,
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-24',
        endDate: null,
        status: 'active',
        lastRunAt: null,
        lastPeriodKey: null,
        createdAt: '2026-07-24T10:00:00.000Z',
        updatedAt: '2026-07-24T10:00:00.000Z',
      },
    };
    const expense = {
      ...meta,
      kind: 'expenseTransaction',
      data: {
        categoryId: null,
        direction: 'expense',
        amount: 1,
        currency: 'EUR',
        bookedOn: '2026-07-24',
        description: 'Storage quantum',
        source: 'manual',
        createdAt: '2026-07-24T10:00:00.000Z',
        updatedAt: '2026-07-24T10:00:00.000Z',
      },
    };
    const cashMovement = {
      ...meta,
      kind: 'cashMovement',
      data: {
        portfolioId: UUID_A,
        sourceId: UUID_B,
        kind: 'deposit',
        amountEur: 1,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-24T10:00:00.000Z',
        createdAt: '2026-07-24T10:00:00.000Z',
        note: null,
        source: 'manual',
      },
    };
    const cases = [
      {
        label: 'scale-2 expense amount',
        invalid: { ...expense, data: { ...expense.data, amount: 1e-10 } },
        valid: { ...expense, data: { ...expense.data, amount: 0.01 } },
      },
      {
        label: 'scale-2 cash amount',
        invalid: { ...cashMovement, data: { ...cashMovement.data, amountEur: 1e-10 } },
        valid: { ...cashMovement, data: { ...cashMovement.data, amountEur: 0.01 } },
      },
      {
        label: 'scale-6 transaction price',
        invalid: { ...transaction, data: { ...transaction.data, price: 1e-14 } },
        valid: { ...transaction, data: { ...transaction.data, price: 0.000001 } },
      },
      {
        label: 'scale-6 dividend amount',
        invalid: { ...dividend, data: { ...dividend.data, grossAmountEur: 1e-14 } },
        valid: { ...dividend, data: { ...dividend.data, grossAmountEur: 0.000001 } },
      },
      {
        label: 'scale-6 signed tax amount',
        invalid: {
          ...dividend,
          data: {
            ...dividend.data,
            taxMode: 'country_specific',
            taxCountry: 'AT',
            taxAmountEur: -1e-14,
          },
        },
        valid: {
          ...dividend,
          data: {
            ...dividend.data,
            taxMode: 'country_specific',
            taxCountry: 'AT',
            taxAmountEur: -0.000001,
          },
        },
      },
      {
        label: 'scale-8 transaction quantity',
        invalid: { ...transaction, data: { ...transaction.data, quantity: 1e-16 } },
        valid: { ...transaction, data: { ...transaction.data, quantity: 0.00000001 } },
      },
      {
        label: 'scale-8 standing-order amount',
        invalid: { ...standingOrder, data: { ...standingOrder.data, amount: 1e-16 } },
        valid: { ...standingOrder, data: { ...standingOrder.data, amount: 0.00000001 } },
      },
      {
        label: 'scale-6 manual tax default rate',
        invalid: {
          ...meta,
          kind: 'taxSetting',
          data: {
            mode: 'manual_per_trade',
            country: null,
            manualDefaultAmountEur: null,
            manualDefaultRatePct: 1.1234567,
            customParams: null,
            updatedAt: '2026-07-24T10:00:00.000Z',
          },
        },
        valid: {
          ...meta,
          kind: 'taxSetting',
          data: {
            mode: 'manual_per_trade',
            country: null,
            manualDefaultAmountEur: null,
            manualDefaultRatePct: 1.123456,
            customParams: null,
            updatedAt: '2026-07-24T10:00:00.000Z',
          },
        },
      },
    ];

    for (const testCase of cases) {
      expect(
        vaultDocumentV1Schema.safeParse({
          schemaVersion: 1,
          entities: [testCase.invalid],
        }).success,
        testCase.label,
      ).toBe(false);
      expect(
        vaultDocumentV1Schema.safeParse({
          schemaVersion: 1,
          entities: [testCase.valid],
        }).success,
        testCase.label,
      ).toBe(true);
    }
  });

  it('rejects non-cent cash and negative manual tax facts', () => {
    const cash = {
      id: UUID_A,
      kind: 'cashMovement',
      rev: 0,
      editedAt: '2026-07-24T10:00:00.000Z',
      editedBy: UUID_B,
      deletedAt: null,
      data: {
        portfolioId: UUID_A,
        sourceId: UUID_B,
        kind: 'deposit',
        amountEur: 1.001,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-24T10:00:00.000Z',
        createdAt: '2026-07-24T10:00:00.000Z',
        note: null,
        source: 'manual',
      },
    };
    expect(vaultDocumentV1Schema.safeParse({ schemaVersion: 1, entities: [cash] }).success).toBe(
      false,
    );
    expect(
      vaultDocumentV1Schema.safeParse({
        schemaVersion: 1,
        entities: [
          {
            id: UUID_A,
            kind: 'dividend',
            rev: 0,
            editedAt: '2026-07-24T10:00:00.000Z',
            editedBy: UUID_B,
            deletedAt: null,
            data: {
              portfolioId: UUID_A,
              assetId: UUID_B,
              cashSourceId: UUID_C,
              grossAmountEur: 10,
              executedAt: '2026-07-24T10:00:00.000Z',
              createdAt: '2026-07-24T10:00:00.000Z',
              note: null,
              source: 'manual',
              taxMode: 'manual_per_trade',
              taxCountry: null,
              taxAmountEur: -1,
              taxParams: null,
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed graph-shaped source row before a service sees it', () => {
    expect(
      vaultDocumentV1Schema.safeParse({
        schemaVersion: 1,
        entities: [
          {
            id: UUID_A,
            kind: 'cashMovement',
            rev: 0,
            editedAt: '2026-07-24T10:00:00.000Z',
            editedBy: UUID_B,
            deletedAt: null,
            data: {
              portfolioId: UUID_A,
              sourceId: UUID_B,
              kind: 'deposit',
              amountEur: -1,
              transactionId: null,
              transferId: null,
              counterpartSourceId: null,
              dividendId: null,
              taxYear: null,
              executedAt: '2026-07-24T10:00:00.000Z',
              createdAt: '2026-07-24T10:00:00.000Z',
              note: null,
              source: 'manual',
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires transfer fields together and only on transfer movements', () => {
    const movement = {
      id: UUID_A,
      kind: 'cashMovement',
      rev: 0,
      editedAt: '2026-07-24T10:00:00.000Z',
      editedBy: UUID_B,
      deletedAt: null,
      data: {
        portfolioId: UUID_A,
        sourceId: UUID_B,
        kind: 'deposit',
        amountEur: 1,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-24T10:00:00.000Z',
        createdAt: '2026-07-24T10:00:00.000Z',
        note: null,
        source: 'manual',
      },
    };
    const malformed = [
      { ...movement, data: { ...movement.data, transferId: UUID_C } },
      { ...movement, data: { ...movement.data, counterpartSourceId: UUID_C } },
      {
        ...movement,
        data: {
          ...movement.data,
          kind: 'transfer_in',
          transferId: UUID_C,
        },
      },
      {
        ...movement,
        data: {
          ...movement.data,
          kind: 'transfer_in',
          counterpartSourceId: UUID_C,
        },
      },
    ];

    for (const entity of malformed) {
      expect(
        vaultDocumentV1Schema.safeParse({ schemaVersion: 1, entities: [entity] }).success,
      ).toBe(false);
    }
    expect(
      vaultDocumentV1Schema.safeParse({
        schemaVersion: 1,
        entities: [
          {
            ...movement,
            data: {
              ...movement.data,
              kind: 'transfer_in',
              transferId: UUID_C,
              counterpartSourceId: UUID_A,
            },
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('internal paranoid-disable DTOs', () => {
  const request = {
    rehydrationId: UUID_A,
    document: { schemaVersion: 1, entities: [], mergeLog: [] },
  };

  it('pins the rehydration id and strict v1 document on the request', () => {
    expect(paranoidDisableRehydrationRequestSchema.parse(request)).toEqual(request);
    expect(
      paranoidDisableRehydrationRequestSchema.safeParse({
        ...request,
        rehydrationId: 'not-a-uuid',
      }).success,
    ).toBe(false);
    expect(
      paranoidDisableRehydrationRequestSchema.safeParse({ ...request, decryptedRows: 4 }).success,
    ).toBe(false);
  });

  it('returns only the non-sensitive receipt and deterministic post-commit plan', () => {
    const result = {
      rehydrationId: UUID_A,
      completedAt: '2026-07-24T10:00:00.000Z',
      idempotent: false,
      postCommit: { invalidate: ['account', 'portfolio', 'expenses', 'standingOrders', 'tax'] },
    };
    expect(paranoidDisableRehydrationResultSchema.parse(result)).toEqual(result);
    expect(
      paranoidDisableRehydrationResultSchema.safeParse({ ...result, restoredRows: 14 }).success,
    ).toBe(false);
  });
});
