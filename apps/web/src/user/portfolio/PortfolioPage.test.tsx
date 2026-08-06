import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Transaction } from '@bettertrack/contracts';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  getPortfolio: vi.fn(),
  getPortfolioHistory: vi.fn(),
  listTransactions: vi.fn(),
  deleteTransaction: vi.fn(),
  createTransactions: vi.fn(),
  updateTransaction: vi.fn(),
  updatePortfolio: vi.fn(),
  createCustomAsset: vi.fn(),
  updateCustomAsset: vi.fn(),
  getValuePoints: vi.fn(),
  putValuePoints: vi.fn(),
  getRecategorizationStatus: vi.fn(),
  dismissRecategorization: vi.fn(),
  getCashMovements: vi.fn(),
  depositCash: vi.fn(),
  withdrawCash: vi.fn(),
  previewCash: vi.fn(),
  listCashSources: vi.fn(),
}));

vi.mock('../../lib/searchApi', () => ({ searchAssets: vi.fn() }));

// The transaction dialog fetches a daily-close series for its linked date ↔ price
// fields (#226); keep it inert here so opening the dialog makes no real request.
vi.mock('../../lib/assetApi', () => ({
  getAssetDailyCloses: vi.fn().mockResolvedValue({ points: [], stale: false, asOf: null }),
}));

// Canvas-backed chart lib — jsdom can't draw it (mirrors AssetDetailPage tests).
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

// Recharts measures the DOM (0×0 in jsdom); hand the donut a fixed size.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            width: 200,
            height: 200,
          })
        : children,
  };
});

import { ApiError } from '../../lib/apiClient';
import {
  deleteTransaction,
  depositCash,
  dismissRecategorization,
  getPortfolio,
  getPortfolioHistory,
  getRecategorizationStatus,
  getValuePoints,
  listCashSources,
  listPortfolios,
  listTransactions,
  previewCash,
  withdrawCash,
} from '../../lib/portfolioApi';
import { PortfolioPage } from './PortfolioPage';
import { setViewportWidth } from '../../test/viewport';

/** The single auto-created default portfolio (§6.8) resolved before any scoped call. */
const DEFAULT_PORTFOLIO_ID = 'p1';
const PORTFOLIO_LIST = {
  portfolios: [
    {
      id: DEFAULT_PORTFOLIO_ID,
      name: 'Main',
      visibility: 'private' as const,
      sortOrder: 0,
      isDefault: true,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  ],
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STOCK = {
  asset: {
    id: 'a1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    exchange: 'NASDAQ',
    currency: 'USD',
    type: 'stock' as const,
    isCustom: false,
  },
  quantity: 10,
  avgCost: 100,
  realizedPnl: 0,
  price: 150,
  marketValueEur: 1350,
  costBasisEur: 900,
  unrealizedPnlEur: 450,
  unrealizedPnlPct: 50,
  dayChangeEur: 9,
  dayChangePct: 0.67,
};

const HOUSE = {
  asset: {
    id: 'c1',
    symbol: 'HOUSE',
    name: 'Vienna Apartment',
    exchange: null,
    currency: 'EUR',
    type: 'custom' as const,
    isCustom: true,
    category: 'other' as const,
    smoothing: false,
  },
  quantity: 1,
  avgCost: 300000,
  realizedPnl: 0,
  price: 320000,
  marketValueEur: 320000,
  costBasisEur: 300000,
  unrealizedPnlEur: 20000,
  unrealizedPnlPct: 6.67,
  dayChangeEur: null,
  dayChangePct: null,
};

const TOTALS = {
  marketValueEur: 321350,
  investedEur: 300900,
  unrealizedPnlEur: 20450,
  unrealizedPnlPct: 6.8,
  dayChangeEur: 9,
  dayChangePct: 0.003,
  cashEur: 5000,
  totalValueEur: 326350,
};

const PORTFOLIO = { baseCurrency: 'EUR' as const, holdings: [STOCK, HOUSE], totals: TOTALS };

const EMPTY_PORTFOLIO = {
  baseCurrency: 'EUR' as const,
  holdings: [],
  totals: {
    marketValueEur: 0,
    investedEur: 0,
    unrealizedPnlEur: 0,
    unrealizedPnlPct: null,
    dayChangeEur: 0,
    dayChangePct: null,
    cashEur: 0,
    totalValueEur: 0,
  },
};

const TXNS = {
  items: [
    {
      id: 't1',
      assetId: 'a1',
      side: 'buy' as const,
      quantity: 10,
      price: 100,
      fee: 0,
      executedAt: '2024-01-15T00:00:00.000Z',
      note: null,
      allowUncovered: false,
      uncoveredEntryPrice: null,
      source: 'manual',
      asset: STOCK.asset,
    },
    {
      id: 't2',
      assetId: 'c1',
      side: 'buy' as const,
      quantity: 1,
      price: 300000,
      fee: 0,
      executedAt: '2024-02-01T00:00:00.000Z',
      note: 'Down payment',
      allowUncovered: false,
      uncoveredEntryPrice: null,
      source: 'manual',
      asset: HOUSE.asset,
    },
  ],
  nextCursor: null,
};

const HISTORY = {
  range: '1M' as const,
  baseCurrency: 'EUR' as const,
  points: [
    { date: '2024-05-01', valueEur: 300000 },
    { date: '2024-06-01', valueEur: 321350 },
  ],
  // Cash-flow-neutralized TWR series (#125), re-based to 0 % at the window start.
  performance: [
    { date: '2024-05-01', pct: 0 },
    { date: '2024-06-01', pct: 7.1167 },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPage(initialPath = '/portfolio') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <PortfolioPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

function transactionPage(
  transactions: readonly Transaction[],
  params: Parameters<typeof listTransactions>[1] = {},
) {
  const sourceTags = [...new Set(transactions.map((transaction) => transaction.source))].sort();
  const items = transactions
    .filter(
      (transaction) =>
        (params.source == null || transaction.source === params.source) &&
        (params.assetId == null || transaction.assetId === params.assetId),
    )
    .sort((left, right) =>
      params.order === 'executedAt'
        ? right.executedAt.localeCompare(left.executedAt) || right.id.localeCompare(left.id)
        : right.id.localeCompare(left.id),
    )
    .slice(0, params.limit ?? transactions.length);
  return {
    items,
    nextCursor: null,
    ...(params.includeSourceTags ? { sourceTags } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPortfolios).mockResolvedValue(PORTFOLIO_LIST);
  vi.mocked(getPortfolioHistory).mockResolvedValue(HISTORY);
  vi.mocked(listTransactions).mockImplementation(async (_portfolioId, params = {}) =>
    transactionPage(TXNS.items as Transaction[], params),
  );
  vi.mocked(deleteTransaction).mockResolvedValue(undefined);
  vi.mocked(getValuePoints).mockResolvedValue({ points: [] });
  // No pending re-categorization by default → the banner stays hidden.
  vi.mocked(getRecategorizationStatus).mockResolvedValue({ pending: 0 });
  vi.mocked(dismissRecategorization).mockResolvedValue(undefined);
  vi.mocked(previewCash).mockResolvedValue({
    availableEur: 5000,
    afterEur: 4000,
    sufficient: true,
    shortfallEur: 0,
  });
  // Only Main exists by default, so the cash/transaction dialogs render without
  // a source picker — the existing dialog assertions are unaffected.
  vi.mocked(listCashSources).mockResolvedValue({
    sources: [
      {
        id: 'src-main',
        name: 'Main',
        type: 'cash',
        isMain: true,
        archivedAt: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        balanceEur: 5000,
      },
    ],
  });
});

// ─── Empty / error ──────────────────────────────────────────────────────────

describe('PortfolioPage — empty & error states', () => {
  test('renders an auxiliary ledger read failure without hiding portfolio holdings', async () => {
    vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO);
    vi.mocked(listTransactions).mockRejectedValue(
      new ApiError(503, 'UNAVAILABLE', 'transactions unavailable'),
    );
    renderPage();

    expect(
      await screen.findByText("Some portfolio details couldn't be loaded. Please try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Could not load your portfolio/i)).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Portfolio totals' })).toBeInTheDocument();
  });

  // Transactions and cash sources are two independent supporting reads. They
  // used to be collapsed with `??`, so whichever was declared first classified
  // both — pin each order.
  test('retries only the transactions read when it is the outage', async () => {
    vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO);
    vi.mocked(listTransactions).mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'down'));
    vi.mocked(listCashSources).mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'secret'));
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(vi.mocked(listTransactions)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(listCashSources)).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  test('keeps recovery for the cash-source outage behind a confirmed transactions rejection', async () => {
    vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO);
    vi.mocked(listTransactions).mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'secret'));
    vi.mocked(listCashSources).mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'down'));
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(vi.mocked(listCashSources)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(listTransactions)).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  test('shows a designed empty state when there are no holdings', async () => {
    vi.mocked(getPortfolio).mockResolvedValue(EMPTY_PORTFOLIO);
    vi.mocked(listTransactions).mockResolvedValue({ items: [], nextCursor: null });
    renderPage();
    await waitFor(() => expect(screen.getByText(/Your portfolio is empty/i)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Search for an asset/i })).toBeInTheDocument();
    // Winners/losers and recent-transactions blocks stay hidden with no holdings.
    expect(
      screen.queryByRole('region', { name: 'Top winners and losers' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Recent transactions' })).not.toBeInTheDocument();
  });

  test('shows an error state when the portfolio fails to load', async () => {
    vi.mocked(getPortfolio).mockRejectedValue(new Error('boom'));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Could not load your portfolio/i)).toBeInTheDocument(),
    );
  });
});

// ─── Totals + holdings + donuts ───────────────────────────────────────────────

describe('PortfolioPage — holdings, totals & donuts', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  test('renders the totals header with de-AT formatting', async () => {
    renderPage();
    // Scope to the totals header — "Market value" / "Unrealized P/L" also appear
    // as holdings-table column headers, so an unscoped query is ambiguous.
    const totals = await screen.findByRole('region', { name: 'Portfolio totals' });
    expect(within(totals).getByText('Market value')).toBeInTheDocument();
    expect(within(totals).getByText('Invested')).toBeInTheDocument();
    expect(within(totals).getByText('Unrealized P/L')).toBeInTheDocument();
    expect(within(totals).getByText('Day change')).toBeInTheDocument();
    // 321350 → "321.350,00 €" (de-AT, symbol-last). Appears twice since #311:
    // the Market value card and the headline's "invested" composition.
    expect(within(totals).getAllByText('321.350,00 €').length).toBeGreaterThan(0);
  });

  test('renders a holdings row per asset', async () => {
    renderPage();
    // AAPL/HOUSE symbols and the "100,00 $" figure also appear in the
    // winners/losers and recent-transactions blocks — scope to the table.
    const holdingsRegion = await screen.findByRole('region', { name: 'Holdings' });
    await waitFor(() =>
      expect(within(holdingsRegion).getByRole('link', { name: 'AAPL' })).toBeInTheDocument(),
    );
    expect(within(holdingsRegion).getByText('Apple Inc.')).toBeInTheDocument();
    expect(within(holdingsRegion).getByRole('link', { name: 'HOUSE' })).toBeInTheDocument();
    expect(within(holdingsRegion).getByText('Vienna Apartment')).toBeInTheDocument();
    // Native avg cost is shown in the asset's currency ($).
    expect(within(holdingsRegion).getByText('100,00 $')).toBeInTheDocument();
  });

  test('renders both allocation donuts with legends', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('By asset')).toBeInTheDocument());
    expect(screen.getByText('By type')).toBeInTheDocument();
    // V3-P2: custom assets group by their catalog category, not a "Custom" slice.
    // HOUSE carries category "other" → it lands in the Other group.
    expect(screen.queryByText('Custom')).not.toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.getByText('Stocks')).toBeInTheDocument();
  });

  test('a custom asset with category "stock" groups under Stocks — no Custom slice (V3-P2)', async () => {
    // A custom holding whose catalog category is "stock" must merge into the
    // market Stocks group in the by-type donut, not spawn a separate slice.
    const CUSTOM_STOCK = {
      asset: {
        id: 'c2',
        symbol: 'ACME',
        name: 'Acme Private Shares',
        exchange: null,
        currency: 'EUR' as const,
        type: 'custom' as const,
        isCustom: true,
        category: 'stock' as const,
        smoothing: false,
      },
      quantity: 100,
      avgCost: 10,
      realizedPnl: 0,
      price: 12,
      marketValueEur: 1200,
      costBasisEur: 1000,
      unrealizedPnlEur: 200,
      unrealizedPnlPct: 20,
      dayChangeEur: null,
      dayChangePct: null,
    };
    vi.mocked(getPortfolio).mockResolvedValue({
      baseCurrency: 'EUR' as const,
      holdings: [STOCK, CUSTOM_STOCK],
      totals: { ...TOTALS, cashEur: 0 },
    });
    renderPage();

    const allocation = await screen.findByRole('region', { name: 'Allocation' });
    // Exactly one "Stocks" legend entry per donut (by asset and by type); the
    // custom stock folds into the market Stocks group, and no "Custom" appears.
    await waitFor(() =>
      expect(within(allocation).getAllByText('Stocks').length).toBeGreaterThan(0),
    );
    expect(within(allocation).queryByText('Custom')).not.toBeInTheDocument();
  });
});

// ─── Net worth incl. cash (#311) ──────────────────────────────────────────────

describe('PortfolioPage — net worth incl. cash (#311)', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  test('the headline total includes cash and shows the invested/cash composition', async () => {
    renderPage();
    const totals = await screen.findByRole('region', { name: 'Portfolio totals' });
    // The primary figure is net worth: 321 350 invested + 5 000 cash = 326 350.
    expect(within(totals).getByText('326.350,00 €')).toBeInTheDocument();
    expect(within(totals).getByText('Net Worth')).toBeInTheDocument();
  });

  test('the liquidity ring shows invested/cash percentages that sum coherently with the headline', async () => {
    renderPage();
    const totals = await screen.findByRole('region', { name: 'Portfolio totals' });
    // 321 350 / 326 350 = 98,47 % invested; the cash share is its exact
    // complement (1,53 %), so the split always describes 100 % of the total.
    expect(
      within(totals).getByRole('img', { name: '98,47 % invested, 1,53 % liquid' }),
    ).toBeInTheDocument();
    expect(within(totals).getByText('98,47 %')).toBeInTheDocument();
    expect(within(totals).getByText('1,53 %')).toBeInTheDocument();
  });

  test('the allocation donuts include a cash slice', async () => {
    renderPage();
    const allocation = await screen.findByRole('region', { name: 'Allocation' });
    // One "Cash" legend entry per donut (by asset and by type).
    expect(within(allocation).getAllByText('Cash')).toHaveLength(2);
  });
});

// ─── Cash balance ("Bargeld", §14, #220) ───────────────────────────────────────

describe('PortfolioPage — cash balance line + deposit/withdraw', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  test('shows cash as a first-class line in the totals', async () => {
    renderPage();
    const totals = await screen.findByRole('region', { name: 'Portfolio totals' });
    expect(within(totals).getByText('Cash')).toBeInTheDocument();
    // Appears twice since #311: the Cash card and the headline composition.
    expect(within(totals).getAllByText('5.000,00 €').length).toBeGreaterThan(0);
  });

  test('depositing cash calls the API and refreshes the totals', async () => {
    vi.mocked(depositCash).mockResolvedValue({
      movement: {
        id: 'm1',
        kind: 'deposit',
        amountEur: 1000,
        sourceId: 'src-main',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2024-06-01T00:00:00.000Z',
        note: null,
        source: 'manual',
        createdAt: '2024-06-01T00:00:00.000Z',
      },
      sourceBalanceEur: 6000,
      balanceEur: 6000,
    });
    const user = userEvent.setup();
    renderPage();
    const totals = await screen.findByRole('region', { name: 'Portfolio totals' });

    await user.click(within(totals).getByRole('button', { name: '+ Deposit' }));
    const dialog = screen.getByRole('dialog', { name: 'Cash balance' });
    await user.type(within(dialog).getByLabelText('Amount'), '1000');
    await user.click(within(dialog).getByRole('button', { name: 'Deposit cash' }));

    await waitFor(() =>
      expect(vi.mocked(depositCash)).toHaveBeenCalledWith(
        DEFAULT_PORTFOLIO_ID,
        expect.objectContaining({ amountEur: 1000 }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('withdrawing more than available is blocked with the insufficient-cash message', async () => {
    vi.mocked(previewCash).mockResolvedValue({
      availableEur: 5000,
      afterEur: -1000,
      sufficient: false,
      shortfallEur: 1000,
    });
    const user = userEvent.setup();
    renderPage();
    const totals = await screen.findByRole('region', { name: 'Portfolio totals' });

    await user.click(within(totals).getByRole('button', { name: '− Withdraw' }));
    const dialog = screen.getByRole('dialog', { name: 'Cash balance' });
    await user.type(within(dialog).getByLabelText('Amount'), '6000');

    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Withdraw cash' })).toBeDisabled(),
    );
    expect(vi.mocked(withdrawCash)).not.toHaveBeenCalled();
  });
});

describe('PortfolioPage — value chart range toggle', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  test('keeps range choices available when portfolio history is temporarily unavailable', async () => {
    vi.mocked(getPortfolioHistory).mockRejectedValue(
      new ApiError(503, 'UNAVAILABLE', 'history unavailable'),
    );
    renderPage();

    expect(
      await screen.findByText("Portfolio history couldn't be loaded. Please try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1W' })).toBeInTheDocument();
    expect(screen.queryByText(/Could not load your portfolio/i)).not.toBeInTheDocument();
  });

  test('keeps cached portfolio history visible after a failed background refetch', async () => {
    const { client } = renderPage();

    expect(
      await screen.findByRole('img', { name: 'Portfolio value over time' }),
    ).toBeInTheDocument();

    vi.mocked(getPortfolioHistory).mockRejectedValue(
      new ApiError(503, 'UNAVAILABLE', 'history offline'),
    );
    await act(async () => {
      await client.refetchQueries({
        queryKey: ['portfolio', DEFAULT_PORTFOLIO_ID, 'history'],
        type: 'active',
      });
    });

    expect(screen.getByRole('img', { name: 'Portfolio value over time' })).toBeInTheDocument();
    expect(
      await screen.findByText("Portfolio history couldn't be loaded. Please try again."),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  test('offers 1D/1W/1M/6M/1Y/5Y/Max (V4-P0 spans) — 3M stays intentionally omitted', async () => {
    renderPage();
    // Wait on the headline net-worth figure (#311) — unique on the page.
    await waitFor(() => expect(screen.getByText('326.350,00 €')).toBeInTheDocument());
    for (const r of ['1D', '1W', '1M', '6M', '1Y', '5Y', 'Max']) {
      expect(screen.getByRole('button', { name: r })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: '3M' })).not.toBeInTheDocument();
  });
});

// ─── Overlay relocated to Analysis (V3-P9, #425) ──────────────────────────────

describe('PortfolioPage — overlay relocated to Analysis', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  test('the overview has no overlay toggle and links to the Analysis deep-dive', async () => {
    renderPage();
    // The value curve loads without the per-asset overlay (§13.3: the overview
    // keeps only the simple curve; the overlay mode moved to Analytics).
    const link = await screen.findByRole('link', { name: 'Analysis →' });
    // The route and tab use Analysis (legacy /portfolio/analytics redirects).
    expect(link).toHaveAttribute('href', '/portfolio/analysis');
    // No overlay toggle remains on the overview.
    expect(screen.queryByRole('button', { name: 'Overlay assets' })).not.toBeInTheDocument();
    // The overview only ever fetches the plain curve — never the per-asset
    // overlay history (overlay=true).
    expect(vi.mocked(getPortfolioHistory)).toHaveBeenCalledWith(
      DEFAULT_PORTFOLIO_ID,
      '1M',
      false,
      expect.anything(),
    );
    expect(vi.mocked(getPortfolioHistory)).not.toHaveBeenCalledWith(
      DEFAULT_PORTFOLIO_ID,
      expect.anything(),
      true,
      expect.anything(),
    );
  });
});

// ─── Performance-% display mode (#125) ────────────────────────────────────────

describe('PortfolioPage — performance-% display mode', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  test('defaults to the absolute value curve with the € segment selected', async () => {
    renderPage();
    const valueBtn = await screen.findByRole('button', { name: 'Value €' });
    const perfBtn = screen.getByRole('button', { name: 'Performance %' });
    expect(valueBtn).toHaveAttribute('aria-pressed', 'true');
    expect(perfBtn).toHaveAttribute('aria-pressed', 'false');

    await waitFor(() =>
      expect(chartMocks.setData).toHaveBeenCalledWith([
        { time: '2024-05-01', value: 300000 },
        { time: '2024-06-01', value: 321350 },
      ]),
    );
  });

  test('switching to Performance % feeds the TWR series to a baseline chart', async () => {
    const user = userEvent.setup();
    renderPage();
    const perfBtn = await screen.findByRole('button', { name: 'Performance %' });

    await user.click(perfBtn);
    expect(perfBtn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Value €' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // The chart now draws the deposit-neutralized % series (green/red baseline),
    // not the raw EUR values — the whole point of #125.
    await waitFor(() =>
      expect(chartMocks.setData).toHaveBeenCalledWith([
        { time: '2024-05-01', value: 0 },
        { time: '2024-06-01', value: 7.1167 },
      ]),
    );
    expect(chartMocks.addSeries).toHaveBeenCalledWith('BaselineSeries', expect.anything());
    expect(screen.getByText(/Deposits and withdrawals are neutralized/i)).toBeInTheDocument();

    // No refetch: both series arrive with the same history response.
    expect(vi.mocked(getPortfolioHistory)).toHaveBeenCalledTimes(1);
  });
});

// ─── Expandable rows + transactions ───────────────────────────────────────────

describe('PortfolioPage — expandable rows', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  test('loads an expanded holding ledger on demand beyond the eight-row recent card', async () => {
    const aaplTransaction = TXNS.items[0]! as Transaction;
    const houseTransaction = TXNS.items[1]! as Transaction;
    const recentAaplTransactions = Array.from(
      { length: 8 },
      (_, index): Transaction => ({
        ...aaplTransaction,
        id: `t-recent-${index}`,
        executedAt: `2024-03-${String(20 - index).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    const olderHouseTransaction: Transaction = {
      ...houseTransaction,
      id: 't-house-older',
      executedAt: '2024-01-01T00:00:00.000Z',
    };
    const ledger = [...recentAaplTransactions, olderHouseTransaction];
    vi.mocked(listTransactions).mockImplementation(async (_portfolioId, params = {}) =>
      transactionPage(ledger, params),
    );

    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(vi.mocked(listTransactions)).toHaveBeenCalledWith(
        DEFAULT_PORTFOLIO_ID,
        {
          limit: 8,
          order: 'executedAt',
          source: undefined,
          includeSourceTags: true,
        },
        expect.anything(),
      ),
    );
    const holdings = await screen.findByRole('region', { name: 'Holdings' });
    await user.click(within(holdings).getByRole('button', { name: /Expand HOUSE transactions/i }));

    await waitFor(() =>
      expect(vi.mocked(listTransactions)).toHaveBeenCalledWith(
        DEFAULT_PORTFOLIO_ID,
        { assetId: HOUSE.asset.id, limit: 200 },
        expect.anything(),
      ),
    );
    expect(await within(holdings).findByText('Down payment')).toBeInTheDocument();
  });

  test('does not request a stale expanded asset after the active portfolio switches', async () => {
    const secondPortfolio = {
      id: 'p2',
      name: 'Second',
      visibility: 'private' as const,
      sortOrder: 1,
      isDefault: false,
      defaultPayFromCash: false,
      archivedAt: null,
    };
    vi.mocked(listPortfolios).mockResolvedValue({
      portfolios: [...PORTFOLIO_LIST.portfolios, secondPortfolio],
    });
    vi.mocked(getPortfolio).mockImplementation(async (portfolioId) =>
      portfolioId === secondPortfolio.id
        ? { ...PORTFOLIO, holdings: [HOUSE] }
        : { ...PORTFOLIO, holdings: [STOCK] },
    );

    function SwitchHarness() {
      const navigate = useNavigate();
      return (
        <>
          <button type="button" onClick={() => navigate('/portfolio?portfolio=p2')}>
            Switch portfolio
          </button>
          <PortfolioPage />
        </>
      );
    }

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/portfolio']}>
          <SwitchHarness />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const holdings = await screen.findByRole('region', { name: 'Holdings' });
    await user.click(within(holdings).getByRole('button', { name: /Expand AAPL transactions/i }));
    await waitFor(() =>
      expect(vi.mocked(listTransactions)).toHaveBeenCalledWith(
        DEFAULT_PORTFOLIO_ID,
        { assetId: STOCK.asset.id, limit: 200 },
        expect.anything(),
      ),
    );

    vi.mocked(listTransactions).mockClear();
    await user.click(screen.getByRole('button', { name: 'Switch portfolio' }));
    await waitFor(() =>
      expect(vi.mocked(listTransactions)).toHaveBeenCalledWith(
        secondPortfolio.id,
        expect.objectContaining({ order: 'executedAt' }),
        expect.anything(),
      ),
    );
    const secondHoldings = await screen.findByRole('region', { name: 'Holdings' });
    await waitFor(() =>
      expect(within(secondHoldings).getByRole('link', { name: 'HOUSE' })).toBeInTheDocument(),
    );
    expect(
      vi
        .mocked(listTransactions)
        .mock.calls.some(
          ([portfolioId, params]) =>
            portfolioId === secondPortfolio.id && params?.assetId === STOCK.asset.id,
        ),
    ).toBe(false);
  });

  test('expands a holding to reveal its transactions', async () => {
    const user = userEvent.setup();
    renderPage();
    const holdingsRegion = await screen.findByRole('region', { name: 'Holdings' });
    await waitFor(() =>
      expect(within(holdingsRegion).getByRole('link', { name: 'AAPL' })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Expand AAPL transactions/i }));

    // "Buy" also appears in the recent-transactions block — scope to the
    // expanded row (found via its edit button) to check this specific one.
    const editButton = screen.getByRole('button', { name: /Edit transaction from/i });
    expect(editButton).toBeInTheDocument();
    expect(within(editButton.closest('tr')!).getByText('Buy')).toBeInTheDocument();
  });

  test('390px uses action-complete cards for holdings and transaction ledgers', async () => {
    setViewportWidth(390);
    const user = userEvent.setup();
    renderPage();

    const holdings = await screen.findByRole('region', { name: 'Holdings' });
    await waitFor(() => expect(within(holdings).getByRole('link', { name: 'AAPL' })).toBeVisible());
    expect(within(holdings).queryByRole('table')).not.toBeInTheDocument();
    expect(holdings.querySelector('.bt-phone-card-list')).not.toBeNull();

    await user.click(within(holdings).getByRole('button', { name: /Expand AAPL transactions/i }));
    const edit = within(holdings).getByRole('button', { name: /Edit transaction from/i });
    expect(edit.closest('li')).not.toBeNull();

    await user.click(edit);
    expect(screen.getByRole('dialog', { name: 'Edit transaction' })).toHaveClass(
      'bt-dialog__panel--phone-sheet',
    );

    const recent = screen.getByRole('region', { name: 'Recent transactions' });
    expect(within(recent).queryByRole('table')).not.toBeInTheDocument();
    expect(recent.querySelector('.bt-phone-card-list')).not.toBeNull();
  });

  test('deletes a transaction through the inline confirm', async () => {
    const user = userEvent.setup();
    renderPage();
    const holdingsRegion = await screen.findByRole('region', { name: 'Holdings' });
    await waitFor(() =>
      expect(within(holdingsRegion).getByRole('link', { name: 'HOUSE' })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Expand HOUSE transactions/i }));
    // The down-payment note proves HOUSE's transaction is rendered.
    const region = screen.getByText('Down payment').closest('tr')!;
    await user.click(within(region).getByRole('button', { name: /Delete transaction from/i }));
    await user.click(screen.getByRole('button', { name: 'Yes' }));

    await waitFor(() =>
      // MIRRORCHAIN M5 (V5-P7 #685): the client now forwards `baseSeq` for
      // chain rows; a non-chain row simply passes `undefined`.
      expect(vi.mocked(deleteTransaction)).toHaveBeenCalledWith(DEFAULT_PORTFOLIO_ID, 't2', {
        baseSeq: undefined,
      }),
    );
  });

  test('a solvency-gate rejection surfaces the server guidance, not a generic retry (#300)', async () => {
    vi.mocked(deleteTransaction).mockRejectedValue(
      new ApiError(
        400,
        'CASH_LEDGER_WOULD_GO_NEGATIVE',
        'Deleting this transaction would overdraw your cash balance on a later date. Add cash or remove the dependent movements first.',
      ),
    );
    const user = userEvent.setup();
    renderPage();
    const holdingsRegion = await screen.findByRole('region', { name: 'Holdings' });
    await waitFor(() =>
      expect(within(holdingsRegion).getByRole('link', { name: 'HOUSE' })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Expand HOUSE transactions/i }));
    const region = screen.getByText('Down payment').closest('tr')!;
    await user.click(within(region).getByRole('button', { name: /Delete transaction from/i }));
    await user.click(screen.getByRole('button', { name: 'Yes' }));

    expect(await screen.findByText(/would overdraw your cash balance/i)).toBeInTheDocument();
    expect(screen.queryByText(/Could not delete the transaction/i)).not.toBeInTheDocument();
  });
});

// ─── Dialog opening ───────────────────────────────────────────────────────────

describe('PortfolioPage — dialogs', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  test('opens the transaction dialog from the header action', async () => {
    const user = userEvent.setup();
    renderPage();
    const holdingsRegion = await screen.findByRole('region', { name: 'Holdings' });
    await waitFor(() =>
      expect(within(holdingsRegion).getByRole('link', { name: 'AAPL' })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: '+ Transaction' }));
    expect(screen.getByRole('dialog', { name: /New transaction/i })).toBeInTheDocument();
  });

  test('honors the global trade intent by opening the transaction dialog', async () => {
    renderPage('/portfolio?create=trade');

    expect(await screen.findByRole('dialog', { name: /New transaction/i })).toBeInTheDocument();
  });

  test('opens the value-point editor for a custom holding', async () => {
    const user = userEvent.setup();
    renderPage();
    const holdingsRegion = await screen.findByRole('region', { name: 'Holdings' });
    await waitFor(() =>
      expect(within(holdingsRegion).getByRole('link', { name: 'HOUSE' })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Expand HOUSE transactions/i }));
    await user.click(screen.getByRole('button', { name: 'Edit value points' }));
    expect(screen.getByRole('dialog', { name: /Value points/i })).toBeInTheDocument();
  });
});

// ─── Top winners / losers (#120) ───────────────────────────────────────────────

const TSLA = {
  asset: {
    id: 'a2',
    symbol: 'TSLA',
    name: 'Tesla Inc.',
    exchange: 'NASDAQ',
    currency: 'USD' as const,
    type: 'stock' as const,
    isCustom: false,
  },
  quantity: 5,
  avgCost: 200,
  realizedPnl: 0,
  price: 240,
  marketValueEur: 1100,
  costBasisEur: 900,
  unrealizedPnlEur: 200,
  unrealizedPnlPct: 20,
  // Down on the day, but up overall — makes the metric toggle change both
  // membership (winners vs losers) and ordering.
  dayChangeEur: -50,
  dayChangePct: -4.5,
};

const PORTFOLIO_WITH_MOVERS = {
  baseCurrency: 'EUR' as const,
  holdings: [STOCK, HOUSE, TSLA],
  totals: TOTALS,
};

describe('PortfolioPage — top winners / losers', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO_WITH_MOVERS));

  test('ranks by day % by default, then re-ranks when the metric toggle switches to total P/L', async () => {
    const user = userEvent.setup();
    renderPage();
    const winnersLosers = await screen.findByRole('region', { name: 'Top winners and losers' });

    // Day % (default): AAPL is up 0.67% → winner. TSLA is down 4.5% → loser.
    // HOUSE has no day change and is excluded from this metric entirely.
    const winnersBox = within(winnersLosers).getByText('Top winners').closest('div')!;
    const losersBox = within(winnersLosers).getByText('Top losers').closest('div')!;
    expect(within(winnersBox).getByRole('link', { name: 'AAPL' })).toBeInTheDocument();
    expect(within(winnersBox).queryByRole('link', { name: 'HOUSE' })).not.toBeInTheDocument();
    expect(within(losersBox).getByRole('link', { name: 'TSLA' })).toBeInTheDocument();

    // Switch to total P/L: all three holdings are net positive, so TSLA moves
    // from losers to winners and HOUSE now appears too — ranked below TSLA.
    await user.click(within(winnersLosers).getByRole('button', { name: 'Total P/L' }));

    const winnersAfter = within(winnersLosers).getByText('Top winners').closest('div')!;
    const losersAfter = within(winnersLosers).getByText('Top losers').closest('div')!;
    const order = within(winnersAfter)
      .getAllByRole('link')
      .map((el) => el.textContent);
    expect(order).toEqual(['AAPL', 'TSLA', 'HOUSE']);
    expect(within(losersAfter).getByText('Nothing to show.')).toBeInTheDocument();
  });
});

// ─── Re-categorize banner (V3-P2) ─────────────────────────────────────────────

describe('PortfolioPage — re-categorize banner (V3-P2)', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  test('keeps a terminal background-probe failure invisible', async () => {
    vi.mocked(getRecategorizationStatus).mockRejectedValue(
      new ApiError(404, 'NOT_FOUND', 'status unavailable'),
    );
    renderPage();

    await screen.findByRole('region', { name: 'Holdings' });
    expect(screen.queryByText("This information isn't available.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Kategoriestatus|need categories/i)).not.toBeInTheDocument();
  });

  test('shows a contextual retry only for a background-probe outage', async () => {
    vi.mocked(getRecategorizationStatus).mockRejectedValue(
      new ApiError(503, 'UNAVAILABLE', 'status unavailable'),
    );
    renderPage();

    expect(
      await screen.findByText(
        "Couldn't check whether custom investments need categories. Please try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  test('stays hidden when nothing is pending', async () => {
    renderPage();
    // Wait for the page to settle, then confirm no banner rendered.
    await screen.findByRole('region', { name: 'Holdings' });
    expect(screen.queryByText(/need a category/i)).not.toBeInTheDocument();
  });

  test('shows when pending > 0 and dismiss calls the endpoint then hides it', async () => {
    // First status read reports pending; the refetch after dismiss returns 0.
    vi.mocked(getRecategorizationStatus).mockResolvedValueOnce({ pending: 2 });
    const user = userEvent.setup();
    renderPage();

    const banner = await screen.findByText(/need a category/i);
    expect(banner).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(vi.mocked(dismissRecategorization)).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(screen.queryByText(/need a category/i)).not.toBeInTheDocument());
  });
});

// ─── Recent transactions (#120) ────────────────────────────────────────────────

describe('PortfolioPage — recent transactions', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  test('lists the most recent transactions newest-first', async () => {
    renderPage();
    const recent = await screen.findByRole('region', { name: 'Recent transactions' });

    // t2 (HOUSE, 2024-02-01) is newer than t1 (AAPL, 2024-01-15).
    const rows = within(recent).getAllByRole('row').slice(1); // drop the header row
    expect(within(rows[0]!).getByRole('link', { name: 'HOUSE' })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('link', { name: 'AAPL' })).toBeInTheDocument();
  });
});

// ─── Intraday dense 1D/1W curve (#556) ────────────────────────────────────────

describe('PortfolioPage — intraday 1D/1W dense curve (#556)', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const INTRADAY_HISTORY = {
    range: '1D' as const,
    baseCurrency: 'EUR' as const,
    // A 1D curve starts with the prior daily close and then uses today's exact
    // intraday instants. Four points stand in for the ≥20 the API emits; the
    // unit here is the client's time mapping.
    points: [
      { date: '2024-06-15', time: '2024-06-15T23:59:59.999Z', valueEur: 326000 },
      { date: '2024-06-16', time: '2024-06-16T09:00:00.000Z', valueEur: 326000 },
      { date: '2024-06-16', time: '2024-06-16T09:15:00.000Z', valueEur: 326100 },
      { date: '2024-06-16', time: '2024-06-16T09:30:00.000Z', valueEur: 326350 },
    ],
    performance: [
      { date: '2024-06-15', time: '2024-06-15T23:59:59.999Z', pct: 0 },
      { date: '2024-06-16', time: '2024-06-16T09:00:00.000Z', pct: 0 },
      { date: '2024-06-16', time: '2024-06-16T09:15:00.000Z', pct: 0.03 },
      { date: '2024-06-16', time: '2024-06-16T09:30:00.000Z', pct: 0.11 },
    ],
  };

  test('keys intraday points on their UNIX-second instant, not the shared day', async () => {
    const user = userEvent.setup();
    vi.mocked(getPortfolioHistory).mockResolvedValue(INTRADAY_HISTORY);
    renderPage();

    // Select the 1D span (the dense-curve range).
    await user.click(await screen.findByRole('button', { name: '1D' }));

    // Each point is plotted at its exact instant (a numeric UNIX-second `Time`),
    // preserving the prior-close anchor and today's real curve rather than
    // collapsing the same-day points onto one business-day mark.
    await waitFor(() =>
      expect(chartMocks.setData).toHaveBeenCalledWith([
        { time: sec('2024-06-15T23:59:59.999Z'), value: 326000 },
        { time: sec('2024-06-16T09:00:00.000Z'), value: 326000 },
        { time: sec('2024-06-16T09:15:00.000Z'), value: 326100 },
        { time: sec('2024-06-16T09:30:00.000Z'), value: 326350 },
      ]),
    );
  });

  test('other (daily) ranges still key on the business-day string', async () => {
    // The default 1M fetch returns the daily fixture (no `time`) — the mapping
    // must leave those keyed on the ISO day, unchanged from before #556.
    renderPage();
    await waitFor(() =>
      expect(chartMocks.setData).toHaveBeenCalledWith([
        { time: '2024-05-01', value: 300000 },
        { time: '2024-06-01', value: 321350 },
      ]),
    );
  });
});

// ─── Recent-transactions source filter (V5-P0c + V5-P6b) ─────────────────────

describe('PortfolioPage — recent-transactions source filter', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  test('no filter when every row is manual (anti-bloat — chip does not earn its place)', async () => {
    // The default TXNS fixture is all-manual; the chip must not appear.
    renderPage();
    const recent = await screen.findByRole('region', { name: 'Recent transactions' });
    expect(within(recent).queryByLabelText('Source')).not.toBeInTheDocument();
  });

  test('renders the full-ledger newest eight and refetches a selected source at the boundary', async () => {
    const base = TXNS.items[0]! as Transaction;
    const transaction = (
      id: string,
      symbol: string,
      source: string,
      executedAt: string,
    ): Transaction => ({
      ...base,
      id,
      assetId: `asset-${id}`,
      source,
      executedAt,
      asset: { ...base.asset, id: `asset-${id}`, symbol, name: symbol },
    });
    const ledger = [
      ...Array.from({ length: 9 }, (_, index) =>
        transaction(
          `manual-${index}`,
          `M${index}`,
          'manual',
          `2024-07-${String(20 - index).padStart(2, '0')}T00:00:00.000Z`,
        ),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        transaction(
          `standing-${index}`,
          `S${index}`,
          'standing-order',
          `2024-06-${String(20 - index).padStart(2, '0')}T00:00:00.000Z`,
        ),
      ),
      // Created/newest id, deliberately backdated: an id-ordered limit would
      // displace a genuinely recent execution with this row.
      transaction('zz-backdated', 'BACKDATED', 'manual', '2024-01-01T00:00:00.000Z'),
    ];
    vi.mocked(listTransactions).mockImplementation(async (_portfolioId, params = {}) =>
      transactionPage(ledger, params),
    );
    const fullLedgerComputation = [...ledger].sort(
      (left, right) =>
        right.executedAt.localeCompare(left.executedAt) || right.id.localeCompare(left.id),
    );
    const user = userEvent.setup();
    renderPage();

    const recent = await screen.findByRole('region', { name: 'Recent transactions' });
    const filter = within(recent).getByLabelText('Source');
    expect(within(filter).getByRole('option', { name: 'All sources' })).toBeInTheDocument();
    expect(within(filter).getByRole('option', { name: 'Manual entry' })).toBeInTheDocument();
    expect(within(filter).getByRole('option', { name: 'Standing order' })).toBeInTheDocument();
    expect(
      within(recent)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(fullLedgerComputation.slice(0, 8).map((row) => row.asset.symbol));
    expect(within(recent).queryByText('BACKDATED')).not.toBeInTheDocument();
    expect(vi.mocked(listTransactions)).toHaveBeenCalledWith(
      DEFAULT_PORTFOLIO_ID,
      {
        limit: 8,
        order: 'executedAt',
        source: undefined,
        includeSourceTags: true,
      },
      expect.anything(),
    );

    await user.selectOptions(filter, 'standing-order');
    const standingExpected = fullLedgerComputation
      .filter((row) => row.source === 'standing-order')
      .slice(0, 8);
    await waitFor(() =>
      expect(
        within(recent)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(standingExpected.map((row) => row.asset.symbol)),
    );
    expect(vi.mocked(listTransactions)).toHaveBeenCalledWith(
      DEFAULT_PORTFOLIO_ID,
      {
        limit: 8,
        order: 'executedAt',
        source: 'standing-order',
        includeSourceTags: true,
      },
      expect.anything(),
    );
  });
});
