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
  type PerVaultMediaDocAttestation,
  type PerVaultMediaTransitionRequest,
  type PortfolioSummary,
  type VaultCommonDoc,
  type VaultConfig,
  type VaultDocEnvelopeHeader,
  type VaultHeaderDoc,
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
    lifecycleGeneration: number;
  };
}

async function seedVaultDocuments(
  harness: Harness,
  options: { memberPortfolioDoc?: boolean } = {},
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
    entities: {},
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
    lifecycleGeneration: 1,
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
      dividends: [],
    })) as unknown as PortfolioMoveCaptureApi['listDividends'],
    getTaxYearReports: (async () => ({
      years: [],
    })) as unknown as PortfolioMoveCaptureApi['getTaxYearReports'],
    getTaxYearReport: notCalled(
      'getTaxYearReport',
    ) as unknown as PortfolioMoveCaptureApi['getTaxYearReport'],
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

  it('refuses import history before any ciphertext write', async () => {
    harness.state.settledRevisions = [{ portfolioDataRevision: REVISION, importBatchCount: 2 }];
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      name: 'PortfolioMoveCaptureError',
      code: 'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
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

  it('refuses rows imported from a broker (defense in depth under the count gate)', async () => {
    harness.state.transactions = [transactionFixture({ source: 'import:csv' })];
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      code: 'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
    });
    expect(harness.writes).toEqual([]);
  });

  it('refuses owner-manual assets until an exact-snapshot seam exists', async () => {
    harness.state.transactions = [
      transactionFixture({
        asset: { ...MARKET_ASSET, isCustom: true, category: 'other', smoothing: false },
      }),
    ];
    await expect(runMoveIn(harness)).rejects.toMatchObject({
      code: 'VAULT_MOVE_MANUAL_ASSETS_UNSUPPORTED',
    });
    expect(harness.writes).toEqual([]);
  });

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
