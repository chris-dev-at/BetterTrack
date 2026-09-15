import { webcrypto } from 'node:crypto';

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VAULT_DOC_SCHEMA_VERSION, inspectVaultDocEnvelope } from '@bettertrack/contracts';

import { utf8, zeroBytes } from '../bytes';
import { mnemonicToEntropy } from '../bip39/mnemonic';
import { encryptVaultDoc } from '../keys/documents';
import {
  deriveAccountBinding,
  deriveKeyFingerprint,
  deriveVaultWrapKey,
  wrapContentKey,
} from '../keys/keyCore';
import { createVaultTransferQrSource } from '../qr/senderSource';
import { acknowledgePlainCustodyRisk } from './acknowledgment';
import { EndpointVaultKeystore, lockoutDelayMs } from './core';
import { NO_ENDPOINT_SESSION_PERSISTENCE } from './sessionPersistence';
import type { DevicePasswordArgon2, DevicePasswordArgon2Options } from './deviceCrypto';
import { encodeBase64Url } from './encoding';
import {
  ENDPOINT_KEYSTORE_CONTROL_STORE,
  ENDPOINT_KEYSTORE_METADATA_STORE,
  ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE,
  createIndexedDbEndpointKeystoreStorage,
  type EndpointKeystoreStorage,
} from './storage';
import type { FetchVaultHeaderEnvelope, PlainCustodyAcknowledgmentToken } from './types';

const VAULT_1 = '018f6a3e-1111-7000-8000-000000000001';
const VAULT_2 = '018f6a3e-1111-7000-8000-000000000002';
const VAULT_3 = '018f6a3e-1111-7000-8000-000000000003';
const KEY_ID = '018f6a3e-3333-7000-8000-000000000001';
const DOC_ID = '018f6a3e-2222-7000-8000-000000000001';
const DEVICE_ID = '018f6a3e-4444-7000-8000-000000000001';
const WRITE_ID = '018f6a3e-5555-7000-8000-000000000001';
const PASSWORD = 'endpoint password secret';
const WRONG_PASSWORD = 'definitely wrong password';

/** Public BIP39 TEST VECTOR: 128 zero entropy bits, never production key material. */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** Public BIP39 TEST VECTOR: checksum-valid but intentionally for the wrong vault. */
const OTHER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

class MemoryEndpointStorage implements EndpointKeystoreStorage {
  revision = 0;
  metadata: unknown | null = null;
  readonly entries = new Map<string, unknown>();

  async readEndpointSnapshot(): Promise<{ revision: number; metadata: unknown | null }> {
    return { revision: this.revision, metadata: clone(this.metadata) };
  }

  async initializeMetadata(expectedRevision: number, value: unknown) {
    if (expectedRevision !== this.revision) {
      return { status: 'stale' as const, revision: this.revision };
    }
    if (this.metadata != null) {
      return { status: 'exists' as const, revision: this.revision };
    }
    this.metadata = clone(value);
    this.revision += 1;
    return { status: 'created' as const, revision: this.revision };
  }

  async updateMetadata<T>(
    expectedRevision: number,
    updater: (current: unknown | null) => { value: unknown; result: T },
  ) {
    if (expectedRevision !== this.revision) {
      return { status: 'stale' as const, revision: this.revision };
    }
    const update = updater(clone(this.metadata));
    this.metadata = clone(update.value);
    this.revision += 1;
    return { status: 'updated' as const, revision: this.revision, result: update.result };
  }

  async readEntry(vaultId: string): Promise<unknown | null> {
    return clone(this.entries.get(vaultId) ?? null);
  }

  async listEntries(expectedRevision: number) {
    if (expectedRevision !== this.revision) {
      return { status: 'stale' as const, revision: this.revision };
    }
    return {
      status: 'current' as const,
      revision: this.revision,
      entries: [...this.entries].map(([vaultId, value]) => ({ vaultId, value: clone(value) })),
    };
  }

  async writeEntry(expectedRevision: number, vaultId: string, value: unknown) {
    if (expectedRevision !== this.revision) {
      return { status: 'stale' as const, revision: this.revision };
    }
    this.entries.set(vaultId, clone(value));
    this.revision += 1;
    return { status: 'written' as const, revision: this.revision };
  }

  async deleteEntry(expectedRevision: number, vaultId: string) {
    if (expectedRevision !== this.revision) {
      return { status: 'stale' as const, revision: this.revision };
    }
    this.entries.delete(vaultId);
    this.revision += 1;
    return { status: 'deleted' as const, revision: this.revision };
  }

  async reset(): Promise<{ revision: number }> {
    this.metadata = null;
    this.entries.clear();
    this.revision += 1;
    return { revision: this.revision };
  }
}

class AfterWriteStorage extends MemoryEndpointStorage {
  afterWrite: (() => void) | undefined;

  override async writeEntry(expectedRevision: number, vaultId: string, value: unknown) {
    const result = await super.writeEntry(expectedRevision, vaultId, value);
    if (result.status === 'written') this.afterWrite?.();
    return result;
  }
}

interface CapturedArgon2Call {
  iterations: number;
  parallelism: number;
  memorySize: number;
  hashLength: number;
  outputType: 'binary';
}

function fastArgon2(calls: CapturedArgon2Call[] = []): DevicePasswordArgon2 {
  return async (options) => {
    calls.push({
      iterations: options.iterations,
      parallelism: options.parallelism,
      memorySize: options.memorySize,
      hashLength: options.hashLength,
      outputType: options.outputType,
    });
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

function verifiedHeaderFetch(
  expectedVaultId: string,
  expectedMnemonic = MNEMONIC,
  contentByte = 0x31,
): FetchVaultHeaderEnvelope {
  const envelope = createHeaderEnvelope(expectedVaultId, expectedMnemonic, contentByte);
  return vi.fn(async ({ vaultId }) => {
    if (vaultId !== expectedVaultId) throw new Error('wrong vault requested');
    return (await envelope).slice();
  });
}

async function createHeaderEnvelope(
  vaultId: string,
  mnemonic: string,
  contentByte: number,
): Promise<Uint8Array> {
  const contentKey = new Uint8Array(32).fill(contentByte);
  const wrapKey = await deriveVaultWrapKey(mnemonic, vaultId);
  try {
    const keySlot = await wrapContentKey({
      contentKey,
      wrapKey,
      vaultId,
      keyId: KEY_ID,
      randomBytes: deterministicRandom(),
    });
    const keyFingerprint = await deriveKeyFingerprint(contentKey);
    const document = {
      schemaVersion: VAULT_DOC_SCHEMA_VERSION,
      name: 'TEST VECTOR vault',
      portfolios: [],
      keySlots: [keySlot],
      driveConnection: null,
      created: { at: '2026-08-20T12:00:00.000Z', deviceId: DEVICE_ID },
    };
    const encrypted = await encryptVaultDoc({
      plaintext: utf8(JSON.stringify(document)),
      contentKey,
      header: {
        keyId: KEY_ID,
        keySlots: [keySlot],
        vaultId,
        docId: DOC_ID,
        docKind: 'header',
        accountBinding: await deriveAccountBinding('018f6a3e-0000-7000-8000-00000000aaaa'),
        docVersion: 1,
        schemaVersion: VAULT_DOC_SCHEMA_VERSION,
        deviceId: DEVICE_ID,
        writeId: WRITE_ID,
        writtenAt: '2026-08-20T12:00:00.000Z',
      },
      randomBytes: deterministicRandom(),
    });
    expect(keyFingerprint).toHaveLength(16);
    return encrypted.envelope;
  } finally {
    zeroBytes(contentKey);
    zeroBytes(wrapKey);
  }
}

function keystore(
  storage: EndpointKeystoreStorage,
  options: { argon2?: DevicePasswordArgon2; now?: () => number } = {},
): EndpointVaultKeystore {
  return new EndpointVaultKeystore({
    storage,
    argon2: options.argon2 ?? fastArgon2(),
    randomBytes: deterministicRandom(),
    now: options.now,
    // This suite pins the keystore itself; the device-side session record has
    // its own suite in `sessionSharing.test.ts` (P1–P7).
    sessionPersistence: NO_ENDPOINT_SESSION_PERSISTENCE,
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'keystore-test=; Max-Age=0; path=/';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('endpoint keystore custody and verified persistence', () => {
  it('notifies and detaches synchronous session-end listeners', () => {
    const core = keystore(new MemoryEndpointStorage());
    const listener = vi.fn();
    const unsubscribe = core.subscribeToSessionEnd(listener);

    core.endSession();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    core.endSession();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  /**
   * The opposite edge (#1416). Session-end fires when an unlock BEGINS, so a
   * surface that only listened there would tear its session down and never
   * learn that the vault it needs has since been opened.
   */
  it('notifies and detaches vault-opened listeners, and survives one that throws', async () => {
    const core = keystore(new MemoryEndpointStorage());
    const opened = vi.fn();
    const throwing = vi.fn(() => {
      throw new Error('a broken surface must not fail a completed unlock');
    });
    core.subscribeToVaultOpened(throwing);
    const unsubscribe = core.subscribeToVaultOpened(opened);

    await core.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });

    expect(opened).toHaveBeenCalled();
    expect(throwing).toHaveBeenCalled();
    // The unlock itself completed regardless of the throwing listener.
    expect(await core.stateFor(VAULT_1)).toMatchObject({ session: 'unlocked' });

    const beforeUnsubscribe = opened.mock.calls.length;
    unsubscribe();
    core.endSession();
    await core.unlock(PASSWORD);
    await core.openStoredVault(VAULT_1, verifiedHeaderFetch(VAULT_1));
    expect(opened).toHaveBeenCalledTimes(beforeUnsubscribe);
    expect(throwing.mock.calls.length).toBeGreaterThan(beforeUnsubscribe);
  });

  /**
   * The id the edge has to carry (#1533). A surface that re-reads on every open
   * has to tell one vault's open from another's: without it, two vaults
   * unlocked in quick succession are one indistinguishable ping, and the
   * portfolio store registry dropped the second one's edge. It stays a "re-ask
   * me about THAT vault" signal — an id, never key material — and the no-op
   * re-open path stays silent (#1531), so a listener that reacts by re-reading
   * cannot trigger its own next notification.
   */
  it('names the vault that opened and stays silent on a no-op re-open', async () => {
    const core = keystore(new MemoryEndpointStorage());
    const opened = vi.fn();
    core.subscribeToVaultOpened(opened);

    await core.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });
    expect(opened.mock.calls).toEqual([[VAULT_1]]);

    await core.storeAfterVerifiedOpen({
      vaultId: VAULT_2,
      mnemonic: MNEMONIC,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_2),
    });
    expect(opened.mock.calls).toEqual([[VAULT_1], [VAULT_2]]);

    await core.openStoredVault(VAULT_1, verifiedHeaderFetch(VAULT_1));
    expect(opened.mock.calls).toEqual([[VAULT_1], [VAULT_2]]);
  });

  /**
   * THE CACHE-REUSE PREDICATE, PINNED (#1531 F3).
   *
   * `cacheVerifiedOpen` reuses the cached entry only when the re-open proved
   * EXACTLY the same key (same keyId, same fingerprint, same bytes). Both
   * halves of that decision are load-bearing and neither had a test: the whole
   * suite stayed green both when the reuse was removed (every re-open cancels
   * live borrows) and when it was made unconditional (a genuinely different key
   * silently keeps serving the old one). The two cases below are those two
   * mutations, one each.
   *
   * The byte comparison itself is deliberately NOT probed in isolation: reaching
   * it with a matching keyId and a matching fingerprint but different bytes
   * means a SHA-256 collision, so it is defense in depth against a future
   * fingerprint change, not a reachable state to test.
   */
  it('keeps a live borrow alive when the same vault is re-opened under the same key', async () => {
    const core = keystore(new MemoryEndpointStorage());
    await core.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });

    // Two independent readers of one vault is ordinary now (a §9 move capture
    // beside a resolved portfolio store), and the second one's re-open used to
    // end the first one's operation mid-flight.
    let borrowStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      borrowStarted = resolve;
    });
    let releaseBorrow!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBorrow = resolve;
    });
    const borrow = core.withContentKey(
      VAULT_1,
      async (contentKey, _keyId, assertSessionCurrent) => {
        borrowStarted();
        await gate;
        // The identity check `withContentKey` proves its session with: a replaced
        // cache entry fails here even though nothing was locked.
        assertSessionCurrent();
        expect(contentKey).toEqual(new Uint8Array(32).fill(0x31));
        return 'survived';
      },
    );
    await started;

    await core.openStoredVault(VAULT_1, verifiedHeaderFetch(VAULT_1));
    releaseBorrow();

    await expect(borrow).resolves.toBe('survived');
  });

  it('replaces the cached key when a re-open proves a different one, and kills the old borrow', async () => {
    const core = keystore(new MemoryEndpointStorage());
    await core.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });

    let borrowStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      borrowStarted = resolve;
    });
    let releaseBorrow!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBorrow = resolve;
    });
    const stale = core.withContentKey(
      VAULT_1,
      async (_contentKey, _keyId, assertSessionCurrent) => {
        borrowStarted();
        await gate;
        assertSessionCurrent();
        return 'must not survive a key change';
      },
    );
    await started;

    // A rekey: the same vault, authenticated by the same words, but the header
    // now carries a DIFFERENT content key (and therefore a different
    // fingerprint). Reuse here would be silent key confusion — the caller is
    // handed the retired key while the receipt names the new one.
    const rekeyed = await core.openStoredVault(
      VAULT_1,
      verifiedHeaderFetch(VAULT_1, MNEMONIC, 0x32),
    );
    releaseBorrow();

    await expect(stale).rejects.toMatchObject({ code: 'session-ended' });
    await expect(
      core.withContentKey(VAULT_1, (contentKey, keyId) => {
        expect(contentKey).toEqual(new Uint8Array(32).fill(0x32));
        expect(keyId).toBe(rekeyed.keyId);
        return 'reads the new key';
      }),
    ).resolves.toBe('reads the new key');
  });

  it('defaults to wrapped custody and one password unlocks all phrases on one endpoint only', async () => {
    const firstStorage = new MemoryEndpointStorage();
    const secondStorage = new MemoryEndpointStorage();
    const calls: CapturedArgon2Call[] = [];
    const first = keystore(firstStorage, { argon2: fastArgon2(calls) });
    const second = keystore(secondStorage);

    await first.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });
    await first.storeAfterVerifiedOpen({
      vaultId: VAULT_2,
      mnemonic: MNEMONIC,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_2),
    });
    await first.storeAfterVerifiedOpen({
      vaultId: VAULT_3,
      mnemonic: MNEMONIC,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_3),
    });

    expect((await firstStorage.readEntry(VAULT_1)) as { custody: string }).toMatchObject({
      custody: 'wrapped',
    });
    expect(await first.stateFor(VAULT_1)).toMatchObject({
      status: 'stored+wrapped',
      session: 'unlocked',
      requiredAction: { kind: 'open-silently' },
    });
    expect(await second.stateFor(VAULT_1)).toMatchObject({
      status: 'not-on-this-endpoint',
      requiredAction: { kind: 'provide-phrase' },
    });
    expect(calls[0]).toEqual({
      iterations: 3,
      parallelism: 1,
      memorySize: 65_536,
      hashLength: 32,
      outputType: 'binary',
    });

    first.endSession();
    await expect(first.readMnemonic(VAULT_1)).rejects.toMatchObject({ code: 'phrase-locked' });
    await expect(first.unlock(PASSWORD)).resolves.toEqual({
      unlockedVaultIds: [VAULT_1, VAULT_2, VAULT_3],
    });
    await expect(first.readMnemonic(VAULT_1)).resolves.toBe(MNEMONIC);
    await expect(first.readMnemonic(VAULT_2)).resolves.toBe(MNEMONIC);
    await expect(first.readMnemonic(VAULT_3)).resolves.toBe(MNEMONIC);
    expect(secondStorage.entries.size).toBe(0);
  });

  it('requires a one-use, vault-scoped acknowledgment for plain custody and re-wraps on password entry', async () => {
    const storage = new MemoryEndpointStorage();
    const core = keystore(storage);
    const forged = {} as PlainCustodyAcknowledgmentToken;
    const input = {
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    };

    await expect(
      core.storePlainAfterVerifiedOpen({ ...input, acknowledgment: forged }),
    ).rejects.toMatchObject({ code: 'acknowledgment-required' });
    expect(await storage.readEntry(VAULT_1)).toBeNull();

    const acknowledgment = acknowledgePlainCustodyRisk(VAULT_1);
    await core.storePlainAfterVerifiedOpen({ ...input, acknowledgment });
    expect(await core.stateFor(VAULT_1)).toEqual({
      status: 'stored+plain',
      requiredAction: { kind: 'open-silently' },
    });
    core.endSession();
    await expect(core.readMnemonic(VAULT_1)).resolves.toBe(MNEMONIC);
    await expect(
      core.storePlainAfterVerifiedOpen({ ...input, acknowledgment }),
    ).rejects.toMatchObject({ code: 'acknowledgment-required' });

    await core.switchToWrapped(VAULT_1, PASSWORD);
    expect(await core.stateFor(VAULT_1)).toMatchObject({
      status: 'stored+wrapped',
      session: 'unlocked',
    });
    core.endSession();
    await expect(core.readMnemonic(VAULT_1)).rejects.toMatchObject({ code: 'phrase-locked' });
    await core.unlock(PASSWORD);
    await core.switchToPlain(VAULT_1, acknowledgePlainCustodyRisk(VAULT_1));
    expect((await storage.readEntry(VAULT_1)) as { custody: string }).toMatchObject({
      custody: 'plain',
    });
  });

  it('derives transfer reveal custody from the current real keystore entry', async () => {
    const storage = new MemoryEndpointStorage();
    const core = keystore(storage);
    await core.storePlainAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      acknowledgment: acknowledgePlainCustodyRisk(VAULT_1),
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });
    const source = createVaultTransferQrSource({ keystore: core, vaultId: VAULT_1 });

    await expect(source.requireLiveUnlock()).resolves.toBe('plain');
    await core.switchToWrapped(VAULT_1, PASSWORD);
    await expect(source.requireLiveUnlock()).resolves.toBe('wrapped');
  });

  it('re-verifies the device password without dropping the live E7 content-key session', async () => {
    const storage = new MemoryEndpointStorage();
    const core = keystore(storage);
    await core.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });

    await expect(core.verifyDevicePassword(PASSWORD)).resolves.toBeUndefined();
    await expect(core.withContentKey(VAULT_1, () => 'still-open')).resolves.toBe('still-open');
    await expect(core.verifyDevicePassword(WRONG_PASSWORD)).rejects.toMatchObject({
      code: 'wrong-password',
      details: { failures: 1 },
    });
    await expect(core.withContentKey(VAULT_1, () => 'preserved')).resolves.toBe('preserved');
    await expect(core.verifyDevicePassword(PASSWORD)).resolves.toBeUndefined();
    expect((await storage.readEndpointSnapshot()).metadata).toMatchObject({
      lockout: { failures: 0, lockedUntil: null },
    });
  });

  it('never writes a checksum-valid but non-opening phrase before verified open succeeds', async () => {
    const storage = new MemoryEndpointStorage();
    const core = keystore(storage);

    await expect(
      core.storeAfterVerifiedOpen({
        vaultId: VAULT_1,
        mnemonic: OTHER_MNEMONIC,
        devicePassword: PASSWORD,
        fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
      }),
    ).rejects.toMatchObject({ code: 'verification-failed' });
    expect((await storage.readEndpointSnapshot()).metadata).toBeNull();
    expect(await storage.readEntry(VAULT_1)).toBeNull();
  });

  it('classifies an unavailable header separately from a rejected phrase and never writes', async () => {
    const storage = new MemoryEndpointStorage();
    const core = keystore(storage);

    await expect(
      core.storeAfterVerifiedOpen({
        vaultId: VAULT_1,
        mnemonic: MNEMONIC,
        devicePassword: PASSWORD,
        fetchHeaderEnvelope: async () => {
          throw new Error('offline');
        },
      }),
    ).rejects.toMatchObject({ code: 'vault-header-unavailable' });
    expect((await storage.readEndpointSnapshot()).metadata).toBeNull();
    expect(await storage.readEntry(VAULT_1)).toBeNull();
  });

  it('synchronously wipes unlocked K_c and requires another password after every session boundary', async () => {
    const storage = new MemoryEndpointStorage();
    const core = keystore(storage);
    await core.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });
    let borrowed: Uint8Array | undefined;
    await core.withContentKey(VAULT_1, (contentKey) => {
      expect(contentKey).toEqual(new Uint8Array(32).fill(0x31));
      borrowed = contentKey;
    });
    expect(borrowed).toEqual(new Uint8Array(32));

    const target = new EventTarget();
    const unbind = core.bindToVaultLockSignal(target);
    target.dispatchEvent(new Event('bettertrack:vault-lock-request'));
    expect(borrowed).toEqual(new Uint8Array(32));
    await expect(core.withContentKey(VAULT_1, () => undefined)).rejects.toMatchObject({
      code: 'phrase-locked',
    });
    await expect(core.readMnemonic(VAULT_1)).rejects.toMatchObject({ code: 'phrase-locked' });
    unbind();

    await core.unlock(PASSWORD);
    core.handleIdle(false);
    await expect(core.readMnemonic(VAULT_1)).resolves.toBe(MNEMONIC);
    core.handleIdle(true);
    await expect(core.readMnemonic(VAULT_1)).rejects.toMatchObject({ code: 'phrase-locked' });
  });

  it('invalidates an in-flight password derivation when the session ends', async () => {
    const storage = new MemoryEndpointStorage();
    const fixedDeviceKey = new Uint8Array(32).fill(0x91);
    const initial = keystore(storage, {
      argon2: async () => fixedDeviceKey.slice(),
    });
    await initial.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });
    initial.endSession();

    let resolveDerivation!: (value: Uint8Array) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const reopened = keystore(storage, {
      argon2: async () => {
        signalStarted();
        return new Promise<Uint8Array>((resolve) => {
          resolveDerivation = resolve;
        });
      },
    });

    const unlocking = reopened.unlock(PASSWORD);
    await started;
    reopened.endSession();
    resolveDerivation(fixedDeviceKey.slice());

    await expect(unlocking).rejects.toMatchObject({ code: 'session-ended' });
    expect(await reopened.stateFor(VAULT_1)).toMatchObject({
      status: 'stored+wrapped',
      session: 'locked',
      requiredAction: { kind: 'unlock' },
    });
  });

  it('zeros an active borrowed K_c before synchronously notifying session listeners', async () => {
    const storage = new MemoryEndpointStorage();
    const core = keystore(storage);
    await core.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });
    const started = deferred<void>();
    const release = deferred<void>();
    let borrowed: Uint8Array | undefined;
    const operation = core.withContentKey(VAULT_1, async (contentKey) => {
      borrowed = contentKey;
      started.resolve();
      await release.promise;
    });
    await started.promise;
    expect(borrowed).toEqual(new Uint8Array(32).fill(0x31));
    const sessionEnded = vi.fn(() => {
      expect(borrowed).toEqual(new Uint8Array(32));
    });
    const unsubscribe = core.subscribeToSessionEnd(sessionEnded);

    core.endSession();
    expect(borrowed).toEqual(new Uint8Array(32));
    expect(sessionEnded).toHaveBeenCalledTimes(1);
    unsubscribe();
    release.resolve();
    await expect(operation).rejects.toMatchObject({ code: 'session-ended' });
  });

  it('rejects encryption under a borrowed K_c wiped during an async callback', async () => {
    const storage = new MemoryEndpointStorage();
    const core = keystore(storage);
    await core.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });
    const sourceEnvelope = await createHeaderEnvelope(VAULT_1, MNEMONIC, 0x31);
    const inspected = inspectVaultDocEnvelope(sourceEnvelope);
    if (inspected.status === 'update-required') throw new Error('unexpected future envelope');
    const header = {
      keyId: inspected.header.keyId,
      keySlots: inspected.header.keySlots,
      vaultId: inspected.header.vaultId,
      docId: inspected.header.docId,
      docKind: inspected.header.docKind,
      accountBinding: inspected.header.accountBinding,
      docVersion: inspected.header.docVersion + 1,
      schemaVersion: inspected.header.schemaVersion,
      deviceId: inspected.header.deviceId,
      writeId: inspected.header.writeId,
      writtenAt: inspected.header.writtenAt,
    };
    const started = deferred<void>();
    const release = deferred<void>();
    const randomBytes = vi.fn(deterministicRandom());
    const plaintext = utf8('stale borrowed K_c probe');
    let borrowed: Uint8Array | undefined;
    let producedEnvelope: Uint8Array | undefined;
    const operation = core.withContentKey(VAULT_1, async (contentKey) => {
      borrowed = contentKey;
      started.resolve();
      await release.promise;
      const encrypted = await encryptVaultDoc({
        plaintext,
        contentKey,
        header,
        randomBytes,
      });
      producedEnvelope = encrypted.envelope;
    });
    await started.promise;

    core.endSession();
    expect(borrowed).toEqual(new Uint8Array(32));
    release.resolve();
    await expect(operation).rejects.toMatchObject({
      name: 'VaultKeyCoreError',
      code: 'invalid-key-material',
    });
    expect(randomBytes).not.toHaveBeenCalled();
    expect(producedEnvelope).toBeUndefined();
    zeroBytes(plaintext);
    zeroBytes(sourceEnvelope);
  });

  it('scopes plain-custody acknowledgments to one vault and one live session', async () => {
    const storage = new MemoryEndpointStorage();
    const core = keystore(storage);
    const wrongVault = acknowledgePlainCustodyRisk(VAULT_1);

    await expect(
      core.storePlainAfterVerifiedOpen({
        vaultId: VAULT_2,
        mnemonic: MNEMONIC,
        acknowledgment: wrongVault,
        fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_2),
      }),
    ).rejects.toMatchObject({ code: 'acknowledgment-required' });

    const expired = acknowledgePlainCustodyRisk(VAULT_1);
    core.endSession();
    await expect(
      core.storePlainAfterVerifiedOpen({
        vaultId: VAULT_1,
        mnemonic: MNEMONIC,
        acknowledgment: expired,
        fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
      }),
    ).rejects.toMatchObject({ code: 'acknowledgment-required' });
    expect(storage.entries.size).toBe(0);
  });

  it('fails closed when a store or open finishes after a session boundary', async () => {
    const storage = new MemoryEndpointStorage();
    const core = keystore(storage);
    const firstEnvelope = await createHeaderEnvelope(VAULT_1, MNEMONIC, 0x31);
    const storingFetch = deferred<Uint8Array>();
    const storingStarted = deferred<void>();
    const storing = core.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: async () => {
        storingStarted.resolve();
        return storingFetch.promise;
      },
    });
    await storingStarted.promise;
    core.endSession();
    storingFetch.resolve(firstEnvelope.slice());
    await expect(storing).rejects.toMatchObject({ code: 'session-ended' });
    expect(await storage.readEntry(VAULT_1)).toBeNull();
    expect((await storage.readEndpointSnapshot()).metadata).toBeNull();

    await core.storePlainAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      acknowledgment: acknowledgePlainCustodyRisk(VAULT_1),
      fetchHeaderEnvelope: async () => firstEnvelope.slice(),
    });
    core.endSession();
    const openingFetch = deferred<Uint8Array>();
    const openingStarted = deferred<void>();
    const opening = core.openStoredVault(VAULT_1, async () => {
      openingStarted.resolve();
      return openingFetch.promise;
    });
    await openingStarted.promise;
    core.endSession();
    openingFetch.resolve(firstEnvelope.slice());
    await expect(opening).rejects.toMatchObject({ code: 'session-ended' });
    await expect(core.withContentKey(VAULT_1, () => undefined)).rejects.toMatchObject({
      code: 'phrase-locked',
    });
  });

  it('does not restore a phrase when reset wins an in-flight verified store', async () => {
    const storage = new MemoryEndpointStorage();
    const core = keystore(storage);
    const envelope = await createHeaderEnvelope(VAULT_1, MNEMONIC, 0x31);
    const pendingFetch = deferred<Uint8Array>();
    const storingStarted = deferred<void>();
    const storing = core.storePlainAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      acknowledgment: acknowledgePlainCustodyRisk(VAULT_1),
      fetchHeaderEnvelope: async () => {
        storingStarted.resolve();
        return pendingFetch.promise;
      },
    });

    await storingStarted.promise;
    await core.reset();
    pendingFetch.resolve(envelope);
    await expect(storing).rejects.toMatchObject({ code: 'session-ended' });
    expect(await storage.readEntry(VAULT_1)).toBeNull();
  });

  it('zeros the Argon2-owned output after taking an internal device-key copy', async () => {
    const storage = new MemoryEndpointStorage();
    let argonOutput: Uint8Array | undefined;
    const core = keystore(storage, {
      argon2: async () => {
        argonOutput = new Uint8Array(32).fill(0x77);
        return argonOutput;
      },
    });
    await core.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });
    expect(argonOutput).toEqual(new Uint8Array(32));
  });

  it('treats a custody write as committed when a lock races after the atomic write', async () => {
    const storage = new AfterWriteStorage();
    const core = keystore(storage);
    await core.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });
    storage.afterWrite = () => core.endSession();

    await expect(
      core.switchToPlain(VAULT_1, acknowledgePlainCustodyRisk(VAULT_1)),
    ).resolves.toBeUndefined();
    expect(await storage.readEntry(VAULT_1)).toMatchObject({ custody: 'plain' });
    await expect(core.withContentKey(VAULT_1, () => undefined)).rejects.toMatchObject({
      code: 'phrase-locked',
    });
  });
});

describe('device-password lockout and reset', () => {
  it('starts at five failures, doubles to 5 minutes, resets on success, and never fetches', async () => {
    const storage = new MemoryEndpointStorage();
    let now = 1_700_000_000_000;
    const core = keystore(storage, { now: () => now });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must stay local'));
    await core.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });
    core.endSession();

    for (let failure = 1; failure <= 4; failure += 1) {
      await expect(core.unlock(WRONG_PASSWORD)).rejects.toMatchObject({
        code: 'wrong-password',
        details: { failures: failure },
      });
    }
    await expect(core.unlock(WRONG_PASSWORD)).rejects.toMatchObject({
      code: 'locked-out',
      details: { failures: 5, retryAt: now + 30_000 },
    });
    await expect(core.unlock(PASSWORD)).rejects.toMatchObject({
      code: 'locked-out',
      details: { failures: 5, retryAt: now + 30_000 },
    });

    for (const [failure, delay] of [
      [6, 60_000],
      [7, 120_000],
      [8, 240_000],
      [9, 300_000],
      [10, 300_000],
    ] as const) {
      now += lockoutDelayMs(failure - 1);
      await expect(core.unlock(WRONG_PASSWORD)).rejects.toMatchObject({
        code: 'locked-out',
        details: { failures: failure, retryAt: now + delay },
      });
    }

    now += 300_000;
    await expect(core.unlock(PASSWORD)).resolves.toEqual({ unlockedVaultIds: [VAULT_1] });
    core.endSession();
    await expect(core.unlock(WRONG_PASSWORD)).rejects.toMatchObject({
      code: 'wrong-password',
      details: { failures: 1 },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resets only local custody and re-entering the words restores the untouched vault', async () => {
    const firstStorage = new MemoryEndpointStorage();
    const secondStorage = new MemoryEndpointStorage();
    const first = keystore(firstStorage);
    const second = keystore(secondStorage);
    const remoteEnvelope = await createHeaderEnvelope(VAULT_1, MNEMONIC, 0x31);
    const originalRemoteEnvelope = remoteEnvelope.slice();
    const remoteFetch = vi.fn(async () => remoteEnvelope.slice());
    await first.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: remoteFetch,
    });
    await second.storePlainAfterVerifiedOpen({
      vaultId: VAULT_2,
      mnemonic: MNEMONIC,
      acknowledgment: acknowledgePlainCustodyRisk(VAULT_2),
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_2),
    });

    await expect(first.reset()).resolves.toEqual({
      scope: 'this-endpoint-only',
      storedPhrases: 'removed',
      remoteVaultCopies: 'server-and-drive-untouched',
      vaultDataLost: false,
      nextAction: 're-enter-words-or-scan-qr',
    });
    expect(remoteEnvelope).toEqual(originalRemoteEnvelope);
    expect(await first.stateFor(VAULT_1)).toMatchObject({ status: 'not-on-this-endpoint' });
    expect(await second.stateFor(VAULT_2)).toMatchObject({ status: 'stored+plain' });

    await first.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: 'replacement password',
      fetchHeaderEnvelope: remoteFetch,
    });
    expect(await first.stateFor(VAULT_1)).toMatchObject({ status: 'stored+wrapped' });
    expect(remoteEnvelope).toEqual(originalRemoteEnvelope);
    expect(remoteFetch).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent first setup without mixing password metadata and entries', async () => {
    const storage = new MemoryEndpointStorage();
    const first = keystore(storage);
    const second = keystore(storage);
    const attempts = await Promise.allSettled([
      first.storeAfterVerifiedOpen({
        vaultId: VAULT_1,
        mnemonic: MNEMONIC,
        devicePassword: PASSWORD,
        fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
      }),
      second.storeAfterVerifiedOpen({
        vaultId: VAULT_2,
        mnemonic: MNEMONIC,
        devicePassword: PASSWORD,
        fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_2),
      }),
    ]);
    expect(attempts.some((attempt) => attempt.status === 'fulfilled')).toBe(true);

    first.endSession();
    second.endSession();
    const reopened = keystore(storage);
    const unlocked = await reopened.unlock(PASSWORD);
    expect(unlocked.unlockedVaultIds).toEqual([...storage.entries.keys()].sort());
    for (const vaultId of unlocked.unlockedVaultIds) {
      await expect(reopened.readMnemonic(vaultId)).resolves.toBe(MNEMONIC);
    }
  });

  it('atomically accumulates concurrent wrong-password attempts across instances', async () => {
    const storage = new MemoryEndpointStorage();
    const configured = keystore(storage);
    await configured.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });
    configured.endSession();
    const cores = Array.from({ length: 5 }, () => keystore(storage));
    const attempts = await Promise.allSettled(cores.map((core) => core.unlock(WRONG_PASSWORD)));
    expect(attempts.every((result) => result.status === 'rejected')).toBe(true);
    const snapshot = await storage.readEndpointSnapshot();
    expect(snapshot.metadata).toMatchObject({
      lockout: { failures: 5, lockedUntil: expect.any(Number) },
    });
    await expect(cores[0]!.stateFor(VAULT_1)).resolves.toMatchObject({
      status: 'stored+wrapped',
      session: 'locked',
      requiredAction: { kind: 'wait-or-reset' },
    });
  });

  it('revokes an old unlocked K_dev after another instance resets and reconfigures', async () => {
    const storage = new MemoryEndpointStorage();
    const oldSession = keystore(storage);
    await oldSession.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });

    const replacement = keystore(storage);
    await replacement.reset();
    await replacement.storeAfterVerifiedOpen({
      vaultId: VAULT_2,
      mnemonic: MNEMONIC,
      devicePassword: 'replacement password',
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_2),
    });

    await expect(
      oldSession.storeAfterVerifiedOpen({
        vaultId: VAULT_3,
        mnemonic: MNEMONIC,
        fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_3),
      }),
    ).rejects.toMatchObject({ code: 'session-ended' });
    await expect(oldSession.withContentKey(VAULT_1, () => undefined)).rejects.toMatchObject({
      code: 'phrase-locked',
    });
    replacement.endSession();
    const reopened = keystore(storage);
    await expect(reopened.unlock('replacement password')).resolves.toEqual({
      unlockedVaultIds: [VAULT_2],
    });
  });

  it('rejects an unlock if another instance resets during password derivation', async () => {
    const storage = new MemoryEndpointStorage();
    let correctDeviceKey: Uint8Array | undefined;
    const capturingArgon = async (options: DevicePasswordArgon2Options) => {
      const output = await fastArgon2()(options);
      correctDeviceKey = output.slice();
      return output;
    };
    const configured = keystore(storage, { argon2: capturingArgon });
    await configured.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });
    configured.endSession();

    const derivation = deferred<Uint8Array>();
    const started = deferred<void>();
    const reopening = keystore(storage, {
      argon2: async () => {
        started.resolve();
        return derivation.promise;
      },
    });
    const unlocking = reopening.unlock(PASSWORD);
    await started.promise;
    await storage.reset();
    derivation.resolve(correctDeviceKey!.slice());
    await expect(unlocking).rejects.toMatchObject({ code: 'session-ended' });
    await expect(reopening.withContentKey(VAULT_1, () => undefined)).rejects.toMatchObject({
      code: 'phrase-locked',
    });
    zeroBytes(correctDeviceKey!);
  });
});

describe('never persisted across sessions', () => {
  const databaseName = 'bettertrack-paranoid-keystore-never-persisted-test';

  afterEach(async () => {
    await deleteDatabase(databaseName);
    Reflect.deleteProperty(globalThis, 'caches');
  });

  it('stores no password, K_dev, mnemonic, entropy, local/session/cookie/cache secret before or after reopen', async () => {
    const storage = createIndexedDbEndpointKeystoreStorage({ databaseName });
    const knownDeviceKey = new Uint8Array(32).fill(0xa7);
    const knownContentKey = new Uint8Array(32).fill(0x31);
    const argon2 = vi.fn(async (_options: DevicePasswordArgon2Options) => knownDeviceKey.slice());
    const cacheKeys = vi.fn(async () => ['unrelated-cache']);
    const publicCacheBytes = utf8('unrelated public cached response');
    const cacheOpen = vi.fn(async () => ({
      keys: async () => [{ url: 'https://cache.test/public-resource' } as Request],
      match: async () =>
        ({
          text: async () => new TextDecoder().decode(publicCacheBytes),
          arrayBuffer: async () => publicCacheBytes.slice().buffer,
        }) as unknown as Response,
    }));
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { keys: cacheKeys, open: cacheOpen } as unknown as CacheStorage,
    });
    localStorage.setItem('unrelated', 'theme');
    sessionStorage.setItem('unrelated', 'tab-state');
    document.cookie = 'unrelated=cookie; path=/';

    const first = new EndpointVaultKeystore({
      storage,
      argon2,
      randomBytes: deterministicRandom(),
      sessionPersistence: NO_ENDPOINT_SESSION_PERSISTENCE,
    });
    await first.storeAfterVerifiedOpen({
      vaultId: VAULT_1,
      mnemonic: MNEMONIC,
      devicePassword: PASSWORD,
      fetchHeaderEnvelope: verifiedHeaderFetch(VAULT_1),
    });

    const entropy = mnemonicToEntropy(MNEMONIC);
    const rawSecrets = [
      entropy.slice(),
      knownDeviceKey.slice(),
      knownContentKey.slice(),
      utf8(PASSWORD),
      utf8(MNEMONIC),
    ];
    const forbidden = [
      PASSWORD,
      MNEMONIC,
      encodeBase64Url(entropy),
      encodeBase64Url(knownDeviceKey),
      encodeBase64Url(knownContentKey),
      [...knownDeviceKey].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      [...knownContentKey].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    ];
    const beforeClose = await persistentSurfaceText(databaseName);
    for (const secret of forbidden) expect(beforeClose).not.toContain(secret);
    const rawBeforeClose = await readAllPersistentBinary(databaseName);
    for (const secret of rawSecrets)
      expect(containsByteSequence(rawBeforeClose, secret)).toBe(false);

    first.endSession();
    const reopened = new EndpointVaultKeystore({
      storage,
      argon2,
      randomBytes: deterministicRandom(),
      sessionPersistence: NO_ENDPOINT_SESSION_PERSISTENCE,
    });
    await expect(reopened.readMnemonic(VAULT_1)).rejects.toMatchObject({ code: 'phrase-locked' });
    expect(await reopened.stateFor(VAULT_1)).toMatchObject({
      status: 'stored+wrapped',
      session: 'locked',
      requiredAction: { kind: 'unlock' },
    });
    const afterReopen = await persistentSurfaceText(databaseName);
    for (const secret of forbidden) expect(afterReopen).not.toContain(secret);
    const rawAfterReopen = await readAllPersistentBinary(databaseName);
    for (const secret of rawSecrets)
      expect(containsByteSequence(rawAfterReopen, secret)).toBe(false);
    expect(cacheKeys).toHaveBeenCalledTimes(4);
    expect(cacheOpen).toHaveBeenCalledTimes(4);
    zeroBytes(entropy);
    for (const secret of rawSecrets) zeroBytes(secret);
    zeroBytes(knownDeviceKey);
    zeroBytes(knownContentKey);
    zeroBytes(publicCacheBytes);
  });
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function persistentSurfaceText(databaseName: string): Promise<string> {
  const indexedDb = await readAllDatabaseValues(databaseName);
  const local = Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]);
  const session = Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]);
  const cacheNames = await globalThis.caches.keys();
  const cacheContents = await Promise.all(
    cacheNames.map(async (cacheName) => {
      const cache = await globalThis.caches.open(cacheName);
      const requests = await cache.keys();
      return Promise.all(
        requests.map(async (request) => ({
          url: request.url,
          body: await (await cache.match(request))?.text(),
        })),
      );
    }),
  );
  return JSON.stringify({
    indexedDb,
    local,
    session,
    cookie: document.cookie,
    cacheNames,
    cacheContents,
  });
}

async function readAllDatabaseValues(databaseName: string): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const transaction = db.transaction(
      [
        ENDPOINT_KEYSTORE_CONTROL_STORE,
        ENDPOINT_KEYSTORE_METADATA_STORE,
        ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE,
      ],
      'readonly',
    );
    return await Promise.all(
      [
        ENDPOINT_KEYSTORE_CONTROL_STORE,
        ENDPOINT_KEYSTORE_METADATA_STORE,
        ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE,
      ].map(async (storeName) => {
        const store = transaction.objectStore(storeName);
        const [keys, values] = await Promise.all([
          idbRequest(store.getAllKeys()),
          idbRequest(store.getAll()),
        ]);
        return { keys, values };
      }),
    );
  } finally {
    db.close();
  }
}

async function readAllPersistentBinary(databaseName: string): Promise<unknown[]> {
  const indexedDb = await readAllDatabaseValues(databaseName);
  const cacheNames = await globalThis.caches.keys();
  const cacheBodies = await Promise.all(
    cacheNames.map(async (cacheName) => {
      const cache = await globalThis.caches.open(cacheName);
      return Promise.all(
        (await cache.keys()).map(async (request) => {
          const response = await cache.match(request);
          return response == null ? null : new Uint8Array(await response.arrayBuffer());
        }),
      );
    }),
  );
  return [indexedDb, cacheBodies];
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Deletion of ${databaseName} was blocked.`));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function containsByteSequence(value: unknown, sequence: Uint8Array): boolean {
  if (sequence.length === 0) return false;
  if (value instanceof ArrayBuffer) return bytesContain(new Uint8Array(value), sequence);
  if (ArrayBuffer.isView(value)) {
    return bytesContain(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), sequence);
  }
  if (Array.isArray(value)) {
    if (
      value.every(
        (item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255,
      ) &&
      bytesContain(Uint8Array.from(value as number[]), sequence)
    ) {
      return true;
    }
    return value.some((item) => containsByteSequence(item, sequence));
  }
  if (value != null && typeof value === 'object') {
    return Object.values(value).some((item) => containsByteSequence(item, sequence));
  }
  return false;
}

function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((byte, offset) => haystack[start + offset] === byte)) return true;
  }
  return false;
}

it('pins the lockout ladder independently', () => {
  expect(Array.from({ length: 11 }, (_, failures) => lockoutDelayMs(failures))).toEqual([
    0, 0, 0, 0, 0, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
  ]);
  expect(lockoutDelayMs(Number.NaN)).toBe(0);
});

it('rejects malformed persisted records instead of guessing', async () => {
  const storage = new MemoryEndpointStorage();
  await storage.writeEntry(storage.revision, VAULT_1, {
    vaultId: VAULT_1,
    custody: 'wrapped',
    payload: { version: 99, algorithm: 'A256GCM', iv: '', ciphertext: '' },
  });
  const core = keystore(storage);
  await expect(core.stateFor(VAULT_1)).resolves.toEqual({
    status: 'endpoint-keystore-invalid',
    requiredAction: { kind: 'reset-endpoint-keystore' },
  });
});

it('rejects an IndexedDB key and stored payload vault-id mismatch', async () => {
  const storage = new MemoryEndpointStorage();
  await storage.writeEntry(storage.revision, VAULT_1, {
    vaultId: VAULT_2,
    custody: 'plain',
    payload: {
      version: 1,
      encoding: 'bip39-entropy-base64url',
      entropy: encodeBase64Url(mnemonicToEntropy(MNEMONIC)),
    },
  });
  const core = keystore(storage);
  await expect(core.stateFor(VAULT_1)).resolves.toEqual({
    status: 'endpoint-keystore-invalid',
    requiredAction: { kind: 'reset-endpoint-keystore' },
  });
});
