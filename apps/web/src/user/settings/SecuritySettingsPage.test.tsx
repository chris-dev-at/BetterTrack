import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { MeResponse, SessionInfoResponse } from '@bettertrack/contracts';

vi.mock('../../lib/userApi', () => ({
  getMe: vi.fn(),
  getSession: vi.fn(),
  setPin: vi.fn(),
  disablePin: vi.fn(),
  setPinLockIdleMinutes: vi.fn(),
}));

import { disablePin, getMe, getSession, setPin, setPinLockIdleMinutes } from '../../lib/userApi';
import { SecuritySettingsPage } from './SecuritySettingsPage';

const SESSION: SessionInfoResponse = {
  signedInAt: '2026-06-01T08:00:00.000Z',
  renewedAt: '2026-07-01T08:00:00.000Z',
  expiresAt: '2026-07-31T08:00:00.000Z',
};

function makeMe(pinEnabled: boolean): MeResponse {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'ada@example.com',
    username: 'ada',
    role: 'user',
    status: 'active',
    mustChangePassword: false,
    pinEnabled,
    pinLockIdleMinutes: null,
    baseCurrency: 'EUR',
    lastLoginAt: '2026-07-01T08:00:00.000Z',
    createdAt: '2026-01-15T09:00:00.000Z',
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <SecuritySettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION);
  vi.mocked(setPin).mockResolvedValue(makeMe(true));
  vi.mocked(disablePin).mockResolvedValue(makeMe(false));
  vi.mocked(setPinLockIdleMinutes).mockResolvedValue(makeMe(true));
});

describe('SecuritySettingsPage', () => {
  test('renders session info and the planned 2FA section', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPage();

    expect(await screen.findByText(/signed in since/i)).toBeInTheDocument();
    expect(screen.getByText(/expires after 30 days of inactivity/i)).toBeInTheDocument();

    expect(screen.getByText('Two-factor authentication')).toBeInTheDocument();
    expect(screen.getByText('Planned')).toBeInTheDocument();
  });

  test('enables a PIN when none is set', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('PIN'), '1234');
    await user.type(screen.getByLabelText('Confirm PIN'), '1234');
    await user.click(screen.getByRole('button', { name: 'Enable PIN' }));

    await waitFor(() => expect(setPin).toHaveBeenCalledWith({ pin: '1234' }));
  });

  test('rejects a mismatched PIN confirmation', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('PIN'), '1234');
    await user.type(screen.getByLabelText('Confirm PIN'), '5678');
    await user.click(screen.getByRole('button', { name: 'Enable PIN' }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(setPin).not.toHaveBeenCalled();
  });

  test('changes and disables an existing PIN', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(true));
    const user = userEvent.setup();
    renderPage();

    // Change flow reveals the PIN form and submits via setPin.
    await user.click(await screen.findByRole('button', { name: 'Change PIN' }));
    await user.type(screen.getByLabelText('PIN'), '9999');
    await user.type(screen.getByLabelText('Confirm PIN'), '9999');
    await user.click(screen.getByRole('button', { name: 'Save new PIN' }));

    await waitFor(() => expect(setPin).toHaveBeenCalledWith({ pin: '9999' }));

    // Disable calls disablePin.
    await user.click(await screen.findByRole('button', { name: 'Disable PIN' }));
    await waitFor(() => expect(disablePin).toHaveBeenCalled());
  });

  test('the AFK auto-lock control only shows once a PIN is enabled', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPage();

    // With no PIN, the enable form is up but no AFK switch.
    expect(await screen.findByRole('button', { name: 'Enable PIN' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Auto-lock when idle' })).not.toBeInTheDocument();
  });

  test('enabling AFK auto-lock sends the default idle timeout', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(true)); // pinLockIdleMinutes: null → off
    vi.mocked(setPinLockIdleMinutes).mockResolvedValue({
      ...makeMe(true),
      pinLockIdleMinutes: 5,
    });
    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByRole('switch', { name: 'Auto-lock when idle' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);

    await waitFor(() => expect(setPinLockIdleMinutes).toHaveBeenCalledWith({ idleMinutes: 5 }));
    // The idle-timeout picker appears once it's on.
    expect(await screen.findByLabelText('Idle timeout')).toBeInTheDocument();
  });

  test('changing the idle timeout persists the new value', async () => {
    vi.mocked(getMe).mockResolvedValue({ ...makeMe(true), pinLockIdleMinutes: 5 });
    vi.mocked(setPinLockIdleMinutes).mockResolvedValue({
      ...makeMe(true),
      pinLockIdleMinutes: 30,
    });
    const user = userEvent.setup();
    renderPage();

    const select = await screen.findByLabelText('Idle timeout');
    await user.selectOptions(select, '30');

    await waitFor(() => expect(setPinLockIdleMinutes).toHaveBeenCalledWith({ idleMinutes: 30 }));
  });

  test('turning AFK auto-lock off clears the idle timeout', async () => {
    vi.mocked(getMe).mockResolvedValue({ ...makeMe(true), pinLockIdleMinutes: 15 });
    vi.mocked(setPinLockIdleMinutes).mockResolvedValue(makeMe(true));
    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByRole('switch', { name: 'Auto-lock when idle' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);

    await waitFor(() => expect(setPinLockIdleMinutes).toHaveBeenCalledWith({ idleMinutes: null }));
  });
});
