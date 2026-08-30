import { webcrypto } from 'node:crypto';

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VAULT_DOC_SCHEMA_VERSION } from '@bettertrack/contracts';

import { utf8, zeroBytes } from '../bytes';
import { encryptVaultDoc } from '../keys/documents';
import {
  deriveAccountBinding,
  deriveKeyFingerprint,
  deriveVaultWrapKey,
  wrapContentKey,
} from '../keys/keyCore';
import { EndpointVaultKeystore } from './core';
import type { DevicePasswordArgon2, DevicePasswordArgon2Options } from './deviceCrypto';
import {
  createIndexedDbEndpointDeviceCustody,
  endpointCustodyId,
  isEndpointDeviceLocked,
  type EndpointDeviceCustody,
} from './deviceCustody';
import { encodeBase64Url } from './encoding';
import { createIndexedDbEndpointKeystoreStorage, type EndpointKeystoreStorage } from './storage';
import type { FetchVaultHeaderEnvelope } from './types';

const VAULT_1 = '018f6a3e-1111-7000-8000-000000000001';
const VAULT_2 = '018f6a3e-1111-7000-8000-000000000002';
const KEY_ID = '018f6a3e-3333-7000-8000-000000000001';
const DOC_ID = '018f6a3e-2222-7000-8000-000000000001';
const DEVICE_ID = '018f6a3e-4444-7000-8000-000000000001';
const WRITE_ID = '018f6a3e-5555-7000-8000-000000000001';
const ACCOUNT_ID = '018f6a3e-0000-7000-8000-00000000aaaa';
const PASSWORD = 'endpoint password secret';
const WRONG_PASSWORD = 'definitely wrong password';

/** Public BIP39 TEST VECTOR: 128 zero entropy bits, never production key material. */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const KEYSTORE_DB = 'bettertrack-custody-test-keystore';
const CUSTODY_DB = 'bettertrack-custody-test-custody';

let storage: EndpointKeystoreStorage;
let custody: EndpointDeviceCustody;

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  localStorage.clear();
  sessionStorage.clear();
  storage = createIndexedDbEndpointKeystoreStorage({ databaseName: KEYSTORE_DB });
  custody = createIndexedDbEndpointDeviceCustody({ databaseName: CUSTODY_DB });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteDatabase(KEYSTORE_DB);
  await deleteDatabase(CUSTODY_DB);
});

/**
 * One tab. Every test builds its tabs over the SAME IndexedDB databases, which
 * is exactly what a reload and a second tab share and an in-memory session does
 * not.
 */
function tab(options: { now?: () => number } = {}): EndpointVaultKeystore {
  return new EndpointVaultKeystore({
    storage,
    custody,
    custodyAccount: () => ACCOUNT_ID,
    argon2: fastArgon2(),
    randomBytes: deterministicRandom(),
    ...(options.now ? { now: options.now } : {}),
  });
}

async function seedWrappedVault(keystore: EndpointVaultKeystore, vaultId = VAULT_1): Promise<void> {
  await keystore.storeAfterVerifiedOpen({
    vaultId,
    mnemonic: MNEMONIC,
    devicePassword: PASSWORD,
    fetchHeaderEnvelope: verifiedHeaderFetch(vaultId),
  });
}

describe('endpoint device custody — the legacy gate semantics, per endpoint', () => {
  it('restores the session after a reload when the user kept it unlocked', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });

    // The reload: the module singleton is gone, the databases are not.
    const reloaded = tab();
    expect(await reloaded.stateFor(VAULT_1)).toMatchObject({
      status: 'stored+wrapped',
      session: 'locked',
    });

    await expect(reloaded.restoreFromDeviceCustody()).resolves.toEqual({
      unlockedVaultIds: [VAULT_1],
    });
    expect(await reloaded.stateFor(VAULT_1)).toMatchObject({
      status: 'stored+wrapped',
      session: 'unlocked',
      requiredAction: { kind: 'open-silently' },
    });
    await expect(reloaded.readMnemonic(VAULT_1)).resolves.toBe(MNEMONIC);
  });

  it('restores in a second tab while the first stays unlocked', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await seedWrappedVault(first, VAULT_2);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });

    const second = tab();
    await expect(second.restoreFromDeviceCustody()).resolves.toEqual({
      unlockedVaultIds: [VAULT_1, VAULT_2],
    });
    expect(await second.stateFor(VAULT_2)).toMatchObject({ session: 'unlocked' });
    // The first tab is untouched by the second tab's restore.
    expect(await first.stateFor(VAULT_2)).toMatchObject({ session: 'unlocked' });
  });

  it('fires the vault-opened edge for every restored vault so stores re-resolve', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await seedWrappedVault(first, VAULT_2);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });

    const reloaded = tab();
    const opened: string[] = [];
    reloaded.subscribeToVaultOpened((vaultId) => opened.push(vaultId));
    await reloaded.restoreFromDeviceCustody();
    expect([...opened].sort()).toEqual([VAULT_1, VAULT_2]);
  });

  it('persists nothing without the opt-in', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);

    const reloaded = tab();
    await expect(reloaded.restoreFromDeviceCustody()).resolves.toEqual({ unlockedVaultIds: [] });
    expect(await reloaded.stateFor(VAULT_1)).toMatchObject({
      session: 'locked',
      requiredAction: { kind: 'unlock', credential: 'device-password' },
    });
  });

  it('revokes persisted custody on a manual lock', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });
    await expect(custody.read(endpointCustodyId(ACCOUNT_ID))).resolves.not.toBeNull();

    await first.lockDevice();

    await expect(custody.read(endpointCustodyId(ACCOUNT_ID))).resolves.toBeNull();
    expect(isEndpointDeviceLocked(ACCOUNT_ID)).toBe(true);
    const reloaded = tab();
    await expect(reloaded.restoreFromDeviceCustody()).resolves.toEqual({ unlockedVaultIds: [] });
  });

  it('revokes persisted custody on sign-out, through the shared lock signal', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });

    const target = new EventTarget();
    const release = first.bindToVaultLockSignal(target);
    // What `requestVaultLock` dispatches on sign-out.
    target.dispatchEvent(new Event('bettertrack:vault-lock-request'));
    await vi.waitFor(async () =>
      expect(await custody.read(endpointCustodyId(ACCOUNT_ID))).toBeNull(),
    );
    release();

    const reloaded = tab();
    await expect(reloaded.restoreFromDeviceCustody()).resolves.toEqual({ unlockedVaultIds: [] });
  });

  it('revokes persisted custody on the PIN idle lock', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });

    await first.handleIdle(true);

    await expect(custody.read(endpointCustodyId(ACCOUNT_ID))).resolves.toBeNull();
    const reloaded = tab();
    await expect(reloaded.restoreFromDeviceCustody()).resolves.toEqual({ unlockedVaultIds: [] });
  });

  it('leaves an idle lock alone when the account has no PIN lock', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });

    await first.handleIdle(false);

    await expect(custody.read(endpointCustodyId(ACCOUNT_ID))).resolves.not.toBeNull();
  });

  it('refuses to restore while the device-locked marker is set, even with a VALID custody record', async () => {
    // The marker has to be the only thing refusing. Re-persisting junk would
    // make the wrapCheck fail instead and the test would pass with the guard
    // deleted — so this restores the REAL K_dev the endpoint would accept.
    const knownDeviceKey = new Uint8Array(32).fill(0xa7);
    const first = new EndpointVaultKeystore({
      storage,
      custody,
      custodyAccount: () => ACCOUNT_ID,
      argon2: async (_options: DevicePasswordArgon2Options) => knownDeviceKey.slice(),
      randomBytes: deterministicRandom(),
    });
    await seedWrappedVault(first);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });
    const custodyId = endpointCustodyId(ACCOUNT_ID);
    await expect(custody.read(custodyId)).resolves.not.toBeNull();

    // Control: that exact key does open this endpoint.
    const control = new EndpointVaultKeystore({
      storage,
      custody,
      custodyAccount: () => ACCOUNT_ID,
      argon2: async (_options: DevicePasswordArgon2Options) => knownDeviceKey.slice(),
      randomBytes: deterministicRandom(),
    });
    await expect(control.restoreFromDeviceCustody()).resolves.toEqual({
      unlockedVaultIds: [VAULT_1],
    });

    // The belt-and-braces half of the legacy construction: a lock whose
    // IndexedDB delete never landed still fails closed on the marker alone.
    await first.lockDevice();
    await custody.persist(custodyId, knownDeviceKey);
    await expect(custody.read(custodyId)).resolves.not.toBeNull();

    const reloaded = new EndpointVaultKeystore({
      storage,
      custody,
      custodyAccount: () => ACCOUNT_ID,
      argon2: async (_options: DevicePasswordArgon2Options) => knownDeviceKey.slice(),
      randomBytes: deterministicRandom(),
    });
    await expect(reloaded.restoreFromDeviceCustody()).resolves.toEqual({ unlockedVaultIds: [] });
    zeroBytes(knownDeviceKey);
  });

  it('drops custody that no longer matches the endpoint password', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });

    // A reset re-establishes the endpoint under a different device password.
    const custodyId = endpointCustodyId(ACCOUNT_ID);
    const stolen = await custody.read(custodyId);
    expect(stolen).not.toBeNull();
    await first.reset();
    const rebuilt = tab();
    await seedWrappedVault(rebuilt);
    await custody.persist(custodyId, new Uint8Array(32).fill(0x5a));
    localStorage.removeItem(`bettertrack:endpoint-device-locked:${ACCOUNT_ID}`);

    const reloaded = tab();
    await expect(reloaded.restoreFromDeviceCustody()).resolves.toEqual({ unlockedVaultIds: [] });
    await expect(custody.read(custodyId)).resolves.toBeNull();
  });

  it('never persists raw device-key bytes — only a non-extractable AES-GCM CryptoKey', async () => {
    const knownDeviceKey = new Uint8Array(32).fill(0xa7);
    const first = new EndpointVaultKeystore({
      storage,
      custody,
      custodyAccount: () => ACCOUNT_ID,
      argon2: async (_options: DevicePasswordArgon2Options) => knownDeviceKey.slice(),
      randomBytes: deterministicRandom(),
    });
    await seedWrappedVault(first);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });

    const record = await custody.read(endpointCustodyId(ACCOUNT_ID));
    expect(record).not.toBeNull();
    expect(record).toMatchObject({ extractable: false, type: 'secret' });
    expect((record as CryptoKey).algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });

    const surface = await persistentText(CUSTODY_DB);
    expect(surface).not.toContain(encodeBase64Url(knownDeviceKey));
    expect(surface).not.toContain(PASSWORD);
    expect(surface).not.toContain(MNEMONIC);
    const raw = await readAllValues(CUSTODY_DB);
    expect(containsBytes(raw, knownDeviceKey)).toBe(false);
    zeroBytes(knownDeviceKey);
  });

  it('discards an extractable custody record instead of trusting it', async () => {
    const custodyId = endpointCustodyId(ACCOUNT_ID);
    const extractable = await webcrypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(0x11),
      { name: 'AES-GCM' },
      true,
      ['encrypt', 'decrypt'],
    );
    // Touch the custody database so it exists with its schema before the raw write.
    await custody.clear(custodyId);
    await putRaw(CUSTODY_DB, custodyId, extractable);
    await expect(readRaw(CUSTODY_DB, custodyId)).resolves.not.toBeUndefined();

    await expect(custody.read(custodyId)).resolves.toBeNull();
    // …and the junk record is gone, not merely ignored.
    await expect(readRaw(CUSTODY_DB, custodyId)).resolves.toBeUndefined();
  });

  it('leaves the wrong-password lockout ladder exactly as it was', async () => {
    const now = 1_000_000;
    const first = tab({ now: () => now });
    await seedWrappedVault(first);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(
        first.unlock(WRONG_PASSWORD, { keepUnlockedOnThisDevice: true }),
      ).rejects.toMatchObject({ code: 'wrong-password', details: { failures: attempt } });
    }
    await expect(
      first.unlock(WRONG_PASSWORD, { keepUnlockedOnThisDevice: true }),
    ).rejects.toMatchObject({ code: 'locked-out', details: { failures: 5 } });
    expect(await first.stateFor(VAULT_1)).toMatchObject({
      session: 'locked',
      requiredAction: { kind: 'wait-or-reset', retryAt: now + 30_000 },
    });
  });

  it('revokes custody when an unlock attempt fails, as the legacy failUnlock does', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });
    const custodyId = endpointCustodyId(ACCOUNT_ID);
    await expect(custody.read(custodyId)).resolves.not.toBeNull();

    // A LIVE custody record, and then a failed password on this endpoint. The
    // session it proved is already gone (`beginSessionChange`); leaving the
    // record behind would let the next load silently resurrect it.
    const second = tab();
    await expect(second.unlock(WRONG_PASSWORD)).rejects.toMatchObject({
      code: 'wrong-password',
    });

    await expect(custody.read(custodyId)).resolves.toBeNull();
  });

  it('refuses to restore a live custody record while the endpoint is locked out', async () => {
    let now = 2_000_000;
    const first = tab({ now: () => now });
    await seedWrappedVault(first);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });
    const custodyId = endpointCustodyId(ACCOUNT_ID);

    // The E7 step-up ladder reaches a lockout WITHOUT going through `unlock()`,
    // so the custody record is untouched and still valid — the one path where
    // the lockout guard is the only thing standing in the way.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(first.verifyDevicePassword(WRONG_PASSWORD)).rejects.toMatchObject({
        name: 'EndpointKeystoreError',
      });
    }
    await expect(custody.read(custodyId)).resolves.not.toBeNull();

    const duringLockout = tab({ now: () => now });
    await expect(duringLockout.restoreFromDeviceCustody()).resolves.toEqual({
      unlockedVaultIds: [],
    });
    // …and the record survives it: someone else's failed guesses must not
    // destroy the custody its owner opted into.
    await expect(custody.read(custodyId)).resolves.not.toBeNull();

    now += 60_000;
    const afterLockout = tab({ now: () => now });
    await expect(afterLockout.restoreFromDeviceCustody()).resolves.toEqual({
      unlockedVaultIds: [VAULT_1],
    });
  });

  it('has no custody at all without a bound account', async () => {
    const anonymous = new EndpointVaultKeystore({
      storage,
      custody,
      custodyAccount: () => null,
      argon2: fastArgon2(),
      randomBytes: deterministicRandom(),
    });
    await seedWrappedVault(anonymous);
    await expect(
      anonymous.unlock(PASSWORD, { keepUnlockedOnThisDevice: true }),
    ).rejects.toMatchObject({ code: 'custody-unavailable' });
    await expect(custody.read(endpointCustodyId(ACCOUNT_ID))).resolves.toBeNull();
  });

  it('re-persisting is only ever possible from a freshly derived device key', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD, { keepUnlockedOnThisDevice: true });

    const reloaded = tab();
    await reloaded.restoreFromDeviceCustody();
    // A restored CryptoKey cannot be exported, so it can never be written back
    // as a second custody record; the record on disk stays the original one.
    await expect(reloaded.forgetDeviceCustody()).resolves.toBeUndefined();
    await expect(custody.read(endpointCustodyId(ACCOUNT_ID))).resolves.toBeNull();
  });
});

function fastArgon2(): DevicePasswordArgon2 {
  return async (options) => {
    const input = new Uint8Array(options.password.length + options.salt.length);
    input.set(options.password);
    input.set(options.salt, options.password.length);
    const digest = await webcrypto.subtle.digest('SHA-256', input);
    zeroBytes(input);
    return new Uint8Array(digest);
  };
}

function deterministicRandom(): (length: number) => Uint8Array {
  let next = 1;
  return (length) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = next++ % 256;
    return bytes;
  };
}

function verifiedHeaderFetch(expectedVaultId: string): FetchVaultHeaderEnvelope {
  const envelope = createHeaderEnvelope(expectedVaultId);
  return vi.fn(async ({ vaultId }) => {
    if (vaultId !== expectedVaultId) throw new Error('wrong vault requested');
    return (await envelope).slice();
  });
}

async function createHeaderEnvelope(vaultId: string): Promise<Uint8Array> {
  const contentKey = new Uint8Array(32).fill(0x31);
  const wrapKey = await deriveVaultWrapKey(MNEMONIC, vaultId);
  try {
    const keySlot = await wrapContentKey({
      contentKey,
      wrapKey,
      vaultId,
      keyId: KEY_ID,
      randomBytes: deterministicRandom(),
    });
    await deriveKeyFingerprint(contentKey);
    const encrypted = await encryptVaultDoc({
      plaintext: utf8(
        JSON.stringify({
          schemaVersion: VAULT_DOC_SCHEMA_VERSION,
          name: 'TEST VECTOR vault',
          portfolios: [],
          keySlots: [keySlot],
          driveConnection: null,
          created: { at: '2026-08-20T12:00:00.000Z', deviceId: DEVICE_ID },
        }),
      ),
      contentKey,
      header: {
        keyId: KEY_ID,
        keySlots: [keySlot],
        vaultId,
        docId: DOC_ID,
        docKind: 'header',
        accountBinding: await deriveAccountBinding(ACCOUNT_ID),
        docVersion: 1,
        schemaVersion: VAULT_DOC_SCHEMA_VERSION,
        deviceId: DEVICE_ID,
        writeId: WRITE_ID,
        writtenAt: '2026-08-20T12:00:00.000Z',
      },
      randomBytes: deterministicRandom(),
    });
    return encrypted.envelope;
  } finally {
    zeroBytes(contentKey);
    zeroBytes(wrapKey);
  }
}

function deleteDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Deletion of ${databaseName} was blocked.`));
  });
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putRaw(databaseName: string, key: string, value: unknown): Promise<void> {
  const db = await openDatabase(databaseName);
  try {
    const store = db.transaction('keys', 'readwrite').objectStore('keys');
    await new Promise<void>((resolve, reject) => {
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function readRaw(databaseName: string, key: string): Promise<unknown> {
  const db = await openDatabase(databaseName);
  try {
    const store = db.transaction('keys', 'readonly').objectStore('keys');
    return await new Promise<unknown>((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function readAllValues(databaseName: string): Promise<unknown[]> {
  const db = await openDatabase(databaseName);
  try {
    const values: unknown[] = [];
    for (const storeName of [...db.objectStoreNames]) {
      const store = db.transaction(storeName, 'readonly').objectStore(storeName);
      values.push(
        await new Promise<unknown[]>((resolve, reject) => {
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }),
      );
    }
    return values;
  } finally {
    db.close();
  }
}

async function persistentText(databaseName: string): Promise<string> {
  const values = await readAllValues(databaseName);
  const local = Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]);
  const session = Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]);
  return JSON.stringify([values, local, session, document.cookie], replaceBinary);
}

function replaceBinary(_key: string, value: unknown): unknown {
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  if (ArrayBuffer.isView(value)) {
    return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
  }
  return value;
}

function containsBytes(value: unknown, sequence: Uint8Array): boolean {
  if (sequence.length === 0) return false;
  if (value instanceof ArrayBuffer) return bytesContain(new Uint8Array(value), sequence);
  if (ArrayBuffer.isView(value)) {
    return bytesContain(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), sequence);
  }
  if (Array.isArray(value)) return value.some((entry) => containsBytes(entry, sequence));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((entry) => containsBytes(entry, sequence));
  }
  return false;
}

function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    let matched = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}
