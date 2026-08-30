import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const VAULT_ID = '018f0000-0000-7000-8000-000000000001';

const mocks = vi.hoisted(() => ({
  unlock: vi.fn(),
  stateFor: vi.fn(),
  restoreOnce: vi.fn(),
}));

vi.mock('../keystore/runtime', () => ({
  endpointVaultKeystore: { unlock: mocks.unlock, stateFor: mocks.stateFor },
  restoreEndpointCustodyOnce: mocks.restoreOnce,
  bindEndpointKeystoreAccount: vi.fn(),
  endpointKeystoreAccountId: () => null,
  releaseEndpointKeystoreLockSignal: () => undefined,
}));

import type { EndpointVaultState } from '../keystore';
import { EndpointKeystoreError } from '../keystore/errors';
import { VaultStateAction } from './VaultStateAction';

const LOCKED: EndpointVaultState = {
  status: 'stored+wrapped',
  session: 'locked',
  requiredAction: { kind: 'unlock', credential: 'device-password' },
};

const NOT_ON_ENDPOINT: EndpointVaultState = {
  status: 'not-on-this-endpoint',
  requiredAction: { kind: 'provide-phrase', methods: ['enter-words', 'scan-qr'] },
};

function renderAction(state: EndpointVaultState, onUnlocked = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <VaultStateAction inPlace onUnlocked={onUnlocked} state={state} vaultId={VAULT_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onUnlocked };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.restoreOnce.mockResolvedValue({ unlockedVaultIds: [] });
  mocks.stateFor.mockResolvedValue(LOCKED);
  mocks.unlock.mockResolvedValue({ unlockedVaultIds: [VAULT_ID] });
});

describe('in-place vault unlock', () => {
  it('offers a real button — not a link into settings — and prompts right there', async () => {
    const user = userEvent.setup();
    renderAction(LOCKED);

    // The owner's oracle: open the portfolio, get prompted, unlock. No anchor.
    expect(screen.queryByRole('link', { name: 'Unlock' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByLabelText('Device password')).toBeTruthy();
  });

  it('unlocks in place and reports it, without navigating', async () => {
    const user = userEvent.setup();
    const { onUnlocked } = renderAction(LOCKED);

    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await user.type(await screen.findByLabelText('Device password'), 'the device password');
    await user.click(screen.getByRole('button', { name: 'Unlock vault' }));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(mocks.unlock).toHaveBeenCalledWith('the device password', {
      keepUnlockedOnThisDevice: false,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('carries the keep-unlocked opt-in into the keystore', async () => {
    const user = userEvent.setup();
    renderAction(LOCKED);

    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await user.type(await screen.findByLabelText('Device password'), 'the device password');
    await user.click(screen.getByRole('switch', { name: /Keep unlocked on this device/ }));
    await user.click(screen.getByRole('button', { name: 'Unlock vault' }));

    await waitFor(() =>
      expect(mocks.unlock).toHaveBeenCalledWith('the device password', {
        keepUnlockedOnThisDevice: true,
      }),
    );
  });

  it('keeps a wrong password inline, with the attempt count and the dialog open', async () => {
    const user = userEvent.setup();
    mocks.unlock.mockRejectedValue(
      new EndpointKeystoreError('wrong-password', 'nope', { failures: 2 }),
    );
    renderAction(LOCKED);

    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await user.type(await screen.findByLabelText('Device password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Unlock vault' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/password/i);
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Still typeable: a wrong password is a retry, not a dead end.
    expect(screen.getByLabelText('Device password')).toBeTruthy();
  });

  it('surfaces the lockout deadline and withdraws the password field', async () => {
    const user = userEvent.setup();
    const retryAt = Date.UTC(2026, 7, 30, 12, 0, 30);
    mocks.unlock.mockRejectedValue(
      new EndpointKeystoreError('locked-out', 'wait', { failures: 5, retryAt }),
    );
    renderAction(LOCKED);

    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await user.type(await screen.findByLabelText('Device password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Unlock vault' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    // The endpoint withdrew the action: never invite a password nothing will read.
    await waitFor(() => expect(screen.queryByLabelText('Device password')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Unlock vault' })).toBeNull();
  });

  it('leaves the phrase entry paths to the settings surface', async () => {
    renderAction(NOT_ON_ENDPOINT);
    // In-place mode only owns the unlock. A vault that is not on this endpoint
    // needs the twelve words or a QR scan, which is a settings-sized flow.
    expect(screen.getByRole('link', { name: 'Enter words' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Scan QR' })).toBeTruthy();
  });
});
