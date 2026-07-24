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
    const key = await keyForPassphrase(envelope, passphrase, deps);
    try {
      const { header } = await decryptVaultDocument(envelope, key);
      await this.setUnlocked(key, header.keyId, keepUnlocked, deviceId);
    } catch (cause) {
      disposeVaultKey(key);
      throw cause;
    }
  }

  async unlockWithRecoveryKit(
    envelope: Uint8Array,
    recoveryKit: Uint8Array,
    keepUnlocked = false,
    deviceId?: string,
  ): Promise<void> {
    const kit = importRecoveryKit(recoveryKit);
    try {
      const { header } = await decryptVaultDocument(envelope, kit.vaultKey);
      if (kit.keyId !== header.keyId) {
        throw new VaultCryptoError(
          'recovery-kit-invalid',
          'Recovery kit does not match this vault key id.',
        );
      }
      await this.setUnlocked(kit.vaultKey, header.keyId, keepUnlocked, deviceId);
    } catch (cause) {
      disposeVaultKey(kit.vaultKey);
      throw cause;
    }
  }

  async unlockFromDevice(deviceId: string, envelope: Uint8Array): Promise<void> {
    if (this.options.custody == null) {
      throw new VaultCryptoError('custody-failed', 'Device custody is unavailable.');
    }
    const key = await this.options.custody.read(deviceId);
    if (key == null) {
      throw new VaultCryptoError('locked', 'No device vault key is available.');
    }
    try {
      const { header } = await decryptVaultDocument(envelope, key);
      await this.setUnlocked(key, header.keyId, false);
    } catch (cause) {
      await this.options.custody.clear(deviceId);
      throw cause;
    }
  }

  async lock(deviceId?: string): Promise<void> {
    if (this.vaultKey instanceof Uint8Array) disposeVaultKey(this.vaultKey);
    this.vaultKey = null;
    this.keyId = null;
    if (deviceId != null && this.options.custody != null)
      await this.options.custody.clear(deviceId);
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
    if (this.vaultKey instanceof Uint8Array) disposeVaultKey(this.vaultKey);
    this.vaultKey = vaultKey;
    this.keyId = keyId;
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
