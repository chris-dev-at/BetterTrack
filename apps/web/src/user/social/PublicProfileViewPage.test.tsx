import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import type { PublicProfileResponse, SharedLinkResponse } from '@bettertrack/contracts';

vi.mock('../../lib/socialApi', () => ({
  getPublicProfile: vi.fn(),
  getPublicProfileItem: vi.fn(),
}));

// lightweight-charts uses a canvas API jsdom doesn't implement (same mock shape
// as SharedPortfolioPage.test.tsx).
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

import { getPublicProfile, getPublicProfileItem } from '../../lib/socialApi';
import { PublicProfileViewPage } from './PublicProfileViewPage';

const PID = '00000000-0000-0000-0000-000000000001';
const ASSET_ID = '00000000-0000-0000-0000-000000000002';

const profile: PublicProfileResponse = {
  userId: '00000000-0000-0000-0000-000000000003',
  username: 'alice',
  bio: 'Long-term investor',
  followerCount: 0,
  portfolios: [{ portfolioId: PID, name: 'Main', totalValueEur: 1000 }],
  conglomerates: [],
  watchlists: [],
};

const portfolioItem: SharedLinkResponse = {
  kind: 'portfolio',
  portfolio: {
    portfolioId: PID,
    name: 'Main',
    owner: { id: '00000000-0000-0000-0000-000000000003', username: 'alice' },
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
      <MemoryRouter initialEntries={['/u/alice']}>
        <Routes>
          <Route path="/u/:username" element={<PublicProfileViewPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PublicProfileViewPage (/u/:username)', () => {
  test('shows the wordmark and, on drill-in, the portfolio value/performance chart', async () => {
    vi.mocked(getPublicProfile).mockResolvedValue(profile);
    vi.mocked(getPublicProfileItem).mockResolvedValue(portfolioItem);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('@alice')).toBeInTheDocument());

    // Wordmark: "Better" + "Track" + the Web edition label.
    expect(screen.getByText('Better')).toBeInTheDocument();
    expect(screen.getByText('Track')).toBeInTheDocument();
    expect(screen.getByText('Web')).toBeInTheDocument();

    // The drill-in is collapsed → the item detail is not fetched until expanded.
    expect(getPublicProfileItem).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Main/i }));

    // Expanding fetches the read-only detail and renders its value/performance
    // chart (served behind the same public_link gate as the listing).
    await waitFor(() =>
      expect(screen.getByRole('img', { name: /value over time/i })).toBeInTheDocument(),
    );
    expect(getPublicProfileItem).toHaveBeenCalledWith(
      'alice',
      'portfolio',
      PID,
      expect.any(AbortSignal),
    );
    expect(chartMocks.createChart).toHaveBeenCalled();
    expect(screen.getByText('BAYN.DE')).toBeInTheDocument();
  });
});
