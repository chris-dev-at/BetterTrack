import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AdminStats, AdminUser, CreateUserResponse, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { UsersPage } from './UsersPage';

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

const stats: AdminStats = {
  userCount: 2,
  activeUserCount: 2,
  disabledUserCount: 0,
  pendingInviteCount: 0,
};

function renderPage() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/admin/users']}>
        <Routes>
          <Route path="/admin/users" element={<UsersPage />} />
          <Route path="/admin/users/:userId" element={<div>User detail view</div>} />
        </Routes>
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
  vi.mocked(api.getStats).mockResolvedValue(stats);
  vi.mocked(api.listUsers).mockResolvedValue({ users: [jane] });
});

test('renders the slimmed users table with essential columns and stats', async () => {
  renderPage();

  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();
  expect(screen.getByText('jane')).toBeInTheDocument();
  expect(await screen.findByText('Pending invites')).toBeInTheDocument();
});

test('clicking a user row opens the user detail view', async () => {
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByText('jane@bettertrack.test'));
  expect(await screen.findByText('User detail view')).toBeInTheDocument();
});

test('create-user flow shows the generated temp password exactly once', async () => {
  const created: CreateUserResponse = {
    user: { ...jane, id: 'user-2', email: 'newbie@bettertrack.test', username: 'newbie' },
    tempPassword: 'Tmp-Sup3r-Secret-99',
  };
  vi.mocked(api.createUser).mockResolvedValue(created);

  const user = userEvent.setup();
  renderPage();
  await screen.findByText('jane@bettertrack.test');

  await user.click(screen.getByRole('button', { name: 'Create user' }));

  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('Email'), 'newbie@bettertrack.test');
  await user.type(within(dialog).getByLabelText('Username'), 'newbie');
  await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

  expect(await screen.findByText('Tmp-Sup3r-Secret-99')).toBeInTheDocument();
  expect(api.createUser).toHaveBeenCalledWith({
    email: 'newbie@bettertrack.test',
    username: 'newbie',
    role: 'user',
  });
});

test('bulk-select drives a bulk-disable action', async () => {
  vi.mocked(api.bulkUserAction).mockResolvedValue({ action: 'disable', disabled: 1, skipped: 0 });

  const user = userEvent.setup();
  renderPage();
  await screen.findByText('jane@bettertrack.test');

  await user.click(screen.getByLabelText('Select jane'));
  await user.click(await screen.findByRole('button', { name: 'Disable selected' }));

  expect(api.bulkUserAction).toHaveBeenCalledWith({ action: 'disable', userIds: ['user-1'] });
  expect(await screen.findByText(/Disabled 1 user/)).toBeInTheDocument();
});
