import { vaultIdParamSchema } from '@bettertrack/contracts';

import { zeroBytes } from '../bytes';
import { type RandomBytes, secureRandomBytes } from '../crypto';
import { entropyToMnemonic, mnemonicToEntropy } from '../bip39/mnemonic';
import { openVaultHeaderWithMnemonic, type VerifiedVaultHeaderOpen } from '../keys/documents';
import { VAULT_LOCK_REQUEST_EVENT } from '../lockSignal';
import {
  consumePlainCustodyAcknowledgment,
  invalidatePlainCustodyAcknowledgments,
} from './acknowledgment';
import {
  createEndpointPassword,
  deriveDeviceKey,
  unwrapMnemonicEntropy,
  verifyEndpointPassword,
  wrapMnemonicEntropy,
  type DevicePasswordArgon2,
} from './deviceCrypto';
import { decodeBase64Url, encodeBase64Url } from './encoding';
import { EndpointKeystoreError } from './errors';
import { parseEndpointPasswordMetadata, parseStoredPhraseEntry } from './records';
import { createIndexedDbEndpointKeystoreStorage, type EndpointKeystoreStorage } from './storage';
import {
  ENDPOINT_KEYSTORE_VERSION,
  type EndpointPasswordMetadataV1,
  type EndpointUnlockResult,
  type EndpointVaultState,
  type FetchVaultHeaderEnvelope,
  type KeystoreResetResult,
  type OpenedVault,
  type PlainCustodyAcknowledgmentToken,
  type StorePlainPhraseInput,
  type StoreWrappedPhraseInput,
  type StoredPhraseEntry,
} from './types';

const LOCKOUT_FIRST_FAILURE = 5;
const LOCKOUT_INITIAL_MS = 30_000;
const LOCKOUT_MAX_MS = 300_000;

interface CachedContentKey {
  keyId: string;
  keyFingerprint: OpenedVault['keyFingerprint'];
  bytes: Uint8Array;
}

interface StoredMnemonicRead {
  mnemonic: string;
  revision: number;
}

export interface EndpointVaultKeystoreOptions {
  storage?: EndpointKeystoreStorage;
  argon2?: DevicePasswordArgon2;
  randomBytes?: RandomBytes;
  now?: () => number;
}

/**
 * Headless E3 endpoint keystore. Passwords, K_dev, mnemonic entropy and K_c are
 * held only by this object and synchronously zeroed when the session ends.
 */
export class EndpointVaultKeystore {
  private readonly storage: EndpointKeystoreStorage;
  private readonly argon2: DevicePasswordArgon2 | undefined;
  private readonly randomBytes: RandomBytes;
  private readonly now: () => number;
  private deviceKey: Uint8Array | null = null;
  private devicePasswordMetadata: EndpointPasswordMetadataV1 | null = null;
  private readonly wrappedEntropy = new Map<string, Uint8Array>();
  private readonly contentKeys = new Map<string, CachedContentKey>();
  private readonly activeContentKeyBorrows = new Set<Uint8Array>();
  private sessionGeneration = 0;
  private sessionRevision: number | null = null;

  constructor(options: EndpointVaultKeystoreOptions = {}) {
    this.storage = options.storage ?? createIndexedDbEndpointKeystoreStorage();
    this.argon2 = options.argon2;
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
    this.now = options.now ?? Date.now;
  }

  async stateFor(vaultId: string): Promise<EndpointVaultState> {
    requireVaultId(vaultId);
    const stable = await this.readStableEntries();
    this.reconcileSessionRevision(stable.revision);
    try {
      const entries = stable.entries.map((record) =>
        parseStoredPhraseEntry(record.value, record.vaultId),
      );
      const metadata =
        stable.metadata == null ? null : parseEndpointPasswordMetadata(stable.metadata);
      if (metadata == null && entries.some((entry) => entry.custody === 'wrapped')) {
        return invalidEndpointState();
      }
      const entry = entries.find((candidate) => candidate.vaultId === vaultId);
      if (entry == null) {
        return {
          status: 'not-on-this-endpoint',
          requiredAction: {
            kind: 'provide-phrase',
            methods: ['enter-words', 'scan-qr'],
          },
        };
      }
      if (entry.custody === 'plain') {
        return { status: 'stored+plain', requiredAction: { kind: 'open-silently' } };
      }
      if (metadata == null) return invalidEndpointState();
      if (metadata.lockout.lockedUntil != null && metadata.lockout.lockedUntil > this.now()) {
        return {
          status: 'stored+wrapped',
          session: 'locked',
          requiredAction: {
            kind: 'wait-or-reset',
            retryAt: metadata.lockout.lockedUntil,
            alternative: 'reset-endpoint-keystore',
          },
        };
      }
      const sessionMatches =
        this.deviceKey != null &&
        this.devicePasswordMetadata != null &&
        this.sessionRevision === stable.revision &&
        sameEndpointPassword(metadata, this.devicePasswordMetadata) &&
        this.wrappedEntropy.has(vaultId);
      if (this.deviceKey != null && !sessionMatches) this.endSession();
      return sessionMatches
        ? {
            status: 'stored+wrapped',
            session: 'unlocked',
            requiredAction: { kind: 'open-silently' },
          }
        : {
            status: 'stored+wrapped',
            session: 'locked',
            requiredAction: { kind: 'unlock', credential: 'device-password' },
          };
    } catch (cause) {
      if (cause instanceof EndpointKeystoreError && cause.code === 'storage-invalid') {
        return invalidEndpointState();
      }
      throw cause;
    }
  }

  async unlock(devicePassword: string): Promise<EndpointUnlockResult> {
    const generation = this.beginSessionChange();
    const snapshot = await this.storage.readEndpointSnapshot();
    if (snapshot.metadata == null) {
      throw new EndpointKeystoreError(
        'device-password-not-configured',
        'This endpoint has no device password.',
      );
    }
    const metadata = parseEndpointPasswordMetadata(snapshot.metadata);
    this.assertNotLockedOut(metadata);
    let candidate: Uint8Array | undefined;
    const entropy = new Map<string, Uint8Array>();
    try {
      candidate = await deriveDeviceKey(devicePassword, metadata.kdf, this.argon2);
      this.requireCurrentGeneration(generation);
      if (!(await verifyEndpointPassword(metadata, candidate))) {
        await this.recordWrongPassword(metadata, snapshot.revision);
      }
      this.requireCurrentGeneration(generation);
      const resetRevision = await this.resetPasswordLockout(metadata, snapshot.revision);
      const listed = await this.storage.listEntries(resetRevision);
      if (listed.status === 'stale') {
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint keystore changed during password verification.',
        );
      }
      for (const record of listed.entries) {
        const entry = parseStoredPhraseEntry(record.value, record.vaultId);
        if (entry.custody === 'wrapped') {
          if (entropy.has(entry.vaultId)) {
            throw new EndpointKeystoreError(
              'storage-invalid',
              'Endpoint keystore contains duplicate vault entries.',
            );
          }
          entropy.set(
            entry.vaultId,
            await unwrapMnemonicEntropy(entry.vaultId, entry.payload, candidate),
          );
        }
      }
      const finalSnapshot = await this.storage.readEndpointSnapshot();
      if (
        finalSnapshot.revision !== listed.revision ||
        finalSnapshot.metadata == null ||
        !sameEndpointPassword(parseEndpointPasswordMetadata(finalSnapshot.metadata), metadata)
      ) {
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint keystore changed while stored phrases were being unlocked.',
        );
      }
      this.requireCurrentGeneration(generation);
      this.deviceKey = candidate;
      this.devicePasswordMetadata = metadata;
      this.sessionRevision = listed.revision;
      candidate = undefined;
      for (const [vaultId, bytes] of entropy) this.wrappedEntropy.set(vaultId, bytes);
      entropy.clear();
      return { unlockedVaultIds: [...this.wrappedEntropy.keys()].sort() };
    } catch (cause) {
      if (this.sessionGeneration === generation) this.clearSessionSecrets();
      throw cause;
    } finally {
      if (candidate != null) zeroBytes(candidate);
      for (const bytes of entropy.values()) zeroBytes(bytes);
    }
  }

  /** Default save path: verified open first, then wrapped custody. */
  async storeAfterVerifiedOpen(input: StoreWrappedPhraseInput): Promise<OpenedVault> {
    requireVaultId(input.vaultId);
    const initialGeneration = this.sessionGeneration;
    const snapshot = await this.storage.readEndpointSnapshot();
    this.reconcileSessionRevision(snapshot.revision);
    this.requireCurrentGeneration(initialGeneration);
    const entropy = mnemonicToEntropy(input.mnemonic);
    let verified: VerifiedVaultHeaderOpen | undefined;
    try {
      verified = await this.runVerifiedOpen(
        input.vaultId,
        input.mnemonic,
        input.fetchHeaderEnvelope,
        input.expectedFingerprint,
      );
      this.requireCurrentGeneration(initialGeneration);
      const session = await this.ensureDeviceKey(input.devicePassword, snapshot, initialGeneration);
      const payload = await wrapMnemonicEntropy(
        input.vaultId,
        entropy,
        session.deviceKey,
        this.randomBytes,
      );
      const entry: StoredPhraseEntry = { vaultId: input.vaultId, custody: 'wrapped', payload };
      this.requireCurrentGeneration(session.generation);
      const written = await this.storage.writeEntry(session.revision, input.vaultId, entry);
      if (written.status === 'stale') {
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint keystore changed before the phrase could be stored.',
        );
      }
      if (session.generation !== this.sessionGeneration) {
        zeroBytes(verified.contentKey);
        return openedVaultReceipt(verified);
      }
      this.cacheWrappedEntropy(input.vaultId, entropy);
      this.sessionRevision = written.revision;
      return this.cacheVerifiedOpen(verified);
    } catch (cause) {
      if (verified != null) zeroBytes(verified.contentKey);
      throw cause;
    } finally {
      zeroBytes(entropy);
    }
  }

  /** Exceptional save path: impossible without a fresh runtime acknowledgment. */
  async storePlainAfterVerifiedOpen(input: StorePlainPhraseInput): Promise<OpenedVault> {
    requireVaultId(input.vaultId);
    const generation = this.sessionGeneration;
    const snapshot = await this.storage.readEndpointSnapshot();
    this.reconcileSessionRevision(snapshot.revision);
    this.requireCurrentGeneration(generation);
    const entropy = mnemonicToEntropy(input.mnemonic);
    let verified: VerifiedVaultHeaderOpen | undefined;
    try {
      verified = await this.runVerifiedOpen(
        input.vaultId,
        input.mnemonic,
        input.fetchHeaderEnvelope,
        input.expectedFingerprint,
      );
      this.requireCurrentGeneration(generation);
      consumePlainCustodyAcknowledgment(input.vaultId, input.acknowledgment);
      const entry: StoredPhraseEntry = {
        vaultId: input.vaultId,
        custody: 'plain',
        payload: {
          version: ENDPOINT_KEYSTORE_VERSION,
          encoding: 'bip39-entropy-base64url',
          entropy: encodeBase64Url(entropy),
        },
      };
      const written = await this.storage.writeEntry(snapshot.revision, input.vaultId, entry);
      if (written.status === 'stale') {
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint keystore changed before the phrase could be stored.',
        );
      }
      if (generation !== this.sessionGeneration) {
        zeroBytes(verified.contentKey);
        return openedVaultReceipt(verified);
      }
      this.dropWrappedEntropy(input.vaultId);
      this.sessionRevision = written.revision;
      return this.cacheVerifiedOpen(verified);
    } catch (cause) {
      if (verified != null) zeroBytes(verified.contentKey);
      throw cause;
    } finally {
      zeroBytes(entropy);
    }
  }

  async openStoredVault(
    vaultId: string,
    fetchHeaderEnvelope: FetchVaultHeaderEnvelope,
    expectedFingerprint?: OpenedVault['keyFingerprint'],
  ): Promise<OpenedVault> {
    const generation = this.sessionGeneration;
    const stored = await this.readStoredMnemonic(vaultId);
    this.requireCurrentGeneration(generation);
    let verified: VerifiedVaultHeaderOpen | undefined;
    try {
      verified = await this.runVerifiedOpen(
        vaultId,
        stored.mnemonic,
        fetchHeaderEnvelope,
        expectedFingerprint,
      );
      this.requireCurrentGeneration(generation);
      const current = await this.storage.listEntries(stored.revision);
      if (current.status === 'stale') {
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint custody changed while the vault was opening.',
        );
      }
      this.requireCurrentGeneration(generation);
      this.sessionRevision = current.revision;
      return this.cacheVerifiedOpen(verified);
    } catch (cause) {
      if (verified != null) zeroBytes(verified.contentKey);
      throw cause;
    }
  }

  async readMnemonic(vaultId: string): Promise<string> {
    return (await this.readStoredMnemonic(vaultId)).mnemonic;
  }

  private async readStoredMnemonic(vaultId: string): Promise<StoredMnemonicRead> {
    requireVaultId(vaultId);
    const stable = await this.readStableEntries();
    this.reconcileSessionRevision(stable.revision);
    const record = stable.entries.find((candidate) => candidate.vaultId === vaultId);
    if (record == null) {
      throw new EndpointKeystoreError('vault-not-stored', 'Vault phrase is not on this endpoint.');
    }
    const entry = parseStoredPhraseEntry(record.value, record.vaultId);
    if (entry.custody === 'wrapped') {
      const entropy = this.wrappedEntropy.get(vaultId);
      if (
        this.deviceKey == null ||
        this.devicePasswordMetadata == null ||
        entropy == null ||
        stable.metadata == null ||
        this.sessionRevision !== stable.revision ||
        !sameEndpointPassword(
          parseEndpointPasswordMetadata(stable.metadata),
          this.devicePasswordMetadata,
        )
      ) {
        if (this.deviceKey != null) this.endSession();
        throw new EndpointKeystoreError(
          'phrase-locked',
          'The endpoint device password must be unlocked first.',
        );
      }
      return { mnemonic: entropyToMnemonic(entropy), revision: stable.revision };
    }
    const entropy = decodeBase64Url(entry.payload.entropy);
    try {
      return { mnemonic: entropyToMnemonic(entropy), revision: stable.revision };
    } finally {
      zeroBytes(entropy);
    }
  }

  async switchToPlain(
    vaultId: string,
    acknowledgment: PlainCustodyAcknowledgmentToken,
  ): Promise<void> {
    requireVaultId(vaultId);
    const generation = this.sessionGeneration;
    const stable = await this.readStableEntries();
    this.reconcileSessionRevision(stable.revision);
    this.requireCurrentGeneration(generation);
    const record = stable.entries.find((candidate) => candidate.vaultId === vaultId);
    if (record == null) {
      throw new EndpointKeystoreError('vault-not-stored', 'Vault phrase is not on this endpoint.');
    }
    const entry = parseStoredPhraseEntry(record.value, record.vaultId);
    if (entry.custody === 'plain') {
      consumePlainCustodyAcknowledgment(vaultId, acknowledgment);
      return;
    }
    const entropy = this.wrappedEntropy.get(vaultId);
    if (this.deviceKey == null || entropy == null) {
      throw new EndpointKeystoreError(
        'phrase-locked',
        'The endpoint device password must be unlocked first.',
      );
    }
    consumePlainCustodyAcknowledgment(vaultId, acknowledgment);
    const written = await this.storage.writeEntry(stable.revision, vaultId, {
      vaultId,
      custody: 'plain',
      payload: {
        version: ENDPOINT_KEYSTORE_VERSION,
        encoding: 'bip39-entropy-base64url',
        entropy: encodeBase64Url(entropy),
      },
    } satisfies StoredPhraseEntry);
    if (written.status === 'stale') {
      throw new EndpointKeystoreError('session-ended', 'Endpoint keystore changed during switch.');
    }
    if (generation !== this.sessionGeneration) {
      return;
    }
    this.dropWrappedEntropy(vaultId);
    this.sessionRevision = written.revision;
  }

  /** Plain → wrapped always requires the password again, even in an open session. */
  async switchToWrapped(vaultId: string, devicePassword: string): Promise<void> {
    requireVaultId(vaultId);
    const initialGeneration = this.sessionGeneration;
    const stable = await this.readStableEntries();
    this.reconcileSessionRevision(stable.revision);
    this.requireCurrentGeneration(initialGeneration);
    const record = stable.entries.find((candidate) => candidate.vaultId === vaultId);
    if (record == null) {
      throw new EndpointKeystoreError('vault-not-stored', 'Vault phrase is not on this endpoint.');
    }
    const entry = parseStoredPhraseEntry(record.value, record.vaultId);
    if (entry.custody === 'wrapped') return;
    const entropy = decodeBase64Url(entry.payload.entropy);
    try {
      const session = await this.ensureDeviceKey(
        devicePassword,
        { revision: stable.revision, metadata: stable.metadata },
        initialGeneration,
        true,
      );
      const payload = await wrapMnemonicEntropy(
        vaultId,
        entropy,
        session.deviceKey,
        this.randomBytes,
      );
      this.requireCurrentGeneration(session.generation);
      const written = await this.storage.writeEntry(session.revision, vaultId, {
        vaultId,
        custody: 'wrapped',
        payload,
      });
      if (written.status === 'stale') {
        throw new EndpointKeystoreError('session-ended', 'Custody switch was cancelled.');
      }
      if (session.generation !== this.sessionGeneration) {
        return;
      }
      this.cacheWrappedEntropy(vaultId, entropy);
      this.sessionRevision = written.revision;
    } finally {
      zeroBytes(entropy);
    }
  }

  /**
   * Borrows a session-scoped K_c copy that is wiped when custody locks.
   * Consumers MUST call assertSessionCurrent between any crypto operation and
   * any external side effect; an async suspension may cross a session teardown.
   */
  withContentKey<T>(
    vaultId: string,
    operation: (
      contentKey: Uint8Array,
      keyId: string,
      assertSessionCurrent: () => void,
    ) => Promise<T> | T,
  ): Promise<T> {
    const cached = this.contentKeys.get(vaultId);
    if (cached == null) {
      return Promise.reject(
        new EndpointKeystoreError('phrase-locked', 'The vault content key is not unlocked.'),
      );
    }
    const generation = this.sessionGeneration;
    const borrowed = cached.bytes.slice();
    this.activeContentKeyBorrows.add(borrowed);
    const assertSessionCurrent = () => {
      if (generation !== this.sessionGeneration || this.contentKeys.get(vaultId) !== cached) {
        throw new EndpointKeystoreError('session-ended', 'Vault session ended during operation.');
      }
    };
    return Promise.resolve()
      .then(async () => {
        const stable = await this.readStableEntries();
        if (
          this.sessionRevision !== stable.revision ||
          !stable.entries.some((entry) => entry.vaultId === vaultId)
        ) {
          this.endSession();
          throw new EndpointKeystoreError(
            'session-ended',
            'Endpoint custody changed during the vault session.',
          );
        }
        assertSessionCurrent();
        return operation(borrowed, cached.keyId, assertSessionCurrent);
      })
      .then(async (result) => {
        assertSessionCurrent();
        const stable = await this.readStableEntries();
        if (this.sessionRevision !== stable.revision) {
          this.endSession();
          throw new EndpointKeystoreError(
            'session-ended',
            'Endpoint custody changed during the vault operation.',
          );
        }
        assertSessionCurrent();
        return result;
      })
      .finally(() => {
        this.activeContentKeyBorrows.delete(borrowed);
        zeroBytes(borrowed);
      });
  }

  /** Manual lock, logout, tab teardown and PIN idle-lock all call this seam. */
  endSession(): void {
    this.sessionGeneration += 1;
    invalidatePlainCustodyAcknowledgments();
    this.clearSessionSecrets();
  }

  handleIdle(pinLockEnabled: boolean): void {
    if (pinLockEnabled) this.endSession();
  }

  bindToVaultLockSignal(target: EventTarget = globalThis): () => void {
    const onLock = () => this.endSession();
    target.addEventListener(VAULT_LOCK_REQUEST_EVENT, onLock);
    return () => target.removeEventListener(VAULT_LOCK_REQUEST_EVENT, onLock);
  }

  /**
   * Wipes only this endpoint's phrase copies. Server/Drive ciphertext is never
   * touched; the words or E7 QR restore access without vault-data loss.
   */
  async reset(): Promise<KeystoreResetResult> {
    this.endSession();
    await this.storage.reset();
    return {
      scope: 'this-endpoint-only',
      storedPhrases: 'removed',
      remoteVaultCopies: 'server-and-drive-untouched',
      vaultDataLost: false,
      nextAction: 're-enter-words-or-scan-qr',
    };
  }

  private async runVerifiedOpen(
    vaultId: string,
    mnemonic: string,
    fetchHeaderEnvelope: FetchVaultHeaderEnvelope,
    expectedFingerprint: OpenedVault['keyFingerprint'] | undefined,
  ): Promise<VerifiedVaultHeaderOpen> {
    let verified: VerifiedVaultHeaderOpen;
    try {
      const envelope = await fetchHeaderEnvelope({ vaultId });
      if (!(envelope instanceof Uint8Array)) {
        throw new EndpointKeystoreError(
          'verification-failed',
          'Vault header fetch did not return envelope bytes.',
        );
      }
      verified = await openVaultHeaderWithMnemonic({
        envelope,
        mnemonic,
        expectedVaultId: vaultId,
        expectedFingerprint,
      });
    } catch (cause) {
      throw new EndpointKeystoreError(
        'verification-failed',
        'The words did not open the authenticated vault header.',
        {},
        { cause },
      );
    }
    zeroBytes(verified.plaintext);
    return verified;
  }

  private cacheVerifiedOpen(verified: VerifiedVaultHeaderOpen): OpenedVault {
    const existing = this.contentKeys.get(verified.vaultId);
    if (existing != null) zeroBytes(existing.bytes);
    this.contentKeys.set(verified.vaultId, {
      keyId: verified.keyId,
      keyFingerprint: verified.keyFingerprint,
      bytes: verified.contentKey,
    });
    return {
      vaultId: verified.vaultId,
      keyId: verified.keyId,
      keyFingerprint: verified.keyFingerprint,
    };
  }

  private async ensureDeviceKey(
    devicePassword: string | undefined,
    snapshot: { revision: number; metadata: unknown | null },
    initialGeneration: number,
    forcePassword = false,
  ): Promise<{ deviceKey: Uint8Array; revision: number; generation: number }> {
    if (!forcePassword && this.deviceKey != null) {
      this.requireCurrentGeneration(initialGeneration);
      if (snapshot.metadata == null) {
        this.endSession();
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint device-password metadata was reset.',
        );
      }
      const metadata = parseEndpointPasswordMetadata(snapshot.metadata);
      if (
        this.devicePasswordMetadata == null ||
        !sameEndpointPassword(metadata, this.devicePasswordMetadata) ||
        this.sessionRevision !== snapshot.revision
      ) {
        this.endSession();
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint device-password metadata changed during the session.',
        );
      }
      return {
        deviceKey: this.deviceKey,
        revision: snapshot.revision,
        generation: initialGeneration,
      };
    }
    if (devicePassword == null) {
      throw new EndpointKeystoreError(
        'device-password-required',
        'The endpoint device password is required.',
      );
    }
    if (snapshot.metadata == null) {
      const configured = await createEndpointPassword(devicePassword, {
        argon2: this.argon2,
        randomBytes: this.randomBytes,
      });
      try {
        this.requireCurrentGeneration(initialGeneration);
        const initialized = await this.storage.initializeMetadata(
          snapshot.revision,
          configured.metadata,
        );
        if (initialized.status === 'created') {
          this.requireCurrentGeneration(initialGeneration);
          this.deviceKey = configured.deviceKey;
          this.devicePasswordMetadata = configured.metadata;
          this.sessionRevision = initialized.revision;
          return {
            deviceKey: configured.deviceKey,
            revision: initialized.revision,
            generation: initialGeneration,
          };
        }
        zeroBytes(configured.deviceKey);
        await this.unlock(devicePassword);
        return this.requireUnlockedSession();
      } catch (cause) {
        if (this.deviceKey !== configured.deviceKey) zeroBytes(configured.deviceKey);
        throw cause;
      }
    }
    await this.unlock(devicePassword);
    return this.requireUnlockedSession();
  }

  private requireUnlockedSession(): {
    deviceKey: Uint8Array;
    revision: number;
    generation: number;
  } {
    if (this.deviceKey == null || this.sessionRevision == null) {
      throw new EndpointKeystoreError('session-ended', 'Device-password unlock was cancelled.');
    }
    return {
      deviceKey: this.deviceKey,
      revision: this.sessionRevision,
      generation: this.sessionGeneration,
    };
  }

  private assertNotLockedOut(metadata: EndpointPasswordMetadataV1): void {
    if (metadata.lockout.lockedUntil != null && metadata.lockout.lockedUntil > this.now()) {
      throw new EndpointKeystoreError(
        'locked-out',
        'Device-password verification is temporarily locked.',
        {
          failures: metadata.lockout.failures,
          retryAt: metadata.lockout.lockedUntil,
        },
      );
    }
  }

  private async recordWrongPassword(
    verifiedMetadata: EndpointPasswordMetadataV1,
    expectedRevision: number,
  ): Promise<never> {
    let revision = expectedRevision;
    for (let retry = 0; retry < 32; retry += 1) {
      const now = this.now();
      const updated = await this.storage.updateMetadata(revision, (current) => {
        if (current == null) {
          throw new EndpointKeystoreError('session-ended', 'Endpoint password metadata was reset.');
        }
        const metadata = parseEndpointPasswordMetadata(current);
        if (!sameEndpointPassword(metadata, verifiedMetadata)) {
          throw new EndpointKeystoreError(
            'session-ended',
            'Endpoint password metadata changed during verification.',
          );
        }
        if (metadata.lockout.lockedUntil != null && metadata.lockout.lockedUntil > now) {
          return { value: metadata, result: metadata.lockout };
        }
        const failures = metadata.lockout.failures + 1;
        const delay = lockoutDelayMs(failures);
        const lockedUntil = delay === 0 ? null : now + delay;
        const lockout = { failures, lockedUntil };
        return { value: { ...metadata, lockout }, result: lockout };
      });
      if (updated.status === 'stale') {
        revision = updated.revision;
        continue;
      }
      const { failures, lockedUntil } = updated.result;
      throw new EndpointKeystoreError(
        lockedUntil == null ? 'wrong-password' : 'locked-out',
        lockedUntil == null
          ? 'The endpoint device password is incorrect.'
          : 'Device-password verification is temporarily locked.',
        { failures, ...(lockedUntil == null ? {} : { retryAt: lockedUntil }) },
      );
    }
    throw new EndpointKeystoreError(
      'session-ended',
      'Endpoint password lockout changed too many times concurrently.',
    );
  }

  private async resetPasswordLockout(
    verifiedMetadata: EndpointPasswordMetadataV1,
    expectedRevision: number,
  ): Promise<number> {
    let revision = expectedRevision;
    for (let retry = 0; retry < 32; retry += 1) {
      const updated = await this.storage.updateMetadata(revision, (current) => {
        if (current == null) {
          throw new EndpointKeystoreError('session-ended', 'Endpoint password metadata was reset.');
        }
        const metadata = parseEndpointPasswordMetadata(current);
        if (!sameEndpointPassword(metadata, verifiedMetadata)) {
          throw new EndpointKeystoreError(
            'session-ended',
            'Endpoint password metadata changed during verification.',
          );
        }
        return {
          value: { ...metadata, lockout: { failures: 0, lockedUntil: null } },
          result: undefined,
        };
      });
      if (updated.status === 'updated') return updated.revision;
      revision = updated.revision;
    }
    throw new EndpointKeystoreError(
      'session-ended',
      'Endpoint password state changed too many times concurrently.',
    );
  }

  private async readStableEntries(): Promise<{
    revision: number;
    metadata: unknown | null;
    entries: readonly { vaultId: string; value: unknown }[];
  }> {
    for (let retry = 0; retry < 16; retry += 1) {
      const snapshot = await this.storage.readEndpointSnapshot();
      const listed = await this.storage.listEntries(snapshot.revision);
      if (listed.status === 'current') {
        return { ...snapshot, entries: listed.entries };
      }
    }
    throw new EndpointKeystoreError(
      'storage-invalid',
      'Endpoint keystore changed too many times while reading.',
    );
  }

  private beginSessionChange(): number {
    this.sessionGeneration += 1;
    invalidatePlainCustodyAcknowledgments();
    this.clearSessionSecrets();
    return this.sessionGeneration;
  }

  private requireCurrentGeneration(generation: number): void {
    if (generation !== this.sessionGeneration) {
      throw new EndpointKeystoreError('session-ended', 'Device-password unlock was cancelled.');
    }
  }

  private clearSessionSecrets(): void {
    if (this.deviceKey != null) zeroBytes(this.deviceKey);
    this.deviceKey = null;
    this.devicePasswordMetadata = null;
    this.sessionRevision = null;
    for (const entropy of this.wrappedEntropy.values()) zeroBytes(entropy);
    this.wrappedEntropy.clear();
    for (const contentKey of this.contentKeys.values()) zeroBytes(contentKey.bytes);
    this.contentKeys.clear();
    for (const borrowed of this.activeContentKeyBorrows) zeroBytes(borrowed);
    this.activeContentKeyBorrows.clear();
  }

  private reconcileSessionRevision(revision: number): void {
    if (this.sessionRevision != null && this.sessionRevision !== revision) this.endSession();
  }

  private cacheWrappedEntropy(vaultId: string, entropy: Uint8Array): void {
    this.dropWrappedEntropy(vaultId);
    this.wrappedEntropy.set(vaultId, entropy.slice());
  }

  private dropWrappedEntropy(vaultId: string): void {
    const existing = this.wrappedEntropy.get(vaultId);
    if (existing != null) zeroBytes(existing);
    this.wrappedEntropy.delete(vaultId);
  }
}

export function lockoutDelayMs(failures: number): number {
  if (!Number.isInteger(failures) || failures < LOCKOUT_FIRST_FAILURE) return 0;
  const doubling = Math.min(failures - LOCKOUT_FIRST_FAILURE, 4);
  return Math.min(LOCKOUT_INITIAL_MS * 2 ** doubling, LOCKOUT_MAX_MS);
}

function requireVaultId(vaultId: string): void {
  if (!vaultIdParamSchema.safeParse({ vaultId }).success) {
    throw new EndpointKeystoreError('storage-invalid', 'Vault id is invalid.');
  }
}

function invalidEndpointState(): EndpointVaultState {
  return {
    status: 'endpoint-keystore-invalid',
    requiredAction: { kind: 'reset-endpoint-keystore' },
  };
}

function sameEndpointPassword(
  left: EndpointPasswordMetadataV1,
  right: EndpointPasswordMetadataV1,
): boolean {
  return (
    left.kdf.algorithm === right.kdf.algorithm &&
    left.kdf.memoryKiB === right.kdf.memoryKiB &&
    left.kdf.iterations === right.kdf.iterations &&
    left.kdf.parallelism === right.kdf.parallelism &&
    left.kdf.salt === right.kdf.salt &&
    left.wrapCheck.algorithm === right.wrapCheck.algorithm &&
    left.wrapCheck.iv === right.wrapCheck.iv &&
    left.wrapCheck.ciphertext === right.wrapCheck.ciphertext
  );
}

function openedVaultReceipt(verified: VerifiedVaultHeaderOpen): OpenedVault {
  return {
    vaultId: verified.vaultId,
    keyId: verified.keyId,
    keyFingerprint: verified.keyFingerprint,
  };
}
