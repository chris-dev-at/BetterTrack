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
import { EndpointVaultKeystore } from '../keystore/core';
import type { DevicePasswordArgon2 } from '../keystore/deviceCrypto';
import { endpointVaultKeystore } from '../keystore/runtime';
import {
  createMemoryEndpointSessionPersistence,
  type EndpointSessionPersistence,
} from '../keystore/sessionPersistence';
import {
  createIndexedDbEndpointKeystoreStorage,
  type EndpointKeystoreStorage,
} from '../keystore/storage';
import type { FetchVaultHeaderEnvelope } from '../keystore/types';
import { createVaultTransferRuntime, vaultTransferRuntime } from './runtime';

/**
 * #2013 — the E7 receive path left the receiving device LOCKED.
 *
 * `VaultTransferActions` drives `VaultReceivePhrase` through
 * `vaultTransferRuntime`, whose keystore used to be a private
 * `new EndpointVaultKeystore()` that NOTHING ever `bindAccount()`ed —
 * `runtime.setAccountId()` only moved a runtime-local variable used for Drive
 * addressing and the cross-tab lock signal. With `accountId === null` inside the
 * keystore, `ensureDeviceKey`/`unlock` skip `rememberSession()`, so the device
 * password the user just typed into the receiver established NO §12 session on
 * the device (`docs/paranoid-design.md` §12 as amended 2026-09-03).
 *
 * The observable consequence, reproduced by [E10-A7] against the live stack: the
 * panel said "The transferred vault was verified and saved on this device." and
 * the vault row in the SAME panel still said "Words needed on this device";
 * after a reload it said "Locked on this device" and asked for the password that
 * was just proven.
 *
 * Everything below is the SHIPPED path — the same `storeAfterVerifiedOpen` call
 * `VaultReceivePhrase.save()` makes, on the same runtime the panel mounts.
 */

const VAULT_ID = '018f6a3e-1111-7000-8000-000000000001';
const KEY_ID = '018f6a3e-3333-7000-8000-000000000001';
const DOC_ID = '018f6a3e-2222-7000-8000-000000000001';
const DEVICE_ID = '018f6a3e-4444-7000-8000-000000000001';
const WRITE_ID = '018f6a3e-5555-7000-8000-000000000001';
const ACCOUNT_ID = '018f6a3e-0000-7000-8000-00000000aaaa';
const OTHER_ACCOUNT_ID = '018f6a3e-0000-7000-8000-00000000bbbb';
const PASSWORD = 'endpoint password secret';

/** Public BIP39 TEST VECTOR: 128 zero entropy bits, never production material. */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const KEYSTORE_DB = 'bettertrack-receive-session-test-keystore';

let storage: EndpointKeystoreStorage;

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  localStorage.clear();
  storage = createIndexedDbEndpointKeystoreStorage({ databaseName: KEYSTORE_DB });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteDatabase(KEYSTORE_DB);
});

describe('#2013 — receiving a phrase must leave a §12 device session', () => {
  it('binds the receive keystore to the account, so the receiver session is the ENDPOINT session', () => {
    const keystore = newKeystore(createMemoryEndpointSessionPersistence());
    const runtime = createVaultTransferRuntime({ keystore, bindLockSignal: false });

    runtime.setAccountId(ACCOUNT_ID);

    // RED before #2013: the runtime kept the id to itself and the keystore
    // stayed account-less, which is what silently disabled every §12 session
    // edge.
    expect(keystore.boundAccountId()).toBe(ACCOUNT_ID);
  });

  it('a received phrase survives the reload the receiver navigates into', async () => {
    const persistence = createMemoryEndpointSessionPersistence();
    const keystore = newKeystore(persistence);
    const runtime = createVaultTransferRuntime({ keystore, bindLockSignal: false });
    runtime.setAccountId(ACCOUNT_ID);

    // The receive itself — `VaultReceivePhrase.save()`, wrapped custody branch.
    const opened = await runtime.keystore.storeAfterVerifiedOpen({
      vaultId: VAULT_ID,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_ID),
    });
    runtime.registerOpenedVault(opened);
    expect(runtime.isVaultOpen(VAULT_ID)).toBe(true);

    // A device session was proven by a password, so §12 says it belongs to the
    // DEVICE and outlives the page load. RED before #2013: nothing persisted.
    await flushMicrotasks();
    expect(persistence.size(), 'the receive must leave a §12 device session').toBe(1);

    // The reload the receiver walks into (the manager re-reads on
    // `/control/privacy`): a fresh keystore, no sibling tab, same device.
    const reloaded = newKeystore(persistence);
    reloaded.bindAccount(ACCOUNT_ID);
    await expect(reloaded.resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [VAULT_ID],
    });
    expect(await reloaded.stateFor(VAULT_ID)).toMatchObject({
      status: 'stored+wrapped',
      session: 'unlocked',
    });
  });

  /**
   * The other half of the binding: what binds must also UNBIND.
   *
   * Sign-out and an account switch both arrive at `setAccountId`, and §12 makes
   * both a revocation — "a session ends at … sign-out, an account switch on the
   * same profile". Binding without this is worse than not binding at all: it
   * would leave a session the receiver established standing under the NEXT
   * account's id, and leave the previous account's device-session record on
   * disk for the next sign-in to resume from without any password.
   */
  it.each([
    ['sign-out', null],
    ['an account switch', OTHER_ACCOUNT_ID],
  ])(
    '%s revokes the session the receiver established and drops its device record',
    async (_name, nextAccountId) => {
      const persistence = createMemoryEndpointSessionPersistence();
      const keystore = newKeystore(persistence);
      const runtime = createVaultTransferRuntime({ keystore, bindLockSignal: false });
      runtime.setAccountId(ACCOUNT_ID);

      const opened = await runtime.keystore.storeAfterVerifiedOpen({
        vaultId: VAULT_ID,
        mnemonic: MNEMONIC,
        devicePassword: PASSWORD,
        fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_ID),
      });
      runtime.registerOpenedVault(opened);
      await flushMicrotasks();
      expect(persistence.size()).toBe(1);

      runtime.setAccountId(nextAccountId as string | null);

      expect(keystore.boundAccountId()).toBe(nextAccountId);
      expect(runtime.isVaultOpen(VAULT_ID), 'the receipt cannot outlive its account').toBe(false);
      expect(await keystore.stateFor(VAULT_ID)).toMatchObject({
        status: 'stored+wrapped',
        session: 'locked',
      });
      await flushMicrotasks();
      expect(persistence.size(), 'the previous account’s §12 record goes with it').toBe(0);
    },
  );

  /**
   * The shape decision (#2013): ONE endpoint keystore, not two bound ones.
   *
   * §12 scopes a session to the DEVICE and `keystore/runtime.ts` holds "one
   * endpoint-scoped E3 keystore shared by the directory, chip and stubs". Two
   * instances in one tab over one IndexedDB would be two §12 session holders on
   * one endpoint: two participants on the account's BroadcastChannel, two
   * `sessionRevision` trackers and two writers of the single persistence
   * record. Identity is the only assertion that makes them unable to disagree
   * about the device-locked marker, the session or that record.
   */
  it('mounts the ONE endpoint keystore the manager, chip and stubs read', () => {
    expect(vaultTransferRuntime.keystore).toBe(endpointVaultKeystore);
  });
});

function newKeystore(persistence: EndpointSessionPersistence): EndpointVaultKeystore {
  return new EndpointVaultKeystore({
    storage,
    argon2: fastArgon2(),
    randomBytes: deterministicRandom(),
    sessionPersistence: persistence,
    createSessionTransport: () => null,
  });
}

/**
 * `rememberSession`/`forgetPersistedSession` are fire-and-forget by design (§12:
 * persistence may never delay or fail an unlock), so the assertion has to let
 * their microtask chain run instead of racing it.
 */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

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
