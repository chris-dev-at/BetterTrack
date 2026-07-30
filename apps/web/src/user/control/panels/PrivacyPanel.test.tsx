import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ParanoidVaultMediaState, PrivacyMode } from '@bettertrack/contracts';

const toggleDiscreetMode = vi.fn(async () => undefined);
const auth = { user: { username: 'jane', discreetMode: false }, toggleDiscreetMode };
const refetch = vi.fn(async () => undefined);
const acceptEnabled = vi.fn();
const acceptNormal = vi.fn();
let privacyMode: PrivacyMode = 'normal';
let mediaState: ParanoidVaultMediaState | null = null;

vi.mock('../../AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../vault/usePrivacyMode', () => ({
  usePrivacyMode: () => ({
    privacyMode,
    mediaState,
    isPending: false,
    isError: false,
    refetch,
    acceptEnabled,
    acceptNormal,
  }),
}));
vi.mock('../../vault/VaultRuntimeProvider', () => ({ useVaultRuntime: () => ({}) }));
vi.mock('../../vault/engine/VaultMoneyEngineProvider', () => ({
  useVaultMoneySession: () => null,
}));

import { PrivacyPanel } from './PrivacyPanel';

function renderPanel() {
  return render(
    <MemoryRouter>
      <PrivacyPanel />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  privacyMode = 'normal';
  mediaState = null;
  auth.user = { username: 'jane', discreetMode: false };
  toggleDiscreetMode.mockImplementation(async () => undefined);
});

describe('PrivacyPanel (§13.5 V5-P13)', () => {
  test('names itself once and reflects the stored discreet-mode state', () => {
    auth.user = { username: 'jane', discreetMode: true };
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Privacy modes' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Discreet mode' })).toBeChecked();
  });

  test('flipping the switch goes through the auth mutation', async () => {
    const user = userEvent.setup();
    renderPanel();

    const control = screen.getByRole('switch', { name: 'Discreet mode' });
    expect(control).not.toBeChecked();
    await user.click(control);

    await waitFor(() => expect(toggleDiscreetMode).toHaveBeenCalledTimes(1));
  });

  test('a failed write is swallowed — the optimistic flip is rolled back upstream', async () => {
    toggleDiscreetMode.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('switch', { name: 'Discreet mode' }));

    await waitFor(() => expect(toggleDiscreetMode).toHaveBeenCalledTimes(1));
    // The rejection never escapes as an unhandled rejection, and the switch
    // keeps rendering whatever auth state says (still off).
    expect(screen.getByRole('switch', { name: 'Discreet mode' })).not.toBeChecked();
  });

  test('opens the live setup wizard with the compact killed-surface review', async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByRole('heading', { name: /Paranoid mode/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up' }));

    expect(screen.getByRole('heading', { name: 'What changes' })).toBeInTheDocument();
    expect(screen.getByText(/Sharing, shared items, comments/i)).toBeInTheDocument();
    expect(screen.getByText(/Server portfolio analytics/i)).toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  test('keeps paranoid management compact while exposing storage, security, and destructive flows', () => {
    privacyMode = 'paranoid';
    mediaState = {
      mediaSet: ['server', 'drive'],
      driveAttestedVersion: 4,
      server: { disposition: 'active', candidate: null, retired: null },
    };

    renderPanel();

    expect(screen.getByText('BetterTrack + Google Drive')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage storage' })).toHaveAttribute(
      'href',
      '/control/connections',
    );
    expect(screen.getByText('What’s off in Paranoid mode')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.getByText('Change vault passphrase')).toBeInTheDocument();
    expect(screen.getByText('Rotate vault key')).toBeInTheDocument();
    expect(screen.getByText('Start fresh')).toBeInTheDocument();
    expect(screen.getByText('Disable Paranoid mode')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up' })).not.toBeInTheDocument();
  });
});
