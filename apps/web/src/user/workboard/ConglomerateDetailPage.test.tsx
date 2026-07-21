import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/conglomerateApi', () => ({
  getConglomerate: vi.fn(),
  getResolvedConglomerate: vi.fn(),
  deleteConglomerate: vi.fn(),
  allocateConglomerate: vi.fn(),
  updateConglomerate: vi.fn(),
}));

vi.mock('../../lib/backtestApi', () => ({
  previewBacktest: vi.fn(),
}));

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  createTransactions: vi.fn(),
}));

// Mock the canvas-backed charting lib the backtest panel's PriceChart drives;
// jsdom can't draw (mirrors PriceChart.test.tsx).
vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => ({
    addSeries: vi.fn(() => ({ setData: vi.fn(), applyOptions: vi.fn() })),
    applyOptions: vi.fn(),
    timeScale: () => ({ fitContent: vi.fn() }),
    remove: vi.fn(),
  })),
  AreaSeries: 'AreaSeries',
  LineSeries: 'LineSeries',
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
}));

// Recharts measures the DOM (0×0 in jsdom); hand the donut a fixed size (mirrors
// AllocationDonut.test.tsx / PortfolioPage.test.tsx).
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

import { ApiError } from '../../lib/apiClient';
import { previewBacktest } from '../../lib/backtestApi';
import {
  deleteConglomerate,
  getConglomerate,
  getResolvedConglomerate,
  updateConglomerate,
} from '../../lib/conglomerateApi';
import { listPortfolios } from '../../lib/portfolioApi';
import { ConglomerateDetailPage } from './ConglomerateDetailPage';

const CONGLOMERATE_ID = 'c1';

const AAPL = {
  symbol: 'AAPL',
  name: 'Apple Inc.',
  currency: 'USD' as const,
  type: 'stock' as const,
};
const MSFT = {
  symbol: 'MSFT',
  name: 'Microsoft Corp.',
  currency: 'USD' as const,
  type: 'stock' as const,
};

const DETAIL = {
  id: CONGLOMERATE_ID,
  name: 'Core Growth',
  description: 'My steady basket',
  status: 'active' as const,
  visibility: 'private' as const,
  positionCount: 2,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  positions: [
    { kind: 'asset' as const, assetId: 'a1', weightPct: 60, sortOrder: 0, asset: AAPL },
    { kind: 'asset' as const, assetId: 'a2', weightPct: 40, sortOrder: 1, asset: MSFT },
  ],
};

/** The flat basket's resolved view: its own weights, no nesting. */
const RESOLVED = {
  conglomerateId: CONGLOMERATE_ID,
  nested: false,
  positions: [
    { assetId: 'a1', weightPct: 60, asset: AAPL },
    { assetId: 'a2', weightPct: 40, asset: MSFT },
  ],
};

/** A nested basket (V5-P6): 50% child "Tech Mix" + 50% AAPL, resolved to 20/30/50. */
const NESTED_DETAIL = {
  ...DETAIL,
  positions: [
    { kind: 'asset' as const, assetId: 'a1', weightPct: 50, sortOrder: 0, asset: AAPL },
    {
      kind: 'conglomerate' as const,
      childId: 'c2',
      weightPct: 50,
      sortOrder: 1,
      child: { id: 'c2', name: 'Tech Mix', status: 'active' as const, positionCount: 2 },
    },
  ],
};

const NESTED_RESOLVED = {
  conglomerateId: CONGLOMERATE_ID,
  nested: true,
  positions: [
    { assetId: 'a1', weightPct: 50, asset: AAPL },
    { assetId: 'a2', weightPct: 20, asset: MSFT },
    {
      assetId: 'a3',
      weightPct: 30,
      asset: {
        symbol: 'NVDA',
        name: 'NVIDIA Corp.',
        currency: 'USD' as const,
        type: 'stock' as const,
      },
    },
  ],
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderPage(id = CONGLOMERATE_ID) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[`/workboard/conglomerates/${id}`]}>
        <Routes>
          <Route path="/workboard/conglomerates" element={<div>Conglomerates list</div>} />
          <Route path="/workboard/conglomerates/:id" element={<ConglomerateDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getResolvedConglomerate).mockResolvedValue(RESOLVED);
  vi.mocked(listPortfolios).mockResolvedValue({
    portfolios: [
      {
        id: 'p1',
        name: 'Default',
        visibility: 'private' as const,
        sortOrder: 0,
        isDefault: true,
        defaultPayFromCash: false,
        archivedAt: null,
      },
    ],
  });
  vi.mocked(previewBacktest).mockResolvedValue({
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
  });
});

describe('ConglomerateDetailPage', () => {
  test('renders header, positions table and allocation donut', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(DETAIL);
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('2 positions')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('AAPL')).toBeInTheDocument();
    expect(within(table).getByText('MSFT')).toBeInTheDocument();
    expect(within(table).getByText('60,00 %')).toBeInTheDocument();
    expect(within(table).getByText('40,00 %')).toBeInTheDocument();

    const donut = screen.getByRole('img', { name: /conglomerate allocation/i });
    expect(donut).toBeInTheDocument();
  });

  test('renders the backtest panel and the Invest Calculator', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(DETAIL);
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Backtest' })).toBeInTheDocument();
    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(
        {
          positions: [
            { assetId: 'a1', weight: 60 },
            { assetId: 'a2', weight: 40 },
          ],
          range: '5Y',
          benchmark: null,
          mode: 'clip',
          rebalance: 'none',
        },
        expect.anything(),
      ),
    );
    expect(screen.getByRole('heading', { name: 'Calculator' })).toBeInTheDocument();
    expect(screen.getByLabelText('Budget in EUR')).toBeInTheDocument();
  });

  test('delete confirm flow calls DELETE and navigates back to the list', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(DETAIL);
    vi.mocked(deleteConglomerate).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: /delete conglomerate/i });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteConglomerate).toHaveBeenCalledWith(CONGLOMERATE_ID));
    await waitFor(() => expect(screen.getByText('Conglomerates list')).toBeInTheDocument());
  });

  test('a nested basket shows the badge and the resolved-view toggle flips to effective weights (V5-P6)', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(NESTED_DETAIL);
    vi.mocked(getResolvedConglomerate).mockResolvedValue(NESTED_RESOLVED);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());

    // Stored view: the child row renders with its name + the nesting badge.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Tech Mix')).toBeInTheDocument();
    expect(within(table).getByText('Nested')).toBeInTheDocument();

    // Toggle to the resolved view: flattened effective asset weights.
    await user.click(screen.getByRole('button', { name: 'Resolved' }));
    const resolvedTable = screen.getByRole('table');
    expect(within(resolvedTable).getByText('NVDA')).toBeInTheDocument();
    expect(within(resolvedTable).getByText('20,00 %')).toBeInTheDocument();
    expect(within(resolvedTable).getByText('30,00 %')).toBeInTheDocument();
    expect(within(resolvedTable).queryByText('Tech Mix')).not.toBeInTheDocument();
  });

  test('the backtest panel consumes the RESOLVED weights of a nested basket', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(NESTED_DETAIL);
    vi.mocked(getResolvedConglomerate).mockResolvedValue(NESTED_RESOLVED);
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(
        expect.objectContaining({
          positions: [
            { assetId: 'a1', weight: 50 },
            { assetId: 'a2', weight: 20 },
            { assetId: 'a3', weight: 30 },
          ],
        }),
        expect.anything(),
      ),
    );
  });

  test('a delete blocked by parents (409 CONGLOMERATE_IN_USE) names them in the dialog', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(DETAIL);
    vi.mocked(deleteConglomerate).mockRejectedValue(
      new ApiError(409, 'CONGLOMERATE_IN_USE', 'This conglomerate is a constituent of World Mix.', {
        parents: [{ id: 'c9', name: 'World Mix' }],
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: /delete conglomerate/i });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(within(dialog).getByText(/constituent of World Mix/i)).toBeInTheDocument(),
    );
  });

  test('shows an error message when the Conglomerate fails to load', async () => {
    vi.mocked(getConglomerate).mockRejectedValue(new Error('nope'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load this Conglomerate/i)).toBeInTheDocument(),
    );
  });

  test('shows an inline error when toggling sharing fails', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(DETAIL);
    vi.mocked(updateConglomerate).mockRejectedValue(new Error('server error'));
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Share with friends' }));

    await waitFor(() => expect(screen.getByText(/Could not update sharing/i)).toBeInTheDocument());
  });
});
