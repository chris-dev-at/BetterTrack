import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminInvite,
  AdminStats,
  CreateInviteResponse,
  MeResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider, localizedMessage } from '../../i18n';
import { AuthProvider } from '../AuthContext';
import { InvitesPage } from './InvitesPage';

/**
 * Expected copy resolves from the catalog, like every other admin page test.
 * The page was hardcoded English until #1406 W2 folded it into the People strip;
 * asserting the literal strings would let a missing translation pass.
 */
const en = (key: string, values: Record<string, string> = {}) =>
  Object.entries(values).reduce<string>(
    (text, [name, value]) => text.replaceAll(`{{${name}}}`, value),
    localizedMessage('en', key),
  );

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

const invite: AdminInvite = {
  id: '00000000-0000-0000-0000-0000000000cc',
  email: 'friend@bettertrack.test',
  status: 'pending',
  createdAt: '2026-07-30T09:00:00.000Z',
  expiresAt: '2026-08-06T09:00:00.000Z',
  usedAt: null,
  revokedAt: null,
};

const created: CreateInviteResponse = {
  invite,
  inviteUrl: 'https://bettertrack.test/invite/one-time-secret',
};

/** The People tab strip reads these for its counts (#1406 W2). */
const stats: AdminStats = {
  userCount: 3,
  activeUserCount: 3,
  disabledUserCount: 0,
  pendingInviteCount: 1,
  pendingRegistrationCount: 0,
};

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
  vi.mocked(api.listInvites).mockResolvedValue({
    invites: [invite],
    page: { total: 1, limit: 25, offset: 0 },
  });
  vi.mocked(api.getStats).mockResolvedValue(stats);
});

// The page is a People tab now: it renders the shared WorkspaceTabs strip, so
// it needs a router, and every string resolves through the catalog, so it needs
// the i18n provider.
function renderPage(locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter initialEntries={['/admin/invites']}>
        <AuthProvider>
          <InvitesPage />
        </AuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

test('requires an inline confirmation before revoking an invite', async () => {
  vi.mocked(api.revokeInvite).mockResolvedValue(undefined);
  const user = userEvent.setup();
  renderPage();

  await screen.findByText(invite.email);
  // The row's status reads from the catalog now, not a hardcoded English word.
  expect(await screen.findByText(en('admin.invites.status.pending'))).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: en('admin.actions.revoke') }));

  expect(
    await screen.findByText(en('admin.confirmations.revokeInvite.prompt', { email: invite.email })),
  ).toBeInTheDocument();
  expect(api.revokeInvite).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: en('common.cancel') }));
  expect(api.revokeInvite).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: en('admin.actions.revoke') }));
  await user.click(
    screen.getByRole('button', { name: en('admin.confirmations.revokeInvite.confirm') }),
  );

  await waitFor(() => expect(api.revokeInvite).toHaveBeenCalledWith(invite.id));
});

test('keeps a newly created invite URL open until it is acknowledged', async () => {
  vi.mocked(api.createInvite).mockResolvedValue(created);
  const user = userEvent.setup();
  renderPage();

  await user.type(await screen.findByLabelText(en('admin.users.emailLabel')), invite.email);
  await user.click(screen.getByRole('button', { name: en('admin.invites.createAction') }));

  expect(await screen.findByText(created.inviteUrl)).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.getByText(created.inviteUrl)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: en('common.savedOneTimeSecret') }));
  await waitFor(() => expect(screen.queryByText(created.inviteUrl)).not.toBeInTheDocument());
});

/**
 * #1848 D2, on the invites list: a window that has fallen off the end of the
 * set must not read as "no invites" over 25 live rows. Nothing but the URL
 * could bring the operator back before.
 */
test('a page that emptied under a revoke returns to the page that still has rows', async () => {
  const pageOf = (offset: number) =>
    Array.from({ length: 25 }, (_, i) => ({
      ...invite,
      id: `00000000-0000-0000-0000-${String(offset + i).padStart(12, '0')}`,
      email: `invitee-${offset + i}@bettertrack.test`,
    }));
  vi.mocked(api.listInvites).mockImplementation(async (params = {}) => {
    const offset = params.offset ?? 0;
    return offset === 0
      ? { invites: pageOf(0), page: { total: 50, limit: 25, offset } }
      : { invites: [], page: { total: 50, limit: 25, offset } };
  });
  const user = userEvent.setup();
  renderPage();

  await screen.findByText('invitee-0@bettertrack.test');
  await user.click(screen.getByRole('button', { name: en('admin.pagination.next') }));

  await waitFor(() =>
    expect(api.listInvites).toHaveBeenCalledWith({ offset: 25 }, expect.anything()),
  );
  await waitFor(() =>
    expect(api.listInvites).toHaveBeenLastCalledWith({ offset: 0 }, expect.anything()),
  );
  expect(await screen.findByText('invitee-0@bettertrack.test')).toBeInTheDocument();
  expect(screen.queryByText(en('admin.invites.empty'))).not.toBeInTheDocument();
});

test('renders one bounded page and reaches the rest through the footer', async () => {
  // #1814: the list used to arrive whole — nothing prunes invites, so a
  // long-lived instance answered with every row it had ever written.
  const pageOf = (offset: number) =>
    Array.from({ length: 25 }, (_, i) => ({
      ...invite,
      id: `00000000-0000-0000-0000-${String(offset + i).padStart(12, '0')}`,
      email: `invitee-${offset + i}@bettertrack.test`,
    }));
  vi.mocked(api.listInvites).mockImplementation(async (params = {}) => ({
    invites: pageOf(params.offset ?? 0),
    page: { total: 60, limit: 25, offset: params.offset ?? 0 },
  }));
  const user = userEvent.setup();
  renderPage();

  // 25 rows of a 60-row table, not 60.
  await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(26)); // + header
  expect(screen.getByText(en('admin.pagination.range', { first: '1', last: '25', total: '60' })));

  await user.click(screen.getByRole('button', { name: en('admin.pagination.next') }));

  await waitFor(() =>
    expect(api.listInvites).toHaveBeenCalledWith({ offset: 25 }, expect.anything()),
  );
  expect(await screen.findByText('invitee-25@bettertrack.test')).toBeInTheDocument();
  expect(screen.getAllByRole('row')).toHaveLength(26);
});
