import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  BacktestBenchmarkResult,
  BacktestResponse,
  ConglomerateListResponse,
  SearchResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/backtestApi', () => ({
  previewBacktest: vi.fn(),
}));

vi.mock('../../lib/searchApi', () => ({
  searchAssets: vi.fn(),
}));

vi.mock('../../lib/conglomerateApi', () => ({
  listConglomerates: vi.fn(),
  getConglomerate: vi.fn(),
  replaceConglomeratePositions: vi.fn(),
}));

// Mock the canvas-backed charting lib: jsdom can't draw (mirrors PriceChart.test.tsx).
const chartMocks = vi.hoisted(() => {
  const setData = vi.fn();
  const setMarkers = vi.fn();
  const addSeries = vi.fn(() => ({ setData, applyOptions: vi.fn() }));
  const createChart = vi.fn(() => ({
    addSeries,
    applyOptions: vi.fn(),
    timeScale: () => ({ fitContent: vi.fn() }),
    remove: vi.fn(),
  }));
  const createSeriesMarkers = vi.fn(() => ({ setMarkers }));
  return { setData, setMarkers, addSeries, createChart, createSeriesMarkers };
});

vi.mock('lightweight-charts', () => ({
  createChart: chartMocks.createChart,
  createSeriesMarkers: chartMocks.createSeriesMarkers,
  AreaSeries: 'AreaSeries',
  LineSeries: 'LineSeries',
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
}));

import { previewBacktest } from '../../lib/backtestApi';
import { listConglomerates } from '../../lib/conglomerateApi';
import { searchAssets } from '../../lib/searchApi';
import { BacktestPanel } from './BacktestPanel';

const POSITIONS = [
  { assetId: 'a1', weight: 60 },
  { assetId: 'a2', weight: 40 },
];

/** The default request the panel sends before any control is touched. */
const DEFAULT_PARAMS = {
  positions: POSITIONS,
  range: '5Y',
  benchmark: null,
  mode: 'clip',
  rebalance: 'none',
};

const RESPONSE: BacktestResponse = {
  startDate: '2020-01-01',
  endDate: '2025-01-01',
  series: [
    { date: '2020-01-01', value: 100 },
    { date: '2025-01-01', value: 142.5 },
  ],
  stats: {
    totalReturnPct: 42.5,
    cagrPct: 7.3,
    maxDrawdownPct: -9.1,
    volatilityPct: 14.6,
    bestDay: { date: '2020-03-24', returnPct: 3.2 },
    worstDay: { date: '2020-03-16', returnPct: -2.8 },
  },
  contributions: [],
  notice: null,
  benchmark: null,
  mode: 'clip',
  rebalance: 'none',
  entryEvents: [],
  rebalanceEvents: [],
  idleCashAvgPct: null,
};

/** A full benchmark stat block, distinct from the basket's so every Δ is non-zero. */
const BENCHMARK_RESULT: BacktestBenchmarkResult = {
  kind: 'conglomerate',
  refId: 'cong-1',
  label: 'My Mix',
  series: [
    { date: '2020-01-01', value: 100 },
    { date: '2025-01-01', value: 130 },
  ],
  stats: {
    totalReturnPct: 30,
    cagrPct: 5.4,
    maxDrawdownPct: -12.4,
    volatilityPct: 11.2,
    bestDay: { date: '2020-04-06', returnPct: 2.9 },
    worstDay: { date: '2020-03-12', returnPct: -3.4 },
  },
};

const CONGLOMERATES: ConglomerateListResponse = {
  conglomerates: [
    {
      id: 'cong-1',
      name: 'My Mix',
      description: null,
      status: 'active',
      visibility: 'private',
      positionCount: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};

const SEARCH_RESULTS = {
  results: [
    {
      id: 'asset-9',
      providerId: 'yahoo',
      providerRef: 'AAPL',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      type: 'stock',
      currency: 'USD',
      isCustom: false,
    },
  ],
  enriching: false,
} as unknown as SearchResponse;

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderPanel(positions = POSITIONS) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={makeQueryClient()}>
        <BacktestPanel positions={positions} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BacktestPanel', () => {
  test('renders the series via PriceChart and the headline stats', async () => {
    vi.mocked(previewBacktest).mockResolvedValue(RESPONSE);
    renderPanel();

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(DEFAULT_PARAMS, expect.anything()),
    );
    await waitFor(() => expect(chartMocks.createChart).toHaveBeenCalledTimes(1));
    expect(chartMocks.setData).toHaveBeenCalledWith(
      RESPONSE.series.map((p) => ({ time: p.date, value: p.value })),
    );

    expect(screen.getByText('Total return')).toBeInTheDocument();
    expect(screen.getByText('+42,50 %')).toBeInTheDocument();
    expect(screen.getByText('+7,30 %')).toBeInTheDocument();
    expect(screen.getByText('-9,10 %')).toBeInTheDocument();
    expect(screen.getByText('14,60 %')).toBeInTheDocument();
    expect(screen.getByText('+3,20 %')).toBeInTheDocument();
    expect(screen.getByText('-2,80 %')).toBeInTheDocument();

    // The chart's own built-in range toggle is hidden — the panel drives its own.
    expect(screen.queryByRole('group', { name: /select chart range/i })).not.toBeInTheDocument();
  });

  test('switching the range re-requests with the new range param', async () => {
    vi.mocked(previewBacktest).mockResolvedValue(RESPONSE);
    const user = userEvent.setup();
    renderPanel();

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(DEFAULT_PARAMS, expect.anything()),
    );

    await user.click(screen.getByRole('button', { name: '3Y' }));

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(
        { ...DEFAULT_PARAMS, range: '3Y' },
        expect.anything(),
      ),
    );
  });

  test('a preset benchmark stays one-click: toggling re-requests and draws the overlay (V4-P7 regression)', async () => {
    vi.mocked(previewBacktest).mockImplementation(async (params) =>
      params.benchmark
        ? {
            ...RESPONSE,
            benchmark: {
              ...BENCHMARK_RESULT,
              kind: 'asset',
              refId: '^GSPC',
              label: 'S&P 500',
            },
          }
        : RESPONSE,
    );
    const user = userEvent.setup();
    renderPanel();

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(DEFAULT_PARAMS, expect.anything()),
    );

    await user.click(screen.getByRole('button', { name: 'S&P 500' }));

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(
        { ...DEFAULT_PARAMS, benchmark: { preset: '^GSPC' } },
        expect.anything(),
      ),
    );
    await waitFor(() => expect(screen.getAllByText('S&P 500').length).toBeGreaterThan(1));

    // Toggling the same benchmark off removes the overlay again.
    await user.click(screen.getByRole('button', { name: 'S&P 500' }));
    await waitFor(() =>
      expect(previewBacktest).toHaveBeenLastCalledWith(DEFAULT_PARAMS, expect.anything()),
    );
  });

  test('selecting a benchmark via the local asset search sends its assetId (V4-P7)', async () => {
    vi.mocked(previewBacktest).mockResolvedValue(RESPONSE);
    vi.mocked(searchAssets).mockResolvedValue(SEARCH_RESULTS);
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Search asset…' }));
    await user.type(screen.getByPlaceholderText('Search any asset as benchmark…'), 'app');

    await user.click(await screen.findByText('AAPL'));

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(
        { ...DEFAULT_PARAMS, benchmark: { assetId: 'asset-9' } },
        expect.anything(),
      ),
    );
    // The committed choice shows as a clearable chip; clearing re-requests without it.
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear benchmark' }));
    await waitFor(() =>
      expect(previewBacktest).toHaveBeenLastCalledWith(DEFAULT_PARAMS, expect.anything()),
    );
  });

  test('a conglomerate benchmark renders two full stat columns + delta (V4-P7 snapshot)', async () => {
    vi.mocked(previewBacktest).mockImplementation(async (params) =>
      params.benchmark ? { ...RESPONSE, benchmark: BENCHMARK_RESULT } : RESPONSE,
    );
    vi.mocked(listConglomerates).mockResolvedValue(CONGLOMERATES);
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'My conglomerates…' }));
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Benchmark conglomerate' }),
      'cong-1',
    );

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(
        { ...DEFAULT_PARAMS, benchmark: { conglomerateId: 'cong-1' } },
        expect.anything(),
      ),
    );

    // Side-by-side table: basket column, benchmark column, Δ column.
    const table = await screen.findByRole('table', {
      name: 'Backtest statistics: basket vs benchmark',
    });
    expect(screen.getByRole('columnheader', { name: 'Basket' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'My Mix' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Δ' })).toBeInTheDocument();
    // Both series' stats and the delta (42.5 − 30 = +12.5 pp on total return).
    expect(screen.getByText('+42,50 %')).toBeInTheDocument();
    expect(screen.getByText('+30,00 %')).toBeInTheDocument();
    expect(screen.getByText('+12,50 %')).toBeInTheDocument();
    expect(table).toMatchSnapshot();

    // The Δ column is optional: unchecking the toggle removes it.
    await user.click(screen.getByRole('checkbox', { name: 'Delta column' }));
    expect(screen.queryByRole('columnheader', { name: 'Δ' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'My Mix' })).toBeInTheDocument();
  });

  test('switching the rebalance frequency re-requests, shows the notice and the optional markers (V4-P7)', async () => {
    vi.mocked(previewBacktest).mockImplementation(async (params) =>
      params.rebalance === 'monthly'
        ? {
            ...RESPONSE,
            rebalance: 'monthly',
            rebalanceEvents: [{ date: '2024-02-01' }, { date: '2024-03-01' }],
          }
        : RESPONSE,
    );
    const user = userEvent.setup();
    renderPanel();

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(DEFAULT_PARAMS, expect.anything()),
    );

    await user.click(screen.getByRole('button', { name: 'Monthly' }));

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(
        { ...DEFAULT_PARAMS, rebalance: 'monthly' },
        expect.anything(),
      ),
    );

    // The schedule-adaptive notice names the frequency and the executed count.
    expect(
      await screen.findByText(
        'Rebalanced monthly to the target weights — 2 rebalances in this window.',
      ),
    ).toBeInTheDocument();

    // Rebalance markers ride the chart at the boundary days…
    await waitFor(() =>
      expect(chartMocks.setMarkers).toHaveBeenCalledWith([
        expect.objectContaining({ time: '2024-02-01', text: 'Rebalance' }),
        expect.objectContaining({ time: '2024-03-01', text: 'Rebalance' }),
      ]),
    );

    // …and are optional: unchecking the toggle clears them without a re-request.
    const calls = vi.mocked(previewBacktest).mock.calls.length;
    await user.click(screen.getByRole('checkbox', { name: 'Rebalance markers' }));
    await waitFor(() => expect(chartMocks.setMarkers).toHaveBeenLastCalledWith([]));
    expect(vi.mocked(previewBacktest).mock.calls.length).toBe(calls);
  });

  test('renders the clipping/short-history notice as an informational banner, not an error', async () => {
    vi.mocked(previewBacktest).mockResolvedValue({
      ...RESPONSE,
      notice: 'Limited by TEM (data since 2024-06-14).',
    });
    renderPanel();

    const notice = await screen.findByText(/Limited by TEM/i);
    const banner = notice.closest('[role="alert"]');
    expect(banner).not.toBeNull();
    expect(banner).not.toHaveClass('text-red-200');
  });

  test('shows an empty state when there are no positions and does not request a backtest', () => {
    renderPanel([]);

    expect(screen.getByText(/Add positions to preview a backtest/i)).toBeInTheDocument();
    expect(previewBacktest).not.toHaveBeenCalled();
  });

  test('shows an error state when the backtest request fails', async () => {
    vi.mocked(previewBacktest).mockRejectedValue(new Error('nope'));
    renderPanel();

    await waitFor(() =>
      expect(screen.getByText(/Could not run the backtest/i)).toBeInTheDocument(),
    );
  });

  test('switching the late-listing mode re-requests with the mode param (§14)', async () => {
    vi.mocked(previewBacktest).mockResolvedValue(RESPONSE);
    const user = userEvent.setup();
    renderPanel();

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(DEFAULT_PARAMS, expect.anything()),
    );

    await user.click(screen.getByRole('button', { name: 'Cash until listing' }));

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(
        { ...DEFAULT_PARAMS, mode: 'cash' },
        expect.anything(),
      ),
    );
  });

  test('cash mode renders the adaptive notice, entry flags and the idle-cash stat (§14)', async () => {
    vi.mocked(previewBacktest).mockImplementation(async (params) =>
      params.mode === 'cash'
        ? {
            ...RESPONSE,
            mode: 'cash',
            entryEvents: [{ assetId: 'a2', symbol: 'SPACEX', date: '2023-07-01' }],
            idleCashAvgPct: 21.4,
          }
        : RESPONSE,
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Cash until listing' }));

    // The mode-adaptive notice replaces the clipping message and names the entry.
    const notice = await screen.findByText(/uninvested cash \(0 % return\)/i);
    expect(notice.textContent).toMatch(/SPACEX/);
    // Idle-cash visibility: the "avg. uninvested" stat (cash mode only).
    expect(screen.getByText('Avg. uninvested')).toBeInTheDocument();
    expect(screen.getByText('21,40 %')).toBeInTheDocument();
    // The entry marker rides the chart at the entry date ("X enters").
    await waitFor(() =>
      expect(chartMocks.setMarkers).toHaveBeenCalledWith([
        expect.objectContaining({ time: '2023-07-01', text: 'SPACEX enters' }),
      ]),
    );
  });

  test('redistribute mode states the equal-split rule and shows no idle-cash stat (§14)', async () => {
    vi.mocked(previewBacktest).mockResolvedValue({
      ...RESPONSE,
      mode: 'redistribute',
      entryEvents: [{ assetId: 'a2', symbol: 'SPACEX', date: '2023-07-01' }],
      idleCashAvgPct: null,
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Redistribute until listing' }));

    const notice = await screen.findByText(/split equally among the already-listed constituents/i);
    expect(notice.textContent).toMatch(/SPACEX/);
    expect(screen.queryByText('Avg. uninvested')).not.toBeInTheDocument();
  });
});
