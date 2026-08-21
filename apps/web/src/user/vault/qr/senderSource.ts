import type { EndpointVaultKeystore } from '../keystore/core';

interface VaultTransferQrSourceBase {
  /**
   * Local-memory/IndexedDB check only: this never fetches a remote medium.
   * Custody is read from the live keystore entry, never caller-supplied metadata.
   */
  requireLiveUnlock(): Promise<VaultTransferQrCustody>;
  /** Reads only while the endpoint keystore session remains live. */
  readMnemonic(): Promise<string>;
  /** Synchronously blanks secret-bearing UI when the keystore session ends. */
  subscribeToSessionEnd(listener: () => void): () => void;
  /** Local verification that preserves the already-open content-key session. */
  verifyDevicePassword(devicePassword: string): Promise<void>;
}

export type VaultTransferQrCustody = 'wrapped' | 'plain';

export type VaultTransferQrSource = VaultTransferQrSourceBase;

export function createVaultTransferQrSource(input: {
  keystore: Pick<
    EndpointVaultKeystore,
    | 'readMnemonic'
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
      if (state.status === 'stored+wrapped' && state.session === 'unlocked') {
        return 'wrapped' as const;
      }
      throw new Error('The vault does not have a live endpoint-keystore session.');
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
    verifyDevicePassword: (devicePassword) => input.keystore.verifyDevicePassword(devicePassword),
  };
  return common;
}
