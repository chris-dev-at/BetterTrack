import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { VaultConfig } from '@bettertrack/contracts';

import { EndpointVaultKeystore } from '../../vault/keystore/core';
import type { OpenedVault } from '../../vault/keystore/types';
import { VAULT_TRANSFER_GOLDEN_PAYLOAD, VAULT_TRANSFER_VECTOR_MNEMONIC } from '../../vault/qr';
import { createVaultTransferRuntime } from '../../vault/qr/runtime';
import { VaultTransferActions } from './VaultTransferActions';

const VAULT: VaultConfig = {
  id: '018f6a3e-1111-7000-8000-000000000001',
  name: 'Phone vault',
  headerDocId: '018f6a3e-2222-7000-8000-000000000001',
  commonDocId: '018f6a3e-2222-7000-8000-000000000002',
  media: ['server'],
  driveConnectionId: null,
  keyFingerprint: 'AbCdEfGhIjKlMn_o',
  retirementProofPublicKey: 'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  retirementGeneration: 0,
  mediaAttestedAt: null,
  mediaAttestedDriveConnectionId: null,
  createdAt: '2026-08-20T12:00:00.000Z',
  updatedAt: '2026-08-20T12:00:00.000Z',
};

class LiveTransferKeystore extends EndpointVaultKeystore {
  private opened = false;

  override async storeAfterVerifiedOpen(): Promise<OpenedVault> {
    this.opened = true;
    return {
      vaultId: VAULT.id,
      keyId: '018f6a3e-3333-7000-8000-000000000001',
      keyFingerprint: VAULT.keyFingerprint,
    };
  }

  override async stateFor() {
    return this.opened
      ? {
          status: 'stored+wrapped' as const,
          session: 'unlocked' as const,
          requiredAction: { kind: 'open-silently' as const },
        }
      : {
          status: 'not-on-this-endpoint' as const,
          requiredAction: {
            kind: 'provide-phrase' as const,
            methods: ['enter-words', 'scan-qr'] as const,
          },
        };
  }

  override async readMnemonic(): Promise<string> {
    if (!this.opened) throw new Error('locked');
    return VAULT_TRANSFER_VECTOR_MNEMONIC;
  }

  override async verifyDevicePassword(): Promise<void> {}

  override async withContentKey<T>(
    _vaultId: string,
    operation: (
      contentKey: Uint8Array,
      keyId: string,
      assertSessionCurrent: () => void,
    ) => Promise<T> | T,
  ): Promise<T> {
    if (!this.opened) throw new Error('locked');
    const contentKey = new Uint8Array(32);
    return operation(contentKey, '018f6a3e-3333-7000-8000-000000000001', () => undefined);
  }
}

class LockedTransferKeystore extends EndpointVaultKeystore {
  private unlocked = false;
  private opened = false;

  override async stateFor() {
    return this.unlocked
      ? {
          status: 'stored+wrapped' as const,
          session: 'unlocked' as const,
          requiredAction: { kind: 'open-silently' as const },
        }
      : {
          status: 'stored+wrapped' as const,
          session: 'locked' as const,
          requiredAction: {
            kind: 'unlock' as const,
            credential: 'device-password' as const,
          },
        };
  }

  override async unlock(devicePassword: string) {
    if (devicePassword !== 'correct endpoint password') throw new Error('wrong password');
    this.unlocked = true;
    return { unlockedVaultIds: [VAULT.id] };
  }

  override async openStoredVault(): Promise<OpenedVault> {
    if (!this.unlocked) throw new Error('locked');
    this.opened = true;
    return {
      vaultId: VAULT.id,
      keyId: '018f6a3e-3333-7000-8000-000000000001',
      keyFingerprint: VAULT.keyFingerprint,
    };
  }

  override async withContentKey<T>(
    _vaultId: string,
    operation: (
      contentKey: Uint8Array,
      keyId: string,
      assertSessionCurrent: () => void,
    ) => Promise<T> | T,
  ): Promise<T> {
    if (!this.opened) throw new Error('locked');
    return operation(new Uint8Array(32), '018f6a3e-3333-7000-8000-000000000001', () => undefined);
  }

  override async readMnemonic(): Promise<string> {
    return VAULT_TRANSFER_VECTOR_MNEMONIC;
  }

  override async verifyDevicePassword(): Promise<void> {}
}

describe('VaultTransferActions production entry points', () => {
  it('reaches both the live sender and receive surfaces from Vault settings', async () => {
    const user = userEvent.setup();
    const runtime = createVaultTransferRuntime({
      keystore: new LiveTransferKeystore(),
      requestJson: vi.fn(async () => ({ vaults: [VAULT] })),
      bindLockSignal: false,
    });

    render(<VaultTransferActions onNotice={vi.fn()} runtime={runtime} />);
    await user.click(screen.getByText('Transfer between devices'));

    expect(await screen.findByText(VAULT.name)).toBeInTheDocument();
    expect(await screen.findByText(/phrase is not stored on this device/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Receive transferred vault' }));

    expect(screen.getByRole('heading', { name: 'Open a transferred vault' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter 12 words instead' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Transfer code'), VAULT_TRANSFER_GOLDEN_PAYLOAD);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Device password'), 'new endpoint password');
    await user.click(screen.getByRole('button', { name: 'Verify and open vault' }));

    expect(runtime.isVaultOpen(VAULT.id)).toBe(true);
    expect(
      screen.queryByRole('heading', { name: 'Open a transferred vault' }),
    ).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Show transfer QR' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 12 words instead' })).toBeInTheDocument();

    runtime.endSession();

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Show transfer QR' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/vault session was locked/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen for transfer' })).toBeInTheDocument();
  });

  it('opens an existing wrapped endpoint entry before enabling the sender', async () => {
    const user = userEvent.setup();
    const runtime = createVaultTransferRuntime({
      keystore: new LockedTransferKeystore(),
      requestJson: vi.fn(async () => ({ vaults: [VAULT] })),
      bindLockSignal: false,
    });

    render(<VaultTransferActions onNotice={vi.fn()} runtime={runtime} />);
    await user.click(screen.getByText('Transfer between devices'));

    const password = await screen.findByLabelText('Device password');
    await user.type(password, 'correct endpoint password');
    await user.click(screen.getByRole('button', { name: 'Unlock for transfer' }));

    expect(await screen.findByRole('button', { name: 'Show transfer QR' })).toBeInTheDocument();
    expect(runtime.isVaultOpen(VAULT.id)).toBe(true);
  });
});
