import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { MeResponse, SessionInfoResponse, SessionSummary } from '@bettertrack/contracts';

vi.mock('../../../lib/userApi', () => ({
  getMe: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  setPin: vi.fn(),
  disablePin: vi.fn(),
  setPinLockIdleMinutes: vi.fn(),
}));

import {
  disablePin,
  getMe,
  getSession,
  listSessions,
  revokeOtherSessions,
  revokeSession,
  setPin,
  setPinLockIdleMinutes,
} from '../../../lib/userApi';
import { SessionsPanel } from './SessionsPanel';

const SESSION: SessionInfoResponse = {
  signedInAt: '2026-06-01T08:00:00.000Z',
  renewedAt: '2026-07-01T08:00:00.000Z',
  persistent: true,
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
    locale: 'en',
    lastLoginAt: '2026-07-01T08:00:00.000Z',
    createdAt: '2026-01-15T09:00:00.000Z',
  };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={['/control/sessions']}>
      <QueryClientProvider client={client}>
        <SessionsPanel />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const SESSIONS: SessionSummary[] = [
  {
    id: 'handle-current',
    device: 'Chrome on macOS',
    createdAt: '2026-07-01T08:00:00.000Z',
    lastSeenAt: '2026-07-07T09:00:00.000Z',
    current: true,
    persistent: true,
  },
  {
    id: 'handle-other',
    device: 'Firefox on Windows',
    createdAt: '2026-06-20T08:00:00.000Z',
    lastSeenAt: '2026-07-05T10:00:00.000Z',
    current: false,
    persistent: false,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION);
  vi.mocked(listSessions).mockResolvedValue(SESSIONS);
  vi.mocked(revokeSession).mockResolvedValue(undefined);
  vi.mocked(revokeOtherSessions).mockResolvedValue({ revoked: 1 });
  vi.mocked(setPin).mockResolvedValue(makeMe(true));
  vi.mocked(disablePin).mockResolvedValue(makeMe(false));
  vi.mocked(setPinLockIdleMinutes).mockResolvedValue(makeMe(true));
});

describe('SessionsPanel — where am I signed in', () => {
  test('renders session info', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPanel();

    expect(await screen.findByText(/signed in since/i)).toBeInTheDocument();
    expect(screen.getByText(/expires after 30 days of inactivity/i)).toBeInTheDocument();
  });

  test('an ephemeral session reports its real lifetime, not "30 days" (V4-P2b, §399 §A)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getSession).mockResolvedValue({ ...SESSION, persistent: false });
    renderPanel();

    // The browser-only copy, never the persistent 30-day claim.
    expect(await screen.findByText(/signs out when you close it/i)).toBeInTheDocument();
    expect(screen.queryByText(/expires after 30 days of inactivity/i)).not.toBeInTheDocument();
  });

  // Popup-native: ONE compact head naming the panel; the group labels stay real
  // headings so the outline (and every heading query) survives the compaction.
  test('carries one panel head and keeps its group labels as headings', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPanel();

    await screen.findByText(/signed in since/i);
    const heads = screen.getAllByRole('heading', { level: 2 });
    expect(heads).toHaveLength(1);
    expect(heads[0]).toHaveTextContent('Sessions');
    expect(screen.getByRole('heading', { level: 3, name: 'Active sessions' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  test('lists active sessions with device labels and a current-device marker (V3-P11a)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPanel();

    expect(await screen.findByRole('heading', { name: 'Active sessions' })).toBeInTheDocument();
    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('Firefox on Windows')).toBeInTheDocument();
    // The current session is marked and has no per-row log-out button.
    expect(screen.getByText('This device')).toBeInTheDocument();
    // Exactly one per-row "Log out" (the non-current device).
    expect(screen.getAllByRole('button', { name: 'Log out' })).toHaveLength(1);
  });

  test('marks each session persistent vs ephemeral (V4-P2b, §399 §A)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPanel();

    // The current session is persistent; the other was a browser-session login.
    expect(await screen.findByText('Stays signed in')).toBeInTheDocument();
    expect(screen.getByText('This browser only')).toBeInTheDocument();
  });

  test('logs out one device via revokeSession (V3-P11a)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith('handle-other'));
  });

  test('logs out all other devices behind a confirm step (V3-P11a)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    const user = userEvent.setup();
    renderPanel();

    // First click reveals the confirmation, not an immediate revoke.
    await user.click(await screen.findByRole('button', { name: 'Log out all other devices' }));
    expect(revokeOtherSessions).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Log out all other devices' }));
    await waitFor(() => expect(revokeOtherSessions).toHaveBeenCalled());
  });
});

describe('SessionsPanel — the PIN app lock', () => {
  test('enables a PIN when none is set', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    const user = userEvent.setup();
    renderPanel();

    await user.type(await screen.findByLabelText('PIN'), '1234');
    await user.type(screen.getByLabelText('Confirm PIN'), '1234');
    await user.click(screen.getByRole('button', { name: 'Enable PIN' }));

    await waitFor(() => expect(setPin).toHaveBeenCalledWith({ pin: '1234' }));
  });

  test('rejects a mismatched PIN confirmation', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    const user = userEvent.setup();
    renderPanel();

    await user.type(await screen.findByLabelText('PIN'), '1234');
    await user.type(screen.getByLabelText('Confirm PIN'), '5678');
    await user.click(screen.getByRole('button', { name: 'Enable PIN' }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(setPin).not.toHaveBeenCalled();
  });

  test('changes and disables an existing PIN', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(true));
    const user = userEvent.setup();
    renderPanel();

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

  test('the unlock-window control only shows once a PIN is enabled (#288)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPanel();

    // With no PIN, the enable form is up but no window picker.
    expect(await screen.findByRole('button', { name: 'Enable PIN' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Unlock window')).not.toBeInTheDocument();
  });

  test('the unlock window defaults to 10 minutes when unset (#288)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(true)); // pinLockIdleMinutes: null → default
    renderPanel();

    const select = (await screen.findByLabelText('Unlock window')) as HTMLSelectElement;
    expect(select.value).toBe('10');
  });

  test('changing the unlock window persists the new value (#288)', async () => {
    vi.mocked(getMe).mockResolvedValue({ ...makeMe(true), pinLockIdleMinutes: 5 });
    vi.mocked(setPinLockIdleMinutes).mockResolvedValue({
      ...makeMe(true),
      pinLockIdleMinutes: 30,
    });
    const user = userEvent.setup();
    renderPanel();

    const select = (await screen.findByLabelText('Unlock window')) as HTMLSelectElement;
    expect(select.value).toBe('5');
    await user.selectOptions(select, '30');

    await waitFor(() => expect(setPinLockIdleMinutes).toHaveBeenCalledWith({ idleMinutes: 30 }));
  });

  // The credentials themselves live on the Sign-in panel now — this panel must
  // not also ship a password form or a 2FA control.
  test('carries no credential controls (they moved to the Sign-in panel)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPanel();

    await screen.findByText(/signed in since/i);
    expect(screen.queryByRole('button', { name: 'Update password' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Two-factor authentication' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Passkeys' })).not.toBeInTheDocument();
  });
});
