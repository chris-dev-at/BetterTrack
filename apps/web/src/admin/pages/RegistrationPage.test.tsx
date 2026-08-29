import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminStats,
  AppSettingsResponse,
  MeResponse,
  RegistrationToken,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider } from '../../i18n';
import { AuthProvider } from '../AuthContext';
import { RegistrationPage } from './RegistrationPage';

const admin: MeResponse = {
  id: 'admin-1',
  email: 'admin@bettertrack.test',
  username: 'rootadmin',
  role: 'admin',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: '2026-06-01T08:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const settings: AppSettingsResponse = {
  registrationMode: 'approval',
  betaMode: false,
  updatedAt: null,
  updatedBy: null,
};

const registrationToken: RegistrationToken = {
  id: '00000000-0000-0000-0000-0000000000dd',
  label: 'beta wave 1',
  status: 'active',
  maxUses: 3,
  useCount: 0,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-07-14T00:00:00.000Z',
};

const pendingRequest = {
  id: 'req-1',
  email: 'queue@test.dev',
  username: 'queue_user',
  // #1406 W2: the applicant row now says HOW they applied.
  provider: null as string | null,
  createdAt: '2026-07-14T00:00:00.000Z',
};

const stats: AdminStats = {
  userCount: 3,
  activeUserCount: 3,
  disabledUserCount: 0,
  pendingInviteCount: 1,
  pendingRegistrationCount: 1,
};

/**
 * A mode radio, addressed by its TITLE. Its accessible name is the whole label —
 * title followed by the explanation — so the pattern is anchored: an unanchored
 * /Approval/ also matches the sentence inside a different mode's description.
 */
function modeRadio(title: string): HTMLElement {
  return screen.getByRole('radio', { name: new RegExp(`^${title}`) });
}

function renderPage(locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter>
        <AuthProvider>
          <RegistrationPage />
        </AuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  // Several tests below assert how OFTEN a read ran (the mutation seam reloads
  // on success, and must not on failure), so call counts start from zero.
  vi.clearAllMocks();
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
    setupRequired: false,
    totpEnabled: true,
    totpPending: false,
    emailEnabled: false,
    twoFactorEmail: null,
    recoveryCodesRemaining: 8,
  });
  vi.mocked(api.getSettings).mockResolvedValue(settings);
  vi.mocked(api.getStats).mockResolvedValue(stats);
  vi.mocked(api.listRegistrationTokens).mockResolvedValue({ tokens: [] });
  vi.mocked(api.listRegistrationRequests).mockResolvedValue({ requests: [] });
});

// The Chief's ruling of 2026-08-29 moved the mode selector OFF /admin/settings
// and onto this page, beside the queue it governs. These four tests are what
// keeps it here: the control, its explicit save, its honest failure, and the
// absence of a second copy anywhere.
test('owns the registration-mode selector, beside the queue it governs', async () => {
  renderPage();

  expect(await screen.findByRole('heading', { name: 'Approval queue' })).toBeInTheDocument();

  // All four modes are offered, and the STORED one is the one selected — the
  // form seeds from the settings read rather than defaulting to `closed`.
  await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(4));
  await waitFor(() => expect(modeRadio('Approval')).toBeChecked());
  expect(modeRadio('Closed')).not.toBeChecked();

  // No pointer back to Settings: this page IS the home now, not a mirror of one.
  expect(screen.queryByRole('link', { name: /Settings/i })).not.toBeInTheDocument();
});

test('changing the mode is an explicit save, not a side effect of clicking a radio', async () => {
  vi.mocked(api.updateSettings).mockResolvedValue({ ...settings, registrationMode: 'open' });
  const user = userEvent.setup();
  renderPage();

  const save = await screen.findByRole('button', { name: 'Save settings' });
  expect(save).toBeDisabled();

  await user.click(modeRadio('Open'));
  // Selecting is not saving.
  expect(api.updateSettings).not.toHaveBeenCalled();
  await waitFor(() => expect(save).toBeEnabled());
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

  await user.click(save);
  await waitFor(() =>
    expect(api.updateSettings).toHaveBeenCalledWith({ registrationMode: 'open' }),
  );
  expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
});

test('a failed mode write shows catalog copy, never the server envelope', async () => {
  const { ApiError } = await import('../../lib/apiClient');
  vi.mocked(api.updateSettings).mockRejectedValueOnce(
    new ApiError(500, 'internal_error', 'Server-authored English envelope.'),
  );
  const user = userEvent.setup();
  renderPage();

  await screen.findByRole('button', { name: 'Save settings' });
  await user.click(modeRadio('Open'));
  await user.click(screen.getByRole('button', { name: 'Save settings' }));

  expect(
    await screen.findByText('The registration mode could not be changed.'),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Server-authored English envelope/)).not.toBeInTheDocument();
});

test('shows how each applicant applied, so Google and password are distinguishable', async () => {
  vi.mocked(api.listRegistrationRequests).mockResolvedValue({
    requests: [
      { ...pendingRequest, provider: 'google' },
      { ...pendingRequest, id: 'req-2', username: 'pw_user', provider: null },
    ],
  });

  renderPage();

  const googleRow = (await screen.findByText('queue_user')).closest('tr');
  const passwordRow = screen.getByText('pw_user').closest('tr');
  expect(within(googleRow!).getByText('google')).toBeInTheDocument();
  expect(within(passwordRow!).getByText('Password')).toBeInTheDocument();
});

test('approves a pending registration from the queue', async () => {
  vi.mocked(api.listRegistrationRequests).mockResolvedValue({ requests: [pendingRequest] });
  vi.mocked(api.approveRegistrationRequest).mockResolvedValue({
    ...admin,
    id: 'new-user',
    email: pendingRequest.email,
    username: pendingRequest.username,
    role: 'user',
  } as never);

  renderPage();

  await userEvent.click(await screen.findByRole('button', { name: /approve/i }));
  await waitFor(() => expect(api.approveRegistrationRequest).toHaveBeenCalledWith('req-1'));
  // The shared mutation seam reloads the queue on success.
  await waitFor(() => expect(api.listRegistrationRequests).toHaveBeenCalledTimes(2));
});

test('rejects a pending registration from the queue', async () => {
  vi.mocked(api.listRegistrationRequests).mockResolvedValue({ requests: [pendingRequest] });
  vi.mocked(api.rejectRegistrationRequest).mockResolvedValue(undefined);

  renderPage();

  await userEvent.click(await screen.findByRole('button', { name: /reject/i }));
  await waitFor(() => expect(api.rejectRegistrationRequest).toHaveBeenCalledWith('req-1'));
});

// The regression this guards: `apiClient.isNotAuthorized` is `401 || 404`,
// because admin reads answer 404 to non-admins on purpose. Routing a row-scoped
// WRITE through that rule logged a working admin out over a benign delete race —
// the row was simply already handled in another tab.
test('a 404 on a row-scoped write shows a banner and keeps the admin signed in', async () => {
  const { ApiError } = await import('../../lib/apiClient');
  vi.mocked(api.listRegistrationRequests).mockResolvedValue({ requests: [pendingRequest] });
  vi.mocked(api.approveRegistrationRequest).mockRejectedValueOnce(
    new ApiError(404, 'not_found', 'Registration request not found.'),
  );

  renderPage();

  await userEvent.click(await screen.findByRole('button', { name: /approve/i }));

  expect(
    await screen.findByText(
      'That application is no longer in the queue — someone may have handled it already.',
    ),
  ).toBeInTheDocument();
  // Still on the page, still authenticated: no login redirect, no 2FA trap.
  expect(screen.getByRole('heading', { name: 'Registration' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
});

test('a 404 when revoking a token is a banner too, not a sign-out', async () => {
  const { ApiError } = await import('../../lib/apiClient');
  vi.mocked(api.listRegistrationTokens).mockResolvedValue({ tokens: [registrationToken] });
  vi.mocked(api.revokeRegistrationToken).mockRejectedValueOnce(
    new ApiError(404, 'not_found', 'Token not found.'),
  );
  const user = userEvent.setup();

  renderPage();

  await screen.findByText(registrationToken.label!);
  await user.click(screen.getByRole('button', { name: 'Revoke' }));
  await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));

  expect(
    await screen.findByText('That token no longer exists; it may already have been revoked.'),
  ).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Registration' })).toBeInTheDocument();
});

test('two rows acted on at once keep their own progress state', async () => {
  const second = { ...pendingRequest, id: 'req-2', username: 'second_user' };
  vi.mocked(api.listRegistrationRequests).mockResolvedValue({
    requests: [pendingRequest, second],
  });

  // Row A settles first; row B is still in flight and must stay disabled.
  let releaseB: (() => void) | undefined;
  vi.mocked(api.approveRegistrationRequest).mockImplementation((id: string) => {
    if (id === 'req-1') return Promise.resolve({} as never);
    return new Promise((resolve) => {
      releaseB = () => resolve({} as never);
    });
  });

  const user = userEvent.setup();
  renderPage();

  await screen.findByText('queue_user');
  // Row 0 is the header row of the queue table.
  const rows = screen.getAllByRole('row');
  const approveB = within(rows[2]!).getByRole('button', { name: /approve/i });
  const approveA = within(rows[1]!).getByRole('button', { name: /approve/i });

  await user.click(approveB);
  await waitFor(() => expect(approveB).toBeDisabled());

  await user.click(approveA);
  await waitFor(() => expect(api.approveRegistrationRequest).toHaveBeenCalledWith('req-1'));

  // A finishing while B is still working must not re-enable B's control.
  await waitFor(() => expect(approveA).toBeEnabled());
  expect(approveB).toBeDisabled();

  releaseB?.();
  await waitFor(() => expect(approveB).toBeEnabled());
});

test('surfaces a localized banner when a decision fails, and never reloads the queue', async () => {
  const { ApiError } = await import('../../lib/apiClient');
  vi.mocked(api.listRegistrationRequests).mockResolvedValue({ requests: [pendingRequest] });
  vi.mocked(api.approveRegistrationRequest).mockRejectedValueOnce(
    new ApiError(409, 'conflict', 'Server-authored English envelope.'),
  );

  renderPage();

  await userEvent.click(await screen.findByRole('button', { name: /approve/i }));

  expect(
    await screen.findByText('Could not update that registration request.'),
  ).toBeInTheDocument();
  // The envelope the API authored never reaches the operator verbatim.
  expect(screen.queryByText(/Server-authored English envelope/)).not.toBeInTheDocument();
  expect(api.listRegistrationRequests).toHaveBeenCalledTimes(1);
});

test('creates a registration token and shows the register URL once', async () => {
  vi.mocked(api.createRegistrationToken).mockResolvedValue({
    token: { ...registrationToken, id: 'tok-1', label: 'beta' },
    registerUrl: 'http://localhost:5173/register?token=RAW-SECRET',
  });

  renderPage();

  await userEvent.click(await screen.findByRole('button', { name: /create token/i }));

  await waitFor(() => expect(api.createRegistrationToken).toHaveBeenCalled());
  expect(await screen.findByText(/RAW-SECRET/)).toBeInTheDocument();
});

test('requires confirmation before revoking a registration token', async () => {
  vi.mocked(api.listRegistrationTokens).mockResolvedValue({ tokens: [registrationToken] });
  vi.mocked(api.revokeRegistrationToken).mockResolvedValue(undefined);
  const user = userEvent.setup();

  renderPage();

  await screen.findByText(registrationToken.label!);
  await user.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(await screen.findByText('Revoke registration token “beta wave 1”?')).toBeInTheDocument();
  expect(api.revokeRegistrationToken).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(api.revokeRegistrationToken).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Revoke' }));
  await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
  await waitFor(() =>
    expect(api.revokeRegistrationToken).toHaveBeenCalledWith(registrationToken.id),
  );
});

test('offers a retry after the queue read fails', async () => {
  const { ApiError } = await import('../../lib/apiClient');
  vi.mocked(api.listRegistrationRequests).mockRejectedValueOnce(
    new ApiError(500, 'internal_error', 'Something went wrong.'),
  );

  renderPage();

  const alerts = await screen.findAllByRole('alert');
  expect(alerts.some((alert) => /Something went wrong/i.test(alert.textContent ?? ''))).toBe(true);

  vi.mocked(api.listRegistrationRequests).mockResolvedValue({ requests: [pendingRequest] });
  await userEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]!);

  expect(await screen.findByText('queue_user')).toBeInTheDocument();
});

test('a failed settings read says the mode is unknown, never that it is inactive', async () => {
  const { ApiError } = await import('../../lib/apiClient');
  vi.mocked(api.getSettings).mockRejectedValue(
    new ApiError(500, 'internal_error', 'Something went wrong.'),
  );

  renderPage();

  expect(
    await screen.findAllByText(/The active registration mode could not be read/),
  ).not.toHaveLength(0);
  // "Not the active mode right now." would claim a configuration we never read.
  expect(screen.queryByText(/not the active mode/i)).not.toBeInTheDocument();
});

test('renders the registration surface in German', async () => {
  renderPage('de');

  expect(await screen.findByRole('heading', { name: 'Registrierung' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Freigabewarteschlange' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Registrierungstoken' })).toBeInTheDocument();
});
