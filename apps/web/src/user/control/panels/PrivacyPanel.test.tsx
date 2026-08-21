import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ParanoidVaultMediaState, PrivacyMode } from '@bettertrack/contracts';
import { createVaultTransferRuntime } from '../../vault/qr/runtime';

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
/** `null` = no vault providers above the panel, which is a normal account. */
const transferRuntime = createVaultTransferRuntime({
  bindLockSignal: false,
  requestJson: vi.fn(async () => ({ vaults: [] })),
});
let vaultRuntime: object | null = { transfer: transferRuntime };
vi.mock('../../vault/VaultRuntimeContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vault/VaultRuntimeContext')>()),
  useOptionalVaultRuntime: () => vaultRuntime,
  useVaultRuntime: () => {
    if (vaultRuntime == null) throw new Error('useVaultRuntime must be used within a provider.');
    return vaultRuntime;
  },
}));
let syncStatus: string | null = null;
const syncMutate = vi.fn(async () => undefined);
const discardAllData = vi.fn(async () => undefined);
vi.mock('../../vault/engine/VaultMoneyEngineContext', () => ({
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

/**
 * The wizard renders for real by default (the killed-surface review below is
 * the live component crossing its own lazy boundary). A test that needs the
 * post-enable bookkeeping installs a stub instead, because reaching `onEnabled`
 * for real means running the whole key ceremony — which the wizard's own suite
 * already covers.
 */
type ParanoidEnableWizardProps = Parameters<
  typeof import('../../vault/ui/ParanoidEnableWizard').ParanoidEnableWizard
>[0];
let enableStub: ((props: ParanoidEnableWizardProps) => ReactNode) | null = null;
vi.mock('../../vault/ui/ParanoidEnableWizard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../vault/ui/ParanoidEnableWizard')>();
  return {
    ParanoidEnableWizard: (props: ParanoidEnableWizardProps) =>
      enableStub ? enableStub(props) : <actual.ParanoidEnableWizard {...props} />,
  };
});
const RECEIPT: Parameters<ParanoidEnableWizardProps['onEnabled']>[0] = {
  mode: 'paranoid',
  mediaSet: ['server'],
  vaultVersion: 1,
  completedAt: '2026-08-05T10:00:00.000Z',
  idempotent: false,
};

import { PrivacyPanel } from './PrivacyPanel';

/** Reads back the URL the panel navigates to (the setup request lives there). */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function renderPanel(entry = '/control/privacy') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <PrivacyPanel />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  enableStub = null;
  privacyMode = 'normal';
  mediaState = null;
  syncStatus = null;
  vaultRuntime = { transfer: transferRuntime };
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

  test('keeps the per-vault receive entry reachable for a normal account without the legacy runtime', async () => {
    // E7 is account-mode independent: a fresh endpoint must be able to receive
    // a per-vault phrase before any legacy account-level runtime is unlocked.
    vaultRuntime = null;

    renderPanel();

    expect(screen.getByRole('switch', { name: 'Discreet mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up' })).toBeInTheDocument();
    expect(await screen.findByText('Transfer between devices')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open portfolio settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Read' })).not.toBeInTheDocument();
  });

  test('the setup request rides in the URL, so the gate above can act on it', async () => {
    // `AccountModeRoot` mounts the vault providers from this param and replaces
    // the subtree doing it — local `useState` would not survive that.
    vaultRuntime = null;
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Set up' }));

    expect(screen.getByTestId('url')).toHaveTextContent('/control/privacy?enable=1');
  });

  test('opens the paranoid setup wizard with the compact killed-surface review', async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByRole('heading', { name: /Paranoid mode/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up' }));

    // The wizard is its own chunk (#1089), so it arrives a tick later.
    expect(await screen.findByRole('heading', { name: 'What changes' })).toBeInTheDocument();
    expect(screen.getByText(/Sharing, shared items, comments/i)).toBeInTheDocument();
    expect(screen.getByText(/Server portfolio analytics/i)).toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  test('the setup entry reads as pending while its chunk is still on the way', async () => {
    // `?enable=1` is set but the vault providers are not mounted yet: the row
    // must not offer the same click again as if nothing had happened.
    vaultRuntime = null;
    renderPanel('/control/privacy?enable=1');

    const entry = screen.getByRole('button', { name: 'Loading…' });
    expect(entry).toBeDisabled();
    expect(entry).toHaveAttribute('aria-busy', 'true');
  });

  test('a succeeded setup request leaves the URL, so a later disable lands on the entry row', async () => {
    // Enable → disable inside ONE overlay session: with `?enable=1` still in
    // the URL the panel would re-open the setup wizard instead of the row. The
    // real key ceremony is driven by the wizard's own suite; reaching
    // `onEnabled` is all this assertion needs.
    enableStub = ({ onEnabled }) => (
      <button onClick={() => onEnabled(RECEIPT)} type="button">
        finish
      </button>
    );
    const user = userEvent.setup();
    renderPanel('/control/privacy?enable=1');

    await user.click(await screen.findByRole('button', { name: 'finish' }));

    expect(acceptEnabled).toHaveBeenCalledWith(RECEIPT);
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('/control/privacy'));
    expect(screen.getByTestId('url')).not.toHaveTextContent('enable=1');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Paranoid mode is on. Your encrypted vault is ready.',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('keeps paranoid management compact while exposing storage, security, and destructive flows', async () => {
    const user = userEvent.setup();
    privacyMode = 'paranoid';
    mediaState = {
      mediaSet: ['server', 'drive'],
      driveAttestedVersion: 4,
      server: { disposition: 'active', candidate: null, retired: null },
    };

    renderPanel();

    // The management section is its own chunk (#1089) — it arrives a tick later.
    expect(await screen.findByText('BetterTrack + Google Drive')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage storage' })).toHaveAttribute(
      'href',
      '/control/connections',
    );
    expect(screen.getByText('What’s off in Paranoid mode')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    await user.click(screen.getByText('Transfer between devices'));
    expect(screen.getByRole('button', { name: 'Receive transferred vault' })).toBeInTheDocument();
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

    await user.click(await screen.findByRole('checkbox', { name: /disable Paranoid mode/i }));

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

    await user.click(await screen.findByRole('checkbox', { name: /permanently replaced/i }));
    await user.click(screen.getByRole('button', { name: 'Replace with an empty portfolio' }));

    // The store tombstones every entity; a raw `sync.mutate` wipe would leave a
    // second device free to union its copy back in on the next unlock.
    await waitFor(() => expect(discardAllData).toHaveBeenCalledTimes(1));
    expect(syncMutate).not.toHaveBeenCalled();
    expect(
      await screen.findByText('The encrypted vault now holds a single empty portfolio.'),
    ).toBeInTheDocument();
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

    await user.click(await screen.findByRole('checkbox', { name: /disable Paranoid mode/i }));

    expect(screen.queryByText(/unsynced changes on more than one device/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore normal mode' })).toBeEnabled();
  });
});
