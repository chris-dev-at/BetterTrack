import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  Alert,
  Holding,
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
// Modules exporting a **query-key constant (or a function building one)** are
// the exception: automocking empties arrays and turns every function
// (including a query-key builder) into a `vi.fn()` returning `undefined`, so
// `['alerts']` would arrive as `[]` and `cashTrendsQueryKey(id, months)` would
// arrive as `undefined` — either poisons `useQuery`'s cache identity, and
// every widget keyed that way would collapse onto one shared cache entry (or
// crash outright) and read each other's responses. Those spread the real
// module and stub only the fetchers, keeping the keys intact.
vi.mock('../../lib/portfolioApi');
vi.mock('../../lib/notificationsApi');
vi.mock('../../lib/standingOrdersApi');
vi.mock('../../lib/assetApi');
vi.mock('../../lib/cashApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashApi')>()),
  getCashTrends: vi.fn(),
}));
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
const ACCOUNT = 'acc-jane';
vi.mock('../AuthContext', () => ({
  useAuth: () => ({ user: { id: 'acc-jane', username: 'jane' } }),
}));

// The board now lives on the account (`homeSync.ts`); these tests are about the
// builder, so the transport is stubbed and the assertions stay on the cache.
vi.mock('../../lib/settingsApi');

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
import { getCashTrends } from '../../lib/cashApi';
import { DISCREET_MASK, setDiscreetMode, setMoneyCurrency } from '../../lib/format';
import { getNewsDigest, getPortfolioDividendCalendar } from '../../lib/marketIntelApi';
import { listNotifications } from '../../lib/notificationsApi';
import {
  getPortfolio,
  getPortfolioHistory,
  listCashSources,
  listPortfolios,
  listTransactions,
} from '../../lib/portfolioApi';
import { getHomeLayout, putHomeLayout } from '../../lib/settingsApi';
import { listStandingOrders } from '../../lib/standingOrdersApi';
import { listWatchlists, listWorkboard } from '../../lib/workboardApi';
import {
  DEFAULT_LAYOUT,
  WIDGET_SIZE_RULES,
  type HomeConfig,
  type WidgetSettings,
  type WidgetType,
} from './config';
import { homeCacheKey } from './homeSync';
import { setViewportWidth } from '../../test/viewport';
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
  currency: 'USD',
  points: [
    { time: '2026-07-01T00:00:00.000Z', close: 180 },
    { time: '2026-07-02T00:00:00.000Z', close: 190.5 },
  ],
  stale: false,
  asOf: '2026-07-27T16:00:00.000Z',
};

beforeEach(() => {
  localStorage.clear();
  setDiscreetMode(false);
  setMoneyCurrency('EUR');
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
  vi.mocked(getCashTrends).mockImplementation(async (portfolioId) => ({ portfolioId, points: [] }));
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
  // No board on the account by default; `seedBoard` overrides this.
  vi.mocked(getHomeLayout).mockResolvedValue({ layout: null, updatedAt: null });
  vi.mocked(putHomeLayout).mockImplementation(async (layout) => ({
    layout,
    updatedAt: '2026-07-30T10:00:00.000Z',
  }));
});

/** The revision a seeded board carries — the cache and the account agree on it. */
const SYNCED_AT = '2026-07-29T09:00:00.000Z';

/**
 * Give the signed-in account this board, already in step with the account copy,
 * so the mount reconcile leaves it alone and the test sees what it asked for.
 */
function seedBoard(layout: unknown): void {
  localStorage.setItem(
    homeCacheKey(ACCOUNT),
    JSON.stringify({ account: ACCOUNT, layout, syncedAt: SYNCED_AT, dirty: false }),
  );
  vi.mocked(getHomeLayout).mockResolvedValue({ layout, updatedAt: SYNCED_AT });
}

/**
 * Put exactly the given widgets on the board, at each type's default size. Used
 * by the per-widget tests so one widget's failure cannot be masked (or caused) by
 * another sharing the board.
 */
function storeBoard(...widgets: (WidgetType | [WidgetType, WidgetSettings])[]): void {
  seedBoard({
    version: 1,
    widgets: widgets.map((entry, index) => {
      const [type, settings] = Array.isArray(entry) ? entry : [entry, {}];
      return { id: `w-${index}`, type, size: WIDGET_SIZE_RULES[type].default, settings };
    }),
  });
}

/**
 * `client` is injectable so a test can inspect the cache the board wrote — used
 * to prove the performance widget stores under the portfolio page's own key.
 */
function renderHome(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
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

test('renders the portfolio-list read failure above the still-usable board', async () => {
  vi.mocked(listPortfolios).mockRejectedValue(new Error('portfolios unavailable'));
  renderHome();

  expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Customize' })).toBeInTheDocument();
});

/** The board as the account's local cache now holds it. */
function persisted(): HomeConfig {
  const raw = localStorage.getItem(homeCacheKey(ACCOUNT));
  expect(raw, 'expected the board to have been persisted').not.toBeNull();
  return (JSON.parse(raw!) as { layout: HomeConfig }).layout;
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
  expect(localStorage.getItem(homeCacheKey(ACCOUNT))).toBeNull();
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
  seedBoard({
    version: 1,
    widgets: [
      { id: 'x', type: 'holo-deck', size: 'l', settings: {} },
      { id: 'y', type: 'news', size: 'm', settings: {} },
    ],
  });

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

  const drawer = screen.getByRole('dialog', { name: 'Add a widget' });
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
  seedBoard({
    version: 1,
    widgets: [{ id: 'a', type: 'net-worth', size: 'l', settings: { scope: 'p-deleted' } }],
  });

  renderHome();

  const hero = await screen.findByRole('region', { name: 'Net worth' });
  expect(await within(hero).findByText('14,000.00 €')).toBeInTheDocument();
  // Reading never rewrites, so the setting survives: restoring the portfolio
  // (un-archiving it) brings the scope back without the user re-picking it.
  expect(persisted().widgets[0]?.settings.scope).toBe('p-deleted');
});

test('the cash-flow widget offers a portfolio scope, like every other summed chart', async () => {
  const user = editMode();
  storeBoard('cashflow-chart');
  renderHome();
  await screen.findByRole('region', { name: 'Cash flow' });
  await user.click(screen.getByRole('button', { name: 'Customize' }));

  // V5 cash fusion: cash now lives IN a portfolio, so this widget fans out and
  // sums like net-worth-history / performance-chart — scope, range AND display
  // are all offered.
  await user.click(screen.getByRole('button', { name: 'Cash flow settings' }));
  expect(screen.getByLabelText('Portfolio')).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Cash flow display form' })).toBeInTheDocument();
});

test('a widget with neither scope, range nor display forms has no settings button', async () => {
  const user = editMode();
  storeBoard('attention');
  renderHome();
  await screen.findByRole('region', { name: 'Needs attention' });
  await user.click(screen.getByRole('button', { name: 'Customize' }));

  expect(
    screen.queryByRole('button', { name: 'Needs attention settings' }),
  ).not.toBeInTheDocument();
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

// ─── The performance chart's return form ─────────────────────────────────────

/** A history whose % series is deliberately NOT derivable from its € values. */
const RETURN_HISTORY: PortfolioHistoryResponse = {
  ...HISTORY,
  points: [
    { date: '2026-07-01', valueEur: 100 },
    { date: '2026-07-02', valueEur: 140 },
  ],
  // Value climbs 40 %, but most of that was a deposit — the honest time-weighted
  // return is +2.5 %. These numbers exist to catch a widget that computes its own
  // percentage from `points` instead of plotting the server's audited series.
  performance: [
    { date: '2026-07-01', pct: 0 },
    { date: '2026-07-02', pct: 2.5 },
  ],
};

test('the return form plots the server’s time-weighted % series, not the € values', async () => {
  vi.mocked(getPortfolioHistory).mockResolvedValue(RETURN_HISTORY);
  storeBoard(['performance-chart', { scope: MAIN.id, range: '1M', variant: 'return' }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Performance' });

  await vi.waitFor(() => {
    expect(chartMocks.setData).toHaveBeenCalledWith([
      { time: '2026-07-01', value: 0 },
      { time: '2026-07-02', value: 2.5 },
    ]);
  });
  // Never the euro curve — the two are distinguishable precisely because 140 is
  // not 2.5.
  expect(chartMocks.setData).not.toHaveBeenCalledWith([
    { time: '2026-07-01', value: 100 },
    { time: '2026-07-02', value: 140 },
  ]);
  // The portfolio overview's own performance mode, reused: a 0-centred baseline.
  expect(chartMocks.addSeries).toHaveBeenCalledWith('BaselineSeries', expect.anything());
  expect(
    within(widget).getByRole('img', { name: 'Time-weighted return over time for Main' }),
  ).toBeInTheDocument();
  // Labelled as time-weighted, so the number is never read as a price change.
  expect(within(widget).getByText(/time-weighted return/i)).toBeInTheDocument();
});

test('the return form degrades to the € curve across several portfolios, and says why', async () => {
  vi.mocked(getPortfolioHistory).mockResolvedValue(RETURN_HISTORY);
  // "All portfolios" — percentages are not additive, so there is no honest
  // aggregate return to show.
  storeBoard(['performance-chart', { scope: 'all', range: '1M', variant: 'return' }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Performance' });

  expect(
    await within(widget).findByText(/only meaningful for a single portfolio/i),
  ).toBeInTheDocument();

  const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  await vi.waitFor(() => {
    // Both portfolios summed, in euro — 100+100 then 140+140.
    expect(chartMocks.setData).toHaveBeenCalledWith([
      { time: seconds('2026-07-01'), value: 200 },
      { time: seconds('2026-07-02'), value: 280 },
    ]);
  });
  // The percentage must not appear anywhere: no baseline series, no pct data.
  expect(chartMocks.addSeries).not.toHaveBeenCalledWith('BaselineSeries', expect.anything());
  expect(chartMocks.setData).not.toHaveBeenCalledWith([
    { time: '2026-07-01', value: 0 },
    { time: '2026-07-02', value: 2.5 },
  ]);
});

test('a two-portfolio set degrades too — a set is not one portfolio', async () => {
  vi.mocked(getPortfolioHistory).mockResolvedValue(RETURN_HISTORY);
  storeBoard([
    'performance-chart',
    { scope: 'selected', scopeIds: [MAIN.id, SAVINGS.id], range: '1M', variant: 'return' },
  ]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Performance' });

  expect(
    await within(widget).findByText(/only meaningful for a single portfolio/i),
  ).toBeInTheDocument();
  // Wait for the chart to actually exist before asserting what it is NOT: a
  // negative assertion made before `createChart` runs would pass either way.
  const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  await vi.waitFor(() => {
    expect(chartMocks.setData).toHaveBeenCalledWith([
      { time: seconds('2026-07-01'), value: 200 },
      { time: seconds('2026-07-02'), value: 280 },
    ]);
  });
  expect(chartMocks.addSeries).not.toHaveBeenCalledWith('BaselineSeries', expect.anything());
});

test('a set naming exactly one portfolio still gets its return', async () => {
  vi.mocked(getPortfolioHistory).mockResolvedValue(RETURN_HISTORY);
  storeBoard([
    'performance-chart',
    { scope: 'selected', scopeIds: [SAVINGS.id], range: '1M', variant: 'return' },
  ]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Performance' });

  await vi.waitFor(() => {
    expect(chartMocks.addSeries).toHaveBeenCalledWith('BaselineSeries', expect.anything());
  });
  expect(
    within(widget).queryByText(/only meaningful for a single portfolio/i),
  ).not.toBeInTheDocument();
});

test('the return form reads the same cache entry the portfolio page writes', async () => {
  vi.mocked(getPortfolioHistory).mockResolvedValue(RETURN_HISTORY);
  storeBoard(['performance-chart', { scope: MAIN.id, range: '1M', variant: 'return' }]);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderHome(client);
  await screen.findByRole('region', { name: 'Performance' });

  // Spelled out literally rather than via `toHistoryRange`, so this fails if the
  // widget's key ever drifts from PortfolioPage's own
  // `['portfolio', portfolioId, 'history', toHistoryRange(range)]`. The two
  // surfaces must never be able to show different numbers for the same window.
  await vi.waitFor(() => {
    expect(client.getQueryData(['portfolio', MAIN.id, 'history', '1M'])).toEqual(RETURN_HISTORY);
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

test('a spotlight keeps its history alternative masked when the quote is unavailable', async () => {
  setDiscreetMode(true);
  vi.mocked(getAssetQuote).mockRejectedValueOnce(new Error('quote unavailable'));
  storeBoard(['asset-spotlight', { assetId: APPLE.id, assetLabel: 'AAPL', range: '1M' }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Spotlight' });
  const chart = await within(widget).findByRole('img');

  await vi.waitFor(() => {
    expect(getAssetHistory).toHaveBeenCalledWith(APPLE.id, '1M', expect.anything());
  });
  const summary = document.getElementById(chart.getAttribute('aria-describedby')!);
  expect(summary).toHaveTextContent(`Start: ${DISCREET_MASK}`);
  expect(summary).not.toHaveTextContent('180');
  expect(within(widget).getByRole('button', { name: 'Show chart data' })).toBeInTheDocument();
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
    const drawer = screen.getByRole('dialog', { name: 'Add a widget' });
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

// ─── Click-to-place reordering ────────────────────────────────────────────────

/**
 * Reordering is an explicit two-step: the grip picks a widget up, then one gold
 * line per legal destination appears and clicking one moves it. It replaced live
 * pointer dragging, so these cases also stand in for what the drag used to do —
 * and the ↑/↓ tests above must keep passing alongside them, since those remain
 * the single-step fast path and the accessibility fallback.
 */

/** Every visible placement target's accessible name, in DOM (= visual) order. */
function placementLabels(): string[] {
  return screen
    .queryAllByRole('button', { name: /^Place / })
    .map((button) => button.getAttribute('aria-label') ?? '');
}

async function customizeAndArm(user: ReturnType<typeof editMode>, title: string) {
  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: `Reorder ${title}` }));
}

test('edit mode on its own shows no placement lines — only arming does', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));

  expect(placementLabels()).toEqual([]);
  expect(screen.getByRole('button', { name: 'Reorder Net worth' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('arming shows one target per legal position, in visual order, no-ops omitted', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });

  await customizeAndArm(user, 'Net worth');

  // Five widgets ⇒ six gaps, minus the two that mean "where it already is" ⇒ four.
  expect(placementLabels()).toEqual([
    'Place before Needs attention',
    'Place before Upcoming',
    'Place before Jump in',
    'Place at the end',
  ]);
  expect(placementLabels()).toHaveLength(DEFAULT_LAYOUT.widgets.length - 1);
  // Before itself, and before its own successor, are the same position it is in.
  expect(screen.queryByRole('button', { name: 'Place before Net worth' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Place before Portfolios' })).not.toBeInTheDocument();
  // The armed widget reads as picked up, and its grip now offers the way out.
  expect(screen.getByRole('button', { name: 'Stop placing Net worth' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('arming a middle widget offers the positions on both sides of it', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });

  await customizeAndArm(user, 'Needs attention');

  expect(placementLabels()).toEqual([
    'Place before Net worth',
    'Place before Portfolios',
    'Place before Jump in',
    'Place at the end',
  ]);
});

test('clicking a target moves the widget there, persists it, and disarms', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await customizeAndArm(user, 'Net worth');

  await user.click(screen.getByRole('button', { name: 'Place before Upcoming' }));

  // The persisted layout is the claim — the DOM merely reflects it.
  expect(persisted().widgets.map((widget) => widget.type)).toEqual([
    'portfolio-cards',
    'attention',
    'net-worth',
    'upcoming',
    'shortcuts',
  ]);
  expect(boardOrder()).toEqual([
    'Portfolios',
    'Needs attention',
    'Net worth',
    'Upcoming',
    'Jump in',
  ]);
  expect(placementLabels()).toEqual([]);
});

test('the end target moves the widget to the bottom of the board', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await customizeAndArm(user, 'Net worth');

  await user.click(screen.getByRole('button', { name: 'Place at the end' }));

  expect(persisted().widgets.map((widget) => widget.type)).toEqual([
    'portfolio-cards',
    'attention',
    'upcoming',
    'shortcuts',
    'net-worth',
  ]);
});

test('a placed board survives a remount — the move was written through', async () => {
  const user = editMode();
  const first = renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await customizeAndArm(user, 'Net worth');
  await user.click(screen.getByRole('button', { name: 'Place at the end' }));
  first.unmount();

  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  expect(boardOrder()).toEqual([
    'Portfolios',
    'Needs attention',
    'Upcoming',
    'Jump in',
    'Net worth',
  ]);
});

test('Escape cancels placement and leaves the board untouched', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await customizeAndArm(user, 'Net worth');

  await user.keyboard('{Escape}');

  expect(placementLabels()).toEqual([]);
  expect(boardOrder()).toEqual([
    'Net worth',
    'Portfolios',
    'Needs attention',
    'Upcoming',
    'Jump in',
  ]);
  // Cancelling is not an edit, so nothing was written.
  expect(localStorage.getItem(homeCacheKey(ACCOUNT))).toBeNull();
});

test('clicking the grip again puts the widget back down', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await customizeAndArm(user, 'Net worth');

  await user.click(screen.getByRole('button', { name: 'Stop placing Net worth' }));

  expect(placementLabels()).toEqual([]);
  expect(screen.getByRole('button', { name: 'Reorder Net worth' })).toBeInTheDocument();
});

test('clicking the armed widget itself cancels', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await customizeAndArm(user, 'Net worth');

  // The widget's own title — its body, not its edit chrome.
  await user.click(
    within(screen.getByRole('region', { name: 'Net worth' })).getByText('Net worth'),
  );

  expect(placementLabels()).toEqual([]);
});

test('the armed widget’s edit chrome keeps working while it is picked up', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await customizeAndArm(user, 'Net worth');

  // Resizing is not "never mind" — the click must not be read as a cancel.
  const sizes = screen.getByRole('group', { name: 'Net worth size' });
  await user.click(within(sizes).getByRole('button', { name: 'M' }));

  expect(persisted().widgets[0]?.size).toBe('m');
  expect(placementLabels()).toHaveLength(DEFAULT_LAYOUT.widgets.length - 1);
});

test('arming a different widget re-targets instead of stacking state', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await customizeAndArm(user, 'Net worth');

  await user.click(screen.getByRole('button', { name: 'Reorder Needs attention' }));

  // Exactly one widget is armed, and the targets describe the new one.
  expect(screen.getByRole('button', { name: 'Reorder Net worth' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop placing Needs attention' })).toBeInTheDocument();
  expect(placementLabels()).toEqual([
    'Place before Net worth',
    'Place before Portfolios',
    'Place before Jump in',
    'Place at the end',
  ]);
});

test('the whole flow works from the keyboard', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await user.click(screen.getByRole('button', { name: 'Customize' }));

  // Arm with Enter on the focused grip…
  screen.getByRole('button', { name: 'Reorder Net worth' }).focus();
  await user.keyboard('{Enter}');
  expect(placementLabels()).toHaveLength(DEFAULT_LAYOUT.widgets.length - 1);

  // …then activate a target the same way. Real buttons, so no key handling of ours.
  const target = screen.getByRole('button', { name: 'Place before Jump in' });
  target.focus();
  expect(target).toHaveFocus();
  await user.keyboard('{Enter}');

  expect(persisted().widgets.map((widget) => widget.type)).toEqual([
    'portfolio-cards',
    'attention',
    'upcoming',
    'net-worth',
    'shortcuts',
  ]);
});

test('leaving edit mode disarms', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await customizeAndArm(user, 'Net worth');

  await user.click(screen.getByRole('button', { name: 'Done' }));

  expect(placementLabels()).toEqual([]);
  expect(screen.queryByRole('button', { name: 'Reorder Net worth' })).not.toBeInTheDocument();
});

test('the up/down buttons still reorder, and disarm a pending placement', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await customizeAndArm(user, 'Net worth');

  // The fast path stays available even mid-placement; performing it ends the mode.
  await user.click(screen.getByRole('button', { name: 'Move Net worth down' }));

  expect(persisted().widgets.map((widget) => widget.type)).toEqual([
    'portfolio-cards',
    'net-worth',
    'attention',
    'upcoming',
    'shortcuts',
  ]);
  expect(placementLabels()).toEqual([]);
});

test('a single-widget board offers no placement targets', async () => {
  storeBoard('news');
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'News' });

  await customizeAndArm(user, 'News');

  // Nowhere else to go — arming is honest about it rather than showing a no-op line.
  expect(placementLabels()).toEqual([]);
});

// ─── Display variants and indicators ─────────────────────────────────────────

/**
 * A variant answers the same question a different way, so these cases assert the
 * *other* reading appears — the figures a donut cannot state, the two gross
 * numbers a net line hides — rather than just that markup changed.
 */

function holding(symbol: string, marketValueEur: number, dayChangePct: number): Holding {
  return {
    asset: { ...APPLE, id: `as-${symbol}`, symbol, name: `${symbol} Inc.` },
    quantity: 10,
    avgCost: 100,
    realizedPnl: 0,
    price: 100,
    marketValueEur,
    costBasisEur: marketValueEur - 100,
    unrealizedPnlEur: 100,
    unrealizedPnlPct: 4,
    dayChangeEur: marketValueEur * (dayChangePct / 100),
    dayChangePct,
  };
}

/** Main gets the holdings; Savings stays empty so the roll-up maths stays readable. */
function withHoldings(...holdings: Holding[]) {
  vi.mocked(getPortfolio).mockImplementation(async (id: string) =>
    id === MAIN.id
      ? { ...summary(9_000, 1_000, 250), holdings }
      : { ...summary(3_500, 500, -50), holdings: [] },
  );
}

test('the cash-flow widget’s in/out columns state both gross figures per month', async () => {
  // Savings contributes nothing (default beforeEach mock) — Main alone drives
  // the asserted totals, unchanged from before the widget fanned out.
  vi.mocked(getCashTrends).mockImplementation(async (portfolioId) => ({
    portfolioId,
    points:
      portfolioId === MAIN.id
        ? [
            { month: '2026-06', inflow: 4_000, outflow: 3_600 },
            { month: '2026-07', inflow: 4_200, outflow: 1_000 },
          ]
        : [],
  }));
  storeBoard(['cashflow-chart', { variant: 'columns' }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Cash flow' });

  // The point of the variant: a flat net month could be 4 000/3 600 or 400/0, and
  // only this form distinguishes them. Bars carry both values in their titles.
  expect(await within(widget).findByTitle(/4,000\.00/)).toBeInTheDocument();
  expect(within(widget).getByTitle(/3,600\.00/)).toBeInTheDocument();
  expect(
    within(widget).getByRole('img', { name: 'Money in and money out per month' }),
  ).toBeInTheDocument();
  // The totals row now also carries the net (8 200 in − 4 600 out).
  expect(within(widget).getByText('+3,600.00 €')).toBeInTheDocument();
  expect(within(widget).getByText(/net$/)).toBeInTheDocument();
});

test('the cash-flow widget defaults to the net form', async () => {
  vi.mocked(getCashTrends).mockImplementation(async (portfolioId) => ({
    portfolioId,
    points: portfolioId === MAIN.id ? [{ month: '2026-07', inflow: 4_200, outflow: 1_000 }] : [],
  }));
  storeBoard('cashflow-chart');

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Cash flow' });

  expect(await within(widget).findByRole('img', { name: 'Net cash flow by month' })).toBeVisible();
  expect(
    within(widget).queryByRole('img', { name: 'Money in and money out per month' }),
  ).not.toBeInTheDocument();
});

test('the cash-flow widget fans out over every scoped portfolio and sums them', async () => {
  vi.mocked(getCashTrends).mockImplementation(async (portfolioId) => ({
    portfolioId,
    points:
      portfolioId === MAIN.id
        ? [{ month: '2026-07', inflow: 4_000, outflow: 1_000 }]
        : [{ month: '2026-07', inflow: 500, outflow: 200 }],
  }));
  storeBoard('cashflow-chart');

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Cash flow' });

  // 4 500 in (4 000 + 500) and 1 200 out (1 000 + 200) — summed across BOTH
  // scoped portfolios under the default "all portfolios" scope, not just Main's.
  expect(await within(widget).findByText('4,500.00 €')).toBeInTheDocument();
  expect(within(widget).getByText('1,200.00 €')).toBeInTheDocument();
  expect(getCashTrends).toHaveBeenCalledWith(MAIN.id, 6, expect.anything());
  expect(getCashTrends).toHaveBeenCalledWith(SAVINGS.id, 6, expect.anything());
});

test('the cash-flow chart alternative uses the active base currency', async () => {
  // Re-pointed from `getExpenseTrends` at the merge: this widget reads the CASH
  // ledger now (the expense island is retired), so the mock had to move with it
  // — and the shape differs, inflow/outflow rather than income/expense. Only
  // the data source changed; what is asserted is still main's point, that the
  // chart's text alternative follows the active base currency.
  setMoneyCurrency('USD');
  vi.mocked(getCashTrends).mockImplementation(async (portfolioId) => ({
    portfolioId,
    points: [
      { month: '2026-06', inflow: 4_000, outflow: 3_600 },
      { month: '2026-07', inflow: 4_200, outflow: 1_000 },
    ],
  }));
  storeBoard(['cashflow-chart', { scope: MAIN.id }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Cash flow' });
  const chart = await within(widget).findByRole('img', { name: 'Net cash flow by month' });
  const summary = document.getElementById(chart.getAttribute('aria-describedby')!);

  expect(summary).toHaveTextContent('US$');
  expect(summary).not.toHaveTextContent('€');
});

test('allocation as ranked bars prints the share and amount a donut only implies', async () => {
  withHoldings(holding('AAPL', 6_000, 1.5), holding('MSFT', 3_000, -0.5));
  storeBoard(['allocation', { scope: MAIN.id, variant: 'bars' }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Allocation' });

  // 6 000 + 3 000 + 1 000 cash = 10 000, so AAPL is exactly 60 %.
  expect(await within(widget).findByText('60.00%')).toBeInTheDocument();
  expect(within(widget).getByText('30.00%')).toBeInTheDocument();
  expect(within(widget).getByText('10.00%')).toBeInTheDocument();
  expect(within(widget).getByText('6,000.00 €')).toBeInTheDocument();
  expect(within(widget).getByText('Cash')).toBeInTheDocument();
});

test('movers as chips put every mover in one ranked strip', async () => {
  withHoldings(holding('AAPL', 6_000, 3.5), holding('MSFT', 3_000, -1.25));
  storeBoard(['top-movers', { scope: MAIN.id, variant: 'chips' }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Movers' });

  const chips = await within(widget).findAllByRole('link');
  expect(chips.map((chip) => chip.textContent)).toEqual(['AAPL+3.50%', 'MSFT-1.25%']);
  // The two-column form's headings are gone — this is one strip, not two lists.
  expect(within(widget).queryByText('Climbers')).not.toBeInTheDocument();
});

test('portfolios as a table adds each one’s share of the total', async () => {
  storeBoard(['portfolio-cards', { variant: 'table' }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Portfolios' });

  expect(await within(widget).findByRole('columnheader', { name: 'Share' })).toBeInTheDocument();
  // 10 000 and 4 000 of a 14 000 total.
  expect(within(widget).getByText('71.43%')).toBeInTheDocument();
  expect(within(widget).getByText('28.57%')).toBeInTheDocument();
  expect(within(widget).getByRole('link', { name: 'Main' })).toHaveAttribute(
    'href',
    '/portfolio?portfolio=p-main',
  );
});

test('the liquidity indicator states the cash share of the scoped total', async () => {
  storeBoard(['liquidity', { scope: MAIN.id }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Liquidity' });

  // Main is 9 000 invested + 1 000 cash ⇒ 10 % liquid.
  expect(await within(widget).findByText('10.00%')).toBeInTheDocument();
  expect(within(widget).getByText('1,000.00 €')).toBeInTheDocument();
  expect(within(widget).getByText('10,000.00 €')).toBeInTheDocument();
});

test('the liquidity indicator rolls every portfolio up when unscoped', async () => {
  storeBoard('liquidity');

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Liquidity' });

  // 1 000 + 500 cash of a 14 000 total.
  expect(await within(widget).findByText('10.71%')).toBeInTheDocument();
});

test('the concentration indicator names the biggest position and its share', async () => {
  withHoldings(holding('AAPL', 6_000, 1), holding('MSFT', 2_000, 1), holding('SAP', 1_000, 1));
  storeBoard(['concentration', { scope: MAIN.id }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Concentration' });

  // 6 000 of Main's 10 000 total value (cash included).
  expect(await within(widget).findByText('60.00%')).toBeInTheDocument();
  expect(within(widget).getByRole('link', { name: 'AAPL' })).toBeInTheDocument();
  // 6 000 + 2 000 + 1 000 = 9 000 of 10 000.
  expect(within(widget).getByText('Top 3 together: 90.00%')).toBeInTheDocument();
});

test('switching a display form persists and re-renders in the other form', async () => {
  const user = editMode();
  withHoldings(holding('AAPL', 6_000, 1.5));
  storeBoard(['allocation', { scope: MAIN.id }]);
  renderHome();
  await screen.findByRole('region', { name: 'Allocation' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Allocation settings' }));
  const forms = screen.getByRole('group', { name: 'Allocation display form' });
  await user.click(within(forms).getByRole('button', { name: 'Bars' }));

  expect(persisted().widgets[0]?.settings.variant).toBe('bars');
  const widget = screen.getByRole('region', { name: 'Allocation' });
  expect(await within(widget).findByText('85.71%')).toBeInTheDocument();
});

// ─── Adding at a position ────────────────────────────────────────────────────

test('edit mode offers an ⊕ at every position when nothing is picked up', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));

  // A new widget can go anywhere: five widgets ⇒ six positions.
  const adders = screen.getAllByRole('button', { name: /^Add a widget/ });
  expect(adders).toHaveLength(DEFAULT_LAYOUT.widgets.length + 1);
  expect(adders.map((button) => button.getAttribute('aria-label'))).toEqual([
    'Add a widget before Net worth',
    'Add a widget before Portfolios',
    'Add a widget before Needs attention',
    'Add a widget before Upcoming',
    'Add a widget before Jump in',
    'Add a widget at the end',
  ]);
});

test('the ⊕ on a line inserts the chosen widget at exactly that position', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await user.click(screen.getByRole('button', { name: 'Customize' }));

  await user.click(screen.getByRole('button', { name: 'Add a widget before Needs attention' }));
  const drawer = screen.getByRole('dialog', { name: 'Add a widget' });
  await user.click(within(drawer).getByRole('button', { name: /^Alerts/ }));

  // Third position, not appended — the persisted layout is the claim.
  expect(persisted().widgets.map((widget) => widget.type)).toEqual([
    'net-worth',
    'portfolio-cards',
    'alerts',
    'attention',
    'upcoming',
    'shortcuts',
  ]);
  expect(boardOrder()).toEqual([
    'Net worth',
    'Portfolios',
    'Alerts',
    'Needs attention',
    'Upcoming',
    'Jump in',
  ]);
});

test('the header’s Add button still appends, ignoring any earlier ⊕', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await user.click(screen.getByRole('button', { name: 'Customize' }));

  // Open from a line, dismiss it, then use the header button: the pending slot
  // must not survive into an add the user started somewhere else.
  await user.click(screen.getByRole('button', { name: 'Add a widget before Net worth' }));
  const pending = screen.getByRole('dialog', { name: 'Add a widget' });
  await user.click(within(pending).getByRole('button', { name: 'Close' }));
  await user.click(screen.getByRole('button', { name: 'Add widget' }));
  const drawer = screen.getByRole('dialog', { name: 'Add a widget' });
  await user.click(within(drawer).getByRole('button', { name: /^Alerts/ }));

  expect(persisted().widgets.at(-1)?.type).toBe('alerts');
});

test('picking a widget up swaps the ⊕ positions for move targets', async () => {
  const user = editMode();
  renderHome();
  await screen.findByRole('region', { name: 'Net worth' });
  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Reorder Net worth' }));

  // The add affordance stands down while something is held…
  expect(screen.queryAllByRole('button', { name: /^Add a widget/ })).toHaveLength(0);
  // …and every legal destination becomes a move target. The slots are glyph-only
  // (owner: the label broke the line it sat on), so the position lives in the
  // accessible name and the arrow marks the mode.
  const targets = screen.getAllByRole('button', { name: /^Place / });
  expect(targets).toHaveLength(DEFAULT_LAYOUT.widgets.length - 1);
  for (const target of targets) {
    expect(target).toHaveClass('is-move');
    expect(target.querySelector('svg[data-icon="arrow-right"]')).not.toBeNull();
    expect(target.textContent).toBe('');
  }
});

// ─── Multi-portfolio scope ───────────────────────────────────────────────────

/**
 * Scope stopped being "all portfolios or exactly one" and became a chosen set.
 * These cases cover the three things that can go wrong in the UI rather than in the
 * resolver (which homeData.test.ts pins down directly): the picker has to write a
 * set, the header tag has to state which of the three modes is in play, and each
 * scoped widget has to read the set rather than the whole list.
 */

/** A third portfolio, so "2 of 3" is a real subset rather than everything. */
const PENSION: PortfolioSummary = { ...MAIN, id: 'p-pension', name: 'Pension', isDefault: false };

function withThreePortfolios() {
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, SAVINGS, PENSION] });
  vi.mocked(getPortfolio).mockImplementation(async (id: string) => {
    if (id === MAIN.id) return summary(9_000, 1_000, 250);
    if (id === SAVINGS.id) return summary(3_500, 500, -50);
    return summary(2_000, 0, 10);
  });
}

/** The chosen-set scope for a board fixture. */
const pick = (...ids: string[]) => ({ scope: 'selected', scopeIds: ids });

test('the header tag states all / one / a count, and never implies all for a subset', async () => {
  withThreePortfolios();
  storeBoard(
    ['net-worth', { scope: 'all' }],
    ['today-change', { scope: SAVINGS.id }],
    ['liquidity', pick(MAIN.id, PENSION.id)],
  );

  renderHome();
  const all = await screen.findByRole('region', { name: 'Net worth' });
  const one = screen.getByRole('region', { name: 'Today' });
  const some = screen.getByRole('region', { name: 'Liquidity' });

  // Tags only appear once the portfolio list has resolved, so await one of them
  // before asserting on any of the three.
  expect(await within(one).findByText('Savings')).toBeInTheDocument();
  const tag = await within(some).findByText('2 portfolios');
  // "all" wears no tag: it is the default, and a tag on every widget would be noise.
  expect(within(all).queryByText(/portfolios?$/)).not.toBeInTheDocument();
  // The members are discoverable without opening the settings.
  expect(tag).toHaveAttribute('title', 'Main, Pension');
  expect(tag).toHaveAccessibleName('2 portfolios — Main, Pension');
});

test('a set that currently covers every portfolio still reads as a set, not as all', async () => {
  withThreePortfolios();
  storeBoard(['net-worth', pick(MAIN.id, SAVINGS.id, PENSION.id)]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Net worth' });

  // It is a *fixed* set: a portfolio added tomorrow will not join it, so calling it
  // "All portfolios" would be a promise the widget does not keep.
  expect(await within(widget).findByText('3 portfolios')).toBeInTheDocument();
});

test('the portfolios widget shows only the chosen portfolios — the owner’s case', async () => {
  withThreePortfolios();
  storeBoard(['portfolio-cards', pick(MAIN.id, PENSION.id)]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Portfolios' });

  expect(await within(widget).findByRole('link', { name: /Main/ })).toBeInTheDocument();
  expect(within(widget).getByRole('link', { name: /Pension/ })).toBeInTheDocument();
  expect(within(widget).queryByRole('link', { name: /Savings/ })).not.toBeInTheDocument();
});

test('the portfolios table divides the share across the chosen set only', async () => {
  withThreePortfolios();
  storeBoard(['portfolio-cards', { ...pick(MAIN.id, PENSION.id), variant: 'table' }]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Portfolios' });

  // 10 000 and 2 000 of the 12 000 the set holds between them — the question a set
  // implies. The header tag says a set is in play, so 100 % cannot be misread.
  expect(await within(widget).findByText('83.33%')).toBeInTheDocument();
  expect(within(widget).getByText('16.67%')).toBeInTheDocument();
});

test('a money roll-up over a subset equals what those portfolios sum to alone', async () => {
  withThreePortfolios();
  storeBoard(
    ['net-worth', pick(MAIN.id, PENSION.id)],
    ['net-worth', { scope: MAIN.id }],
    ['net-worth', { scope: PENSION.id }],
  );

  renderHome();
  const [subset, first, second] = await screen.findAllByRole('region', { name: 'Net worth' });

  // Main 10 000 + Pension 2 000 = 12 000, and each on its own is 10 000 / 2 000.
  expect(await within(subset!).findByText('12,000.00 €')).toBeInTheDocument();
  expect(within(first!).getByText('10,000.00 €')).toBeInTheDocument();
  expect(within(second!).getByText('2,000.00 €')).toBeInTheDocument();
  // …and the day change rolls up the same way: +250 + +10.
  expect(within(subset!).getByText('+260.00 €')).toBeInTheDocument();
});

test('the liquidity indicator measures only the chosen portfolios', async () => {
  withThreePortfolios();
  storeBoard(['liquidity', pick(SAVINGS.id, PENSION.id)]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Liquidity' });

  // Savings 500 cash + Pension 0, over a 4 000 + 2 000 total ⇒ 8.33 %.
  expect(await within(widget).findByText('8.33%')).toBeInTheDocument();
  expect(within(widget).getByText('6,000.00 €')).toBeInTheDocument();
});

test('the combined value chart fans out over exactly the chosen portfolios', async () => {
  withThreePortfolios();
  storeBoard(['net-worth-history', { ...pick(MAIN.id, PENSION.id), range: '6M' }]);

  renderHome();
  await screen.findByRole('region', { name: 'Net worth history' });

  await vi.waitFor(() => {
    const asked = vi
      .mocked(getPortfolioHistory)
      .mock.calls.map(([id]) => id)
      .filter((id, index, list) => list.indexOf(id) === index);
    expect(asked.sort()).toEqual([MAIN.id, PENSION.id].sort());
  });
});

test('picking "Selected portfolios…" seeds a set and the checkboxes narrow it', async () => {
  const user = editMode();
  withThreePortfolios();
  storeBoard(['portfolio-cards', { scope: 'all' }]);
  renderHome();
  await screen.findByRole('region', { name: 'Portfolios' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Portfolios settings' }));
  await user.selectOptions(screen.getByLabelText('Portfolio'), 'selected');

  // Seeded with what the widget was already anchored to, never an empty set (which
  // would resolve straight back to "all" and look like the choice did nothing).
  expect(persisted().widgets[0]?.settings).toMatchObject({
    scope: 'selected',
    scopeIds: [MAIN.id],
  });

  await user.click(screen.getByRole('checkbox', { name: 'Pension' }));
  expect(persisted().widgets[0]?.settings.scopeIds).toEqual([MAIN.id, PENSION.id]);

  await user.click(screen.getByRole('checkbox', { name: 'Main' }));
  expect(persisted().widgets[0]?.settings.scopeIds).toEqual([PENSION.id]);
});

test('the last chosen portfolio cannot be unchecked — an empty set would mean "all"', async () => {
  const user = editMode();
  withThreePortfolios();
  storeBoard(['portfolio-cards', pick(SAVINGS.id)]);
  renderHome();
  await screen.findByRole('region', { name: 'Portfolios' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Portfolios settings' }));

  // Refused visibly rather than silently widening the widget behind the user.
  expect(screen.getByRole('checkbox', { name: 'Savings' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Main' })).toBeEnabled();
});

test('leaving the set mode clears the stored ids so a stale set cannot linger', async () => {
  const user = editMode();
  withThreePortfolios();
  storeBoard(['portfolio-cards', pick(MAIN.id, PENSION.id)]);
  renderHome();
  await screen.findByRole('region', { name: 'Portfolios' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Portfolios settings' }));
  await user.selectOptions(screen.getByLabelText('Portfolio'), 'all');

  expect(persisted().widgets[0]?.settings.scopeIds).toBeUndefined();
  expect(persisted().widgets[0]?.settings.scope).toBe('all');
});

test('a set naming a portfolio that no longer exists keeps the rest and says so', async () => {
  withThreePortfolios();
  storeBoard(['net-worth', pick(MAIN.id, 'p-deleted')]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Net worth' });

  // Only Main survives, so the tag counts one — and the stored id is left alone, so
  // un-archiving the other portfolio restores it without the user re-picking.
  expect(await within(widget).findByText('10,000.00 €')).toBeInTheDocument();
  expect(within(widget).getByText('1 portfolios')).toBeInTheDocument();
  expect(persisted().widgets[0]?.settings.scopeIds).toEqual([MAIN.id, 'p-deleted']);
});

test('a set whose every portfolio is gone falls back to all rather than blanking', async () => {
  withThreePortfolios();
  storeBoard(['net-worth', pick('p-gone', 'p-also-gone')]);

  renderHome();
  const widget = await screen.findByRole('region', { name: 'Net worth' });

  // 10 000 + 4 000 + 2 000 across all three.
  expect(await within(widget).findByText('16,000.00 €')).toBeInTheDocument();
  expect(within(widget).queryByText(/portfolios$/)).not.toBeInTheDocument();
});

test('at 390 px the home builder opens its catalog and keeps widget settings usable', async () => {
  setViewportWidth(390);
  const user = editMode();
  const { container } = renderHome();
  await screen.findByRole('region', { name: 'Net worth' });

  await user.click(screen.getByRole('button', { name: 'Customize' }));
  await user.click(screen.getByRole('button', { name: 'Add widget' }));
  expect(screen.getByRole('dialog', { name: 'Add a widget' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Net worth settings' }));

  expect(screen.getByLabelText('Portfolio')).toBeInTheDocument();
  expect(container.querySelector('.bt-home-page')).toBeInTheDocument();
});
