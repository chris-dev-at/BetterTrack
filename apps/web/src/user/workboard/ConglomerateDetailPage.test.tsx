import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/conglomerateApi', () => ({
  getConglomerate: vi.fn(),
  deleteConglomerate: vi.fn(),
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

import { deleteConglomerate, getConglomerate } from '../../lib/conglomerateApi';
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

  test('shows placeholder slots for the backtest and calculator panels', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(DETAIL);
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    expect(screen.getByText(/Backtest — coming with the backtest panel/i)).toBeInTheDocument();
    expect(screen.getByText(/Calculator — coming with the Invest Calculator/i)).toBeInTheDocument();
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
