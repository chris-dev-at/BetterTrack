import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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

/** Mirrors the live URL (path + search) so redirect tests can assert on it. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

/** The desktop navigation rail (the mobile bottom bar shares the label). */
async function findRail(): Promise<HTMLElement> {
  const navs = await screen.findAllByRole('navigation', { name: 'Primary' });
  const rail = navs.find((nav) => nav.closest('.bt-rail'));
  expect(rail).toBeDefined();
  return rail!;
}

/**
 * The rail's top-level destination rows. Section groups render their children
 * inside the same nav — CSS hides a closed tree, but jsdom applies no CSS, so
 * the sub-rows are filtered out here by their container.
 */
function suiteRows(rail: HTMLElement): HTMLElement[] {
  return within(rail)
    .getAllByRole('link')
    .filter((link) => link.closest('.bt-rail-group__children') === null);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(api.getMe).mockResolvedValue(member);
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
  vi.mocked(listNotifications).mockResolvedValue({ items: [], nextCursor: null, unreadCount: 0 });
});

test('the user shell starts with a hidden skip link that focuses main content', async () => {
  const user = userEvent.setup();
  const { container } = renderAt('/portfolio');

  const skipLink = await screen.findByRole('link', { name: 'Skip to main content' });
  const main = screen.getByRole('main');
  const firstFocusable = container.querySelector<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
  );

  expect(skipLink).toHaveAttribute('href', '#main-content');
  expect(skipLink).toHaveClass('sr-only');
  expect(main).toHaveAttribute('id', 'main-content');
  expect(firstFocusable).toBe(skipLink);

  await user.click(skipLink);
  expect(main).toHaveFocus();
});

// ─── Suite rail (PRODUCT_BLUEPRINT §4) ────────────────────────────────────────

test('the rail shows exactly the five suite destinations', async () => {
  renderAt('/portfolio');

  const rail = await findRail();
  const labels = suiteRows(rail).map((el) => el.textContent);
  // Origin redesign: Home · Portfolio · Workbench · Assets · People — the
  // suite nav never grows beyond these five; utilities live below the rule.
  expect(labels).toEqual(['Home', 'Portfolio', 'Workbench', 'Assets', 'People']);

  // Retired top-level destinations must not reappear in the suite nav.
  for (const gone of ['Forecast', 'Expenses', 'Social', 'Workboard', 'Dashboard']) {
    expect(within(rail).queryByRole('link', { name: gone })).not.toBeInTheDocument();
  }
});

// ─── R2 rail: expandable section groups ───────────────────────────────────────

test('the rail groups carry their section tabs as children', async () => {
  renderAt('/assets');

  const rail = await findRail();
  const children = within(rail)
    .getAllByRole('link')
    .filter((link) => link.closest('#bt-rail-group-assets') !== null)
    .map((el) => el.textContent);
  // The curated `rail: true` subset of `components/sectionNav.ts` — the vital
  // pages only; parked and secondary tabs live in the in-page strip.
  expect(children).toEqual(['Overview', 'Search', 'Watchlists', 'News']);
  // Home and the utilities stay plain rows — no chevron, no tree.
  expect(
    screen.queryByRole('button', { name: /^(Expand|Collapse) Home$/ }),
  ).not.toBeInTheDocument();
});

test('the rail tree is the vital subset of the full in-page strip', async () => {
  renderAt('/portfolio');

  const rail = await findRail();
  const railChildren = within(rail)
    .getAllByRole('link')
    .filter((link) => link.closest('#bt-rail-group-portfolio') !== null)
    .map((el) => el.textContent);
  const strip = screen.getByRole('navigation', { name: 'Portfolio workspace' });
  const stripChildren = within(strip)
    .getAllByRole('link')
    .map((el) => el.textContent);

  // The rail curates; the strip carries everything. Same source table, so the
  // subset relation is structural, not a coincidence.
  expect(railChildren).toEqual(['Overview', 'Activity', 'Cash flow', 'Settings']);
  for (const child of railChildren) expect(stripChildren).toContain(child);
  // Custom assets moved to the Assets section (they are user-scoped), so the
  // portfolio strip carries the portfolio-only extras.
  expect(stripChildren).toEqual(expect.arrayContaining(['Analysis', 'Tax']));
  expect(stripChildren).not.toContain('Custom assets');
});

test('trees start closed; clicking the selected section row toggles its tree', async () => {
  const user = userEvent.setup();
  renderAt('/workbench/alerts');

  // Navigation never auto-opens a dropdown — not even the active section's.
  const rail = await findRail();
  for (const section of ['Portfolio', 'Workbench', 'Assets', 'People']) {
    expect(screen.getByRole('button', { name: `Expand ${section}` })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  }

  // Workbench is the selected item — clicking it toggles the dropdown open…
  await user.click(within(rail).getByRole('link', { name: 'Workbench' }));
  expect(screen.getByRole('button', { name: 'Collapse Workbench' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  // …and does NOT navigate away from the child page you were on.
  expect(within(rail).getByRole('link', { name: 'Alerts' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('the chevron toggles without navigating; leaving the section closes the tree', async () => {
  const user = userEvent.setup();
  renderAt('/assets/search');

  const expand = await screen.findByRole('button', { name: 'Expand Assets' });
  await user.click(expand);

  // Toggling is navigation-free: the Assets page is still mounted.
  expect(screen.getByRole('button', { name: 'Collapse Assets' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  expect(screen.getByRole('searchbox', { name: 'Search assets' })).toBeInTheDocument();

  // Navigating OUT of the section (Home) closes the open tree again.
  await user.click(within(await findRail()).getByRole('link', { name: 'Home' }));
  for (const section of ['Portfolio', 'Workbench', 'Assets', 'People']) {
    expect(screen.getByRole('button', { name: `Expand ${section}` })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  }
});

test('a freshly selected section starts closed; re-clicks toggle open and shut', async () => {
  const user = userEvent.setup();
  renderAt('/portfolio');

  const rail = await findRail();

  // From Portfolio, selecting Workbench navigates — freshly selected = closed.
  await user.click(within(rail).getByRole('link', { name: 'Workbench' }));
  expect(screen.getByRole('button', { name: 'Expand Workbench' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // Clicking the now-selected item again toggles it open, then shut.
  const row = within(rail).getByRole('link', { name: 'Workbench' });
  await user.click(row);
  expect(screen.getByRole('button', { name: 'Collapse Workbench' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await user.click(row);
  expect(screen.getByRole('button', { name: 'Expand Workbench' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

test('expanded-ness rides along between sections, in both directions', async () => {
  const user = userEvent.setup();
  renderAt('/');

  const rail = await findRail();

  // Home → Portfolio: nothing was expanded, so Portfolio arrives closed.
  await user.click(within(rail).getByRole('link', { name: 'Portfolio' }));
  expect(screen.getByRole('button', { name: 'Expand Portfolio' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // Expand it, then move to Assets: Assets arrives EXPANDED.
  await user.click(screen.getByRole('button', { name: 'Expand Portfolio' }));
  await user.click(within(rail).getByRole('link', { name: 'Assets' }));
  expect(screen.getByRole('button', { name: 'Collapse Assets' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  // Only the active section's tree is open — never two at once.
  expect(screen.getByRole('button', { name: 'Expand Portfolio' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // Close it here, then move on: the next section arrives closed again.
  await user.click(screen.getByRole('button', { name: 'Collapse Assets' }));
  await user.click(within(rail).getByRole('link', { name: 'People' }));
  expect(screen.getByRole('button', { name: 'Expand People' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

test('the rail is an accordion — expanding one group closes the other', async () => {
  const user = userEvent.setup();
  renderAt('/portfolio');

  await user.click(await screen.findByRole('button', { name: 'Expand Portfolio' }));
  expect(screen.getByRole('button', { name: 'Collapse Portfolio' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );

  await user.click(screen.getByRole('button', { name: 'Expand Workbench' }));

  expect(screen.getByRole('button', { name: 'Collapse Workbench' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  expect(screen.getByRole('button', { name: 'Expand Portfolio' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

test('portfolio rail children keep the active portfolio scope', async () => {
  renderAt('/portfolio/activity?portfolio=p-7');

  const rail = await findRail();
  // `?portfolio=<id>` rides along every child of the section (#322).
  expect(within(rail).getByRole('link', { name: 'Cash flow' })).toHaveAttribute(
    'href',
    '/portfolio/cash-flow?portfolio=p-7',
  );
  expect(within(rail).getByRole('link', { name: 'Settings' })).toHaveAttribute(
    'href',
    '/portfolio/settings?portfolio=p-7',
  );

  // The open child is the current page; its group row is not also "current".
  expect(within(rail).getByRole('link', { name: 'Activity' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(within(rail).getByRole('link', { name: 'Portfolio' })).not.toHaveAttribute('aria-current');
});

test('the collapse control sits in the rail and persists the preference', async () => {
  const user = userEvent.setup();
  renderAt('/');

  const collapse = await screen.findByRole('button', { name: 'Collapse navigation' });
  expect(collapse.closest('.bt-rail')).not.toBeNull();

  await user.click(collapse);
  expect(await screen.findByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
  expect(localStorage.getItem('bt.rail')).toBe('collapsed');
});

test('the in-page strip renders in full alongside the rail tree', async () => {
  renderAt('/portfolio');

  // The strip is the complete sub-navigation at every width (owner: "still
  // keep the full nav inside the content page"); the rail curates on top.
  const strip = await screen.findByRole('navigation', { name: 'Portfolio workspace' });
  expect(strip).not.toHaveClass('bt-hide-when-rail');
  expect(within(strip).getByRole('link', { name: 'Analysis' })).toBeInTheDocument();
});

test('the rail utilities expose Ask, Review and the Control Center', async () => {
  renderAt('/portfolio');

  const utilities = await screen.findByRole('navigation', { name: 'Utilities' });
  for (const label of ['Review', 'Control Center']) {
    expect(within(utilities).getByRole('link', { name: label })).toBeInTheDocument();
  }
  // R2: Ask BetterTrack is the floating AI panel's trigger, not a destination —
  // same row, same styling, but a disclosure button rather than a link.
  expect(within(utilities).getByRole('button', { name: 'Ask BetterTrack' })).toBeInTheDocument();
});

test('the rail Ask row opens and closes the floating AI panel over the page', async () => {
  const user = userEvent.setup();
  renderAt('/portfolio');

  const utilities = await screen.findByRole('navigation', { name: 'Utilities' });
  const ask = within(utilities).getByRole('button', { name: 'Ask BetterTrack' });
  expect(ask).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('complementary', { name: 'Ask BetterTrack panel' })).toBeNull();

  await user.click(ask);

  const panel = await screen.findByRole('complementary', { name: 'Ask BetterTrack panel' });
  expect(ask).toHaveAttribute('aria-expanded', 'true');
  // Non-modal: the page under it keeps its own chrome and stays interactive.
  expect(screen.getByRole('navigation', { name: 'Utilities' })).toBeInTheDocument();
  expect(document.querySelector('.bt-scrim')).toBeNull();
  expect(panel).not.toHaveAttribute('aria-modal');

  await user.click(ask);
  await waitFor(() =>
    expect(screen.queryByRole('complementary', { name: 'Ask BetterTrack panel' })).toBeNull(),
  );
});

test('no chat or AI icon sits in the topbar (owner: the rail row is the trigger)', async () => {
  renderAt('/portfolio');

  await screen.findByRole('button', { name: 'Notifications' });
  const header = document.querySelector('.bt-topbar');
  expect(header).not.toBeNull();
  expect(within(header as HTMLElement).queryByRole('button', { name: /^Chat/ })).toBeNull();
  expect(
    within(header as HTMLElement).queryByRole('button', { name: 'Ask BetterTrack' }),
  ).toBeNull();
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

test('the live account menu supports roving focus and restores its trigger on Escape', async () => {
  const user = userEvent.setup();
  renderAt('/portfolio');

  const trigger = await screen.findByRole('button', { name: 'Account menu' });
  await user.click(trigger);
  const menu = screen.getByRole('menu', { name: 'Account' });
  const profile = within(menu).getByRole('menuitem', { name: 'My profile' });
  const settings = within(menu).getByRole('menuitem', { name: 'Settings' });
  const logoutItem = within(menu).getByRole('menuitem', { name: 'Logout' });

  await waitFor(() => expect(profile).toHaveFocus());
  await user.keyboard('{ArrowDown}');
  expect(settings).toHaveFocus();
  await user.keyboard('{ArrowUp}');
  expect(profile).toHaveFocus();
  await user.keyboard('{End}');
  expect(logoutItem).toHaveFocus();
  await user.keyboard('{Home}');
  expect(profile).toHaveFocus();
  await user.keyboard('{Escape}');

  expect(screen.queryByRole('menu', { name: 'Account' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test('the live Create menu supports roving focus and restores its trigger on Escape', async () => {
  const user = userEvent.setup();
  renderAt('/portfolio');

  const trigger = await screen.findByRole('button', { name: 'Create' });
  await user.click(trigger);
  const menu = screen.getByRole('menu', { name: 'Create' });
  const trade = within(menu).getByRole('menuitem', { name: 'Buy or sell' });
  const cashFlow = within(menu).getByRole('menuitem', { name: 'Income or expense' });
  const portfolio = within(menu).getByRole('menuitem', { name: 'New portfolio' });

  await waitFor(() => expect(trade).toHaveFocus());
  await user.keyboard('{ArrowDown}');
  expect(cashFlow).toHaveFocus();
  await user.keyboard('{ArrowUp}');
  expect(trade).toHaveFocus();
  await user.keyboard('{End}');
  expect(portfolio).toHaveFocus();
  await user.keyboard('{Home}');
  expect(trade).toHaveFocus();
  await user.keyboard('{Escape}');

  expect(screen.queryByRole('menu', { name: 'Create' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
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

// ─── Control Center overlay: the retired /settings/* shell (R2) ──────────────

/**
 * Every legacy `/settings/*` path now redirects onto its Control Center panel.
 * The nav row's `aria-current` is the assertion (not the panel's content), so
 * these stay honest about ROUTING without depending on each page's data.
 */
test.each([
  ['/settings', 'Account'],
  ['/settings/account', 'Account'],
  ['/settings/notifications', 'Notifications'],
  // Security split into Sign-in (credentials) + Sessions (devices + app lock);
  // the legacy path lands on the credentials half.
  ['/settings/security', 'Sign-in'],
  ['/settings/taxes', 'Portfolio defaults'],
  ['/settings/connections', 'Connections'],
  ['/settings/api', 'API keys'],
  // The public-profile settings moved into the Control Center (owner order);
  // both the legacy settings path and the People route land on the panel.
  ['/settings/profile', 'Public profile'],
  ['/people/profile', 'Public profile'],
])('%s opens the Control Center on the %s panel', async (path, panel) => {
  renderAt(path);

  const dialog = await screen.findByRole('dialog', { name: 'Control Center' });
  expect(within(dialog).getByRole('link', { name: panel, current: 'page' })).toBeInTheDocument();
});

test.each([['/settings/imports'], ['/settings/backups']])(
  '%s folds into the Data management page',
  async (path) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { name: 'Data management' })).toBeInTheDocument();
  },
);

test('the settings redirects carry the query string onto the panel', async () => {
  // Load-bearing: apps/api bounces the browser to
  // `/settings/connections?google=linked | ?error=google_…` after the OAuth
  // dance and ConnectionsPage reads exactly those params — a redirect that
  // dropped the search would silently swallow the callback result.
  render(
    <MemoryRouter initialEntries={['/settings/api?google=linked']}>
      <LocationProbe />
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );

  // Generous timeout: the overlay is a lazy route, and resolving its chunk
  // while the rest of this file's shell renders compete for the event loop can
  // exceed the 1s default.
  await screen.findByRole('dialog', { name: 'Control Center' }, { timeout: 5000 });
  expect(screen.getByTestId('location')).toHaveTextContent('/control/api?google=linked');
});

test('`/developer` is its own page, linked out of the Control Center', async () => {
  renderAt('/control');

  const dialog = await screen.findByRole('dialog', { name: 'Control Center' });
  expect(within(dialog).getByRole('link', { name: 'Developer overview' })).toHaveAttribute(
    'href',
    '/developer',
  );

  renderAt('/developer');
  expect(await screen.findByRole('heading', { name: 'Developer platform' })).toBeInTheDocument();
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
  // `/portfolio/settings` is a real page now (PortfolioSettingsPage), not parked.
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
