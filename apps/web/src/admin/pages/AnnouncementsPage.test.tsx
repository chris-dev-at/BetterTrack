import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { Announcement, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import { I18nProvider, localizedMessage } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { AuthProvider, useAuth } from '../AuthContext';
import { AnnouncementsPage, fromInputDateTime, toInputDateTime } from './AnnouncementsPage';

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
  deliveryState: 'published',
  deliveredCount: 128,
  failedCount: 0,
  createdAt: '2026-07-30T09:00:00.000Z',
  updatedAt: '2026-07-30T09:00:00.000Z',
};

/**
 * An announcement the operator armed for next month (#1909). Before this wave
 * it read as "active" while every user had already been mailed; the row must
 * now say it has not gone out yet.
 */
const scheduled: Announcement = {
  ...announcement,
  id: '00000000-0000-0000-0000-0000000000bb',
  titleEn: 'Planned migration',
  titleDe: 'Geplante Migration',
  startsAt: '2026-09-07T06:00:00.000Z',
  publishedAt: null,
  deliveryState: 'scheduled',
  deliveredCount: null,
  failedCount: null,
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

/** The console's auth status, so a sign-out on auth loss is observable. */
function AuthStatus() {
  const { status } = useAuth();
  return <span data-testid="status">{status}</span>;
}

function renderPage(locale = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter initialEntries={['/admin/announcements']}>
        <AuthProvider>
          <AuthStatus />
          <AnnouncementsPage />
        </AuthProvider>
      </MemoryRouter>
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

  // Catalog copy, not the server's envelope (#1814): API envelopes are authored
  // in English and are not locale-aware, so the raw message would leak into a
  // German console.
  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveTextContent(localizedMessage('en', 'common.genericError'));
  expect(alert).not.toHaveTextContent('Could not delete the announcement.');
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

test('a closed admin session window signs the console out instead of a save banner', async () => {
  const envelope = 'Not found';
  vi.mocked(api.createAnnouncement).mockRejectedValue(new ApiError(404, 'NOT_FOUND', envelope));
  const user = userEvent.setup();
  renderPage();

  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
  await user.type(screen.getByLabelText(/English title/), 'Planned downtime');
  await user.type(screen.getByLabelText(/English body/), 'We will be brief.');
  await user.type(screen.getByLabelText(/German title/), 'Geplante Wartung');
  await user.type(screen.getByLabelText(/German body/), 'Wir fassen uns kurz.');
  await user.click(screen.getByRole('button', { name: 'Create announcement' }));

  // The defect this replaces: a red "could not save" on a console whose every
  // next request would also fail (#1814).
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  expect(screen.queryByText(envelope)).not.toBeInTheDocument();
});

/**
 * ADMIN-W7a (#1909). The composer was the console's worst-localized page — 489
 * lines of hardcoded English with no `admin.announcements.*` namespace at all —
 * and its two most prominent strings were untrue: the checkbox promised
 * "publishes to every user on save" and the `startsAt` helper implied a filled
 * start meant "later", while the fan-out ran on the `active` flag alone.
 */
// The page title is asserted as the page's HEADING rather than as text: since
// the W7c fold (#1406) "Announcements" is also this page's own tab in the
// Product & Comms strip, so a bare text query matches twice.
const COMPOSER_KEYS = [
  'admin.announcements.composer.active',
  'admin.announcements.composer.startsAt',
  'admin.announcements.composer.create',
  'admin.announcements.preview.heading',
] as const;

test('renders the composer from the catalog in EN and in DE', async () => {
  const { unmount } = renderPage();
  expect(
    await screen.findByRole('heading', {
      level: 1,
      name: localizedMessage('en', 'admin.announcements.title'),
    }),
  ).toBeInTheDocument();
  for (const key of COMPOSER_KEYS) {
    expect(await screen.findByText(localizedMessage('en', key))).toBeInTheDocument();
  }
  // The old copy promised a send that no longer happens on save.
  expect(screen.queryByText(/publishes to every user on save/i)).not.toBeInTheDocument();
  unmount();

  renderPage('de');
  expect(
    await screen.findByRole('heading', {
      level: 1,
      name: localizedMessage('de', 'admin.announcements.title'),
    }),
  ).toBeInTheDocument();
  for (const key of COMPOSER_KEYS) {
    expect(await screen.findByText(localizedMessage('de', key))).toBeInTheDocument();
  }
  // And the DE catalog is not silently falling back to English.
  expect(localizedMessage('de', 'admin.announcements.composer.create')).not.toBe(
    localizedMessage('en', 'admin.announcements.composer.create'),
  );
});

test('a scheduled announcement reads as scheduled, not as active', async () => {
  vi.mocked(api.listAnnouncements).mockResolvedValue({ announcements: [announcement, scheduled] });
  renderPage();

  const row = (await screen.findByText(scheduled.titleEn)).closest('tr')!;
  expect(
    within(row).getByText(localizedMessage('en', 'admin.announcements.state.scheduled')),
  ).toBeInTheDocument();
  // The honest sentence, carrying the date it will actually go out.
  expect(row).toHaveTextContent(/Will publish on/i);
  // Nothing has been delivered yet, and the row does not claim otherwise.
  expect(
    within(row).getByText(localizedMessage('en', 'admin.announcements.list.reachPending')),
  ).toBeInTheDocument();
  expect(within(row).queryByText(/\d+ delivered/)).not.toBeInTheDocument();
  expect(row).not.toHaveTextContent(localizedMessage('en', 'admin.announcements.state.published'));

  // The published sibling still reads as published, with its reach.
  const publishedRow = screen.getByText(announcement.titleEn).closest('tr')!;
  expect(
    within(publishedRow).getByText(localizedMessage('en', 'admin.announcements.state.published')),
  ).toBeInTheDocument();
  expect(publishedRow).toHaveTextContent('128');
});

test('previews the banner in both languages from the composed fields', async () => {
  const user = userEvent.setup();
  renderPage();

  // Nothing composed yet: the preview says so rather than rendering an empty band.
  expect(
    await screen.findByText(localizedMessage('en', 'admin.announcements.preview.empty')),
  ).toBeInTheDocument();

  await user.type(screen.getByLabelText(/English title/), 'Planned downtime');
  await user.type(screen.getByLabelText(/English body/), 'Ten minutes at 22:00.');
  await user.type(screen.getByLabelText(/German title/), 'Geplante Ausfallzeit');
  await user.type(screen.getByLabelText(/German body/), 'Zehn Minuten ab 22:00 Uhr.');

  const en = screen.getByTestId('announcement-preview-en');
  expect(en).toHaveTextContent('Planned downtime');
  expect(en).toHaveTextContent('Ten minutes at 22:00.');
  // The user-facing severity word and dismiss affordance, in the viewer's own
  // language — the same catalog keys the real banner renders.
  expect(en).toHaveTextContent(localizedMessage('en', 'announcements.severity.info'));
  expect(en).toHaveTextContent(localizedMessage('en', 'announcements.dismiss'));

  const de = screen.getByTestId('announcement-preview-de');
  expect(de).toHaveTextContent('Geplante Ausfallzeit');
  expect(de).toHaveTextContent('Zehn Minuten ab 22:00 Uhr.');
  expect(de).toHaveTextContent(localizedMessage('de', 'announcements.dismiss'));
  // Each side shows its OWN language — no cross-contamination.
  expect(de).not.toHaveTextContent('Planned downtime');
});

/**
 * `<input type="datetime-local">` speaks the browser's zone and nothing else,
 * while every readout in this console renders in Europe/Vienna wall-clock
 * (§5.5). Without an explicit conversion an operator would type 09:00 and the
 * row beside it would answer 10:00 — and the announcement would go out an hour
 * off. Both DST sides are asserted, because a fixed offset would pass one.
 */
test('sends the typed window as UTC, read as Europe/Vienna wall clock', async () => {
  vi.mocked(api.createAnnouncement).mockResolvedValue({
    ...announcement,
    deliveryState: 'scheduled',
  });
  const user = userEvent.setup();
  renderPage();

  await screen.findByLabelText(/English title/);
  await user.type(screen.getByLabelText(/English title/), 'Window test');
  await user.type(screen.getByLabelText(/English body/), 'Body.');
  await user.type(screen.getByLabelText(/German title/), 'Fenstertest');
  await user.type(screen.getByLabelText(/German body/), 'Text.');

  // Summer (CEST, UTC+2) and winter (CET, UTC+1) in one submission.
  fireEvent.change(screen.getByLabelText(/Starts at/), {
    target: { value: '2026-07-01T09:00' },
  });
  fireEvent.change(screen.getByLabelText(/Ends at/), {
    target: { value: '2026-12-01T09:00' },
  });
  await user.click(
    screen.getByRole('button', {
      name: localizedMessage('en', 'admin.announcements.composer.create'),
    }),
  );

  await waitFor(() => expect(api.createAnnouncement).toHaveBeenCalled());
  expect(vi.mocked(api.createAnnouncement).mock.calls[0]![0]).toMatchObject({
    startsAt: '2026-07-01T07:00:00.000Z',
    endsAt: '2026-12-01T08:00:00.000Z',
  });

  // And the round trip is lossless: editing an existing row re-renders the
  // stored instant as the same wall clock the operator typed.
  expect(toInputDateTime('2026-07-01T07:00:00.000Z')).toBe('2026-07-01T09:00');
  expect(toInputDateTime('2026-12-01T08:00:00.000Z')).toBe('2026-12-01T09:00');
  expect(fromInputDateTime('')).toBeNull();
});

/**
 * ADMIN-W7c (#1943). The reach cell showed a red "N failed" with nothing
 * attached to it: the automatic ladder stops after one retry, so those
 * recipients were never getting their inbox row. The retry is the operator's
 * hand on that — and it only exists where there is a failure to act on.
 */
const failedDelivery: Announcement = {
  ...announcement,
  id: '00000000-0000-0000-0000-0000000000cc',
  titleEn: 'Migration notice',
  titleDe: 'Migrationshinweis',
  deliveredCount: 125,
  failedCount: 3,
};

test('offers the delivery retry only on a row that has failures', async () => {
  vi.mocked(api.listAnnouncements).mockResolvedValue({
    announcements: [announcement, failedDelivery, scheduled],
  });
  renderPage();

  const label = localizedMessage('en', 'admin.announcements.list.redeliver');
  const failedRow = (await screen.findByText(failedDelivery.titleEn)).closest('tr')!;
  expect(within(failedRow).getByRole('button', { name: label })).toBeInTheDocument();
  // Beside the count it is retrying, not buried in the actions column.
  expect(failedRow).toHaveTextContent(
    localizedMessage('en', 'admin.announcements.list.reachFailed').replace('{{failed}}', '3'),
  );

  // A clean publication (0 failed) and a row nothing has walked yet (null)
  // both offer nothing to retry.
  const cleanRow = screen.getByText(announcement.titleEn).closest('tr')!;
  expect(within(cleanRow).queryByRole('button', { name: label })).not.toBeInTheDocument();
  const scheduledRow = screen.getByText(scheduled.titleEn).closest('tr')!;
  expect(within(scheduledRow).queryByRole('button', { name: label })).not.toBeInTheDocument();
});

test('confirms the retry, queues it, and reports what was queued', async () => {
  vi.mocked(api.listAnnouncements).mockResolvedValue({ announcements: [failedDelivery] });
  vi.mocked(api.redeliverAnnouncement).mockResolvedValue({
    announcementId: failedDelivery.id,
    jobId: 'announcements.publishDue:cc:2:1',
    attempt: 2,
    failedCount: 3,
    deliveredCount: 125,
  });
  const user = userEvent.setup();
  renderPage();

  await screen.findByText(failedDelivery.titleEn);
  await user.click(
    screen.getByRole('button', {
      name: localizedMessage('en', 'admin.announcements.list.redeliver'),
    }),
  );

  // Nothing is sent on the click itself — the walk hits every account.
  const dialog = await screen.findByRole('dialog', {
    name: localizedMessage('en', 'admin.confirmations.redeliverAnnouncement.title'),
  });
  expect(dialog).toHaveTextContent('Migration notice');
  expect(dialog).toHaveTextContent('3 recipients');
  expect(api.redeliverAnnouncement).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(api.redeliverAnnouncement).not.toHaveBeenCalled();

  await user.click(
    screen.getByRole('button', {
      name: localizedMessage('en', 'admin.announcements.list.redeliver'),
    }),
  );
  await user.click(
    await screen.findByRole('button', {
      name: localizedMessage('en', 'admin.confirmations.redeliverAnnouncement.confirm'),
    }),
  );

  await waitFor(() => expect(api.redeliverAnnouncement).toHaveBeenCalledWith(failedDelivery.id));
  expect(api.redeliverAnnouncement).toHaveBeenCalledOnce();
  // The banner says what actually happened: a retry was QUEUED for the three
  // recipients — not that they have been delivered to — and it names the pass,
  // so a collapsed re-click below is recognisable rather than silent.
  const banner = await screen.findByText(/Retrying delivery to 3 recipients/);
  expect(banner).toHaveTextContent('announcements.publishDue:cc:2:1');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  // And the list is re-read, because the counts change on the worker.
  expect(api.listAnnouncements).toHaveBeenCalledTimes(2);
});

test('names a queue outage instead of a generic failure, and keeps the dialog open', async () => {
  vi.mocked(api.listAnnouncements).mockResolvedValue({ announcements: [failedDelivery] });
  vi.mocked(api.redeliverAnnouncement).mockRejectedValue(
    new ApiError(
      503,
      'ANNOUNCEMENT_REDELIVER_UNAVAILABLE',
      'The delivery queue is unavailable. Try again shortly.',
    ),
  );
  const user = userEvent.setup();
  renderPage('de');

  await screen.findByText(failedDelivery.titleEn);
  await user.click(
    screen.getByRole('button', {
      name: localizedMessage('de', 'admin.announcements.list.redeliver'),
    }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: localizedMessage('de', 'admin.confirmations.redeliverAnnouncement.title'),
  });
  // The German confirmation reads the German title, like the delete one.
  expect(dialog).toHaveTextContent('Migrationshinweis');
  await user.click(
    within(dialog).getByRole('button', {
      name: localizedMessage('de', 'admin.confirmations.redeliverAnnouncement.confirm'),
    }),
  );

  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveTextContent(
    localizedMessage('de', 'admin.announcements.redeliver.unavailable'),
  );
  // Catalog copy, not the server's English envelope (#1814).
  expect(alert).not.toHaveTextContent('The delivery queue is unavailable.');
  // Still open, so the operator can simply try again.
  expect(dialog).toBeInTheDocument();
});

/**
 * Two clicks inside the server's manual dedupe window are deliberately ONE pass
 * (the 202 returns the same job id, because a second identical re-walk would
 * deliver exactly what the first one does). Saying "queued!" twice would read as
 * the button doing nothing again — the console names the collapse instead.
 */
test('says a collapsed re-click is the same pass, and counts one recipient in the singular', async () => {
  const singleFailure: Announcement = { ...failedDelivery, failedCount: 1, deliveredCount: 127 };
  vi.mocked(api.listAnnouncements).mockResolvedValue({ announcements: [singleFailure] });
  vi.mocked(api.redeliverAnnouncement).mockResolvedValue({
    announcementId: singleFailure.id,
    jobId: 'announcements.publishDue:cc:2:7',
    attempt: 2,
    failedCount: 1,
    deliveredCount: 127,
  });
  const user = userEvent.setup();
  renderPage();

  const retry = localizedMessage('en', 'admin.announcements.list.redeliver');
  const confirm = localizedMessage('en', 'admin.confirmations.redeliverAnnouncement.confirm');

  await screen.findByText(singleFailure.titleEn);
  await user.click(screen.getByRole('button', { name: retry }));
  // One recipient reads as one recipient, in the dialog and in the banner.
  const dialog = await screen.findByRole('dialog', {
    name: localizedMessage('en', 'admin.confirmations.redeliverAnnouncement.title'),
  });
  expect(dialog).toHaveTextContent('1 recipient it did not reach');
  expect(dialog).not.toHaveTextContent('1 recipients');
  await user.click(within(dialog).getByRole('button', { name: confirm }));

  const first = await screen.findByText(/Retrying delivery to 1 recipient —/);
  expect(first).toHaveTextContent('announcements.publishDue:cc:2:7');
  expect(first).not.toHaveTextContent('1 recipients');

  // Same window, same job id back: the second click queued nothing new, and the
  // banner says exactly that rather than repeating the success line.
  await user.click(screen.getByRole('button', { name: retry }));
  await user.click(
    await screen.findByRole('button', {
      name: confirm,
    }),
  );
  const second = await screen.findByText(/same pass your last click queued/);
  expect(second).toHaveTextContent('announcements.publishDue:cc:2:7');
  expect(api.redeliverAnnouncement).toHaveBeenCalledTimes(2);
});
