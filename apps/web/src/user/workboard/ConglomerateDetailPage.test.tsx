import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/conglomerateApi', () => ({
  getConglomerate: vi.fn(),
  deleteConglomerate: vi.fn(),
  allocateConglomerate: vi.fn(),
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

import { previewBacktest } from '../../lib/backtestApi';
import { deleteConglomerate, getConglomerate } from '../../lib/conglomerateApi';
import { listPortfolios } from '../../lib/portfolioApi';
import { ConglomerateDetailPage } from './ConglomerateDetailPage';

const CONGLOMERATE_ID = 'c1';

const DETAIL = {
  id: CONGLOMERATE_ID,
  name: 'Core Growth',
  description: 'My steady basket',
  status: 'active' as const,
  positionCount: 2,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  positions: [
    {
      assetId: 'a1',
      weightPct: 60,
      sortOrder: 0,
      asset: {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        currency: 'USD' as const,
        type: 'stock' as const,
      },
    },
    {
      assetId: 'a2',
      weightPct: 40,
      sortOrder: 1,
      asset: {
        symbol: 'MSFT',
        name: 'Microsoft Corp.',
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
  vi.mocked(listPortfolios).mockResolvedValue({
    portfolios: [
      {
        id: 'p1',
        name: 'Default',
        visibility: 'private',
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
    expect(within(table).getByText('60,0 %')).toBeInTheDocument();
    expect(within(table).getByText('40,0 %')).toBeInTheDocument();

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
        [
          { assetId: 'a1', weight: 60 },
          { assetId: 'a2', weight: 40 },
        ],
        '5Y',
        null,
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

  test('shows an error message when the Conglomerate fails to load', async () => {
    vi.mocked(getConglomerate).mockRejectedValue(new Error('nope'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load this Conglomerate/i)).toBeInTheDocument(),
    );
  });
});
