import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { EmailPage } from './EmailPage';

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

function renderPage() {
  return render(
    <AuthProvider>
      <EmailPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getEmailStatus).mockResolvedValue({ enabled: true });
  vi.mocked(api.sendTestEmail).mockResolvedValue({ status: 'sent', to: admin.email });
});

test('shows the channel as enabled and sends a test email', async () => {
  renderPage();

  expect(await screen.findByText('Enabled')).toBeInTheDocument();

  // Blank field ⇒ server defaults to the admin's own email (to is omitted).
  await userEvent.click(screen.getByRole('button', { name: /send test email/i }));

  await waitFor(() => expect(api.sendTestEmail).toHaveBeenCalledWith({ to: undefined }));
  expect(
    await screen.findByText(/test email sent to admin@bettertrack\.test/i),
  ).toBeInTheDocument();
});

test('shows the channel as disabled when SMTP is unset', async () => {
  vi.mocked(api.getEmailStatus).mockResolvedValue({ enabled: false });
  renderPage();

  expect(await screen.findByText('Disabled')).toBeInTheDocument();
  expect(screen.getByText(/email channel is off/i)).toBeInTheDocument();
});
