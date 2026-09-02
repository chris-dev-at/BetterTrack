import {
  createHash,
  generateKeyPairSync,
  verify as nodeVerify,
  createPublicKey,
} from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  VAULT_DOC_SCHEMA_VERSION,
  inspectVaultDocEnvelope,
  serializePortfolioVaultMoveOutProofTranscript,
  serializePortfolioVaultRestoreDocument,
  serializeVaultRetirementVersionSet,
  vaultStrictDocumentV1Schema,
  type CustomAssetVaultSnapshot,
  type PerVaultMediaDocAttestation,
  type PerVaultMediaTransitionRequest,
  type PortfolioSummary,
  type PortfolioVaultImportCaptureResponse,
  type VaultCommonDoc,
  type VaultConfig,
  type VaultDocEnvelopeHeader,
  type VaultEntity,
  type VaultHeaderDoc,
  type VaultPortfolioDoc,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import type { PortfolioStore } from '../../lib/portfolioStore';
import type { VaultDocEnvelopeRead } from '../../lib/vaultsApi';
import { utf8, zeroBytes } from './bytes';
import { decodeBase64Url, encodeBase64Url } from './keys/base64url';
import { deriveAccountBinding } from './keys';
import { decryptVaultDoc, encryptVaultDoc } from './keys/documents';
import {
  createPortfolioVaultMoveCapture,
  type PortfolioMoveCaptureApi,
} from './portfolioMoveCapture';
import type { PortfolioVaultKeystore } from './portfolioStoreResolver';

/**
 * The E6 capture against an in-memory E1 blind store with REAL crypto on both
 * halves: AES-256-GCM envelopes with full-header AAD on move-in, and the
 * Ed25519 phrase-possession transcript on move-out, verified here exactly the
 * way `portfolioVaultPhraseProof.verifyPortfolioVaultMoveOutPhraseProof` does
 * it server-side (same contracts serializer, same DER key, node:crypto verify).
 */

const ACCOUNT_ID = '018f0000-0000-7000-8000-0000000000aa';
const VAULT_ID = '018f0000-0000-7000-8000-0000000000b1';
const HEADER_DOC_ID = '018f0000-0000-7000-8000-0000000000b2';
const COMMON_DOC_ID = '018f0000-0000-7000-8000-0000000000b3';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-0000000000b4';
const ASSET_ID = '018f0000-0000-7000-8000-0000000000b5';
const SOURCE_ID = '018f0000-0000-7000-8000-0000000000b6';
const MOVEMENT_ID = '018f0000-0000-7000-8000-0000000000b7';
const TRANSACTION_ID = '018f0000-0000-7000-8000-0000000000b8';
const DIVIDEND_ID = '018f0000-0000-7000-8000-0000000000bd';
const KEY_ID = '018f0000-0000-7000-8000-0000000000b9';
const REVISION = 'portfolio_move_capture_revision_vector';
/** Typed into rows below; must NEVER appear in any byte written to the store. */
const CLEARTEXT_CANARY = 'CLEARTEXT-CANARY-do-not-store-me';

const proofPair = generateKeyPairSync('ed25519');
const PROOF_PUBLIC = encodeBase64Url(
  new Uint8Array(proofPair.publicKey.export({ format: 'der', type: 'spki' })),
);
const PROOF_PRIVATE = encodeBase64Url(
  new Uint8Array(proofPair.privateKey.export({ format: 'der', type: 'pkcs8' })),
);

const CONTENT_KEY = new Uint8Array(32).map((_, index) => (index * 13 + 7) % 256);
const KEY_SLOT = {
  keyId: KEY_ID,
  slot: 'seed-v1' as const,
  wrappedKc: encodeBase64Url(new Uint8Array(60).fill(9)),
};

const VAULT: VaultConfig = {
  id: VAULT_ID,
  name: 'Move vault',
  headerDocId: HEADER_DOC_ID,
  commonDocId: COMMON_DOC_ID,
  media: ['server'],
  driveConnectionId: null,
  keyFingerprint: 'abcdefghijklmnop',
  retirementProofPublicKey: PROOF_PUBLIC,
  retirementGeneration: 0,
  mediaAttestedAt: '2026-08-27T10:00:00.000Z',
  mediaAttestedDriveConnectionId: null,
  createdAt: '2026-08-27T09:00:00.000Z',
  updatedAt: '2026-08-27T10:00:00.000Z',
};

const PLAIN_PORTFOLIO = {
  id: PORTFOLIO_ID,
  name: `Growth ${CLEARTEXT_CANARY}`,
  isDefault: false,
  sortOrder: 1,
  visibility: 'private',
  defaultPayFromCash: false,
  archivedAt: null,
  kind: null,
  vaultId: null,
  vaultAlias: null,
} as unknown as PortfolioSummary;

const MARKET_ASSET = {
  id: ASSET_ID,
  symbol: 'AAPL',
  name: 'Apple Inc.',
  exchange: 'NASDAQ',
  currency: 'USD',
  type: 'stock',
  isCustom: false,
  category: null,
  smoothing: null,
};

// ── #1529 lossless-capture fixtures ─────────────────────────────────────────
const BATCH_ID = '018f0000-0000-7000-8000-0000000000c5';
const ROW_IDS = [
  '018f0000-0000-7000-8000-0000000000c6',
  '018f0000-0000-7000-8000-0000000000c7',
] as const;
const CANDIDATE_ASSET_ID = '018f0000-0000-7000-8000-0000000000c8';
const MANUAL_ASSET_ID = '018f0000-0000-7000-8000-0000000000c9';
const MANUAL_TRANSACTION_ID = '018f0000-0000-7000-8000-0000000000ca';

function importFixture(): {
  batches: PortfolioVaultImportCaptureResponse['batches'];
  rows: PortfolioVaultImportCaptureResponse['rows'];
} {
  return {
    batches: [
      {
        id: BATCH_ID,
        data: {
          ownerId: ACCOUNT_ID,
          portfolioId: PORTFOLIO_ID,
          brokerId: 'generic',
          filename: `${CLEARTEXT_CANARY}.csv`,
          status: 'applied',
          cashSourceId: SOURCE_ID,
          createdAt: '2026-07-30T10:00:00.000Z',
          appliedAt: '2026-07-30T10:05:00.000Z',
          understanding: {
            mappings: [
              {
                header: 'Datum',
                field: 'date',
                confidence: 0.97,
                reason: 'header match',
                needsReview: false,
                alternative: { header: 'Buchungstag', confidence: 0.4 },
                source: 'ai',
              },
            ],
            unmappedHeaders: [CLEARTEXT_CANARY],
            delimiter: ';',
            encoding: 'utf-8',
            dateLocale: 'de-AT',
            numberLocale: 'de-AT',
            dateLocaleAmbiguous: true,
          },
        },
      },
    ],
    rows: [
      {
        id: ROW_IDS[0],
        data: {
          batchId: BATCH_ID,
          rowIndex: 1,
          raw: `01.08.2026;AAPL;Kauf;2;101,5;${CLEARTEXT_CANARY}`,
          kind: 'buy',
          flag: 'mapped',
          message: null,
          executedAt: '2026-08-01T10:00:00.000Z',
          isin: 'US0378331005',
          symbol: 'AAPL',
          name: 'Apple Inc.',
          quantity: '2.00000000',
          price: '101.500000',
          fee: '1.000000',
          amountEur: null,
          currency: 'USD',
          note: CLEARTEXT_CANARY,
          assetId: ASSET_ID,
          contentHash: 'row-1-hash',
          result: 'applied',
          resultMessage: null,
          candidates: null,
          ruleTagIds: null,
          resolvedBy: 'user',
          kindUndecided: false,
        },
      },
      {
        id: ROW_IDS[1],
        data: {
          batchId: BATCH_ID,
          rowIndex: 2,
          raw: '02.08.2026;APLE?;Kauf;0,12345678;99,999999',
          kind: 'buy',
          flag: 'unmapped',
          message: 'No exact identity match',
          executedAt: '2026-08-02T10:00:00.000Z',
          isin: null,
          symbol: 'APLE?',
          name: null,
          quantity: '0.12345678',
          price: '99.999999',
          fee: null,
          amountEur: null,
          currency: 'USD',
          note: null,
          assetId: null,
          contentHash: 'row-2-hash',
          result: 'skipped_unmapped',
          resultMessage: 'unresolved',
          candidates: [
            {
              id: CANDIDATE_ASSET_ID,
              symbol: 'APLE',
              name: 'Apple Hospitality REIT',
              currency: 'USD',
              exchange: 'NYSE',
              type: 'stock',
            },
          ],
          ruleTagIds: null,
          resolvedBy: null,
          kindUndecided: true,
        },
      },
    ],
  };
}

function manualSnapshotFixture(): CustomAssetVaultSnapshot {
  return {
    id: MANUAL_ASSET_ID,
    asset: {
      providerId: 'manual',
      providerRef: MANUAL_ASSET_ID,
      ownerId: ACCOUNT_ID,
      type: 'custom',
      symbol: 'HOUSE',
      name: `House ${CLEARTEXT_CANARY}`,
      exchange: null,
      currency: 'EUR',
      // Exactly what jsonb holds — more than the rounded DTO ever showed.
      meta: {
        category: 'property',
        smoothing: false,
        valuation: { source: 'owner', nested: [1, null] },
      },
      searchText: `HOUSE House ${CLEARTEXT_CANARY}`,
    },
    values: [
      // Beyond Number precision on purpose: the seam must never float.
      { assetId: MANUAL_ASSET_ID, date: '2026-07-01', close: '98765432109876.654321' },
      { assetId: MANUAL_ASSET_ID, date: '2026-07-15', close: '0.000001' },
    ],
  };
}

const MANUAL_ASSET_DTO = {
  id: MANUAL_ASSET_ID,
  symbol: 'HOUSE',
  name: `House ${CLEARTEXT_CANARY}`,
  exchange: null,
  currency: 'EUR',
  type: 'custom',
  isCustom: true,
  category: 'property',
  smoothing: false,
};

function transactionFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TRANSACTION_ID,
    assetId: ASSET_ID,
    side: 'buy',
    quantity: 2,
    price: 101.5,
    fee: 1,
    executedAt: '2026-08-01T10:00:00.000Z',
    note: CLEARTEXT_CANARY,
    allowUncovered: false,
    uncoveredEntryPrice: null,
    source: 'manual',
    asset: MARKET_ASSET,
    ...overrides,
  };
}

/** The one settled year the harness reports when `state.taxYear` is set. */
const TAX_YEAR = 2026;

function sellFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return transactionFixture({ side: 'sell', ...overrides });
}

/** One `taxYearSellSchema` row — the ONLY endpoint stating a sell's frozen facts. */
function taxYearSellFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    transactionId: TRANSACTION_ID,
    executedAt: '2026-08-01T10:00:00.000Z',
    quantity: 2,
    proceedsEur: 203,
    costBasisEur: 200,
    realizedPnlEur: 3,
    taxMode: 'none',
    taxAmountEur: null,
    taxCountry: null,
    taxParams: null,
    ...overrides,
  };
}

function dividendFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: DIVIDEND_ID,
    portfolioId: PORTFOLIO_ID,
    assetId: ASSET_ID,
    cashSourceId: SOURCE_ID,
    grossAmountEur: 12.5,
    executedAt: '2026-08-02T10:00:00.000Z',
    note: null,
    taxMode: 'none',
    taxCountry: null,
    taxAmountEur: null,
    taxParams: null,
    source: 'manual',
    createdAt: '2026-08-02T10:00:00.000Z',
    asset: MARKET_ASSET,
    ...overrides,
  };
}

/** The year-report twin of {@link dividendFixture}; the two must agree. */
function taxYearDividendFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    dividendId: DIVIDEND_ID,
    executedAt: '2026-08-02T10:00:00.000Z',
    grossAmountEur: 12.5,
    taxMode: 'none',
    taxAmountEur: null,
    taxCountry: null,
    taxParams: null,
    ...overrides,
  };
}

interface Harness {
  docs: Map<string, { envelope: Uint8Array; header: VaultDocEnvelopeHeader }>;
  writes: string[];
  putBodies: Uint8Array[];
  attestations: Array<{
    expectedMediaAttestedAt: string | null;
    docs: PerVaultMediaDocAttestation[];
  }>;
  mediaAttestedAt: () => string | null;
  api: PortfolioMoveCaptureApi;
  keys: PortfolioVaultKeystore;
  reader: { read: (vaultId: string, docId: string) => Promise<VaultDocEnvelopeRead> };
  store: PortfolioStore;
  state: {
    roster: PortfolioSummary[];
    revision: { portfolioDataRevision: string; importBatchCount: number };
    /** FIFO of settled re-reads; the last entry answers every further read. */
    settledRevisions: Array<{ portfolioDataRevision: string; importBatchCount: number }>;
    transactions: ReturnType<typeof transactionFixture>[];
    dividends: ReturnType<typeof dividendFixture>[];
    /**
     * The frozen facts the year drill-down states. `null` = no settled year at
     * all, so `getTaxYearReport` must never be called (the default shape).
     */
    taxYear: {
      sells: ReturnType<typeof taxYearSellFixture>[];
      dividends: ReturnType<typeof taxYearDividendFixture>[];
    } | null;
    lifecycleGeneration: number;
    /** #1529: what the lossless import-capture read serves (all batches; rows paged). */
    importBatches: PortfolioVaultImportCaptureResponse['batches'];
    importRows: PortfolioVaultImportCaptureResponse['rows'];
    /** #1529: the owner's manual assets the snapshot seam holds; anything else is absent. */
    manualAssets: Map<string, CustomAssetVaultSnapshot>;
  };
}

async function seedVaultDocuments(
  harness: Harness,
  options: { memberPortfolioDoc?: boolean; commonEntities?: VaultCommonDoc['entities'] } = {},
): Promise<void> {
  const accountBinding = await deriveAccountBinding(ACCOUNT_ID);
  const clientSecurity = {
    retirementProof: { publicKey: PROOF_PUBLIC, privateKey: PROOF_PRIVATE },
  };
  const headerDocument: VaultHeaderDoc = {
    schemaVersion: VAULT_DOC_SCHEMA_VERSION,
    name: VAULT.name,
    portfolios: options.memberPortfolioDoc
      ? [{ id: PORTFOLIO_ID, name: PLAIN_PORTFOLIO.name }]
      : [],
    keySlots: [KEY_SLOT],
    driveConnection: null,
    created: { at: '2026-08-27T09:00:00.000Z', deviceId: '018f0000-0000-7000-8000-0000000000c0' },
  };
  const commonDocument: VaultCommonDoc = {
    schemaVersion: VAULT_DOC_SCHEMA_VERSION,
    entities: options.commonEntities ?? {},
    mergeLog: [],
    mirrorProvenance: [],
    clientSecurity,
  };
  const base = {
    keyId: KEY_ID,
    keySlots: [KEY_SLOT],
    vaultId: VAULT_ID,
    accountBinding,
    docVersion: 1,
    schemaVersion: VAULT_DOC_SCHEMA_VERSION,
    deviceId: '018f0000-0000-7000-8000-0000000000c0',
    writtenAt: '2026-08-27T09:00:00.000Z',
  };
  for (const [document, docId, docKind] of [
    [headerDocument, HEADER_DOC_ID, 'header'],
    [commonDocument, COMMON_DOC_ID, 'common'],
  ] as const) {
    const plaintext = utf8(JSON.stringify(document));
    const encrypted = await encryptVaultDoc({
      plaintext,
      contentKey: CONTENT_KEY,
      header: {
        ...base,
        docId,
        docKind,
        writeId: `018f0000-0000-7000-8000-0000000000c${docKind === 'header' ? '1' : '2'}`,
      },
    });
    zeroBytes(plaintext);
    harness.docs.set(docId, { envelope: encrypted.envelope, header: encrypted.header });
  }
}

function createHarness(): Harness {
  const docs = new Map<string, { envelope: Uint8Array; header: VaultDocEnvelopeHeader }>();
  const writes: string[] = [];
  const putBodies: Uint8Array[] = [];
  const attestations: Harness['attestations'] = [];
  let mediaAttestedAt: string | null = VAULT.mediaAttestedAt;

  const state: Harness['state'] = {
    roster: [PLAIN_PORTFOLIO],
    revision: { portfolioDataRevision: REVISION, importBatchCount: 0 },
    settledRevisions: [{ portfolioDataRevision: REVISION, importBatchCount: 0 }],
    transactions: [transactionFixture()],
    dividends: [],
    taxYear: null,
    lifecycleGeneration: 1,
    importBatches: [],
    importRows: [],
    manualAssets: new Map(),
  };

  const notCalled = (name: string) => async () => {
    throw new Error(`TEST VECTOR: ${name} must not be called`);
  };

  const api: PortfolioMoveCaptureApi = {
    getMe: (async () => ({ id: ACCOUNT_ID })) as PortfolioMoveCaptureApi['getMe'],
    getPortfolioVaultRevision: (async () => {
      // Mirror E4's `beginPortfolioVaultCapture`: while the portfolio is still
      // PLAIN server-side, every revision read clears an uncommitted
      // prospective blob left by an earlier refused attempt and voids the
      // full-set proof (the roster it attested no longer matches the store).
      const plain = state.roster.some(
        (portfolio) => portfolio.id === PORTFOLIO_ID && portfolio.vaultId == null,
      );
      if (plain && docs.delete(PORTFOLIO_ID)) mediaAttestedAt = null;
      return state.settledRevisions.length > 1
        ? state.settledRevisions.shift()!
        : state.settledRevisions[0]!;
    }) as PortfolioMoveCaptureApi['getPortfolioVaultRevision'],
    getPortfolioVaultLifecycle: (async (portfolioId: string) => ({
      portfolioId,
      vaultId: VAULT_ID,
      lifecycleGeneration: state.lifecycleGeneration,
    })) as PortfolioMoveCaptureApi['getPortfolioVaultLifecycle'],
    getVaultMediaState: (async () => ({
      vaultId: VAULT_ID,
      media: ['server'],
      driveConnectionId: null,
      mediaAttestedAt,
      mediaAttestedDriveConnectionId: null,
      server: { disposition: 'active', candidates: [], retirement: null },
    })) as PortfolioMoveCaptureApi['getVaultMediaState'],
    transitionVaultMedia: (async (_vaultId: string, request: PerVaultMediaTransitionRequest) => {
      if (request.verification.kind !== 'server') {
        throw new Error('TEST VECTOR: only server verification is supported');
      }
      if (request.expected.mediaAttestedAt !== mediaAttestedAt) {
        throw new Error('TEST VECTOR: attestation CAS mismatch');
      }
      const expected = new Map([...docs.entries()].map(([docId, doc]) => [docId, doc.header]));
      if (request.verification.docs.length !== expected.size) {
        throw new Error('TEST VECTOR: partial attestation roster');
      }
      for (const attested of request.verification.docs) {
        const current = expected.get(attested.docId);
        if (
          !current ||
          current.docVersion !== attested.docVersion ||
          current.writeId !== attested.writeId
        ) {
          throw new Error(`TEST VECTOR: attestation mismatch for ${attested.docId}`);
        }
      }
      attestations.push({
        expectedMediaAttestedAt: request.expected.mediaAttestedAt,
        docs: [...request.verification.docs],
      });
      mediaAttestedAt = '2026-08-27T11:00:00.000Z';
      return {
        vaultId: VAULT_ID,
        media: ['server'],
        driveConnectionId: null,
        mediaAttestedAt,
        mediaAttestedDriveConnectionId: null,
        server: { disposition: 'active', candidates: [], retirement: null },
      };
    }) as PortfolioMoveCaptureApi['transitionVaultMedia'],
    writeVaultDocument: (async (
      _vaultId: string,
      docId: string,
      envelope: Uint8Array,
      options: { ifVersion: number | null },
    ) => {
      const inspected = inspectVaultDocEnvelope(envelope);
      if (inspected.status !== 'supported') throw new Error('TEST VECTOR: malformed envelope');
      const current = docs.get(docId) ?? null;
      if ((current?.header.docVersion ?? null) !== options.ifVersion) {
        // The production wire shape: E1 answers a CAS miss with 412, surfaced
        // by `vaultApi.writeVaultDocument` as this exact typed ApiError.
        throw new ApiError(
          412,
          'VAULT_DOCUMENT_CAS_CONFLICT',
          'The vault document changed underneath this write.',
          { currentVersion: current?.header.docVersion ?? null },
        );
      }
      docs.set(docId, { envelope: envelope.slice(), header: inspected.header });
      writes.push(docId);
      putBodies.push(envelope.slice());
      mediaAttestedAt = null; // any live write voids the full-set proof (E1)
    }) as PortfolioMoveCaptureApi['writeVaultDocument'],
    listDividends: (async () => ({
      dividends: state.dividends,
    })) as unknown as PortfolioMoveCaptureApi['listDividends'],
    getTaxYearReports: (async () => ({
      years: state.taxYear === null ? [] : [{ year: TAX_YEAR }],
    })) as unknown as PortfolioMoveCaptureApi['getTaxYearReports'],
    getTaxYearReport: (async () => {
      if (state.taxYear === null)
        throw new Error('TEST VECTOR: getTaxYearReport must not be called');
      return {
        year: TAX_YEAR,
        summary: {},
        positions: [
          {
            asset: MARKET_ASSET,
            realizedPnlEur: 0,
            dividendsGrossEur: 0,
            taxEur: 0,
            sells: state.taxYear.sells,
            dividends: state.taxYear.dividends,
          },
        ],
      };
    }) as unknown as PortfolioMoveCaptureApi['getTaxYearReport'],
    listStandingOrderRuns: (async () => ({
      runs: [],
    })) as unknown as PortfolioMoveCaptureApi['listStandingOrderRuns'],
    listAllCashBudgets: (async () => ({
      budgets: [],
    })) as unknown as PortfolioMoveCaptureApi['listAllCashBudgets'],
    getAssetDetail: notCalled(
      'getAssetDetail',
    ) as unknown as PortfolioMoveCaptureApi['getAssetDetail'],
    getParanoidForkProvenance: (async () => ({
      provenance: [],
    })) as PortfolioMoveCaptureApi['getParanoidForkProvenance'],
    // #1529 capability seams. The harness mirrors the server: every batch on
    // every page, rows paged by the (batchId, rowIndex, id) keyset cursor.
    listPortfolioVaultImportBatches: (async (_portfolioId: string, query = {}) => {
      const sorted = [...state.importRows].sort(
        (left, right) =>
          left.data.batchId.localeCompare(right.data.batchId) ||
          left.data.rowIndex - right.data.rowIndex ||
          left.id.localeCompare(right.id),
      );
      const start =
        query.cursor === undefined
          ? 0
          : sorted.findIndex(
              (row) => `${row.data.batchId}:${row.data.rowIndex}:${row.id}` === query.cursor,
            ) + 1;
      const limit = query.limit ?? 1; // one row per page: paging is exercised on every capture
      const page = sorted.slice(start, start + limit);
      const last = page.at(-1);
      const hasMore = start + limit < sorted.length;
      return {
        batches: structuredClone(state.importBatches),
        rows: structuredClone(page),
        nextCursor:
          hasMore && last ? `${last.data.batchId}:${last.data.rowIndex}:${last.id}` : null,
      };
    }) as PortfolioMoveCaptureApi['listPortfolioVaultImportBatches'],
    getCustomAssetVaultSnapshots: (async (ids: readonly string[]) => {
      const unique = [...new Set(ids)].sort();
      return {
        present: unique
          .filter((id) => state.manualAssets.has(id))
          .map((id) => structuredClone(state.manualAssets.get(id)!)),
        absentIds: unique.filter((id) => !state.manualAssets.has(id)),
      };
    }) as PortfolioMoveCaptureApi['getCustomAssetVaultSnapshots'],
  };

  const keys: PortfolioVaultKeystore = {
    stateFor: async () => ({ status: 'stored+plain', requiredAction: { kind: 'open-silently' } }),
    openStoredVault: async (vaultId) => ({
      vaultId,
      keyId: KEY_ID,
      keyFingerprint: VAULT.keyFingerprint,
    }),
    withContentKey: async (_vaultId, operation) => {
      const borrowed = CONTENT_KEY.slice();
      try {
        return await operation(borrowed, KEY_ID, () => {});
      } finally {
        zeroBytes(borrowed);
      }
    },
  };

  const reader = {
    read: async (_vaultId: string, docId: string): Promise<VaultDocEnvelopeRead> => {
      const doc = docs.get(docId);
      if (!doc) throw new Error(`TEST VECTOR: document ${docId} is absent`);
      return { envelope: doc.envelope.slice(), header: doc.header };
    },
  };

  const store = {
    listPortfolios: async () => ({ portfolios: state.roster }),
    listTransactions: async () => ({ items: state.transactions, nextCursor: null }),
    getCashMovements: async () => ({
      sources: [
        {
          id: SOURCE_ID,
          name: 'Main',
          type: 'cash',
          isMain: true,
          archivedAt: null,
          createdAt: '2026-07-01T10:00:00.000Z',
        },
      ],
      movements: [
        {
          id: MOVEMENT_ID,
          kind: 'deposit',
          amountEur: 1000,
          sourceId: SOURCE_ID,
          transactionId: null,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: '2026-07-01T10:00:00.000Z',
          note: null,
          source: 'manual',
          createdAt: '2026-07-01T10:00:00.000Z',
          tags: [],
        },
      ],
      nextCursor: null,
    }),
    getPortfolioTaxSettings: async () => ({ override: null }),
    listStandingOrders: async () => ({ orders: [] }),
  } as unknown as PortfolioStore;

  return {
    docs,
    writes,
    putBodies,
    attestations,
    mediaAttestedAt: () => mediaAttestedAt,
    api,
    keys,
    reader,
    store,
    state,
  };
}

function capture(harness: Harness) {
  return createPortfolioVaultMoveCapture({
    keys: harness.keys,
    reader: harness.reader,
    store: harness.store,
    api: harness.api,
    now: () => '2026-08-27T10:30:00.000Z',
  });
}

async function runMoveIn(harness: Harness) {
  return capture(harness).captureMoveIn({
    portfolioId: PORTFOLIO_ID,
    vault: VAULT,
    portfolioDataRevision: REVISION,
  });
}

/** Flip the fake account into the post-move-in shape for a move-out capture. */
function vaultThePortfolio(harness: Harness): void {
  harness.state.roster = [
    { ...PLAIN_PORTFOLIO, vaultId: VAULT_ID, vaultAlias: VAULT.name } as PortfolioSummary,
  ];
}

let harness: Harness;

beforeEach(async () => {
  harness = createHarness();
  await seedVaultDocuments(harness);
});

describe('captureMoveIn', () => {
  it('writes portfolio → header → common, verifies round trips, attests the full set, and returns docVersion 1', async () => {
    await expect(runMoveIn(harness)).resolves.toEqual({
      docVersion: 1,
      portfolioDataRevision: REVISION,
    });

    // Order is load-bearing: the prospective portfolio write binds the capture
    // while the full-set proof is still current; header/common follow.
    expect(harness.writes).toEqual([PORTFOLIO_ID, HEADER_DOC_ID, COMMON_DOC_ID]);

    // One final same-selection attestation refresh over the EXACT new roster.
    expect(harness.attestations).toHaveLength(1);
    expect(harness.attestations[0]!.expectedMediaAttestedAt).toBeNull();
    expect(new Set(harness.attestations[0]!.docs.map(({ docId }) => docId))).toEqual(
      new Set([HEADER_DOC_ID, COMMON_DOC_ID, PORTFOLIO_ID]),
    );
    expect(harness.mediaAttestedAt()).not.toBeNull();
  });

  it('never sends cleartext: no PUT body contains the canary bytes, and every doc decrypts only at its own AAD address', async () => {
    await runMoveIn(harness);

    const canary = utf8(CLEARTEXT_CANARY);
    for (const body of harness.putBodies) {
      expect(containsBytes(body, canary)).toBe(false);
    }

    const stored = harness.docs.get(PORTFOLIO_ID)!;
    const accountBinding = await deriveAccountBinding(ACCOUNT_ID);
    const opened = await decryptVaultDoc({
      envelope: stored.envelope,
      contentKey: CONTENT_KEY,
      expected: {
        vaultId: VAULT_ID,
        docId: PORTFOLIO_ID,
        docKind: 'portfolio',
        accountBinding,
        keyId: KEY_ID,
      },
    });
    const document = JSON.parse(new TextDecoder().decode(opened.plaintext)) as {
      portfolioId: string;
      entities: Record<string, Array<{ id: string; data: Record<string, unknown> }>>;
    };
    expect(document.portfolioId).toBe(PORTFOLIO_ID);
    const transaction = document.entities.transaction!.find(({ id }) => id === TRANSACTION_ID)!;
    // Exact decimal strings, frozen buy-side tax facts, verbatim note.
    expect(transaction.data).toMatchObject({
      portfolioId: PORTFOLIO_ID,
      assetId: ASSET_ID,
      quantity: '2',
      price: '101.5',
      fee: '1',
      note: CLEARTEXT_CANARY,
      taxMode: null,
      taxCountry: null,
      taxAmountEur: null,
    });
    expect(document.entities.cashMovement!.map(({ id }) => id)).toEqual([MOVEMENT_ID]);
    expect(document.entities.cashSource!.map(({ id }) => id)).toEqual([SOURCE_ID]);

    // The §5 anti-swap guarantee: the same bytes REFUSE decryption when the
    // caller expects a different doc address — the header rides the AAD.
    await expect(
      decryptVaultDoc({
        envelope: stored.envelope,
        contentKey: CONTENT_KEY,
        expected: { docId: COMMON_DOC_ID },
      }),
    ).rejects.toMatchObject({ name: 'VaultKeyCoreError' });

    // The header roster gained exactly this portfolio, and the common doc
    // folded the referenced market-asset snapshot for the client engine.
    const header = await decryptVaultDoc({
      envelope: harness.docs.get(HEADER_DOC_ID)!.envelope,
      contentKey: CONTENT_KEY,
      expected: { docId: HEADER_DOC_ID, docVersion: 2 },
    });
    const headerDoc = JSON.parse(new TextDecoder().decode(header.plaintext)) as VaultHeaderDoc;
    expect(headerDoc.portfolios).toEqual([{ id: PORTFOLIO_ID, name: PLAIN_PORTFOLIO.name }]);
    const common = await decryptVaultDoc({
      envelope: harness.docs.get(COMMON_DOC_ID)!.envelope,
      contentKey: CONTENT_KEY,
      expected: { docId: COMMON_DOC_ID, docVersion: 2 },
    });
    const commonDoc = JSON.parse(new TextDecoder().decode(common.plaintext)) as VaultCommonDoc;
    expect(commonDoc.entities.customAsset).toHaveLength(1);
    expect(commonDoc.entities.customAsset![0]).toMatchObject({
      id: ASSET_ID,
      data: { ownerId: null, providerId: 'yahoo', symbol: 'AAPL' },
    });
  });

  it('refreshes a voided attestation before the prospective write (failed-attempt recovery path)', async () => {
    // A prior aborted attempt leaves the full-set proof nulled; the capture
    // must restore it FIRST or the prospective portfolio write cannot bind.
    await harness.api.transitionVaultMedia(VAULT_ID, {
      transitionId: '018f0000-0000-7000-8000-0000000000d7',
      expected: {
        media: ['server'],
        driveConnectionId: null,
        mediaAttestedAt: VAULT.mediaAttestedAt,
      },
      next: { media: ['server'], driveConnectionId: null },
      verification: {
        kind: 'server',
        docs: [HEADER_DOC_ID, COMMON_DOC_ID].map((docId) => ({
          docId,
          docVersion: harness.docs.get(docId)!.header.docVersion,
          writeId: harness.docs.get(docId)!.header.writeId,
        })),
      },
    } as PerVaultMediaTransitionRequest);
    harness.attestations.length = 0;
    // Simulate the post-failure state: proof voided, no prospective blob.
    await harness.api.writeVaultDocument(
      VAULT_ID,
      HEADER_DOC_ID,
      harness.docs.get(HEADER_DOC_ID)!.envelope.slice(),
      { ifVersion: 1 },
    );
    // Rewriting bumped nothing semantically but voided the proof; put the
    // stored version back to 1 for a clean CAS base.
    expect(harness.mediaAttestedAt()).toBeNull();
    harness.writes.length = 0;
    harness.putBodies.length = 0;

    await expect(runMoveIn(harness)).resolves.toEqual({
      docVersion: 1,
      portfolioDataRevision: REVISION,
    });
    // Two attestations: the recovery refresh over the CURRENT set, then the
    // final refresh over the completed roster.
    expect(harness.attestations).toHaveLength(2);
    expect(new Set(harness.attestations[0]!.docs.map(({ docId }) => docId))).toEqual(
      new Set([HEADER_DOC_ID, COMMON_DOC_ID]),
    );
    expect(new Set(harness.attestations[1]!.docs.map(({ docId }) => docId))).toEqual(
      new Set([HEADER_DOC_ID, COMMON_DOC_ID, PORTFOLIO_ID]),
    );
  });

  it('refuses import history before any ciphertext write when the lossless read seam is absent (#1529: lifted by capability, not deleted)', async () => {
    harness.api.listPortfolioVaultImportBatches = undefined;
    harness.state.settledRevisions = [{ portfolioDataRevision: REVISION, importBatchCount: 2 }];
    // Byte-identical to the #1528 refusal: code AND message (review F4).
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      name: 'PortfolioMoveCaptureError',
      code: 'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
      message: 'This version cannot capture the portfolio’s historical import batches losslessly.',
      retryable: false,
    });
    expect(harness.writes).toEqual([]);
    expect(harness.attestations).toEqual([]);
  });

  it('accepts after exactly one settled rebuild and binds the commit to the ACCEPTED token', async () => {
    // Capture reads write on a fresh portfolio (cash main-source seed, tax
    // self-heal): the first pass legitimately moves its own token, the second
    // opens on the settled value and must be accepted against IT.
    harness.state.settledRevisions = [
      { portfolioDataRevision: 'seeded_by_the_first_pass', importBatchCount: 0 },
      { portfolioDataRevision: 'seeded_by_the_first_pass', importBatchCount: 0 },
    ];
    await expect(runMoveIn(harness)).resolves.toEqual({
      docVersion: 1,
      portfolioDataRevision: 'seeded_by_the_first_pass',
    });
    expect(harness.writes).toEqual([PORTFOLIO_ID, HEADER_DOC_ID, COMMON_DOC_ID]);
  });

  it('refuses a revision that keeps moving as retryable, before any ciphertext write', async () => {
    harness.state.settledRevisions = [
      { portfolioDataRevision: 'moved_underneath_pass_one', importBatchCount: 0 },
      { portfolioDataRevision: 'moved_underneath_pass_two', importBatchCount: 0 },
    ];
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      code: 'VAULT_MOVE_CAPTURE_UNSTABLE',
      retryable: true,
    });
    expect(harness.writes).toEqual([]);
  });

  it('refuses rows imported from a broker while the read seam is absent (defense in depth under the count gate)', async () => {
    harness.api.listPortfolioVaultImportBatches = undefined;
    harness.state.transactions = [transactionFixture({ source: 'import:csv' })];
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      code: 'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
      message: `This version cannot capture imported rows losslessly (transaction ${TRANSACTION_ID}).`,
      retryable: false,
    });
    expect(harness.writes).toEqual([]);
  });

  it('refuses owner-manual assets while the exact-snapshot seam is absent (#1529: lifted by capability, not deleted)', async () => {
    harness.api.getCustomAssetVaultSnapshots = undefined;
    harness.state.transactions = [
      transactionFixture({
        asset: { ...MARKET_ASSET, isCustom: true, category: 'other', smoothing: false },
      }),
    ];
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      code: 'VAULT_MOVE_MANUAL_ASSETS_UNSUPPORTED',
      message: `This version cannot capture custom asset ${ASSET_ID} with exact values.`,
      retryable: false,
    });
    expect(harness.writes).toEqual([]);
  });

  // #1635: legacy V3-P4 rows freeze `country_specific` with NO country
  // (`drizzle/0021_tax_engine.sql` shipped the column without a backfill). The
  // server settles them as AT; the vault contract has no such fallback, so the
  // capture must refuse them by NAME with its own typed code — not the untyped
  // `Error` the frozen-fact assertion used to raise.
  describe.each([
    {
      label: 'a sell whose year report states the legacy shape',
      arrange: (target: Harness) => {
        target.state.transactions = [sellFixture()];
        target.state.taxYear = {
          sells: [taxYearSellFixture({ taxMode: 'country_specific', taxCountry: null })],
          dividends: [],
        };
      },
      named: `sell ${TRANSACTION_ID}`,
    },
    {
      label: 'a dividend carrying the legacy shape on both of its reads',
      arrange: (target: Harness) => {
        target.state.dividends = [dividendFixture({ taxMode: 'country_specific' })];
        target.state.taxYear = {
          sells: [],
          dividends: [taxYearDividendFixture({ taxMode: 'country_specific', taxCountry: null })],
        };
      },
      named: `dividend ${DIVIDEND_ID}`,
    },
  ])('legacy country-specific row with no frozen country: $label', ({ arrange, named }) => {
    it('refuses with the typed code, names the row, and writes nothing', async () => {
      arrange(harness);
      await expect(runMoveIn(harness)).rejects.toMatchObject({
        name: 'PortfolioMoveCaptureError',
        code: 'VAULT_MOVE_LEGACY_TAX_FACTS_UNSUPPORTED',
        // Needs the `tax_country = 'AT'` backfill, so a retry cannot help.
        retryable: false,
        message: expect.stringContaining(named) as unknown as string,
      });
      expect(harness.writes).toEqual([]);
      expect(harness.attestations).toEqual([]);
    });
  });

  it('names every offending row, not just the one the loop reached first', async () => {
    harness.state.transactions = [sellFixture()];
    harness.state.dividends = [dividendFixture({ taxMode: 'country_specific' })];
    harness.state.taxYear = {
      sells: [taxYearSellFixture({ taxMode: 'country_specific', taxCountry: null })],
      dividends: [taxYearDividendFixture({ taxMode: 'country_specific', taxCountry: null })],
    };
    const refusal = await runMoveIn(harness).then(
      () => null,
      (cause: unknown) => cause as Error & { code: string },
    );
    expect(refusal?.code).toBe('VAULT_MOVE_LEGACY_TAX_FACTS_UNSUPPORTED');
    expect(refusal?.message).toContain(`sell ${TRANSACTION_ID}`);
    expect(refusal?.message).toContain(`dividend ${DIVIDEND_ID}`);
    expect(harness.writes).toEqual([]);
  });

  // Negative space: `taxCountry === null` is the CORRECT frozen shape in every
  // mode except `country_specific`. The refusal must not touch those rows.
  it.each([['none'], ['manual_per_trade']])(
    'leaves a %s row with a null frozen country alone',
    async (taxMode) => {
      harness.state.transactions = [sellFixture()];
      harness.state.dividends = [dividendFixture({ taxMode })];
      harness.state.taxYear = {
        sells: [taxYearSellFixture({ taxMode, taxCountry: null })],
        dividends: [taxYearDividendFixture({ taxMode, taxCountry: null })],
      };
      await expect(runMoveIn(harness)).resolves.toEqual({
        docVersion: 1,
        portfolioDataRevision: REVISION,
      });
      expect(harness.writes).toEqual([PORTFOLIO_ID, HEADER_DOC_ID, COMMON_DOC_ID]);
    },
  );

  it('WEDGE-PROBE (#1528 F1): a refused E4 commit after a completed capture does not wedge the vault — the retry re-captures end to end', async () => {
    // The reviewer's exact interleaving: capture → refused commit → retry.
    // Capture #1 completes every write (portfolio doc, header roster +P,
    // common fold), then the commit is REFUSED (mistyped password,
    // REVISION_STALE, 429, network drop) — server membership still excludes P
    // while the encrypted header roster now contains it.
    await runMoveIn(harness);
    expect(harness.writes).toEqual([PORTFOLIO_ID, HEADER_DOC_ID, COMMON_DOC_ID]);
    harness.writes.length = 0;
    harness.attestations.length = 0;

    // The retry: its own revision read (E4's `beginPortfolioVaultCapture`,
    // mirrored by the harness) deletes P's prospective blob, so the roster
    // names a portfolio with NO document. The loader must tolerate exactly
    // this provable in-flight shape — P is a currently-plain portfolio owned
    // by this account — and the retry must converge instead of throwing
    // `The encrypted header roster does not match the current locked-stub roster.`
    await expect(runMoveIn(harness)).resolves.toEqual({
      docVersion: 1,
      portfolioDataRevision: REVISION,
    });

    // The re-capture rewrote only what the refusal lost: the prospective
    // portfolio doc (fresh v1 after the begin-capture delete). The header
    // roster entry and the common fold are already byte-correct at v2 and are
    // NOT rewritten — the +1 CAS flow is idempotent.
    expect(harness.writes).toEqual([PORTFOLIO_ID]);
    expect(harness.docs.get(HEADER_DOC_ID)!.header.docVersion).toBe(2);
    expect(harness.docs.get(COMMON_DOC_ID)!.header.docVersion).toBe(2);
    expect(harness.docs.get(PORTFOLIO_ID)!.header.docVersion).toBe(1);

    // And the full-set proof is current again over the exact completed roster,
    // ready for E4's destructive commit.
    const finalAttestation = harness.attestations.at(-1)!;
    expect(new Set(finalAttestation.docs.map(({ docId }) => docId))).toEqual(
      new Set([HEADER_DOC_ID, COMMON_DOC_ID, PORTFOLIO_ID]),
    );
    expect(harness.mediaAttestedAt()).not.toBeNull();
  });

  it('still refuses a roster extra that is NOT a plain-owned portfolio (the tolerance is provenance-checked)', async () => {
    // Mutation guard for the F1 tolerance: an attacker-inserted roster entry
    // gains nothing new. GHOST is not in the account's portfolio listing at
    // all, so it is not provably the §9 in-flight state — the open must fail
    // exactly as before the tolerance existed. Removing the plain-owned
    // provenance check from the loader turns this test red.
    const GHOST_ID = '018f0000-0000-7000-8000-0000000000f0';
    await runMoveIn(harness);
    const header = harness.docs.get(HEADER_DOC_ID)!;
    const accountBinding = await deriveAccountBinding(ACCOUNT_ID);
    const opened = await decryptVaultDoc({
      envelope: header.envelope,
      contentKey: CONTENT_KEY,
      expected: {
        vaultId: VAULT_ID,
        docId: HEADER_DOC_ID,
        docKind: 'header',
        accountBinding,
        keyId: KEY_ID,
      },
    });
    const headerDoc = JSON.parse(new TextDecoder().decode(opened.plaintext)) as VaultHeaderDoc;
    const tampered = await encryptVaultDoc({
      plaintext: utf8(
        JSON.stringify({
          ...headerDoc,
          portfolios: [...headerDoc.portfolios, { id: GHOST_ID, name: 'Ghost' }],
        }),
      ),
      contentKey: CONTENT_KEY,
      header: { ...header.header, docVersion: header.header.docVersion + 1 },
    });
    harness.docs.set(HEADER_DOC_ID, { envelope: tampered.envelope, header: tampered.header });

    await expect(runMoveIn(harness)).rejects.toMatchObject({
      name: 'PortfolioDocumentSetError',
      code: 'VAULT_DOCUMENT_SET_CHANGED',
      message: 'The encrypted header roster does not match the current locked-stub roster.',
    });
  });

  it('surfaces a store that lies on read-back as VAULT_MOVE_VERIFY_FAILED (#1528 F3)', async () => {
    // §7 rule 1: the written envelope must read back byte-identical. A store
    // that returns even one flipped ciphertext byte fails the move with the
    // typed retryable code — never a silently-accepted capture.
    const innerRead = harness.reader.read.bind(harness.reader);
    harness.reader.read = async (vaultId: string, docId: string) => {
      const read = await innerRead(vaultId, docId);
      if (docId === PORTFOLIO_ID) read.envelope[read.envelope.length - 1]! ^= 0x01;
      return read;
    };
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      name: 'PortfolioMoveCaptureError',
      code: 'VAULT_MOVE_VERIFY_FAILED',
      retryable: true,
    });
  });

  it('writes nothing when the vault session dies between encryption and the first write (#1528 F3)', async () => {
    // E3 discipline: `assertSessionCurrent` runs after the crypto and before
    // the encrypted result crosses the borrow. A lock race there must abort
    // the capture with ZERO ciphertext writes — not ship documents encrypted
    // under a torn-down session.
    class SessionEndedProbe extends Error {
      constructor() {
        super('TEST VECTOR: vault session ended during operation');
        this.name = 'SessionEndedProbe';
      }
    }
    let borrows = 0;
    const innerWithContentKey = harness.keys.withContentKey.bind(harness.keys);
    harness.keys = {
      ...harness.keys,
      withContentKey: async (vaultId, operation) => {
        borrows += 1;
        if (borrows === 1) return innerWithContentKey(vaultId, operation); // the loader's borrow
        const borrowed = CONTENT_KEY.slice();
        try {
          return await operation(borrowed, KEY_ID, () => {
            throw new SessionEndedProbe();
          });
        } finally {
          zeroBytes(borrowed);
        }
      },
    };
    await expect(runMoveIn(harness)).rejects.toMatchObject({ name: 'SessionEndedProbe' });
    expect(harness.writes).toEqual([]);
    expect(harness.attestations).toEqual([]);
  });

  it('types a mid-sequence CAS conflict as a retryable move-capture conflict (#1528 F4)', async () => {
    // A concurrent writer bumping the header between the open and the write
    // surfaces through `vaultApi` as a raw 412 ApiError. The capture must
    // translate it into its own typed channel so the wizard's error handling
    // stays uniform — with the transport failure preserved as the cause.
    const innerWrite = harness.api.writeVaultDocument.bind(harness.api);
    harness.api.writeVaultDocument = (async (
      vaultId: string,
      docId: string,
      envelope: Uint8Array,
      options: { ifVersion: number | null },
    ) => {
      if (docId === HEADER_DOC_ID) {
        throw new ApiError(
          412,
          'VAULT_DOCUMENT_CAS_CONFLICT',
          'The vault document changed underneath this write.',
          { currentVersion: 2 },
        );
      }
      return innerWrite(vaultId, docId, envelope, options);
    }) as PortfolioMoveCaptureApi['writeVaultDocument'];

    const rejection = expect(runMoveIn(harness)).rejects;
    await rejection.toMatchObject({
      name: 'PortfolioMoveCaptureError',
      code: 'VAULT_MOVE_STATE_CONFLICT',
      retryable: true,
    });
    await rejection.toMatchObject({
      cause: { name: 'ApiError', code: 'VAULT_DOCUMENT_CAS_CONFLICT', status: 412 },
    });
  });

  /**
   * #1530's user-facing half. The server's exact-set attestation refuses with
   * `VAULT_MEDIA_CAPTURE_IN_FLIGHT` when another portfolio's interrupted
   * move-in still holds a prospective blob in the vault. Nothing in the client
   * read that code before, so the wizard could only offer a retry that can
   * never succeed.
   */
  it('translates the in-flight attestation refusal into a NAMED terminal error', async () => {
    const other = '018f0000-0000-7000-8000-0000000000bb';
    harness.state.roster = [
      ...harness.state.roster,
      // Still PLAIN — which is exactly the #1530 shape: its destructive commit
      // was refused, so the portfolio never became a member, but the
      // prospective blob it staged is still sitting in the vault.
      { ...PLAIN_PORTFOLIO, id: other, name: 'Interrupted portfolio' } as PortfolioSummary,
    ];
    harness.api.transitionVaultMedia = (async () => {
      throw new ApiError(
        412,
        'VAULT_MEDIA_CAPTURE_IN_FLIGHT',
        'The readback omits documents an interrupted portfolio move-in staged.',
        { portfolioIds: [other] },
      );
    }) as PortfolioMoveCaptureApi['transitionVaultMedia'];

    const rejection = expect(runMoveIn(harness)).rejects;
    // TERMINAL, not retryable: no readback of THIS portfolio's documents can
    // ever cover the other portfolio's staged blob.
    await rejection.toMatchObject({
      name: 'PortfolioMoveCaptureError',
      code: 'VAULT_MOVE_CAPTURE_IN_FLIGHT',
      retryable: false,
      // Named, so the surface can say WHICH move has to be finished first.
      blockingPortfolios: ['Interrupted portfolio'],
    });
    // The refusal lands on the CLOSING attestation, so this vault now also
    // holds this portfolio's prospective documents — encrypted, inactive, and
    // never committed. What matters is that no attestation was accepted, which
    // is what E4's destructive commit checks before it deletes anything.
    await rejection.toMatchObject({ retryable: false });
    expect(harness.attestations).toEqual([]);
  });

  it('refuses a Drive-carrying vault outright', async () => {
    await expect(
      capture(harness).captureMoveIn({
        portfolioId: PORTFOLIO_ID,
        vault: {
          ...VAULT,
          media: ['server', 'drive'],
          driveConnectionId: '018f0000-0000-7000-8000-0000000000d1',
          mediaAttestedDriveConnectionId: '018f0000-0000-7000-8000-0000000000d1',
        },
        portfolioDataRevision: REVISION,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_MOVE_MEDIA_UNSUPPORTED' });
    expect(harness.writes).toEqual([]);
  });
});

describe('captureMoveOut', () => {
  beforeEach(async () => {
    // The realistic arc: the move-out source docs are EXACTLY what a real
    // move-in wrote — same crypto path a second unlocked device would open.
    await runMoveIn(harness);
    vaultThePortfolio(harness);
  });

  it('builds the strict graph, hashes the exact roster, and signs the challenge so the server verifier accepts it', async () => {
    const draft = await capture(harness).captureMoveOut({
      portfolioId: PORTFOLIO_ID,
      vault: VAULT,
    });
    expect(draft.lifecycleGeneration).toBe(1);

    // documentSetHash: sha256(base64url) over the canonical retirement version
    // set of the exact opened roster — byte-compatible with the server's
    // `documentSetHash(active)` in portfolioVaultTransitionRepository.
    const expectedSetHash = createHash('sha256')
      .update(
        serializeVaultRetirementVersionSet(
          [HEADER_DOC_ID, COMMON_DOC_ID, PORTFOLIO_ID].map((docId) => ({
            docId,
            docVersion: harness.docs.get(docId)!.header.docVersion,
          })),
        ),
      )
      .digest('base64url');
    expect(draft.documentSetHash).toBe(expectedSetHash);

    // documentDigest: the exact idempotency/proof identity E4 recomputes.
    expect(draft.documentDigest).toBe(
      createHash('sha256')
        .update(serializePortfolioVaultRestoreDocument(draft.document))
        .digest('base64url'),
    );

    // The strict document parses and carries the restorable graph verbatim —
    // and NO market-asset snapshot (the server refuses those).
    const parsed = vaultStrictDocumentV1Schema.parse(draft.document);
    const kinds = parsed.entities.map(({ kind }) => kind).sort();
    expect(kinds).toEqual(['cashMovement', 'cashSource', 'portfolio', 'transaction']);
    const transaction = parsed.entities.find(({ kind }) => kind === 'transaction')!;
    expect(transaction.data).toMatchObject({ quantity: '2', price: '101.5', fee: '1' });

    // The signature is EXACTLY what the server-side phrase proof verifies:
    // Ed25519 over the domain-separated transcript, base64url, DER spki key.
    const challenge = 'TEST VECTOR move-out challenge'.padEnd(48, '.');
    const signature = await draft.sign(challenge);
    const verified = nodeVerify(
      null,
      Buffer.from(
        serializePortfolioVaultMoveOutProofTranscript({
          portfolioId: PORTFOLIO_ID,
          vaultId: VAULT_ID,
          lifecycleGeneration: draft.lifecycleGeneration,
          documentDigest: draft.documentDigest,
          documentSetHash: draft.documentSetHash,
          challenge,
        }),
      ),
      createPublicKey({
        key: Buffer.from(decodeBase64Url(VAULT.retirementProofPublicKey)),
        format: 'der',
        type: 'spki',
      }),
      Buffer.from(decodeBase64Url(signature)),
    );
    expect(verified).toBe(true);

    // A transcript with ANY altered claim must not verify: possession proves
    // this graph, this vault, this lifecycle — nothing else.
    expect(
      nodeVerify(
        null,
        Buffer.from(
          serializePortfolioVaultMoveOutProofTranscript({
            portfolioId: PORTFOLIO_ID,
            vaultId: VAULT_ID,
            lifecycleGeneration: draft.lifecycleGeneration + 1,
            documentDigest: draft.documentDigest,
            documentSetHash: draft.documentSetHash,
            challenge,
          }),
        ),
        createPublicKey({
          key: Buffer.from(decodeBase64Url(VAULT.retirementProofPublicKey)),
          format: 'der',
          type: 'spki',
        }),
        Buffer.from(decodeBase64Url(signature)),
      ),
    ).toBe(false);
  });

  it('refuses a vault/lifecycle mismatch before opening anything', async () => {
    await expect(
      capture(harness).captureMoveOut({
        portfolioId: PORTFOLIO_ID,
        vault: { ...VAULT, id: HEADER_DOC_ID, headerDocId: VAULT_ID },
      }),
    ).rejects.toMatchObject({ code: 'VAULT_MOVE_STATE_CONFLICT' });
  });

  it('refuses to sign when the encrypted proof key is not the vault’s registered verifier', async () => {
    await expect(
      capture(harness).captureMoveOut({
        portfolioId: PORTFOLIO_ID,
        vault: {
          ...VAULT,
          retirementProofPublicKey: encodeBase64Url(
            new Uint8Array(
              generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }),
            ),
          ),
        },
      }),
    ).rejects.toMatchObject({ code: 'VAULT_MOVE_STATE_CONFLICT' });
  });
});

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * #1529 — the two ruled move-capture refusals (#1528, §16 2026-08-28) lift
 * behind the lossless read seams. Every test here proves a loss class the old
 * refusal existed for is now carried instead: served bytes in, identical
 * bytes out, or a typed refusal before any ciphertext write.
 */
describe('lossless capture (#1529)', () => {
  async function decryptDoc<T>(docId: string, docKind: 'portfolio' | 'common'): Promise<T> {
    const stored = harness.docs.get(docId)!;
    const accountBinding = await deriveAccountBinding(ACCOUNT_ID);
    const opened = await decryptVaultDoc({
      envelope: stored.envelope,
      contentKey: CONTENT_KEY,
      expected: { vaultId: VAULT_ID, docId, docKind, accountBinding, keyId: KEY_ID },
    });
    return JSON.parse(new TextDecoder().decode(opened.plaintext)) as T;
  }
  const liveRows = (entities: readonly VaultEntity[] | undefined) =>
    (entities ?? []).filter((entity) => entity.deletedAt === null);

  function withImportHistory(): void {
    const fixture = importFixture();
    harness.state.importBatches = fixture.batches;
    harness.state.importRows = fixture.rows;
    harness.state.settledRevisions = [{ portfolioDataRevision: REVISION, importBatchCount: 1 }];
    harness.state.transactions = [transactionFixture({ source: 'import:generic' })];
  }

  function withManualAsset(): void {
    harness.state.manualAssets.set(MANUAL_ASSET_ID, manualSnapshotFixture());
    harness.state.transactions = [
      ...harness.state.transactions,
      transactionFixture({
        id: MANUAL_TRANSACTION_ID,
        assetId: MANUAL_ASSET_ID,
        asset: MANUAL_ASSET_DTO,
        quantity: 1,
        price: 250000,
        fee: 0,
        executedAt: '2026-07-02T10:00:00.000Z',
      }),
    ];
  }

  it('captures historical import batches and staging rows exactly into the portfolio document (the refusal lifts)', async () => {
    withImportHistory();
    await expect(runMoveIn(harness)).resolves.toEqual({
      docVersion: 1,
      portfolioDataRevision: REVISION,
    });
    expect(harness.writes).toEqual([PORTFOLIO_ID, HEADER_DOC_ID, COMMON_DOC_ID]);

    const canary = utf8(CLEARTEXT_CANARY);
    for (const body of harness.putBodies) expect(containsBytes(body, canary)).toBe(false);

    const document = await decryptDoc<VaultPortfolioDoc>(PORTFOLIO_ID, 'portfolio');
    const served = importFixture();
    expect(liveRows(document.entities.importBatch).map(({ id, data }) => ({ id, data }))).toEqual(
      served.batches,
    );
    expect(liveRows(document.entities.importRow).map(({ id, data }) => ({ id, data }))).toEqual(
      served.rows,
    );
    // The imported transaction rides as an ordinary row now, its provenance intact.
    expect(
      document.entities.transaction!.find(({ id }) => id === TRANSACTION_ID)!.data,
    ).toMatchObject({
      source: 'import:generic',
    });
  });

  it('refuses before any write when a served row would not survive the document contract losslessly', async () => {
    withImportHistory();
    const overCap = harness.state.importRows[1]!;
    overCap.data.candidates = Array.from({ length: 6 }, (_, index) => ({
      id: `018f0000-0000-7000-8000-0000000000d${index}`,
      symbol: `C${index}`,
      name: `Candidate ${index}`,
      currency: 'USD',
      exchange: null,
      type: 'stock' as const,
    }));
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      name: 'PortfolioMoveCaptureError',
      code: 'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
    });
    expect(harness.writes).toEqual([]);
    expect(harness.attestations).toEqual([]);
  });

  it('maps the server’s typed "unservable row" answer to the import-history refusal, cause preserved, before any write (review F2)', async () => {
    withImportHistory();
    harness.api.listPortfolioVaultImportBatches = (async () => {
      throw new ApiError(409, 'PORTFOLIO_VAULT_CAPTURE_UNSERVABLE', 'TEST VECTOR unservable row');
    }) as PortfolioMoveCaptureApi['listPortfolioVaultImportBatches'];
    const rejection = expect(runMoveIn(harness)).rejects;
    await rejection.toMatchObject({
      name: 'PortfolioMoveCaptureError',
      code: 'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
      retryable: false,
    });
    await rejection.toMatchObject({
      cause: { name: 'ApiError', code: 'PORTFOLIO_VAULT_CAPTURE_UNSERVABLE', status: 409 },
    });
    expect(harness.writes).toEqual([]);
  });

  it('maps the snapshot seam’s typed refusals (unservable, too large) to the manual-asset refusal, before any write (review F2)', async () => {
    for (const code of [
      'CUSTOM_ASSET_VAULT_SNAPSHOT_UNSERVABLE',
      'CUSTOM_ASSET_VAULT_SNAPSHOT_TOO_LARGE',
    ]) {
      harness = createHarness();
      await seedVaultDocuments(harness);
      withManualAsset();
      harness.api.getCustomAssetVaultSnapshots = (async () => {
        throw new ApiError(409, code, `TEST VECTOR ${code}`);
      }) as PortfolioMoveCaptureApi['getCustomAssetVaultSnapshots'];
      await expect(runMoveIn(harness)).rejects.toMatchObject({
        name: 'PortfolioMoveCaptureError',
        code: 'VAULT_MOVE_MANUAL_ASSETS_UNSUPPORTED',
        retryable: false,
        cause: { code },
      });
      expect(harness.writes).toEqual([]);
    }
  });

  it('refuses a batch that is not historical yet (pending) as a state conflict, before any write', async () => {
    withImportHistory();
    harness.state.importBatches[0]!.data.status = 'pending';
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      name: 'PortfolioMoveCaptureError',
      code: 'VAULT_MOVE_STATE_CONFLICT',
    });
    expect(harness.writes).toEqual([]);
  });

  it('refuses a served batch set that disagrees with the settled revision count, before any write', async () => {
    withImportHistory();
    harness.state.settledRevisions = [{ portfolioDataRevision: REVISION, importBatchCount: 2 }];
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      name: 'PortfolioMoveCaptureError',
      code: 'VAULT_MOVE_STATE_CONFLICT',
    });
    expect(harness.writes).toEqual([]);
  });

  it('refuses a served batch or row that is not this portfolio’s (cross-portfolio injection), before any write', async () => {
    withImportHistory();
    harness.state.importBatches[0]!.data.portfolioId = '018f0000-0000-7000-8000-0000000000ff';
    await expect(runMoveIn(harness)).rejects.toMatchObject({ code: 'VAULT_MOVE_STATE_CONFLICT' });
    expect(harness.writes).toEqual([]);
  });

  it('captures an owner-manual asset EXACTLY (row + every value point) into the common document (the refusal lifts)', async () => {
    withManualAsset();
    await expect(runMoveIn(harness)).resolves.toEqual({
      docVersion: 1,
      portfolioDataRevision: REVISION,
    });
    const canary = utf8(CLEARTEXT_CANARY);
    for (const body of harness.putBodies) expect(containsBytes(body, canary)).toBe(false);

    const common = await decryptDoc<VaultCommonDoc>(COMMON_DOC_ID, 'common');
    const served = manualSnapshotFixture();
    const asset = liveRows(common.entities.customAsset).find(({ id }) => id === MANUAL_ASSET_ID)!;
    // The exact server row — NOT the rounded DTO's `ownedAssetSnapshotRow` projection.
    expect(asset.data).toEqual(served.asset);
    expect(
      liveRows(common.entities.customAssetValue)
        .filter(({ data }) => data.assetId === MANUAL_ASSET_ID)
        .map(({ data }) => data)
        .sort((left, right) => String(left.date).localeCompare(String(right.date))),
    ).toEqual(served.values);
    // The market asset still folds as the client-only catalog snapshot.
    expect(
      liveRows(common.entities.customAsset).find(({ id }) => id === ASSET_ID)!.data,
    ).toMatchObject({
      ownerId: null,
      providerId: 'yahoo',
    });
  });

  it('reconciles the common document to the exact server state: stale value replaced, missing added, extra tombstoned', async () => {
    withManualAsset();
    const STALE_ID = '018f0000-0000-7000-8000-0000000000e1';
    const EXTRA_ID = '018f0000-0000-7000-8000-0000000000e2';
    const staleEntity = (id: string, date: string, close: string): VaultEntity => ({
      id,
      rev: 3,
      editedAt: '2026-07-20T00:00:00.000Z',
      editedBy: '018f0000-0000-7000-8000-0000000000c0',
      deletedAt: null,
      data: { assetId: MANUAL_ASSET_ID, date, close },
    });
    harness.docs.clear();
    await seedVaultDocuments(harness, {
      commonEntities: {
        customAsset: [
          {
            id: MANUAL_ASSET_ID,
            rev: 2,
            editedAt: '2026-07-20T00:00:00.000Z',
            editedBy: '018f0000-0000-7000-8000-0000000000c0',
            deletedAt: null,
            data: { ...manualSnapshotFixture().asset, name: 'stale name' },
          },
        ],
        customAssetValue: [
          staleEntity(STALE_ID, '2026-07-01', '1'), // same date, stale close
          staleEntity(EXTRA_ID, '2026-06-01', '5'), // no longer on the server
        ],
      },
    });
    await runMoveIn(harness);

    const common = await decryptDoc<VaultCommonDoc>(COMMON_DOC_ID, 'common');
    const asset = common.entities.customAsset!.find(({ id }) => id === MANUAL_ASSET_ID)!;
    expect(asset.rev).toBe(3);
    expect(asset.data).toEqual(manualSnapshotFixture().asset);
    const values = common.entities.customAssetValue!;
    const stale = values.find(({ id }) => id === STALE_ID)!;
    expect(stale).toMatchObject({
      rev: 4,
      deletedAt: null,
      data: { date: '2026-07-01', close: '98765432109876.654321' },
    });
    const extra = values.find(({ id }) => id === EXTRA_ID)!;
    expect(extra.rev).toBe(4);
    expect(extra.deletedAt).not.toBeNull();
    expect(liveRows(values).map(({ data }) => data)).toEqual(
      expect.arrayContaining(manualSnapshotFixture().values),
    );
    expect(liveRows(values)).toHaveLength(2);
  });

  it('refuses before any write when the server does not hold a referenced asset as the owner’s manual asset', async () => {
    withManualAsset();
    harness.state.manualAssets.clear();
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      name: 'PortfolioMoveCaptureError',
      code: 'VAULT_MOVE_MANUAL_ASSETS_UNSUPPORTED',
    });
    expect(harness.writes).toEqual([]);
  });

  it('refuses a snapshot whose identity is not the owner’s manual claim', async () => {
    withManualAsset();
    const forged = manualSnapshotFixture();
    forged.asset.ownerId = '018f0000-0000-7000-8000-0000000000fe';
    harness.state.manualAssets.set(MANUAL_ASSET_ID, forged);
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      code: 'VAULT_MOVE_MANUAL_ASSETS_UNSUPPORTED',
    });
    expect(harness.writes).toEqual([]);
  });

  describe('round trip through move-out', () => {
    it('ROUND TRIP: served import rows and the exact manual snapshot come back out of the strict restore document, and the authoring is byte-deterministic', async () => {
      withImportHistory();
      withManualAsset();
      await runMoveIn(harness);
      vaultThePortfolio(harness);

      // Identical inputs AND identical id/clock sources: any remaining
      // difference would be hidden nondeterminism in the authoring itself
      // (iteration order, a stray Date.now). `deviceId` and fresh entity ids
      // come from the `id` source, so each run gets the same fresh sequence.
      const sequence = () => {
        let next = 0;
        return () => `018f0000-0000-7000-8000-${(++next).toString(16).padStart(12, '0')}`;
      };
      const authoring = () =>
        createPortfolioVaultMoveCapture({
          keys: harness.keys,
          reader: harness.reader,
          store: harness.store,
          api: harness.api,
          now: () => '2026-08-27T10:30:00.000Z',
          id: sequence(),
        }).captureMoveOut({ portfolioId: PORTFOLIO_ID, vault: VAULT });
      const first = await authoring();
      const second = await authoring();
      expect(vaultStrictDocumentV1Schema.parse(first.document)).toEqual(first.document);
      expect(
        Buffer.from(serializePortfolioVaultRestoreDocument(first.document)).equals(
          Buffer.from(serializePortfolioVaultRestoreDocument(second.document)),
        ),
      ).toBe(true);
      expect(first.documentDigest).toBe(second.documentDigest);

      const served = importFixture();
      const entities = first.document.entities;
      expect(
        entities
          .filter((entity) => entity.kind === 'importBatch')
          .map(({ id, data }) => ({ id, data })),
      ).toEqual(served.batches);
      expect(
        entities
          .filter((entity) => entity.kind === 'importRow')
          .map(({ id, data }) => ({ id, data })),
      ).toEqual(served.rows);
      const snapshot = manualSnapshotFixture();
      const assets = entities.filter((entity) => entity.kind === 'customAsset');
      expect(assets.map(({ id }) => id)).toEqual([MANUAL_ASSET_ID]); // the catalog snapshot is dropped by design
      expect(assets[0]!.data).toEqual(snapshot.asset);
      expect(
        entities
          .filter((entity) => entity.kind === 'customAssetValue')
          .map(({ data }) => data)
          .sort((left, right) => String(left.date).localeCompare(String(right.date))),
      ).toEqual(snapshot.values);
      // The imported transaction restores under its own id with its provenance.
      expect(
        entities.find((entity) => entity.kind === 'transaction' && entity.id === TRANSACTION_ID)!
          .data,
      ).toMatchObject({
        source: 'import:generic',
      });
    });

    it('uses the encrypted snapshot for an asset the server no longer holds (detached at move-in)', async () => {
      withManualAsset();
      await runMoveIn(harness);
      vaultThePortfolio(harness);
      harness.state.manualAssets.clear(); // exclusive asset: purged by E4 at move-in

      const draft = await capture(harness).captureMoveOut({
        portfolioId: PORTFOLIO_ID,
        vault: VAULT,
      });
      const asset = draft.document.entities.find(
        (entity) => entity.kind === 'customAsset' && entity.id === MANUAL_ASSET_ID,
      )!;
      expect(asset.data).toEqual(manualSnapshotFixture().asset);
      expect(
        draft.document.entities
          .filter((entity) => entity.kind === 'customAssetValue')
          .map(({ data }) => data)
          .sort((left, right) => String(left.date).localeCompare(String(right.date))),
      ).toEqual(manualSnapshotFixture().values);
    });

    it('refuses move-out for a manual-asset portfolio when the snapshot seam is absent (capability, not deletion)', async () => {
      withManualAsset();
      await runMoveIn(harness);
      vaultThePortfolio(harness);
      harness.api.getCustomAssetVaultSnapshots = undefined;
      await expect(
        capture(harness).captureMoveOut({ portfolioId: PORTFOLIO_ID, vault: VAULT }),
      ).rejects.toMatchObject({ code: 'VAULT_RESTORE_MANUAL_SNAPSHOT_UNAVAILABLE' });
    });
  });
});
