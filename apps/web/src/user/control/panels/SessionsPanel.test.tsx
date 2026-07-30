import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { SessionInfoResponse, SessionSummary } from '@bettertrack/contracts';

// The PIN moved to the Sign-in panel (owner order), so this panel no longer
// touches `getMe` or any of the PIN endpoints. The mock deliberately omits them:
// a regression that re-adds a PIN control here fails on the missing export.
vi.mock('../../../lib/userApi', () => ({
  getSession: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
}));

import { getSession, listSessions, revokeOtherSessions, revokeSession } from '../../../lib/userApi';
import { SessionsPanel } from './SessionsPanel';

const SESSION: SessionInfoResponse = {
  signedInAt: '2026-06-01T08:00:00.000Z',
  renewedAt: '2026-07-01T08:00:00.000Z',
  persistent: true,
  expiresAt: '2026-07-31T08:00:00.000Z',
};

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
});

describe('SessionsPanel — where am I signed in', () => {
  test('renders session info', async () => {
    renderPanel();

    expect(await screen.findByText(/signed in since/i)).toBeInTheDocument();
    expect(screen.getByText(/expires after 30 days of inactivity/i)).toBeInTheDocument();
  });

  test('an ephemeral session reports its real lifetime, not "30 days" (V4-P2b, §399 §A)', async () => {
    vi.mocked(getSession).mockResolvedValue({ ...SESSION, persistent: false });
    renderPanel();

    // The browser-only copy, never the persistent 30-day claim.
    expect(await screen.findByText(/signs out when you close it/i)).toBeInTheDocument();
    expect(screen.queryByText(/expires after 30 days of inactivity/i)).not.toBeInTheDocument();
  });

  // Popup-native: ONE compact head naming the panel; the group labels stay real
  // headings so the outline (and every heading query) survives the compaction.
  test('carries one panel head and keeps its group labels as headings', async () => {
    renderPanel();

    await screen.findByText(/signed in since/i);
    const heads = screen.getAllByRole('heading', { level: 2 });
    expect(heads).toHaveLength(1);
    expect(heads[0]).toHaveTextContent('Sessions');
    expect(screen.getByRole('heading', { level: 3, name: 'Active sessions' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  test('lists active sessions with device labels and a current-device marker (V3-P11a)', async () => {
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
    renderPanel();

    // The current session is persistent; the other was a browser-session login.
    expect(await screen.findByText('Stays signed in')).toBeInTheDocument();
    expect(screen.getByText('This browser only')).toBeInTheDocument();
  });

  test('logs out one device via revokeSession (V3-P11a)', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith('handle-other'));
  });

  test('logs out all other devices behind a confirm step (V3-P11a)', async () => {
    const user = userEvent.setup();
    renderPanel();

    // First click reveals the confirmation, not an immediate revoke.
    await user.click(await screen.findByRole('button', { name: 'Log out all other devices' }));
    expect(revokeOtherSessions).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Log out all other devices' }));
    await waitFor(() => expect(revokeOtherSessions).toHaveBeenCalled());
  });

  // Every credential lives on Sign-in now — including the PIN, which moved on
  // owner order because it is how you prove it's you, not a device listing.
  test('ships no credential controls at all, PIN included', async () => {
    renderPanel();

    await screen.findByText(/signed in since/i);
    expect(screen.queryByRole('button', { name: 'Update password' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Two-factor authentication' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Passkeys' })).not.toBeInTheDocument();
    // The PIN block, all three of its surfaces.
    expect(screen.queryByRole('heading', { name: 'PIN' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable PIN' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Unlock window')).not.toBeInTheDocument();
  });
});
