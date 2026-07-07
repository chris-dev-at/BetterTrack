import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

// The shell mounts pages that fetch; auto-mock their data modules so navigation
// is instant and these tests exercise only the nav/subnav/placeholder shell.
vi.mock('../lib/userApi');
vi.mock('../lib/portfolioApi');
vi.mock('../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  listWorkboard: vi.fn(),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
}));
vi.mock('../lib/notificationsApi', () => ({
  listNotifications: vi.fn(),
  markNotificationsRead: vi.fn(),
}));

import * as api from '../lib/userApi';
import { listNotifications } from '../lib/notificationsApi';
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getMe).mockResolvedValue(member);
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
  vi.mocked(listNotifications).mockResolvedValue({ items: [], nextCursor: null, unreadCount: 0 });
});

// ─── Top nav ──────────────────────────────────────────────────────────────────

test('the primary nav shows exactly the four section tabs — no sixth item', async () => {
  renderAt('/portfolio');

  const nav = await screen.findByRole('navigation', { name: 'Primary' });
  const labels = within(nav)
    .getAllByRole('link')
    .map((el) => el.textContent);
  expect(labels).toEqual(['Portfolio', 'Workboard', 'Assets', 'Social']);

  // The V1 shell tabs that were removed must not reappear in the primary nav.
  for (const gone of ['Dashboard', 'Search', 'Conglomerates', 'Settings']) {
    expect(within(nav).queryByRole('link', { name: gone })).not.toBeInTheDocument();
  }

  // The profile menu (the fifth "area") is a button, not a nav tab.
  expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
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

// ─── Profile dropdown (§6.11) ─────────────────────────────────────────────────

test('the profile dropdown lists the §6.11 items and Logout works', async () => {
  vi.mocked(api.logout).mockResolvedValue();
  const user = userEvent.setup();
  renderAt('/portfolio');

  await user.click(await screen.findByRole('button', { name: 'Account menu' }));

  const menu = screen.getByRole('menu');
  expect(within(menu).getByRole('menuitem', { name: 'My Portfolio' })).toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: /Invite Others/ })).toBeDisabled();
  expect(within(menu).getByRole('menuitem', { name: /Share Profile/ })).toBeDisabled();

  await user.click(within(menu).getByRole('menuitem', { name: 'Logout' }));
  expect(api.logout).toHaveBeenCalledOnce();
});

// ─── Redirects (§7.2) ─────────────────────────────────────────────────────────

test('`/` redirects to `/portfolio` and shows the portfolio switcher', async () => {
  renderAt('/');

  // Portfolio section chrome: the multi-portfolio switcher + section subnav.
  expect(await screen.findByRole('button', { name: 'Switch portfolio' })).toBeInTheDocument();
  const sectionNav = screen.getByRole('navigation', { name: 'Section' });
  expect(within(sectionNav).getByRole('link', { name: 'Transactions' })).toBeInTheDocument();
});

test('`/social` redirects to `/social/friends`', async () => {
  renderAt('/social');
  expect(await screen.findByRole('heading', { name: 'Friends' })).toBeInTheDocument();
});

test('`/settings` redirects to `/settings/account`', async () => {
  renderAt('/settings');
  expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
});

// ─── Per-section subnavs (§6.3/§6.4/§6.9/§6.11) ───────────────────────────────

test('the Workboard section renders its subnav', async () => {
  renderAt('/workboard/comparisons');
  const sectionNav = await screen.findByRole('navigation', { name: 'Section' });
  for (const tab of ['Overview', 'Conglomerates', 'Watchlists', 'Comparisons', 'Saved Ideas']) {
    expect(within(sectionNav).getByRole('link', { name: new RegExp(tab) })).toBeInTheDocument();
  }
});

test('the Assets section renders its subnav', async () => {
  renderAt('/assets/stocks');
  const sectionNav = await screen.findByRole('navigation', { name: 'Section' });
  for (const tab of ['Overview', 'Search', 'Stocks', 'ETFs', 'Crypto', 'Commodities']) {
    expect(within(sectionNav).getByRole('link', { name: new RegExp(tab) })).toBeInTheDocument();
  }
});

// ─── Coming-Soon deep links resolve without a 404 (§7.2) ──────────────────────

test.each([
  ['/workboard/comparisons', 'Comparisons'],
  ['/workboard/ideas', 'Saved Ideas'],
  ['/assets/stocks', 'Stocks'],
  ['/assets/etfs', 'ETFs'],
  ['/assets/crypto', 'Crypto'],
  ['/assets/commodities', 'Commodities'],
  ['/assets/custom', 'Custom Assets'],
  ['/social/ideas', 'Ideas'],
  ['/social/profile', 'My Public Profile'],
  ['/settings/imports', 'Imports & Exports'],
  ['/settings/connections', 'Connections'],
  ['/settings/backups', 'Backups'],
  // /settings/api is now a built page (API Access, V2-P12), no longer Coming Soon.
])('deep link %s resolves to a designed Coming Soon page', async (path, title) => {
  renderAt(path);
  const heading = await screen.findByRole('heading', { name: title });
  expect(heading).toBeInTheDocument();
  // The Coming-Soon badge sits in the same section as the heading.
  expect(within(heading.closest('section')!).getByText(/coming soon/i)).toBeInTheDocument();
});
