import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { EmailLogEntry, EmailLogListResponse, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { ApiError } from '../../lib/apiClient';
import { I18nProvider, localizedMessage, useI18n } from '../../i18n';
import { AuthProvider, useAuth } from '../AuthContext';
import { EmailLogTable, type EmailLogLoader } from './EmailLogTable';

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

beforeEach(() => {
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
    setupRequired: false,
    totpEnabled: true,
    totpPending: false,
    emailEnabled: false,
    twoFactorEmail: null,
    recoveryCodesRemaining: 8,
  });
  vi.mocked(api.getVersion).mockRejectedValue(new Error('no version marker in tests'));
});

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

/**
 * The table reads the admin session (it signs the console out when the V5-P13c
 * window closes), so every render needs the provider — and `status` is exposed
 * so a sign-out is observable.
 */
function AuthStatus() {
  const { status } = useAuth();
  return <span data-testid="status">{status}</span>;
}

function renderTable(locale: keyof typeof copy, load: EmailLogLoader, emptyLabel?: string) {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <AuthStatus />
        <EmailLogTable load={load} emptyLabel={emptyLabel} />
      </AuthProvider>
    </I18nProvider>,
  );
}

function LocaleSwitchingTable({ load }: { load: EmailLogLoader }) {
  const { setLocale } = useI18n();
  return (
    <AuthProvider>
      <button type="button" onClick={() => setLocale('de')}>
        German
      </button>
      <EmailLogTable load={load} />
    </AuthProvider>
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

test('keeps an explicit empty label, and never renders the server envelope', async () => {
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

  // #1814: this used to render `err.message` verbatim, so a DE operator whose
  // mail service was down read an English sentence in an otherwise German
  // console. API envelopes are authored by the server and are not locale-aware,
  // so every displayable failure is catalog copy.
  const apiMessage = 'The mail service is unavailable.';
  renderTable(
    'de',
    vi.fn<EmailLogLoader>().mockRejectedValue(new ApiError(503, 'UNAVAILABLE', apiMessage)),
  );

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(localizedMessage('de', 'common.genericError'));
  expect(alert).not.toHaveTextContent(apiMessage);
});

/** Mount the table only once the console is signed in, so the sign-out is the
 *  table's and not a race with the provider's own bootstrap. */
function SignedInTable({ load }: { load: EmailLogLoader }) {
  const { status } = useAuth();
  return (
    <>
      <span data-testid="status">{status}</span>
      {status === 'authenticated' ? <EmailLogTable load={load} /> : null}
    </>
  );
}

test.each([
  ['a 401', new ApiError(401, 'UNAUTHENTICATED', 'Unauthenticated.')],
  // §6.12 makes every `/admin/*` route answer a domainless 404 to a caller that
  // is no longer an admin — on a live console, the V5-P13c window closing.
  ['a domainless 404', new ApiError(404, 'NOT_FOUND', 'Not found')],
] as const)(
  'signs the console out on %s instead of leaving the operator on a dead page',
  async (_label, err) => {
    const load = vi.fn<EmailLogLoader>().mockRejectedValue(err);
    render(
      <I18nProvider initialLocale="de">
        <AuthProvider>
          <SignedInTable load={load} />
        </AuthProvider>
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    // Not a banner on a console that can no longer read anything — and never
    // the English envelope.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(err.message)).not.toBeInTheDocument();
  },
);

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
