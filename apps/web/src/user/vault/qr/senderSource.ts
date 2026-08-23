import type { EndpointVaultKeystore } from '../keystore/core';
import { EndpointKeystoreError } from '../keystore/errors';

interface VaultTransferQrSourceBase {
  /**
   * Local-memory/IndexedDB check only: this never fetches a remote medium.
   * Custody is read from the live keystore entry, never caller-supplied metadata.
   * Rejects with a {@link VaultTransferSenderBlockedError} so the surface can
   * tell "unlock first" apart from "this endpoint is locked out until X".
   */
  requireLiveUnlock(): Promise<VaultTransferQrCustody>;
  /** Reads only while the endpoint keystore session remains live. */
  readMnemonic(): Promise<string>;
  /** Synchronously blanks secret-bearing UI when the keystore session ends. */
  subscribeToSessionEnd(listener: () => void): () => void;
  /** Local verification that preserves the already-open content-key session. */
  verifyDevicePassword(devicePassword: string): Promise<void>;
  /**
   * §12's "Forgot the password?" exit. Wipes ONLY this endpoint's stored
   * phrases: server and Drive ciphertext are untouched and no vault data is
   * lost, so the words or a §13 transfer QR restore access.
   */
  resetEndpointKeystore(): Promise<void>;
}

export type VaultTransferQrCustody = 'wrapped' | 'plain';

export type VaultTransferQrSource = VaultTransferQrSourceBase;

/**
 * Why the sender cannot show the code. §12 makes a state without a next action
 * a design bug, so the two reasons stay distinguishable all the way to the UI:
 * `unlock-required` needs an unlock, `locked-out` needs a wait (until
 * {@link retryAt}) or a keystore reset — and saying the former while the vault
 * is demonstrably unlocked is the recorded v2 anti-pattern.
 */
export type VaultTransferSenderBlockReason = 'unlock-required' | 'locked-out';

export class VaultTransferSenderBlockedError extends Error {
  constructor(
    public readonly reason: VaultTransferSenderBlockReason,
    /** Epoch ms the lockout ends; null when the endpoint reports no deadline. */
    public readonly retryAt: number | null = null,
  ) {
    super(`The vault transfer sender is blocked: ${reason}.`);
    this.name = 'VaultTransferSenderBlockedError';
  }
}

export function createVaultTransferQrSource(input: {
  keystore: Pick<
    EndpointVaultKeystore,
    | 'readMnemonic'
    | 'reset'
    | 'stateFor'
    | 'subscribeToSessionEnd'
    | 'verifyDevicePassword'
    | 'withContentKey'
  >;
  vaultId: string;
}): VaultTransferQrSource {
  const requireLiveUnlock = () =>
    input.keystore.withContentKey(input.vaultId, async (_contentKey, _keyId, assertCurrent) => {
      const state = await input.keystore.stateFor(input.vaultId);
      assertCurrent();
      if (state.status === 'stored+plain') return 'plain' as const;
      if (state.status === 'stored+wrapped') {
        if (state.session === 'unlocked') return 'wrapped' as const;
        // K_c can still be LIVE here — the device-password ladder is a separate
        // gate — so folding this into "unlock the vault first" would be a lie.
        if (state.requiredAction.kind === 'wait-or-reset') {
          throw new VaultTransferSenderBlockedError('locked-out', state.requiredAction.retryAt);
        }
      }
      throw new VaultTransferSenderBlockedError('unlock-required');
    });

  const common: VaultTransferQrSourceBase = {
    requireLiveUnlock,
    readMnemonic: () =>
      input.keystore.withContentKey(input.vaultId, async (_contentKey, _keyId, assertCurrent) => {
        const mnemonic = await input.keystore.readMnemonic(input.vaultId);
        assertCurrent();
        return mnemonic;
      }),
    subscribeToSessionEnd: (listener) => input.keystore.subscribeToSessionEnd(listener),
    verifyDevicePassword: async (devicePassword) => {
      try {
        await input.keystore.verifyDevicePassword(devicePassword);
      } catch (cause) {
        // The attempt that TRIPS the ladder reports the lockout here, not on the
        // next `stateFor` — attempt five has to say so instead of repeating
        // "wrong password" with no deadline and no way out.
        if (cause instanceof EndpointKeystoreError && cause.code === 'locked-out') {
          throw new VaultTransferSenderBlockedError('locked-out', cause.details.retryAt ?? null);
        }
        throw cause;
      }
    },
    resetEndpointKeystore: async () => {
      await input.keystore.reset();
    },
  };
  return common;
}
