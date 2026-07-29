import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  PortfolioResponse,
  PortfolioSummary,
  PortfolioHistoryResponse,
} from '@bettertrack/contracts';

// The board mounts every registered widget module, so each data module it can
// reach is mocked here. Automock keeps the mock in step with the real export
// list — a new export never silently becomes `undefined`.
vi.mock('../../lib/portfolioApi');
vi.mock('../../lib/notificationsApi');
vi.mock('../../lib/standingOrdersApi');
vi.mock('../../lib/marketIntelApi');
vi.mock('../../lib/expensesApi');
vi.mock('../AuthContext', () => ({ useAuth: () => ({ user: { username: 'jane' } }) }));

import { I18nProvider } from '../../i18n';
import { getExpenseTrends } from '../../lib/expensesApi';
import { getNewsDigest } from '../../lib/marketIntelApi';
import { listNotifications } from '../../lib/notificationsApi';
import { getPortfolio, getPortfolioHistory, listPortfolios } from '../../lib/portfolioApi';
import { listStandingOrders } from '../../lib/standingOrdersApi';
import { DEFAULT_LAYOUT, HOME_CONFIG_STORAGE_KEY, type HomeConfig } from './config';
import { HomePage } from './HomePage';

/**
 * The Home widget board end-to-end: the default board renders every widget it
 * declares, and the builder's four operations (reorder, remove, add, scope)
 * survive a remount because they were persisted.
 */

const MAIN: PortfolioSummary = {
  id: 'p-main',
  name: 'Main',
  visibility: 'private',
  sortOrder: 0,
  isDefault: true,
  defaultPayFromCash: false,
  archivedAt: null,
};

const SAVINGS: PortfolioSummary = { ...MAIN, id: 'p-savings', name: 'Savings', isDefault: false };

/**
 * A portfolio summary whose five figures are all distinct, so an assertion on
 * the headline can never accidentally match the invested or cash substat.
 */
function summary(marketValueEur: number, cashEur: number, dayChangeEur: number): PortfolioResponse {
  return {
    baseCurrency: 'EUR',
    holdings: [],
    totals: {
      marketValueEur,
      investedEur: marketValueEur - 500,
      unrealizedPnlEur: 500,
      unrealizedPnlPct: 5,
      dayChangeEur,
      dayChangePct: 1,
      cashEur,
      totalValueEur: marketValueEur + cashEur,
    },
  };
}

const HISTORY: PortfolioHistoryResponse = {
  baseCurrency: 'EUR',
  range: '1M',
  points: [
    { date: '2026-07-01', valueEur: 100 },
    { date: '2026-07-02', valueEur: 140 },
  ],
  performance: [],
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, SAVINGS] });
  vi.mocked(getPortfolio).mockImplementation(async (id: string) =>
    id === MAIN.id ? summary(9_000, 1_000, 250) : summary(3_500, 500, -50),
  );
  vi.mocked(getPortfolioHistory).mockResolvedValue(HISTORY);
  vi.mocked(listNotifications).mockResolvedValue({ items: [], unreadCount: 0, nextCursor: null });
  vi.mocked(listStandingOrders).mockResolvedValue({ orders: [] });
  vi.mocked(getNewsDigest).mockResolvedValue({ available: true, groups: [] });
  vi.mocked(getExpenseTrends).mockResolvedValue({ points: [] });
});

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

/** Widget frames are landmark regions, so this reads the board in visual order. */
function boardOrder(): string[] {
  return screen
    .getAllByRole('region')
    .map((region) => region.getAttribute('aria-label') ?? '')
    .filter((label) => label !== '');
}

function persisted(): HomeConfig {
  const raw = localStorage.getItem(HOME_CONFIG_STORAGE_KEY);
  expect(raw, 'expected the board to have been persisted').not.toBeNull();
  return JSON.parse(raw!) as HomeConfig;
}

const editMode = () => userEvent.setup();

// ─── The default board ────────────────────────────────────────────────────────

test('with nothing stored, the default board renders every widget it declares', async () => {
  renderHome();

  expect(await screen.findByRole('heading', { name: /Welcome back, jane/ })).toBeInTheDocument();
  // One region per DEFAULT_LAYOUT entry, in the order the layout declares —
  // so a widget added to the default board without a module would show up here.
  expect(boardOrder()).toEqual([
    'Net worth',
    'Portfolios',
    'Needs attention',
    'Upcoming',
    'Jump in',
  ]);
  expect(boardOrder()).toHaveLength(DEFAULT_LAYOUT.widgets.length);
  // Nothing was written: an untouched board must not create a storage entry.
  expect(localStorage.getItem(HOME_CONFIG_STORAGE_KEY)).toBeNull();
});

test('the hero rolls every portfolio up and tags the change as money | percent', async () => {
  renderHome();

  const hero = await screen.findByRole('region', { name: 'Net worth' });
  // 10 000 + 4 000, and +250 − 50 = +200 on a 13 800 € previous value.
  expect(await within(hero).findByText('14,000.00 €')).toBeInTheDocument();
  expect(within(hero).getByText('+200.00 €')).toBeInTheDocument();
  expect(within(hero).getByText('+1.45%')).toBeInTheDocument();
});

test('the portfolio cards widget lists every portfolio and links to it', async () => {
  renderHome();

  const cards = await screen.findByRole('region', { name: 'Portfolios' });
  const main = await within(cards).findByRole('link', { name: /Main/ });
  expect(main).toHaveAttribute('href', '/portfolio?portfolio=p-main');
  expect(within(cards).getByRole('link', { name: /Savings/ })).toHaveAttribute(
    'href',
    '/portfolio?portfolio=p-savings',
  );
});

test('a stored board with an unknown widget type still renders the widgets it knows', async () => {
  localStorage.setItem(
    HOME_CONFIG_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      widgets: [
        { id: 'x', type: 'holo-deck', size: 'l', settings: {} },
        { id: 'y', type: 'news', size: 'm', settings: {} },
      ],
    }),
  );

  renderHome();

  expect(await screen.findByRole('region', { name: 'News' })).toBeInTheDocument();
  expect(boardOrder()).toEqual(['News']);
});

// ─── The builder ──────────────────────────────────────────────────────────────

test('edit mode is off until Customize is pressed, and the chrome goes away again', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });

  expect(screen.queryByRole('button', { name: 'Remove Net worth' })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  expect(screen.getByRole('button', { name: 'Remove Net worth' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('button', { name: 'Remove Net worth' })).not.toBeInTheDocument();
});

test('the keyboard reorder buttons move a widget and persist the new order', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Move Net worth down' }));

  expect(boardOrder()).toEqual([
    'Portfolios',
    'Net worth',
    'Needs attention',
    'Upcoming',
    'Jump in',
  ]);
  expect(persisted().widgets.map((widget) => widget.type)).toEqual([
    'portfolio-cards',
    'net-worth',
    'attention',
    'upcoming',
    'shortcuts',
  ]);
});

test('the first widget cannot move up and the last cannot move down', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await user.click(screen.getByRole('button', { name: 'Customize' }));

  expect(screen.getByRole('button', { name: 'Move Net worth up' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move Jump in down' })).toBeDisabled();
});

test('removing a widget takes it off the board and out of storage', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Remove Upcoming' }));

  expect(screen.queryByRole('region', { name: 'Upcoming' })).not.toBeInTheDocument();
  expect(persisted().widgets.map((widget) => widget.type)).not.toContain('upcoming');
});

test('a reordered board survives a remount — exiting edit mode persisted it', async () => {
  const user = editMode();
  const first = renderHome();
  await screen.findByRole('region', { name: 'Net worth' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Remove Needs attention' }));
  await user.click(screen.getByRole('button', { name: 'Move Net worth down' }));
  await user.click(screen.getByRole('button', { name: 'Done' }));
  first.unmount();

  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  expect(boardOrder()).toEqual(['Portfolios', 'Net worth', 'Upcoming', 'Jump in']);
});

test('resizing a widget persists the new span', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  const sizes = screen.getByRole('group', { name: 'Net worth size' });
  await user.click(within(sizes).getByRole('button', { name: 'M' }));

  expect(screen.getByRole('region', { name: 'Net worth' })).toHaveAttribute('data-size', 'm');
  expect(persisted().widgets[0]?.size).toBe('m');
});

test('the add-widget drawer groups the catalog and appends what is chosen', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Add widget' }));

  const drawer = screen.getByRole('complementary', { name: 'Add a widget' });
  expect(within(drawer).getByText('Charts')).toBeInTheDocument();
  expect(within(drawer).getByText('Headlines on the assets you hold')).toBeInTheDocument();

  await user.click(within(drawer).getByRole('button', { name: /News/ }));

  expect(boardOrder().at(-1)).toBe('News');
  expect(persisted().widgets.at(-1)?.type).toBe('news');
});

test('reset to default restores the shipped board', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Remove Upcoming' }));
  await user.click(screen.getByRole('button', { name: 'Remove Jump in' }));
  await user.click(screen.getByRole('button', { name: 'Reset to default' }));

  expect(boardOrder()).toEqual([
    'Net worth',
    'Portfolios',
    'Needs attention',
    'Upcoming',
    'Jump in',
  ]);
  expect(persisted()).toEqual(DEFAULT_LAYOUT);
});

test('emptying the board shows its designed empty state, not the defaults again', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await user.click(screen.getByRole('button', { name: 'Customize' }));

  for (const title of ['Net worth', 'Portfolios', 'Needs attention', 'Upcoming', 'Jump in']) {
    await user.click(screen.getByRole('button', { name: `Remove ${title}` }));
  }

  expect(screen.getByText('Your home is empty')).toBeInTheDocument();
  expect(persisted().widgets).toEqual([]);
});

// ─── Scope ────────────────────────────────────────────────────────────────────

test('scoping a widget to one portfolio persists it, tags it, and narrows its data', async () => {
  const user = editMode();
  renderHome();
  const hero = await screen.findByRole('region', { name: 'Net worth' });
  expect(await within(hero).findByText('14,000.00 €')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Net worth settings' }));
  await user.selectOptions(screen.getByLabelText('Portfolio'), 'p-savings');
  // Escape dismisses the popover, so its <option> list stops shadowing the tag.
  await user.keyboard('{Escape}');
  expect(screen.queryByLabelText('Portfolio')).not.toBeInTheDocument();

  // The frame now names the scope, and the hero shows only that portfolio.
  expect(within(hero).getByText('Savings')).toBeInTheDocument();
  expect(await within(hero).findByText('4,000.00 €')).toBeInTheDocument();
  expect(persisted().widgets[0]?.settings.scope).toBe('p-savings');
});

test('a scope naming a portfolio that no longer exists degrades to all portfolios', async () => {
  localStorage.setItem(
    HOME_CONFIG_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      widgets: [{ id: 'a', type: 'net-worth', size: 'l', settings: { scope: 'p-deleted' } }],
    }),
  );

  renderHome();

  const hero = await screen.findByRole('region', { name: 'Net worth' });
  expect(await within(hero).findByText('14,000.00 €')).toBeInTheDocument();
  // Reading never rewrites, so the setting survives: restoring the portfolio
  // (un-archiving it) brings the scope back without the user re-picking it.
  expect(persisted().widgets[0]?.settings.scope).toBe('p-deleted');
});

test('an unscoped widget offers no scope picker', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await user.click(screen.getByRole('button', { name: 'Customize' }));

  // "Portfolios" is the all-portfolios overview — scoping it would be meaningless.
  expect(screen.queryByRole('button', { name: 'Portfolios settings' })).not.toBeInTheDocument();
});
