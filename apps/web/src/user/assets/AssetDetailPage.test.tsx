import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  listWatchlists: vi.fn(),
  WATCHLISTS_QUERY_KEY: ['workboard', 'watchlists'],
}));

vi.mock('../../lib/marketIntelApi', () => ({
  ASSET_DIVIDENDS_QUERY_KEY: (id: string) => ['asset', id, 'intel', 'dividends'],
  ASSET_EARNINGS_QUERY_KEY: (id: string) => ['asset', id, 'intel', 'earnings'],
  ASSET_SPLITS_QUERY_KEY: (id: string) => ['asset', id, 'intel', 'splits'],
  ASSET_NEWS_QUERY_KEY: (id: string) => ['asset', id, 'intel', 'news'],
  getAssetDividends: vi.fn(),
  getAssetEarnings: vi.fn(),
  getAssetSplits: vi.fn(),
  getAssetNews: vi.fn(),
}));

// lightweight-charts uses a canvas API jsdom doesn't implement; mock it out
// exactly as the PriceChart tests do (same shape, different file).
const chartMocks = vi.hoisted(() => {
  const setData = vi.fn();
  const remove = vi.fn();
  const fitContent = vi.fn();
  const applyOptions = vi.fn();
  const addSeries = vi.fn((_def: unknown, _opts?: unknown) => ({
    setData,
    update: vi.fn(),
    applyOptions: vi.fn(),
  }));
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
import {
  getAssetDividends,
  getAssetEarnings,
  getAssetNews,
  getAssetSplits,
} from '../../lib/marketIntelApi';
import { useAddToWatchlist, useWatchlistMembership } from '../../lib/workboardApi';
import { AssetDetailPage } from './AssetDetailPage';

const UNAVAILABLE_EARNINGS = { available: false as const, next: null, recent: [] };
const UNAVAILABLE_SPLITS = { available: false as const, history: [], upcoming: [] };
const UNAVAILABLE_NEWS = { available: false as const, headlines: [] };

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
  // Dividends default to the "unavailable" shape (gate off) — the block hides.
  vi.mocked(getAssetDividends).mockResolvedValue({
    available: false,
    currency: null,
    history: [],
    upcoming: [],
    forwardYield: null,
    trailingAmount: null,
  });
  vi.mocked(useWatchlistMembership).mockReturnValue(makeWatchlistMembership());
  vi.mocked(useAddToWatchlist).mockReturnValue(makeAddToWatchlistMutation());
  // Market-intel blocks hidden by default (unconfigured) — individual tests opt in.
  vi.mocked(getAssetEarnings).mockResolvedValue(UNAVAILABLE_EARNINGS);
  vi.mocked(getAssetSplits).mockResolvedValue(UNAVAILABLE_SPLITS);
  vi.mocked(getAssetNews).mockResolvedValue(UNAVAILABLE_NEWS);
});

describe('AssetDetailPage — market intelligence (§13.5 V5-P5)', () => {
  test('shows the earnings block with the next date + estimated badge', async () => {
    vi.mocked(getAssetEarnings).mockResolvedValue({
      available: true,
      next: {
        date: '2026-08-10T00:00:00.000Z',
        epsEstimate: 1.42,
        epsActual: null,
        estimated: true,
      },
      recent: [
        { date: '2026-04-30T00:00:00.000Z', epsEstimate: 1.5, epsActual: 1.53, estimated: false },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Earnings')).toBeInTheDocument());
    expect(screen.getByText('Next report')).toBeInTheDocument();
    // Estimated (amber) badge distinguishes an unconfirmed date.
    expect(screen.getByText('Estimated')).toBeInTheDocument();
  });

  test('hides the earnings block when the capability is unavailable', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(screen.queryByText('Earnings')).not.toBeInTheDocument();
  });

  test('shows past + announced splits with ratio formatting', async () => {
    vi.mocked(getAssetSplits).mockResolvedValue({
      available: true,
      history: [{ date: '2020-08-31T00:00:00.000Z', numerator: 4, denominator: 1, ratio: '4:1' }],
      upcoming: [{ date: '2026-09-01T00:00:00.000Z', numerator: 2, denominator: 1, ratio: '2:1' }],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Stock splits')).toBeInTheDocument());
    expect(screen.getByText('Announced')).toBeInTheDocument();
    expect(screen.getByText('2:1')).toBeInTheDocument();
    expect(screen.getByText('4:1')).toBeInTheDocument();
  });

  test('hides the splits block when there are no splits', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(screen.queryByText('Stock splits')).not.toBeInTheDocument();
  });

  test('renders a compact, expandable news feed from fixture headlines', async () => {
    vi.mocked(getAssetNews).mockResolvedValue({
      available: true,
      headlines: [
        {
          id: 'n1',
          title: 'Headline one',
          publisher: 'Reuters',
          url: 'https://example.com/1',
          publishedAt: '2026-06-20T08:00:00.000Z',
        },
        {
          id: 'n2',
          title: 'Headline two',
          publisher: 'Bloomberg',
          url: 'https://example.com/2',
          publishedAt: '2026-06-19T08:00:00.000Z',
        },
        {
          id: 'n3',
          title: 'Headline three',
          publisher: 'FT',
          url: 'https://example.com/3',
          publishedAt: '2026-06-18T08:00:00.000Z',
        },
        {
          id: 'n4',
          title: 'Headline four',
          publisher: 'WSJ',
          url: 'https://example.com/4',
          publishedAt: '2026-06-17T08:00:00.000Z',
        },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('News')).toBeInTheDocument());
    // Compact: the first three headlines show, the fourth is folded away.
    expect(screen.getByText('Headline one')).toBeInTheDocument();
    expect(screen.getByText('Headline three')).toBeInTheDocument();
    expect(screen.queryByText('Headline four')).not.toBeInTheDocument();
    // Expandable: the toggle reveals the rest.
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    expect(screen.getByText('Headline four')).toBeInTheDocument();
  });

  test('hides the news block when the capability is unavailable', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    await waitFor(() => expect(getAssetNews).toHaveBeenCalled());
    expect(screen.queryByText('News')).not.toBeInTheDocument();
  });
});

describe('AssetDetailPage — dividends block (V5-P5)', () => {
  const availableDividends = {
    available: true,
    currency: 'USD',
    history: [
      { exDate: '2026-02-07T00:00:00.000Z', payDate: null, amount: 0.24, currency: 'USD' },
      { exDate: '2026-05-09T00:00:00.000Z', payDate: null, amount: 0.25, currency: 'USD' },
    ],
    upcoming: [
      {
        exDate: '2026-08-08T00:00:00.000Z',
        payDate: '2026-08-15T00:00:00.000Z',
        amount: null,
        currency: 'USD',
      },
    ],
    forwardYield: 0.0044,
    trailingAmount: 0.98,
  };

  test('renders payout history, forward yield and next ex/pay dates from fixture data', async () => {
    vi.mocked(getAssetDividends).mockResolvedValue(availableDividends);
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(await screen.findByText('Dividends')).toBeInTheDocument();
    expect(screen.getByText('Forward yield')).toBeInTheDocument();
    expect(screen.getByText('TTM per share')).toBeInTheDocument();
    expect(screen.getByText('Next ex-date')).toBeInTheDocument();
    expect(screen.getByText('Next pay date')).toBeInTheDocument();
    expect(screen.getByLabelText('Dividend payout history')).toBeInTheDocument();
  });

  test('is absent when the capability is unavailable (invisible when unconfigured)', async () => {
    // beforeEach already mocks the unavailable shape.
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    // Give the query a tick to settle, then assert the block never appears.
    await waitFor(() => expect(getAssetDividends).toHaveBeenCalled());
    expect(screen.queryByText('Dividends')).not.toBeInTheDocument();
    expect(screen.queryByText('Forward yield')).not.toBeInTheDocument();
  });
});

describe('AssetDetailPage — header rendering', () => {
  test('shows asset name, symbol and exchange', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(screen.getByText('BAYN.DE')).toBeInTheDocument();
    expect(screen.getByText('XETRA')).toBeInTheDocument();
  });

  test('renders the Parqet capability tag for a supported (stock) asset', async () => {
    // baseDetail.asset.type is 'stock' — Parqet syncs stocks (V5-P0c).
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(screen.getByText('Syncs with Parqet')).toBeInTheDocument();
  });

  test('renders no capability tag for an unsupported (index) asset', async () => {
    vi.mocked(getAssetDetail).mockResolvedValue({
      ...baseDetail,
      asset: { ...baseDetail.asset, type: 'index' as const },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(screen.queryByText('Syncs with Parqet')).not.toBeInTheDocument();
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

describe('AssetDetailPage — Live Mode (§6.3, V3-P7b)', () => {
  test('the LIVE toggle is real — no Coming-Soon marker — and off by default', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    const toggle = screen.getByRole('button', { name: 'Toggle live mode' });
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).not.toHaveAttribute('title', 'Coming soon');
  });

  test('turning LIVE on swaps the range toggle for the six live windows; off restores it', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Toggle live mode' }));
    for (const w of ['1m', '10m', '30m', '1h', '3h', '12h']) {
      expect(screen.getByRole('button', { name: w })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: '1D' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Max' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Toggle live mode' }));
    expect(screen.getByRole('button', { name: '1D' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '12h' })).not.toBeInTheDocument();
  });

  test('gateway absent (no realtime provider) ⇒ silent 60 s poll fallback, zero user-visible errors', async () => {
    const user = userEvent.setup();
    renderPage(); // no RealtimeProvider mounted — the noop context (§4.5)
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Toggle live mode' }));

    // The fallback note is informational; nothing error-toned renders and the
    // polled quote keeps the page alive.
    await waitFor(() =>
      expect(
        screen.getByText('Live updates every 60 s while the stream reconnects.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/live.*(unavailable|error|failed)/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Live price chart for BAYN.DE')).toBeInTheDocument();
  });

  test('a window switch stays in live mode with the picked window selected', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Toggle live mode' }));
    await user.click(screen.getByRole('button', { name: '12h' }));
    expect(screen.getByRole('button', { name: '12h' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '10m' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Toggle live mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('live mode offers refresh rates down to 1 s; picking one stays selected (#372)', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Toggle live mode' }));
    const rateGroup = screen.getByRole('group', { name: 'Select refresh rate' });
    for (const rate of ['1s', '2s', '5s', '10s', '30s', '60s']) {
      expect(within(rateGroup).getByRole('button', { name: rate })).toBeInTheDocument();
    }
    // Default rate is 10 s (the pre-overhaul cadence).
    expect(within(rateGroup).getByRole('button', { name: '10s' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(within(rateGroup).getByRole('button', { name: '1s' }));
    expect(within(rateGroup).getByRole('button', { name: '1s' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(rateGroup).getByRole('button', { name: '10s' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // Still live, window selection untouched.
    expect(screen.getByRole('button', { name: 'Toggle live mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('custom assets get no LIVE toggle — there is nothing to stream (§6.3)', async () => {
    vi.mocked(getAssetDetail).mockResolvedValue({
      ...baseDetail,
      asset: { ...baseDetail.asset, isCustom: true, providerId: 'manual' },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Toggle live mode' })).not.toBeInTheDocument();
  });
});

describe('AssetDetailPage — market state badge (§13.5 V5-P1 Part B)', () => {
  const closedQuote = {
    quote: { ...baseDetail.quote, marketState: 'closed' as const },
    stale: false,
    asOf: '2024-06-01T12:00:00.000Z',
  };

  test('renders the exchange-session badge in the header from the quote', async () => {
    vi.mocked(getAssetQuote).mockResolvedValue(closedQuote);
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Closed')).toBeInTheDocument());
  });

  test('shows a "Market closed" state on the live chart when the market is closed', async () => {
    vi.mocked(getAssetQuote).mockResolvedValue(closedQuote);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Closed')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Toggle live mode' }));
    expect(screen.getByText('Market closed')).toBeInTheDocument();
  });

  test('renders no badge when the provider reports no session state', async () => {
    // Default fixture carries no marketState → the badge is absent, not wrong.
    renderPage();
    await waitFor(() => expect(screen.getByText('Bayer AG')).toBeInTheDocument());
    expect(screen.queryByText('Closed')).not.toBeInTheDocument();
    expect(screen.queryByText('Open')).not.toBeInTheDocument();
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

    expect(addToWatchlistMutate).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      watchlistId: undefined,
    });
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
