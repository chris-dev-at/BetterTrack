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
    renderPage();
    await waitFor(() => expect(screen.getByText(/Your portfolio is empty/i)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Search for an asset/i })).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByRole('link', { name: 'AAPL' })).toBeInTheDocument());
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'HOUSE' })).toBeInTheDocument();
    expect(screen.getByText('Vienna Apartment')).toBeInTheDocument();
    // Native avg cost is shown in the asset's currency ($).
    expect(screen.getByText('100,00 $')).toBeInTheDocument();
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

// ─── Expandable rows + transactions ───────────────────────────────────────────

describe('PortfolioPage — expandable rows', () => {
  beforeEach(() => vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO));

  test('expands a holding to reveal its transactions', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('link', { name: 'AAPL' })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Expand AAPL transactions/i }));

    // The HOUSE note proves only the expanded asset's rows show — expand it too.
    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit transaction from/i })).toBeInTheDocument();
  });

  test('deletes a transaction through the inline confirm', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('link', { name: 'HOUSE' })).toBeInTheDocument());

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
    await waitFor(() => expect(screen.getByRole('link', { name: 'AAPL' })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '+ Transaction' }));
    expect(screen.getByRole('dialog', { name: /Record transaction/i })).toBeInTheDocument();
  });

  test('opens the value-point editor for a custom holding', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('link', { name: 'HOUSE' })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Expand HOUSE transactions/i }));
    await user.click(screen.getByRole('button', { name: 'Edit value points' }));
    expect(screen.getByRole('dialog', { name: /Value points/i })).toBeInTheDocument();
  });
});
