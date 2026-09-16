import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VaultCryptoError } from '../errors';

const runtime = vi.hoisted(() => ({
  phase: 'locked' as 'locked' | 'unlocking' | 'unlocked',
  unlockWithPassphrase: vi.fn(async () => ({})),
  unlockWithRecoveryKit: vi.fn(async () => ({})),
  prepareDriveStorage: vi.fn(async () => undefined),
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

vi.mock('../../../lib/twoFactorApi', () => ({ getTwoFactorStatus: vi.fn() }));

import { getTwoFactorStatus } from '../../../lib/twoFactorApi';
import { VaultUnlockGate } from './VaultUnlockGate';

function renderGate(props: Parameters<typeof VaultUnlockGate>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VaultUnlockGate {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.phase = 'locked';
  runtime.unlockWithPassphrase.mockResolvedValue({});
  runtime.prepareDriveStorage.mockResolvedValue(undefined);
  auth.user = { username: 'ada' };
  vi.mocked(getTwoFactorStatus).mockResolvedValue({
    totpEnabled: false,
    totpPending: false,
    emailEnabled: false,
    recoveryCodesRemaining: 0,
  });
});

describe('VaultUnlockGate', () => {
  it('renders a 2FA-status read failure without hiding the password fallback', async () => {
    vi.mocked(getTwoFactorStatus).mockRejectedValue(new Error('status unavailable'));
    renderGate({ mediaSet: ['server'], onStartFresh: vi.fn(async () => undefined) });

    expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
    expect(screen.getByLabelText('Current account password')).toBeInTheDocument();
  });

  /**
   * #1640 residue 3: §12's retirement of v1's persisted-VK convenience, on the
   * surface that shipped it. The checkbox is gone, so is the silent
   * trusted-device attempt this gate used to fire at mount, and an unlock can no
   * longer be asked to keep anything — the passphrase is required every session.
   */
  it('offers no keep-unlocked choice and never unlocks from a persisted key', async () => {
    const user = userEvent.setup();
    renderGate({ mediaSet: ['drive'] });

    expect(screen.queryByRole('checkbox', { name: /keep unlocked/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/keep unlocked/i)).not.toBeInTheDocument();
    expect('unlockFromDevice' in runtime).toBe(false);

    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse battery staple');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unlock vault' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Unlock vault' }));

    expect(runtime.unlockWithPassphrase).toHaveBeenCalledWith('correct horse battery staple', {
      authorizeDrive: true,
      driveOnly: true,
    });
  });

  it('preloads GIS before enabling a fresh Drive-only unlock gesture', async () => {
    let finishPreparation!: () => void;
    runtime.prepareDriveStorage.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishPreparation = () => resolve(undefined);
        }),
    );
    const user = userEvent.setup();
    renderGate({ mediaSet: ['drive'] });

    await waitFor(() => expect(runtime.prepareDriveStorage).toHaveBeenCalledOnce());
    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse battery staple');
    expect(screen.getByRole('button', { name: 'Unlock vault' })).toBeDisabled();

    finishPreparation();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Unlock vault' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Unlock vault' }));

    expect(runtime.unlockWithPassphrase).toHaveBeenCalledWith('correct horse battery staple', {
      authorizeDrive: true,
      driveOnly: true,
    });
  });

  it('fails closed with specific copy after an authenticated unlock failure', async () => {
    runtime.unlockWithPassphrase.mockRejectedValue(
      new VaultCryptoError('authentication-failed', 'secret detail'),
    );
    const user = userEvent.setup();
    renderGate({ mediaSet: ['server'] });

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
    renderGate({ mediaSet: ['server'] });

    await user.upload(screen.getByLabelText('Use a recovery kit'), file);

    expect(await screen.findByText(/file could not be read/i)).toBeInTheDocument();
    // The gate stays closed: no kit is armed, so the passphrase is still required.
    expect(screen.getByRole('button', { name: 'Unlock vault' })).toBeDisabled();
    expect(runtime.unlockWithRecoveryKit).not.toHaveBeenCalled();
  });

  it('is never a dead end: signing out is always available, like the PIN gate', async () => {
    const user = userEvent.setup();
    renderGate({ mediaSet: ['server'] });

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('offers the §3 destruction exit only after the username AND a credential are given', async () => {
    const onStartFresh = vi.fn(async () => undefined);
    const user = userEvent.setup();
    renderGate({ mediaSet: ['server'], onStartFresh });

    const action = screen.getByRole('button', { name: 'Discard the vault and start fresh' });
    expect(action).toBeDisabled();

    await user.type(screen.getByLabelText(/Type your username \(ada\)/), 'adam');
    expect(action).toBeDisabled();

    await user.clear(screen.getByLabelText(/Type your username \(ada\)/));
    await user.type(screen.getByLabelText(/Type your username \(ada\)/), 'ada');
    // The typed username alone is only HALF the account-deletion rung; the
    // account password is the other half, and the server verifies both.
    expect(action).toBeDisabled();

    await user.type(screen.getByLabelText('Current account password'), 'hunter2hunter2');
    expect(action).toBeEnabled();

    await user.click(action);
    expect(onStartFresh).toHaveBeenCalledWith({
      confirmUsername: 'ada',
      password: 'hunter2hunter2',
    });
  });

  it('offers the authenticator code instead of the password on a 2FA account', async () => {
    vi.mocked(getTwoFactorStatus).mockResolvedValue({
      totpEnabled: true,
      totpPending: false,
      emailEnabled: false,
      recoveryCodesRemaining: 8,
    });
    const onStartFresh = vi.fn(async () => undefined);
    const user = userEvent.setup();
    renderGate({ mediaSet: ['server'], onStartFresh });

    await user.type(screen.getByLabelText(/Type your username \(ada\)/), 'ada');
    await user.click(await screen.findByRole('button', { name: /authenticator code instead/i }));
    await user.type(screen.getByLabelText('Authenticator code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Discard the vault and start fresh' }));

    expect(onStartFresh).toHaveBeenCalledWith({ confirmUsername: 'ada', code: '123456' });
  });

  it('keeps the password as the only option when no authenticator is enrolled', async () => {
    renderGate({ mediaSet: ['server'], onStartFresh: vi.fn(async () => undefined) });

    await waitFor(() => expect(getTwoFactorStatus).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /authenticator code instead/i })).toBeNull();
    expect(screen.getByLabelText('Current account password')).toBeInTheDocument();
  });

  it('tells a Drive vault owner that the leftover ciphertext is theirs to remove', () => {
    renderGate({ mediaSet: ['drive'], onStartFresh: vi.fn(async () => undefined) });

    expect(screen.getByText(/bettertrack-vault file from Drive/i)).toBeInTheDocument();
  });

  it('says nothing about Drive for a server-only vault', () => {
    renderGate({ mediaSet: ['server'], onStartFresh: vi.fn(async () => undefined) });

    expect(screen.queryByText(/bettertrack-vault file from Drive/i)).not.toBeInTheDocument();
  });

  it('keeps the gate usable when discarding the vault fails', async () => {
    const onStartFresh = vi.fn(async () => {
      throw new Error('offline');
    });
    const user = userEvent.setup();
    renderGate({ mediaSet: ['server'], onStartFresh });

    await user.type(screen.getByLabelText(/Type your username \(ada\)/), 'ada');
    await user.type(screen.getByLabelText('Current account password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: 'Discard the vault and start fresh' }));

    expect(await screen.findByText(/could not be discarded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard the vault and start fresh' })).toBeEnabled();
    // Unlocking is still the primary path — the failed exit changed nothing.
    expect(screen.getByLabelText('Vault passphrase')).toBeEnabled();
  });

  it('does not offer destruction when no exit was wired up', () => {
    renderGate({ mediaSet: ['server'] });

    expect(screen.queryByText('Can’t unlock this vault?')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Discard the vault and start fresh' }),
    ).not.toBeInTheDocument();
  });

  it('carries the enable confirmation when it replaces the wizard mid-unlock', async () => {
    // The wizard's own "done" frame cannot survive the subtree swap the mode
    // flip causes, so the gate it swapped in shows the confirmation instead —
    // the one-way flow never ends on a bare passphrase prompt.
    runtime.phase = 'unlocking';
    renderGate({ mediaSet: ['server'] });

    expect(screen.getByText('Paranoid mode is on. Your encrypted vault is ready.')).toBeVisible();
    // An unlock owned by the wizard must not be joined by a second attempt —
    // and this gate now starts none at all (#1640).
    expect(runtime.unlockWithPassphrase).not.toHaveBeenCalled();
    expect(runtime.unlockWithRecoveryKit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Unlocking…' })).toBeDisabled();
  });

  it('shows no enable confirmation on an ordinary locked visit', () => {
    renderGate({ mediaSet: ['server'] });

    expect(
      screen.queryByText('Paranoid mode is on. Your encrypted vault is ready.'),
    ).not.toBeInTheDocument();
  });
});
