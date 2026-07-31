import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AdminStats, AdminUser, CreateUserResponse, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import { I18nProvider } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
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
  chatBanned: false,
  lastLoginAt: null,
  createdAt: '2026-02-02T00:00:00.000Z',
};

const stats: AdminStats = {
  userCount: 2,
  activeUserCount: 2,
  disabledUserCount: 0,
  pendingInviteCount: 0,
};

function renderPage(locale = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/admin/users']}>
          <Routes>
            <Route path="/admin/users" element={<UsersPage />} />
            <Route path="/admin/users/:userId" element={<div>User detail view</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

function renderPersistentPage(locale = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/admin/users']}>
          <UsersPage />
          <Routes>
            <Route path="/admin/users" element={null} />
            <Route path="/admin/users/:userId" element={<div>User detail view</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
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
  vi.mocked(api.getStats).mockResolvedValue(stats);
  vi.mocked(api.listUsers).mockResolvedValue({ users: [jane] });
});

test('renders the slimmed users table with essential columns and stats', async () => {
  renderPage();

  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();
  expect(screen.getByText('jane')).toBeInTheDocument();
  expect(await screen.findByText('Pending invites')).toBeInTheDocument();
});

test('the user link is keyboard-operable without changing the selection', async () => {
  const user = userEvent.setup();
  renderPersistentPage();

  const checkbox = await screen.findByLabelText('Select jane');
  await user.click(checkbox);
  expect(checkbox).toBeChecked();
  expect(checkbox).toHaveFocus();

  const link = screen.getByRole('link', { name: /jane@bettertrack\.test jane/ });
  expect(link).toHaveAttribute('href', '/admin/users/user-1');

  await user.tab();
  expect(link).toHaveFocus();

  await user.keyboard('{Enter}');
  expect(await screen.findByText('User detail view')).toBeInTheDocument();
  expect(checkbox).toBeChecked();
  expect(screen.getByText('1 selected')).toBeInTheDocument();
});

test('clicking a user checkbox does not navigate', async () => {
  const user = userEvent.setup();
  renderPage();

  const checkbox = await screen.findByLabelText('Select jane');
  await user.click(checkbox);

  expect(checkbox).toBeChecked();
  expect(screen.queryByText('User detail view')).not.toBeInTheDocument();
});

test('the users table scrolls horizontally instead of clipping columns', async () => {
  renderPage();

  const table = await screen.findByRole('table');
  // jsdom does not calculate CSS overflow, so these classes are the regression contract.
  expect(table).toHaveClass('min-w-[40rem]');
  expect(table.parentElement).toHaveClass('overflow-x-auto');
  expect(table.parentElement).not.toHaveClass('overflow-hidden');
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

  await user.keyboard('{Escape}');
  expect(screen.getByText(created.tempPassword)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: "I've saved this" }));
  expect(screen.queryByText(created.tempPassword)).not.toBeInTheDocument();
});

test('bulk-disable names the selected count and only runs after confirmation', async () => {
  vi.mocked(api.bulkUserAction).mockResolvedValue({ action: 'disable', disabled: 1, skipped: 0 });

  const user = userEvent.setup();
  renderPage();
  await screen.findByText('jane@bettertrack.test');

  await user.click(screen.getByLabelText('Select jane'));
  await user.click(await screen.findByRole('button', { name: 'Disable selected' }));

  expect(await screen.findByRole('dialog', { name: 'Disable selected users?' })).toHaveTextContent(
    'Disable 1 selected user?',
  );
  expect(api.bulkUserAction).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(api.bulkUserAction).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Disable selected' }));
  await user.click(await screen.findByRole('button', { name: 'Disable 1 user' }));

  await waitFor(() =>
    expect(api.bulkUserAction).toHaveBeenCalledWith({ action: 'disable', userIds: ['user-1'] }),
  );
  expect(await screen.findByText(/Disabled 1 user/)).toBeInTheDocument();
});

test('bulk-disable names its single affected user in German', async () => {
  const user = userEvent.setup();
  renderPage('de');
  await screen.findByText('jane@bettertrack.test');

  await user.click(screen.getByLabelText('Select jane'));
  await user.click(screen.getByRole('button', { name: 'Ausgewählte deaktivieren' }));

  const dialog = await screen.findByRole('dialog', {
    name: 'Ausgewählte Nutzer deaktivieren?',
  });
  expect(dialog).toHaveTextContent('1 ausgewählten Nutzer deaktivieren?');
  expect(within(dialog).getByRole('button', { name: '1 Nutzer deaktivieren' })).toBeInTheDocument();
});

test('keeps a bulk-disable failure visible in its confirmation dialog', async () => {
  vi.mocked(api.bulkUserAction).mockRejectedValue(
    new ApiError(500, 'internal_error', 'Could not disable the selected users.'),
  );
  const user = userEvent.setup();
  renderPage();

  await screen.findByText('jane@bettertrack.test');
  await user.click(screen.getByLabelText('Select jane'));
  await user.click(screen.getByRole('button', { name: 'Disable selected' }));
  const dialog = await screen.findByRole('dialog', { name: 'Disable selected users?' });
  const confirm = within(dialog).getByRole('button', { name: 'Disable 1 user' });

  await user.click(confirm);

  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Could not disable the selected users.',
  );
  expect(confirm).toBeEnabled();

  await user.click(confirm);
  await waitFor(() => expect(api.bulkUserAction).toHaveBeenCalledTimes(2));
});
