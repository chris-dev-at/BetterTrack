import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  BacktestComparisonRequest,
  BacktestComparisonResponse,
  ConglomerateSummary,
} from '@bettertrack/contracts';

vi.mock('../../lib/conglomerateApi', () => ({
  listConglomerates: vi.fn(),
}));

vi.mock('../../lib/workboardApi', () => ({
  compareConglomerates: vi.fn(),
  CONGLOMERATE_COMPARE_QUERY_KEY: ['workboard', 'compare'],
}));

// jsdom can't draw the canvas-backed chart (mirrors BacktestPanel.test.tsx).
const chartMocks = vi.hoisted(() => {
  const setData = vi.fn();
  const addSeries = vi.fn(() => ({ setData, applyOptions: vi.fn() }));
  const createChart = vi.fn(() => ({
    addSeries,
    applyOptions: vi.fn(),
    timeScale: () => ({ fitContent: vi.fn() }),
    remove: vi.fn(),
  }));
  const createSeriesMarkers = vi.fn(() => ({ setMarkers: vi.fn() }));
  return { createChart, createSeriesMarkers };
});

vi.mock('lightweight-charts', () => ({
  createChart: chartMocks.createChart,
  createSeriesMarkers: chartMocks.createSeriesMarkers,
  AreaSeries: 'AreaSeries',
  LineSeries: 'LineSeries',
  BaselineSeries: 'BaselineSeries',
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
}));

import { listConglomerates } from '../../lib/conglomerateApi';
import { compareConglomerates } from '../../lib/workboardApi';
import { ComparisonPage } from './ComparisonPage';

function cong(id: string, name: string, positionCount: number): ConglomerateSummary {
  return {
    id,
    name,
    description: null,
    status: 'active',
    visibility: 'private',
    positionCount,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  } as ConglomerateSummary;
}

const NAMES: Record<string, string> = { c1: 'Alpha', c2: 'Beta', c3: 'Gamma' };
const STATS: Record<
  string,
  { total: number; cagr: number; dd: number; vol: number; best: number; worst: number }
> = {
  c1: { total: 10, cagr: 8, dd: -5, vol: 12, best: 3, worst: -4 },
  c2: { total: 25, cagr: 15, dd: -9, vol: 18, best: 5, worst: -7 },
  c3: { total: 5, cagr: 4, dd: -3, vol: 9, best: 2, worst: -2 },
};

function seriesFor(id: string, baselineId: string) {
  const s = STATS[id]!;
  const b = STATS[baselineId]!;
  return {
    conglomerateId: id,
    name: NAMES[id]!,
    series: [
      { date: '2021-01-04', value: 100 },
      { date: '2026-01-05', value: 100 * (1 + s.total / 100) },
    ],
    stats: {
      totalReturnPct: s.total,
      cagrPct: s.cagr,
      maxDrawdownPct: s.dd,
      volatilityPct: s.vol,
      bestDay: { date: '2022-03-01', returnPct: s.best },
      worstDay: { date: '2022-03-02', returnPct: s.worst },
    },
    deltas: {
      totalReturnPct: s.total - b.total,
      cagrPct: s.cagr - b.cagr,
      maxDrawdownPct: s.dd - b.dd,
      volatilityPct: s.vol - b.vol,
      bestDayPct: s.best - b.best,
      worstDayPct: s.worst - b.worst,
    },
  };
}

function buildResponse(ids: string[], baselineId: string): BacktestComparisonResponse {
  return {
    startDate: '2021-01-04',
    endDate: '2026-01-05',
    baselineId,
    mode: 'clip',
    rebalance: 'none',
    series: ids.map((id) => seriesFor(id, baselineId)),
  } as BacktestComparisonResponse;
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderPage() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <ComparisonPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Select blueprints by clicking their picker checkboxes, in order. */
async function selectConglomerates(user: ReturnType<typeof userEvent.setup>, names: string[]) {
  for (const name of names) {
    await user.click(screen.getByRole('checkbox', { name: new RegExp(name) }));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(compareConglomerates).mockImplementation((body: BacktestComparisonRequest) =>
    Promise.resolve(
      buildResponse(body.conglomerateIds, body.baselineId ?? body.conglomerateIds[0]!),
    ),
  );
});

describe('ComparisonPage', () => {
  test('keeps a failed blueprint list distinct from the not-enough empty state and retries it', async () => {
    vi.mocked(listConglomerates)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        conglomerates: [cong('c1', 'Alpha', 3), cong('c2', 'Beta', 4)],
      });
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByText('Could not load your blueprints. Please try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Not enough blueprints yet')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('checkbox', { name: /Alpha/ })).toBeInTheDocument();
    expect(listConglomerates).toHaveBeenCalledTimes(2);
  });

  test('retries a failed comparison execution without discarding the selections', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({
      conglomerates: [cong('c1', 'Alpha', 3), cong('c2', 'Beta', 4)],
    });
    vi.mocked(compareConglomerates)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(buildResponse(['c1', 'c2'], 'c1'));
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('checkbox', { name: /Alpha/ });
    await selectConglomerates(user, ['Alpha', 'Beta']);
    expect(
      await screen.findByText('The comparison could not be computed. Please try again.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('table', { name: 'Blueprint comparison statistics' }),
    ).toBeInTheDocument();
    expect(compareConglomerates).toHaveBeenCalledTimes(2);
  });

  test('three blueprints compare on one chart with a full stats grid (snapshot)', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({
      conglomerates: [cong('c1', 'Alpha', 3), cong('c2', 'Beta', 4), cong('c3', 'Gamma', 2)],
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /Alpha/ })).toBeInTheDocument(),
    );
    await selectConglomerates(user, ['Alpha', 'Beta', 'Gamma']);

    // The grid renders once all three series are back (one baseline radio each).
    const grid = await screen.findByRole('table', { name: 'Blueprint comparison statistics' });
    await waitFor(() => expect(within(grid).getAllByRole('radio')).toHaveLength(3));

    // Every metric row is present, side by side with all three series.
    expect(within(grid).getByRole('rowheader', { name: 'Total return' })).toBeInTheDocument();
    expect(within(grid).getByRole('rowheader', { name: 'Max drawdown' })).toBeInTheDocument();
    expect(within(grid).getByRole('rowheader', { name: 'Volatility (ann.)' })).toBeInTheDocument();
    expect(grid).toMatchSnapshot();
  });

  test('renders exactly one legend, and it names the primary series too', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({
      conglomerates: [cong('c1', 'Alpha', 3), cong('c2', 'Beta', 4), cong('c3', 'Gamma', 2)],
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /Alpha/ })).toBeInTheDocument(),
    );
    await selectConglomerates(user, ['Alpha', 'Beta', 'Gamma']);
    await screen.findByRole('table', { name: 'Blueprint comparison statistics' });

    // The page no longer draws a second, partial legend under the chart's own…
    expect(screen.queryByRole('list', { name: 'Compared blueprints' })).toBeNull();

    // …and the chart's single legend covers every series, Alpha (the primary,
    // which the overlay-built legend used to omit) included — exactly once each.
    const canvas = await screen.findByRole('img', { name: 'Blueprint comparison chart' });
    const chart = canvas.closest('.flex-col') as HTMLElement;
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      expect(within(chart).getByText(name)).toBeInTheDocument();
    }
  });

  test('caps the selection at six — a seventh blueprint cannot be added (N=7 prevented)', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => cong(`c${i}`, `Cong${i}`, 3));
    vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: seven });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /Cong0/ })).toBeInTheDocument(),
    );
    await selectConglomerates(user, ['Cong0', 'Cong1', 'Cong2', 'Cong3', 'Cong4', 'Cong5']);

    // Six selected → the seventh is disabled; the selected six stay toggleable.
    expect(screen.getByRole('checkbox', { name: /Cong6/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Cong0/ })).toBeEnabled();
  });

  test('picking a different baseline recomputes the deltas against it', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({
      conglomerates: [cong('c1', 'Alpha', 3), cong('c2', 'Beta', 4), cong('c3', 'Gamma', 2)],
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /Alpha/ })).toBeInTheDocument(),
    );
    await selectConglomerates(user, ['Alpha', 'Beta', 'Gamma']);
    await screen.findByRole('table', { name: 'Blueprint comparison statistics' });

    // Default baseline is the first pick (c1). Choose Beta (c2) as the baseline.
    await user.click(screen.getByRole('radio', { name: 'Use Beta as the baseline' }));

    await waitFor(() =>
      expect(compareConglomerates).toHaveBeenCalledWith(
        expect.objectContaining({ baselineId: 'c2' }),
        expect.anything(),
      ),
    );
  });

  test('prompts for a second pick until two blueprints are selected', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({
      conglomerates: [cong('c1', 'Alpha', 3), cong('c2', 'Beta', 4)],
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /Alpha/ })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Select at least 2 blueprints/i)).toBeInTheDocument();
    expect(compareConglomerates).not.toHaveBeenCalled();

    await selectConglomerates(user, ['Alpha', 'Beta']);
    await waitFor(() => expect(compareConglomerates).toHaveBeenCalled());
  });

  test('offers an empty state when the user has fewer than two blueprints', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: [cong('c1', 'Alpha', 3)] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Not enough blueprints yet')).toBeInTheDocument());
    expect(compareConglomerates).not.toHaveBeenCalled();
  });
});
