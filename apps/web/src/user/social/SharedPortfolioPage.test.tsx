import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../../lib/socialApi', () => ({
  getSharedPortfolio: vi.fn(),
}));

// lightweight-charts uses a canvas API jsdom doesn't implement (same shape as
// AssetDetailPage.test.tsx / PortfolioPage.test.tsx).
const chartMocks = vi.hoisted(() => {
  const setData = vi.fn();
  const remove = vi.fn();
  const fitContent = vi.fn();
  const applyOptions = vi.fn();
  const addSeries = vi.fn((_def: unknown, _opts?: unknown) => ({ setData, applyOptions: vi.fn() }));
  const createChart = vi.fn(() => ({
    addSeries,
    applyOptions,
    timeScale: () => ({ fitContent }),
    remove,
  }));
  return { setData, remove, fitContent, applyOptions, addSeries, createChart };
});

vi.mock('lightweight-charts', () => ({
  createChart: chartMocks.createChart,
  AreaSeries: 'AreaSeries',
  LineSeries: 'LineSeries',
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
}));

import { getSharedPortfolio } from '../../lib/socialApi';
import { SharedPortfolioPage } from './SharedPortfolioPage';

const PORTFOLIO_ID = '00000000-0000-0000-0000-000000000001';

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/social/shared-with-me/${PORTFOLIO_ID}`]}>
        <Routes>
          <Route path="/social/shared-with-me/:portfolioId" element={<SharedPortfolioPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ASSET_ID = '00000000-0000-0000-0000-000000000002';

const detail = {
  portfolioId: PORTFOLIO_ID,
  name: "Jane's Main",
  owner: { id: '00000000-0000-0000-0000-000000000003', username: 'jane' },
  baseCurrency: 'EUR' as const,
  totals: {
    marketValueEur: 1000,
    investedEur: 900,
    unrealizedPnlEur: 100,
    unrealizedPnlPct: 11.1,
    dayChangeEur: 5,
    dayChangePct: 0.5,
    cashEur: 0,
    totalValueEur: 1000,
  },
  holdings: [
    {
      asset: {
        id: ASSET_ID,
        symbol: 'BAYN.DE',
        name: 'Bayer AG',
        exchange: 'XETRA',
        currency: 'EUR' as const,
        type: 'stock' as const,
        isCustom: false,
      },
      quantity: 10,
      avgCost: 25,
      realizedPnl: 0,
      price: 28.5,
      marketValueEur: 285,
      costBasisEur: 250,
      unrealizedPnlEur: 35,
      unrealizedPnlPct: 14,
      dayChangeEur: 2,
      dayChangePct: 0.7,
    },
  ],
  history: {
    range: 'MAX' as const,
    points: [{ date: '2024-06-01', valueEur: 1000 }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SharedPortfolioPage', () => {
  test('renders a read-only overview with totals and holdings, no edit affordances', async () => {
    vi.mocked(getSharedPortfolio).mockResolvedValue(detail);
    renderPage();

    await waitFor(() => expect(screen.getByText("Jane's Main")).toBeInTheDocument());
    expect(screen.getByText(/Shared by jane/i)).toBeInTheDocument();
    expect(screen.getAllByText('BAYN.DE').length).toBeGreaterThan(0);
    expect(getSharedPortfolio).toHaveBeenCalledWith(PORTFOLIO_ID, expect.any(AbortSignal));

    // No add/edit/delete affordances anywhere on the page.
    expect(screen.queryByRole('button', { name: /record/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
  });

  test('shows an empty state when the shared portfolio has no holdings', async () => {
    vi.mocked(getSharedPortfolio).mockResolvedValue({
      ...detail,
      holdings: [],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Nothing to show yet')).toBeInTheDocument());
  });

  test('shows an error affordance when the fetch fails', async () => {
    vi.mocked(getSharedPortfolio).mockRejectedValue(new Error('boom'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load this shared portfolio/i)).toBeInTheDocument(),
    );
  });
});
