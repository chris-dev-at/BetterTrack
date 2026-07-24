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
    let key: Uint8Array | undefined;
    try {
      key = await keyForPassphrase(envelope, passphrase, deps);
      const { header } = await decryptVaultDocument(envelope, key);
      await this.setUnlocked(key, header.keyId, keepUnlocked, deviceId);
    } catch (cause) {
      await this.failUnlock(cause, key, deviceId);
    }
  }

  async unlockWithRecoveryKit(
    envelope: Uint8Array,
    recoveryKit: Uint8Array,
    keepUnlocked = false,
    deviceId?: string,
  ): Promise<void> {
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
      await this.setUnlocked(key, header.keyId, keepUnlocked, deviceId);
    } catch (cause) {
      await this.failUnlock(cause, key, deviceId);
    }
  }

  async unlockFromDevice(deviceId: string, envelope: Uint8Array): Promise<void> {
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
      await this.setUnlocked(key, header.keyId, false, deviceId);
    } catch (cause) {
      await this.failUnlock(cause, key, deviceId);
    }
  }

  async lock(deviceId?: string): Promise<void> {
    const custodyDeviceIds = new Set(
      [this.custodyDeviceId, deviceId].filter((value): value is string => value != null),
    );
    if (this.vaultKey instanceof Uint8Array) disposeVaultKey(this.vaultKey);
    this.vaultKey = null;
    this.keyId = null;
    this.custodyDeviceId = null;
    if (this.options.custody != null) {
      for (const activeDeviceId of custodyDeviceIds)
        await this.options.custody.clear(activeDeviceId);
    }
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

  private async setUnlocked(
    vaultKey: VaultKeyMaterial,
    keyId: string,
    keepUnlocked: boolean,
    deviceId?: string,
  ): Promise<void> {
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
      await this.options.custody.persist(deviceId, vaultKey);
    }

    const nextCustodyDeviceId =
      keepUnlocked || !(vaultKey instanceof Uint8Array) ? (deviceId ?? null) : null;
    if (
      this.custodyDeviceId != null &&
      this.custodyDeviceId !== nextCustodyDeviceId &&
      this.options.custody != null
    ) {
      await this.options.custody.clear(this.custodyDeviceId);
    }

    if (this.vaultKey instanceof Uint8Array) disposeVaultKey(this.vaultKey);
    this.vaultKey = vaultKey;
    this.keyId = keyId;
    this.custodyDeviceId = nextCustodyDeviceId;
  }

  private async failUnlock(
    cause: unknown,
    candidateKey?: VaultKeyMaterial | null,
    deviceId?: string,
  ): Promise<never> {
    if (candidateKey instanceof Uint8Array && candidateKey !== this.vaultKey) {
      disposeVaultKey(candidateKey);
    }
    await this.lock(deviceId);
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
