import { webcrypto } from 'node:crypto';

import { deflateSync } from 'fflate';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  VAULT_DOC_SCHEMA_VERSION,
  decodeVaultEnvelope,
  encodeVaultEnvelope,
  serializeVaultDocHeader,
  type VaultDocEnvelopeHeader,
  type VaultDocKind,
} from '@bettertrack/contracts';

import { equalBytes, utf8, zeroBytes } from '../bytes';
import { aesGcmEncrypt } from '../crypto';
import { encodeBase64Url } from './base64url';
import { decryptVaultDoc, encryptVaultDoc, openVaultHeaderWithMnemonic } from './documents';
import {
  createVaultKeyMaterial,
  deriveAccountBinding,
  deriveVaultWrapKey,
  openVaultKey,
  selectActiveSeedKeySlot,
  wrapContentKey,
  type VaultContentKeyMaterial,
} from './keyCore';
import {
  rotateVaultDocuments,
  type RotateVaultDocumentsInput,
  type RotatedVaultDocument,
  type VaultRotationCommitPlan,
} from './rotation';

const VAULT_1 = '018f6a3e-1111-7000-8000-000000000001';
const VAULT_2 = '018f6a3e-1111-7000-8000-000000000002';
const KEY_1 = '018f6a3e-3333-7000-8000-000000000001';
const KEY_2 = '018f6a3e-3333-7000-8000-000000000002';
const HEADER_DOC_ID = '018f6a3e-2222-7000-8000-000000000001';
const COMMON_DOC_ID = '018f6a3e-2222-7000-8000-000000000002';
const PORTFOLIO_DOC_ID = '018f6a3e-2222-7000-8000-000000000003';
const PORTFOLIO_ID = '018f6a3e-6666-7000-8000-000000000001';
const DEVICE_ID = '018f6a3e-4444-7000-8000-000000000001';
const WRITE_ID = '018f6a3e-5555-7000-8000-000000000001';
const WRITTEN_AT = '2026-08-20T12:00:00.000Z';
const ACCOUNT_BINDING = 'uInyTdYZ_BcxUihO_Kmd3mZqzL1pf0oTqk_xezqrWX4';
/** TEST VECTOR: canonical Ed25519 SPKI prefix plus 32 public zero bytes. */
const RETIREMENT_PUBLIC_KEY = encodeBase64Url(
  new Uint8Array([
    0x30,
    0x2a,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x03,
    0x21,
    0x00,
    ...new Array<number>(32).fill(0),
  ]),
);
/** TEST VECTOR: canonical Ed25519 PKCS#8 prefix plus 32 private zero bytes. */
const RETIREMENT_PRIVATE_KEY = encodeBase64Url(
  new Uint8Array([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x04,
    0x22,
    0x04,
    0x20,
    ...new Array<number>(32).fill(0),
  ]),
);

/** Public BIP39 TEST VECTOR: 128 zero entropy bits, never production key material. */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** Public BIP39 TEST VECTOR: checksum-valid replacement phrase. */
const NEW_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('seed phrase key derivation and document vectors', () => {
  it('pins K_wrap, random K_c, wrapped slot, fingerprint, and a full envelope', async () => {
    const randomBytes = incrementingRandom(0);
    const wrapKey = await deriveVaultWrapKey(MNEMONIC, VAULT_1);
    const material = await createVaultKeyMaterial({
      mnemonic: MNEMONIC,
      vaultId: VAULT_1,
      keyId: KEY_1,
      randomBytes,
    });
    const encrypted = await createHeaderEnvelope(material, randomBytes);

    // TEST VECTOR: repo-owned E3 derivation chain with injected deterministic CSPRNG bytes.
    const expectedWrapKeyHex = 'd7b530f6785808e62075af39ad66ea65a7bdcfe1748f3f414d94020f3b5b68c6';
    // TEST VECTOR: injected bytes 0x00..0x1f model the otherwise-random K_c.
    const expectedContentKeyHex =
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    // TEST VECTOR: AES-GCM slot payload (IV || ciphertext || tag), base64url-unpadded.
    const expectedWrappedKc =
      'ICEiIyQlJicoKSorbDGcHk22PjwIQXq5rfPlReFkaqQjhKeWqpg-euSE-1bKKmTWvYTDSRd1nfSCRbjQ';
    // TEST VECTOR: first 16 base64url chars of the fingerprint HKDF output.
    const expectedFingerprint = 'SGn1pC05gjstkyjs';
    // TEST VECTOR: complete BTVAULT1 v2 envelope; fixture contains no production secret.
    const expectedEnvelope =
      'QlRWQVVMVDEAAAJ4eyJmb3JtYXRWZXJzaW9uIjoyLCJjaXBoZXIiOiJBMjU2R0NNIiwiaXYiOiJMQzB1THpBeE1qTTBOVFkzIiwia2V5SWQiOiIwMThmNmEzZS0zMzMzLTcwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJrZXlTbG90cyI6W3sia2V5SWQiOiIwMThmNmEzZS0zMzMzLTcwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJzbG90Ijoic2VlZC12MSIsIndyYXBwZWRLYyI6IklDRWlJeVFsSmljb0tTb3JiREdjSGsyMlBqd0lRWHE1cmZQbFJlRmthcVFqaEtlV3FwZy1ldVNFLTFiS0ttVFd2WVREU1JkMW5mU0NSYmpRIn1dLCJ2YXVsdElkIjoiMDE4ZjZhM2UtMTExMS03MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwiZG9jSWQiOiIwMThmNmEzZS0yMjIyLTcwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJkb2NLaW5kIjoiaGVhZGVyIiwiYWNjb3VudEJpbmRpbmciOiJ1SW55VGRZWl9CY3hVaWhPX0ttZDNtWnF6TDFwZjBvVHFrX3hlenFyV1g0IiwiZG9jVmVyc2lvbiI6MSwic2NoZW1hVmVyc2lvbiI6MSwiZGV2aWNlSWQiOiIwMThmNmEzZS00NDQ0LTcwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJ3cml0ZUlkIjoiMDE4ZjZhM2UtNTU1NS03MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwid3JpdHRlbkF0IjoiMjAyNi0wOC0yMFQxMjowMDowMC4wMDBaIn0ncu544dHoiUntB9No7s5VxFFql6zHxg7xZ-etFwOZhCyi-TBhL_DgOEqyWuX6Y1lyS91Y76UcQbelXTn9uvZXNktu_K7arsqrW8wTNatRX9QIfvFdfe2qIF8J_eaOm-vttgWPFdJ2S-D7j7nFBfhP8d81h2KJJosRChtl5kpo5HsFMS-EaV5bAdYMIreQF-RpdEgFgH0DqXhbTWMAPh5OqtYPEe7ZfGdVWKgFhOMTxOoYvjRLQfWkOta2owwtl80WEFZXW5V_jyxtp1WhtD5eCzMUt6Is-aAqXN6ZQiZJy8yqxBmGXQCgKaFcsXeCOzRYE0fSt17R2ZoliNcKosGT3Bz1MNvIhJEhFj-Wy_Vnneg2Lzpc';
    expect(hex(wrapKey)).toBe(expectedWrapKeyHex);
    expect(hex(material.contentKey)).toBe(expectedContentKeyHex);
    expect(material.keySlot.wrappedKc).toBe(expectedWrappedKc);
    expect(material.keyFingerprint).toBe(expectedFingerprint);
    expect(encodeBase64Url(encrypted.envelope)).toBe(expectedEnvelope);

    const opened = await openVaultHeaderWithMnemonic({
      envelope: encrypted.envelope,
      mnemonic: MNEMONIC,
      expectedVaultId: VAULT_1,
      expectedFingerprint: material.keyFingerprint,
    });
    expect(opened.document.name).toBe('TEST VECTOR vault');
    expect(opened.contentKey).toEqual(material.contentKey);
    zeroBytes(opened.plaintext);
    zeroBytes(opened.contentKey);
    zeroBytes(wrapKey);
    zeroBytes(material.contentKey);
  });

  it('domain-separates a reused phrase and independent random content keys by vault', async () => {
    const [wrap1, wrap2] = await Promise.all([
      deriveVaultWrapKey(MNEMONIC, VAULT_1),
      deriveVaultWrapKey(MNEMONIC, VAULT_2),
    ]);
    const first = await createVaultKeyMaterial({
      mnemonic: MNEMONIC,
      vaultId: VAULT_1,
      keyId: KEY_1,
      randomBytes: filledRandom(0x11),
    });
    const second = await createVaultKeyMaterial({
      mnemonic: MNEMONIC,
      vaultId: VAULT_2,
      keyId: KEY_1,
      randomBytes: filledRandom(0x22),
    });
    expect(wrap1).not.toEqual(wrap2);
    expect(first.contentKey).not.toEqual(second.contentKey);
    expect(first.keyFingerprint).not.toBe(second.keyFingerprint);
    await expect(
      openVaultKey({
        mnemonic: MNEMONIC,
        vaultId: VAULT_2,
        keyId: KEY_1,
        keySlots: [first.keySlot],
      }),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
    zeroBytes(wrap1);
    zeroBytes(wrap2);
    zeroBytes(first.contentKey);
    zeroBytes(second.contentKey);
  });

  it('rejects a zeroized content key before key-slot encryption begins', async () => {
    const wrapKey = await deriveVaultWrapKey(MNEMONIC, VAULT_1);
    const randomBytes = vi.fn(filledRandom(0x33));
    try {
      await expect(
        wrapContentKey({
          contentKey: new Uint8Array(32),
          wrapKey,
          vaultId: VAULT_1,
          keyId: KEY_1,
          randomBytes,
        }),
      ).rejects.toMatchObject({
        name: 'VaultKeyCoreError',
        code: 'invalid-key-material',
      });
      expect(randomBytes).not.toHaveBeenCalled();
    } finally {
      zeroBytes(wrapKey);
    }
  });

  it('requires exactly one active seed-v1 slot and checks an expected fingerprint', async () => {
    const material = await createVaultKeyMaterial({
      mnemonic: MNEMONIC,
      vaultId: VAULT_1,
      keyId: KEY_1,
      randomBytes: filledRandom(0x33),
    });
    expect(() => selectActiveSeedKeySlot([], KEY_1)).toThrowError(
      expect.objectContaining({ code: 'slot-invalid' }),
    );
    expect(() => selectActiveSeedKeySlot([material.keySlot, material.keySlot], KEY_1)).toThrowError(
      expect.objectContaining({ code: 'slot-invalid' }),
    );
    await expect(
      openVaultKey({
        mnemonic: MNEMONIC,
        vaultId: VAULT_1,
        keyId: KEY_1,
        keySlots: [material.keySlot],
        expectedFingerprint: 'AAAAAAAAAAAAAAAA',
      }),
    ).rejects.toMatchObject({ code: 'fingerprint-mismatch' });
    zeroBytes(material.contentKey);
  });

  it('authenticates exact noncanonical wire header bytes instead of reserializing', async () => {
    const material = await createVaultKeyMaterial({
      mnemonic: MNEMONIC,
      vaultId: VAULT_1,
      keyId: KEY_1,
      randomBytes: filledRandom(0x44),
    });
    const iv = new Uint8Array(12).fill(0x55);
    const accountBinding = await deriveAccountBinding('vector-account');
    const header = {
      writtenAt: WRITTEN_AT,
      writeId: WRITE_ID,
      deviceId: DEVICE_ID,
      schemaVersion: VAULT_DOC_SCHEMA_VERSION,
      docVersion: 1,
      accountBinding,
      docKind: 'common',
      docId: COMMON_DOC_ID,
      vaultId: VAULT_1,
      keySlots: [material.keySlot],
      keyId: KEY_1,
      iv: encodeBase64Url(iv),
      cipher: 'A256GCM',
      formatVersion: 2,
    } satisfies VaultDocEnvelopeHeader;
    const wireHeaderBytes = utf8(JSON.stringify(header));
    expect(wireHeaderBytes).not.toEqual(serializeVaultDocHeader(header));
    const plaintext = utf8('exact wire AAD TEST VECTOR');
    const compressed = deflateSync(plaintext);
    const ciphertext = await aesGcmEncrypt(material.contentKey, iv, compressed, wireHeaderBytes);
    const envelope = encodeVaultEnvelope(header, ciphertext);
    const decrypted = await decryptVaultDoc({ envelope, contentKey: material.contentKey });
    expect(equalBytes(decrypted.plaintext, plaintext)).toBe(true);
    zeroBytes(decrypted.plaintext);
    zeroBytes(material.contentKey);
    zeroBytes(iv);
    zeroBytes(plaintext);
    zeroBytes(compressed);
    zeroBytes(ciphertext);
    zeroBytes(wireHeaderBytes);
  });

  it('fails closed for every binding header tamper and format rollback', async () => {
    const material = await createVaultKeyMaterial({
      mnemonic: MNEMONIC,
      vaultId: VAULT_1,
      keyId: KEY_1,
      randomBytes: incrementingRandom(7),
    });
    const encrypted = await createHeaderEnvelope(material, incrementingRandom(99));
    const decoded = decodeVaultEnvelope(encrypted.envelope);
    const header = decoded.header as Record<string, unknown>;
    const otherBinding = await deriveAccountBinding('other-account');
    const tampered = [
      ['formatVersion', 1],
      ['vaultId', VAULT_2],
      ['docId', COMMON_DOC_ID],
      ['accountBinding', otherBinding],
      ['docVersion', 2],
      ['keyId', KEY_2],
    ] as const;
    expect.assertions(tampered.length);
    for (const [field, value] of tampered) {
      const envelope = encodeVaultEnvelope({ ...header, [field]: value }, decoded.ciphertext);
      await expect(
        decryptVaultDoc({ envelope, contentKey: material.contentKey }),
      ).rejects.toBeDefined();
    }
    zeroBytes(material.contentKey);
  });

  it('rejects a header payload whose complete key-slot echo differs', async () => {
    const material = await createVaultKeyMaterial({
      mnemonic: MNEMONIC,
      vaultId: VAULT_1,
      keyId: KEY_1,
      randomBytes: filledRandom(0x66),
    });
    const otherSlot = { ...material.keySlot, keyId: KEY_2 };
    const encrypted = await createHeaderEnvelope(material, filledRandom(0x77), [
      material.keySlot,
      otherSlot,
    ]);
    await expect(
      openVaultHeaderWithMnemonic({
        envelope: encrypted.envelope,
        mnemonic: MNEMONIC,
        expectedVaultId: VAULT_1,
      }),
    ).rejects.toMatchObject({ code: 'document-invalid' });
    zeroBytes(material.contentKey);
  });
});

describe('full document-set rotation', () => {
  it('rotates every doc, key id, fingerprint and header echo after exact medium read-backs', async () => {
    const initial = await createInitialDocumentSet();
    let committedPlan: VaultRotationCommitPlan | undefined;
    const result = await rotateVaultDocuments({
      ...rotationInput(initial),
      stage: async (plan) => {
        committedPlan = plan;
        return successfulStage(plan);
      },
    });

    expect(result.mnemonic).toBe(NEW_MNEMONIC);
    expect(result.keyMaterial.keyId).toBe(KEY_2);
    expect(result.keyMaterial.keyFingerprint).not.toBe(initial.material.keyFingerprint);
    expect(committedPlan?.requiredRoundTripTargets).toEqual(['server', 'drive:test']);
    expect(committedPlan?.historyInvalidation).toEqual({
      scope: 'all-prior-versions',
      documents: [
        { docId: HEADER_DOC_ID, throughDocVersion: 1 },
        { docId: COMMON_DOC_ID, throughDocVersion: 1 },
        { docId: PORTFOLIO_DOC_ID, throughDocVersion: 1 },
      ],
    });
    const opened = await openVaultHeaderWithMnemonic({
      envelope: result.documents[0]!.envelope,
      mnemonic: NEW_MNEMONIC,
      expectedVaultId: VAULT_1,
      expectedFingerprint: result.keyMaterial.keyFingerprint,
    });
    expect(opened.document.keySlots).toEqual([result.keyMaterial.keySlot]);
    await expect(
      openVaultHeaderWithMnemonic({
        envelope: result.documents[0]!.envelope,
        mnemonic: MNEMONIC,
        expectedVaultId: VAULT_1,
      }),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
    zeroBytes(opened.plaintext);
    zeroBytes(opened.contentKey);
    zeroBytes(result.keyMaterial.contentKey);
    zeroBytes(initial.material.contentKey);
  });

  it('rejects an omitted authoritative doc, mixed set, and reused key id', async () => {
    const initial = await createInitialDocumentSet();
    const base = rotationInput(initial);
    await expect(
      rotateVaultDocuments({ ...base, documents: base.documents.slice(0, 2) }),
    ).rejects.toMatchObject({ code: 'rotation-failed' });

    const mixed = [...base.documents];
    const decoded = decodeVaultEnvelope(mixed[1]!);
    mixed[1] = encodeVaultEnvelope(
      {
        ...(decoded.header as Record<string, unknown>),
        accountBinding: await deriveAccountBinding('mixed'),
      },
      decoded.ciphertext,
    );
    await expect(rotateVaultDocuments({ ...base, documents: mixed })).rejects.toMatchObject({
      code: 'rotation-failed',
    });
    await expect(rotateVaultDocuments({ ...base, newKeyId: KEY_1 })).rejects.toMatchObject({
      code: 'rotation-failed',
    });
    zeroBytes(initial.material.contentKey);
  });

  it('rejects an invalid common payload before staging candidates', async () => {
    const initial = await createInitialDocumentSet(false);
    let staged = false;
    await expect(
      rotateVaultDocuments({
        ...rotationInput(initial),
        stage: async (plan) => {
          staged = true;
          return successfulStage(plan);
        },
      }),
    ).rejects.toMatchObject({ code: 'rotation-failed' });
    expect(staged).toBe(false);
    zeroBytes(initial.material.contentKey);
  });

  it('rejects missing or tampered read-backs and an unconfirmed history purge', async () => {
    const first = await createInitialDocumentSet();
    let finalizedMissingReadBack = false;
    await expect(
      rotateVaultDocuments({
        ...rotationInput(first),
        stage: async (plan) => ({
          stageId: 'missing-drive-readback',
          roundTrips: [{ target: 'server', documents: readBack(plan.documents) }],
        }),
        finalize: async () => {
          finalizedMissingReadBack = true;
          return { historyInvalidated: true };
        },
      }),
    ).rejects.toMatchObject({ code: 'rotation-failed' });
    expect(finalizedMissingReadBack).toBe(false);
    zeroBytes(first.material.contentKey);

    const second = await createInitialDocumentSet();
    let finalizedTamperedReadBack = false;
    await expect(
      rotateVaultDocuments({
        ...rotationInput(second),
        stage: async (plan) => {
          const committed = successfulStage(plan);
          const envelope = committed.roundTrips[0]!.documents[0]!.envelope.slice();
          envelope[envelope.length - 1] = envelope[envelope.length - 1]! ^ 1;
          return {
            ...committed,
            roundTrips: [
              {
                ...committed.roundTrips[0]!,
                documents: [
                  { ...committed.roundTrips[0]!.documents[0]!, envelope },
                  ...committed.roundTrips[0]!.documents.slice(1),
                ],
              },
              committed.roundTrips[1]!,
            ],
          };
        },
        finalize: async () => {
          finalizedTamperedReadBack = true;
          return { historyInvalidated: true };
        },
      }),
    ).rejects.toMatchObject({ code: 'rotation-failed' });
    expect(finalizedTamperedReadBack).toBe(false);
    zeroBytes(second.material.contentKey);

    const third = await createInitialDocumentSet();
    await expect(
      rotateVaultDocuments({
        ...rotationInput(third),
        finalize: async () => ({ historyInvalidated: false }) as never,
      }),
    ).rejects.toMatchObject({ code: 'rotation-failed' });
    zeroBytes(third.material.contentKey);
  });

  it('zeros the generated replacement K_c when candidate staging fails', async () => {
    const initial = await createInitialDocumentSet();
    const generated: Uint8Array[] = [];
    const randomBytes = (length: number) => {
      const bytes = new Uint8Array(length).fill(generated.length + 1);
      generated.push(bytes);
      return bytes;
    };
    await expect(
      rotateVaultDocuments({
        ...rotationInput(initial),
        randomBytes,
        stage: async () => {
          throw new Error('medium failed');
        },
      }),
    ).rejects.toMatchObject({ code: 'rotation-failed' });
    expect(generated.find((bytes) => bytes.length === 32)).toEqual(new Uint8Array(32));
    zeroBytes(initial.material.contentKey);
  });
});

async function createHeaderEnvelope(
  material: VaultContentKeyMaterial,
  randomBytes: (length: number) => Uint8Array,
  payloadKeySlots = [material.keySlot],
): Promise<{ envelope: Uint8Array; header: VaultDocEnvelopeHeader }> {
  const document = {
    schemaVersion: VAULT_DOC_SCHEMA_VERSION,
    name: 'TEST VECTOR vault',
    portfolios: [],
    keySlots: payloadKeySlots,
    driveConnection: null,
    created: { at: WRITTEN_AT, deviceId: DEVICE_ID },
  };
  return encryptVaultDoc({
    plaintext: utf8(JSON.stringify(document)),
    contentKey: material.contentKey,
    header: baseHeader(material, HEADER_DOC_ID, 'header'),
    randomBytes,
  });
}

interface InitialDocumentSet {
  material: VaultContentKeyMaterial;
  documents: readonly RotatedVaultDocument[];
}

async function createInitialDocumentSet(validCommon = true): Promise<InitialDocumentSet> {
  const randomBytes = incrementingRandom(9);
  const material = await createVaultKeyMaterial({
    mnemonic: MNEMONIC,
    vaultId: VAULT_1,
    keyId: KEY_1,
    randomBytes,
  });
  const payloads = [
    utf8(
      JSON.stringify({
        schemaVersion: VAULT_DOC_SCHEMA_VERSION,
        name: 'Rotation vault',
        portfolios: [{ id: PORTFOLIO_ID, name: 'Portfolio' }],
        keySlots: [material.keySlot],
        driveConnection: null,
        created: { at: WRITTEN_AT, deviceId: DEVICE_ID },
      }),
    ),
    utf8(
      JSON.stringify(
        validCommon
          ? {
              schemaVersion: VAULT_DOC_SCHEMA_VERSION,
              entities: {},
              clientSecurity: {
                retirementProof: {
                  publicKey: RETIREMENT_PUBLIC_KEY,
                  privateKey: RETIREMENT_PRIVATE_KEY,
                },
              },
            }
          : {
              schemaVersion: VAULT_DOC_SCHEMA_VERSION,
              entities: {},
              missing: 'clientSecurity',
            },
      ),
    ),
    utf8(
      JSON.stringify({
        schemaVersion: VAULT_DOC_SCHEMA_VERSION,
        portfolioId: PORTFOLIO_ID,
        entities: {},
      }),
    ),
  ];
  const specs = [
    [HEADER_DOC_ID, 'header'],
    [COMMON_DOC_ID, 'common'],
    [PORTFOLIO_DOC_ID, 'portfolio'],
  ] as const;
  const documents: RotatedVaultDocument[] = [];
  for (const [index, [docId, docKind]] of specs.entries()) {
    const encrypted = await encryptVaultDoc({
      plaintext: payloads[index]!,
      contentKey: material.contentKey,
      header: baseHeader(material, docId, docKind),
      randomBytes,
    });
    documents.push({
      docId,
      previousDocVersion: 0,
      header: encrypted.header,
      envelope: encrypted.envelope,
    });
    zeroBytes(payloads[index]!);
  }
  return { material, documents };
}

function rotationInput(initial: InitialDocumentSet): RotateVaultDocumentsInput {
  return {
    vaultId: VAULT_1,
    currentMnemonic: MNEMONIC,
    currentFingerprint: initial.material.keyFingerprint,
    newMnemonic: NEW_MNEMONIC,
    newKeyId: KEY_2,
    documents: initial.documents.map(({ envelope }) => envelope),
    expectedDocuments: initial.documents.map(({ header }) => ({
      docId: header.docId,
      docKind: header.docKind,
      docVersion: header.docVersion,
    })),
    requiredRoundTripTargets: ['server', 'drive:test'],
    metadataFor: (header, index) => ({
      docVersion: header.docVersion + 1,
      deviceId: DEVICE_ID,
      writeId: withUuidSuffix(WRITE_ID, index + 2),
      writtenAt: '2026-08-20T13:00:00.000Z',
    }),
    stage: async (plan) => successfulStage(plan),
    finalize: async () => ({ historyInvalidated: true }),
    randomBytes: incrementingRandom(129),
  };
}

function successfulStage(plan: VaultRotationCommitPlan) {
  return {
    stageId: 'rotation-stage-test-vector',
    roundTrips: plan.requiredRoundTripTargets.map((target) => ({
      target,
      documents: readBack(plan.documents),
    })),
  };
}

function readBack(documents: readonly RotatedVaultDocument[]) {
  return documents.map(({ docId, envelope }) => ({ docId, envelope: envelope.slice() }));
}

function baseHeader(material: VaultContentKeyMaterial, docId: string, docKind: VaultDocKind) {
  return {
    keyId: material.keyId,
    keySlots: [material.keySlot],
    vaultId: material.vaultId,
    docId,
    docKind,
    accountBinding: ACCOUNT_BINDING,
    docVersion: 1,
    schemaVersion: VAULT_DOC_SCHEMA_VERSION,
    deviceId: DEVICE_ID,
    writeId: WRITE_ID,
    writtenAt: WRITTEN_AT,
  };
}

function incrementingRandom(start: number): (length: number) => Uint8Array {
  let next = start;
  return (length) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = next++ & 0xff;
    return bytes;
  };
}

function filledRandom(value: number): (length: number) => Uint8Array {
  return (length) => new Uint8Array(length).fill(value);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function withUuidSuffix(uuid: string, suffix: number): string {
  return `${uuid.slice(0, -1)}${suffix.toString(16)}`;
}
