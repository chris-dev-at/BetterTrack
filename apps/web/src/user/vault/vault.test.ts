import { webcrypto } from 'node:crypto';

import { deflateSync } from 'fflate';
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  decodeVaultEnvelope as decodeContractEnvelope,
  encodeVaultEnvelope as encodeContractEnvelope,
  VAULT_DOCUMENT_VERSION,
  VAULT_FORMAT_VERSION,
  type VaultEnvelopeHeader,
  vaultEnvelopeHeaderSchema,
} from '@bettertrack/contracts';

import { base64ToBytes, bytesToBase64 } from './bytes';
import {
  decryptVaultDocument,
  deriveVaultKek,
  encryptVaultDocument,
  generateVaultKey,
  newKdfParams,
  VAULT_IV_BYTES,
  type RandomBytes,
  unwrapVaultKey,
  wrapVaultKey,
} from './crypto';
import { createIndexedDbVaultCustody } from './custody';
import {
  decodeVaultEnvelope,
  encodeVaultEnvelope,
  inspectVaultEnvelope,
  serializeVaultHeader,
} from './envelope';
import { VaultCryptoError } from './errors';
import { VaultLockCore } from './lock';
import { importRecoveryKit, serializeRecoveryKit } from './recovery';
import { changeVaultPassphrase, rotateVaultKey } from './rekey';
import {
  deterministicRandom,
  VECTOR_DEVICE_ID,
  VECTOR_KEY_ID,
  VECTOR_NEXT_KEY_ID,
  VECTOR_WRITE_ID,
  vaultInteroperabilityFixture,
  vaultVectorDocument,
} from './vectors';

const headerMetadata = {
  vaultVersion: 1,
  deviceId: VECTOR_DEVICE_ID,
  writeId: VECTOR_WRITE_ID,
  writtenAt: '2026-07-24T10:00:00.000Z',
};
const firstRekeyWriteId = '018f0000-0000-7000-8000-00000000000d';
const unexpectedArgon2 = async () => Promise.reject(new Error('KDF must not run'));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function failingDeterministicRandom(failAtCall: number, start = 0): RandomBytes {
  const random = deterministicRandom(start);
  let calls = 0;
  return (length) => {
    calls += 1;
    if (calls === failAtCall) throw new Error(`Deterministic random failure at call ${calls}.`);
    return random(length);
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

async function fixture() {
  const random = deterministicRandom();
  const vaultKey = generateVaultKey(random);
  const kdf = newKdfParams(random);
  const kek = await deriveVaultKek('correct horse battery staple', kdf);
  const wrapped = await wrapVaultKey(vaultKey, kek, VECTOR_KEY_ID, kdf, random);
  const encrypted = await encryptVaultDocument({
    document: vaultVectorDocument,
    vaultKey,
    header: { keyId: VECTOR_KEY_ID, wrappedKeys: [wrapped], ...headerMetadata },
    randomBytes: random,
  });
  kek.fill(0);
  return { ...encrypted, vaultKey, kdf, wrapped };
}

describe('BTVAULT1 envelope and content crypto', () => {
  it('is interoperable with the PD2 contract header and authenticates exact header bytes', async () => {
    const { envelope, header, vaultKey } = await fixture();
    const decoded = decodeVaultEnvelope(envelope);
    const contractDecoded = decodeContractEnvelope(envelope);
    expect(vaultEnvelopeHeaderSchema.parse(decoded.header)).toEqual(header);
    expect(contractDecoded.header).toEqual(header);
    expect(Array.from(contractDecoded.ciphertext)).toEqual(Array.from(decoded.ciphertext));
    const contractEnvelope = encodeContractEnvelope(header, decoded.ciphertext);
    const contractRoundTrip = decodeContractEnvelope(contractEnvelope);
    expect(contractRoundTrip.header).toEqual(header);
    expect(Array.from(contractRoundTrip.ciphertext)).toEqual(Array.from(decoded.ciphertext));
    await expect(decryptVaultDocument(contractEnvelope, vaultKey)).resolves.toMatchObject({
      document: vaultVectorDocument,
      header,
    });
    expect(Array.from(envelope.subarray(0, 8))).toEqual(
      Array.from(new TextEncoder().encode('BTVAULT1')),
    );
    expect(await decryptVaultDocument(envelope, vaultKey)).toMatchObject({
      document: vaultVectorDocument,
    });

    for (const mutate of [
      (value: VaultEnvelopeHeader) => ({ ...value, vaultVersion: 2 }),
      (value: VaultEnvelopeHeader) => ({ ...value, keyId: VECTOR_WRITE_ID }),
      (value: VaultEnvelopeHeader) => ({ ...value, writtenAt: '2026-07-25T10:00:00.000Z' }),
      (value: VaultEnvelopeHeader) => ({ ...value, wrappedKeys: [] }),
    ]) {
      const changed = mutate(header);
      if (vaultEnvelopeHeaderSchema.safeParse(changed).success) {
        await expect(
          decryptVaultDocument(encodeVaultEnvelope(changed, decoded.ciphertext), vaultKey),
        ).rejects.toMatchObject({
          code: 'authentication-failed',
        });
      }
    }

    const changedCiphertext = envelope.slice();
    const last = changedCiphertext.length - 1;
    changedCiphertext[last] = changedCiphertext[last]! ^ 1;
    await expect(decryptVaultDocument(changedCiphertext, vaultKey)).rejects.toMatchObject({
      code: 'authentication-failed',
    });
  });

  it('decrypts a valid PD2 envelope whose header has noncanonical JSON member order', async () => {
    const { header, vaultKey } = await fixture();
    const noncanonicalHeader: VaultEnvelopeHeader = {
      vaultVersion: header.vaultVersion,
      deviceId: header.deviceId,
      writeId: header.writeId,
      writtenAt: header.writtenAt,
      keyId: header.keyId,
      wrappedKeys: header.wrappedKeys,
      formatVersion: header.formatVersion,
      schemaVersion: header.schemaVersion,
      cipher: header.cipher,
      iv: header.iv,
    };
    const headerBytes = new TextEncoder().encode(JSON.stringify(noncanonicalHeader));
    expect(Array.from(headerBytes)).not.toEqual(
      Array.from(serializeVaultHeader(noncanonicalHeader)),
    );

    const plaintext = new TextEncoder().encode(JSON.stringify(vaultVectorDocument));
    const compressed = deflateSync(plaintext);
    const ciphertext = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: base64ToBytes(noncanonicalHeader.iv, 'envelope-invalid'),
          additionalData: headerBytes,
          tagLength: 128,
        },
        await globalThis.crypto.subtle.importKey('raw', vaultKey, { name: 'AES-GCM' }, false, [
          'encrypt',
        ]),
        compressed,
      ),
    );
    const envelope = encodeContractEnvelope(noncanonicalHeader, ciphertext);

    expect(Array.from(decodeVaultEnvelope(envelope).headerBytes)).toEqual(Array.from(headerBytes));
    await expect(decryptVaultDocument(envelope, vaultKey)).resolves.toMatchObject({
      document: vaultVectorDocument,
      header: noncanonicalHeader,
    });

    const headerMutation = encodeContractEnvelope(
      { ...noncanonicalHeader, vaultVersion: noncanonicalHeader.vaultVersion + 1 },
      ciphertext,
    );
    await expect(decryptVaultDocument(headerMutation, vaultKey)).rejects.toMatchObject({
      code: 'authentication-failed',
    });

    const ciphertextMutation = envelope.slice();
    ciphertextMutation[ciphertextMutation.length - 1] =
      ciphertextMutation[ciphertextMutation.length - 1]! ^ 1;
    await expect(decryptVaultDocument(ciphertextMutation, vaultKey)).rejects.toMatchObject({
      code: 'authentication-failed',
    });
  });

  it('rejects invalid structural input and leaves newer versions read-only', () => {
    expect(() => decodeVaultEnvelope(new Uint8Array([1, 2, 3]))).toThrow(VaultCryptoError);
    const header = {
      formatVersion: VAULT_FORMAT_VERSION,
      cipher: 'A256GCM',
      iv: 'AAAAAAAAAAAAAAAA',
      keyId: VECTOR_KEY_ID,
      wrappedKeys: [],
      vaultVersion: 1,
      schemaVersion: VAULT_DOCUMENT_VERSION + 1,
      deviceId: VECTOR_DEVICE_ID,
      writeId: VECTOR_WRITE_ID,
      writtenAt: '2026-07-24T10:00:00.000Z',
      futureSchemaField: 'v2',
    };
    const raw = new TextEncoder().encode(JSON.stringify(header));
    const truncated = new Uint8Array(8 + 4 + raw.length + 15);
    truncated.set(new TextEncoder().encode('BTVAULT1'));
    new DataView(truncated.buffer).setUint32(8, raw.length, false);
    truncated.set(raw, 12);
    expect(() => decodeVaultEnvelope(truncated)).toThrow(VaultCryptoError);

    const bytes = new Uint8Array(8 + 4 + raw.length + 16);
    bytes.set(new TextEncoder().encode('BTVAULT1'));
    new DataView(bytes.buffer).setUint32(8, raw.length, false);
    bytes.set(raw, 12);
    let decodeError: unknown;
    try {
      decodeVaultEnvelope(bytes);
    } catch (cause) {
      decodeError = cause;
    }
    expect(decodeError).toMatchObject({ code: 'update-required' });
    expect(inspectVaultEnvelope(bytes)).toEqual({
      status: 'update-required',
      formatVersion: VAULT_FORMAT_VERSION,
      schemaVersion: VAULT_DOCUMENT_VERSION + 1,
    });
  });

  it('rejects cleartext fields outside the exact header, wrapper, and KDF contract', async () => {
    const { header } = await fixture();
    const wrapper = header.wrappedKeys[0]!;
    const leakedHeaders = [
      { ...header, portfolioBalance: '123456.78' },
      {
        ...header,
        wrappedKeys: [{ ...wrapper, portfolioBalance: '123456.78' }],
      },
      {
        ...header,
        wrappedKeys: [
          {
            ...wrapper,
            kdf: { ...wrapper.kdf, portfolioBalance: '123456.78' },
          },
        ],
      },
    ];

    for (const leakedHeader of leakedHeaders) {
      const headerBytes = new TextEncoder().encode(JSON.stringify(leakedHeader));
      const envelope = new Uint8Array(12 + headerBytes.length + 16);
      envelope.set(new TextEncoder().encode('BTVAULT1'));
      new DataView(envelope.buffer).setUint32(8, headerBytes.length, false);
      envelope.set(headerBytes, 12);
      expect(() => decodeVaultEnvelope(envelope)).toThrow(VaultCryptoError);
    }
  });

  it('matches public fixed Argon2id envelope, tamper, passphrase, rotation, recovery, and rollback vectors', async () => {
    const vector = vaultInteroperabilityFixture;
    const vaultKey = new Uint8Array(Buffer.from(vector.vaultKeyBase64, 'base64'));
    const initialEnvelope = new Uint8Array(Buffer.from(vector.initial.envelopeBase64, 'base64'));
    expect(bytesToBase64(await deriveVaultKek(vector.passphrase, vector.kdf))).toBe(
      vector.kekBase64,
    );
    expect(bytesToBase64(initialEnvelope)).toBe(vector.initial.envelopeBase64);
    expect(bytesToBase64(decodeVaultEnvelope(initialEnvelope).headerBytes)).toBe(
      vector.initial.headerBytesBase64,
    );
    // The immutable PD4 vector carries the pre-PD3a document shape. Its envelope
    // remains a valid crypto/KDF vector, but the strict current payload decoder
    // intentionally rejects that historical body.
    const expectLegacyDocumentInvalid = () =>
      expect(decryptVaultDocument(initialEnvelope, vaultKey)).rejects.toMatchObject({
        code: 'document-invalid',
      });
    await expectLegacyDocumentInvalid();
    await expect(
      decryptVaultDocument(
        new Uint8Array(Buffer.from(vector.initial.tamperedEnvelopeBase64!, 'base64')),
        vaultKey,
      ),
    ).rejects.toMatchObject({ code: 'authentication-failed' });

    const wrongSecretKek = await deriveVaultKek(vector.wrongSecret.passphrase, vector.kdf);
    expect(bytesToBase64(wrongSecretKek)).toBe(vector.wrongSecret.kekBase64);
    await expect(
      unwrapVaultKey(
        vector.initial.header.wrappedKeys[0]!,
        vector.initial.header.keyId,
        wrongSecretKek,
      ),
    ).rejects.toMatchObject({ code: vector.wrongSecret.expectedErrorCode });
    wrongSecretKek.fill(0);

    const updateRequiredEnvelope = new Uint8Array(
      Buffer.from(vector.updateRequired.envelopeBase64, 'base64'),
    );
    expect(bytesToBase64(updateRequiredEnvelope)).toBe(vector.updateRequired.envelopeBase64);
    expect(bytesToBase64(decodeContractEnvelope(updateRequiredEnvelope).headerBytes)).toBe(
      vector.updateRequired.headerBytesBase64,
    );
    expect(inspectVaultEnvelope(updateRequiredEnvelope)).toEqual({
      status: vector.updateRequired.expectedStatus,
      formatVersion: vector.updateRequired.formatVersion,
      schemaVersion: vector.updateRequired.schemaVersion,
    });
    expect(() => decodeVaultEnvelope(updateRequiredEnvelope)).toThrow(
      expect.objectContaining({ code: 'update-required' }),
    );

    await expect(
      changeVaultPassphrase({
        envelope: initialEnvelope,
        oldPassphrase: vector.passphrase,
        newPassphrase: vector.newPassphrase,
        metadata: vector.passphraseChanged.header,
        randomBytes: deterministicRandom(),
      }),
    ).rejects.toMatchObject({ code: 'document-invalid' });

    await expect(
      rotateVaultKey({
        envelope: initialEnvelope,
        passphrase: vector.passphrase,
        metadata: vector.rotated.header,
        randomBytes: deterministicRandom(96),
        keyIdGenerator: () => VECTOR_NEXT_KEY_ID,
      }),
    ).rejects.toMatchObject({ code: 'document-invalid' });
    expect(
      bytesToBase64(
        serializeRecoveryKit({ keyId: VECTOR_KEY_ID, vaultKey, formatVersion: 1 }).bytes,
      ),
    ).toBe(vector.recoveryKitBase64);
    await expect(
      changeVaultPassphrase({
        envelope: initialEnvelope,
        oldPassphrase: vector.passphrase,
        newPassphrase: vector.passphrase,
        metadata: vector.passphraseChanged.header,
      }),
    ).rejects.toMatchObject({ code: 'envelope-invalid' });
    await expect(
      changeVaultPassphrase({
        envelope: initialEnvelope,
        oldPassphrase: vector.passphrase,
        newPassphrase: vector.newPassphrase,
        metadata: { ...vector.initial.header, vaultVersion: vector.rollback.rejectedVaultVersion },
      }),
    ).rejects.toMatchObject({ code: 'envelope-invalid' });

    const rollback = vector.rollback;
    expect(bytesToBase64(initialEnvelope)).toBe(rollback.expectedEnvelopeBase64);
    expect(bytesToBase64(decodeVaultEnvelope(initialEnvelope).headerBytes)).toBe(
      rollback.expectedHeaderBytesBase64,
    );
    expect(bytesToBase64(vaultKey)).toBe(rollback.expectedVaultKeyBase64);
    expect(vector.initial.header.keyId).toBe(rollback.expectedKeyId);

    // These operations decrypt before consuming randomness. The immutable PD4
    // body predates the strict PD3a document union, so validation deliberately
    // stops both before their injected random failure points and leaves bytes
    // untouched.
    await expect(
      changeVaultPassphrase({
        envelope: initialEnvelope,
        oldPassphrase: rollback.passphraseChange.oldPassphrase,
        newPassphrase: rollback.passphraseChange.newPassphrase!,
        metadata: rollback.passphraseChange.metadata,
        randomBytes: failingDeterministicRandom(
          rollback.passphraseChange.failAtRandomCall,
          rollback.passphraseChange.randomStart,
        ),
      }),
    ).rejects.toMatchObject({ code: 'document-invalid' });
    expect(bytesToBase64(initialEnvelope)).toBe(rollback.expectedEnvelopeBase64);
    expect(bytesToBase64(decodeVaultEnvelope(initialEnvelope).headerBytes)).toBe(
      rollback.expectedHeaderBytesBase64,
    );
    await expectLegacyDocumentInvalid();

    await expect(
      rotateVaultKey({
        envelope: initialEnvelope,
        passphrase: rollback.rotation.oldPassphrase,
        metadata: rollback.rotation.metadata,
        randomBytes: failingDeterministicRandom(
          rollback.rotation.failAtRandomCall,
          rollback.rotation.randomStart,
        ),
        keyIdGenerator: () => rollback.rotation.keyId,
      }),
    ).rejects.toMatchObject({ code: 'document-invalid' });
    expect(bytesToBase64(initialEnvelope)).toBe(rollback.expectedEnvelopeBase64);
    expect(bytesToBase64(decodeVaultEnvelope(initialEnvelope).headerBytes)).toBe(
      rollback.expectedHeaderBytesBase64,
    );
    await expectLegacyDocumentInvalid();
  });

  it('rejects producer headers without an active wrapper or the required Argon2id profile', async () => {
    const { header, vaultKey } = await fixture();
    const wrapper = header.wrappedKeys[0]!;
    const encryptionHeader = {
      keyId: header.keyId,
      vaultVersion: header.vaultVersion,
      deviceId: header.deviceId,
      writeId: header.writeId,
      writtenAt: header.writtenAt,
    };

    await expect(
      encryptVaultDocument({
        document: vaultVectorDocument,
        vaultKey,
        header: {
          ...encryptionHeader,
          wrappedKeys: [{ ...wrapper, keyId: VECTOR_NEXT_KEY_ID }],
        },
      }),
    ).rejects.toMatchObject({ code: 'envelope-invalid' });
    await expect(
      encryptVaultDocument({
        document: vaultVectorDocument,
        vaultKey,
        header: {
          ...encryptionHeader,
          wrappedKeys: [{ ...wrapper, kdf: { ...wrapper.kdf, m: 1024 } }],
        },
      }),
    ).rejects.toMatchObject({ code: 'envelope-invalid' });
  });

  it('pins the required Argon2id profile and fails closed if WASM fails', async () => {
    const params = {
      alg: 'argon2id' as const,
      m: 65536,
      t: 3,
      p: 1,
      salt: bytesToBase64(new Uint8Array(16)),
    };
    await expect(deriveVaultKek('passphrase', params)).resolves.toHaveLength(32);
    await expect(deriveVaultKek('passphrase', { ...params, m: 1024 })).rejects.toMatchObject({
      code: 'kdf-failed',
    });
    await expect(
      deriveVaultKek('passphrase', params, {
        argon2: async () => Promise.reject(new Error('WASM')),
      }),
    ).rejects.toMatchObject({
      code: 'kdf-failed',
    });
  });

  it('rejects non-96-bit random IVs before producing vault content or wrappers', async () => {
    const { header, kdf, vaultKey } = await fixture();
    const invalidIvRandom = () => new Uint8Array(VAULT_IV_BYTES - 4);
    const encryptionHeader = {
      keyId: header.keyId,
      wrappedKeys: header.wrappedKeys,
      vaultVersion: header.vaultVersion,
      deviceId: header.deviceId,
      writeId: header.writeId,
      writtenAt: header.writtenAt,
    };

    await expect(
      wrapVaultKey(vaultKey, new Uint8Array(32), VECTOR_KEY_ID, kdf, invalidIvRandom),
    ).rejects.toMatchObject({ code: 'envelope-invalid' });
    await expect(
      encryptVaultDocument({
        document: vaultVectorDocument,
        vaultKey,
        header: encryptionHeader,
        randomBytes: invalidIvRandom,
      }),
    ).rejects.toMatchObject({ code: 'envelope-invalid' });
  });

  it('rejects 128-bit and 192-bit AES-GCM CryptoKeys for encryption and decryption', async () => {
    const { envelope, header } = await fixture();
    const encryptionHeader = {
      keyId: header.keyId,
      wrappedKeys: header.wrappedKeys,
      vaultVersion: header.vaultVersion,
      deviceId: header.deviceId,
      writeId: header.writeId,
      writtenAt: header.writtenAt,
    };

    for (const length of [16, 24]) {
      const shortKey = await globalThis.crypto.subtle.importKey(
        'raw',
        new Uint8Array(length),
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
      );
      await expect(
        encryptVaultDocument({
          document: vaultVectorDocument,
          vaultKey: shortKey,
          header: encryptionHeader,
        }),
      ).rejects.toMatchObject({ code: 'authentication-failed' });
      await expect(decryptVaultDocument(envelope, shortKey)).rejects.toMatchObject({
        code: 'authentication-failed',
      });
    }
  });

  it('rejects wrong passphrases and modified wrapped vault keys', async () => {
    const { wrapped, kdf } = await fixture();
    const wrongKek = await deriveVaultKek('wrong passphrase', kdf);
    await expect(unwrapVaultKey(wrapped, VECTOR_KEY_ID, wrongKek)).rejects.toMatchObject({
      code: 'authentication-failed',
    });
    wrongKek.fill(0);
    await expect(
      unwrapVaultKey(
        { ...wrapped, wrappedVk: `${wrapped.wrappedVk.slice(0, -2)}AA` },
        VECTOR_KEY_ID,
        new Uint8Array(32),
      ),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
  });
});

describe('passphrase and key lifecycle', () => {
  it('preserves the document while passphrase change uses a fresh IV and ciphertext', async () => {
    const original = await fixture();
    const changed = await changeVaultPassphrase({
      envelope: original.envelope,
      oldPassphrase: 'correct horse battery staple',
      newPassphrase: 'new secret',
      metadata: {
        ...headerMetadata,
        vaultVersion: 2,
        writeId: firstRekeyWriteId,
      },
      randomBytes: deterministicRandom(),
    });
    expect(changed.document).toEqual(vaultVectorDocument);
    expect(changed.header.iv).not.toBe(original.header.iv);
    expect(bytesToBase64(changed.envelope)).not.toBe(bytesToBase64(original.envelope));
    const changedWrapper = changed.header.wrappedKeys[0];
    expect(changedWrapper).toBeDefined();
    const oldKek = await deriveVaultKek('correct horse battery staple', changedWrapper!.kdf);
    await expect(
      unwrapVaultKey(changedWrapper!, changed.header.keyId, oldKek),
    ).rejects.toMatchObject({
      code: 'authentication-failed',
    });
    oldKek.fill(0);
    expect(await decryptVaultDocument(changed.envelope, changed.vaultKey)).toMatchObject({
      document: vaultVectorDocument,
    });
  }, 15_000);

  it('rejects a reused passphrase and a rekey write ID reused from the prior envelope', async () => {
    const original = await fixture();
    const staleWriteMetadata = { ...headerMetadata, vaultVersion: 2 };

    await expect(
      changeVaultPassphrase({
        envelope: original.envelope,
        oldPassphrase: 'correct horse battery staple',
        newPassphrase: 'correct horse battery staple',
        metadata: {
          ...staleWriteMetadata,
          writeId: firstRekeyWriteId,
        },
      }),
    ).rejects.toMatchObject({ code: 'envelope-invalid' });
    await expect(
      changeVaultPassphrase({
        envelope: original.envelope,
        oldPassphrase: 'correct horse battery staple',
        newPassphrase: 'new secret',
        metadata: staleWriteMetadata,
        cryptoDeps: { argon2: unexpectedArgon2 },
      }),
    ).rejects.toMatchObject({ code: 'envelope-invalid' });
    await expect(
      rotateVaultKey({
        envelope: original.envelope,
        passphrase: 'correct horse battery staple',
        metadata: staleWriteMetadata,
        cryptoDeps: { argon2: unexpectedArgon2 },
        keyIdGenerator: () => VECTOR_NEXT_KEY_ID,
      }),
    ).rejects.toMatchObject({ code: 'envelope-invalid' });
  });

  it('rotates a VK and does not replace the last decryptable state on failure', async () => {
    const original = await fixture();
    const rotated = await rotateVaultKey({
      envelope: original.envelope,
      passphrase: 'correct horse battery staple',
      metadata: {
        ...headerMetadata,
        vaultVersion: 2,
        writeId: firstRekeyWriteId,
      },
      randomBytes: deterministicRandom(96),
      keyIdGenerator: () => VECTOR_NEXT_KEY_ID,
    });
    expect(rotated.header.keyId).not.toBe(original.header.keyId);
    await expect(decryptVaultDocument(rotated.envelope, original.vaultKey)).rejects.toMatchObject({
      code: 'authentication-failed',
    });
    expect(await decryptVaultDocument(rotated.envelope, rotated.vaultKey)).toMatchObject({
      document: vaultVectorDocument,
    });

    await expect(
      rotateVaultKey({
        envelope: original.envelope,
        passphrase: 'correct horse battery staple',
        metadata: {
          ...headerMetadata,
          vaultVersion: 2,
          writeId: firstRekeyWriteId,
        },
        cryptoDeps: { argon2: unexpectedArgon2 },
        keyIdGenerator: () => original.header.keyId.toUpperCase(),
      }),
    ).rejects.toMatchObject({ code: 'envelope-invalid' });
    await expect(
      rotateVaultKey({
        envelope: original.envelope,
        passphrase: 'correct horse battery staple',
        metadata: {
          ...headerMetadata,
          vaultVersion: 2,
          writeId: firstRekeyWriteId,
        },
        cryptoDeps: { argon2: unexpectedArgon2 },
        keyIdGenerator: () => 'not-a-uuid',
      }),
    ).rejects.toMatchObject({ code: 'envelope-invalid' });
    const secondRotation = await rotateVaultKey({
      envelope: rotated.envelope,
      passphrase: 'correct horse battery staple',
      metadata: {
        ...headerMetadata,
        vaultVersion: 3,
        writeId: '018f0000-0000-7000-8000-00000000000e',
      },
    });
    expect(secondRotation.header.keyId).not.toBe(original.header.keyId);
    expect(secondRotation.header.keyId).not.toBe(rotated.header.keyId);
    expect(secondRotation.header.keyId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await expect(
      rotateVaultKey({
        envelope: original.envelope,
        passphrase: 'wrong',
        metadata: {
          ...headerMetadata,
          vaultVersion: 2,
          writeId: firstRekeyWriteId,
        },
        keyIdGenerator: () => VECTOR_NEXT_KEY_ID,
      }),
    ).rejects.toBeInstanceOf(VaultCryptoError);
    expect(await decryptVaultDocument(original.envelope, original.vaultKey)).toMatchObject({
      document: vaultVectorDocument,
    });
  }, 15_000);
});

describe('recovery kit and custody lock core', () => {
  it('round-trips a strict recovery kit and unlocks its matching envelope', async () => {
    const original = await fixture();
    const download = serializeRecoveryKit({
      keyId: VECTOR_KEY_ID,
      vaultKey: original.vaultKey,
      formatVersion: VAULT_FORMAT_VERSION,
    });
    expect(download.filename).toBe('bettertrack-recovery-kit.txt');
    expect(importRecoveryKit(download.bytes)).toMatchObject({ keyId: VECTOR_KEY_ID });
    await expect(
      decryptVaultDocument(original.envelope, importRecoveryKit(download.bytes).vaultKey),
    ).resolves.toMatchObject({
      document: vaultVectorDocument,
    });
    expect(() => importRecoveryKit(new TextEncoder().encode('bad'))).toThrow(VaultCryptoError);
  });

  it('stays locked on failures, supports manual/PIN-seam locking, and persists only non-extractable IDB keys', async () => {
    const original = await fixture();
    const core = new VaultLockCore();
    expect(core.state).toEqual({ status: 'locked' });
    await expect(core.withVaultKey(() => 'nope')).rejects.toMatchObject({ code: 'locked' });
    await core.unlockWithPassphrase(original.envelope, 'correct horse battery staple');
    expect(core.state).toEqual({ status: 'unlocked', keyId: VECTOR_KEY_ID });
    await core.handleIdle(true);
    expect(core.state).toEqual({ status: 'locked' });

    const custody = createIndexedDbVaultCustody();
    const deviceCore = new VaultLockCore({ custody });
    await deviceCore.unlockWithPassphrase(
      original.envelope,
      'correct horse battery staple',
      undefined,
      true,
      VECTOR_DEVICE_ID,
    );
    expect(await custody.read(VECTOR_DEVICE_ID)).toMatchObject({
      extractable: false,
      type: 'secret',
    });
    await deviceCore.lock();
    await expect(custody.read(VECTOR_DEVICE_ID)).resolves.toBeNull();

    await custody.persist(VECTOR_DEVICE_ID, original.vaultKey);
    await deviceCore.unlockFromDevice(VECTOR_DEVICE_ID, original.envelope);
    expect(
      await deviceCore.withVaultKey((key) => decryptVaultDocument(original.envelope, key)),
    ).toMatchObject({
      document: vaultVectorDocument,
    });

    await deviceCore.unlockWithPassphrase(original.envelope, 'correct horse battery staple');
    await expect(custody.read(VECTOR_DEVICE_ID)).resolves.toBeNull();
    await expect(
      deviceCore.unlockFromDevice(VECTOR_DEVICE_ID, original.envelope),
    ).rejects.toMatchObject({ code: 'locked' });
    await deviceCore.lock();
    await expect(custody.read(VECTOR_DEVICE_ID)).resolves.toBeNull();

    await custody.persist(VECTOR_DEVICE_ID, original.vaultKey);
    await deviceCore.unlockFromDevice(VECTOR_DEVICE_ID, original.envelope);
    await deviceCore.handleIdle(true);
    await expect(custody.read(VECTOR_DEVICE_ID)).resolves.toBeNull();
    await expect(
      deviceCore.unlockFromDevice(VECTOR_DEVICE_ID, original.envelope),
    ).rejects.toMatchObject({
      code: 'locked',
    });
  });

  it('keeps every delayed unlock path locked after manual and PIN idle locks', async () => {
    const original = await fixture();
    const recoveryKit = serializeRecoveryKit({
      keyId: VECTOR_KEY_ID,
      vaultKey: original.vaultKey,
      formatVersion: VAULT_FORMAT_VERSION,
    }).bytes;
    for (const lock of [
      (core: VaultLockCore) => core.lock(),
      (core: VaultLockCore) => core.handleIdle(true),
    ]) {
      const passphraseKdfStarted = deferred<void>();
      const passphraseKdf = deferred<Uint8Array>();
      const passphrasePersisted = new Set<string>();
      const passphraseCore = new VaultLockCore({
        custody: {
          persist: async (deviceId) => void passphrasePersisted.add(deviceId),
          read: async () => null,
          clear: async (deviceId) => void passphrasePersisted.delete(deviceId),
        },
      });
      const passphraseUnlock = passphraseCore.unlockWithPassphrase(
        original.envelope,
        'correct horse battery staple',
        {
          argon2: async () => {
            passphraseKdfStarted.resolve();
            return passphraseKdf.promise;
          },
        },
        true,
        VECTOR_DEVICE_ID,
      );
      await passphraseKdfStarted.promise;
      const passphraseLock = lock(passphraseCore);
      expect(passphraseCore.state).toEqual({ status: 'locked' });
      passphraseKdf.resolve(await deriveVaultKek('correct horse battery staple', original.kdf));
      await passphraseLock;
      await expect(passphraseUnlock).rejects.toMatchObject({ code: 'locked' });
      expect(passphraseCore.state).toEqual({ status: 'locked' });
      expect(passphrasePersisted).toEqual(new Set());
      await expect(passphraseCore.withVaultKey(() => 'unavailable')).rejects.toMatchObject({
        code: 'locked',
      });

      const recoveryPersistStarted = deferred<void>();
      const releaseRecoveryPersist = deferred<void>();
      const recoveryPersisted = new Set<string>();
      const recoveryCore = new VaultLockCore({
        custody: {
          persist: async (deviceId) => {
            recoveryPersistStarted.resolve();
            await releaseRecoveryPersist.promise;
            recoveryPersisted.add(deviceId);
          },
          read: async () => null,
          clear: async (deviceId) => void recoveryPersisted.delete(deviceId),
        },
      });
      const recoveryUnlock = recoveryCore.unlockWithRecoveryKit(
        original.envelope,
        recoveryKit,
        true,
        VECTOR_DEVICE_ID,
      );
      await recoveryPersistStarted.promise;
      const recoveryLock = lock(recoveryCore);
      expect(recoveryCore.state).toEqual({ status: 'locked' });
      releaseRecoveryPersist.resolve();
      await recoveryLock;
      await expect(recoveryUnlock).rejects.toMatchObject({ code: 'locked' });
      expect(recoveryCore.state).toEqual({ status: 'locked' });
      expect(recoveryPersisted).toEqual(new Set());
      await expect(recoveryCore.withVaultKey(() => 'unavailable')).rejects.toMatchObject({
        code: 'locked',
      });

      const deviceReadStarted = deferred<void>();
      const deviceRead = deferred<CryptoKey | null>();
      const devicePersisted = new Set([VECTOR_DEVICE_ID]);
      const deviceCore = new VaultLockCore({
        custody: {
          persist: async (deviceId) => void devicePersisted.add(deviceId),
          read: async () => {
            deviceReadStarted.resolve();
            return deviceRead.promise;
          },
          clear: async (deviceId) => void devicePersisted.delete(deviceId),
        },
      });
      const deviceUnlock = deviceCore.unlockFromDevice(VECTOR_DEVICE_ID, original.envelope);
      await deviceReadStarted.promise;
      const deviceLock = lock(deviceCore);
      expect(deviceCore.state).toEqual({ status: 'locked' });
      deviceRead.resolve(
        await globalThis.crypto.subtle.importKey(
          'raw',
          original.vaultKey,
          { name: 'AES-GCM' },
          false,
          ['encrypt', 'decrypt'],
        ),
      );
      await deviceLock;
      await expect(deviceUnlock).rejects.toMatchObject({ code: 'locked' });
      expect(deviceCore.state).toEqual({ status: 'locked' });
      expect(devicePersisted).toEqual(new Set());
      await expect(deviceCore.withVaultKey(() => 'unavailable')).rejects.toMatchObject({
        code: 'locked',
      });
    }
  });

  it('fails closed when device-key persistence is unsupported', async () => {
    const original = await fixture();
    const custody = createIndexedDbVaultCustody();
    const originalIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
    await expect(custody.persist(VECTOR_DEVICE_ID, original.vaultKey)).rejects.toMatchObject({
      code: 'custody-failed',
    });
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: originalIndexedDb,
    });
  });

  it('clears an existing unlock when every replacement unlock path fails', async () => {
    const original = await fixture();
    const recoveryKit = serializeRecoveryKit({
      keyId: VECTOR_KEY_ID,
      vaultKey: original.vaultKey,
      formatVersion: VAULT_FORMAT_VERSION,
    }).bytes;
    const core = new VaultLockCore();
    const expectLocked = async () => {
      expect(core.state).toEqual({ status: 'locked' });
      await expect(core.withVaultKey(() => 'still unlocked')).rejects.toMatchObject({
        code: 'locked',
      });
    };

    await core.unlockWithRecoveryKit(original.envelope, recoveryKit);
    await expect(core.unlockWithPassphrase(original.envelope, 'wrong passphrase')).rejects.toThrow(
      VaultCryptoError,
    );
    await expectLocked();

    await core.unlockWithRecoveryKit(original.envelope, recoveryKit);
    await expect(
      core.unlockWithPassphrase(original.envelope, 'correct horse battery staple', {
        argon2: async () => Promise.reject(new Error('KDF unavailable')),
      }),
    ).rejects.toThrow(VaultCryptoError);
    await expectLocked();

    await core.unlockWithRecoveryKit(original.envelope, recoveryKit);
    const tamperedEnvelope = original.envelope.slice();
    tamperedEnvelope[tamperedEnvelope.length - 1] =
      tamperedEnvelope[tamperedEnvelope.length - 1]! ^ 1;
    await expect(core.unlockWithRecoveryKit(tamperedEnvelope, recoveryKit)).rejects.toThrow(
      VaultCryptoError,
    );
    await expectLocked();

    await core.unlockWithRecoveryKit(original.envelope, recoveryKit);
    await expect(
      core.unlockWithRecoveryKit(original.envelope, new TextEncoder().encode('invalid kit')),
    ).rejects.toThrow(VaultCryptoError);
    await expectLocked();

    const failingCustody = {
      persist: async () => undefined,
      read: async () => Promise.reject(new Error('IndexedDB read failed')),
      clear: async () => undefined,
    };
    const custodyCore = new VaultLockCore({ custody: failingCustody });
    await custodyCore.unlockWithRecoveryKit(original.envelope, recoveryKit);
    await expect(custodyCore.unlockFromDevice(VECTOR_DEVICE_ID, original.envelope)).rejects.toThrow(
      'IndexedDB read failed',
    );
    expect(custodyCore.state).toEqual({ status: 'locked' });
    await expect(custodyCore.withVaultKey(() => 'still unlocked')).rejects.toMatchObject({
      code: 'locked',
    });
  });

  it('does not unlock after a wrong passphrase', async () => {
    const original = await fixture();
    const core = new VaultLockCore();
    await expect(core.unlockWithPassphrase(original.envelope, 'wrong')).rejects.toMatchObject({
      code: 'authentication-failed',
    });
    expect(core.state).toEqual({ status: 'locked' });
  });
});
