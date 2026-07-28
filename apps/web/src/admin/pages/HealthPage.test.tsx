import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AdminHealthResponse, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
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

function renderPage() {
  return render(
    <AuthProvider>
      <HealthPage />
    </AuthProvider>,
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
});

test('renders every component status once loaded', async () => {
  const initialLoad = deferred<AdminHealthResponse>();
  vi.mocked(api.getAdminHealth).mockReturnValueOnce(initialLoad.promise);
  renderPage();

  expect(screen.getByRole('region', { name: 'System health' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();

  initialLoad.resolve(health);
  await waitFor(() => expect(screen.getByText('Database')).toBeInTheDocument());
  expect(screen.getByRole('region', { name: 'System health' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  expect(screen.getByText('Redis')).toBeInTheDocument();
  expect(screen.getByText('Market data')).toBeInTheDocument();
  expect(screen.getByText('Job queues')).toBeInTheDocument();
  expect(screen.getByText('Realtime gateway')).toBeInTheDocument();

  // The overall + the down Redis both surface their status labels.
  expect(screen.getAllByText('Degraded').length).toBeGreaterThan(0);
  expect(screen.getByText('Down')).toBeInTheDocument();
  // Version + gateway connection count render.
  expect(screen.getByText('0.1.0')).toBeInTheDocument();
  expect(screen.getByText('3 connected')).toBeInTheDocument();
});

test('renders the failover panel: the chain, currently-serving provider and a switch', async () => {
  vi.mocked(api.getAdminHealth).mockResolvedValue(health);
  renderPage();

  await waitFor(() => expect(screen.getByText('Provider failover')).toBeInTheDocument());
  // The chain and the currently-serving (failed-over) provider.
  expect(screen.getByText('yahoo → stooq')).toBeInTheDocument();
  expect(screen.getByText('Failover active')).toBeInTheDocument();
  // Per-provider attribution + the recent-switches section.
  expect(screen.getByText('10 served')).toBeInTheDocument();
  expect(screen.getByText('3 served')).toBeInTheDocument();
  expect(screen.getByText('Recent switches')).toBeInTheDocument();
});

test('shows an error state when the health fetch fails', async () => {
  vi.mocked(api.getAdminHealth).mockRejectedValue(new Error('boom'));
  renderPage();

  await waitFor(() =>
    expect(screen.getByText("Couldn't load the health status.")).toBeInTheDocument(),
  );
});

test('keeps stale health visible and announces reload progress while a refresh is pending', async () => {
  const successfulReload = deferred<AdminHealthResponse>();
  const failedReload = deferred<AdminHealthResponse>();
  vi.mocked(api.getAdminHealth)
    .mockResolvedValueOnce(health)
    .mockReturnValueOnce(successfulReload.promise)
    .mockReturnValueOnce(failedReload.promise);
  renderPage();

  await waitFor(() => expect(screen.getByText('Database')).toBeInTheDocument());

  const callsBeforeReload = vi.mocked(api.getAdminHealth).mock.calls.length;
  const refresh = screen.getByRole('button', { name: 'Refresh' });
  fireEvent.click(refresh);

  await waitFor(() => expect(refresh).toBeDisabled());
  expect(api.getAdminHealth).toHaveBeenCalledTimes(callsBeforeReload + 1);
  expect(screen.getByText('Database')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'System health' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  const progress = screen.getByRole('status', { name: 'Loading…' });
  expect(progress).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'System health' })).not.toContainElement(progress);

  fireEvent.click(refresh);
  expect(api.getAdminHealth).toHaveBeenCalledTimes(callsBeforeReload + 1);

  successfulReload.resolve(health);
  await waitFor(() => expect(refresh).toBeEnabled());
  expect(screen.getByRole('region', { name: 'System health' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(screen.queryByRole('status', { name: 'Loading…' })).not.toBeInTheDocument();

  fireEvent.click(refresh);
  await waitFor(() => expect(refresh).toBeDisabled());
  failedReload.reject(new Error('boom'));

  await waitFor(() =>
    expect(screen.getByText("Couldn't load the health status.")).toBeInTheDocument(),
  );
  expect(refresh).toBeEnabled();
  expect(screen.getByRole('region', { name: 'System health' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
});
