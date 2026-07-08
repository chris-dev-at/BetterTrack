import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ─── API mocks ────────────────────────────────────────────────────────────────

vi.mock('../../lib/assetApi', () => ({
  getAssetDetail: vi.fn(),
  getAssetQuote: vi.fn(),
  getAssetHistory: vi.fn(),
}));

vi.mock('../../lib/workboardApi', () => ({
  useWatchlistMembership: vi.fn(),
  useAddToWatchlist: vi.fn(),
}));

// lightweight-charts uses a canvas API jsdom doesn't implement; mock it out
// exactly as the PriceChart tests do (same shape, different file).
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

import { getAssetDetail, getAssetHistory, getAssetQuote } from '../../lib/assetApi';
import { useAddToWatchlist, useWatchlistMembership } from '../../lib/workboardApi';
import { AssetDetailPage } from './AssetDetailPage';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ASSET_ID = '00000000-0000-0000-0000-000000000001';

const baseDetail = {
  asset: {
    id: ASSET_ID,
    providerId: 'yahoo',
    providerRef: 'BAYN.DE',
    symbol: 'BAYN.DE',
    name: 'Bayer AG',
    exchange: 'XETRA',
    currency: 'EUR',
    type: 'stock' as const,
    isCustom: false,
  },
  quote: {
    price: 28.5,
    currency: 'EUR',
    prevClose: 27.8,
    dayChangePct: 2.5,
    asOf: '2024-06-01T12:00:00.000Z',
  },
  stale: false,
  asOf: '2024-06-01T12:00:00.000Z',
  baseCurrency: 'EUR',
};

const baseHistory = {
  range: '1M' as const,
  interval: '30m' as const,
  points: [
    { time: '2024-05-01T00:00:00.000Z', close: 27.0 },
    { time: '2024-06-01T00:00:00.000Z', close: 28.5 },
  ],
  stale: false,
  asOf: '2024-06-01T12:00:00.000Z',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
}

function renderPage(assetId = ASSET_ID) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[`/assets/${assetId}`]}>
        <Routes>
          <Route path="/assets/:id" element={<AssetDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── Watchlist hook mocks (shared with search results, #256) ─────────────────

function makeWatchlistMembership(watchedIds: string[] = []) {
  return {
    watchedIds: new Set(watchedIds),
    data: undefined,
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useWatchlistMembership>;
}

const addToWatchlistMutate = vi.fn();

function makeAddToWatchlistMutation(
  overrides: Partial<{ isPending: boolean; isError: boolean; isSuccess: boolean }> = {},
) {
  return {
    mutate: addToWatchlistMutate,
    isPending: false,
    isError: false,
    isSuccess: false,
    ...overrides,
  } as unknown as ReturnType<typeof useAddToWatchlist>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAssetDetail).mockResolvedValue(baseDetail);
  vi.mocked(getAssetQuote).mockResolvedValue({
    quote: baseDetail.quote,
    stale: false,
    asOf: '2024-06-01T12:00:00.000Z',
  });
  vi.mocked(getAssetHistory).mockResolvedValue(baseHistory);
  vi.mocked(useWatchlistMembership).mockReturnValue(makeWatchlistMembership());
  vi.mocked(useAddToWatchlist).mockReturnValue(makeAddToWatchlistMutation());
});

describe('AssetDetailPage — header rendering', () => {
  test('shows asset name, symbol and exchange', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(screen.getByText('BAYN.DE')).toBeInTheDocument();
    expect(screen.getByText('XETRA')).toBeInTheDocument();
  });

  test('shows native price with currency symbol', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    // Price 28.50 EUR should be rendered via MoneyText — check the formatted value
    expect(screen.getByText(/28/)).toBeInTheDocument();
    expect(screen.getByText(/2,5/)).toBeInTheDocument(); // day change pct
  });

  test('shows stale marker when provider is degraded', async () => {
    vi.mocked(getAssetDetail).mockResolvedValue({ ...baseDetail, stale: true });
    renderPage();
    await waitFor(() => expect(screen.getByText('Stale')).toBeInTheDocument());
  });

  test('shows EUR-converted price for foreign assets', async () => {
    vi.mocked(getAssetDetail).mockResolvedValue({
      ...baseDetail,
      asset: { ...baseDetail.asset, symbol: 'NVDA', currency: 'USD' },
      quote: { ...baseDetail.quote, price: 150, currency: 'USD' },
      eurPrice: 138.89,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    // eurAmount shows in parentheses via MoneyText
    expect(screen.getByText(/138/)).toBeInTheDocument();
  });

  test('renders error state when API fails', async () => {
    vi.mocked(getAssetDetail).mockRejectedValue(new Error('not found'));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Could not load asset details/i)).toBeInTheDocument(),
    );
  });

  test('shows the unofficial/delayed market-data disclaimer', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(
      screen.getByText(
        'Market data comes from an unofficial source and may be delayed or inaccurate.',
      ),
    ).toBeInTheDocument();
  });
});

describe('AssetDetailPage — range switching', () => {
  test('renders all six range buttons', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    for (const r of ['1D', '1W', '1M', '3M', '1Y', 'Max']) {
      expect(screen.getByRole('button', { name: r })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: '6M' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '5Y' })).not.toBeInTheDocument();
  });

  test('switching to 3M fetches ~3 months of history', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '3M' }));
    await waitFor(() =>
      expect(vi.mocked(getAssetHistory)).toHaveBeenCalledWith(ASSET_ID, '3M', expect.anything()),
    );
  });

  test('switching range triggers a new history fetch with the correct range', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    // Default range is 1M, so initial history call uses '1M'.
    expect(vi.mocked(getAssetHistory)).toHaveBeenCalledWith(ASSET_ID, '1M', expect.anything());

    // Click 1Y — should fire a new call with '1Y'.
    await user.click(screen.getByRole('button', { name: '1Y' }));
    await waitFor(() =>
      expect(vi.mocked(getAssetHistory)).toHaveBeenCalledWith(ASSET_ID, '1Y', expect.anything()),
    );
  });

  test('clicking "Max" maps to the "MAX" history range for the API', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Max' }));
    await waitFor(() =>
      expect(vi.mocked(getAssetHistory)).toHaveBeenCalledWith(ASSET_ID, 'MAX', expect.anything()),
    );
  });

  test('custom asset renders in step-line mode', async () => {
    vi.mocked(getAssetDetail).mockResolvedValue({
      ...baseDetail,
      asset: { ...baseDetail.asset, isCustom: true, providerId: 'manual' },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    // step mode uses LineSeries (not AreaSeries)
    await waitFor(() => expect(chartMocks.addSeries.mock.calls[0]?.[0]).toBe('LineSeries'));
  });
});

describe('AssetDetailPage — quick actions (§13.2)', () => {
  test('quick actions render above the price chart, not buried at the bottom', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    const watchlistIcon = screen.getByRole('button', { name: 'Add BAYN.DE to watchlist' });
    const chart = screen.getByLabelText('Price chart for BAYN.DE');

    // DOCUMENT_POSITION_FOLLOWING (4) on `chart` relative to `watchlistIcon`
    // means the icon comes first in document order — i.e. above the chart.
    expect(watchlistIcon.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test('no label reading "Workboard" remains on the asset page', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(screen.queryByText(/Workboard/i)).not.toBeInTheDocument();
  });

  test('watchlist icon is unfilled and idle when the asset is not yet watched', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    const icon = screen.getByRole('button', { name: 'Add BAYN.DE to watchlist' });
    expect(icon).toHaveAttribute('aria-pressed', 'false');
  });

  test('watchlist icon is state-aware: filled from first render when already watched', async () => {
    vi.mocked(useWatchlistMembership).mockReturnValue(makeWatchlistMembership([ASSET_ID]));
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    const icon = screen.getByRole('button', { name: 'BAYN.DE is on your watchlist' });
    expect(icon).toHaveAttribute('aria-pressed', 'true');
  });

  test('clicking the watchlist icon adds the asset in place, no navigation', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add BAYN.DE to watchlist' }));

    expect(addToWatchlistMutate).toHaveBeenCalledWith(ASSET_ID);
    // Still on the asset page — the click never redirects.
    expect(screen.getByText('Bayer AG')).toBeInTheDocument();
  });

  test('a second click on an already-watched asset does not fire another add', async () => {
    vi.mocked(useWatchlistMembership).mockReturnValue(makeWatchlistMembership([ASSET_ID]));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'BAYN.DE is on your watchlist' }));
    expect(addToWatchlistMutate).not.toHaveBeenCalled();
  });

  test('shows an error alert only when the add mutation genuinely fails', async () => {
    vi.mocked(useAddToWatchlist).mockReturnValue(makeAddToWatchlistMutation({ isError: true }));
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(screen.getByText(/Failed to add to Watchlist/i)).toBeInTheDocument();
  });

  test('renders Portfolio and Conglomerate quick actions near the top', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '+ Portfolio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Conglomerate' })).toBeInTheDocument();
  });
});
