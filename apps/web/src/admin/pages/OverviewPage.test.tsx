import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminBackupStatusResponse,
  AdminHealthResponse,
  MeResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider } from '../../i18n';
import { AuthProvider } from '../AuthContext';
import { OverviewPage } from './OverviewPage';

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

const healthyHealth: AdminHealthResponse = {
  status: 'ok',
  version: '0.1.0',
  uptimeSeconds: 7320,
  checkedAt: '2026-08-20T10:00:00.000Z',
  components: {
    database: { status: 'ok' },
    redis: { status: 'ok' },
    providers: { status: 'ok', breakers: [], chains: [], switches: [], attribution: [] },
    queues: {
      status: 'ok',
      available: true,
      depths: [{ name: 'prices', waiting: 0, active: 0, delayed: 0, failed: 0, completed: 12 }],
      heartbeat: { status: 'ok', ageSeconds: 4 },
    },
    gateway: { status: 'ok', enabled: true, attached: true, connections: 7 },
  },
};

const readyBackup: AdminBackupStatusResponse = {
  configured: true,
  level: 'ok',
  reason: 'healthy',
  checkedAt: '2026-08-20T10:00:00.000Z',
  backup: {
    lastSuccessAt: '2026-08-20T04:00:00.000Z',
    ageSeconds: 6 * 3600,
    lastAttemptOutcome: 'success',
    artifactBytes: 4194304,
    maxAgeSeconds: 26 * 3600,
  },
  restore: {
    lastSuccessAt: '2026-08-10T04:00:00.000Z',
    ageSeconds: 10 * 86400,
    lastOutcome: 'success',
    maxAgeSeconds: 35 * 86400,
  },
  offsite: { outcome: 'success', uploadedCount: 3 },
  scheduler: { outcome: 'healthy', reason: 'none', checkedAt: '2026-08-20T09:59:00.000Z' },
};

function renderPage(locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter>
        <AuthProvider>
          <OverviewPage />
        </AuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
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
  vi.mocked(api.getStats).mockResolvedValue({
    userCount: 42,
    activeUserCount: 40,
    disabledUserCount: 2,
    pendingInviteCount: 1,
    pendingRegistrationCount: 0,
  });
  vi.mocked(api.getAdminHealth).mockResolvedValue(healthyHealth);
  vi.mocked(api.listProblems).mockResolvedValue({
    problems: [],
    openCount: 0,
    droppedCaptures: 0,
    droppedCapturesTotal: 0,
    total: 0,
    hasMore: false,
  });
  vi.mocked(api.getEmailStatus).mockResolvedValue({ enabled: true });
  vi.mocked(api.getBackupStatus).mockResolvedValue(readyBackup);
  vi.mocked(api.getVersion).mockResolvedValue({
    commit: 'a71be9012345',
    shortCommit: 'a71be90',
    builtAt: '2026-08-20T09:08:00.000Z',
  });
  vi.mocked(api.listAudit).mockResolvedValue({ entries: [], nextCursor: null });
  vi.mocked(api.getUsageAnalytics).mockResolvedValue({
    activeUsers: { daily: 9, weekly: 21, monthly: 33 },
    features: [],
    topAssets: [],
    funnel: [],
    series: [],
    windowDays: 30,
    generatedAt: '2026-08-20T10:00:00.000Z',
  });
});

test('a quiet deployment renders an explicit all-clear instead of an empty card', async () => {
  renderPage();

  expect(await screen.findByText('All clear — nothing is waiting for you.')).toBeInTheDocument();
  expect(screen.queryByText('Open problems')).not.toBeInTheDocument();
});

test('ranks the attention queue with the worst signal first and links each row to its workspace', async () => {
  vi.mocked(api.getStats).mockResolvedValue({
    userCount: 42,
    activeUserCount: 40,
    disabledUserCount: 2,
    pendingInviteCount: 1,
    pendingRegistrationCount: 2,
  });
  vi.mocked(api.listProblems).mockResolvedValue({
    problems: [],
    openCount: 4,
    droppedCaptures: 0,
    droppedCapturesTotal: 0,
    total: 4,
    hasMore: false,
  });
  vi.mocked(api.getEmailStatus).mockResolvedValue({ enabled: false });
  vi.mocked(api.getAdminHealth).mockResolvedValue({
    ...healthyHealth,
    status: 'down',
    components: {
      ...healthyHealth.components,
      database: { status: 'down' },
    },
  });

  renderPage();

  const critical = await screen.findByText('Database is not healthy');
  const rows = within(screen.getByRole('region', { name: 'Needs your attention' })).getAllByRole(
    'link',
  );

  // Critical first: a down database outranks pending approvals.
  expect(rows[0]).toHaveTextContent('Database is not healthy');
  expect(critical).toBeInTheDocument();

  const targets = rows.map((row) => row.getAttribute('href'));
  expect(targets).toContain('/admin/health');
  expect(targets).toContain('/admin/problems');
  expect(targets).toContain('/admin/registration');
  expect(targets).toContain('/admin/email');

  expect(screen.getByText('4 items')).toBeInTheDocument();
});

test('never renders a false all-clear when the attention reads failed', async () => {
  const { ApiError } = await import('../../lib/apiClient');
  const outage = new ApiError(500, 'internal_error', 'Something went wrong.');
  vi.mocked(api.getStats).mockRejectedValue(outage);
  vi.mocked(api.listProblems).mockRejectedValue(outage);
  vi.mocked(api.getAdminHealth).mockRejectedValue(outage);
  vi.mocked(api.getEmailStatus).mockRejectedValue(outage);
  vi.mocked(api.getBackupStatus).mockRejectedValue(outage);

  renderPage();

  expect(
    await screen.findByText('The attention checks could not be read. Refresh to try again.'),
  ).toBeInTheDocument();
  expect(screen.queryByText('All clear — nothing is waiting for you.')).not.toBeInTheDocument();
});

test('surfaces a failed backup drill as an amber signal with the documented reason', async () => {
  vi.mocked(api.getBackupStatus).mockResolvedValue({
    ...readyBackup,
    level: 'warn',
    reason: 'restore_stale',
    restore: { ...readyBackup.restore, ageSeconds: 40 * 86400 },
  });

  renderPage();

  expect(await screen.findByText('Backup readiness')).toBeInTheDocument();
  expect(
    screen.getAllByText('The newest restore drill is older than the 35-day target.').length,
  ).toBeGreaterThan(0);
  expect(screen.getByText('Unproven')).toBeInTheDocument();
});

test('shows "not configured" for a deployment without a backup status file', async () => {
  vi.mocked(api.getBackupStatus).mockResolvedValue({
    ...readyBackup,
    configured: false,
    level: 'unknown',
    reason: 'not_configured',
  });

  renderPage();

  expect(await screen.findByText('This deployment reports no backup status.')).toBeInTheDocument();
  // "unknown" is never an attention row — an unwired tile is not a problem.
  expect(await screen.findByText('All clear — nothing is waiting for you.')).toBeInTheDocument();
});

// The production failure this guards: the api container could not read the
// scheduler's status file at all. "Not configured" would have read as benign and
// hidden a total loss of backup visibility.
test('treats an unreadable backup status as a critical signal, not as "not configured"', async () => {
  vi.mocked(api.getBackupStatus).mockResolvedValue({
    ...readyBackup,
    configured: false,
    level: 'critical',
    reason: 'permission_denied',
  });

  renderPage();

  // Once in the attention queue, once on the tile — both must say it.
  expect(
    await screen.findAllByText(
      'The backup status file exists but this server may not read it. Check the mount and the file permissions.',
    ),
  ).toHaveLength(2);
  expect(screen.queryByText('All clear — nothing is waiting for you.')).not.toBeInTheDocument();
  expect(screen.getByText('Not ready')).toBeInTheDocument();
});

test('renders both deploy markers and the standing stat tiles', async () => {
  renderPage();

  expect(await screen.findByText('a71be90')).toBeInTheDocument();
  expect(screen.getByText('42')).toBeInTheDocument();
  expect(screen.getByText('40 active · 2 disabled')).toBeInTheDocument();
  // Usage analytics is the heavy read and arrives after the attention burst.
  await waitFor(() => expect(api.getUsageAnalytics).toHaveBeenCalled());
  expect(await screen.findByText('21 this week · 33 this month')).toBeInTheDocument();
});

test('refresh re-reads every panel once', async () => {
  renderPage();

  await screen.findByText('All clear — nothing is waiting for you.');
  expect(api.getAdminHealth).toHaveBeenCalledTimes(1);

  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

  await waitFor(() => expect(api.getAdminHealth).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(api.listAudit).toHaveBeenCalledTimes(2));
});

test('humanizes recent admin activity and links to the audit log', async () => {
  vi.mocked(api.listAudit).mockResolvedValue({
    entries: [
      {
        id: '00000000-0000-7000-8000-00000000000a',
        actorId: null,
        action: 'user.disable',
        targetType: 'user',
        targetId: 'u1',
        ip: null,
        meta: null,
        createdAt: '2026-08-20T09:38:00.000Z',
      },
    ],
    nextCursor: null,
  });

  renderPage();

  expect(await screen.findByText('User disable')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View audit log' })).toHaveAttribute(
    'href',
    '/admin/audit',
  );
});

test('renders the operator Overview in German', async () => {
  renderPage('de');

  expect(await screen.findByRole('heading', { name: 'Übersicht' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Braucht deine Aufmerksamkeit' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Letzte Admin-Aktionen' })).toBeInTheDocument();
});
