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
  baseCurrency: 'EUR',
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
  vi.mocked(api.getSettings).mockResolvedValue(settings);
  vi.mocked(api.updateSettings).mockResolvedValue(settings);
});

test('shows all four registration modes with only Closed selectable', async () => {
  renderPage();

  // All four modes render as radios.
  expect(await screen.findByRole('radio', { name: /Closed/i })).toBeInTheDocument();
  const invite = screen.getByRole('radio', { name: /Invite \/ access-token/i });
  const approval = screen.getByRole('radio', { name: /Approval/i });
  const open = screen.getByRole('radio', { name: /^Open/i });

  // Only Closed is enabled; the other three are disabled + marked Coming soon.
  expect(screen.getByRole('radio', { name: /Closed/i })).toBeEnabled();
  expect(screen.getByRole('radio', { name: /Closed/i })).toBeChecked();
  expect(invite).toBeDisabled();
  expect(approval).toBeDisabled();
  expect(open).toBeDisabled();
  expect(screen.getAllByText(/Coming soon/i)).toHaveLength(3);

  // The beta-mode toggle placeholder is present.
  expect(screen.getByRole('checkbox', { name: /Beta mode/i })).toBeInTheDocument();
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
