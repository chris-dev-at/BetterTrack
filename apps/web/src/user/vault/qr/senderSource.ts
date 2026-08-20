import type { EndpointVaultKeystore } from '../keystore/core';

interface VaultTransferQrSourceBase {
  /** Local-memory/IndexedDB check only: this never fetches a remote medium. */
  requireLiveUnlock(): Promise<void>;
  /** Reads only from the already-unlocked endpoint keystore. */
  readMnemonic(): Promise<string>;
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
  keystore: Pick<EndpointVaultKeystore, 'readMnemonic' | 'verifyDevicePassword' | 'withContentKey'>;
  vaultId: string;
  custody: 'wrapped' | 'plain';
}): VaultTransferQrSource {
  const common: VaultTransferQrSourceBase = {
    requireLiveUnlock: () => input.keystore.withContentKey(input.vaultId, () => undefined),
    readMnemonic: () => input.keystore.readMnemonic(input.vaultId),
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
