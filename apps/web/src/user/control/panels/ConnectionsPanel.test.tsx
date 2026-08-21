import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  DriveConnection,
  ParanoidMediaStateResponse,
  ParanoidVaultMediaState,
  VaultConfig,
} from '@bettertrack/contracts';

vi.mock('../../../lib/userApi', () => ({
  createDriveConnection: vi.fn(),
  deleteDriveConnection: vi.fn(),
  getGoogleLinkStatus: vi.fn(),
  getParanoidMediaState: vi.fn(),
  listDriveConnections: vi.fn(),
  listVaultConfigs: vi.fn(),
  unlinkGoogle: vi.fn(),
  verifyDriveConnection: vi.fn(),
  googleStartUrl: vi.fn(() => 'http://api.test/api/v1/auth/google/start'),
}));

import { ApiError } from '../../../lib/apiClient';
import {
  getGoogleLinkStatus,
  getParanoidMediaState,
  listDriveConnections,
  listVaultConfigs,
  unlinkGoogle,
} from '../../../lib/userApi';
import type { DriveConnectionController } from '../../vault/media';
import type { DriveConnectionRegistry } from '../../vault/media/driveConnectionRegistry';
import { ConnectionsPanel } from './ConnectionsPanel';

const GOOGLE_OFF = {
  enabled: false,
  linked: false,
  email: null,
  linkedAt: null,
  canUnlink: false,
} as const;

const LINKED = {
  enabled: true,
  linked: true,
  email: 'me@example.com',
  linkedAt: '2026-07-01T08:00:00.000Z',
  canUnlink: true,
} as const;

const NORMAL_MEDIA: ParanoidMediaStateResponse = {
  privacyMode: 'normal',
  mediaState: null,
};

const SERVER_STATE: ParanoidVaultMediaState = {
  mediaSet: ['server'],
  driveAttestedVersion: null,
  server: { disposition: 'active', candidate: null, retired: null },
};

const SERVER_MEDIA: ParanoidMediaStateResponse = {
  privacyMode: 'paranoid',
  mediaState: SERVER_STATE,
};

const BOTH_STATE: ParanoidVaultMediaState = {
  mediaSet: ['server', 'drive'],
  driveAttestedVersion: 4,
  server: { disposition: 'active', candidate: null, retired: null },
};

const BOTH_MEDIA: ParanoidMediaStateResponse = {
  privacyMode: 'paranoid',
  mediaState: BOTH_STATE,
};

const DRIVE_ONLY_STATE: ParanoidVaultMediaState = {
  mediaSet: ['drive'],
  driveAttestedVersion: 4,
  server: { disposition: 'retired', candidate: null, retired: null },
};

const DRIVE_ONLY_MEDIA: ParanoidMediaStateResponse = {
  privacyMode: 'paranoid',
  mediaState: DRIVE_ONLY_STATE,
};

const RETIRED_SERVER = {
  version: 4,
  retiredAt: '2026-07-20T08:00:00.000Z',
  purgeAfter: '2026-08-20T08:00:00.000Z',
} as const;

function controller(
  authorization: DriveConnectionController['authorization'] = 'connected',
): DriveConnectionController {
  return {
    authorization,
    subscribeAuthorization: vi.fn(() => () => undefined),
    connect: vi.fn(async () => ({
      status: 'ok' as const,
      media: BOTH_STATE,
      driveLeftover: false as const,
    })),
    disconnect: vi.fn(async () => ({
      status: 'ok' as const,
      media: SERVER_STATE,
      driveLeftover: false as const,
    })),
    useDriveOnly: vi.fn(async () => ({
      status: 'ok' as const,
      media: DRIVE_ONLY_STATE,
      driveLeftover: false as const,
    })),
    addServerCopy: vi.fn(async () => ({
      status: 'ok' as const,
      media: BOTH_STATE,
      driveLeftover: false as const,
    })),
    resume: vi.fn(async () => ({
      status: 'ok' as const,
      state: { status: 'synced' as const, active: null, pending: null },
    })),
    purgeRetiredServer: vi.fn(async () => ({
      status: 'ok' as const,
      media: DRIVE_ONLY_STATE,
    })),
  };
}

function expiringController(delayMs: number): DriveConnectionController {
  let authorization: DriveConnectionController['authorization'] = 'connected';
  const listeners = new Set<() => void>();
  const base = controller();
  setTimeout(() => {
    authorization = 'token-expired';
    for (const listener of listeners) listener();
  }, delayMs);
  return {
    ...base,
    get authorization() {
      return authorization;
    },
    subscribeAuthorization(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function renderPanel(
  initialEntry = '/settings/connections',
  props: React.ComponentProps<typeof ConnectionsPanel> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={client}>
        <ConnectionsPanel {...props} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_GOOGLE_DRIVE_CLIENT_ID', '');
  delete window.__BT__;
  // Google off by default so the section stays hidden unless a test opts in.
  vi.mocked(getGoogleLinkStatus).mockResolvedValue(GOOGLE_OFF);
  vi.mocked(getParanoidMediaState).mockResolvedValue(NORMAL_MEDIA);
  vi.mocked(listDriveConnections).mockResolvedValue([]);
  vi.mocked(listVaultConfigs).mockResolvedValue([]);
  vi.mocked(unlinkGoogle).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete window.__BT__;
});

describe('ConnectionsPanel — connector slots (V5-P0c)', () => {
  test('renders the compact, non-functional connector slots with sync semantics', async () => {
    renderPanel();

    // The panel head renders even while Google is off.
    expect(await screen.findByRole('heading', { name: 'Connections' })).toBeInTheDocument();

    // Each designed slot is present with a "coming soon" chip and no dead button.
    expect(screen.getByText('Bank & broker cash sync')).toBeInTheDocument();
    expect(screen.getByText('Parqet')).toBeInTheDocument();
    expect(screen.getAllByText('Coming soon').length).toBe(2);
    // Both sync-semantics variants are surfaced.
    expect(screen.getAllByText(/Stays connected/).length).toBeGreaterThan(0);
    expect(screen.getByText(/One-time import/)).toBeInTheDocument();
    // No dead action buttons in the connectors area.
    expect(screen.queryByRole('button', { name: /connect|sync/i })).not.toBeInTheDocument();
  });
});

describe('ConnectionsPanel — Google account (§13.4 V4-P4b, moved from Security)', () => {
  test('retries a recoverable Google status failure', async () => {
    vi.mocked(getGoogleLinkStatus)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(LINKED);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Linked as me@example.com')).toBeInTheDocument();
    expect(getGoogleLinkStatus).toHaveBeenCalledTimes(2);
  });

  test('the section is hidden when Google is not configured (routes 404 / disabled)', async () => {
    renderPanel();
    // The connectors still render; the Google section resolves to nothing once
    // the disabled status arrives (a transient skeleton clears on settle).
    expect(await screen.findByText('Bank & broker cash sync')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Google account')).not.toBeInTheDocument());
  });

  test('shows the linked identity and unlinks after a password re-auth', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue(LINKED);
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText('Linked as me@example.com')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Unlink' }));
    await user.type(await screen.findByLabelText('Password'), 'my-password-1');
    await user.click(screen.getByRole('button', { name: 'Unlink Google' }));

    await waitFor(() => expect(unlinkGoogle).toHaveBeenCalledWith('my-password-1'));
    expect(await screen.findByText('Google account unlinked.')).toBeInTheDocument();
  });

  test('a wrong password surfaces an in-form error and does not unlink further', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue(LINKED);
    vi.mocked(unlinkGoogle).mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'nope'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    await user.type(await screen.findByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Unlink Google' }));

    expect(await screen.findByText('Your password is incorrect.')).toBeInTheDocument();
  });

  test('Google as the only sign-in method: unlink is withheld with a hint', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue({ ...LINKED, canUnlink: false });
    renderPanel();

    expect(await screen.findByText('Linked as me@example.com')).toBeInTheDocument();
    expect(screen.getByText(/only way to sign in/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument();
  });

  test('when not linked, offers a Connect Google affordance', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue({
      enabled: true,
      linked: false,
      email: null,
      linkedAt: null,
      canUnlink: false,
    });
    renderPanel();

    expect(await screen.findByText('No Google account is linked.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect Google' })).toBeInTheDocument();
  });

  test('announces a just-completed link from the ?google=linked callback marker', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue(LINKED);
    renderPanel('/settings/connections?google=linked');

    expect(await screen.findByText('Google account linked.')).toBeInTheDocument();
  });

  test('surfaces an email-mismatch connect failure from the ?error=google_email_mismatch marker', async () => {
    // Connect is email-match-only (owner order 2026-07-16): the callback bounces
    // a mismatched Google email back as ?error=google_email_mismatch.
    vi.mocked(getGoogleLinkStatus).mockResolvedValue({
      enabled: true,
      linked: false,
      email: null,
      linkedAt: null,
      canUnlink: false,
    });
    renderPanel('/settings/connections?error=google_email_mismatch');

    expect(await screen.findByText(/doesn't match your account email/i)).toBeInTheDocument();
    // The connect affordance is still offered — nothing was linked.
    expect(screen.getByRole('link', { name: 'Connect Google' })).toBeInTheDocument();
  });
});

describe('ConnectionsPanel — Drive connection registry (E5)', () => {
  const y: DriveConnection = {
    id: '018f0000-0000-7000-8000-000000000501',
    googleSub: 'sub-y',
    email: 'y@example.test',
    displayName: 'Drive Y',
    createdAt: '2026-08-20T12:00:00.000Z',
    lastVerifiedAt: '2026-08-20T12:00:00.000Z',
  };
  const z: DriveConnection = {
    ...y,
    id: '018f0000-0000-7000-8000-000000000502',
    googleSub: 'sub-z',
    email: 'z@example.test',
    displayName: 'Drive Z',
  };
  const vault = {
    id: '018f0000-0000-7000-8000-000000000503',
    name: 'Vault A',
    driveConnectionId: y.id,
    media: ['server', 'drive'],
  } as VaultConfig;

  function registry(disconnect = vi.fn(async () => undefined)): DriveConnectionRegistry {
    return {
      connect: vi.fn(async () => ({ status: 'ok' as const, connection: z })),
      authorize: vi.fn(async (connection) => ({ status: 'ok' as const, connection })),
      authorization: vi.fn(() => 'connected' as const),
      subscribe: vi.fn(() => () => undefined),
      tokens: vi.fn(() => null),
      disconnect,
    };
  }

  test('lists separate identities and moves one vault through the supplied verified migration', async () => {
    vi.mocked(listDriveConnections).mockResolvedValue([y, z]);
    vi.mocked(listVaultConfigs).mockResolvedValue([vault]);
    const moveVault = vi.fn(async () => ({ cleanupFailures: [] }));
    const user = userEvent.setup();
    renderPanel('/settings/connections', {
      driveRegistry: registry(),
      driveMoveVault: moveVault,
    });

    expect(await screen.findByText('Drive Y · y@example.test')).toBeInTheDocument();
    expect(screen.getByText('Drive Z · z@example.test')).toBeInTheDocument();
    expect(screen.getByText('Used by: Vault A')).toBeInTheDocument();
    await user.click(screen.getByText('Vault Drive bindings'));
    await user.selectOptions(screen.getByLabelText('Move Vault A to Drive account'), z.id);
    await user.click(screen.getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(moveVault).toHaveBeenCalledWith(vault.id, z.id));
    expect(
      await screen.findByText('The vault was verified in the new Drive account and moved.'),
    ).toBeInTheDocument();
  });

  test('requires explicit acknowledgement and states that Drive files remain', async () => {
    vi.mocked(listDriveConnections).mockResolvedValue([y]);
    vi.mocked(listVaultConfigs).mockResolvedValue([vault]);
    const disconnect = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, 'DRIVE_CONNECTION_BOUND', 'bound'))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderPanel('/settings/connections', { driveRegistry: registry(disconnect) });

    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(
      await screen.findByText(/encrypted files remain your property in Google Drive/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disconnect and leave files in Drive' }));

    await waitFor(() => expect(disconnect).toHaveBeenLastCalledWith(y, true));
    expect(
      await screen.findByText('Drive account disconnected. Its files remain in Google Drive.'),
    ).toBeInTheDocument();
  });
});

describe('ConnectionsPanel — paranoid Google Drive storage', () => {
  test('never renders the Drive card without a runtime client id', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue(SERVER_MEDIA);
    window.__BT__ = { googleDriveClientId: '' };
    renderPanel();

    // The initial render is pending, so this catches a titled skeleton flash.
    expect(screen.queryByText('Google Drive vault storage')).not.toBeInTheDocument();
    expect(await screen.findByText('Bank & broker cash sync')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Google Drive vault storage')).not.toBeInTheDocument(),
    );
  });

  test('shows the Drive card when the runtime client id is configured', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue(SERVER_MEDIA);
    window.__BT__ = { googleDriveClientId: 'runtime.apps.googleusercontent.com' };
    renderPanel();

    expect(await screen.findByText('Google Drive vault storage')).toBeInTheDocument();
    expect(await screen.findByText('Disconnected')).toBeInTheDocument();
  });

  test('shows the Drive card when Drive is already selected without a runtime client id', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue(DRIVE_ONLY_MEDIA);
    window.__BT__ = { googleDriveClientId: '' };
    renderPanel();

    expect(await screen.findByText('Google Drive vault storage')).toBeInTheDocument();
    expect(await screen.findByText('Needs sign-in')).toBeInTheDocument();
  });

  test('suppresses Drive status errors without a runtime client id', async () => {
    let rejectRequest!: (reason?: unknown) => void;
    vi.mocked(getParanoidMediaState).mockImplementation(
      () =>
        new Promise<ParanoidMediaStateResponse>((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    window.__BT__ = { googleDriveClientId: '' };
    renderPanel();

    expect(screen.queryByText('Google Drive vault storage')).not.toBeInTheDocument();
    await waitFor(() => expect(getParanoidMediaState).toHaveBeenCalledTimes(1));
    await act(async () => {
      rejectRequest(new Error('offline'));
    });
    expect(screen.queryByText('Google Drive vault storage')).not.toBeInTheDocument();
  });

  test('retries a recoverable storage-status failure', async () => {
    vi.mocked(getParanoidMediaState)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(SERVER_MEDIA);
    const user = userEvent.setup();
    renderPanel('/settings/connections', {
      driveConnection: controller(),
      driveConfigured: true,
    });

    const error = await screen.findByText(/storage status could not be loaded/i);
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(error).not.toBeInTheDocument());
    expect(getParanoidMediaState).toHaveBeenCalledTimes(2);
  });

  test('connects a server-only vault through the verified media flow', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue(SERVER_MEDIA);
    const drive = controller();
    const user = userEvent.setup();
    renderPanel('/settings/connections', {
      driveConnection: drive,
      driveConfigured: true,
    });

    expect(await screen.findByText('Google Drive vault storage')).toBeInTheDocument();
    expect(await screen.findByText('Disconnected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect Drive' }));

    await waitFor(() => expect(drive.connect).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Google Drive vault storage connected.')).toBeInTheDocument();
  });

  test('refreshes a committed storage choice when follow-up synchronization needs attention', async () => {
    vi.mocked(getParanoidMediaState)
      .mockResolvedValueOnce(SERVER_MEDIA)
      .mockResolvedValue(BOTH_MEDIA);
    const drive = controller();
    vi.mocked(drive.connect).mockResolvedValue({
      status: 'ok',
      media: BOTH_STATE,
      driveLeftover: false,
      synchronization: { status: 'pending', cause: new Error('reconnect failed') },
    });
    const user = userEvent.setup();
    renderPanel('/settings/connections', {
      driveConnection: drive,
      driveConfigured: true,
    });

    await user.click(await screen.findByRole('button', { name: 'Connect Drive' }));

    expect(
      await screen.findByText(
        'The storage choice was saved, but synchronization still needs attention. BetterTrack will retry from the encrypted pending copy.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(getParanoidMediaState).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(
      screen.queryByText(
        'The storage change was cancelled because a verified copy could not be completed.',
      ),
    ).not.toBeInTheDocument();
  });

  test('explains a blocked preflight and an unreadable Drive leftover in their own words', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue(SERVER_MEDIA);
    const drive = controller();
    vi.mocked(drive.connect).mockResolvedValueOnce({
      status: 'failed',
      media: null,
      driveLeftover: false,
      stage: 'preflight-sync',
      message: 'not reconciled',
      synchronization: { status: 'pending' },
    });
    const user = userEvent.setup();
    renderPanel('/settings/connections', {
      driveConnection: drive,
      driveConfigured: true,
    });

    await user.click(await screen.findByRole('button', { name: 'Connect Drive' }));
    expect(
      await screen.findByText(
        'Your latest encrypted changes are not on every selected medium yet, so the storage choice was left unchanged. Try again once synchronization has finished.',
      ),
    ).toBeInTheDocument();

    vi.mocked(drive.connect).mockResolvedValueOnce({
      status: 'failed',
      media: null,
      driveLeftover: false,
      stage: 'authenticate-drive',
      message: 'leftover does not authenticate',
    });
    await user.click(screen.getByRole('button', { name: 'Connect Drive' }));
    expect(
      await screen.findByText(
        'A Google Drive copy of your vault could not be decrypted with this vault key. BetterTrack never deletes ciphertext it cannot verify — remove the affected encrypted file from BetterTrack Vaults, then try again.',
      ),
    ).toBeInTheDocument();
  });

  test('surfaces token expiry as an explicit Google sign-in action', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue(BOTH_MEDIA);
    const drive = controller('token-expired');
    const user = userEvent.setup();
    renderPanel('/settings/connections', {
      driveConnection: drive,
      driveConfigured: true,
    });

    expect(await screen.findByText('Needs sign-in')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in to Google to sync' }));
    await waitFor(() => expect(drive.connect).toHaveBeenCalledTimes(1));
  });

  test('updates an open connection card when its browser token expires', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getParanoidMediaState).mockResolvedValue(BOTH_MEDIA);
      const drive = expiringController(1_000);
      renderPanel('/settings/connections', {
        driveConnection: drive,
        driveConfigured: true,
      });

      await vi.waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(screen.getByText('Needs sign-in')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign in to Google to sync' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('routes disconnect through the media controller and withholds last-medium removal', async () => {
    const drive = controller();
    const user = userEvent.setup();
    vi.mocked(getParanoidMediaState).mockResolvedValue(BOTH_MEDIA);
    const rendered = renderPanel('/settings/connections', {
      driveConnection: drive,
      driveConfigured: true,
    });

    await user.click(await screen.findByRole('button', { name: 'Disconnect Drive' }));
    await waitFor(() => expect(drive.disconnect).toHaveBeenCalledTimes(1));

    rendered.unmount();
    vi.mocked(getParanoidMediaState).mockResolvedValue(DRIVE_ONLY_MEDIA);
    renderPanel('/settings/connections', {
      driveConnection: drive,
      driveConfigured: true,
    });
    expect(await screen.findByText(/only vault medium/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect Drive' })).not.toBeInTheDocument();
  });

  test('exposes Drive-only and add-server transitions in a folded storage control', async () => {
    const drive = controller();
    const user = userEvent.setup();
    vi.mocked(getParanoidMediaState).mockResolvedValue(BOTH_MEDIA);
    const rendered = renderPanel('/settings/connections', {
      driveConnection: drive,
      driveConfigured: true,
    });

    await user.click(await screen.findByText('Vault storage copies'));
    await user.click(screen.getByRole('button', { name: 'Use Drive only' }));
    await waitFor(() => expect(drive.useDriveOnly).toHaveBeenCalledTimes(1));

    rendered.unmount();
    vi.mocked(getParanoidMediaState).mockResolvedValue(DRIVE_ONLY_MEDIA);
    renderPanel('/settings/connections', {
      driveConnection: drive,
      driveConfigured: true,
    });
    await user.click(await screen.findByText('Vault storage copies'));
    await user.click(screen.getByRole('button', { name: 'Add server copy' }));
    await waitFor(() => expect(drive.addServerCopy).toHaveBeenCalledTimes(1));
  });

  test('hides stale server-retirement purge controls after the server copy is active again', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue({
      privacyMode: 'paranoid',
      mediaState: {
        ...BOTH_STATE,
        server: { ...BOTH_STATE.server, retired: RETIRED_SERVER },
      },
    });
    renderPanel('/settings/connections', {
      driveConnection: controller(),
      driveConfigured: true,
    });

    expect(await screen.findByText('Google Drive vault storage')).toBeInTheDocument();
    expect(screen.queryByText('Retained server recovery copy')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete retained server copy' }),
    ).not.toBeInTheDocument();
  });

  test('unlocks from the user gesture before starting a storage transition', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue(SERVER_MEDIA);
    const drive = controller();
    const unlock = vi.fn(async () => drive);
    const user = userEvent.setup();
    renderPanel('/settings/connections', {
      driveConnection: null,
      driveUnlock: unlock,
      driveConfigured: true,
    });

    await user.click(await screen.findByRole('button', { name: 'Connect Drive' }));
    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Unlock and continue' }));

    await waitFor(() =>
      expect(unlock).toHaveBeenCalledWith('correct horse', {
        authorizeDrive: true,
        driveOnly: false,
      }),
    );
    expect(drive.connect).toHaveBeenCalledTimes(1);
  });
});
