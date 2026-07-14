import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AppSettingsResponse, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { SettingsPage } from './SettingsPage';

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
  registrationMode: 'closed',
  betaMode: false,
  updatedAt: null,
  updatedBy: null,
};

function renderPage() {
  return render(
    <AuthProvider>
      <SettingsPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getMe).mockResolvedValue(admin);
  // Bootstrap now consults the mandatory-2FA setup gate — an enrolled admin.
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
    setupRequired: false,
    totpEnabled: true,
    totpPending: false,
    emailEnabled: false,
    twoFactorEmail: null,
    recoveryCodesRemaining: 8,
  });
  vi.mocked(api.getSettings).mockResolvedValue(settings);
  vi.mocked(api.updateSettings).mockResolvedValue(settings);
  vi.mocked(api.listRegistrationTokens).mockResolvedValue({ tokens: [] });
  vi.mocked(api.listRegistrationRequests).mockResolvedValue({ requests: [] });
});

test('shows all four registration modes, every one selectable (V4-P4a)', async () => {
  renderPage();

  // All four modes render as enabled radios — no "Coming soon".
  expect(await screen.findByRole('radio', { name: /Closed/i })).toBeChecked();
  for (const name of [/Closed/i, /Invite \/ access-token/i, /Approval/i, /^Open/i]) {
    expect(screen.getByRole('radio', { name })).toBeEnabled();
  }
  expect(screen.queryByText(/Coming soon/i)).not.toBeInTheDocument();

  // The beta-mode toggle placeholder is present.
  expect(screen.getByRole('checkbox', { name: /Beta mode/i })).toBeInTheDocument();
});

test('switching to a self-serve mode and saving persists it', async () => {
  vi.mocked(api.updateSettings).mockResolvedValue({ ...settings, registrationMode: 'open' });
  renderPage();

  await userEvent.click(await screen.findByRole('radio', { name: /^Open/i }));
  await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

  await waitFor(() =>
    expect(api.updateSettings).toHaveBeenCalledWith({
      registrationMode: 'open',
      betaMode: false,
    }),
  );
});

test('creates a registration token and shows the register URL once', async () => {
  vi.mocked(api.createRegistrationToken).mockResolvedValue({
    token: {
      id: 'tok-1',
      label: 'beta',
      status: 'active',
      maxUses: 3,
      useCount: 0,
      expiresAt: null,
      revokedAt: null,
      createdAt: '2026-07-14T00:00:00.000Z',
    },
    registerUrl: 'http://localhost:5173/register?token=RAW-SECRET',
  });
  renderPage();

  await userEvent.click(await screen.findByRole('button', { name: /create token/i }));

  await waitFor(() => expect(api.createRegistrationToken).toHaveBeenCalled());
  expect(await screen.findByText(/RAW-SECRET/)).toBeInTheDocument();
});

test('approves a pending registration from the queue', async () => {
  vi.mocked(api.listRegistrationRequests).mockResolvedValue({
    requests: [
      {
        id: 'req-1',
        email: 'queue@test.dev',
        username: 'queue_user',
        createdAt: '2026-07-14T00:00:00.000Z',
      },
    ],
  });
  vi.mocked(api.approveRegistrationRequest).mockResolvedValue({
    ...admin,
    id: 'new-user',
    email: 'queue@test.dev',
    username: 'queue_user',
    role: 'user',
  } as never);
  renderPage();

  await userEvent.click(await screen.findByRole('button', { name: /approve/i }));
  await waitFor(() => expect(api.approveRegistrationRequest).toHaveBeenCalledWith('req-1'));
});

test('toggling beta mode and saving persists via updateSettings', async () => {
  renderPage();

  const save = await screen.findByRole('button', { name: /save settings/i });
  // Nothing changed yet ⇒ Save is disabled.
  expect(save).toBeDisabled();

  await userEvent.click(screen.getByRole('checkbox', { name: /Beta mode/i }));
  expect(save).toBeEnabled();

  await userEvent.click(save);

  await waitFor(() =>
    expect(api.updateSettings).toHaveBeenCalledWith({
      registrationMode: 'closed',
      betaMode: true,
    }),
  );
  expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
});

test('offers a retry after a load failure', async () => {
  const { ApiError } = await import('../../lib/apiClient');
  vi.mocked(api.getSettings).mockRejectedValueOnce(
    new ApiError(500, 'internal_error', 'Something went wrong.'),
  );
  renderPage();

  expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');

  vi.mocked(api.getSettings).mockResolvedValueOnce(settings);
  await userEvent.click(screen.getByRole('button', { name: /retry/i }));

  expect(await screen.findByRole('radio', { name: /Closed/i })).toBeInTheDocument();
});

test('surfaces a save error from the API', async () => {
  const { ApiError } = await import('../../lib/apiClient');
  vi.mocked(api.updateSettings).mockRejectedValueOnce(
    new ApiError(422, 'validation_error', 'Registration mode not allowed.'),
  );
  renderPage();

  await userEvent.click(await screen.findByRole('checkbox', { name: /Beta mode/i }));
  await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

  expect(await screen.findByText(/registration mode not allowed/i)).toBeInTheDocument();
});
