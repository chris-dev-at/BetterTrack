import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { BacktestResponse } from '@bettertrack/contracts';

vi.mock('../../lib/backtestApi', () => ({
  previewBacktest: vi.fn(),
}));

// Mock the canvas-backed charting lib: jsdom can't draw (mirrors PriceChart.test.tsx).
const chartMocks = vi.hoisted(() => {
  const setData = vi.fn();
  const addSeries = vi.fn(() => ({ setData, applyOptions: vi.fn() }));
  const createChart = vi.fn(() => ({
    addSeries,
    applyOptions: vi.fn(),
    timeScale: () => ({ fitContent: vi.fn() }),
    remove: vi.fn(),
  }));
  return { setData, addSeries, createChart };
});

vi.mock('lightweight-charts', () => ({
  createChart: chartMocks.createChart,
  AreaSeries: 'AreaSeries',
  LineSeries: 'LineSeries',
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
}));

import { previewBacktest } from '../../lib/backtestApi';
import { BacktestPanel } from './BacktestPanel';

const POSITIONS = [
  { assetId: 'a1', weight: 60 },
  { assetId: 'a2', weight: 40 },
];

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
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderPanel(positions = POSITIONS) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <BacktestPanel positions={positions} />
    </QueryClientProvider>,
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
      expect(previewBacktest).toHaveBeenCalledWith(POSITIONS, '5Y', null, expect.anything()),
    );
    await waitFor(() => expect(chartMocks.createChart).toHaveBeenCalledTimes(1));
    expect(chartMocks.setData).toHaveBeenCalledWith(
      RESPONSE.series.map((p) => ({ time: p.date, value: p.value })),
    );

    expect(screen.getByText('Total return')).toBeInTheDocument();
    expect(screen.getByText('+42,5 %')).toBeInTheDocument();
    expect(screen.getByText('+7,3 %')).toBeInTheDocument();
    expect(screen.getByText('-9,1 %')).toBeInTheDocument();
    expect(screen.getByText('14,6 %')).toBeInTheDocument();
    expect(screen.getByText('+3,2 %')).toBeInTheDocument();
    expect(screen.getByText('-2,8 %')).toBeInTheDocument();

    // The chart's own built-in range toggle is hidden — the panel drives its own.
    expect(screen.queryByRole('group', { name: /select chart range/i })).not.toBeInTheDocument();
  });

  test('switching the range re-requests with the new range param', async () => {
    vi.mocked(previewBacktest).mockResolvedValue(RESPONSE);
    const user = userEvent.setup();
    renderPanel();

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(POSITIONS, '5Y', null, expect.anything()),
    );

    await user.click(screen.getByRole('button', { name: '3Y' }));

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(POSITIONS, '3Y', null, expect.anything()),
    );
  });

  test('toggling a benchmark re-requests with the benchmark param and draws the overlay', async () => {
    vi.mocked(previewBacktest).mockResolvedValue({
      ...RESPONSE,
      benchmark: {
        assetId: 'bench-1',
        symbol: '^GSPC',
        series: [
          { date: '2020-01-01', value: 100 },
          { date: '2025-01-01', value: 130 },
        ],
        stats: RESPONSE.stats,
      },
    });
    const user = userEvent.setup();
    renderPanel();

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(POSITIONS, '5Y', null, expect.anything()),
    );

    await user.click(screen.getByRole('button', { name: 'S&P 500' }));

    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(POSITIONS, '5Y', '^GSPC', expect.anything()),
    );
    await waitFor(() => expect(screen.getAllByText('S&P 500').length).toBeGreaterThan(1));

    // Toggling the same benchmark off removes the overlay again.
    await user.click(screen.getByRole('button', { name: 'S&P 500' }));
    await waitFor(() =>
      expect(previewBacktest).toHaveBeenLastCalledWith(POSITIONS, '5Y', null, expect.anything()),
    );
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
});
