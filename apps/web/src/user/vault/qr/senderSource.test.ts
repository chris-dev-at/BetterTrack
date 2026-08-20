import { describe, expect, it, vi } from 'vitest';

import type { EndpointVaultKeystore } from '../keystore/core';
import {
  VAULT_TRANSFER_VECTOR_MNEMONIC,
  VAULT_TRANSFER_VECTOR_VAULT_ID,
} from './conformanceVectors';
import { createVaultTransferQrSource } from './senderSource';

class ControlledKeystore implements Pick<
  EndpointVaultKeystore,
  'readMnemonic' | 'subscribeToSessionEnd' | 'verifyDevicePassword' | 'withContentKey'
> {
  readonly mnemonic = deferred<string>();
  readonly readMnemonic = vi.fn((_vaultId: string) => this.mnemonic.promise);
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  subscribeToSessionEnd(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async verifyDevicePassword(_devicePassword: string): Promise<void> {}

  async withContentKey<T>(
    _vaultId: string,
    operation: (
      contentKey: Uint8Array,
      keyId: string,
      assertSessionCurrent: () => void,
    ) => Promise<T> | T,
  ): Promise<T> {
    const generation = this.generation;
    const contentKey = new Uint8Array(32);
    const assertSessionCurrent = () => {
      if (generation !== this.generation) throw new Error('session-ended');
    };
    try {
      const result = await operation(contentKey, 'test-key', assertSessionCurrent);
      assertSessionCurrent();
      return result;
    } finally {
      contentKey.fill(0);
    }
  }

  endSession(): void {
    this.generation += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

describe('createVaultTransferQrSource', () => {
  it('rejects a mnemonic read that crosses live-session revocation', async () => {
    const keystore = new ControlledKeystore();
    const source = createVaultTransferQrSource({
      custody: 'plain',
      keystore,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    });

    const reading = source.readMnemonic();
    await vi.waitFor(() => expect(keystore.readMnemonic).toHaveBeenCalledTimes(1));
    const rejected = expect(reading).rejects.toThrow('session-ended');

    keystore.endSession();
    keystore.mnemonic.resolve(VAULT_TRANSFER_VECTOR_MNEMONIC);

    await rejected;
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
