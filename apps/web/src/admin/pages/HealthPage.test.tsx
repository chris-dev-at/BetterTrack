import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminBackupStatusResponse,
  AdminHealthResponse,
  AdminOpsJobsResponse,
  MeResponse,
  VersionResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider } from '../../i18n';
import { AuthProvider } from '../AuthContext';
import { HealthPage } from './HealthPage';

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

const health: AdminHealthResponse = {
  status: 'degraded',
  version: '0.1.0',
  uptimeSeconds: 3725,
  checkedAt: '2026-07-16T02:00:00.000Z',
  components: {
    database: { status: 'ok', latencyMs: 2 },
    redis: { status: 'down', detail: 'connection refused' },
    providers: {
      status: 'degraded',
      breakers: [
        { providerId: 'yahoo', state: 'open' },
        { providerId: 'stooq', state: 'closed' },
      ],
      chains: [
        {
          primaryId: 'yahoo',
          serving: 'stooq',
          since: '2026-07-16T01:59:00.000Z',
          providerIds: ['yahoo', 'stooq'],
        },
      ],
      switches: [
        { primaryId: 'yahoo', from: 'yahoo', to: 'stooq', at: '2026-07-16T01:59:00.000Z' },
      ],
      attribution: [
        { providerId: 'yahoo', serves: 10, lastServedAt: '2026-07-16T01:00:00.000Z' },
        { providerId: 'stooq', serves: 3, lastServedAt: '2026-07-16T02:00:00.000Z' },
      ],
    },
    queues: {
      status: 'ok',
      available: true,
      depths: [
        { name: 'system.heartbeat', waiting: 0, active: 0, delayed: 0, failed: 0, completed: 5 },
      ],
      heartbeat: { status: 'ok', ageSeconds: 12 },
    },
    gateway: { status: 'ok', enabled: true, attached: true, connections: 3 },
  },
};

const version: VersionResponse = {
  commit: 'b657d6a1f0c2e4d9a7b3c5e1f8d2a4b6c8e0f2a4',
  shortCommit: 'b657d6a',
  builtAt: '2026-07-16T01:00:00.000Z',
};

/**
 * A cockpit-shaped jobs payload: one busy queue, one idle, a retention schedule
 * that has already run and reported its counts, and one permanently-failed job.
 */
const jobs: AdminOpsJobsResponse = {
  available: true,
  checkedAt: '2026-07-16T02:00:00.000Z',
  heartbeatAgeSeconds: 12,
  heartbeatIntervalSeconds: 60,
  queues: [
    {
      name: 'prices.backfill',
      waiting: 31,
      active: 1,
      delayed: 12,
      failed: 0,
      completed: 900,
      paused: 0,
    },
    {
      name: 'standingOrders.process',
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 2,
      completed: 40,
      paused: 0,
    },
    {
      name: 'system.heartbeat',
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 5,
      paused: 0,
    },
  ],
  schedules: [
    {
      id: 'data.retentionCleanup',
      queue: 'data.retentionCleanup',
      pattern: '50 4 * * *',
      everyMs: null,
      tz: 'Europe/Vienna',
      nextRunAt: '2026-07-17T02:50:00.000Z',
      lastRun: {
        finishedAt: '2026-07-16T02:50:04.000Z',
        durationMs: 4000,
        counts: { auditPruned: 120, emailLogPruned: 8, deferredToNextRun: 0 },
      },
    },
  ],
  failures: [
    {
      queue: 'notifications.dispatch',
      jobId: 'job-1',
      name: 'notifications.dispatch',
      failedReason: 'ECONNREFUSED smtp.example.test:587',
      attemptsMade: 3,
      at: '2026-07-16T01:30:00.000Z',
    },
  ],
  failureTotal: 1,
};

const backupStatus: AdminBackupStatusResponse = {
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

function renderPage(locale: 'en' | 'de' = 'en', entry = '/admin/health') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <MemoryRouter initialEntries={[entry]}>
          <HealthPage />
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
  vi.mocked(api.getBackupStatus).mockResolvedValue(backupStatus);
  vi.mocked(api.getAdminHealth).mockResolvedValue(health);
  vi.mocked(api.getOpsJobs).mockResolvedValue(jobs);
  vi.mocked(api.getVersion).mockResolvedValue(version);
});

// ── W1 behaviour this page must keep ───────────────────────────────────────

// #1406 W1: the Overview's backup attention row links here, so the evidence has
// to be on this page rather than one workspace away.
test('shows the backup and restore-drill evidence the Overview links to', async () => {
  renderPage();

  const panel = await screen.findByRole('region', { name: 'Backup & restore drill' });
  expect(within(panel).getByText('Ready')).toBeInTheDocument();
  expect(
    within(panel).getByText('A recent dump exists and a recent restore drill proved it.'),
  ).toBeInTheDocument();
  expect(within(panel).getByText('6 h 0 min ago')).toBeInTheDocument();
  expect(within(panel).getByText('10 d 0 h ago')).toBeInTheDocument();
});

test('a critical backup verdict reads red with its reason, without breaking the page', async () => {
  vi.mocked(api.getBackupStatus).mockResolvedValue({
    ...backupStatus,
    level: 'critical',
    reason: 'scheduler_unhealthy',
    scheduler: { outcome: 'stale', reason: 'artifact_missing', checkedAt: null },
  });
  renderPage();

  const panel = await screen.findByRole('region', { name: 'Backup & restore drill' });
  expect(within(panel).getByText('Not ready')).toBeInTheDocument();
  expect(
    within(panel).getByText('The backup scheduler reports a problem with the stored backup.'),
  ).toBeInTheDocument();
  // The system snapshot above it still rendered.
  expect(screen.getByRole('region', { name: 'System' })).toBeInTheDocument();
});

test('a failed backup read degrades to a retry without touching the system snapshot', async () => {
  vi.mocked(api.getBackupStatus).mockRejectedValue(new Error('boom'));
  renderPage();

  const panel = await screen.findByRole('region', { name: 'Backup & restore drill' });
  expect(await within(panel).findByText('Could not read the backup status.')).toBeInTheDocument();
  expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'System' })).toBeInTheDocument();
});

test('renders every component status once loaded', async () => {
  const initialLoad = deferred<AdminHealthResponse>();
  vi.mocked(api.getAdminHealth).mockReturnValueOnce(initialLoad.promise);
  renderPage();

  expect(screen.getByRole('region', { name: 'System' })).toHaveAttribute('aria-busy', 'true');

  initialLoad.resolve(health);
  const system = screen.getByRole('region', { name: 'System' });
  await waitFor(() => expect(within(system).getByText('Database')).toBeInTheDocument());
  expect(system).toHaveAttribute('aria-busy', 'false');
  expect(within(system).getByText('Redis')).toBeInTheDocument();
  // Scoped to the region: "Market data" is also the W5 tab's label in the strip.
  expect(within(system).getByText('Market data')).toBeInTheDocument();
  expect(within(system).getByText('Job queues')).toBeInTheDocument();
  expect(within(system).getByText('Realtime gateway')).toBeInTheDocument();

  expect(within(system).getAllByText('Degraded').length).toBeGreaterThan(0);
  expect(within(system).getByText('Down')).toBeInTheDocument();
  expect(within(system).getByText('3 connected')).toBeInTheDocument();
});

test('shows an error state when the health fetch fails', async () => {
  vi.mocked(api.getAdminHealth).mockRejectedValue(new Error('boom'));
  renderPage();

  await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
});

// ── W4: the cockpit ────────────────────────────────────────────────────────

// The deployed commit is the answer to "is my merge live?"; the API version
// never changes and cannot answer it.
test('reports the deployed commit, not just the API version', async () => {
  renderPage();

  expect(await screen.findByText('b657d6a')).toBeInTheDocument();
  expect(screen.getByText('Deployed build')).toBeInTheDocument();
});

test('says the commit is unavailable rather than passing the API version off as one', async () => {
  vi.mocked(api.getVersion).mockRejectedValue(new Error('boom'));
  renderPage();

  await screen.findByText('The deploy marker could not be read.');
  expect(screen.queryByText('b657d6a')).not.toBeInTheDocument();
});

test('lists the busy queues and hides the idle ones behind a count', async () => {
  renderPage();

  const table = await screen.findByRole('table', { name: '' }).catch(() => null);
  void table;
  const backfill = (await screen.findByText('prices.backfill')).closest('tr')!;
  expect(within(backfill).getByText('31')).toBeInTheDocument();
  expect(within(backfill).getByText('12')).toBeInTheDocument();

  // The idle heartbeat queue is not drawn, but its existence is stated.
  expect(screen.queryByText('system.heartbeat')).not.toBeInTheDocument();
  expect(screen.getByText('1 idle queues are not listed.')).toBeInTheDocument();
});

// The §9 promise that never had a reader: what failed, and why.
test('shows a permanently-failed job with its reason', async () => {
  renderPage();

  const row = (await screen.findByText('notifications.dispatch')).closest('tr')!;
  expect(within(row).getByText('ECONNREFUSED smtp.example.test:587')).toBeInTheDocument();
  expect(within(row).getByText('3')).toBeInTheDocument();
});

// The DECISION killed generic queue retry/discard. The absence must read as a
// decision, not as something nobody got around to.
test('offers no retry or discard, and says why', async () => {
  renderPage();

  await screen.findByText('notifications.dispatch');
  expect(screen.getByText(/there is no retry or discard/)).toBeInTheDocument();
  for (const button of screen.getAllByRole('button')) {
    expect(button.textContent ?? '').not.toMatch(/retry|discard|requeue/i);
  }
});

test('shows a sweep’s own counts and when it next runs', async () => {
  renderPage();

  const row = (await screen.findByText('data.retentionCleanup')).closest('tr')!;
  expect(within(row).getByText('50 4 * * *')).toBeInTheDocument();
  expect(within(row).getByText('Europe/Vienna')).toBeInTheDocument();
  // The retention job's return value, carried through BullMQ to the operator.
  expect(within(row).getByText(/auditPruned: 120/)).toBeInTheDocument();
  expect(within(row).getByText('4000 ms')).toBeInTheDocument();
});

// "No jobs waiting" and "I cannot see the jobs" are different facts.
test('distinguishes an unreadable queue system from an empty one', async () => {
  vi.mocked(api.getOpsJobs).mockResolvedValue({
    ...jobs,
    available: false,
    queues: [],
    schedules: [],
  });
  renderPage();

  expect(
    await screen.findByText(/holds no queue registry, so it cannot see the queues/),
  ).toBeInTheDocument();
  expect(screen.queryByText('prices.backfill')).not.toBeInTheDocument();
});

test('renders the Operations tab strip with Health & queues current', async () => {
  renderPage();

  const nav = await screen.findByRole('navigation', { name: 'Operations' });
  expect(within(nav).getByRole('link', { name: /Health & queues/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // The W5 placeholder is present and marked, not hidden.
  expect(within(nav).getByRole('link', { name: /Market data/ })).toBeInTheDocument();
});

test('refreshing re-reads every panel so the cockpit shows one moment', async () => {
  renderPage();
  await screen.findByText('Database');

  const before = vi.mocked(api.getAdminHealth).mock.calls.length;
  const beforeJobs = vi.mocked(api.getOpsJobs).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

  await waitFor(() => {
    expect(vi.mocked(api.getAdminHealth).mock.calls.length).toBe(before + 1);
  });
  expect(vi.mocked(api.getOpsJobs).mock.calls.length).toBe(beforeJobs + 1);
});

test('localizes the cockpit into German', async () => {
  renderPage('de');

  expect(
    await screen.findByRole('heading', { level: 1, name: 'Zustand & Warteschlangen' }),
  ).toBeInTheDocument();
  expect(screen.getByText('Geplante Läufe')).toBeInTheDocument();
  expect(screen.getByText('Endgültige Fehlschläge')).toBeInTheDocument();
});
