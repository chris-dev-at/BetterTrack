import { render, screen, waitFor } from '@testing-library/react';
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
  vi.mocked(api.getAdminHealth).mockResolvedValue(health);
  renderPage();

  await waitFor(() => expect(screen.getByText('Database')).toBeInTheDocument());
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
