import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminHealthResponse,
  AdminOpsProvidersResponse,
  MeResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider } from '../../i18n';
import { AuthProvider } from '../AuthContext';
import { ProvidersPage } from './ProvidersPage';

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
  checkedAt: '2026-09-01T02:00:00.000Z',
  components: {
    database: { status: 'ok', latencyMs: 2 },
    redis: { status: 'ok', latencyMs: 1 },
    providers: {
      status: 'degraded',
      breakers: [{ providerId: 'yahoo', state: 'open' }],
      chains: [],
      switches: [],
      attribution: [],
    },
    queues: {
      status: 'ok',
      available: true,
      depths: [],
      heartbeat: { status: 'ok', ageSeconds: 4 },
    },
    gateway: { status: 'ok', enabled: true, attached: true, connections: 0 },
  },
};

/**
 * The shape the whole page exists for: ONE capability open, its sibling closed.
 * `/admin/health` reports this provider as simply "open", which is the summary
 * this page is here to break apart (§13.5 V5-P1c / #1552).
 */
const providers: AdminOpsProvidersResponse = {
  checkedAt: '2026-09-01T02:00:00.000Z',
  sampledSince: '2026-09-01T00:00:00.000Z',
  providers: [
    {
      providerId: 'yahoo',
      state: 'open',
      capabilities: [
        {
          capability: 'history',
          state: 'open',
          consecutiveFailures: 5,
          failureThreshold: 5,
          openedAt: '2026-09-01T01:59:00.000Z',
          retryAt: '2026-09-01T02:29:00.000Z',
          lastError: 'RateLimitError',
          lastErrorAt: '2026-09-01T01:59:00.000Z',
        },
        {
          capability: 'quote',
          state: 'closed',
          consecutiveFailures: 0,
          failureThreshold: 5,
          openedAt: null,
          retryAt: null,
          lastError: null,
          lastErrorAt: null,
        },
      ],
      calls: { success: 1412, error: 5, circuitOpen: 22 },
    },
    {
      providerId: 'stooq',
      state: 'closed',
      capabilities: [],
      calls: { success: 0, error: 0, circuitOpen: 0 },
    },
  ],
  cache: {
    hit: 864,
    miss: 65,
    stale: 71,
    negative: 0,
    total: 1000,
    hitRate: 0.864,
    staleRate: 0.071,
  },
};

function renderPage(locale: 'en' | 'de' = 'en', entry = '/admin/providers') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <MemoryRouter initialEntries={[entry]}>
          <ProvidersPage />
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
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
  vi.mocked(api.getAdminHealth).mockResolvedValue(health);
  vi.mocked(api.getOpsProviders).mockResolvedValue(providers);
});

test('separates an open capability from its healthy sibling on the same provider', async () => {
  renderPage();

  const table = await screen.findByRole('table');
  const historyRow = within(table).getByText('history').closest('tr')!;
  const quoteRow = within(table).getByText('quote').closest('tr')!;

  // The whole point: same provider, two different breaker verdicts.
  expect(within(historyRow).getByText('Open')).toBeInTheDocument();
  expect(within(historyRow).getByText('RateLimitError')).toBeInTheDocument();
  expect(within(historyRow).getByText('5 / 5')).toBeInTheDocument();
  expect(within(quoteRow).getByText('Closed')).toBeInTheDocument();
  expect(within(quoteRow).getByText('0 / 5')).toBeInTheDocument();
});

test('shows cache hit and stale rates as percentages', async () => {
  renderPage();

  expect(await screen.findByText('86.4 %')).toBeInTheDocument();
  expect(screen.getByText('7.1 %')).toBeInTheDocument();
});

// Null, never "0 %": a cache that has answered nothing has no hit rate, and a
// zero would read as a catastrophe rather than as silence.
test('draws an em dash rather than 0 % before anything has been sampled', async () => {
  vi.mocked(api.getOpsProviders).mockResolvedValue({
    ...providers,
    providers: [],
    cache: { hit: 0, miss: 0, stale: 0, negative: 0, total: 0, hitRate: null, staleRate: null },
  });
  renderPage();

  await screen.findByText('Cache hit rate');
  expect(screen.queryByText('0.0 %')).not.toBeInTheDocument();
  expect(screen.getAllByText('—').length).toBeGreaterThan(0);
});

// "Never exercised" and "exercised and healthy" are different operational facts.
test('says a provider has no breakers rather than reporting it healthy', async () => {
  renderPage();

  await screen.findByText('yahoo');
  expect(
    screen.getByText('Nothing has called this provider yet, so it has no breakers to report.'),
  ).toBeInTheDocument();
});

test('states that the counters are process-local and that there is no quota figure', async () => {
  renderPage();

  const note = await screen.findByText(/These counters belong to the API process/);
  expect(note).toHaveTextContent('no upstream quota figure');
});

// The DECISION's kill list, asserted rather than assumed: shipping a reset later
// must be a deliberate act, not a drift.
test('offers no control that resets or closes a breaker', async () => {
  renderPage();
  await screen.findByText('yahoo');

  for (const button of screen.getAllByRole('button')) {
    expect(button.textContent ?? '').not.toMatch(/reset|close|trip|clear/i);
  }
});

test('renders the workspace tab strip so the fold costs no navigation', async () => {
  renderPage();

  const nav = await screen.findByRole('navigation', { name: 'Operations' });
  const links = within(nav).getAllByRole('link');
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/admin/health',
    '/admin/problems',
    '/admin/providers',
    '/admin/monitoring',
    '/admin/email',
    '/admin/usage-analytics',
    '/admin/market-data',
  ]);
  expect(within(nav).getByRole('link', { name: /Providers/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('localizes into German', async () => {
  renderPage('de');

  expect(await screen.findByRole('heading', { level: 1, name: 'Anbieter' })).toBeInTheDocument();
  expect(screen.getByText('Cache-Trefferquote')).toBeInTheDocument();
  // The breaker states are localized on both the provider roll-up badge and the
  // capability rows, so each label legitimately appears more than once.
  expect(screen.getAllByText('Offen').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Geschlossen').length).toBeGreaterThan(0);
  expect(screen.getByText('Fähigkeit')).toBeInTheDocument();
});

test('surfaces a failed read with a retry instead of an empty page', async () => {
  vi.mocked(api.getOpsProviders).mockRejectedValue(new Error('boom'));
  renderPage();

  await waitFor(() => {
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
});
