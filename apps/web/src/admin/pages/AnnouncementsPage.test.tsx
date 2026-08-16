import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { Announcement, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import { I18nProvider } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
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

function renderPage(locale = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <AnnouncementsPage />
      </AuthProvider>
    </I18nProvider>,
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

test('keeps a deletion failure visible in its confirmation dialog', async () => {
  vi.mocked(api.deleteAnnouncement).mockRejectedValue(
    new ApiError(500, 'internal_error', 'Could not delete the announcement.'),
  );
  const user = userEvent.setup();
  renderPage();

  await screen.findByText(announcement.titleEn);
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete announcement?' });
  const confirm = within(dialog).getByRole('button', { name: 'Delete announcement' });

  await user.click(confirm);

  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Could not delete the announcement.',
  );
  expect(confirm).toBeEnabled();

  await user.click(confirm);
  await waitFor(() => expect(api.deleteAnnouncement).toHaveBeenCalledTimes(2));
});

test('uses the German announcement title in a German confirmation', async () => {
  const user = userEvent.setup();
  renderPage('de');

  await screen.findByText(announcement.titleEn);
  await user.click(screen.getByRole('button', { name: 'Löschen' }));

  expect(await screen.findByRole('dialog', { name: 'Ankündigung löschen?' })).toHaveTextContent(
    '„Service-Update“ löschen?',
  );
});

test('keeps required announcement body markers out of accessible labels', async () => {
  const { container } = renderPage();

  expect(await screen.findByLabelText('English body', { exact: true })).toHaveAttribute('required');
  const marker = container.querySelector<HTMLElement>(
    'label[for="bodyEn"] + .bt-field__required-marker',
  )!;
  expect(marker).toHaveAttribute('aria-hidden', 'true');
  expect(marker).toHaveTextContent('*');
});
