import type { EndpointVaultKeystore } from '../keystore/core';

interface VaultTransferQrSourceBase {
  /** Local-memory/IndexedDB check only: this never fetches a remote medium. */
  requireLiveUnlock(): Promise<void>;
  /** Reads only while the endpoint keystore session remains live. */
  readMnemonic(): Promise<string>;
  /** Synchronously blanks secret-bearing UI when the keystore session ends. */
  subscribeToSessionEnd(listener: () => void): () => void;
}

export type VaultTransferQrSource =
  | (VaultTransferQrSourceBase & {
      custody: 'wrapped';
      /** Local verification that preserves the already-open content-key session. */
      verifyDevicePassword(devicePassword: string): Promise<void>;
    })
  | (VaultTransferQrSourceBase & {
      custody: 'plain';
    });

export function createVaultTransferQrSource(input: {
  keystore: Pick<
    EndpointVaultKeystore,
    'readMnemonic' | 'subscribeToSessionEnd' | 'verifyDevicePassword' | 'withContentKey'
  >;
  vaultId: string;
  custody: 'wrapped' | 'plain';
}): VaultTransferQrSource {
  const common: VaultTransferQrSourceBase = {
    requireLiveUnlock: () => input.keystore.withContentKey(input.vaultId, () => undefined),
    readMnemonic: () =>
      input.keystore.withContentKey(input.vaultId, async (_contentKey, _keyId, assertCurrent) => {
        const mnemonic = await input.keystore.readMnemonic(input.vaultId);
        assertCurrent();
        return mnemonic;
      }),
    subscribeToSessionEnd: (listener) => input.keystore.subscribeToSessionEnd(listener),
  };
  return input.custody === 'wrapped'
    ? {
        ...common,
        custody: 'wrapped',
        verifyDevicePassword: (devicePassword) =>
          input.keystore.verifyDevicePassword(devicePassword),
      }
    : { ...common, custody: 'plain' };
}
