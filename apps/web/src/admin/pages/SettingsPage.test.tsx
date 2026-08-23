import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AppSettingsResponse, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider } from '../../i18n';
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

function renderPage(locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter>
        <AuthProvider>
          <SettingsPage />
        </AuthProvider>
      </MemoryRouter>
    </I18nProvider>,
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

test('a saved gated mode points at the People workspace instead of hosting its queue', async () => {
  vi.mocked(api.getSettings).mockResolvedValue({ ...settings, registrationMode: 'approval' });
  renderPage();

  expect(await screen.findByRole('link', { name: 'Open Registration' })).toHaveAttribute(
    'href',
    '/admin/registration',
  );
  // The approval queue itself no longer lives here (#1406 W1).
  expect(screen.queryByRole('heading', { name: 'Approval queue' })).not.toBeInTheDocument();
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

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Something went wrong. Please try again.',
  );

  vi.mocked(api.getSettings).mockResolvedValueOnce(settings);
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

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

  expect(await screen.findByText(/something went wrong. please try again/i)).toBeInTheDocument();
});

test('renders the P13b settings surface in German', async () => {
  renderPage('de');

  expect(await screen.findByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Geschlossen/i })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Beta-Modus/i })).toBeInTheDocument();
});
