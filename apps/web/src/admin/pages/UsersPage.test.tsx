import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminStats,
  AdminUser,
  CreateUserResponse,
  MeResponse,
  ResetPasswordResponse,
} from '@bettertrack/contracts';

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
  baseCurrency: 'EUR',
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
      <UsersPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getStats).mockResolvedValue(stats);
  vi.mocked(api.listUsers).mockResolvedValue({ users: [jane] });
});

test('renders the users table with account details and stats', async () => {
  renderPage();

  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();
  expect(screen.getByText('jane')).toBeInTheDocument();
  // Stats strip surfaces the overview counts.
  expect(await screen.findByText('Pending invites')).toBeInTheDocument();
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

test('reset-password flow shows the new temp password once', async () => {
  const result: ResetPasswordResponse = { user: jane, tempPassword: 'Reset-Pass-4242' };
  vi.mocked(api.resetPassword).mockResolvedValue(result);

  const user = userEvent.setup();
  renderPage();
  await screen.findByText('jane@bettertrack.test');

  await user.click(screen.getByRole('button', { name: 'Reset password' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Reset password' }));

  expect(await screen.findByText('Reset-Pass-4242')).toBeInTheDocument();
  expect(api.resetPassword).toHaveBeenCalledWith('user-1');
});

test('delete is gated behind type-username confirmation', async () => {
  vi.mocked(api.deleteUser).mockResolvedValue();

  const user = userEvent.setup();
  renderPage();
  await screen.findByText('jane@bettertrack.test');

  await user.click(screen.getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog');
  const confirmButton = within(dialog).getByRole('button', { name: 'Delete user' });
  expect(confirmButton).toBeDisabled();

  await user.type(within(dialog).getByLabelText('Confirm username'), 'jane');
  await waitFor(() => expect(confirmButton).toBeEnabled());

  await user.click(confirmButton);
  expect(api.deleteUser).toHaveBeenCalledWith('user-1', 'jane');
});
