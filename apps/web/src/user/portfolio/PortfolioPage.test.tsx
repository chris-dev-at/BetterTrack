import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  getPortfolio: vi.fn(),
  getPortfolioHistory: vi.fn(),
  listTransactions: vi.fn(),
  deleteTransaction: vi.fn(),
  createTransactions: vi.fn(),
  updateTransaction: vi.fn(),
  createCustomAsset: vi.fn(),
  getValuePoints: vi.fn(),
  putValuePoints: vi.fn(),
}));

vi.mock('../../lib/searchApi', () => ({ searchAssets: vi.fn() }));

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

import {
  deleteTransaction,
  getPortfolio,
  getPortfolioHistory,
  getValuePoints,
  listPortfolios,
  listTransactions,
} from '../../lib/portfolioApi';
import { PortfolioPage } from './PortfolioPage';

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

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPortfolios).mockResolvedValue(PORTFOLIO_LIST);
  vi.mocked(getPortfolioHistory).mockResolvedValue(HISTORY);
  vi.mocked(listTransactions).mockResolvedValue(TXNS);
  vi.mocked(deleteTransaction).mockResolvedValue(undefined);
  vi.mocked(getValuePoints).mockResolvedValue({ points: [] });
});

// ─── Empty / error ──────────────────────────────────────────────────────────

describe('PortfolioPage — empty & error states', () => {
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
    // 321350 → "321.350,00 €" (de-AT, symbol-last).
    expect(within(totals).getByText('321.350,00 €')).toBeInTheDocument();
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
    // The by-type donut groups the custom asset under "Custom".
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.getByText('Stocks')).toBeInTheDocument();
  });
});

// ─── Chart overlay (#122) ─────────────────────────────────────────────────────

describe('PortfolioPage — asset overlay on the value chart', () => {
  const HISTORY_WITH_ASSETS = {
    ...HISTORY,
    assets: [
      {
        assetId: 'a1',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        currency: 'USD' as const,
        points: [
          { date: '2024-05-01', close: 150 },
          { date: '2024-06-01', close: 155 },
        ],
      },
    ],
  };

  beforeEach(() => {
    vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO);
    vi.mocked(getPortfolioHistory).mockImplementation((_portfolioId, _range, overlay) =>
      Promise.resolve(overlay ? HISTORY_WITH_ASSETS : HISTORY),
    );
  });

  test('toggling "Overlay assets" refetches with overlay=true and shows the asset legend', async () => {
    const user = userEvent.setup();
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Overlay assets' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(vi.mocked(getPortfolioHistory)).toHaveBeenCalledWith(
      DEFAULT_PORTFOLIO_ID,
      '1M',
      false,
      expect.anything(),
    );

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(vi.mocked(getPortfolioHistory)).toHaveBeenCalledWith(
        DEFAULT_PORTFOLIO_ID,
        '1M',
        true,
        expect.anything(),
      ),
    );
    // The overlay asset's legend chip appears next to the chart ("AAPL" also
    // exists in the holdings table / donut legend, so scope to the section).
    const section = screen.getByRole('region', { name: 'Value over time' });
    await waitFor(() => expect(within(section).getByText('AAPL')).toBeInTheDocument());

    // Toggling off returns to the plain curve (no overlay legend).
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(within(section).queryByText('AAPL')).not.toBeInTheDocument());
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
      expect(vi.mocked(deleteTransaction)).toHaveBeenCalledWith(DEFAULT_PORTFOLIO_ID, 't2'),
    );
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
    expect(screen.getByRole('dialog', { name: /Record transaction/i })).toBeInTheDocument();
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
