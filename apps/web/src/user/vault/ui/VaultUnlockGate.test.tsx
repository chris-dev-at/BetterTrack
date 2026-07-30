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

const auth = vi.hoisted(() => ({
  user: { username: 'ada' } as { username: string } | null,
  logout: vi.fn(async () => undefined),
}));

vi.mock('../VaultRuntimeProvider', () => ({
  useVaultRuntime: () => runtime,
}));

vi.mock('../../AuthContext', () => ({
  useAuth: () => auth,
}));

import { VaultUnlockGate } from './VaultUnlockGate';

beforeEach(() => {
  vi.clearAllMocks();
  runtime.phase = 'locked';
  runtime.unlockFromDevice.mockResolvedValue(false);
  runtime.unlockWithPassphrase.mockResolvedValue({});
  auth.user = { username: 'ada' };
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

  it('is never a dead end: signing out is always available, like the PIN gate', async () => {
    const user = userEvent.setup();
    render(<VaultUnlockGate mediaSet={['server']} />);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('offers the §3 destruction exit only after the username is typed', async () => {
    const onStartFresh = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<VaultUnlockGate mediaSet={['server']} onStartFresh={onStartFresh} />);

    const action = screen.getByRole('button', { name: 'Discard the vault and start fresh' });
    expect(action).toBeDisabled();

    await user.type(screen.getByLabelText(/Type your username \(ada\)/), 'adam');
    expect(action).toBeDisabled();

    await user.clear(screen.getByLabelText(/Type your username \(ada\)/));
    await user.type(screen.getByLabelText(/Type your username \(ada\)/), 'ada');
    expect(action).toBeEnabled();

    await user.click(action);
    expect(onStartFresh).toHaveBeenCalledTimes(1);
  });

  it('tells a Drive vault owner that the leftover ciphertext is theirs to remove', () => {
    render(<VaultUnlockGate mediaSet={['drive']} onStartFresh={vi.fn(async () => undefined)} />);

    expect(screen.getByText(/bettertrack-vault file from Drive/i)).toBeInTheDocument();
  });

  it('says nothing about Drive for a server-only vault', () => {
    render(<VaultUnlockGate mediaSet={['server']} onStartFresh={vi.fn(async () => undefined)} />);

    expect(screen.queryByText(/bettertrack-vault file from Drive/i)).not.toBeInTheDocument();
  });

  it('keeps the gate usable when discarding the vault fails', async () => {
    const onStartFresh = vi.fn(async () => {
      throw new Error('offline');
    });
    const user = userEvent.setup();
    render(<VaultUnlockGate mediaSet={['server']} onStartFresh={onStartFresh} />);

    await user.type(screen.getByLabelText(/Type your username \(ada\)/), 'ada');
    await user.click(screen.getByRole('button', { name: 'Discard the vault and start fresh' }));

    expect(await screen.findByText(/could not be discarded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard the vault and start fresh' })).toBeEnabled();
    // Unlocking is still the primary path — the failed exit changed nothing.
    expect(screen.getByLabelText('Vault passphrase')).toBeEnabled();
  });

  it('does not offer destruction when no exit was wired up', () => {
    render(<VaultUnlockGate mediaSet={['server']} />);

    expect(screen.queryByText('Can’t unlock this vault?')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Discard the vault and start fresh' }),
    ).not.toBeInTheDocument();
  });
});
