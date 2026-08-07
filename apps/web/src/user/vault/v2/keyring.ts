import type { VaultHeaderDoc } from '@bettertrack/contracts';

import { zeroBytes } from '../bytes';
import type { VaultCryptoDeps } from '../crypto';
import { VaultCryptoError } from '../errors';

import { openVaultHeader, type VaultHeaderSealState } from './headerCrypto';

/**
 * In-memory custody of unlocked vault content keys (`docs/VAULTS_V2_DESIGN.md`
 * §2). One entry per unlocked vault — the whole point of v2 is that vaults
 * unlock independently, so this is a map rather than the v1 singleton.
 *
 * Deliberate properties:
 *  - keys live ONLY here, never in React state, never serialized, never logged;
 *  - `lock()` and `lockAll()` zero the bytes before dropping the reference, so
 *    a later heap snapshot has nothing to find;
 *  - the passphrase is held alongside the key **only** while a vault is
 *    unlocked, because the QR share has to re-emit it. `lock()` clears it too.
 *
 * The idle/PIN lock handler calls {@link VaultKeyring.lockAll}, matching the v1
 * `VaultLockCore.handleIdle` discipline.
 */

export interface UnlockedVault {
  vaultId: string;
  header: VaultHeaderDoc;
  seal: VaultHeaderSealState;
  unlockedAt: number;
}

export type VaultKeyringListener = () => void;

interface Entry {
  vaultId: string;
  contentKey: Uint8Array;
  passphrase: string;
  header: VaultHeaderDoc;
  seal: VaultHeaderSealState;
  unlockedAt: number;
}

export class VaultKeyring {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<VaultKeyringListener>();
  /** Bumped on every mutation so `useSyncExternalStore` sees a new snapshot. */
  private version = 0;
  private snapshot: readonly UnlockedVault[] = [];

  subscribe = (listener: VaultKeyringListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Stable-identity snapshot for `useSyncExternalStore`. */
  getSnapshot = (): readonly UnlockedVault[] => this.snapshot;

  getVersion(): number {
    return this.version;
  }

  isUnlocked(vaultId: string): boolean {
    return this.entries.has(vaultId);
  }

  /**
   * Unlock a vault from its header and 12 words. Rejects with the same opaque
   * `authentication-failed` for a wrong phrase and a tampered header.
   */
  async unlock(
    header: VaultHeaderDoc,
    passphrase: string,
    deps?: VaultCryptoDeps,
  ): Promise<UnlockedVault> {
    const opened = await openVaultHeader(header, passphrase, deps);
    this.lock(header.vaultId);
    const entry: Entry = {
      vaultId: header.vaultId,
      contentKey: opened.contentKey,
      passphrase: passphrase.normalize('NFKD').toLowerCase().trim().replace(/\s+/gu, ' '),
      header: opened.header,
      seal: opened.seal,
      unlockedAt: Date.now(),
    };
    this.entries.set(header.vaultId, entry);
    this.emit();
    return toPublic(entry);
  }

  /**
   * Run an operation with the content key without ever handing it out. The key
   * is a live reference for the duration of the callback only; callers must not
   * retain it.
   */
  withContentKey<T>(
    vaultId: string,
    operation: (contentKey: Uint8Array) => T | Promise<T>,
  ): Promise<T> {
    const entry = this.entries.get(vaultId);
    if (entry == null) {
      return Promise.reject(new VaultCryptoError('locked', 'This vault is locked.'));
    }
    return Promise.resolve(operation(entry.contentKey));
  }

  /**
   * Read back the 12 words for the QR share. Separate from
   * {@link withContentKey} so the one call site that reveals the secret is
   * greppable, and so a future audit can see there is exactly one.
   */
  revealPassphrase(vaultId: string): string {
    const entry = this.entries.get(vaultId);
    if (entry == null) throw new VaultCryptoError('locked', 'This vault is locked.');
    return entry.passphrase;
  }

  /** Replace the cached header after a revision, keeping the vault unlocked. */
  updateHeader(vaultId: string, header: VaultHeaderDoc, seal: VaultHeaderSealState): void {
    const entry = this.entries.get(vaultId);
    if (entry == null) return;
    this.entries.set(vaultId, { ...entry, header, seal });
    this.emit();
  }

  lock(vaultId: string): void {
    const entry = this.entries.get(vaultId);
    if (entry == null) return;
    zeroBytes(entry.contentKey);
    this.entries.delete(vaultId);
    this.emit();
  }

  lockAll(): void {
    if (this.entries.size === 0) return;
    for (const entry of this.entries.values()) zeroBytes(entry.contentKey);
    this.entries.clear();
    this.emit();
  }

  private emit(): void {
    this.version += 1;
    this.snapshot = [...this.entries.values()].map(toPublic);
    for (const listener of this.listeners) listener();
  }
}

function toPublic(entry: Entry): UnlockedVault {
  return {
    vaultId: entry.vaultId,
    header: entry.header,
    seal: entry.seal,
    unlockedAt: entry.unlockedAt,
  };
}
