import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

// The shell mounts pages that fetch; auto-mock their data modules so navigation
// is instant and these tests exercise only the rail/topbar/parked shell.
vi.mock('../lib/userApi');
vi.mock('../lib/portfolioApi');
vi.mock('../lib/conglomerateApi');
vi.mock('../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  CONGLOMERATE_COMPARE_QUERY_KEY: ['workboard', 'compare'],
  listWorkboard: vi.fn(),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
  compareConglomerates: vi.fn(),
}));
vi.mock('../lib/notificationsApi', () => ({
  listNotifications: vi.fn(),
  markNotificationsRead: vi.fn(),
}));

import * as api from '../lib/userApi';
import { listNotifications } from '../lib/notificationsApi';
import { listPortfolios } from '../lib/portfolioApi';
import { listWorkboard } from '../lib/workboardApi';
import { UserApp } from './UserApp';

const member: MeResponse = {
  id: 'user-1',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** Mount the user app under a `/*` parent, exactly as App.tsx does. */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The desktop navigation rail (the mobile bottom bar shares the label). */
async function findRail(): Promise<HTMLElement> {
  const navs = await screen.findAllByRole('navigation', { name: 'Primary' });
  const rail = navs.find((nav) => nav.closest('.bt-rail'));
  expect(rail).toBeDefined();
  return rail!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getMe).mockResolvedValue(member);
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
  vi.mocked(listNotifications).mockResolvedValue({ items: [], nextCursor: null, unreadCount: 0 });
});

// ─── Suite rail (PRODUCT_BLUEPRINT §4) ────────────────────────────────────────

test('the rail shows exactly the five suite destinations', async () => {
  renderAt('/portfolio');

  const rail = await findRail();
  const labels = within(rail)
    .getAllByRole('link')
    .map((el) => el.textContent);
  // Origin redesign: Home · Portfolio · Workbench · Assets · People — the
  // suite nav never grows beyond these five; utilities live below the rule.
  expect(labels).toEqual(['Home', 'Portfolio', 'Workbench', 'Assets', 'People']);

  // Retired top-level destinations must not reappear in the suite nav.
  for (const gone of ['Forecast', 'Expenses', 'Social', 'Workboard', 'Dashboard']) {
    expect(within(rail).queryByRole('link', { name: gone })).not.toBeInTheDocument();
  }
});

test('the rail utilities expose Ask, Review and the Control Center', async () => {
  renderAt('/portfolio');

  const utilities = await screen.findByRole('navigation', { name: 'Utilities' });
  for (const label of ['Ask BetterTrack', 'Review', 'Control Center']) {
    expect(within(utilities).getByRole('link', { name: label })).toBeInTheDocument();
  }
});

test('the header exposes a live, enabled notification bell', async () => {
  renderAt('/portfolio');

  const bell = await screen.findByRole('button', { name: 'Notifications' });
  expect(bell).not.toBeDisabled();
});

test('the footer shows the passion tagline on every page', async () => {
  renderAt('/portfolio');

  expect(await screen.findByText('BetterTrack — finances under your control')).toBeInTheDocument();
});

// ─── Account menu ─────────────────────────────────────────────────────────────

test('the account menu lists profile, settings, discreet mode and Logout works', async () => {
  vi.mocked(api.logout).mockResolvedValue();
  const user = userEvent.setup();
  renderAt('/portfolio');

  await user.click(await screen.findByRole('button', { name: 'Account menu' }));

  const menu = screen.getByRole('menu');
  expect(within(menu).getByRole('menuitem', { name: 'My profile' })).toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
  expect(within(menu).getByRole('menuitemcheckbox', { name: /Discreet mode/ })).toBeInTheDocument();

  await user.click(within(menu).getByRole('menuitem', { name: 'Logout' }));
  expect(api.logout).toHaveBeenCalledOnce();
});

// ─── Destinations & redirects ─────────────────────────────────────────────────

test('`/` is the Home command center', async () => {
  renderAt('/');

  expect(await screen.findByRole('heading', { name: /Welcome back/ })).toBeInTheDocument();
  expect(screen.getByText('Net worth')).toBeInTheDocument();
});

test('the portfolio workspace shows the switcher and its local tabs', async () => {
  renderAt('/portfolio');

  expect(await screen.findByRole('button', { name: 'Switch portfolio' })).toBeInTheDocument();
  const tabs = screen.getByRole('navigation', { name: 'Portfolio workspace' });
  // Parked tabs append the "Planned" dot to their accessible name — anchor the
  // match so "Plan" does not also match every parked tab's name.
  for (const tab of ['Overview', 'Activity', 'Cash flow', 'Analysis', 'Tax', 'Plan', 'Files']) {
    expect(
      within(tabs).getByRole('link', { name: new RegExp(`^${tab}( Planned)?$`) }),
    ).toBeInTheDocument();
  }
});

test('`/social` redirects to the People destination', async () => {
  renderAt('/social');
  expect(await screen.findByRole('heading', { name: 'Friends' })).toBeInTheDocument();
});

test('`/workboard` redirects to the Workbench', async () => {
  renderAt('/workboard');
  const tabs = await screen.findByRole('navigation', { name: 'Workbench' });
  for (const tab of ['Overview', 'Studio', 'Forecasts', 'Blueprints', 'Backtests', 'Alerts']) {
    expect(within(tabs).getByRole('link', { name: new RegExp(tab) })).toBeInTheDocument();
  }
});

test('`/settings` redirects to `/settings/account`', async () => {
  renderAt('/settings');
  expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
});

test('the Assets destination renders its local tabs', async () => {
  renderAt('/assets/search');
  const tabs = await screen.findByRole('navigation', { name: 'Assets' });
  for (const tab of ['Overview', 'Search', 'Watchlists', 'News', 'Discover', 'Screener']) {
    expect(within(tabs).getByRole('link', { name: new RegExp(tab) })).toBeInTheDocument();
  }
});

// ─── Parked destinations resolve to designed surfaces (no 404) ────────────────

test.each([
  ['/portfolio/plan', 'Plan'],
  ['/portfolio/automate', 'Automate'],
  ['/portfolio/files', 'Files'],
  ['/portfolio/settings', 'Portfolio settings'],
  ['/portfolio/health', 'Data health'],
  ['/portfolio/private-markets', 'Private markets'],
  ['/portfolio/rebalance', 'Rebalance'],
  ['/workbench/studio', 'Studio'],
  ['/assets/screener', 'Screener'],
  ['/assets/events', 'Events'],
  ['/people/teams', 'Teams'],
  ['/people/approvals', 'Approvals'],
  ['/control/data', 'Data management'],
  ['/control/privacy', 'Paranoid mode'],
  ['/developer/mcp', 'MCP'],
  ['/developer/logs', 'Request logs'],
  ['/review', 'Review inbox'],
])('parked destination %s renders its designed surface', async (path, title) => {
  renderAt(path);
  const heading = await screen.findByRole('heading', { name: title });
  expect(heading).toBeInTheDocument();
  // Every parked surface carries the "In the works" flag.
  expect(within(heading.closest('section')!).getByText('In the works')).toBeInTheDocument();
});

test('legacy category stubs fold into the parked Discover surface', async () => {
  renderAt('/assets/stocks');
  expect(await screen.findByRole('heading', { name: 'Discover' })).toBeInTheDocument();
  expect(screen.getByText('In the works')).toBeInTheDocument();
});
