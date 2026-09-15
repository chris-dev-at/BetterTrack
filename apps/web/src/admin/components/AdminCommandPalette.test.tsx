import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminInvite,
  AdminUser,
  Announcement,
  MeResponse,
  RegistrationToken,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider } from '../../i18n';
import { AuthProvider } from '../AuthContext';
import { AdminCommandPalette } from './AdminCommandPalette';
import { TAP_TARGET } from './tokens';

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

const announcement: Announcement = {
  id: '00000000-0000-7000-8000-0000000000b1',
  severity: 'warning',
  titleEn: 'Planned maintenance window',
  bodyEn: 'We will be down for an hour.',
  titleDe: 'Geplante Wartungsarbeiten',
  bodyDe: 'Wir sind eine Stunde offline.',
  startsAt: null,
  endsAt: null,
  active: true,
  publishedAt: null,
  deliveryState: 'publishing',
  deliveredCount: null,
  failedCount: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const invite: AdminInvite = {
  id: '00000000-0000-7000-8000-0000000000c1',
  email: 'neuer.kollege@example.net',
  status: 'pending',
  createdAt: '2026-09-01T00:00:00.000Z',
  expiresAt: '2026-09-08T00:00:00.000Z',
  usedAt: null,
  revokedAt: null,
};

const token: RegistrationToken = {
  id: '00000000-0000-7000-8000-0000000000d1',
  label: 'beta wave 1',
  status: 'active',
  maxUses: 10,
  useCount: 2,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
};

const emptyPage = { total: 0, limit: 50, offset: 0 };

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
  vi.mocked(api.listProblems).mockResolvedValue({
    problems: [],
    openCount: 0,
    droppedCaptures: 0,
    droppedCapturesTotal: 0,
    total: 0,
    hasMore: false,
  });
  vi.mocked(api.listAnnouncements).mockResolvedValue({ announcements: [] });
  vi.mocked(api.listInvites).mockResolvedValue({ invites: [], page: emptyPage });
  vi.mocked(api.listRegistrationTokens).mockResolvedValue({ tokens: [], page: emptyPage });
});

test('opens focused on the input and offers destinations before anything is typed', async () => {
  renderPalette();

  const palette = screen.getByRole('dialog', { name: 'Admin command palette' });
  expect(within(palette).getByRole('combobox')).toHaveFocus();
  expect(within(palette).getByRole('option', { name: /Overview/ })).toBeInTheDocument();

  // An empty palette must not cost a round trip — to ANY of the five remote
  // sections. A palette that reads five lists the moment it opens is a palette
  // an operator learns not to open.
  expect(api.listUsers).not.toHaveBeenCalled();
  expect(api.listProblems).not.toHaveBeenCalled();
  expect(api.listAnnouncements).not.toHaveBeenCalled();
  expect(api.listInvites).not.toHaveBeenCalled();
  expect(api.listRegistrationTokens).not.toHaveBeenCalled();
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
    droppedCaptures: 0,
    droppedCapturesTotal: 0,
    total: 1,
    hasMore: false,
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
        regressed: false,
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
    'Seiten, Nutzer, Ankündigungen, Flags suchen…',
  );
  expect(within(palette).getByText('Seiten')).toBeInTheDocument();
});

/**
 * The phone floor on the rows that ARE the console's destinations (§13.5
 * V5-P13b, #1891). They shipped at `min-h-[42px]` — two pixels under the
 * console's own declared floor — and, being `<li role="option">` elements with
 * no marker class, they were outside the phone gate's admin selectors as well:
 * undersized AND unmeasured.
 *
 * jsdom applies no CSS, so what a component test can prove is the OPT-IN: the
 * row wears the class `styles/origin.css` declares `min-height: 44px` for below
 * the console's 768px drawer handoff. The rendered geometry is measured for real
 * in `e2e/mobile-overflow.spec.ts`, which selects the row structurally so
 * dropping this class fails the gate rather than leaving the sweep.
 */
test('gives every palette result row the console tap-target floor', async () => {
  renderPalette();

  const rows = screen.getAllByRole('option');
  expect(rows.length).toBeGreaterThan(2);
  for (const row of rows) {
    expect(row.className, `${row.textContent} must carry the console 44px floor`).toContain(
      TAP_TARGET,
    );
  }
  // 42px stays as the console's deliberate DESKTOP density — the floor above it
  // is what the phone gets — so the row must still declare one.
  expect(rows[0]!.className).toContain('min-h-[42px]');
});

/**
 * The palette searches CONTENT, not just destinations (#1406 W7b). An operator
 * who remembers an announcement's title, a flag's name or an invite's e-mail had
 * no way to jump to it — the rail answers "which page", never "which thing".
 *
 * Every section below reads an endpoint the console already calls from its own
 * page, behind the same admin fence, and renders the same fields. The palette
 * removes a navigation step; it is not a new read scope.
 */
test('matches an announcement by its ENGLISH title and points at the composer', async () => {
  vi.mocked(api.listAnnouncements).mockResolvedValue({ announcements: [announcement] });
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'maintenance');

  const row = await screen.findByRole('option', { name: /Planned maintenance window/ });
  await user.click(row);
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/announcements');
});

test('matches an announcement by its GERMAN title even while the console is English', async () => {
  // The operator who composed the German copy remembers the German words. A
  // console that searched only the English half would be unfindable to exactly
  // the person who wrote it.
  vi.mocked(api.listAnnouncements).mockResolvedValue({ announcements: [announcement] });
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'wartungs');

  expect(
    await screen.findByRole('option', { name: /Planned maintenance window/ }),
  ).toBeInTheDocument();
});

test('matches a feature flag by localized name and by key, with no request at all', async () => {
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'live');

  const byName = await screen.findByRole('option', { name: /Live Mode/ });
  expect(byName).toHaveTextContent('liveMode');
  await user.click(byName);
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/feature-flags');
});

test('matches a feature flag by its contract key', async () => {
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'imports');

  expect(await screen.findByRole('option', { name: /Imports/ })).toBeInTheDocument();
});

test('matches an invite by e-mail and a registration token by label, each to its own page', async () => {
  vi.mocked(api.listInvites).mockResolvedValue({ invites: [invite], page: emptyPage });
  vi.mocked(api.listRegistrationTokens).mockResolvedValue({ tokens: [token], page: emptyPage });
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'kollege');
  const inviteRow = await screen.findByRole('option', { name: /neuer\.kollege@example\.net/ });
  expect(inviteRow).toHaveTextContent('Pending');
  await user.click(inviteRow);
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/invites');
});

test('a registration token navigates to Registration, not to Invites', async () => {
  vi.mocked(api.listInvites).mockResolvedValue({ invites: [invite], page: emptyPage });
  vi.mocked(api.listRegistrationTokens).mockResolvedValue({ tokens: [token], page: emptyPage });
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'beta wave');
  const tokenRow = await screen.findByRole('option', { name: /beta wave 1/ });
  await user.click(tokenRow);
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/registration');
});

test('fetches each client-filtered list ONCE per palette session, however much is typed', async () => {
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'maintenance window');
  await waitFor(() => expect(api.listAnnouncements).toHaveBeenCalled());

  // These endpoints take no search argument, so refetching them per keystroke
  // batch would be pure waste — the same contract the problems section has had
  // since W1.
  expect(api.listAnnouncements).toHaveBeenCalledTimes(1);
  expect(api.listInvites).toHaveBeenCalledTimes(1);
  expect(api.listRegistrationTokens).toHaveBeenCalledTimes(1);
  expect(api.listProblems).toHaveBeenCalledTimes(1);
  // …and the one endpoint that DOES search server-side still gets exactly one
  // debounced request for the whole phrase.
  expect(api.listUsers).toHaveBeenCalledTimes(1);
});

test('asks the bounded windows, never the whole table', async () => {
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'anything');

  await waitFor(() => expect(api.listInvites).toHaveBeenCalled());
  expect(api.listInvites).toHaveBeenCalledWith({ limit: 50 }, expect.anything());
  expect(api.listRegistrationTokens).toHaveBeenCalledWith({ limit: 50 }, expect.anything());
});

test('reports a failed announcement or invite read instead of pretending nothing matched', async () => {
  const { ApiError } = await import('../../lib/apiClient');
  vi.mocked(api.listAnnouncements).mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
  vi.mocked(api.listInvites).mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'anything');

  expect(await screen.findByText('Could not load announcements.')).toBeInTheDocument();
  expect(
    await screen.findByText('Could not load invites or registration tokens.'),
  ).toBeInTheDocument();
  expect(screen.queryByText('No matching announcements.')).not.toBeInTheDocument();
});

test('renders the new section headings in German', async () => {
  vi.mocked(api.listAnnouncements).mockResolvedValue({ announcements: [announcement] });
  const user = userEvent.setup();
  renderPalette('de');

  await user.type(screen.getByRole('combobox'), 'wartungs');

  const palette = screen.getByRole('dialog', { name: 'Admin-Befehlspalette' });
  // The German operator sees the German title; the match ran over both. Awaited
  // on the ROW, not on the heading: a section renders its heading as soon as it
  // has a note, so waiting on the heading would race the fetch.
  expect(await within(palette).findByText('Geplante Wartungsarbeiten')).toBeInTheDocument();
  expect(within(palette).getByText('Ankündigungen')).toBeInTheDocument();
  expect(within(palette).getByText('Einladungen & Token')).toBeInTheDocument();
});

test('stays navigation-only — no new section exposes a mutation', async () => {
  vi.mocked(api.listAnnouncements).mockResolvedValue({ announcements: [announcement] });
  vi.mocked(api.listInvites).mockResolvedValue({ invites: [invite], page: emptyPage });
  vi.mocked(api.listRegistrationTokens).mockResolvedValue({ tokens: [token], page: emptyPage });
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'a');
  await screen.findByRole('option', { name: /neuer\.kollege@example\.net/ });

  const palette = screen.getByRole('dialog', { name: 'Admin command palette' });
  // The #1406 decision keeps mutations out of v1: every row is a destination and
  // Enter is always "go there". The palette owns no button at all.
  expect(within(palette).queryAllByRole('button')).toEqual([]);
  expect(
    within(palette).getByText('Navigation only — nothing here changes data.'),
  ).toBeInTheDocument();
});

test('gives every NEW result row the console tap-target floor too', async () => {
  vi.mocked(api.listAnnouncements).mockResolvedValue({ announcements: [announcement] });
  vi.mocked(api.listInvites).mockResolvedValue({ invites: [invite], page: emptyPage });
  vi.mocked(api.listRegistrationTokens).mockResolvedValue({ tokens: [token], page: emptyPage });
  const user = userEvent.setup();
  renderPalette();

  await user.type(screen.getByRole('combobox'), 'e');
  await screen.findByRole('option', { name: /neuer\.kollege@example\.net/ });

  const rows = screen.getAllByRole('option');
  for (const row of rows) {
    if (row.getAttribute('aria-disabled') === 'true') continue;
    expect(row.className, `${row.textContent} must carry the console 44px floor`).toContain(
      TAP_TARGET,
    );
  }
});
