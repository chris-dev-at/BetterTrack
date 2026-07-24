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
  VAULT_MAGIC,
  vaultDocumentV1Schema,
  vaultEnvelopeHeaderSchema,
  vaultEtag,
  VaultEnvelopeError,
  vaultMediaSetSchema,
  vaultServerHeaderSchema,
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
              note: null,
              source: 'manual',
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
