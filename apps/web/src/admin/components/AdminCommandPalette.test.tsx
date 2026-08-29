import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AdminUser, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider } from '../../i18n';
import { AuthProvider } from '../AuthContext';
import { AdminCommandPalette } from './AdminCommandPalette';

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

const disabledUser: AdminUser = {
  id: '00000000-0000-7000-8000-0000000000aa',
  email: 'm.huber@example.net',
  username: 'm_huber',
  role: 'user',
  status: 'disabled',
  mustChangePassword: false,
  chatBanned: false,
  lastLoginAt: null,
  createdAt: '2026-02-01T00:00:00.000Z',
};

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderPalette(locale: 'en' | 'de' = 'en') {
  const onClose = vi.fn();
  const view = render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter initialEntries={['/admin']}>
        <AuthProvider>
          <Routes>
            <Route path="*" element={<LocationProbe />} />
          </Routes>
          <AdminCommandPalette isOpen onClose={onClose} />
        </AuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
  return { ...view, onClose };
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
  // The People list is paged as of #1406 W2 — `page` is part of the response.
  vi.mocked(api.listUsers).mockResolvedValue({
    users: [],
    page: { total: 0, limit: 6, offset: 0 },
  });
  vi.mocked(api.listProblems).mockResolvedValue({ problems: [], openCount: 0 });
});

test('opens focused on the input and offers destinations before anything is typed', async () => {
  renderPalette();

  const palette = screen.getByRole('dialog', { name: 'Admin command palette' });
  expect(within(palette).getByRole('combobox')).toHaveFocus();
  expect(within(palette).getByRole('option', { name: /Overview/ })).toBeInTheDocument();

  // An empty palette must not cost an admin-users round trip.
  expect(api.listUsers).not.toHaveBeenCalled();
});

test('arrow keys move the active option and Enter navigates to it', async () => {
  const user = userEvent.setup();
  const { onClose } = renderPalette();

  await user.keyboard('{ArrowDown}');
  await user.keyboard('{Enter}');

  expect(screen.getByTestId('location')).toHaveTextContent('/admin/support');
  expect(onClose).toHaveBeenCalled();
});

test('filters destinations by their localized label', async () => {
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'invit');

  await waitFor(() => expect(screen.getByRole('option', { name: /Invites/ })).toBeInTheDocument());
  expect(screen.queryByRole('option', { name: /^Overview/ })).not.toBeInTheDocument();
});

test('searches users through the existing admin endpoint and flags a disabled account', async () => {
  vi.mocked(api.listUsers).mockResolvedValue({
    users: [disabledUser],
    page: { total: 1, limit: 6, offset: 0 },
  });
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'huber');

  // The paged read (#1406 W2) takes a params object, and the palette asks for a
  // handful of matches — never the whole account table.
  await waitFor(() =>
    expect(api.listUsers).toHaveBeenCalledWith({ search: 'huber', limit: 6 }, expect.anything()),
  );
  const row = await screen.findByRole('option', { name: /m_huber/ });
  expect(row).toHaveTextContent('m.huber@example.net');
  expect(row).toHaveTextContent('Disabled');
});

test('debounces the user search so one word is one request', async () => {
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'anna');

  await waitFor(() => expect(api.listUsers).toHaveBeenCalled());
  expect(api.listUsers).toHaveBeenCalledTimes(1);
});

test('matches open problems client-side and points at the Problems page', async () => {
  vi.mocked(api.listProblems).mockResolvedValue({
    openCount: 1,
    problems: [
      {
        id: '00000000-0000-7000-8000-000000000001',
        kind: 'job',
        fingerprint: 'abc',
        title: 'emailSend exhausted retries',
        message: 'the mailer gave up',
        context: {},
        status: 'open',
        occurrenceCount: 3,
        firstSeenAt: '2026-08-19T10:00:00.000Z',
        lastSeenAt: '2026-08-20T09:00:00.000Z',
        resolvedAt: null,
        resolvedBy: null,
      },
    ],
  });
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'emailsend');

  const row = await screen.findByRole('option', { name: /emailSend exhausted retries/ });
  await user.click(row);

  expect(screen.getByTestId('location')).toHaveTextContent('/admin/problems');
});

test('reports a failed user search instead of pretending nobody matched', async () => {
  const { ApiError } = await import('../../lib/apiClient');
  vi.mocked(api.listUsers).mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'anna');

  expect(await screen.findByText('Could not search users.')).toBeInTheDocument();
  expect(screen.queryByText('No matching users.')).not.toBeInTheDocument();
});

test('Escape closes the palette', async () => {
  const user = userEvent.setup();
  const { onClose } = renderPalette();

  await user.keyboard('{Escape}');

  expect(onClose).toHaveBeenCalled();
});

test('renders the palette chrome in German', async () => {
  renderPalette('de');

  const palette = screen.getByRole('dialog', { name: 'Admin-Befehlspalette' });
  expect(within(palette).getByRole('combobox')).toHaveAttribute(
    'placeholder',
    'Seiten, Nutzer, Probleme suchen…',
  );
  expect(within(palette).getByText('Seiten')).toBeInTheDocument();
});
