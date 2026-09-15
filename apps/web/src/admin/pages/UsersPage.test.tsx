import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminStats,
  AdminUser,
  AdminUserListResponse,
  CreateUserResponse,
  MeResponse,
} from '@bettertrack/contracts';

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
  pendingRegistrationCount: 0,
};

function page(users: AdminUser[], total = users.length, offset = 0): AdminUserListResponse {
  return { users, page: { total, limit: 25, offset } };
}

function renderPage(locale = 'en', entry = '/admin/users') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <MemoryRouter initialEntries={[entry]}>
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

/** The query the page last sent, so filter/sort/page tests assert the real call. */
function lastListQuery(): Record<string, unknown> {
  const calls = vi.mocked(api.listUsers).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
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
  vi.mocked(api.listUsers).mockResolvedValue(page([jane]));
});

test('renders the users table with essential columns and stats', async () => {
  renderPage();

  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();
  expect(screen.getByText('jane')).toBeInTheDocument();
  expect(await screen.findByText('Pending invites')).toBeInTheDocument();
});

test('renders stats read failure with recovery without hiding the users table', async () => {
  vi.mocked(api.getStats).mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'stats unavailable'));
  renderPage();

  expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();
});

test('renders a forbidden stats read as unavailable without retry', async () => {
  vi.mocked(api.getStats).mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'secret'));
  renderPage();

  expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  expect(screen.queryByText('secret')).not.toBeInTheDocument();
  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();
});

test('the user link is keyboard-operable without changing the selection', async () => {
  const user = userEvent.setup();
  renderPersistentPage();

  const checkbox = await screen.findByLabelText('Select jane');
  await user.click(checkbox);
  expect(checkbox).toBeChecked();
  expect(checkbox).toHaveFocus();

  const link = screen.getByRole('link', { name: /jane jane@bettertrack\.test/ });
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
  expect(table).toHaveStyle({ minWidth: '56rem' });
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

  await user.click(screen.getByLabelText('jane auswählen'));
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
    'Something went wrong. Please try again.',
  );
  expect(confirm).toBeEnabled();

  await user.click(confirm);
  await waitFor(() => expect(api.bulkUserAction).toHaveBeenCalledTimes(2));
});

test('renders the P13b users surface in German', async () => {
  renderPage('de');

  expect(await screen.findByRole('heading', { name: 'Nutzer' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Nutzer erstellen' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Nach E-Mail oder Benutzername filtern')).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Rolle' })).toBeInTheDocument();
});

// ── #1406 W2: filters, sorting and paging are SERVER-side ────────────────────
// Each of these asserts the query that actually left the page. A filter that
// only narrows the rows already in the browser would pass a "the table shows
// one row" assertion while silently paging past the matches on the server.

test('sends the contract defaults on first load and asks for a bounded page', async () => {
  renderPage();
  await screen.findByText('jane@bettertrack.test');

  expect(lastListQuery()).toMatchObject({
    sort: 'createdAt',
    direction: 'desc',
    limit: 25,
    offset: 0,
  });
});

test('a kind filter goes to the server and lands in the URL', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('jane@bettertrack.test');

  await user.selectOptions(screen.getByLabelText('Role'), 'admin');

  await waitFor(() => expect(lastListQuery()).toMatchObject({ role: 'admin' }));
});

test('a state filter and a privacy filter combine rather than replace each other', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('jane@bettertrack.test');

  await user.selectOptions(screen.getByLabelText('Status'), 'disabled');
  await waitFor(() => expect(lastListQuery()).toMatchObject({ status: 'disabled' }));

  await user.selectOptions(screen.getByLabelText('Privacy'), 'paranoid');
  await waitFor(() =>
    expect(lastListQuery()).toMatchObject({ status: 'disabled', privacyMode: 'paranoid' }),
  );
});

test('clicking a column head sorts, and clicking it again flips the direction', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('jane@bettertrack.test');

  await user.click(screen.getByRole('button', { name: /User/ }));
  await waitFor(() =>
    expect(lastListQuery()).toMatchObject({ sort: 'username', direction: 'desc' }),
  );

  await user.click(screen.getByRole('button', { name: /User/ }));
  await waitFor(() =>
    expect(lastListQuery()).toMatchObject({ sort: 'username', direction: 'asc' }),
  );

  // The header announces the state it is in, not just the state it can go to.
  const header = screen.getByRole('columnheader', { name: /User/ });
  expect(header).toHaveAttribute('aria-sort', 'ascending');
});

test('the filter state lives in the URL, so a filtered view is a shareable link', async () => {
  renderPage('en', '/admin/users?role=admin&status=disabled&sort=email&dir=asc&limit=50&offset=50');
  await screen.findByText('jane@bettertrack.test');

  expect(lastListQuery()).toMatchObject({
    role: 'admin',
    status: 'disabled',
    sort: 'email',
    direction: 'asc',
    limit: 50,
    offset: 50,
  });
});

test('paging asks the server for the next window and reports the real total', async () => {
  vi.mocked(api.listUsers).mockResolvedValue(page([jane], 60, 0));
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('jane@bettertrack.test');

  expect(screen.getByText('1–1 of 60')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

  await user.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => expect(lastListQuery()).toMatchObject({ offset: 25 }));
});

/**
 * #1848 D2. The users list was one of the two pages that rendered its pager
 * INSIDE the non-empty branch, so bulk-disabling the last row of page 2 left an
 * empty state with no way back — the only escape was hand-editing `?offset=`.
 */
test('a page emptied by a bulk action snaps back to the last page that has rows', async () => {
  const user = userEvent.setup();
  const joe: AdminUser = { ...jane, id: 'user-2', username: 'joe', email: 'joe@bettertrack.test' };
  // 26 active accounts; the operator is on page 2, holding the 26th.
  vi.mocked(api.listUsers).mockImplementation(async (query = {}) =>
    (query.offset ?? 0) === 0 ? page([jane], 26, 0) : page([joe], 26, 25),
  );
  vi.mocked(api.bulkUserAction).mockResolvedValue({ action: 'disable', disabled: 1, skipped: 0 });
  renderPage('en', '/admin/users?status=active&offset=25');

  await screen.findByText('joe@bettertrack.test');
  expect(screen.getByText('26–26 of 26')).toBeInTheDocument();

  // The bulk action retires the only row of page 2; the reload behind it reads
  // the SAME offset, which now answers nothing.
  await user.click(screen.getByRole('checkbox', { name: 'Select all users' }));
  vi.mocked(api.listUsers).mockImplementation(async (query = {}) => {
    const offset = query.offset ?? 0;
    return offset === 0 ? page([jane], 25, 0) : page([], 25, offset);
  });
  await user.click(screen.getByRole('button', { name: 'Disable selected' }));
  await user.click(screen.getByRole('button', { name: 'Disable 1 user' }));

  await waitFor(() => expect(lastListQuery()).toMatchObject({ offset: 0 }));
  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();
  expect(screen.getByText('1–1 of 25')).toBeInTheDocument();
  expect(screen.queryByText(/26–25/)).not.toBeInTheDocument();
});

test('an empty page past the first keeps a working way back', async () => {
  const user = userEvent.setup();
  // The window answered nothing and the snap-back has not landed yet: the
  // empty state renders, and the pager must render WITH it.
  vi.mocked(api.listUsers).mockResolvedValue(page([], 25, 25));
  renderPage('en', '/admin/users?offset=25');

  expect(await screen.findByText('No users yet. Create the first one.')).toBeInTheDocument();
  const previous = screen.getByRole('button', { name: 'Previous' });
  expect(previous).toBeEnabled();
  // The range never counts backwards, whatever the window answered.
  expect(screen.getByText('0–0 of 25')).toBeInTheDocument();

  await user.click(previous);
  await waitFor(() => expect(lastListQuery()).toMatchObject({ offset: 0 }));
});

test('changing a filter returns to the first page instead of stranding the operator', async () => {
  const user = userEvent.setup();
  renderPage('en', '/admin/users?offset=50');
  await screen.findByText('jane@bettertrack.test');
  expect(lastListQuery()).toMatchObject({ offset: 50 });

  await user.selectOptions(screen.getByLabelText('Role'), 'admin');

  await waitFor(() => expect(lastListQuery()).toMatchObject({ role: 'admin', offset: 0 }));
});

test('a paranoid account is marked in the list without exposing anything inside the vault', async () => {
  vi.mocked(api.listUsers).mockResolvedValue(
    page([
      {
        ...jane,
        privacyMode: 'paranoid',
        paranoid: {
          mediaSet: ['server'],
          vault: { version: 14, sizeBytes: 63897, updatedAt: '2026-08-20T10:00:00.000Z' },
          historyCount: 13,
        },
      },
    ]),
  );
  renderPage();

  const row = (await screen.findByText('jane')).closest('tr');
  expect(row).not.toBeNull();
  expect(within(row!).getByText('Paranoid')).toBeInTheDocument();
  // The list shows the MODE. It never shows the vault's size, version or history.
  expect(within(row!).queryByText(/63897|63,897/)).not.toBeInTheDocument();
});
