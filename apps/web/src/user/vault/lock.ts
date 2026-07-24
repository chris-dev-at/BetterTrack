import { disposeVaultKey, type DeviceVaultCustody } from './custody';
import {
  decryptVaultDocument,
  deriveVaultKek,
  unwrapVaultKey,
  type VaultCryptoDeps,
  type VaultKeyMaterial,
} from './crypto';
import { decodeVaultEnvelope } from './envelope';
import { VaultCryptoError } from './errors';
import { importRecoveryKit } from './recovery';

export type VaultLockState = { status: 'locked' } | { status: 'unlocked'; keyId: string };

export interface VaultLockCoreOptions {
  custody?: DeviceVaultCustody;
  onLock?: () => void;
}

/**
 * UI-independent custody gate. It has no vault-specific timer: an app can call
 * `handleIdle()` from the existing PIN idle-lock event using the same duration.
 */
export class VaultLockCore {
  private vaultKey: VaultKeyMaterial | null = null;
  private keyId: string | null = null;
  /** Device custody must be cleared by every lock, even when the caller has no id. */
  private custodyDeviceId: string | null = null;
  /** Every unlock captures this value; lock and competing unlocks invalidate prior work. */
  private unlockGeneration = 0;
  /** Tracks persisted and in-flight custody IDs so locks can revoke both synchronously. */
  private readonly custodyOwners = new Map<string, number>();
  /** Serializes device-key writes and removals so stale work cannot clear newer custody. */
  private custodyMutation: Promise<void> = Promise.resolve();

  constructor(private readonly options: VaultLockCoreOptions = {}) {}

  get state(): VaultLockState {
    return this.vaultKey == null || this.keyId == null
      ? { status: 'locked' }
      : { status: 'unlocked', keyId: this.keyId };
  }

  async unlockWithPassphrase(
    envelope: Uint8Array,
    passphrase: string,
    deps?: VaultCryptoDeps,
    keepUnlocked = false,
    deviceId?: string,
  ): Promise<void> {
    const generation = this.beginUnlock();
    if (keepUnlocked && deviceId != null) this.claimCustody(deviceId, generation);
    let key: Uint8Array | undefined;
    try {
      key = await keyForPassphrase(envelope, passphrase, deps);
      const { header } = await decryptVaultDocument(envelope, key);
      await this.setUnlocked(generation, key, header.keyId, keepUnlocked, deviceId);
    } catch (cause) {
      await this.failUnlock(generation, cause, key, deviceId);
    }
  }

  async unlockWithRecoveryKit(
    envelope: Uint8Array,
    recoveryKit: Uint8Array,
    keepUnlocked = false,
    deviceId?: string,
  ): Promise<void> {
    const generation = this.beginUnlock();
    if (keepUnlocked && deviceId != null) this.claimCustody(deviceId, generation);
    let key: Uint8Array | undefined;
    try {
      const kit = importRecoveryKit(recoveryKit);
      key = kit.vaultKey;
      const { header } = await decryptVaultDocument(envelope, key);
      if (kit.keyId !== header.keyId) {
        throw new VaultCryptoError(
          'recovery-kit-invalid',
          'Recovery kit does not match this vault key id.',
        );
      }
      await this.setUnlocked(generation, key, header.keyId, keepUnlocked, deviceId);
    } catch (cause) {
      await this.failUnlock(generation, cause, key, deviceId);
    }
  }

  async unlockFromDevice(deviceId: string, envelope: Uint8Array): Promise<void> {
    const generation = this.beginUnlock();
    this.claimCustody(deviceId, generation);
    let key: CryptoKey | null | undefined;
    try {
      if (this.options.custody == null) {
        throw new VaultCryptoError('custody-failed', 'Device custody is unavailable.');
      }
      key = await this.options.custody.read(deviceId);
      if (key == null) {
        throw new VaultCryptoError('locked', 'No device vault key is available.');
      }
      const { header } = await decryptVaultDocument(envelope, key);
      await this.setUnlocked(generation, key, header.keyId, false, deviceId);
    } catch (cause) {
      await this.failUnlock(generation, cause, key, deviceId);
    }
  }

  async lock(deviceId?: string): Promise<void> {
    this.unlockGeneration += 1;
    const custodyDeviceIds = new Set(
      [this.custodyDeviceId, deviceId, ...this.custodyOwners.keys()].filter(
        (value): value is string => value != null,
      ),
    );
    if (this.vaultKey instanceof Uint8Array) disposeVaultKey(this.vaultKey);
    this.vaultKey = null;
    this.keyId = null;
    this.custodyDeviceId = null;
    await this.clearCustody(custodyDeviceIds);
    this.options.onLock?.();
  }

  /** The existing PIN idle-lock handler calls this; no second preference exists. */
  async handleIdle(pinLockEnabled: boolean, deviceId?: string): Promise<void> {
    if (pinLockEnabled) await this.lock(deviceId);
  }

  withVaultKey<T>(
    operation: (vaultKey: VaultKeyMaterial, keyId: string) => Promise<T> | T,
  ): Promise<T> {
    if (this.vaultKey == null || this.keyId == null) {
      return Promise.reject(new VaultCryptoError('locked', 'Vault is locked.'));
    }
    return Promise.resolve(operation(this.vaultKey, this.keyId));
  }

  private beginUnlock(): number {
    this.unlockGeneration += 1;
    return this.unlockGeneration;
  }

  private isCurrentUnlock(generation: number): boolean {
    return this.unlockGeneration === generation;
  }

  private requireCurrentUnlock(generation: number): void {
    if (!this.isCurrentUnlock(generation)) {
      throw new VaultCryptoError('locked', 'Vault unlock was cancelled.');
    }
  }

  private claimCustody(deviceId: string, generation: number): void {
    this.custodyOwners.set(deviceId, generation);
  }

  private async setUnlocked(
    generation: number,
    vaultKey: VaultKeyMaterial,
    keyId: string,
    keepUnlocked: boolean,
    deviceId?: string,
  ): Promise<void> {
    this.requireCurrentUnlock(generation);
    if (keepUnlocked) {
      if (deviceId == null || this.options.custody == null) {
        throw new VaultCryptoError('custody-failed', 'Device custody is unavailable.');
      }
      if (!(vaultKey instanceof Uint8Array)) {
        throw new VaultCryptoError(
          'custody-failed',
          'Only freshly unlocked vault keys may be persisted.',
        );
      }
      if (!(await this.persistCustody(deviceId, vaultKey, generation))) {
        throw new VaultCryptoError('locked', 'Vault unlock was cancelled.');
      }
    }

    this.requireCurrentUnlock(generation);
    const nextCustodyDeviceId =
      keepUnlocked || !(vaultKey instanceof Uint8Array) ? (deviceId ?? null) : null;
    if (this.custodyDeviceId != null && this.custodyDeviceId !== nextCustodyDeviceId) {
      await this.clearReplacedCustody(
        this.custodyDeviceId,
        this.custodyOwners.get(this.custodyDeviceId),
      );
      this.requireCurrentUnlock(generation);
    }

    if (this.vaultKey instanceof Uint8Array) disposeVaultKey(this.vaultKey);
    this.vaultKey = vaultKey;
    this.keyId = keyId;
    this.custodyDeviceId = nextCustodyDeviceId;
    if (nextCustodyDeviceId != null) this.claimCustody(nextCustodyDeviceId, generation);
  }

  private async persistCustody(
    deviceId: string,
    vaultKey: Uint8Array,
    generation: number,
  ): Promise<boolean> {
    if (this.options.custody == null) return false;
    return this.enqueueCustodyMutation(async () => {
      if (!this.isCurrentUnlock(generation) || this.custodyOwners.get(deviceId) !== generation) {
        return false;
      }
      await this.options.custody!.persist(deviceId, vaultKey);
      return this.isCurrentUnlock(generation) && this.custodyOwners.get(deviceId) === generation;
    });
  }

  private async clearCustody(deviceIds: Set<string>): Promise<void> {
    for (const deviceId of deviceIds) {
      this.custodyOwners.delete(deviceId);
      await this.enqueueCustodyMutation(async () => {
        await this.options.custody?.clear(deviceId);
      });
    }
  }

  private async clearReplacedCustody(
    deviceId: string,
    ownerGeneration: number | undefined,
  ): Promise<void> {
    await this.enqueueCustodyMutation(async () => {
      if (ownerGeneration != null && this.custodyOwners.get(deviceId) !== ownerGeneration) return;
      this.custodyOwners.delete(deviceId);
      await this.options.custody?.clear(deviceId);
    });
  }

  private async clearStaleCustody(deviceId: string | undefined, generation: number): Promise<void> {
    if (deviceId == null) return;
    await this.clearReplacedCustody(deviceId, generation);
  }

  private enqueueCustodyMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const queued = this.custodyMutation.then(mutation);
    this.custodyMutation = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async failUnlock(
    generation: number,
    cause: unknown,
    candidateKey?: VaultKeyMaterial | null,
    deviceId?: string,
  ): Promise<never> {
    if (candidateKey instanceof Uint8Array && candidateKey !== this.vaultKey) {
      disposeVaultKey(candidateKey);
    }
    if (this.isCurrentUnlock(generation)) await this.lock(deviceId);
    else await this.clearStaleCustody(deviceId, generation);
    throw cause;
  }
}

async function keyForPassphrase(
  envelope: Uint8Array,
  passphrase: string,
  deps?: VaultCryptoDeps,
): Promise<Uint8Array> {
  const header = decodeVaultEnvelope(envelope).header;
  const wrapper = header.wrappedKeys.find((entry) => entry.keyId === header.keyId);
  if (wrapper == null) {
    throw new VaultCryptoError('envelope-invalid', 'Vault has no active wrapped key.');
  }
  const kek = await deriveVaultKek(passphrase, wrapper.kdf, deps);
  try {
    return await unwrapVaultKey(wrapper, header.keyId, kek);
  } finally {
    kek.fill(0);
  }
}
