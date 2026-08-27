import { describe, expect, it, vi } from 'vitest';

import type { EndpointVaultKeystore } from '../keystore/core';
import { EndpointKeystoreError } from '../keystore/errors';
import type { EndpointVaultState, KeystoreResetResult } from '../keystore/types';
import {
  VAULT_TRANSFER_VECTOR_MNEMONIC,
  VAULT_TRANSFER_VECTOR_VAULT_ID,
} from './conformanceVectors';
import { createVaultTransferQrSource, VaultTransferSenderBlockedError } from './senderSource';

const RETRY_AT = 1_800_000_000_000;

class ControlledKeystore implements Pick<
  EndpointVaultKeystore,
  | 'readMnemonic'
  | 'reset'
  | 'stateFor'
  | 'subscribeToSessionEnd'
  | 'verifyDevicePassword'
  | 'withContentKey'
> {
  readonly mnemonic = deferred<string>();
  readonly readMnemonic = vi.fn((_vaultId: string) => this.mnemonic.promise);
  readonly reset = vi.fn(
    async (): Promise<KeystoreResetResult> => ({
      scope: 'this-endpoint-only',
      storedPhrases: 'removed',
      remoteVaultCopies: 'server-and-drive-untouched',
      vaultDataLost: false,
      nextAction: 're-enter-words-or-scan-qr',
    }),
  );
  /** Swapped by the lockout cases; the content-key session stays live either way. */
  state: EndpointVaultState = {
    status: 'stored+plain',
    requiredAction: { kind: 'open-silently' },
  };
  verifyDevicePassword = vi.fn(async (_devicePassword: string): Promise<void> => {});
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  subscribeToSessionEnd(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async stateFor(): Promise<EndpointVaultState> {
    return this.state;
  }

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

  it('reports a device-password lockout as such while the content key is still live', async () => {
    const keystore = new ControlledKeystore();
    keystore.state = {
      status: 'stored+wrapped',
      session: 'locked',
      requiredAction: {
        kind: 'wait-or-reset',
        retryAt: RETRY_AT,
        alternative: 'reset-endpoint-keystore',
      },
    };
    const source = createVaultTransferQrSource({
      keystore,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    });

    const blocked = await source.requireLiveUnlock().catch((cause: unknown) => cause);

    expect(blocked).toBeInstanceOf(VaultTransferSenderBlockedError);
    expect(blocked).toMatchObject({ reason: 'locked-out', retryAt: RETRY_AT });
  });

  it('keeps a plain unlock-required refusal distinguishable from the lockout', async () => {
    const keystore = new ControlledKeystore();
    keystore.state = {
      status: 'stored+wrapped',
      session: 'locked',
      requiredAction: { kind: 'unlock', credential: 'device-password' },
    };
    const source = createVaultTransferQrSource({
      keystore,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    });

    const blocked = await source.requireLiveUnlock().catch((cause: unknown) => cause);

    expect(blocked).toBeInstanceOf(VaultTransferSenderBlockedError);
    expect(blocked).toMatchObject({ reason: 'unlock-required', retryAt: null });
  });

  it('translates the lockout that the step-up attempt itself trips', async () => {
    const keystore = new ControlledKeystore();
    keystore.verifyDevicePassword = vi.fn(async () => {
      throw new EndpointKeystoreError('locked-out', 'locked', { failures: 5, retryAt: RETRY_AT });
    });
    const source = createVaultTransferQrSource({
      keystore,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    });

    const blocked = await source.verifyDevicePassword('wrong').catch((cause: unknown) => cause);

    expect(blocked).toBeInstanceOf(VaultTransferSenderBlockedError);
    expect(blocked).toMatchObject({ reason: 'locked-out', retryAt: RETRY_AT });
  });

  it('leaves a plain wrong-password failure untranslated', async () => {
    const keystore = new ControlledKeystore();
    keystore.verifyDevicePassword = vi.fn(async () => {
      throw new EndpointKeystoreError('wrong-password', 'nope', { failures: 1 });
    });
    const source = createVaultTransferQrSource({
      keystore,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    });

    const rejected = await source.verifyDevicePassword('wrong').catch((cause: unknown) => cause);

    expect(rejected).toBeInstanceOf(EndpointKeystoreError);
    expect(rejected).toMatchObject({ code: 'wrong-password' });
  });

  it('exposes the §12 keystore reset as the sender-side forgot-password exit', async () => {
    const keystore = new ControlledKeystore();
    const source = createVaultTransferQrSource({
      keystore,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    });

    await source.resetEndpointKeystore();

    expect(keystore.reset).toHaveBeenCalledTimes(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
