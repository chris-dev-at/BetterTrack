import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse, UsageAnalyticsResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { UsageAnalyticsPage } from './UsageAnalyticsPage';

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

const usage: UsageAnalyticsResponse = {
  activeUsers: { daily: 3, weekly: 8, monthly: 20 },
  features: [
    { feature: 'assets', events: 42 },
    { feature: 'portfolio', events: 17 },
  ],
  topAssets: [{ assetId: 'AAPL', views: 9 }],
  funnel: [
    { stage: 'registered', count: 25 },
    { stage: 'activated', count: 20 },
    { stage: 'weeklyActive', count: 8 },
    { stage: 'dailyActive', count: 3 },
  ],
  series: [{ day: '2026-07-17', events: 30, activeUsers: 5 }],
  windowDays: 30,
  todayRollupStale: false,
  generatedAt: '2026-07-18T00:00:00.000Z',
};

function renderPage() {
  return render(
    <AuthProvider>
      {/* W4 folded Operations: the page renders the workspace tab strip, which
          needs a router. */}
      <MemoryRouter initialEntries={['/admin/usage-analytics']}>
        <UsageAnalyticsPage />
      </MemoryRouter>
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
  vi.mocked(api.getUsageAnalytics).mockResolvedValue(usage);
});

test('renders DAU/WAU/MAU, feature counters, top assets and the funnel', async () => {
  renderPage();

  await waitFor(() => expect(screen.getByText('Daily active users')).toBeInTheDocument());
  expect(screen.getByText('Weekly active users')).toBeInTheDocument();
  expect(screen.getByText('Monthly active users')).toBeInTheDocument();
  // DAU value (3) also appears as the dailyActive funnel count → at least one.
  expect(screen.getAllByText('3').length).toBeGreaterThan(0);
  expect(screen.getByText('42')).toBeInTheDocument();
  // Localized feature label (not the raw key).
  expect(screen.getByText('Assets')).toBeInTheDocument();
  expect(screen.getByText('AAPL')).toBeInTheDocument();
  expect(screen.getByText('9 views')).toBeInTheDocument();
  // Funnel stage labels are localized.
  expect(screen.getByText('Registered')).toBeInTheDocument();
  expect(screen.getByText('Activated')).toBeInTheDocument();
});

test('shows an error state when the fetch fails', async () => {
  vi.mocked(api.getUsageAnalytics).mockRejectedValue(new Error('boom'));
  renderPage();

  await waitFor(() =>
    expect(screen.getByText('Could not load usage analytics.')).toBeInTheDocument(),
  );
});

const TODAY_STALE_TOOLTIP =
  "Today's numbers may be behind — the last refresh failed; the next scheduled rollup will catch up.";

test('marks the Features and Activity panels stale when todayRollupStale is true (#1906)', async () => {
  vi.mocked(api.getUsageAnalytics).mockResolvedValue({ ...usage, todayRollupStale: true });
  renderPage();

  // Features and Activity are both served from the rollup that can go stale;
  // DAU/WAU/MAU and top assets read raw events directly and stay unmarked.
  await waitFor(() => expect(screen.getAllByText('Stale')).toHaveLength(2));

  const wrappers = screen.getAllByTitle(TODAY_STALE_TOOLTIP);
  expect(wrappers).toHaveLength(2);

  // The tooltip must reach screen-reader/keyboard users too, not just a mouse
  // hover on a non-focusable span — assert the aria-describedby actually
  // resolves to an element carrying the same text, not just that one exists.
  for (const wrapper of wrappers) {
    const describedById = wrapper.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    // Resolving an aria-describedby reference has no testing-library query of
    // its own — a plain DOM lookup is the correct tool here.
    const description = document.getElementById(describedById as string);
    expect(description).toHaveTextContent(TODAY_STALE_TOOLTIP);
  }
});

test('shows no stale marker when todayRollupStale is false (#1906)', async () => {
  renderPage();

  await waitFor(() => expect(screen.getByText('Activity')).toBeInTheDocument());
  expect(screen.queryByText('Stale')).not.toBeInTheDocument();
  expect(screen.queryByTitle(TODAY_STALE_TOOLTIP)).not.toBeInTheDocument();
});
