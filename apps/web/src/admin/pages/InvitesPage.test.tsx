import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AdminInvite, CreateInviteResponse, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { InvitesPage } from './InvitesPage';

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
  vi.mocked(api.listInvites).mockResolvedValue({ invites: [invite] });
});

function renderPage() {
  return render(
    <AuthProvider>
      <InvitesPage />
    </AuthProvider>,
  );
}

test('requires an inline confirmation before revoking an invite', async () => {
  vi.mocked(api.revokeInvite).mockResolvedValue(undefined);
  const user = userEvent.setup();
  renderPage();

  await screen.findByText(invite.email);
  await user.click(screen.getByRole('button', { name: 'Revoke' }));

  expect(await screen.findByText(`Revoke invite for ${invite.email}?`)).toBeInTheDocument();
  expect(api.revokeInvite).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(api.revokeInvite).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Revoke' }));
  await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));

  await waitFor(() => expect(api.revokeInvite).toHaveBeenCalledWith(invite.id));
});

test('keeps a newly created invite URL open until it is acknowledged', async () => {
  vi.mocked(api.createInvite).mockResolvedValue(created);
  const user = userEvent.setup();
  renderPage();

  await user.type(await screen.findByLabelText('Email'), invite.email);
  await user.click(screen.getByRole('button', { name: 'Create invite' }));

  expect(await screen.findByText(created.inviteUrl)).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.getByText(created.inviteUrl)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: "I've saved this" }));
  await waitFor(() => expect(screen.queryByText(created.inviteUrl)).not.toBeInTheDocument());
});
