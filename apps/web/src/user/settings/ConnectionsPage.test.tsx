import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/userApi', () => ({
  getGoogleLinkStatus: vi.fn(),
  getParanoidMediaState: vi.fn(),
  unlinkGoogle: vi.fn(),
  googleStartUrl: vi.fn(() => 'http://api.test/api/v1/auth/google/start'),
}));

vi.mock('../vault/media/runtime', () => ({
  connectDriveConnection: vi.fn(),
  disconnectDriveConnection: vi.fn(),
  driveConnectionConfigured: vi.fn(() => true),
  driveConnectionReady: vi.fn(() => true),
  driveConnectionState: vi.fn(() => 'disconnected'),
  prepareDriveConnection: vi.fn(async () => undefined),
}));

import { ApiError } from '../../lib/apiClient';
import { getGoogleLinkStatus, getParanoidMediaState, unlinkGoogle } from '../../lib/userApi';
import {
  connectDriveConnection,
  disconnectDriveConnection,
  driveConnectionReady,
  driveConnectionState,
} from '../vault/media/runtime';
import { ConnectionsPage } from './ConnectionsPage';

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

function renderPage(initialEntry = '/settings/connections') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={client}>
        <ConnectionsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Google off by default so the section stays hidden unless a test opts in.
  vi.mocked(getGoogleLinkStatus).mockResolvedValue(GOOGLE_OFF);
  vi.mocked(getParanoidMediaState).mockResolvedValue({
    privacyMode: 'normal',
    mediaState: null,
  });
  vi.mocked(unlinkGoogle).mockResolvedValue(undefined);
  vi.mocked(connectDriveConnection).mockResolvedValue({
    status: 'ok',
    state: { mediaSet: ['server', 'drive'], driveAttestedVersion: 4 },
    recoveredAfterPatchFailure: false,
  });
  vi.mocked(disconnectDriveConnection).mockResolvedValue({
    status: 'ok',
    state: { mediaSet: ['server'], driveAttestedVersion: null },
    recoveredAfterPatchFailure: false,
  });
  vi.mocked(driveConnectionReady).mockReturnValue(true);
  vi.mocked(driveConnectionState).mockReturnValue('disconnected');
});

describe('ConnectionsPage — connector slots (V5-P0c)', () => {
  test('renders the compact, non-functional connector slots with sync semantics', async () => {
    renderPage();

    // The page shell renders even while Google is off.
    expect(await screen.findByRole('heading', { name: 'Connections' })).toBeInTheDocument();

    // Each designed slot is present with a "coming soon" chip and no dead button.
    expect(screen.queryByText('Google Drive backup')).not.toBeInTheDocument();
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

describe('ConnectionsPage — Google account (§13.4 V4-P4b, moved from Security)', () => {
  test('the section is hidden when Google is not configured (routes 404 / disabled)', async () => {
    renderPage();
    // The connectors still render; the Google section resolves to nothing once
    // the disabled status arrives (a transient skeleton clears on settle).
    expect(await screen.findByText('Bank & broker cash sync')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Google account')).not.toBeInTheDocument());
  });

  test('shows the linked identity and unlinks after a password re-auth', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue(LINKED);
    const user = userEvent.setup();
    renderPage();

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
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    await user.type(await screen.findByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Unlink Google' }));

    expect(await screen.findByText('Your password is incorrect.')).toBeInTheDocument();
  });

  test('Google as the only sign-in method: unlink is withheld with a hint', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue({ ...LINKED, canUnlink: false });
    renderPage();

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
    renderPage();

    expect(await screen.findByText('No Google account is linked.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect Google' })).toBeInTheDocument();
  });

  test('announces a just-completed link from the ?google=linked callback marker', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue(LINKED);
    renderPage('/settings/connections?google=linked');

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
    renderPage('/settings/connections?error=google_email_mismatch');

    expect(await screen.findByText(/doesn't match your account email/i)).toBeInTheDocument();
    // The connect affordance is still offered — nothing was linked.
    expect(screen.getByRole('link', { name: 'Connect Google' })).toBeInTheDocument();
  });
});

describe('ConnectionsPage — paranoid Google Drive app-data card', () => {
  test('offers a real connect action for a disconnected paranoid account', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue({
      privacyMode: 'paranoid',
      mediaState: { mediaSet: ['server'], driveAttestedVersion: null },
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Disconnected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect Drive' }));
    await waitFor(() => expect(connectDriveConnection).toHaveBeenCalledOnce());
    expect(await screen.findByText('Google Drive storage connected.')).toBeInTheDocument();
  });

  test('does not expose a dead Drive action while the encrypted vault is locked', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue({
      privacyMode: 'paranoid',
      mediaState: { mediaSet: ['server'], driveAttestedVersion: null },
    });
    vi.mocked(driveConnectionReady).mockReturnValue(false);
    vi.mocked(driveConnectionState).mockReturnValue('unavailable');
    renderPage();

    expect(await screen.findByText(/unlock your encrypted vault/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Drive' })).not.toBeInTheDocument();
  });

  test('shows needs-sign-in honestly and routes the gesture through the controller', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue({
      privacyMode: 'paranoid',
      mediaState: { mediaSet: ['server', 'drive'], driveAttestedVersion: 4 },
    });
    vi.mocked(driveConnectionState).mockReturnValue('needs-sign-in');
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Needs sign-in')).toBeInTheDocument();
    expect(screen.getByText('Sign in to Google to sync')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in to Google' }));
    await waitFor(() => expect(connectDriveConnection).toHaveBeenCalledOnce());
  });

  test('disconnects through the safe media flow and never offers removal of Drive-only', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue({
      privacyMode: 'paranoid',
      mediaState: { mediaSet: ['server', 'drive'], driveAttestedVersion: 4 },
    });
    vi.mocked(driveConnectionState).mockReturnValue('connected');
    const user = userEvent.setup();
    const view = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Disconnect Drive' }));
    await waitFor(() => expect(disconnectDriveConnection).toHaveBeenCalledOnce());
    expect(await screen.findByText('Google Drive storage disconnected.')).toBeInTheDocument();

    view.unmount();
    vi.mocked(getParanoidMediaState).mockResolvedValue({
      privacyMode: 'paranoid',
      mediaState: { mediaSet: ['drive'], driveAttestedVersion: 4 },
    });
    renderPage();
    expect(await screen.findByText(/Drive is your only vault location/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect Drive' })).not.toBeInTheDocument();
  });

  test('offers an explicit retry while post-switch Drive cleanup remains pending', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue({
      privacyMode: 'paranoid',
      mediaState: { mediaSet: ['server'], driveAttestedVersion: null },
    });
    vi.mocked(driveConnectionState).mockReturnValue('needs-attention');
    vi.mocked(disconnectDriveConnection).mockResolvedValue({
      status: 'ok-with-drive-leftover',
      state: { mediaSet: ['server'], driveAttestedVersion: null },
      deleteResult: {
        status: 'transport-failure',
        medium: 'drive',
        failure: { kind: 'api-failure', message: 'delete failed' },
      },
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText(/Drive removal still needs attention/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry Drive cleanup' }));
    await waitFor(() => expect(disconnectDriveConnection).toHaveBeenCalledOnce());
    expect(
      await screen.findByText(/encrypted Drive file couldn't be deleted/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Drive' })).not.toBeInTheDocument();
  });
});
