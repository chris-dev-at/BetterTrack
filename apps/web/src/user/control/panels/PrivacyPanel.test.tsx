import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ParanoidVaultMediaState, PrivacyMode } from '@bettertrack/contracts';

const toggleDiscreetMode = vi.fn(async () => undefined);
const USER_ID = '018f0000-0000-7000-8000-000000000001';
const auth = { user: { id: USER_ID, username: 'jane', discreetMode: false }, toggleDiscreetMode };
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
let syncStatus: string | null = null;
const syncMutate = vi.fn(async () => undefined);
const discardAllData = vi.fn(async () => undefined);
vi.mock('../../vault/engine/VaultMoneyEngineProvider', () => ({
  useVaultMoneySession: () =>
    syncStatus === null
      ? null
      : {
          sync: {
            mutate: syncMutate,
            state: {
              status: syncStatus,
              active: { document: { schemaVersion: 1, entities: {}, mergeLog: [] } },
              pending: null,
            },
          },
          store: { discardAllData },
        },
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
  syncStatus = null;
  auth.user = { id: USER_ID, username: 'jane', discreetMode: false };
  toggleDiscreetMode.mockImplementation(async () => undefined);
});

describe('PrivacyPanel (§13.5 V5-P13)', () => {
  test('names itself once and reflects the stored discreet-mode state', () => {
    auth.user = { id: USER_ID, username: 'jane', discreetMode: true };
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

  test('disable stays closed while the vault sync is split — the other branch would be lost', async () => {
    privacyMode = 'paranoid';
    mediaState = {
      mediaSet: ['server'],
      driveAttestedVersion: null,
      server: { disposition: 'active', candidate: null, retired: null },
    };
    syncStatus = 'conflict';
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('checkbox', { name: /disable Paranoid mode/i }));

    expect(screen.getByText(/unsynced changes on more than one device/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore normal mode' })).toBeDisabled();
  });

  test('start fresh deletes through the store, never by rewriting the document', async () => {
    privacyMode = 'paranoid';
    mediaState = {
      mediaSet: ['server'],
      driveAttestedVersion: null,
      server: { disposition: 'active', candidate: null, retired: null },
    };
    syncStatus = 'synced';
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('checkbox', { name: /permanently replaced/i }));
    await user.click(screen.getByRole('button', { name: 'Replace with empty vault' }));

    // The store tombstones every entity; a raw `sync.mutate` wipe would leave a
    // second device free to union its copy back in on the next unlock.
    await waitFor(() => expect(discardAllData).toHaveBeenCalledTimes(1));
    expect(syncMutate).not.toHaveBeenCalled();
    expect(await screen.findByText('The encrypted vault is now empty.')).toBeInTheDocument();
  });

  test('disable is available once the vault has a single acknowledged branch', async () => {
    privacyMode = 'paranoid';
    mediaState = {
      mediaSet: ['server'],
      driveAttestedVersion: null,
      server: { disposition: 'active', candidate: null, retired: null },
    };
    syncStatus = 'synced';
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('checkbox', { name: /disable Paranoid mode/i }));

    expect(screen.queryByText(/unsynced changes on more than one device/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore normal mode' })).toBeEnabled();
  });
});
