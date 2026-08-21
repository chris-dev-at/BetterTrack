import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { VaultConfig } from '@bettertrack/contracts';

import { EndpointVaultKeystore } from '../../vault/keystore/core';
import type { VaultTransferRuntime } from '../../vault/qr/runtime';
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

describe('VaultTransferActions production entry points', () => {
  it('reaches both the live sender and receive surfaces from Vault settings', async () => {
    const user = userEvent.setup();
    const runtime: VaultTransferRuntime = {
      keystore: new EndpointVaultKeystore(),
      listVaults: vi.fn(async () => [VAULT]),
      fetchHeaderEnvelope: vi.fn(async () => new Uint8Array([1])),
    };

    render(<VaultTransferActions onNotice={vi.fn()} runtime={runtime} />);
    await user.click(screen.getByText('Transfer between devices'));

    expect(await screen.findByText(VAULT.name)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show transfer QR' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 12 words instead' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Receive transferred vault' }));

    expect(screen.getByRole('heading', { name: 'Open a transferred vault' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter 12 words instead' })).toBeInTheDocument();
    expect(runtime.listVaults).toHaveBeenCalledTimes(1);
  });
});
