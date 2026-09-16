import { zeroBytes } from './bytes';
import {
  decryptVaultDocument,
  deriveVaultKek,
  unwrapVaultKey,
  type VaultCryptoDeps,
} from './crypto';
import { decodeVaultEnvelope } from './envelope';
import { VaultCryptoError } from './errors';
import { importRecoveryKit } from './recovery';

export type VaultLockState = { status: 'locked' } | { status: 'unlocked'; keyId: string };

export interface VaultLockCoreOptions {
  onLock?: () => void;
}

/**
 * UI-independent custody gate. It has no vault-specific timer: an app can call
 * `handleIdle()` from the existing PIN idle-lock event using the same duration.
 *
 * MEMORY ONLY (§12, #1640 residue 3). The vault key lives in this object and
 * nowhere else. The v1 "keep unlocked on this device" convenience that used to
 * persist it as a non-extractable `CryptoKey` — `custody.ts`, the
 * `keepUnlocked` unlock flag, `setUnlocked`'s custody branch and the
 * `unlockFromDevice` read path — was retired here, which is what §12 had
 * claimed all along; `purgeRetiredDeviceCustody()` erases what it left behind.
 * The consequence is deliberate and user-visible: the vault passphrase (or the
 * recovery kit) is required once per session, every session.
 */
export class VaultLockCore {
  private vaultKey: Uint8Array | null = null;
  private keyId: string | null = null;
  /** Every unlock captures this value; lock and competing unlocks invalidate prior work. */
  private unlockGeneration = 0;

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
  ): Promise<void> {
    const generation = this.beginUnlock();
    let key: Uint8Array | undefined;
    try {
      key = await keyForPassphrase(envelope, passphrase, deps);
      const { header } = await decryptVaultDocument(envelope, key);
      this.setUnlocked(generation, key, header.keyId);
    } catch (cause) {
      await this.failUnlock(generation, cause, key);
    }
  }

  async unlockWithRecoveryKit(envelope: Uint8Array, recoveryKit: Uint8Array): Promise<void> {
    const generation = this.beginUnlock();
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
      this.setUnlocked(generation, key, header.keyId);
    } catch (cause) {
      await this.failUnlock(generation, cause, key);
    }
  }

  async lock(): Promise<void> {
    this.unlockGeneration += 1;
    if (this.vaultKey != null) zeroBytes(this.vaultKey);
    this.vaultKey = null;
    this.keyId = null;
    this.options.onLock?.();
  }

  /** The existing PIN idle-lock handler calls this; no second preference exists. */
  async handleIdle(pinLockEnabled: boolean): Promise<void> {
    if (pinLockEnabled) await this.lock();
  }

  withVaultKey<T>(operation: (vaultKey: Uint8Array, keyId: string) => Promise<T> | T): Promise<T> {
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

  private setUnlocked(generation: number, vaultKey: Uint8Array, keyId: string): void {
    // SYNCHRONOUS from the guard to the assignment, with nothing awaited
    // between: a lock landing here bumped the generation already, and the
    // install must not be able to slip past it. (The custody write that used to
    // sit in this window is what made it a window at all.)
    this.requireCurrentUnlock(generation);
    if (this.vaultKey != null && this.vaultKey !== vaultKey) zeroBytes(this.vaultKey);
    this.vaultKey = vaultKey;
    this.keyId = keyId;
  }

  private async failUnlock(
    generation: number,
    cause: unknown,
    candidateKey?: Uint8Array | null,
  ): Promise<never> {
    if (candidateKey != null && candidateKey !== this.vaultKey) zeroBytes(candidateKey);
    if (this.isCurrentUnlock(generation)) await this.lock();
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
