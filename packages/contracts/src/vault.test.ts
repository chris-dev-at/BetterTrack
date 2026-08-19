import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decodeVaultEnvelope,
  encodeVaultEnvelope,
  parseVaultEtag,
  privacyModeSchema,
  readVaultServerHeader,
  VAULT_CONTENT_CIPHER,
  VAULT_DOCUMENT_VERSION,
  VAULT_FORMAT_VERSION,
  VAULT_HISTORY_PAGE_MAX,
  VAULT_MAGIC,
  VAULT_VERSION_MAX,
  vaultDocumentV1Schema,
  vaultClientSecuritySchema,
  vaultEnvelopeHeaderSchema,
  vaultEtag,
  VaultEnvelopeError,
  vaultHistoryListQuerySchema,
  vaultHistoryListResponseSchema,
  vaultHistoryMetadataSchema,
  vaultHistoryVersionParamSchema,
  paranoidDisableRequestSchema,
  paranoidMediaStateResponseSchema,
  paranoidMediaTransitionRequestSchema,
  paranoidVaultMediaStateSchema,
  retiredServerPurgeRequestSchema,
  vaultMediaSetSchema,
  vaultRetirementProofPublicKeySchema,
  vaultRetirementProofPrivateKeySchema,
  vaultServerHeaderSchema,
  vaultVersionSchema,
} from './vault';

const UUID_A = '018f0000-0000-7000-8000-00000000000a';
const UUID_B = '018f0000-0000-7000-8000-00000000000b';
const UUID_C = '018f0000-0000-7000-8000-00000000000c';

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
});

describe('durable media transition contracts', () => {
  const serverOnly = { mediaSet: ['server'], driveAttestedVersion: null } as const;
  const both = { mediaSet: ['server', 'drive'], driveAttestedVersion: 4 } as const;

  it('rejects no-op and multi-medium transitions while pinning the required read-back kind', () => {
    expect(
      paranoidMediaTransitionRequestSchema.safeParse({
        expected: serverOnly,
        nextMediaSet: ['server'],
        verification: { kind: 'server', version: 1 },
      }).success,
    ).toBe(false);
    expect(
      paranoidMediaTransitionRequestSchema.safeParse({
        expected: serverOnly,
        nextMediaSet: ['drive'],
        verification: { kind: 'drive', version: 1 },
      }).success,
    ).toBe(false);
    expect(
      paranoidMediaTransitionRequestSchema.safeParse({
        expected: serverOnly,
        nextMediaSet: ['server', 'drive'],
        verification: { kind: 'server', version: 1 },
      }).success,
    ).toBe(false);
    expect(
      paranoidMediaTransitionRequestSchema.safeParse({
        expected: both,
        nextMediaSet: ['drive'],
        verification: { kind: 'drive', version: 4 },
      }).success,
    ).toBe(true);
  });

  it('exposes only physical server disposition metadata, never ciphertext', () => {
    const state = {
      mediaSet: ['drive'],
      driveAttestedVersion: 4,
      server: {
        disposition: 'inactive-candidate',
        candidate: {
          candidateId: UUID_A,
          version: 4,
          formatVersion: 1,
          sizeBytes: 42,
          expiresAt: '2026-07-24T10:10:00.000Z',
        },
        retired: {
          version: 3,
          retiredAt: '2026-07-24T10:00:00.000Z',
          purgeAfter: '2026-07-31T10:00:00.000Z',
        },
      },
    };
    expect(paranoidVaultMediaStateSchema.parse(state)).toEqual(state);
    expect(
      paranoidVaultMediaStateSchema.safeParse({
        ...state,
        server: { ...state.server, ciphertext: 'never exposed' },
      }).success,
    ).toBe(false);
    expect(
      paranoidMediaStateResponseSchema.safeParse({ privacyMode: 'normal', mediaState: state })
        .success,
    ).toBe(false);
  });

  it('keeps retired purge proof inputs strict and bounded', () => {
    expect(
      retiredServerPurgeRequestSchema.safeParse({
        retiredVersion: 4,
        observedVersion: 5,
        challenge: 'x'.repeat(40),
        signature: 'a'.repeat(86),
      }).success,
    ).toBe(true);
    expect(
      retiredServerPurgeRequestSchema.safeParse({
        retiredVersion: 4,
        observedVersion: 5,
        challenge: 'x'.repeat(40),
        signature: 'not base64url!',
      }).success,
    ).toBe(false);
  });

  it('accepts only canonical Ed25519 SPKI retirement verifiers', () => {
    const pair = generateKeyPairSync('ed25519');
    const ed25519 = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const privateKey = pair.privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64url');
    const x25519 = generateKeyPairSync('x25519')
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64url');

    expect(vaultRetirementProofPublicKeySchema.safeParse(ed25519).success).toBe(true);
    expect(vaultRetirementProofPrivateKeySchema.safeParse(privateKey).success).toBe(true);
    expect(
      vaultClientSecuritySchema.safeParse({
        retirementProof: { publicKey: ed25519, privateKey },
      }).success,
    ).toBe(true);
    expect(vaultRetirementProofPublicKeySchema.safeParse(x25519).success).toBe(false);
    expect(vaultRetirementProofPrivateKeySchema.safeParse('a'.repeat(64)).success).toBe(false);
    expect(vaultRetirementProofPublicKeySchema.safeParse('a'.repeat(59)).success).toBe(false);
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
      entities: {
        portfolio: [
          {
            id: UUID_A,
            rev: 0,
            editedAt: '2026-07-24T10:00:00.000Z',
            editedBy: UUID_B,
            deletedAt: null,
            data: { name: 'Main' },
          },
        ],
      },
    });
    expect(doc.mergeLog).toEqual([]);
    expect(doc.entities.portfolio?.[0]?.data.name).toBe('Main');
  });

  it('rejects an unknown entity kind and a wrong schema version', () => {
    expect(vaultDocumentV1Schema.safeParse({ schemaVersion: 2, entities: {} }).success).toBe(false);
    expect(
      vaultDocumentV1Schema.safeParse({ schemaVersion: 1, entities: { bogus: [] } }).success,
    ).toBe(false);
  });
});

describe('paranoid disable request', () => {
  const emptyDocument = { schemaVersion: 1 as const, entities: [], mergeLog: [] };
  const base = { confirm: true as const, rehydrationId: UUID_A, document: emptyDocument };

  it('requires in-request step-up for an ordinary restoring disable', () => {
    expect(paranoidDisableRequestSchema.safeParse(base).success).toBe(false);
    for (const credential of [
      { password: 'hunter2hunter2' },
      { code: '123456' },
      { recoveryCode: 'abcd-efgh' },
    ]) {
      expect(paranoidDisableRequestSchema.safeParse({ ...base, ...credential }).success).toBe(true);
    }
  });

  it('requires the account-deletion rung on the irreversible discard', () => {
    // Neither half may be optional: the flag destroys a vault whose owner
    // cannot decrypt it, so it carries the same gates as `DELETE /account`.
    expect(paranoidDisableRequestSchema.safeParse({ ...base, discard: true }).success).toBe(false);
    expect(
      paranoidDisableRequestSchema.safeParse({ ...base, discard: true, confirmUsername: 'ada' })
        .success,
    ).toBe(false);
    expect(
      paranoidDisableRequestSchema.safeParse({ ...base, discard: true, password: 'hunter2hunter2' })
        .success,
    ).toBe(false);

    for (const credential of [
      { password: 'hunter2hunter2' },
      { code: '123456' },
      { recoveryCode: 'abcd-efgh' },
    ]) {
      expect(
        paranoidDisableRequestSchema.safeParse({
          ...base,
          discard: true,
          confirmUsername: 'ada',
          ...credential,
        }).success,
      ).toBe(true);
    }
  });
});
