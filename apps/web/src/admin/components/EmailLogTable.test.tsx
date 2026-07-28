import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type { EmailLogEntry, EmailLogListResponse } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import { I18nProvider, useI18n } from '../../i18n';
import { EmailLogTable, type EmailLogLoader } from './EmailLogTable';

const nextCursor = '00000000-0000-7000-8000-000000000099';

const entries: [EmailLogEntry, EmailLogEntry, EmailLogEntry] = [
  {
    id: '00000000-0000-7000-8000-000000000001',
    userId: null,
    recipient: 'sent@example.com',
    template: 'welcome',
    subject: 'Welcome',
    status: 'sent',
    errorCode: null,
    createdAt: '2026-07-01T12:00:00.000Z',
  },
  {
    id: '00000000-0000-7000-8000-000000000002',
    userId: null,
    recipient: 'failed@example.com',
    template: 'password-reset',
    subject: 'Reset your password',
    status: 'failed',
    errorCode: 'SMTP_REJECTED',
    createdAt: '2026-07-02T12:00:00.000Z',
  },
  {
    id: '00000000-0000-7000-8000-000000000003',
    userId: null,
    recipient: 'suppressed@example.com',
    template: 'notification',
    subject: 'Your notification',
    status: 'suppressed',
    errorCode: null,
    createdAt: '2026-07-03T12:00:00.000Z',
  },
];

const copy = {
  en: {
    loading: 'Loading email log…',
    empty: 'No emails sent yet.',
    headers: ['When', 'Recipient', 'Template', 'Subject', 'Status'],
    statuses: ['Sent', 'Failed', 'Suppressed'],
    loadMore: 'Load more',
    loadingMore: 'Loading…',
  },
  de: {
    loading: 'E-Mail-Protokoll wird geladen…',
    empty: 'Noch keine E-Mails gesendet.',
    headers: ['Zeitpunkt', 'Empfänger', 'Vorlage', 'Betreff', 'Status'],
    statuses: ['Gesendet', 'Fehlgeschlagen', 'Unterdrückt'],
    loadMore: 'Mehr laden',
    loadingMore: 'Wird geladen…',
  },
} as const;

function renderTable(locale: keyof typeof copy, load: EmailLogLoader, emptyLabel?: string) {
  return render(
    <I18nProvider initialLocale={locale}>
      <EmailLogTable load={load} emptyLabel={emptyLabel} />
    </I18nProvider>,
  );
}

function LocaleSwitchingTable({ load }: { load: EmailLogLoader }) {
  const { setLocale } = useI18n();
  return (
    <>
      <button type="button" onClick={() => setLocale('de')}>
        German
      </button>
      <EmailLogTable load={load} />
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test.each(Object.entries(copy))(
  'localizes the initial loading and default empty states in %s',
  async (locale, strings) => {
    const initialPage = deferred<EmailLogListResponse>();
    const load = vi.fn<EmailLogLoader>(() => initialPage.promise);

    renderTable(locale as keyof typeof copy, load);

    expect(await screen.findByRole('status')).toHaveTextContent(strings.loading);

    initialPage.resolve({ entries: [], nextCursor: null });

    expect(await screen.findByText(strings.empty)).toBeInTheDocument();
  },
);

test.each(Object.entries(copy))(
  'localizes table rows and pagination controls in %s',
  async (locale, strings) => {
    const user = userEvent.setup();
    const secondPage = deferred<EmailLogListResponse>();
    const load = vi
      .fn<EmailLogLoader>()
      .mockResolvedValueOnce({ entries, nextCursor })
      .mockImplementationOnce(() => secondPage.promise);

    renderTable(locale as keyof typeof copy, load);

    expect(await screen.findByText(entries[0].recipient)).toBeInTheDocument();
    for (const header of strings.headers) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    for (const status of strings.statuses) {
      expect(screen.getByText(status, { exact: false, selector: 'span' })).toBeInTheDocument();
    }
    expect(
      screen.getByText('SMTP_REJECTED', { exact: false, selector: 'span' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: strings.loadMore }));

    const loadingButton = await screen.findByRole('button', { name: strings.loadingMore });
    expect(loadingButton).toBeDisabled();
    expect(load).toHaveBeenLastCalledWith({ cursor: nextCursor }, undefined);

    secondPage.resolve({ entries: [], nextCursor: null });

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: strings.loadMore })).not.toBeInTheDocument(),
    );
  },
);

test('keeps an explicit empty label and an ApiError message', async () => {
  const customEmpty = 'No messages for this person.';
  const { unmount } = renderTable(
    'en',
    vi.fn<EmailLogLoader>().mockResolvedValue({ entries: [], nextCursor: null }),
    customEmpty,
  );

  expect(await screen.findByText(customEmpty)).toBeInTheDocument();
  unmount();

  const fallback = renderTable(
    'de',
    vi.fn<EmailLogLoader>().mockRejectedValue(new Error('The request failed.')),
  );

  expect(await screen.findByRole('alert')).toHaveTextContent('Etwas ist schiefgelaufen.');
  fallback.unmount();

  const apiMessage = 'The mail service is unavailable.';
  renderTable(
    'de',
    vi.fn<EmailLogLoader>().mockRejectedValue(new ApiError(503, 'UNAVAILABLE', apiMessage)),
  );

  expect(await screen.findByRole('alert')).toHaveTextContent(apiMessage);
});

test('keeps loaded pages when the locale changes', async () => {
  const user = userEvent.setup();
  const load = vi.fn<EmailLogLoader>().mockResolvedValue({ entries, nextCursor });

  render(
    <I18nProvider initialLocale="en">
      <LocaleSwitchingTable load={load} />
    </I18nProvider>,
  );

  expect(await screen.findByText(entries[0].recipient)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'German' }));

  expect(await screen.findByRole('button', { name: copy.de.loadMore })).toBeInTheDocument();
  expect(screen.getByText(entries[0].recipient)).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(1);
});

test('translates a generic error after a locale change without retrying', async () => {
  const user = userEvent.setup();
  const load = vi.fn<EmailLogLoader>().mockRejectedValue(new Error('The request failed.'));

  render(
    <I18nProvider initialLocale="en">
      <LocaleSwitchingTable load={load} />
    </I18nProvider>,
  );

  expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
  await user.click(screen.getByRole('button', { name: 'German' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Etwas ist schiefgelaufen.');
  expect(load).toHaveBeenCalledTimes(1);
});
