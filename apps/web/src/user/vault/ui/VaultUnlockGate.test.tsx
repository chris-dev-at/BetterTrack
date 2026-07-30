import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VaultCryptoError } from '../errors';

const runtime = vi.hoisted(() => ({
  phase: 'locked' as 'locked' | 'unlocking' | 'unlocked',
  unlockFromDevice: vi.fn(async () => false),
  unlockWithPassphrase: vi.fn(async () => ({})),
  unlockWithRecoveryKit: vi.fn(async () => ({})),
}));

vi.mock('../VaultRuntimeProvider', () => ({
  useVaultRuntime: () => runtime,
}));

import { VaultUnlockGate } from './VaultUnlockGate';

beforeEach(() => {
  vi.clearAllMocks();
  runtime.phase = 'locked';
  runtime.unlockFromDevice.mockResolvedValue(false);
  runtime.unlockWithPassphrase.mockResolvedValue({});
});

describe('VaultUnlockGate', () => {
  it('tries trusted-device custody once, then authenticates Drive-only with the explicit choice', async () => {
    const user = userEvent.setup();
    render(<VaultUnlockGate mediaSet={['drive']} />);

    await waitFor(() =>
      expect(runtime.unlockFromDevice).toHaveBeenCalledWith({
        authorizeDrive: false,
        driveOnly: false,
      }),
    );

    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse battery staple');
    await user.click(screen.getByRole('checkbox', { name: /Keep unlocked on this device/i }));
    await user.click(screen.getByRole('button', { name: 'Unlock vault' }));

    expect(runtime.unlockWithPassphrase).toHaveBeenCalledWith('correct horse battery staple', {
      authorizeDrive: true,
      driveOnly: true,
      keepUnlocked: true,
    });
  });

  it('fails closed with specific copy after an authenticated unlock failure', async () => {
    runtime.unlockWithPassphrase.mockRejectedValue(
      new VaultCryptoError('authentication-failed', 'secret detail'),
    );
    const user = userEvent.setup();
    render(<VaultUnlockGate mediaSet={['server']} />);

    await user.type(screen.getByLabelText('Vault passphrase'), 'wrong passphrase');
    await user.click(screen.getByRole('button', { name: 'Unlock vault' }));

    expect(await screen.findByText(/vault passphrase is incorrect/i)).toBeInTheDocument();
    expect(screen.queryByText('secret detail')).not.toBeInTheDocument();
  });

  it('says so when the chosen recovery kit cannot be read at all', async () => {
    const file = new File(['kit'], 'bettertrack-recovery-kit.txt', { type: 'text/plain' });
    // A removed medium / denied permission: the read rejects (jsdom's File has
    // no arrayBuffer of its own, so install the failing one).
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.reject(new DOMException('The file could not be read.')),
    });
    const user = userEvent.setup();
    render(<VaultUnlockGate mediaSet={['server']} />);

    await user.upload(screen.getByLabelText('Use a recovery kit'), file);

    expect(await screen.findByText(/file could not be read/i)).toBeInTheDocument();
    // The gate stays closed: no kit is armed, so the passphrase is still required.
    expect(screen.getByRole('button', { name: 'Unlock vault' })).toBeDisabled();
    expect(runtime.unlockWithRecoveryKit).not.toHaveBeenCalled();
  });
});
