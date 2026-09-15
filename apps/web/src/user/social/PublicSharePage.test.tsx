import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import { ApiError } from '../../lib/apiClient';
import { defaultProfileIconIdFor } from '../components/profileIcons';
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
    expect(await screen.findByRole('img', { name: /value over time/i })).toBeInTheDocument();
    expect(chartMocks.createChart).toHaveBeenCalled();

    // Holdings still render, and the resolve went through the token client.
    expect(screen.getByText('BAYN.DE')).toBeInTheDocument();
    expect(resolveShareLink).toHaveBeenCalledWith('tok_abc', expect.any(AbortSignal));
  });

  test('shows the not-available copy and no chart when the link is revoked/unknown', async () => {
    vi.mocked(resolveShareLink).mockRejectedValue(new ApiError(404, 'LINK_NOT_FOUND', 'not found'));
    renderPage();

    await waitFor(() => expect(screen.getByText(/no longer available/i)).toBeInTheDocument());
    expect(screen.queryByRole('img', { name: /value over time/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  test.each([0, 500])(
    'shows a retryable unavailable state for status %i without declaring the link dead',
    async (status) => {
      vi.mocked(resolveShareLink)
        .mockRejectedValueOnce(
          new ApiError(status, status === 0 ? 'NETWORK_ERROR' : 'UNKNOWN', 'unavailable'),
        )
        .mockResolvedValueOnce(portfolioLink);
      const user = userEvent.setup();
      renderPage();

      expect(await screen.findByText(/temporarily unavailable/i)).toBeInTheDocument();
      expect(screen.queryByText(/no longer available/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /try again/i }));

      expect(await screen.findByText("Jane's Main")).toBeInTheDocument();
      expect(resolveShareLink).toHaveBeenCalledTimes(2);
    },
  );
});

/** The curated icon a rendered avatar actually painted (inert `data-icon-id`). */
function avatarIconId(container: HTMLElement): string | null | undefined {
  return container.querySelector('.bt-avatar svg[data-icon-id]')?.getAttribute('data-icon-id');
}

const OWNER_ID = '00000000-0000-0000-0000-000000000003';

const conglomerateLink: SharedLinkResponse = {
  kind: 'conglomerate',
  conglomerate: {
    conglomerateId: '00000000-0000-0000-0000-000000000004',
    name: 'Dividend core',
    description: null,
    status: 'active',
    owner: { id: OWNER_ID, username: 'jane', profileIcon: 'crown' },
    positions: [
      {
        kind: 'asset',
        assetId: ASSET_ID,
        weightPct: 100,
        sortOrder: 0,
        asset: { symbol: 'BAYN.DE', name: 'Bayer AG', currency: 'EUR', type: 'stock' },
      },
    ],
  },
};

const watchlistLink: SharedLinkResponse = {
  kind: 'watchlist',
  watchlist: {
    watchlistId: '00000000-0000-0000-0000-000000000005',
    name: 'Watching',
    owner: { id: OWNER_ID, username: 'jane', profileIcon: 'panda' },
    items: [],
  },
};

describe('PublicSharePage — the owner has a face, logged out (§6.9)', () => {
  test.each([
    [
      'portfolio',
      {
        ...portfolioLink,
        portfolio: {
          ...portfolioLink.portfolio,
          owner: { ...portfolioLink.portfolio.owner, profileIcon: 'fox' as const },
        },
      } as SharedLinkResponse,
      'fox',
    ],
    ['conglomerate', conglomerateLink, 'crown'],
    ['watchlist', watchlistLink, 'panda'],
  ])('renders the owner’s curated icon on a %s link', async (_kind, link, expected) => {
    vi.mocked(resolveShareLink).mockResolvedValue(link);
    const { container } = renderPage();

    await waitFor(() => expect(avatarIconId(container)).toBe(expected));
    // The page still asks the token endpoint for exactly what it always did —
    // the icon rides along on the payload the link already returned.
    expect(resolveShareLink).toHaveBeenCalledTimes(1);
    expect(resolveShareLink).toHaveBeenCalledWith('tok_abc', expect.any(AbortSignal));
  });

  test('falls back to the deterministic default when the owner never picked one', async () => {
    vi.mocked(resolveShareLink).mockResolvedValue(portfolioLink);
    const { container } = renderPage();

    await waitFor(() => expect(screen.getByText("Jane's Main")).toBeInTheDocument());
    expect(avatarIconId(container)).toBe(defaultProfileIconIdFor('jane'));
  });
});
