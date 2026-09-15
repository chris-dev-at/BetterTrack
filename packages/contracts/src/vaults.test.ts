import { describe, expect, it } from 'vitest';

import {
  VAULT_ACCOUNT_BINDING_INFO_PREFIX,
  VAULT_COMMON_DOC_ENTITY_KINDS,
  VAULT_DOC_FORMAT_VERSION,
  VAULT_DOC_SCHEMA_VERSION,
  VAULT_ENTITY_DOC_BUCKETS,
  VAULT_ENTITY_KINDS,
  VAULT_PORTFOLIO_DOC_ENTITY_KINDS,
  PORTFOLIO_VAULT_TRANSITION_ERROR_CODES,
  VaultEnvelopeError,
  createVaultRequestSchema,
  encodeVaultDocEnvelope,
  encodeVaultEnvelope,
  inspectVaultDocEnvelope,
  perVaultMediaTransitionRequestSchema,
  perVaultRetiredServerPurgeChallengeRequestSchema,
  perVaultRetiredServerPurgeRequestSchema,
  perVaultRetiredServerPurgeResponseSchema,
  perVaultServerCandidateReadParamsSchema,
  perVaultServerCandidateStageParamsSchema,
  portfolioVaultMoveOutChallengeRequestSchema,
  portfolioVaultMoveOutChallengeResponseSchema,
  portfolioVaultMoveInRequestSchema,
  portfolioVaultMoveInResponseSchema,
  portfolioVaultMoveOutRequestSchema,
  portfolioVaultMoveOutResponseSchema,
  readVaultDocServerHeader,
  serializeVaultDocHeader,
  serializePerVaultRetiredServerPurgeTranscript,
  serializePortfolioVaultMoveOutProofTranscript,
  serializePortfolioVaultRestoreDocument,
  serializeVaultRetirementVersionSet,
  vaultCommonDocSchema,
  vaultDocEnvelopeHeaderSchema,
  vaultHeaderDocSchema,
  vaultKeyFingerprintSchema,
  vaultMediaListSchema,
  vaultMediaSchema,
  vaultPortfolioDocSchema,
  vaultStepUpCredentialSchema,
  vaultVersionSetHashSchema,
  type VaultDocEnvelopeHeader,
} from './index';

/**
 * PARANOID VAULTS envelope v2 + contract vectors (epic E0 #1410,
 * `docs/paranoid-design.md` §5). The crypto tests here are REAL: the payload is
 * AES-256-GCM-encrypted with the serialized header bound as additional
 * authenticated data, exactly as the client will do it (E3) — so the §8
 * anti-swap guarantee (a doc copied between vaults, accounts or Drive folders
 * fails decryption) is proven at the format level, not assumed.
 */

const subtle = globalThis.crypto.subtle;

const ACCOUNT_ID = '018f6a3e-0000-7000-8000-00000000aaaa';
const OTHER_ACCOUNT_ID = '018f6a3e-0000-7000-8000-00000000bbbb';
const VAULT_ID = '018f6a3e-1111-7000-8000-000000000001';
const OTHER_VAULT_ID = '018f6a3e-1111-7000-8000-000000000002';
const DOC_ID = '018f6a3e-2222-7000-8000-000000000001';
const OTHER_DOC_ID = '018f6a3e-2222-7000-8000-000000000002';
const KEY_ID = '018f6a3e-3333-7000-8000-000000000001';
const DEVICE_ID = '018f6a3e-4444-7000-8000-000000000001';
const WRITE_ID = '018f6a3e-5555-7000-8000-000000000001';
const TRANSITION_ID = '018f6a3e-6666-7000-8000-000000000001';

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // Node's Buffer is available in vitest, but stay engine-neutral like the codec.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function accountBinding(accountId: string): Promise<string> {
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(VAULT_ACCOUNT_BINDING_INFO_PREFIX + accountId),
  );
  return base64url(new Uint8Array(digest));
}

async function makeHeader(): Promise<VaultDocEnvelopeHeader> {
  return {
    formatVersion: VAULT_DOC_FORMAT_VERSION,
    cipher: 'A256GCM',
    iv: base64url(globalThis.crypto.getRandomValues(new Uint8Array(12))),
    keyId: KEY_ID,
    keySlots: [{ keyId: KEY_ID, slot: 'seed-v1', wrappedKc: base64url(new Uint8Array(48)) }],
    vaultId: VAULT_ID,
    docId: DOC_ID,
    docKind: 'portfolio',
    accountBinding: await accountBinding(ACCOUNT_ID),
    docVersion: 7,
    schemaVersion: VAULT_DOC_SCHEMA_VERSION,
    deviceId: DEVICE_ID,
    writeId: WRITE_ID,
    writtenAt: '2026-08-20T12:00:00.000Z',
  };
}

interface Sealed {
  header: VaultDocEnvelopeHeader;
  envelope: Uint8Array;
  key: CryptoKey;
  iv: Uint8Array;
  plaintext: Uint8Array;
}

/** Encrypt → encode, with the exact serialized header bytes as the GCM AAD. */
async function seal(): Promise<Sealed> {
  const header = await makeHeader();
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const headerWithIv = { ...header, iv: base64url(iv) };
  const headerBytes = new TextEncoder().encode(JSON.stringify(headerWithIv));
  const plaintext = new TextEncoder().encode('{"schemaVersion":1,"entities":{}}');
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: headerBytes }, key, plaintext),
  );
  return {
    header: headerWithIv,
    envelope: encodeVaultDocEnvelope(headerWithIv, ciphertext),
    key,
    iv,
    plaintext,
  };
}

async function decryptWithAad(
  sealed: Pick<Sealed, 'key' | 'iv'>,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.iv, additionalData: aad },
      sealed.key,
      ciphertext,
    ),
  );
}

/** Byte-exact JSON text surgery on the wire header, re-framed as an envelope. */
function mutateHeaderText(envelope: Uint8Array, from: string, to: string): Uint8Array {
  const inspected = inspectVaultDocEnvelope(envelope);
  if (inspected.status !== 'supported') throw new Error('fixture must be supported');
  const text = new TextDecoder().decode(inspected.headerBytes);
  if (!text.includes(from)) throw new Error(`fixture header does not contain ${from}`);
  const mutated = new TextEncoder().encode(text.replace(from, to));
  // Re-frame with the generic v1 codec (magic + length + header + ciphertext).
  return encodeVaultEnvelope(JSON.parse(new TextDecoder().decode(mutated)), inspected.ciphertext);
}

describe('envelope v2 — round trip and the AAD anti-swap guarantee (§5, §8)', () => {
  it('encrypt → encode → inspect → decrypt round-trips', async () => {
    const sealed = await seal();
    const inspected = inspectVaultDocEnvelope(sealed.envelope);
    expect(inspected.status).toBe('supported');
    if (inspected.status !== 'supported') return;
    expect(inspected.header).toEqual(sealed.header);
    // Decrypt authenticates the EXACT wire header bytes as AAD.
    const plaintext = await decryptWithAad(sealed, inspected.ciphertext, inspected.headerBytes);
    expect(new TextDecoder().decode(plaintext)).toBe('{"schemaVersion":1,"entities":{}}');
  });

  /**
   * The four §8 anti-swap fields, one test each: mutating the serialized
   * header makes DECRYPTION fail closed — even when the mutated header still
   * parses as a perfectly valid v2 header (a swapped-but-well-formed id), the
   * GCM tag refuses it before any payload byte is interpreted.
   */
  const SWAPS: readonly { name: string; from: string; to: string }[] = [
    { name: 'formatVersion rollback 2→1', from: '"formatVersion":2', to: '"formatVersion":1' },
    { name: 'swapped vaultId', from: VAULT_ID, to: OTHER_VAULT_ID },
    { name: 'swapped docId', from: DOC_ID, to: OTHER_DOC_ID },
  ];

  for (const swap of SWAPS) {
    it(`fails closed on a ${swap.name}`, async () => {
      const sealed = await seal();
      const mutated = mutateHeaderText(sealed.envelope, swap.from, swap.to);
      // Extract the mutated wire bytes with the raw framing reader: a swapped
      // id still parses as a perfectly valid v2 header and a rolled-back
      // formatVersion no longer satisfies the v2 literal — either way the
      // CRYPTO must refuse, independent of any schema validation.
      const { headerBytes, ciphertext } = decodeGeneric(mutated);
      await expect(decryptWithAad(sealed, ciphertext, headerBytes)).rejects.toThrow();
    });
  }

  it('fails closed on a swapped accountBinding', async () => {
    const sealed = await seal();
    const mutated = mutateHeaderText(
      sealed.envelope,
      await accountBinding(ACCOUNT_ID),
      await accountBinding(OTHER_ACCOUNT_ID),
    );
    const { headerBytes, ciphertext } = decodeGeneric(mutated);
    await expect(decryptWithAad(sealed, ciphertext, headerBytes)).rejects.toThrow();
  });

  /**
   * Canonicalization pin (review round 1 on #1424): the writer serializes the
   * SCHEMA-parsed header, so two writers handing the codec the same fields in
   * ANY key order must emit byte-identical wire headers — otherwise the exact
   * same logical header could carry two different AADs and a re-encode by a
   * cooperating device would fail decryption. This property currently rides
   * zod's parse-time key ordering; this test exists to break loudly if a zod
   * upgrade ever changes it.
   */
  it('serializes a fully key-shuffled header to byte-identical canonical AAD bytes', async () => {
    const header = await makeHeader();
    const canonical = serializeVaultDocHeader(header);
    const reverseKeys = <T extends Record<string, unknown>>(value: T): T =>
      Object.fromEntries(Object.entries(value).reverse()) as T;
    const shuffled = reverseKeys({
      ...header,
      keySlots: header.keySlots.map((slot) => reverseKeys(slot)),
    }) as VaultDocEnvelopeHeader;
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(header));

    expect(Array.from(serializeVaultDocHeader(shuffled))).toEqual(Array.from(canonical));
    const envelope = encodeVaultDocEnvelope(shuffled, new Uint8Array(16));
    const inspected = inspectVaultDocEnvelope(envelope);
    expect(inspected.status).toBe('supported');
    if (inspected.status !== 'supported') return;
    expect(Array.from(inspected.headerBytes)).toEqual(Array.from(canonical));
  });

  it('fails closed on any single-byte header mutation', async () => {
    const sealed = await seal();
    const inspected = inspectVaultDocEnvelope(sealed.envelope);
    if (inspected.status !== 'supported') throw new Error('fixture must be supported');
    const mutatedAad = inspected.headerBytes.slice();
    // Flip one bit somewhere in the middle of the serialized header.
    mutatedAad[Math.floor(mutatedAad.length / 2)]! ^= 0x01;
    await expect(decryptWithAad(sealed, inspected.ciphertext, mutatedAad)).rejects.toThrow();
    // Control: the untouched AAD still decrypts.
    await expect(
      decryptWithAad(sealed, inspected.ciphertext, inspected.headerBytes),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});

/** Generic framing read (magic + length + JSON + ciphertext), no validation. */
function decodeGeneric(envelope: Uint8Array): { headerBytes: Uint8Array; ciphertext: Uint8Array } {
  const magicLength = 'BTVAULT1'.length;
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const headerLength = view.getUint32(magicLength, false);
  const headerStart = magicLength + 4;
  return {
    headerBytes: envelope.subarray(headerStart, headerStart + headerLength),
    ciphertext: envelope.subarray(headerStart + headerLength),
  };
}

describe('envelope v2 — strict fail-closed versioning (§5)', () => {
  it('refuses a formatVersion 3 envelope with update-required, never parsed', async () => {
    const future = {
      formatVersion: 3,
      totallyUnknownField: { nested: true },
      schemaVersion: 9,
    };
    const envelope = encodeVaultEnvelope(future, new Uint8Array([1, 2, 3, 4]));
    const inspected = inspectVaultDocEnvelope(envelope);
    expect(inspected).toEqual({ status: 'update-required', formatVersion: 3, schemaVersion: 9 });
  });

  it('refuses a v2 envelope carrying a newer payload schemaVersion', async () => {
    const header = { ...(await makeHeader()), schemaVersion: VAULT_DOC_SCHEMA_VERSION + 1 };
    const envelope = encodeVaultEnvelope(header, new Uint8Array([1, 2, 3, 4]));
    const inspected = inspectVaultDocEnvelope(envelope);
    expect(inspected.status).toBe('update-required');
  });

  it('rejects a v1 ACCOUNT-vault envelope instead of downgrading it', () => {
    const v1Header = {
      formatVersion: 1,
      cipher: 'A256GCM',
      iv: 'aXY',
      keyId: KEY_ID,
      wrappedKeys: [],
      vaultVersion: 1,
      schemaVersion: 1,
      deviceId: DEVICE_ID,
      writeId: WRITE_ID,
      writtenAt: '2026-08-20T12:00:00.000Z',
    };
    const envelope = encodeVaultEnvelope(v1Header, new Uint8Array(16));
    expect(() => inspectVaultDocEnvelope(envelope)).toThrow(VaultEnvelopeError);
  });

  it('rejects an unknown extra header field (strict, fail closed)', async () => {
    const header = { ...(await makeHeader()), sneaky: 1 };
    const envelope = encodeVaultEnvelope(header, new Uint8Array(16));
    expect(() => inspectVaultDocEnvelope(envelope)).toThrow(VaultEnvelopeError);
  });

  it('server header read yields exactly the R2 six-field projection, even for future formats', async () => {
    const sealed = await seal();
    expect(readVaultDocServerHeader(sealed.envelope)).toEqual({
      formatVersion: 2,
      docVersion: 7,
      vaultId: VAULT_ID,
      docId: DOC_ID,
      docKind: 'portfolio',
      writeId: WRITE_ID,
    });
    // The blind store must keep accepting newer formats verbatim (§5 makes
    // versioning a CLIENT decision) — only the six R2 addressing fields are read.
    const future = encodeVaultEnvelope(
      {
        formatVersion: 99,
        docVersion: 3,
        vaultId: OTHER_VAULT_ID,
        docId: OTHER_DOC_ID,
        docKind: 'common',
        writeId: WRITE_ID,
        mystery: true,
      },
      new Uint8Array(16),
    );
    expect(readVaultDocServerHeader(future)).toEqual({
      formatVersion: 99,
      docVersion: 3,
      vaultId: OTHER_VAULT_ID,
      docId: OTHER_DOC_ID,
      docKind: 'common',
      writeId: WRITE_ID,
    });
  });

  it('server header read refuses when any R2 addressing field is absent', () => {
    const incomplete = encodeVaultEnvelope(
      {
        formatVersion: 2,
        docVersion: 1,
        vaultId: VAULT_ID,
        docId: DOC_ID,
        docKind: 'header',
        // writeId deliberately absent.
      },
      new Uint8Array(16),
    );
    expect(() => readVaultDocServerHeader(incomplete)).toThrow(VaultEnvelopeError);
  });
});

describe('media enum — the reserved `local` value (§22, acceptance d)', () => {
  it('the CONTRACT accepts local; rejection is a server boundary decision', () => {
    expect(vaultMediaSchema.parse('local')).toBe('local');
    expect(vaultMediaListSchema.parse(['local'])).toEqual(['local']);
    expect(
      createVaultRequestSchema.safeParse({
        name: 'Future phone vault',
        headerDocId: DOC_ID,
        commonDocId: OTHER_DOC_ID,
        media: ['local'],
        keyFingerprint: 'A'.repeat(16),
        retirementProofPublicKey: RETIREMENT_PUBLIC_KEY,
      }).success,
    ).toBe(true);
  });

  it('rejects an empty or duplicated media list', () => {
    expect(vaultMediaListSchema.safeParse([]).success).toBe(false);
    expect(vaultMediaListSchema.safeParse(['server', 'server']).success).toBe(false);
    expect(vaultMediaListSchema.safeParse(['tape']).success).toBe(false);
  });

  it('requires the Drive binding iff the drive medium is selected', () => {
    const base = {
      name: 'Drive vault',
      headerDocId: DOC_ID,
      commonDocId: OTHER_DOC_ID,
      keyFingerprint: 'A'.repeat(16),
      retirementProofPublicKey: RETIREMENT_PUBLIC_KEY,
    };
    expect(createVaultRequestSchema.safeParse({ ...base, media: ['drive'] }).success).toBe(false);
    expect(
      createVaultRequestSchema.safeParse({
        ...base,
        media: ['drive'],
        driveConnectionId: VAULT_ID,
      }).success,
    ).toBe(true);
    expect(
      createVaultRequestSchema.safeParse({
        ...base,
        media: ['server'],
        driveConnectionId: VAULT_ID,
      }).success,
    ).toBe(false);
  });

  it('requires distinct config-registered header/common document ids (R1)', () => {
    const base = {
      name: 'Registered docs',
      media: ['server'],
      keyFingerprint: 'A'.repeat(16),
      retirementProofPublicKey: RETIREMENT_PUBLIC_KEY,
    };
    expect(
      createVaultRequestSchema.safeParse({
        ...base,
        headerDocId: DOC_ID,
        commonDocId: OTHER_DOC_ID,
      }).success,
    ).toBe(true);
    expect(
      createVaultRequestSchema.safeParse({
        ...base,
        headerDocId: DOC_ID,
        commonDocId: DOC_ID,
      }).success,
    ).toBe(false);
    expect(createVaultRequestSchema.safeParse(base).success).toBe(false);
  });
});

/** A real 44-byte DER SPKI Ed25519 public key (canonical prefix + 32 zero bytes). */
const RETIREMENT_PUBLIC_KEY = base64url(
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

describe('key fingerprint (§4)', () => {
  it('accepts exactly 16 base64url chars and nothing else', () => {
    expect(vaultKeyFingerprintSchema.safeParse('abcDEF123456-_Zz').success).toBe(true);
    expect(vaultKeyFingerprintSchema.safeParse('abcDEF123456-_Z').success).toBe(false);
    expect(vaultKeyFingerprintSchema.safeParse('abcDEF123456-_Zzq').success).toBe(false);
    expect(vaultKeyFingerprintSchema.safeParse('abcDEF123456+/Zz').success).toBe(false);
  });
});

describe('doc buckets (§5) — exhaustive and disjoint', () => {
  it('assigns every entity kind exactly one bucket', () => {
    expect(Object.keys(VAULT_ENTITY_DOC_BUCKETS).sort()).toEqual([...VAULT_ENTITY_KINDS].sort());
    const union = [...VAULT_PORTFOLIO_DOC_ENTITY_KINDS, ...VAULT_COMMON_DOC_ENTITY_KINDS].sort();
    expect(union).toEqual([...VAULT_ENTITY_KINDS].sort());
    expect(
      VAULT_PORTFOLIO_DOC_ENTITY_KINDS.filter((kind) =>
        VAULT_COMMON_DOC_ENTITY_KINDS.includes(kind),
      ),
    ).toEqual([]);
  });

  it('pins the mechanical scoping rule on the telling cases', () => {
    expect(VAULT_ENTITY_DOC_BUCKETS.transaction).toBe('portfolio');
    expect(VAULT_ENTITY_DOC_BUCKETS.standingOrderRun).toBe('portfolio');
    expect(VAULT_ENTITY_DOC_BUCKETS.cashBudget).toBe('portfolio');
    // Account-scoped rows ride the common doc — including the V5-P9 expense
    // area, which is user-keyed in the live schema (see the record's note).
    expect(VAULT_ENTITY_DOC_BUCKETS.taxSetting).toBe('common');
    expect(VAULT_ENTITY_DOC_BUCKETS.customAsset).toBe('common');
    expect(VAULT_ENTITY_DOC_BUCKETS.expenseTransaction).toBe('common');
    expect(VAULT_ENTITY_DOC_BUCKETS.cashTag).toBe('common');
  });
});

describe('doc-set payloads (§5)', () => {
  it('header doc: roster + keySlots echo + creation record', () => {
    const parsed = vaultHeaderDocSchema.parse({
      schemaVersion: 1,
      name: 'Family vault',
      portfolios: [{ id: VAULT_ID, name: 'Main' }],
      keySlots: [{ keyId: KEY_ID, slot: 'seed-v1', wrappedKc: 'd2s' }],
      driveConnection: null,
      created: { at: '2026-08-20T12:00:00.000Z', deviceId: DEVICE_ID },
    });
    expect(parsed.portfolios).toHaveLength(1);
    expect(
      vaultHeaderDocSchema.safeParse({
        schemaVersion: 1,
        name: 'x',
        portfolios: [],
        keySlots: [],
        driveConnection: null,
        created: { at: '2026-08-20T12:00:00.000Z', deviceId: DEVICE_ID },
      }).success,
    ).toBe(false);
  });

  it('common doc requires clientSecurity and refuses portfolio-bucket kinds', () => {
    const base = {
      schemaVersion: 1,
      entities: {},
      clientSecurity: {
        retirementProof: {
          publicKey: RETIREMENT_PUBLIC_KEY,
          privateKey: PKCS8_PRIVATE_KEY,
        },
      },
    };
    expect(vaultCommonDocSchema.safeParse(base).success).toBe(true);
    expect(vaultCommonDocSchema.safeParse({ schemaVersion: 1, entities: {} }).success).toBe(false);
    expect(
      vaultCommonDocSchema.safeParse({
        ...base,
        entities: { transaction: [] },
      }).success,
    ).toBe(false);
  });

  it('portfolio doc refuses common-bucket kinds', () => {
    const base = { schemaVersion: 1, portfolioId: VAULT_ID, entities: {} };
    expect(vaultPortfolioDocSchema.safeParse(base).success).toBe(true);
    expect(
      vaultPortfolioDocSchema.safeParse({ ...base, entities: { customAsset: [] } }).success,
    ).toBe(false);
    expect(
      vaultPortfolioDocSchema.safeParse({ ...base, entities: { transaction: [] } }).success,
    ).toBe(true);
  });
});

/** A real 48-byte DER PKCS#8 Ed25519 private key (canonical prefix + 32 zero bytes). */
const PKCS8_PRIVATE_KEY = base64url(
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

describe('per-vault media transition batches (R3)', () => {
  const expectedDrive = {
    media: ['drive'] as const,
    driveConnectionId: VAULT_ID,
    mediaAttestedAt: '2026-08-20T12:00:00.000Z',
  };
  const nextBoth = {
    media: ['drive', 'server'] as const,
    driveConnectionId: VAULT_ID,
  };
  const readbacks = [
    { candidateId: KEY_ID, docId: DOC_ID, readback: 'r'.repeat(32) },
    { candidateId: DEVICE_ID, docId: OTHER_DOC_ID, readback: 's'.repeat(32) },
  ];

  it('accepts one transition-scoped readback per distinct staged doc', () => {
    expect(
      perVaultMediaTransitionRequestSchema.safeParse({
        transitionId: TRANSITION_ID,
        expected: expectedDrive,
        next: nextBoth,
        verification: { kind: 'server-candidates', readbacks },
      }).success,
    ).toBe(true);
    expect(
      perVaultServerCandidateStageParamsSchema.parse({
        vaultId: VAULT_ID,
        transitionId: TRANSITION_ID,
        docId: DOC_ID,
      }),
    ).toEqual({ vaultId: VAULT_ID, transitionId: TRANSITION_ID, docId: DOC_ID });
    expect(
      perVaultServerCandidateStageParamsSchema.safeParse({
        vaultId: VAULT_ID,
        transitionId: '018f6a3e-6666-4000-8000-000000000001',
        docId: DOC_ID,
      }).success,
    ).toBe(false);
    expect(
      perVaultServerCandidateReadParamsSchema.parse({ vaultId: VAULT_ID, candidateId: KEY_ID }),
    ).toEqual({ vaultId: VAULT_ID, candidateId: KEY_ID });
  });

  it('rejects duplicate doc attestations and the wrong verification kind', () => {
    expect(
      perVaultMediaTransitionRequestSchema.safeParse({
        transitionId: TRANSITION_ID,
        expected: expectedDrive,
        next: nextBoth,
        verification: {
          kind: 'server-candidates',
          readbacks: [readbacks[0], { ...readbacks[1], docId: DOC_ID }],
        },
      }).success,
    ).toBe(false);
    expect(
      perVaultMediaTransitionRequestSchema.safeParse({
        transitionId: TRANSITION_ID,
        expected: expectedDrive,
        next: nextBoth,
        verification: { kind: 'drive', driveConnectionId: VAULT_ID, docs: [] },
      }).success,
    ).toBe(false);
  });

  it('binds Drive verification to the target connection', () => {
    const request = {
      transitionId: TRANSITION_ID,
      expected: {
        media: ['server'],
        driveConnectionId: null,
        mediaAttestedAt: null,
      },
      next: { media: ['server', 'drive'], driveConnectionId: VAULT_ID },
      verification: {
        kind: 'drive',
        driveConnectionId: VAULT_ID,
        docs: [{ docId: DOC_ID, docVersion: 1, writeId: WRITE_ID }],
      },
    } as const;
    expect(perVaultMediaTransitionRequestSchema.safeParse(request).success).toBe(true);
    expect(
      perVaultMediaTransitionRequestSchema.safeParse({
        ...request,
        verification: { ...request.verification, driveConnectionId: OTHER_VAULT_ID },
      }).success,
    ).toBe(false);

    expect(
      perVaultMediaTransitionRequestSchema.safeParse({
        transitionId: TRANSITION_ID,
        expected: expectedDrive,
        next: { ...nextBoth, driveConnectionId: OTHER_VAULT_ID },
        verification: { kind: 'server-candidates', readbacks },
      }).success,
    ).toBe(false);
  });

  it('allows an unchanged selection only as a medium-specific full-set attestation refresh', () => {
    const serverRefresh = {
      transitionId: TRANSITION_ID,
      expected: {
        media: ['server'],
        driveConnectionId: null,
        mediaAttestedAt: null,
      },
      next: { media: ['server'], driveConnectionId: null },
      verification: {
        kind: 'server',
        docs: [{ docId: DOC_ID, docVersion: 1, writeId: WRITE_ID }],
      },
    } as const;
    expect(perVaultMediaTransitionRequestSchema.safeParse(serverRefresh).success).toBe(true);
    expect(
      perVaultMediaTransitionRequestSchema.safeParse({
        ...serverRefresh,
        verification: {
          kind: 'drive',
          driveConnectionId: VAULT_ID,
          docs: serverRefresh.verification.docs,
        },
      }).success,
    ).toBe(false);

    const driveRefresh = {
      transitionId: TRANSITION_ID,
      expected: expectedDrive,
      next: { media: ['drive'], driveConnectionId: VAULT_ID },
      verification: {
        kind: 'drive',
        driveConnectionId: VAULT_ID,
        docs: [{ docId: DOC_ID, docVersion: 1, writeId: WRITE_ID }],
      },
    } as const;
    expect(perVaultMediaTransitionRequestSchema.safeParse(driveRefresh).success).toBe(true);
    expect(
      perVaultMediaTransitionRequestSchema.safeParse({
        ...driveRefresh,
        verification: { kind: 'server', docs: driveRefresh.verification.docs },
      }).success,
    ).toBe(false);

    expect(
      perVaultMediaTransitionRequestSchema.safeParse({
        ...driveRefresh,
        expected: {
          media: ['server', 'drive'],
          driveConnectionId: VAULT_ID,
          mediaAttestedAt: null,
        },
        next: { media: ['server', 'drive'], driveConnectionId: VAULT_ID },
      }).success,
    ).toBe(true);
  });
});

describe('per-vault retirement generation + version-set purge transcript (R4)', () => {
  // Deterministic TEST VECTOR, not a secret: unpadded base64url shape of SHA-256.
  const VERSION_SET_HASH = 'A'.repeat(43);
  const CHALLENGE = 'challenge-'.padEnd(32, 'c');
  const SIGNATURE = 's'.repeat(86);
  const observedDocs = [
    { docId: OTHER_DOC_ID, docVersion: 8, writeId: DEVICE_ID },
    { docId: DOC_ID, docVersion: 7, writeId: WRITE_ID },
  ];

  it('canonicalizes the sorted (docId, docVersion) set before hashing', () => {
    const first = serializeVaultRetirementVersionSet([
      { docId: OTHER_DOC_ID, docVersion: 8 },
      { docId: DOC_ID, docVersion: 9 },
      { docId: DOC_ID, docVersion: 7 },
    ]);
    const reordered = serializeVaultRetirementVersionSet([
      { docId: DOC_ID, docVersion: 7 },
      { docId: OTHER_DOC_ID, docVersion: 8 },
      { docId: DOC_ID, docVersion: 9 },
    ]);
    expect(new TextDecoder().decode(first)).toBe(
      JSON.stringify([
        [DOC_ID, 7],
        [DOC_ID, 9],
        [OTHER_DOC_ID, 8],
      ]),
    );
    expect(Array.from(reordered)).toEqual(Array.from(first));
    expect(vaultVersionSetHashSchema.safeParse(VERSION_SET_HASH).success).toBe(true);
    expect(vaultVersionSetHashSchema.safeParse(`${VERSION_SET_HASH}A`).success).toBe(false);
  });

  it('pins identity in challenge, request and purge response shapes', () => {
    const identity = { vaultId: VAULT_ID, generation: 3, versionSetHash: VERSION_SET_HASH };
    expect(perVaultRetiredServerPurgeChallengeRequestSchema.parse(identity)).toEqual(identity);
    const request = {
      ...identity,
      observedDocs,
      challenge: CHALLENGE,
      signature: SIGNATURE,
    };
    expect(perVaultRetiredServerPurgeRequestSchema.safeParse(request).success).toBe(true);
    expect(perVaultRetiredServerPurgeResponseSchema.parse({ ...identity, purged: true })).toEqual({
      ...identity,
      purged: true,
    });
    expect(
      perVaultRetiredServerPurgeRequestSchema.safeParse({
        ...request,
        observedDocs: [observedDocs[0], { ...observedDocs[1], docId: OTHER_DOC_ID }],
      }).success,
    ).toBe(false);
  });

  it('canonicalizes observed docs inside the domain-separated signed transcript', () => {
    const request = perVaultRetiredServerPurgeRequestSchema.parse({
      vaultId: VAULT_ID,
      generation: 3,
      versionSetHash: VERSION_SET_HASH,
      observedDocs,
      challenge: CHALLENGE,
      signature: SIGNATURE,
    });
    const reversed = { ...request, observedDocs: [...request.observedDocs].reverse() };
    const transcript = serializePerVaultRetiredServerPurgeTranscript(request);
    expect(Array.from(serializePerVaultRetiredServerPurgeTranscript(reversed))).toEqual(
      Array.from(transcript),
    );
    expect(JSON.parse(new TextDecoder().decode(transcript))).toEqual([
      'bettertrack.per-vault-retired-server-purge.v1',
      VAULT_ID,
      3,
      VERSION_SET_HASH,
      [
        [DOC_ID, 7, WRITE_ID],
        [OTHER_DOC_ID, 8, DEVICE_ID],
      ],
      CHALLENGE,
    ]);
  });
});

describe('move-in / move-out / step-up bodies (§9, §10, §15)', () => {
  const stepUp = { password: 'hunter2hunter2' };
  // Deterministic TEST VECTOR, not a secret: unpadded base64url SHA-256 shape
  // plus the wire length of one Ed25519 signature.
  const documentDigest = 'A'.repeat(43);
  const documentSetHash = 'B'.repeat(43);
  const vaultProof = { challenge: 'challenge-'.padEnd(32, 'c'), signature: 's'.repeat(86) };
  /** Deterministic TEST VECTOR: one same-UUID strict portfolio restore graph. */
  const strictRestoreDocument = {
    schemaVersion: 1,
    entities: [
      {
        id: DOC_ID,
        kind: 'portfolio',
        rev: 3,
        editedAt: '2026-08-20T12:00:00.000Z',
        editedBy: DEVICE_ID,
        deletedAt: null,
        data: {
          userId: ACCOUNT_ID,
          name: 'TEST VECTOR restored portfolio',
          visibility: 'private',
          sortOrder: 2,
          defaultPayFromCash: true,
          archivedAt: null,
          kind: null,
          vaultId: null,
          alias: null,
          vaultAlias: null,
        },
      },
    ],
    mergeLog: [],
    mirrorProvenance: [],
  };

  it('step-up requires at least one credential', () => {
    expect(vaultStepUpCredentialSchema.safeParse({}).success).toBe(false);
    expect(vaultStepUpCredentialSchema.safeParse(stepUp).success).toBe(true);
    expect(vaultStepUpCredentialSchema.safeParse({ code: '123456' }).success).toBe(true);
  });

  it('move-in binds vault + doc CAS + capture revision + step-up', () => {
    expect(
      portfolioVaultMoveInRequestSchema.safeParse({
        vaultId: VAULT_ID,
        docVersion: 1,
        portfolioDataRevision: 'abc123_-',
        stepUp,
      }).success,
    ).toBe(true);
    expect(
      portfolioVaultMoveInRequestSchema.safeParse({
        vaultId: VAULT_ID,
        docVersion: 1,
        portfolioDataRevision: 'abc123_-',
      }).success,
    ).toBe(false);
  });

  it('move-out accepts the strict restore TEST VECTOR and requires step-up', () => {
    const request = {
      vaultId: VAULT_ID,
      moveOutId: DOC_ID,
      lifecycleGeneration: 1,
      documentSetHash,
      document: strictRestoreDocument,
      vaultProof,
      stepUp,
    };

    expect(portfolioVaultMoveOutRequestSchema.parse(request)).toEqual(request);
    expect(
      portfolioVaultMoveOutRequestSchema.safeParse({
        ...request,
        lifecycleGeneration: 0,
      }).success,
    ).toBe(false);
    const { lifecycleGeneration: _lifecycleGeneration, ...withoutLifecycle } = request;
    expect(portfolioVaultMoveOutRequestSchema.safeParse(withoutLifecycle).success).toBe(false);
    expect(
      portfolioVaultMoveOutRequestSchema.safeParse({
        vaultId: VAULT_ID,
        moveOutId: DOC_ID,
        lifecycleGeneration: 1,
        documentSetHash,
        document: strictRestoreDocument,
        vaultProof,
      }).success,
    ).toBe(false);
  });

  it('pins canonical restore bytes and the phrase-proof transcript', () => {
    const reordered = {
      mirrorProvenance: [],
      mergeLog: [],
      entities: strictRestoreDocument.entities.map((entity) => ({
        data: entity.data,
        deletedAt: entity.deletedAt,
        editedBy: entity.editedBy,
        editedAt: entity.editedAt,
        rev: entity.rev,
        kind: entity.kind,
        id: entity.id,
      })),
      schemaVersion: 1,
    };
    expect(Array.from(serializePortfolioVaultRestoreDocument(reordered))).toEqual(
      Array.from(serializePortfolioVaultRestoreDocument(strictRestoreDocument)),
    );
    expect(
      JSON.parse(
        new TextDecoder().decode(
          serializePortfolioVaultMoveOutProofTranscript({
            portfolioId: DOC_ID,
            vaultId: VAULT_ID,
            lifecycleGeneration: 7,
            documentDigest,
            documentSetHash,
            challenge: vaultProof.challenge,
          }),
        ),
      ),
    ).toEqual([
      'bettertrack.portfolio-vault-move-out.v1',
      VAULT_ID,
      DOC_ID,
      7,
      documentDigest,
      documentSetHash,
      vaultProof.challenge,
    ]);
  });

  it('pins the graph-bound move-out challenge exchange', () => {
    const identity = {
      vaultId: VAULT_ID,
      lifecycleGeneration: 7,
      documentDigest,
      documentSetHash,
    };
    expect(portfolioVaultMoveOutChallengeRequestSchema.parse(identity)).toEqual(identity);
    expect(
      portfolioVaultMoveOutChallengeResponseSchema.parse({
        ...identity,
        portfolioId: DOC_ID,
        challenge: vaultProof.challenge,
        expiresAt: '2026-08-20T12:05:00.000Z',
      }),
    ).toEqual({
      ...identity,
      portfolioId: DOC_ID,
      challenge: vaultProof.challenge,
      expiresAt: '2026-08-20T12:05:00.000Z',
    });
  });

  it('move-out rejects generic JSON and unknown strict-row fields', () => {
    expect(
      portfolioVaultMoveOutRequestSchema.safeParse({
        vaultId: VAULT_ID,
        moveOutId: DOC_ID,
        lifecycleGeneration: 1,
        documentSetHash,
        document: { schemaVersion: 1, entities: [{ arbitrary: 'transport JSON' }] },
        vaultProof,
        stepUp,
      }).success,
    ).toBe(false);

    const portfolio = strictRestoreDocument.entities[0]!;
    expect(
      portfolioVaultMoveOutRequestSchema.safeParse({
        vaultId: VAULT_ID,
        moveOutId: DOC_ID,
        lifecycleGeneration: 1,
        documentSetHash,
        document: {
          ...strictRestoreDocument,
          entities: [{ ...portfolio, data: { ...portfolio.data, plaintextHash: 'forbidden' } }],
        },
        vaultProof,
        stepUp,
      }).success,
    ).toBe(false);
  });

  it('pins strict idempotent success receipts', () => {
    const moveIn = {
      portfolioId: DOC_ID,
      vaultId: VAULT_ID,
      docVersion: 7,
      lifecycleGeneration: 1,
      idempotent: false,
    };
    const moveOut = {
      portfolioId: DOC_ID,
      vaultId: VAULT_ID,
      moveOutId: TRANSITION_ID,
      lifecycleGeneration: 1,
      idempotent: true,
    };

    expect(portfolioVaultMoveInResponseSchema.parse(moveIn)).toEqual(moveIn);
    expect(portfolioVaultMoveOutResponseSchema.parse(moveOut)).toEqual(moveOut);
    expect(
      portfolioVaultMoveInResponseSchema.safeParse({ ...moveIn, cleartextRowsPurged: 42 }).success,
    ).toBe(false);
    expect(
      portfolioVaultMoveOutResponseSchema.safeParse({ ...moveOut, restoredRows: 42 }).success,
    ).toBe(false);
  });

  it('pins the stable transition refusal codes', () => {
    expect(PORTFOLIO_VAULT_TRANSITION_ERROR_CODES).toEqual({
      notFound: 'PORTFOLIO_VAULT_NOT_FOUND',
      alreadyVaulted: 'PORTFOLIO_ALREADY_VAULTED',
      notVaulted: 'PORTFOLIO_NOT_VAULTED',
      mediaNotVerified: 'VAULT_MEDIA_NOT_VERIFIED',
      activeMirrorchain: 'PORTFOLIO_VAULT_ACTIVE_MIRRORCHAIN',
      pendingImport: 'PORTFOLIO_VAULT_PENDING_IMPORT',
      pendingExport: 'PORTFOLIO_VAULT_PENDING_EXPORT',
      captureExpired: 'PORTFOLIO_VAULT_CAPTURE_EXPIRED',
      revisionStale: 'PORTFOLIO_VAULT_REVISION_STALE',
      documentMissing: 'PORTFOLIO_VAULT_DOCUMENT_MISSING',
      documentVersionMismatch: 'PORTFOLIO_VAULT_DOCUMENT_VERSION_MISMATCH',
      documentSetStale: 'PORTFOLIO_VAULT_DOCUMENT_SET_STALE',
      transitionConflict: 'PORTFOLIO_VAULT_TRANSITION_CONFLICT',
      restoreInvalid: 'PORTFOLIO_VAULT_RESTORE_INVALID',
      restoreSolvency: 'PORTFOLIO_VAULT_RESTORE_INSOLVENT',
      restoreProvenance: 'PORTFOLIO_VAULT_RESTORE_PROVENANCE_INVALID',
      possessionProofInvalid: 'PORTFOLIO_VAULT_POSSESSION_PROOF_INVALID',
      captureUnservable: 'PORTFOLIO_VAULT_CAPTURE_UNSERVABLE',
    });
  });
});

describe('envelope v2 header schema', () => {
  it('is strict and pins the literal format version + slot kind', async () => {
    const header = await makeHeader();
    expect(vaultDocEnvelopeHeaderSchema.parse(header)).toEqual(header);
    expect(vaultDocEnvelopeHeaderSchema.safeParse({ ...header, formatVersion: 1 }).success).toBe(
      false,
    );
    expect(
      vaultDocEnvelopeHeaderSchema.safeParse({
        ...header,
        keySlots: [{ keyId: KEY_ID, slot: 'password-v1', wrappedKc: 'x' }],
      }).success,
    ).toBe(false);
    expect(vaultDocEnvelopeHeaderSchema.safeParse({ ...header, docKind: 'roster' }).success).toBe(
      false,
    );
  });
});
