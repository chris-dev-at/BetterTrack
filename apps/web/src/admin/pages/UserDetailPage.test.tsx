import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AdminUser, AuditLogEntry, EmailLogEntry, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { UserDetailPage } from './UserDetailPage';

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
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const jane: AdminUser = {
  id: 'user-1',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: '2026-02-02T00:00:00.000Z',
};

const auditEntry: AuditLogEntry = {
  id: '00000000-0000-7000-8000-000000000001',
  actorId: 'admin-1',
  action: 'user.email_changed',
  targetType: 'user',
  targetId: 'user-1',
  ip: '127.0.0.1',
  meta: { email: 'jane@bettertrack.test' },
  createdAt: '2026-03-03T00:00:00.000Z',
};

const emailEntry: EmailLogEntry = {
  id: '00000000-0000-7000-8000-000000000002',
  userId: 'user-1',
  recipient: 'jane@bettertrack.test',
  template: 'temp-password',
  subject: 'Your temporary password',
  status: 'sent',
  errorCode: null,
  createdAt: '2026-03-04T00:00:00.000Z',
};

function renderPage() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/admin/users/user-1']}>
        <Routes>
          <Route path="/admin/users/:userId" element={<UserDetailPage />} />
          <Route path="/admin/users" element={<div>Users list</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  // Reset call history + per-test implementations between cases; without this the
  // mocked adminApi retains calls from a sibling test and `toHaveBeenCalledWith`
  // matches (or reports) a stale mutation from the wrong test (#337).
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
  vi.mocked(api.listUsers).mockResolvedValue({ users: [jane] });
  vi.mocked(api.listUserAudit).mockResolvedValue({ entries: [auditEntry], nextCursor: null });
  vi.mocked(api.listUserEmails).mockResolvedValue({ entries: [emailEntry], nextCursor: null });
});

test('centralizes the profile, per-user audit log and per-user email log', async () => {
  renderPage();

  // Profile header + prefilled fields.
  expect(await screen.findByDisplayValue('jane')).toBeInTheDocument();
  expect(screen.getByDisplayValue('jane@bettertrack.test')).toBeInTheDocument();

  // Per-user audit + email history are rendered.
  expect(await screen.findByText('user.email_changed')).toBeInTheDocument();
  expect(await screen.findByText('Your temporary password')).toBeInTheDocument();

  // Every user action is reachable from this one view.
  expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reset password' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send test email' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
});

test('editing the username persists via updateUser', async () => {
  vi.mocked(api.updateUser).mockResolvedValue({ ...jane, username: 'jane2' });

  const user = userEvent.setup();
  renderPage();

  const usernameField = await screen.findByLabelText('Username');
  // Wait for the controlled value to settle before editing — otherwise a late
  // hydration can re-fill the field after `clear` and the typed text appends (#337).
  await waitFor(() => expect(usernameField).toHaveValue('jane'));
  await user.clear(usernameField);
  await user.type(usernameField, 'jane2');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(api.updateUser).toHaveBeenCalledWith('user-1', { username: 'jane2' }));
  expect(await screen.findByText('Profile updated.')).toBeInTheDocument();
});

test('editing the email persists via updateUser', async () => {
  vi.mocked(api.updateUser).mockResolvedValue({ ...jane, email: 'jane.doe@bettertrack.test' });

  const user = userEvent.setup();
  renderPage();

  const emailField = await screen.findByLabelText('Email');
  // Wait for the controlled value to settle before editing — otherwise a late
  // hydration can re-fill the field after `clear` and the typed text appends (#337).
  await waitFor(() => expect(emailField).toHaveValue('jane@bettertrack.test'));
  await user.clear(emailField);
  await user.type(emailField, 'jane.doe@bettertrack.test');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() =>
    expect(api.updateUser).toHaveBeenCalledWith('user-1', { email: 'jane.doe@bettertrack.test' }),
  );
});

test('reset-password action surfaces the new temp password once', async () => {
  vi.mocked(api.resetPassword).mockResolvedValue({ user: jane, tempPassword: 'Reset-Pass-4242' });

  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Reset password' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Reset password' }));

  expect(await screen.findByText('Reset-Pass-4242')).toBeInTheDocument();
  expect(api.resetPassword).toHaveBeenCalledWith('user-1');
});

test('delete is gated behind type-username confirmation', async () => {
  vi.mocked(api.deleteUser).mockResolvedValue();

  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog');
  const confirmButton = within(dialog).getByRole('button', { name: 'Delete user' });
  expect(confirmButton).toBeDisabled();

  await user.type(within(dialog).getByLabelText('Confirm username'), 'jane');
  await waitFor(() => expect(confirmButton).toBeEnabled());

  await user.click(confirmButton);
  expect(api.deleteUser).toHaveBeenCalledWith('user-1', 'jane');
});
