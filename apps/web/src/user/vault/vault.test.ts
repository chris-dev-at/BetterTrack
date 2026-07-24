import { webcrypto } from 'node:crypto';

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  decodeVaultEnvelope as decodeContractEnvelope,
  encodeVaultEnvelope as encodeContractEnvelope,
  VAULT_FORMAT_VERSION,
  type VaultEnvelopeHeader,
  vaultEnvelopeHeaderSchema,
} from '@bettertrack/contracts';

import { bytesToBase64 } from './bytes';
import {
  decryptVaultDocument,
  deriveVaultKek,
  encryptVaultDocument,
  generateVaultKey,
  newKdfParams,
  unwrapVaultKey,
  wrapVaultKey,
} from './crypto';
import { createIndexedDbVaultCustody } from './custody';
import { decodeVaultEnvelope, encodeVaultEnvelope, inspectVaultEnvelope } from './envelope';
import { VaultCryptoError } from './errors';
import { VaultLockCore } from './lock';
import { importRecoveryKit, serializeRecoveryKit } from './recovery';
import { changeVaultPassphrase, rotateVaultKey } from './rekey';
import {
  deterministicRandom,
  VECTOR_DEVICE_ID,
  VECTOR_KEY_ID,
  VECTOR_WRITE_ID,
  vaultVectorDocument,
  vectorKdf,
} from './vectors';

const headerMetadata = {
  vaultVersion: 1,
  deviceId: VECTOR_DEVICE_ID,
  writeId: VECTOR_WRITE_ID,
  writtenAt: '2026-07-24T10:00:00.000Z',
};

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

async function fixture() {
  const random = deterministicRandom();
  const vaultKey = generateVaultKey(random);
  const kdf = newKdfParams(random);
  const kek = await deriveVaultKek('correct horse battery staple', kdf, vectorKdf);
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

  it('rejects invalid structural input and leaves newer versions read-only', () => {
    expect(() => decodeVaultEnvelope(new Uint8Array([1, 2, 3]))).toThrow(VaultCryptoError);
    const header = {
      formatVersion: 2,
      cipher: 'A256GCM',
      iv: 'AAAAAAAAAAAAAAAA',
      keyId: VECTOR_KEY_ID,
      wrappedKeys: [],
      vaultVersion: 1,
      schemaVersion: 2,
      deviceId: VECTOR_DEVICE_ID,
      writeId: VECTOR_WRITE_ID,
      writtenAt: '2026-07-24T10:00:00.000Z',
    };
    const raw = new TextEncoder().encode(JSON.stringify(header));
    const bytes = new Uint8Array(8 + 4 + raw.length + 16);
    bytes.set(new TextEncoder().encode('BTVAULT1'));
    new DataView(bytes.buffer).setUint32(8, raw.length, false);
    bytes.set(raw, 12);
    expect(inspectVaultEnvelope(bytes)).toEqual({
      status: 'update-required',
      formatVersion: 2,
      schemaVersion: 2,
    });
  });

  it('pins the required Argon2id profile and fails closed if WASM fails', async () => {
    const params = {
      alg: 'argon2id' as const,
      m: 65536,
      t: 3,
      p: 1,
      salt: bytesToBase64(new Uint8Array(16)),
    };
    await expect(deriveVaultKek('passphrase', params, vectorKdf)).resolves.toHaveLength(32);
    await expect(
      deriveVaultKek('passphrase', { ...params, m: 1024 }, vectorKdf),
    ).rejects.toMatchObject({
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

  it('rejects wrong passphrases and modified wrapped vault keys', async () => {
    const { wrapped, kdf } = await fixture();
    const wrongKek = await deriveVaultKek('wrong passphrase', kdf, vectorKdf);
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
        writeId: '018f0000-0000-7000-8000-00000000000d',
      },
      randomBytes: deterministicRandom(),
      cryptoDeps: vectorKdf,
    });
    expect(changed.document).toEqual(vaultVectorDocument);
    expect(changed.header.iv).not.toBe(original.header.iv);
    expect(bytesToBase64(changed.envelope)).not.toBe(bytesToBase64(original.envelope));
    const changedWrapper = changed.header.wrappedKeys[0];
    expect(changedWrapper).toBeDefined();
    const oldKek = await deriveVaultKek(
      'correct horse battery staple',
      changedWrapper!.kdf,
      vectorKdf,
    );
    await expect(
      unwrapVaultKey(changedWrapper!, changed.header.keyId, oldKek),
    ).rejects.toMatchObject({
      code: 'authentication-failed',
    });
    oldKek.fill(0);
    expect(await decryptVaultDocument(changed.envelope, changed.vaultKey)).toMatchObject({
      document: vaultVectorDocument,
    });
  });

  it('rotates a VK and does not replace the last decryptable state on failure', async () => {
    const original = await fixture();
    const rotated = await rotateVaultKey({
      envelope: original.envelope,
      passphrase: 'correct horse battery staple',
      nextKeyId: '018f0000-0000-7000-8000-00000000000d',
      metadata: {
        ...headerMetadata,
        vaultVersion: 2,
        writeId: '018f0000-0000-7000-8000-00000000000d',
      },
      randomBytes: deterministicRandom(96),
      cryptoDeps: vectorKdf,
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
        passphrase: 'wrong',
        nextKeyId: '018f0000-0000-7000-8000-00000000000d',
        metadata: headerMetadata,
        cryptoDeps: vectorKdf,
      }),
    ).rejects.toBeInstanceOf(VaultCryptoError);
    expect(await decryptVaultDocument(original.envelope, original.vaultKey)).toMatchObject({
      document: vaultVectorDocument,
    });
  });
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
    await core.unlockWithPassphrase(original.envelope, 'correct horse battery staple', vectorKdf);
    expect(core.state).toEqual({ status: 'unlocked', keyId: VECTOR_KEY_ID });
    await core.handleIdle(true);
    expect(core.state).toEqual({ status: 'locked' });

    const custody = createIndexedDbVaultCustody();
    await custody.persist(VECTOR_DEVICE_ID, original.vaultKey);
    const persisted = await custody.read(VECTOR_DEVICE_ID);
    expect(persisted).toMatchObject({ extractable: false, type: 'secret' });
    const deviceCore = new VaultLockCore({ custody });
    await deviceCore.unlockFromDevice(VECTOR_DEVICE_ID, original.envelope);
    expect(
      await deviceCore.withVaultKey((key) => decryptVaultDocument(original.envelope, key)),
    ).toMatchObject({
      document: vaultVectorDocument,
    });
    await custody.clear(VECTOR_DEVICE_ID);
    await expect(custody.read(VECTOR_DEVICE_ID)).resolves.toBeNull();
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

  it('does not unlock after a wrong passphrase', async () => {
    const original = await fixture();
    const core = new VaultLockCore();
    await expect(
      core.unlockWithPassphrase(original.envelope, 'wrong', vectorKdf),
    ).rejects.toMatchObject({
      code: 'authentication-failed',
    });
    expect(core.state).toEqual({ status: 'locked' });
  });
});
