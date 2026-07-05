import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/conglomerateApi', () => ({
  getConglomerate: vi.fn(),
  createConglomerate: vi.fn(),
  updateConglomerate: vi.fn(),
  replaceConglomeratePositions: vi.fn(),
  activateConglomerate: vi.fn(),
}));

vi.mock('../../lib/searchApi', () => ({
  searchAssets: vi.fn(),
}));

// Recharts measures the DOM (0×0 in jsdom); hand the donut a fixed size.
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

import {
  activateConglomerate,
  createConglomerate,
  getConglomerate,
  replaceConglomeratePositions,
  updateConglomerate,
} from '../../lib/conglomerateApi';
import { searchAssets } from '../../lib/searchApi';
import { ConglomerateBuilderPage } from './ConglomerateBuilderPage';

const CONGLOMERATE_ID = 'c1';

function detail(positions: Array<{ id: string; symbol: string; weightPct: number }>) {
  return {
    id: CONGLOMERATE_ID,
    name: 'My Basket',
    description: null,
    status: 'draft' as const,
    positionCount: positions.length,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    positions: positions.map((p, i) => ({
      assetId: p.id,
      weightPct: p.weightPct,
      sortOrder: i,
      asset: {
        symbol: p.symbol,
        name: `${p.symbol} Inc.`,
        currency: 'USD' as const,
        type: 'stock' as const,
      },
    })),
  };
}

const AAPL_RESULT = {
  id: 'a-aapl',
  providerId: 'yahoo',
  providerRef: 'AAPL',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  exchange: 'NASDAQ',
  type: 'stock' as const,
  currency: 'USD' as const,
  isCustom: false,
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderBuilder(initialPath: string) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/workboard/conglomerates" element={<div>Conglomerates list</div>} />
          <Route path="/workboard/conglomerates/new" element={<ConglomerateBuilderPage />} />
          <Route path="/workboard/conglomerates/:id" element={<div>Detail view</div>} />
          <Route path="/workboard/conglomerates/:id/edit" element={<ConglomerateBuilderPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Load the Builder in edit mode with the given positions and wait for the rows. */
async function renderEdit(positions: Array<{ id: string; symbol: string; weightPct: number }>) {
  vi.mocked(getConglomerate).mockResolvedValue(detail(positions));
  vi.mocked(updateConglomerate).mockResolvedValue(detail(positions));
  vi.mocked(replaceConglomeratePositions).mockResolvedValue(detail(positions));
  renderBuilder(`/workboard/conglomerates/${CONGLOMERATE_ID}/edit`);
  for (const p of positions) {
    await screen.findByLabelText(`Weight for ${p.symbol}`);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConglomerateBuilderPage', () => {
  test('renders the three-zone Builder full-screen', async () => {
    await renderEdit([{ id: 'a1', symbol: 'AAPL', weightPct: 60 }]);
    expect(screen.getByRole('heading', { name: /add assets/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^positions$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /live preview/i })).toBeInTheDocument();
    // A labelled placeholder stands in for the backtest chart (deferred).
    expect(screen.getByText(/backtest preview — coming/i)).toBeInTheDocument();
  });

  test('searching and clicking a result adds a position at weight 0', async () => {
    vi.mocked(searchAssets).mockResolvedValue({ results: [AAPL_RESULT] });
    vi.mocked(createConglomerate).mockResolvedValue(detail([]));
    vi.mocked(replaceConglomeratePositions).mockResolvedValue(detail([]));
    const user = userEvent.setup();
    renderBuilder('/workboard/conglomerates/new');

    await user.type(screen.getByRole('searchbox', { name: /search assets/i }), 'AAPL');
    const select = await screen.findByRole('button', { name: /select aapl/i });
    await user.click(select);

    const weightInput = await screen.findByLabelText('Weight for AAPL');
    expect(weightInput).toHaveValue(0);
    expect(screen.getByLabelText('Weight slider for AAPL')).toHaveValue('0');
  });

  test('the slider and number input stay in sync', async () => {
    await renderEdit([{ id: 'a1', symbol: 'AAPL', weightPct: 20 }]);
    const numberInput = screen.getByLabelText('Weight for AAPL');
    const slider = screen.getByLabelText('Weight slider for AAPL');

    // Move the slider → the number input follows.
    fireEvent.change(slider, { target: { value: '45' } });
    await waitFor(() => expect(numberInput).toHaveValue(45));

    // Type in the number input → the slider follows.
    fireEvent.change(numberInput, { target: { value: '12.5' } });
    await waitFor(() => expect(slider).toHaveValue('12.5'));
  });

  test('the sum pill is amber below 100 and green at exactly 100', async () => {
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 60 },
      { id: 'a2', symbol: 'MSFT', weightPct: 27.5 },
    ]);
    // 87.5% total → amber with the "% left" readout.
    expect(screen.getByText('87.5% — 12.5% left')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Weight for MSFT'), { target: { value: '40' } });
    await waitFor(() => expect(screen.getByText('100.0%')).toBeInTheDocument());
  });

  test('auto-balance produces a Σ of exactly 100', async () => {
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 60 },
      { id: 'a2', symbol: 'MSFT', weightPct: 10 },
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /auto-balance/i }));

    await waitFor(() => expect(screen.getByText('100.0%')).toBeInTheDocument());
    expect(screen.getByLabelText('Weight for AAPL')).toHaveValue(50);
    expect(screen.getByLabelText('Weight for MSFT')).toHaveValue(50);
  });

  test('normalize scales unlocked positions to Σ = 100', async () => {
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 30 },
      { id: 'a2', symbol: 'MSFT', weightPct: 10 },
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /normalize/i }));

    await waitFor(() => expect(screen.getByText('100.0%')).toBeInTheDocument());
    expect(screen.getByLabelText('Weight for AAPL')).toHaveValue(75);
    expect(screen.getByLabelText('Weight for MSFT')).toHaveValue(25);
  });

  test('normalize errors when the locked positions alone total ≥ 100', async () => {
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 100 },
      { id: 'a2', symbol: 'MSFT', weightPct: 10 },
    ]);
    const user = userEvent.setup();
    // Lock AAPL (100%) so the locked total alone is ≥ 100.
    await user.click(screen.getByRole('button', { name: /lock aapl/i }));
    await user.click(screen.getByRole('button', { name: /normalize/i }));

    expect(await screen.findByText(/Locked weights already total 100%/i)).toBeInTheDocument();
  });

  test('activate is blocked until Σ = 100 ± 0.01, then flips to active', async () => {
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 60 },
      { id: 'a2', symbol: 'MSFT', weightPct: 30 },
    ]);
    vi.mocked(activateConglomerate).mockResolvedValue({
      ...detail([
        { id: 'a1', symbol: 'AAPL', weightPct: 60 },
        { id: 'a2', symbol: 'MSFT', weightPct: 40 },
      ]),
      status: 'active',
    });
    const user = userEvent.setup();

    // 90% total → Activate disabled, with a reason an owner-naive user can read.
    expect(screen.getByRole('button', { name: /^activate$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^activate$/i })).toHaveAttribute(
      'title',
      expect.stringContaining('must sum to 100%'),
    );

    fireEvent.change(screen.getByLabelText('Weight for MSFT'), { target: { value: '40' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^activate$/i })).toBeEnabled());
    expect(screen.getByRole('button', { name: /^activate$/i })).toHaveAttribute(
      'title',
      expect.stringContaining('used by the calculator'),
    );

    await user.click(screen.getByRole('button', { name: /^activate$/i }));
    await waitFor(() => expect(activateConglomerate).toHaveBeenCalledWith(CONGLOMERATE_ID));
    await waitFor(() => expect(screen.getByText('Detail view')).toBeInTheDocument());
  });

  test('surfaces a server validation error on activate', async () => {
    const { ApiError } = await import('../../lib/apiClient');
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 60 },
      { id: 'a2', symbol: 'MSFT', weightPct: 40 },
    ]);
    vi.mocked(activateConglomerate).mockRejectedValue(
      new ApiError(400, 'ACTIVATION_INVALID', 'Weights must sum to 100%.'),
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /^activate$/i }));
    expect(await screen.findByText('Weights must sum to 100%.')).toBeInTheDocument();
  });
});
