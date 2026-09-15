import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import {
  ADMIN_2FA_SETUP_REQUIRED,
  type AdminSecuritySignalsResponse,
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
  actor: { id: admin.id, username: 'rootadmin', kind: 'admin' },
  actorKind: 'account',
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

const breakGlassEntry: AuditLogEntry = {
  id: '00000000-0000-7000-8000-000000000003',
  actorId: null,
  actor: null,
  actorKind: 'shell',
  action: 'admin.two_factor_reset',
  targetType: 'user',
  targetId: '00000000-0000-7000-8000-000000000011',
  ip: null,
  meta: { via: 'break_glass_script' },
  createdAt: '2026-07-02T12:00:00.000Z',
};

const diffEntry: AuditLogEntry = {
  id: '00000000-0000-7000-8000-000000000004',
  actorId: admin.id,
  actor: { id: admin.id, username: 'rootadmin', kind: 'admin' },
  actorKind: 'account',
  action: 'settings.updated',
  targetType: 'app_settings',
  targetId: null,
  ip: null,
  meta: {
    before: { betaMode: false, registrationMode: 'closed' },
    after: { betaMode: true, registrationMode: 'closed', newKey: 'added' },
  },
  createdAt: '2026-07-03T12:00:00.000Z',
};

/**
 * Exactly what `featureFlagService.setFlag` writes: the `{ before, after }`
 * pair AND three sibling keys, the flag NAME among them.
 */
const flagEntry: AuditLogEntry = {
  id: '00000000-0000-7000-8000-000000000005',
  actorId: admin.id,
  actor: { id: admin.id, username: 'rootadmin', kind: 'admin' },
  actorKind: 'account',
  action: 'feature_flag.changed',
  targetType: 'feature_flag',
  targetId: null,
  ip: null,
  meta: {
    key: 'chat',
    enabled: false,
    propagated: true,
    before: { enabled: true },
    after: { enabled: false },
  },
  createdAt: '2026-07-04T12:00:00.000Z',
};

const noSignals: AdminSecuritySignalsResponse = {
  window: '24h',
  from: '2026-06-30T12:00:00.000Z',
  to: '2026-07-01T12:00:00.000Z',
  loginFailures: { total: 0, byReason: [] },
  twoFactorVerifyFail: 0,
  passkeyLoginFail: 0,
  pinVerifyFail: 0,
  reauthFail: 0,
  apiKeyScopeDenied: 0,
  adminLogins: 0,
  adminActors: 0,
  breakGlass: 0,
  breakGlassRetentionTotal: 0,
  breakGlassRetentionCapped: false,
};

const nextCursor = '00000000-0000-7000-8000-000000000099';

function AuthStatus() {
  const { status } = useAuth();
  return <div data-testid="auth-status">{status}</div>;
}

/** The URL the page has driven the filters into — the shareable-link contract. */
function CurrentUrl() {
  const location = useLocation();
  return <div data-testid="url">{`${location.pathname}${location.search}`}</div>;
}

function renderPage(locale = 'en', entry = '/admin/audit') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AuthStatus />
          <CurrentUrl />
          <Routes>
            <Route path="/admin/audit" element={<AuditPage />} />
          </Routes>
        </MemoryRouter>
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

/** The filter set the page last sent, so every filter test asserts the real call. */
function lastAuditQuery(): Record<string, unknown> {
  const calls = vi.mocked(api.listAudit).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
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
  vi.mocked(api.getSecuritySignals).mockResolvedValue(noSignals);
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
  // The new W6 controls are catalogued too — no hardcoded English anywhere.
  expect(screen.getByRole('button', { name: 'Notfallzugriff' })).toBeInTheDocument();
  expect(screen.getByLabelText('Aktion')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Signale' })).toBeInTheDocument();
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
  expect(lastAuditQuery()).toEqual({ cursor: nextCursor });

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
  expect(lastAuditQuery()).toEqual({ cursor: nextCursor });

  await user.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByText('audit.second')).toBeInTheDocument();
  expect(screen.getAllByText('audit.first')).toHaveLength(1);
  expect(lastAuditQuery()).toEqual({ cursor: nextCursor });
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

// ── W6: filters in the URL (#1908 §6) ───────────────────────────────────────

test('reads every filter out of the URL on first render', async () => {
  renderPage(
    'en',
    '/admin/audit?action=user.&actorId=00000000-0000-7000-8000-0000000000aa' +
      '&targetId=00000000-0000-7000-8000-0000000000bb&targetType=user' +
      '&from=2026-06-01T00:00:00.000Z&to=2026-06-03T00:00:00.000Z&preset=admin_actions',
  );

  await waitFor(() => expect(api.listAudit).toHaveBeenCalled());
  expect(lastAuditQuery()).toEqual({
    action: 'user.',
    actorId: '00000000-0000-7000-8000-0000000000aa',
    targetId: '00000000-0000-7000-8000-0000000000bb',
    targetType: 'user',
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-06-03T00:00:00.000Z',
    preset: 'admin_actions',
  });
});

test('puts a typed filter into the URL, so the view survives a reload as a link', async () => {
  const user = userEvent.setup();
  const { unmount } = renderPage();

  await screen.findByText('No audit entries yet.');
  await user.type(screen.getByLabelText('Action'), 'user.');

  await waitFor(() =>
    expect(screen.getByTestId('url')).toHaveTextContent('/admin/audit?action=user.'),
  );
  await waitFor(() => expect(lastAuditQuery()).toEqual({ action: 'user.' }));

  // The reload: a second mount from the URL alone re-issues the same read.
  const url = screen.getByTestId('url').textContent ?? '/admin/audit';
  unmount();
  vi.mocked(api.listAudit).mockClear();
  renderPage('en', url);
  await waitFor(() => expect(lastAuditQuery()).toEqual({ action: 'user.' }));
});

test('toggles a preset chip through the URL and clears every filter at once', async () => {
  const user = userEvent.setup();
  renderPage('en', '/admin/audit?action=user.');

  await screen.findByText('No audit entries match these filters.');
  await user.click(screen.getByRole('button', { name: 'Break-glass' }));
  await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('preset=break_glass'));
  expect(screen.getByRole('button', { name: 'Break-glass' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Pressing the active chip again removes it rather than re-applying it.
  await user.click(screen.getByRole('button', { name: 'Break-glass' }));
  await waitFor(() =>
    expect(screen.getByTestId('url')).not.toHaveTextContent('preset=break_glass'),
  );

  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  await waitFor(() => expect(lastAuditQuery()).toEqual({}));
});

test('sends the day the operator picked as a half-open range, inclusive of the end day', async () => {
  const user = userEvent.setup();
  renderPage();

  await screen.findByText('No audit entries yet.');
  await user.type(screen.getByLabelText('From'), '2026-06-01');
  await user.type(screen.getByLabelText('Until'), '2026-06-02');

  // "Until 2 June" means everything ON 2 June, so the exclusive bound the
  // contract wants is the start of 3 June.
  await waitFor(() =>
    expect(lastAuditQuery()).toEqual({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-03T00:00:00.000Z',
    }),
  );
  // And it round-trips back into the picker as the day the operator chose.
  expect(screen.getByLabelText('Until')).toHaveValue('2026-06-02');
});

// ── W6: actor attribution (#1908 §3) ────────────────────────────────────────

test('shows the actor username, and tells the actorless kinds apart', async () => {
  vi.mocked(api.listAudit).mockResolvedValueOnce({
    entries: [
      firstEntry,
      breakGlassEntry,
      { ...secondEntry, actorId: null, actor: null, actorKind: 'unattributed' },
    ],
    nextCursor: null,
  });

  renderPage();

  await screen.findByText('audit.first');
  const rows = screen.getAllByRole('row');
  // A username, never a raw UUID and never the e-mail.
  expect(within(rows[1]!).getByText('rootadmin')).toBeInTheDocument();
  expect(screen.queryByText(admin.email)).not.toBeInTheDocument();
  // The break-glass row is visually its own thing, not "system".
  expect(within(rows[2]!).getByText('Shell (break-glass)')).toBeInTheDocument();
  // And the unresolvable one is labelled honestly rather than claiming a deletion.
  expect(within(rows[3]!).getByText('System or removed account')).toBeInTheDocument();
});

// ── W6: the row drawer (#1908 §4) ───────────────────────────────────────────

test('opens the row drawer, renders the field-by-field diff, and closes on Escape', async () => {
  const user = userEvent.setup();
  vi.mocked(api.listAudit).mockResolvedValueOnce({ entries: [diffEntry], nextCursor: null });

  renderPage();

  await screen.findByText('settings.updated');
  await user.click(screen.getByRole('button', { name: 'Details' }));

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Audit entry')).toBeInTheDocument();

  // Changed, unchanged and added all render, each named.
  const changed = within(dialog).getByText('betaMode').closest('tr') as HTMLElement;
  expect(changed).toHaveAttribute('data-diff-state', 'changed');
  expect(within(changed).getByText('false')).toBeInTheDocument();
  expect(within(changed).getByText('true')).toBeInTheDocument();
  expect(within(dialog).getByText('registrationMode').closest('tr')).toHaveAttribute(
    'data-diff-state',
    'unchanged',
  );
  expect(within(dialog).getByText('newKey').closest('tr')).toHaveAttribute(
    'data-diff-state',
    'added',
  );

  // Escape through the shared overlay arbiter (#1302), not a bespoke handler.
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

/**
 * Review of PR #1942, B2. Rendering the diff INSTEAD of the tree put every
 * sibling key out of reach of the whole console — the flag NAME for a
 * `feature_flag.changed` row, and `moderationId` (ADMIN-W5's link to the reason)
 * for a moderating write. main's row cell at least stringified the full payload
 * into its `title`, so dropping them was a regression, not a gap.
 */
test('shows the keys beside the diff, not only the diff', async () => {
  const user = userEvent.setup();
  vi.mocked(api.listAudit).mockResolvedValueOnce({ entries: [flagEntry], nextCursor: null });

  renderPage();

  await screen.findByText('feature_flag.changed');
  // The row cell names the changed field AND the remaining keys.
  // Deduped: `enabled` is both the changed field and a top-level sibling.
  expect(screen.getByText('enabled, key, propagated')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Details' }));
  const dialog = await screen.findByRole('dialog');

  // The diff is there … (scoped to the diff table: `enabled` legitimately
  // appears twice now — once as the changed field, once as a sibling key.)
  const diffRow = dialog.querySelector('tr[data-diff-state]');
  expect(diffRow).not.toBeNull();
  expect(diffRow).toHaveAttribute('data-diff-state', 'changed');
  expect(within(diffRow as HTMLElement).getByText('enabled')).toBeInTheDocument();
  // … and so is WHICH FLAG it was, which is the fact the diff cannot carry.
  expect(within(dialog).getByText('key')).toBeInTheDocument();
  expect(within(dialog).getByText('chat')).toBeInTheDocument();
  expect(within(dialog).getByText('propagated')).toBeInTheDocument();
});

test('shows a W5 moderation link beside the before/after pair', async () => {
  const user = userEvent.setup();
  vi.mocked(api.listAudit).mockResolvedValueOnce({
    entries: [
      {
        ...diffEntry,
        action: 'user.role_changed',
        meta: {
          before: { role: 'user' },
          after: { role: 'admin' },
          moderationId: '00000000-0000-7000-8000-00000000c0de',
        },
      },
    ],
    nextCursor: null,
  });

  renderPage();

  await screen.findByText('user.role_changed');
  await user.click(screen.getByRole('button', { name: 'Details' }));

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('moderationId')).toBeInTheDocument();
  expect(within(dialog).getByText('00000000-0000-7000-8000-00000000c0de')).toBeInTheDocument();
});

test('renders a plain meta payload as a readable tree rather than a JSON blob', async () => {
  const user = userEvent.setup();
  vi.mocked(api.listAudit).mockResolvedValueOnce({
    entries: [{ ...firstEntry, meta: { reason: 'locked', nested: { attempts: 3 } } }],
    nextCursor: null,
  });

  renderPage();

  await screen.findByText('audit.first');
  await user.click(screen.getByRole('button', { name: 'Details' }));

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('reason')).toBeInTheDocument();
  expect(within(dialog).getByText('locked')).toBeInTheDocument();
  expect(within(dialog).getByText('attempts')).toBeInTheDocument();
  expect(within(dialog).getByText('3')).toBeInTheDocument();
});

// ── W6: signals + the break-glass banner (#1908 §3, §5) ─────────────────────

test('raises a standing break-glass banner and files the preset behind it', async () => {
  const user = userEvent.setup();
  vi.mocked(api.getSecuritySignals).mockResolvedValue({
    ...noSignals,
    breakGlass: 1,
    breakGlassRetentionTotal: 2,
  });

  renderPage();

  // Standing: on screen without expanding anything.
  expect(
    await screen.findByText(/2 break-glass two-factor resets are on record/),
  ).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Show them' }));
  await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('preset=break_glass'));
  await waitFor(() => expect(lastAuditQuery()).toEqual({ preset: 'break_glass' }));
});

test('shows no banner when nothing has ever been reset from a shell', async () => {
  renderPage();

  await screen.findByText('No audit entries yet.');
  await waitFor(() => expect(api.getSecuritySignals).toHaveBeenCalled());
  expect(screen.queryByText(/break-glass two-factor resets/)).not.toBeInTheDocument();
});

test('expands the signals section and switches its window through the URL', async () => {
  const user = userEvent.setup();
  vi.mocked(api.getSecuritySignals).mockResolvedValue({
    ...noSignals,
    loginFailures: { total: 3, byReason: [{ reason: 'bad_password', count: 3 }] },
    adminLogins: 4,
  });

  renderPage();

  await screen.findByText('No audit entries yet.');
  await user.click(screen.getByRole('button', { name: 'Show' }));

  expect(await screen.findByText('Wrong password')).toBeInTheDocument();
  expect(screen.getByText('Admin sign-ins')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '7 days' }));
  await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('signalWindow=7d'));
  await waitFor(() =>
    // `useResource` passes its own abort signal; the window is what this asserts.
    expect(api.getSecuritySignals).toHaveBeenLastCalledWith('7d', expect.anything()),
  );
});

test('a failed signals read never takes the audit log down with it', async () => {
  vi.mocked(api.getSecuritySignals).mockRejectedValue(
    new ApiError(503, 'UNAVAILABLE', 'signals envelope the page must not show'),
  );
  vi.mocked(api.listAudit).mockResolvedValueOnce({ entries: [firstEntry], nextCursor: null });

  renderPage();

  // The table is the page's job; the aggregate is a convenience beside it.
  expect(await screen.findByText('audit.first')).toBeInTheDocument();
  expect(screen.queryByText(/signals envelope/)).not.toBeInTheDocument();
});
