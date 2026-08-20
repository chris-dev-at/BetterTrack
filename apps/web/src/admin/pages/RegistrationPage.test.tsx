import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AppSettingsResponse, MeResponse, RegistrationToken } from '@bettertrack/contracts';

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
  createdAt: '2026-07-14T00:00:00.000Z',
};

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
  vi.mocked(api.listRegistrationTokens).mockResolvedValue({ tokens: [] });
  vi.mocked(api.listRegistrationRequests).mockResolvedValue({ requests: [] });
});

test('shows the active registration mode and links back to the mode switch', async () => {
  renderPage();

  expect(await screen.findByText('Approval queue')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Change the mode in Settings' })).toHaveAttribute(
    'href',
    '/admin/settings',
  );
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

test('renders the registration surface in German', async () => {
  renderPage('de');

  expect(await screen.findByRole('heading', { name: 'Registrierung' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Freigabewarteschlange' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Registrierungstoken' })).toBeInTheDocument();
});
