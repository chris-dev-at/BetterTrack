import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { Announcement, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { AnnouncementsPage } from './AnnouncementsPage';

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

const announcement: Announcement = {
  id: '00000000-0000-0000-0000-0000000000aa',
  severity: 'info',
  titleEn: 'Service update',
  bodyEn: 'A short notice.',
  titleDe: 'Service-Update',
  bodyDe: 'Eine kurze Nachricht.',
  startsAt: null,
  endsAt: null,
  active: true,
  publishedAt: '2026-07-30T10:00:00.000Z',
  createdAt: '2026-07-30T09:00:00.000Z',
  updatedAt: '2026-07-30T09:00:00.000Z',
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
  vi.mocked(api.listAnnouncements).mockResolvedValue({ announcements: [announcement] });
});

function renderPage() {
  return render(
    <AuthProvider>
      <AnnouncementsPage />
    </AuthProvider>,
  );
}

test('confirms announcement deletion and suppresses a pending second activation', async () => {
  let resolveDelete: (() => void) | undefined;
  vi.mocked(api.deleteAnnouncement).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
  );

  const user = userEvent.setup();
  renderPage();

  await screen.findByText(announcement.titleEn);
  await user.click(screen.getByRole('button', { name: 'Delete' }));

  const dialog = await screen.findByRole('dialog', { name: 'Delete announcement?' });
  expect(dialog).toHaveTextContent('Delete “Service update”?');
  expect(api.deleteAnnouncement).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(api.deleteAnnouncement).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Delete' }));
  const confirm = await screen.findByRole('button', { name: 'Delete announcement' });
  await user.click(confirm);

  await waitFor(() => expect(api.deleteAnnouncement).toHaveBeenCalledWith(announcement.id));
  await waitFor(() => expect(confirm).toBeDisabled());
  await user.click(confirm);
  expect(api.deleteAnnouncement).toHaveBeenCalledOnce();

  resolveDelete?.();
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
