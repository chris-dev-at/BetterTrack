import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import {
  ADMIN_2FA_SETUP_REQUIRED,
  type AuditLogEntry,
  type AuditLogListResponse,
  type MeResponse,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { I18nProvider } from '../../i18n';
import { AuthProvider, useAuth } from '../AuthContext';
import { AuditPage } from './AuditPage';

vi.mock('../../lib/adminApi');

const admin: MeResponse = {
  id: '00000000-0000-7000-8000-000000000010',
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

const firstEntry: AuditLogEntry = {
  id: '00000000-0000-7000-8000-000000000001',
  actorId: admin.id,
  action: 'audit.first',
  targetType: 'user',
  targetId: '00000000-0000-7000-8000-000000000011',
  ip: '127.0.0.1',
  meta: { reason: 'test' },
  createdAt: '2026-07-01T12:00:00.000Z',
};

const secondEntry: AuditLogEntry = {
  ...firstEntry,
  id: '00000000-0000-7000-8000-000000000002',
  action: 'audit.second',
};

const nextCursor = '00000000-0000-7000-8000-000000000099';

function AuthStatus() {
  const { status } = useAuth();
  return <div data-testid="auth-status">{status}</div>;
}

function renderPage(locale = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <AuthStatus />
        <AuditPage />
      </AuthProvider>
    </I18nProvider>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
  vi.mocked(api.listAudit).mockResolvedValue({ entries: [], nextCursor: null });
});

test('renders an accessible loading state before the empty state', async () => {
  const initialPage = deferred<AuditLogListResponse>();
  vi.mocked(api.listAudit).mockImplementationOnce(() => initialPage.promise);

  renderPage();

  expect(await screen.findByRole('status')).toHaveTextContent('Loading audit log…');

  initialPage.resolve({ entries: [], nextCursor: null });

  expect(await screen.findByText('No audit entries yet.')).toBeInTheDocument();
});

/**
 * #1848: this assertion used to read `toHaveTextContent('Audit log is
 * unavailable.')` — the server's OWN envelope, rendered verbatim, which is the
 * defect the issue names and exactly what `useResource` forbids ("API envelopes
 * are authored by the server and are not locale-aware"). It now asserts the
 * catalogue copy AND that the envelope text reaches no part of the screen, and
 * the German case below asserts the same thing in the other locale.
 */
test('renders catalog copy for a failed read, never the server envelope', async () => {
  const user = userEvent.setup();
  vi.mocked(api.listAudit)
    .mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'Audit log is unavailable.'))
    .mockResolvedValueOnce({ entries: [firstEntry], nextCursor: null });

  renderPage();

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the audit log.');
  expect(screen.queryByText(/Audit log is unavailable\./)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByText('audit.first')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(api.listAudit).toHaveBeenCalledTimes(2);
});

test('localizes the failure and the retry action, and leaks no English envelope into DE', async () => {
  vi.mocked(api.listAudit).mockRejectedValueOnce(
    new ApiError(500, 'INTERNAL', 'Audit log is unavailable.'),
  );

  renderPage('de');

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Das Audit-Protokoll konnte nicht geladen werden.',
  );
  expect(screen.queryByText(/Audit log is unavailable\./)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
});

test('renders every label, empty state and control from the catalogue in German', async () => {
  vi.mocked(api.listAudit).mockResolvedValueOnce({ entries: [firstEntry], nextCursor });

  renderPage('de');

  expect(await screen.findByRole('heading', { name: 'Audit-Protokoll' })).toBeInTheDocument();
  for (const column of ['Zeitpunkt', 'Aktion', 'Akteur', 'Ziel', 'IP', 'Details']) {
    expect(screen.getByRole('columnheader', { name: column })).toBeInTheDocument();
  }
  expect(screen.getByRole('button', { name: 'Mehr laden' })).toBeInTheDocument();
});

test('names the system actor from the catalogue rather than a hardcoded literal', async () => {
  vi.mocked(api.listAudit).mockResolvedValueOnce({
    entries: [{ ...firstEntry, actorId: null }],
    nextCursor: null,
  });

  renderPage('de');

  expect(await screen.findByText('System')).toBeInTheDocument();
});

test('appends the next page, disables the control while pending, and hides it at the end', async () => {
  const user = userEvent.setup();
  const nextPage = deferred<AuditLogListResponse>();
  vi.mocked(api.listAudit)
    .mockResolvedValueOnce({ entries: [firstEntry], nextCursor })
    .mockImplementationOnce(() => nextPage.promise);

  renderPage();

  await screen.findByText('audit.first');
  await user.click(screen.getByRole('button', { name: 'Load more' }));

  const loadingButton = await screen.findByRole('button', { name: 'Loading…' });
  expect(loadingButton).toBeDisabled();
  expect(screen.getByText('audit.first')).toBeInTheDocument();
  expect(api.listAudit).toHaveBeenLastCalledWith({ cursor: nextCursor }, undefined);

  nextPage.resolve({ entries: [secondEntry], nextCursor: null });

  expect(await screen.findByText('audit.second')).toBeInTheDocument();
  expect(screen.getByText('audit.first')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
});

test('keeps loaded rows and retries the same cursor after a pagination failure', async () => {
  const user = userEvent.setup();
  vi.mocked(api.listAudit)
    .mockResolvedValueOnce({ entries: [firstEntry], nextCursor })
    .mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'envelope text the page must not show'))
    .mockResolvedValueOnce({ entries: [secondEntry], nextCursor: null });

  renderPage();

  await screen.findByText('audit.first');
  await user.click(screen.getByRole('button', { name: 'Load more' }));

  // Catalogue copy again (#1848), not the 503 envelope the server sent.
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load more audit entries.');
  expect(screen.queryByText(/UNAVAILABLE|envelope text/)).not.toBeInTheDocument();
  expect(screen.getByText('audit.first')).toBeInTheDocument();
  expect(api.listAudit).toHaveBeenLastCalledWith({ cursor: nextCursor }, undefined);

  await user.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByText('audit.second')).toBeInTheDocument();
  expect(screen.getAllByText('audit.first')).toHaveLength(1);
  expect(api.listAudit).toHaveBeenLastCalledWith({ cursor: nextCursor }, undefined);
  expect(api.listAudit).toHaveBeenCalledTimes(3);
});

test('hands an unauthorized audit response to the auth context', async () => {
  vi.mocked(api.getMe).mockImplementation(() => new Promise<MeResponse>(() => undefined));
  vi.mocked(api.listAudit).mockRejectedValueOnce(new ApiError(401, 'UNAUTHORIZED', 'Expired.'));

  renderPage();

  await waitFor(() => expect(screen.getByTestId('auth-status')).toHaveTextContent('anonymous'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('hands the mandatory-2FA setup response to the auth context', async () => {
  vi.mocked(api.getMe).mockImplementation(() => new Promise<MeResponse>(() => undefined));
  vi.mocked(api.listAudit).mockRejectedValueOnce(
    new ApiError(403, ADMIN_2FA_SETUP_REQUIRED, 'Set up two-factor authentication.'),
  );

  renderPage();

  await waitFor(() =>
    expect(screen.getByTestId('auth-status')).toHaveTextContent('two-factor-setup-required'),
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
