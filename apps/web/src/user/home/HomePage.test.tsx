import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  Alert,
  CashSource,
  DividendCalendarEntry,
  HistoryResponse,
  PortfolioResponse,
  PortfolioSummary,
  PortfolioHistoryResponse,
  QuoteResponse,
  Transaction,
  WatchlistSummary,
  WorkboardItem,
} from '@bettertrack/contracts';

// The board mounts every registered widget module, so each data module it can
// reach is mocked here. Automock keeps the mock in step with the real export
// list — a new export never silently becomes `undefined`.
//
// Modules exporting a **query-key constant** are the exception: automocking
// empties arrays, so `['alerts']` would arrive as `[]` and every widget keyed
// that way would collapse onto one shared cache entry and read each other's
// responses. Those spread the real module and stub only the fetchers, keeping
// the keys intact.
vi.mock('../../lib/portfolioApi');
vi.mock('../../lib/notificationsApi');
vi.mock('../../lib/standingOrdersApi');
vi.mock('../../lib/expensesApi');
vi.mock('../../lib/assetApi');
vi.mock('../../lib/marketIntelApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/marketIntelApi')>()),
  getNewsDigest: vi.fn(),
  getPortfolioDividendCalendar: vi.fn(),
}));
vi.mock('../../lib/workboardApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/workboardApi')>()),
  listWatchlists: vi.fn(),
  listWorkboard: vi.fn(),
}));
vi.mock('../../lib/alertsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/alertsApi')>()),
  listAlerts: vi.fn(),
}));
vi.mock('../AuthContext', () => ({ useAuth: () => ({ user: { username: 'jane' } }) }));

// Canvas-backed chart lib — jsdom cannot draw it (mirrors the portfolio/asset
// page tests). `setData` is captured so the summed net-worth curve can be
// asserted on the exact series the chart was handed.
const chartMocks = vi.hoisted(() => {
  const setData = vi.fn();
  const addSeries = vi.fn(() => ({ setData, applyOptions: vi.fn() }));
  return {
    setData,
    addSeries,
    createChart: vi.fn(() => ({
      addSeries,
      applyOptions: vi.fn(),
      timeScale: () => ({ fitContent: vi.fn() }),
      remove: vi.fn(),
    })),
  };
});
vi.mock('lightweight-charts', () => ({
  createChart: chartMocks.createChart,
  AreaSeries: 'AreaSeries',
  BaselineSeries: 'BaselineSeries',
  LineSeries: 'LineSeries',
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
}));

import { I18nProvider } from '../../i18n';
import { listAlerts } from '../../lib/alertsApi';
import { getAssetHistory, getAssetQuote } from '../../lib/assetApi';
import { getExpenseTrends } from '../../lib/expensesApi';
import { getNewsDigest, getPortfolioDividendCalendar } from '../../lib/marketIntelApi';
import { listNotifications } from '../../lib/notificationsApi';
import {
  getPortfolio,
  getPortfolioHistory,
  listCashSources,
  listPortfolios,
  listTransactions,
} from '../../lib/portfolioApi';
import { listStandingOrders } from '../../lib/standingOrdersApi';
import { listWatchlists, listWorkboard } from '../../lib/workboardApi';
import {
  DEFAULT_LAYOUT,
  HOME_CONFIG_STORAGE_KEY,
  WIDGET_SIZE_RULES,
  type HomeConfig,
  type WidgetSettings,
  type WidgetType,
} from './config';
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

// ─── Fixtures for the expanded catalog ───────────────────────────────────────

const APPLE = {
  id: 'as-apple',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  exchange: 'NASDAQ',
  currency: 'USD' as const,
  type: 'stock' as const,
  isCustom: false,
  category: null,
};

const BUY: Transaction = {
  id: 'txn-buy',
  assetId: APPLE.id,
  side: 'buy',
  quantity: 3,
  price: 100,
  fee: 1,
  executedAt: '2026-07-20T10:00:00.000Z',
  note: null,
  allowUncovered: false,
  uncoveredEntryPrice: null,
  source: 'manual',
  asset: APPLE,
};

/** Newer than {@link BUY}, and from the other portfolio — so order and grouping both show. */
const SELL: Transaction = {
  ...BUY,
  id: 'txn-sell',
  assetId: 'as-msft',
  side: 'sell',
  quantity: 2,
  price: 50,
  executedAt: '2026-07-21T10:00:00.000Z',
  asset: { ...APPLE, id: 'as-msft', symbol: 'MSFT', name: 'Microsoft Corp.' },
};

function cashSource(overrides: Partial<CashSource> = {}): CashSource {
  return {
    id: 'src-main',
    name: 'Main account',
    type: 'cash',
    isMain: true,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    balanceEur: 1_000,
    ...overrides,
  };
}

const DIVIDEND: DividendCalendarEntry = {
  assetId: APPLE.id,
  symbol: 'AAPL',
  name: 'Apple Inc.',
  source: 'holding',
  // The ex-date is the earlier of the two, so it is the one the row must show.
  exDate: '2026-08-05T00:00:00.000Z',
  payDate: '2026-08-19T00:00:00.000Z',
  amount: 0.24,
  currency: 'USD',
};

const CORE_LIST: WatchlistSummary = {
  id: 'wl-core',
  name: 'Core',
  isDefault: true,
  itemCount: 1,
  audience: 'private',
};

const SPEC_LIST: WatchlistSummary = {
  ...CORE_LIST,
  id: 'wl-spec',
  name: 'Speculative',
  isDefault: false,
  itemCount: 1,
};

const CORE_ITEM: WorkboardItem = {
  id: 'wbi-1',
  watchlistId: CORE_LIST.id,
  assetId: APPLE.id,
  sortOrder: 0,
  note: null,
  asset: {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    exchange: 'NASDAQ',
    currency: 'USD',
    type: 'stock',
  },
};

const SPEC_ITEM: WorkboardItem = {
  ...CORE_ITEM,
  id: 'wbi-2',
  watchlistId: SPEC_LIST.id,
  assetId: 'as-doge',
  asset: { ...CORE_ITEM.asset, symbol: 'DOGE', name: 'Dogecoin', type: 'crypto' },
};

const FIRED_ALERT: Alert = {
  id: 'al-fired',
  kind: 'price_above',
  threshold: 200,
  refPrice: null,
  repeat: false,
  status: 'triggered',
  lastTriggeredAt: '2026-07-25T08:00:00.000Z',
  asset: { id: APPLE.id, symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD', type: 'stock' },
};

const ARMED_ALERT: Alert = {
  ...FIRED_ALERT,
  id: 'al-armed',
  status: 'active',
  lastTriggeredAt: null,
};

const QUOTE: QuoteResponse = {
  quote: {
    price: 190.5,
    currency: 'USD',
    prevClose: 188.15,
    dayChangePct: 1.25,
    asOf: '2026-07-27T16:00:00.000Z',
  },
  stale: false,
  asOf: '2026-07-27T16:00:00.000Z',
};

const ASSET_HISTORY: HistoryResponse = {
  range: '1M',
  interval: '1d',
  points: [
    { time: '2026-07-01T00:00:00.000Z', close: 180 },
    { time: '2026-07-02T00:00:00.000Z', close: 190.5 },
  ],
  stale: false,
  asOf: '2026-07-27T16:00:00.000Z',
};

beforeEach(() => {
  localStorage.clear();
  // Call history, not implementations: several cases below assert *how often* an
  // endpoint was hit (cache sharing, the "asks before it fetches" guarantee), and
  // those claims are meaningless if the counts carry over from earlier tests.
  vi.clearAllMocks();
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, SAVINGS] });
  vi.mocked(getPortfolio).mockImplementation(async (id: string) =>
    id === MAIN.id ? summary(9_000, 1_000, 250) : summary(3_500, 500, -50),
  );
  vi.mocked(getPortfolioHistory).mockResolvedValue(HISTORY);
  vi.mocked(listNotifications).mockResolvedValue({ items: [], unreadCount: 0, nextCursor: null });
  vi.mocked(listStandingOrders).mockResolvedValue({ orders: [] });
  vi.mocked(getNewsDigest).mockResolvedValue({ available: true, groups: [] });
  vi.mocked(getExpenseTrends).mockResolvedValue({ points: [] });
  vi.mocked(listTransactions).mockImplementation(async (portfolioId: string) => ({
    items: portfolioId === MAIN.id ? [BUY] : [SELL],
    nextCursor: null,
  }));
  vi.mocked(listCashSources).mockImplementation(async (portfolioId: string) => ({
    sources:
      portfolioId === MAIN.id
        ? [cashSource()]
        : [cashSource({ id: 'src-savings', name: 'Savings account', balanceEur: 500 })],
  }));
  vi.mocked(getPortfolioDividendCalendar).mockResolvedValue({
    available: true,
    entries: [DIVIDEND],
  });
  vi.mocked(listWatchlists).mockResolvedValue({ watchlists: [CORE_LIST, SPEC_LIST] });
  vi.mocked(listWorkboard).mockResolvedValue({ items: [CORE_ITEM, SPEC_ITEM] });
  vi.mocked(listAlerts).mockResolvedValue({ items: [ARMED_ALERT, FIRED_ALERT] });
  vi.mocked(getAssetQuote).mockResolvedValue(QUOTE);
  vi.mocked(getAssetHistory).mockResolvedValue(ASSET_HISTORY);
});

/**
 * Put exactly the given widgets on the board, at each type's default size. Used
 * by the per-widget tests so one widget's failure cannot be masked (or caused) by
 * another sharing the board.
 */
function storeBoard(...widgets: (WidgetType | [WidgetType, WidgetSettings])[]): void {
  localStorage.setItem(
    HOME_CONFIG_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      widgets: widgets.map((entry, index) => {
        const [type, settings] = Array.isArray(entry) ? entry : [entry, {}];
        return { id: `w-${index}`, type, size: WIDGET_SIZE_RULES[type].default, settings };
      }),
    }),
  );
}

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

// ─── The expanded catalog ─────────────────────────────────────────────────────

test('the all-portfolios curve sums every portfolio on the union of their dates', async () => {
  // Deliberately misaligned series: Main has 07-01 and 07-03, Savings only 07-02.
  vi.mocked(getPortfolioHistory).mockImplementation(async (portfolioId: string) => ({
    ...HISTORY,
    range: '6M',
    points:
      portfolioId === MAIN.id
        ? [
            { date: '2026-07-01', valueEur: 100 },
            { date: '2026-07-03', valueEur: 120 },
          ]
        : [{ date: '2026-07-02', valueEur: 50 }],
  }));
  storeBoard('net-worth-history');

  renderHome();
  await screen.findByRole('region', { name: 'Net worth history' });

  const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  await vi.waitFor(() => {
    expect(chartMocks.setData).toHaveBeenCalledWith([
      // Savings does not exist yet ⇒ 0, not its future 50.
      { time: seconds('2026-07-01'), value: 100 },
      // Main carries 100 forward; Savings opens at 50.
      { time: seconds('2026-07-02'), value: 150 },
      // Main moves to 120; Savings carries 50 forward.
      { time: seconds('2026-07-03'), value: 170 },
    ]);
  });
});

test('the all-portfolios curve reuses the per-portfolio history cache entry', async () => {
  // Both widgets on one board: the shared `['portfolio', id, 'history', range]`
  // key means Main's 1M series is fetched once, not once per widget.
  storeBoard(
    ['performance-chart', { scope: MAIN.id, range: '1M' }],
    ['net-worth-history', { range: '1M' }],
  );

  renderHome();
  await screen.findByRole('region', { name: 'Net worth history' });

  await vi.waitFor(() => {
    const mainCalls = vi
      .mocked(getPortfolioHistory)
      .mock.calls.filter(([id, range]) => id === MAIN.id && range === '1M');
    expect(mainCalls).toHaveLength(1);
  });
});

test('recent activity merges both portfolios newest-first and names each one', async () => {
  storeBoard('recent-transactions');

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Recent activity' });

  const rows = await within(widget).findAllByRole('listitem');
  // The 07-21 sell from Savings outranks the 07-20 buy from Main.
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining('MSFT'),
    expect.stringContaining('AAPL'),
  ]);
  expect(within(widget).getByText('Sell')).toBeInTheDocument();
  expect(within(widget).getByText('Buy')).toBeInTheDocument();
  // 3 × 100 US$ on a buy reads as money out; the fee is deliberately not folded in.
  expect(within(widget).getByText('-300.00 US$')).toBeInTheDocument();
  expect(within(widget).getByText('100.00 US$')).toBeInTheDocument();
  expect(within(widget).getByRole('link', { name: 'AAPL' })).toHaveAttribute(
    'href',
    `/assets/${APPLE.id}`,
  );
  // Unscoped, so each row says which portfolio it came from.
  expect(within(widget).getByText(/Savings/)).toBeInTheDocument();
});

test('the row-count setting persists and re-asks the API for that many rows', async () => {
  const user = editMode();
  storeBoard('recent-transactions');
  renderHome();
  await screen.findByRole('region', { name: 'Recent activity' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Recent activity settings' }));
  await user.selectOptions(screen.getByLabelText('Rows'), '15');

  expect(persisted().widgets[0]?.settings.count).toBe(15);
  await vi.waitFor(() => {
    expect(listTransactions).toHaveBeenCalledWith(MAIN.id, { limit: 15 }, expect.anything());
  });
});

test('cash balances group by portfolio and total what they show', async () => {
  storeBoard('cash-balances');

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Cash' });

  expect(await within(widget).findByText('Main account')).toBeInTheDocument();
  expect(within(widget).getByText('Savings account')).toBeInTheDocument();
  // Unscoped across two portfolios ⇒ each group is headed by its portfolio name.
  expect(within(widget).getByText('Main')).toBeInTheDocument();
  expect(within(widget).getByText('Savings')).toBeInTheDocument();
  // 1 000 + 500, and the total describes exactly the rows above it.
  expect(within(widget).getByText('1,500.00 €')).toBeInTheDocument();
  expect(within(widget).getByText('Total')).toBeInTheDocument();
});

test('dividends show the earlier of ex/pay date, labelled', async () => {
  storeBoard('dividends');

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Dividends' });

  expect(await within(widget).findByRole('link', { name: 'AAPL' })).toBeInTheDocument();
  // 05.08. is before 19.08., so the row is an ex-date row.
  expect(within(widget).getByText(/Ex-date/)).toBeInTheDocument();
  expect(within(widget).queryByText(/Pay date/)).not.toBeInTheDocument();
});

test('dividends explain themselves when market intel is switched off', async () => {
  vi.mocked(getPortfolioDividendCalendar).mockResolvedValue({ available: false, entries: [] });
  storeBoard('dividends');

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Dividends' });

  // A widget the user placed on purpose never renders as a blank slot.
  expect(await within(widget).findByText('Dividend data is not available.')).toBeInTheDocument();
});

test('the watchlist widget shows the first list with quotes, and only its rows', async () => {
  storeBoard('watchlist');

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Watchlist' });

  expect(await within(widget).findByRole('link', { name: 'AAPL' })).toBeInTheDocument();
  // DOGE belongs to the other list — it must not leak in.
  expect(within(widget).queryByText('DOGE')).not.toBeInTheDocument();
  expect(within(widget).getByText('190.50 US$')).toBeInTheDocument();
  expect(within(widget).getByText('+1.25%')).toBeInTheDocument();
});

test('picking another watchlist persists and swaps the rows', async () => {
  const user = editMode();
  storeBoard('watchlist');
  renderHome();
  const widget = await screen.findByRole('region', { name: 'Watchlist' });
  expect(await within(widget).findByRole('link', { name: 'AAPL' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Watchlist settings' }));
  await user.selectOptions(screen.getByLabelText('List'), SPEC_LIST.id);
  await user.keyboard('{Escape}');

  expect(persisted().widgets[0]?.settings.watchlistId).toBe(SPEC_LIST.id);
  expect(await within(widget).findByRole('link', { name: 'DOGE' })).toBeInTheDocument();
  expect(within(widget).queryByText('AAPL')).not.toBeInTheDocument();
});

test('a watchlistId naming a deleted list degrades to the first list', async () => {
  storeBoard(['watchlist', { watchlistId: 'wl-gone' }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Watchlist' });

  expect(await within(widget).findByRole('link', { name: 'AAPL' })).toBeInTheDocument();
  // Reading never rewrites: restoring the list restores the choice.
  expect(persisted().widgets[0]?.settings.watchlistId).toBe('wl-gone');
});

test('the alerts widget counts armed vs fired and links to the alerts page', async () => {
  storeBoard('alerts');

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Alerts' });

  expect(await within(widget).findByText('Armed')).toBeInTheDocument();
  expect(within(widget).getByText('Triggered')).toBeInTheDocument();
  // One of each in the fixture.
  expect(within(widget).getAllByText('1')).toHaveLength(2);
  expect(within(widget).getByRole('link', { name: /Armed/ })).toHaveAttribute(
    'href',
    '/workbench/alerts',
  );
  // The fired one is listed; the armed one is a count, not a row.
  expect(within(widget).getByRole('link', { name: 'AAPL' })).toBeInTheDocument();
});

test('the spotlight asks for an asset before it asks for data', async () => {
  storeBoard('asset-spotlight');

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Spotlight' });

  expect(within(widget).getByText('No asset picked yet')).toBeInTheDocument();
  expect(getAssetQuote).not.toHaveBeenCalled();
});

test('a picked spotlight shows the asset’s price, day move and chart', async () => {
  storeBoard(['asset-spotlight', { assetId: APPLE.id, assetLabel: 'AAPL', range: '1M' }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Spotlight' });

  expect(await within(widget).findByText('190.50 US$')).toBeInTheDocument();
  expect(within(widget).getByText('+1.25%')).toBeInTheDocument();
  expect(within(widget).getByRole('link', { name: 'AAPL' })).toHaveAttribute(
    'href',
    `/assets/${APPLE.id}`,
  );
  // Keyed exactly like the asset page, so opening AAPL there costs no refetch.
  expect(getAssetHistory).toHaveBeenCalledWith(APPLE.id, '1M', expect.anything());
});

test('every widget in the catalog is offered in the drawer and renders when added', async () => {
  const user = editMode();
  const added: WidgetType[] = [
    'net-worth-history',
    'asset-spotlight',
    'recent-transactions',
    'cash-balances',
    'watchlist',
    'dividends',
    'alerts',
  ];
  // Nothing on the board but the new widgets, added the way a user would.
  storeBoard();
  renderHome();
  await screen.findByText('Your home is empty');
  // Edit mode keeps "Add widget" in the page header; the empty state's own copy of
  // it disappears with the first widget added.
  await user.click(screen.getByRole('button', { name: 'Customize' }));

  // Matched on title + description (the catalog button's full accessible name):
  // "Cash" alone would also match the older "Cash flow" entry.
  for (const name of [
    "Net worth history Every portfolio's value over time, combined",
    'Spotlight One asset with its price and chart',
    'Recent activity The latest trades across your portfolios',
    'Cash Balances per cash source',
    'Watchlist A watchlist with live quotes',
    'Dividends Upcoming ex- and pay dates',
    'Alerts How many are armed and what fired',
  ]) {
    // An empty board shows "Add widget" twice (header + empty state); the header
    // one is first in DOM order and survives the first add.
    await user.click(screen.getAllByRole('button', { name: 'Add widget' })[0]!);
    const drawer = screen.getByRole('complementary', { name: 'Add a widget' });
    await user.click(within(drawer).getByRole('button', { name }));
  }

  expect(persisted().widgets.map((widget) => widget.type)).toEqual(added);
  expect(boardOrder()).toEqual([
    'Net worth history',
    'Spotlight',
    'Recent activity',
    'Cash',
    'Watchlist',
    'Dividends',
    'Alerts',
  ]);
});
