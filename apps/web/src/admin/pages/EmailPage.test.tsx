import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { ApiError } from '../../lib/apiClient';
import { localizedMessage } from '../../i18n';
import { AuthProvider, useAuth } from '../AuthContext';
import { EmailPage } from './EmailPage';

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

/** The console's auth status, so a sign-out on auth loss is observable. */
function AuthStatus() {
  const { status } = useAuth();
  return <span data-testid="status">{status}</span>;
}

function renderPage() {
  return render(
    <AuthProvider>
      <AuthStatus />
      {/* W4 folded Operations: the page renders the workspace tab strip, which
          needs a router. */}
      <MemoryRouter initialEntries={['/admin/email']}>
        <EmailPage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
    setupRequired: false,
    totpEnabled: true,
    totpPending: false,
    emailEnabled: false,
    twoFactorEmail: null,
    recoveryCodesRemaining: 8,
  });
  vi.mocked(api.getEmailStatus).mockResolvedValue({ enabled: true });
  vi.mocked(api.sendTestEmail).mockResolvedValue({ status: 'sent', to: admin.email });
  vi.mocked(api.listEmails).mockResolvedValue({ entries: [], nextCursor: null });
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

test('a closed admin session window signs the console out instead of a failed-send banner', async () => {
  // §6.12 answers a domainless 404 to a caller that is no longer an admin; on a
  // live console that is the V5-P13c window closing (#1814).
  const envelope = 'Not found';
  vi.mocked(api.sendTestEmail).mockRejectedValue(new ApiError(404, 'NOT_FOUND', envelope));
  const user = userEvent.setup();
  renderPage();

  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
  await user.click(screen.getByRole('button', { name: 'Send test email' }));

  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  expect(screen.queryByText(envelope)).not.toBeInTheDocument();
});

test('shows catalog copy — never the server envelope — when a send fails', async () => {
  const envelope = 'The mail service is unavailable.';
  vi.mocked(api.sendTestEmail).mockRejectedValue(new ApiError(503, 'UNAVAILABLE', envelope));
  const user = userEvent.setup();
  renderPage();

  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
  await user.click(screen.getByRole('button', { name: 'Send test email' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    localizedMessage('en', 'common.genericError'),
  );
  expect(screen.queryByText(envelope)).not.toBeInTheDocument();
});
