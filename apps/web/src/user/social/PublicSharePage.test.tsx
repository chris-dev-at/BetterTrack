import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import type { SharedLinkResponse } from '@bettertrack/contracts';

vi.mock('../../lib/socialApi', () => ({
  resolveShareLink: vi.fn(),
}));

// lightweight-charts uses a canvas API jsdom doesn't implement (same mock shape
// as SharedPortfolioPage.test.tsx / PortfolioPage.test.tsx).
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

import { resolveShareLink } from '../../lib/socialApi';
import { PublicSharePage } from './PublicSharePage';

const PID = '00000000-0000-0000-0000-000000000001';
const ASSET_ID = '00000000-0000-0000-0000-000000000002';

const portfolioLink: SharedLinkResponse = {
  kind: 'portfolio',
  portfolio: {
    portfolioId: PID,
    name: "Jane's Main",
    owner: { id: '00000000-0000-0000-0000-000000000003', username: 'jane' },
    baseCurrency: 'EUR',
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
          currency: 'EUR',
          type: 'stock',
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
      range: 'MAX',
      points: [
        { date: '2024-06-01', valueEur: 900 },
        { date: '2024-06-02', valueEur: 1000 },
      ],
    },
  },
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/s/tok_abc']}>
        <Routes>
          <Route path="/s/:token" element={<PublicSharePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PublicSharePage (/s/:token)', () => {
  test('renders the BetterTrack(Web) wordmark, the value/performance chart, and holdings', async () => {
    vi.mocked(resolveShareLink).mockResolvedValue(portfolioLink);
    renderPage();

    await waitFor(() => expect(screen.getByText("Jane's Main")).toBeInTheDocument());

    // Wordmark: "Better" + "Track" + the Web edition label (App is reserved for
    // the native client).
    expect(screen.getByText('Better')).toBeInTheDocument();
    expect(screen.getByText('Track')).toBeInTheDocument();
    expect(screen.getByText('Web')).toBeInTheDocument();

    // The value/performance chart is wired in from the (already public_link-gated)
    // payload's history series.
    expect(screen.getByRole('img', { name: /value over time/i })).toBeInTheDocument();
    expect(chartMocks.createChart).toHaveBeenCalled();

    // Holdings still render, and the resolve went through the token client.
    expect(screen.getByText('BAYN.DE')).toBeInTheDocument();
    expect(resolveShareLink).toHaveBeenCalledWith('tok_abc', expect.any(AbortSignal));
  });

  test('shows the not-available copy and no chart when the link is revoked/unknown', async () => {
    vi.mocked(resolveShareLink).mockRejectedValue(new Error('not found'));
    renderPage();

    await waitFor(() => expect(screen.getByText(/no longer available/i)).toBeInTheDocument());
    expect(screen.queryByRole('img', { name: /value over time/i })).not.toBeInTheDocument();
  });
});
