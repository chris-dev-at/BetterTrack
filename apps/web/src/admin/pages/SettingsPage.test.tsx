import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AppSettingsResponse, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider, localizedMessage } from '../../i18n';
import { AuthProvider } from '../AuthContext';
import { SettingsPage } from './SettingsPage';

/** Expected copy always comes from the catalog, so EN and DE assert the same claim. */
const message = (locale: 'en' | 'de', key: string) => localizedMessage(locale, key);

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
  // A test below reads the exact payload of the FIRST save, so call history
  // starts from zero.
  vi.clearAllMocks();
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

test.each(['en', 'de'] as const)(
  'shows the registration mode read-only and points at its one home in %s',
  async (locale) => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...settings, registrationMode: 'approval' });
    renderPage(locale);

    // The stored mode is stated, not offered: a label and the current value.
    expect(
      await screen.findByText(message(locale, 'admin.registration.currentMode')),
    ).toBeInTheDocument();
    expect(
      screen.getByText(message(locale, 'admin.settings.registration.modes.approval.title')),
    ).toBeInTheDocument();

    // …and the single pointer at where it IS edited (#1406 W2).
    expect(
      screen.getByRole('link', { name: message(locale, 'admin.settings.registration.movedLink') }),
    ).toHaveAttribute('href', '/admin/registration');
  },
);

test('the mode has NO second home here — the page renders no selector at all', async () => {
  renderPage();

  await screen.findByRole('checkbox', { name: /Beta mode/i });

  // The W2 ruling: exactly one home for the registration mode. A radio group
  // here would be a second one, so its absence is enforced, not assumed.
  expect(screen.queryAllByRole('radio')).toHaveLength(0);
  expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  expect(screen.queryByRole('group', { name: /registration mode/i })).not.toBeInTheDocument();
  // Nor does the old inline queue/token management live here (#1406 W1).
  expect(screen.queryByRole('heading', { name: 'Approval queue' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Registration tokens' })).not.toBeInTheDocument();
});

test('saving sends ONLY betaMode — never the mode it no longer owns', async () => {
  vi.mocked(api.updateSettings).mockResolvedValue({ ...settings, betaMode: true });
  renderPage();

  const save = await screen.findByRole('button', { name: /save settings/i });
  // Nothing changed yet ⇒ Save is disabled.
  expect(save).toBeDisabled();

  await userEvent.click(screen.getByRole('checkbox', { name: /Beta mode/i }));
  expect(save).toBeEnabled();

  await userEvent.click(save);

  // Deep equality: a `registrationMode` smuggled into the payload fails here.
  await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ betaMode: true }));
  expect(vi.mocked(api.updateSettings).mock.calls[0]![0]).not.toHaveProperty('registrationMode');

  expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
  // The saved value is the one the server echoed back, and Save goes quiet again.
  expect(screen.getByRole('checkbox', { name: /Beta mode/i })).toBeChecked();
  expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
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

  // Loaded: the mode badge and the beta toggle are back.
  expect(await screen.findByText('Closed')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /Beta mode/i })).toBeInTheDocument();
});

test('surfaces a save error from the API', async () => {
  const { ApiError } = await import('../../lib/apiClient');
  vi.mocked(api.updateSettings).mockRejectedValueOnce(
    new ApiError(422, 'validation_error', 'Beta mode not allowed.'),
  );
  renderPage();

  await userEvent.click(await screen.findByRole('checkbox', { name: /Beta mode/i }));
  await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

  // Catalog copy, not the server's English envelope (the useAdminMutation rule).
  expect(await screen.findByText(message('en', 'admin.settings.saveError'))).toBeInTheDocument();
  expect(screen.queryByText(/settings saved/i)).not.toBeInTheDocument();
});

test('renders the P13b settings surface in German', async () => {
  renderPage('de');

  expect(await screen.findByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument();
  expect(screen.getByText('Geschlossen')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /Beta-Modus/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Einstellungen speichern' })).toBeInTheDocument();
});
