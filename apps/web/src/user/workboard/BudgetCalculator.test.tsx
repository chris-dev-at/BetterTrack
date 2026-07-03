import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { AllocateResponse } from '@bettertrack/contracts';

vi.mock('../../lib/conglomerateApi', () => ({
  allocateConglomerate: vi.fn(),
}));

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  createTransactions: vi.fn(),
  updateTransaction: vi.fn(),
}));

import { allocateConglomerate } from '../../lib/conglomerateApi';
import { createTransactions, listPortfolios } from '../../lib/portfolioApi';
import { BudgetCalculator } from './BudgetCalculator';

const CONGLOMERATE_ID = 'c1';

// PROJECTPLAN.md §6.7 worked example: B = 1000 €, BAYN.DE 30% @ 25 €, NVDA 60%
// @ 150 €, GOOGL 10% @ 140 € — GOOGL's slice (100 €) can't afford one share.
const RESPONSE: AllocateResponse = {
  positions: [
    {
      assetId: 'a-bayn',
      symbol: 'BAYN.DE',
      name: 'Bayer AG',
      qty: 12,
      costEur: 300,
      actualPct: 30,
      targetPct: 30,
      deltaPp: 0,
    },
    {
      assetId: 'a-nvda',
      symbol: 'NVDA',
      name: 'NVIDIA Corp.',
      qty: 4,
      costEur: 600,
      actualPct: 60,
      targetPct: 60,
      deltaPp: 0,
    },
    {
      assetId: 'a-googl',
      symbol: 'GOOGL',
      name: 'Alphabet Inc.',
      qty: 0,
      costEur: 0,
      actualPct: 0,
      targetPct: 10,
      deltaPp: -10,
      unbuyable: true,
      note: 'GOOGL share price (140 €) exceeds its 100 € slice; raise the budget to ≥ ~1400 € or use fractional mode.',
    },
  ],
  totalCostEur: 900,
  leftoverEur: 100,
  warnings: [
    'GOOGL share price (140 €) exceeds its 100 € slice; raise the budget to ≥ ~1400 € or use fractional mode.',
  ],
  stale: false,
  quoteNotice: null,
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderCalculator() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <BudgetCalculator conglomerateId={CONGLOMERATE_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function calculate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Calculate' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPortfolios).mockResolvedValue({
    portfolios: [
      { id: 'p1', name: 'Default', visibility: 'private', sortOrder: 0, isDefault: true },
    ],
  });
});

describe('BudgetCalculator', () => {
  test('calculating renders the deviation table and a totals footer with total cost ≤ budget', async () => {
    vi.mocked(allocateConglomerate).mockResolvedValue(RESPONSE);
    const user = userEvent.setup();
    renderCalculator();

    await calculate(user);

    await waitFor(() =>
      expect(allocateConglomerate).toHaveBeenCalledWith(CONGLOMERATE_ID, {
        budgetEur: 1000,
        mode: 'whole',
      }),
    );

    const table = screen.getByRole('table');
    expect(within(table).getByText('BAYN.DE')).toBeInTheDocument();
    expect(within(table).getByText('NVDA')).toBeInTheDocument();
    expect(within(table).getByText('GOOGL')).toBeInTheDocument();
    expect(within(table).getByText('300,00 €')).toBeInTheDocument();
    expect(within(table).getByText('600,00 €')).toBeInTheDocument();
    expect(within(table).getByText('-10,0 %')).toBeInTheDocument();

    expect(screen.getByText('Total cost')).toBeInTheDocument();
    expect(screen.getByText('900,00 €')).toBeInTheDocument();
    expect(screen.getByText('Leftover')).toBeInTheDocument();
    expect(screen.getByText('100,00 €')).toBeInTheDocument();
    expect(screen.getByText('Within budget')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  test('an unbuyable position surfaces its note inline instead of being hidden', async () => {
    vi.mocked(allocateConglomerate).mockResolvedValue(RESPONSE);
    const user = userEvent.setup();
    renderCalculator();

    await calculate(user);

    const table = await screen.findByRole('table');
    expect(
      within(table).getByText(/GOOGL share price \(140 €\) exceeds its 100 € slice/i),
    ).toBeInTheDocument();
  });

  test('warnings and a stale quote notice render as a non-blocking banner', async () => {
    vi.mocked(allocateConglomerate).mockResolvedValue({
      ...RESPONSE,
      warnings: [],
      stale: true,
      quoteNotice: 'Markets are closed; showing last close.',
    });
    const user = userEvent.setup();
    renderCalculator();

    await calculate(user);

    const notice = await screen.findByText('Markets are closed; showing last close.');
    expect(notice.closest('[role="alert"]')).not.toHaveClass('text-red-200');
  });

  test('shows an error state when the allocate request fails', async () => {
    vi.mocked(allocateConglomerate).mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderCalculator();

    await calculate(user);

    expect(await screen.findByText(/Could not calculate a buy list/i)).toBeInTheDocument();
  });

  test('Add to Portfolio opens the bulk dialog prefilled with the non-zero BUYs, and confirming bulk-inserts', async () => {
    vi.mocked(allocateConglomerate).mockResolvedValue(RESPONSE);
    vi.mocked(createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderCalculator();

    await calculate(user);
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add to Portfolio' }));

    const dialog = await screen.findByRole('dialog', { name: /record transaction/i });
    expect(within(dialog).getByText('BAYN.DE')).toBeInTheDocument();
    expect(within(dialog).getByText('NVDA')).toBeInTheDocument();
    expect(within(dialog).queryByText('GOOGL')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Quantity for BAYN.DE')).toHaveValue(12);
    expect(within(dialog).getByLabelText('Price for BAYN.DE')).toHaveValue(25);
    expect(within(dialog).getByLabelText('Quantity for NVDA')).toHaveValue(4);
    expect(within(dialog).getByLabelText('Price for NVDA')).toHaveValue(150);

    await user.click(within(dialog).getByRole('button', { name: 'Record' }));

    await waitFor(() =>
      expect(createTransactions).toHaveBeenCalledWith(
        'p1',
        expect.arrayContaining([
          expect.objectContaining({ assetId: 'a-bayn', side: 'buy', quantity: 12, price: 25 }),
          expect.objectContaining({ assetId: 'a-nvda', side: 'buy', quantity: 4, price: 150 }),
        ]),
      ),
    );
  });

  test('Add to Portfolio is disabled when every position is unbuyable', async () => {
    vi.mocked(allocateConglomerate).mockResolvedValue({
      ...RESPONSE,
      positions: RESPONSE.positions.filter((p) => p.symbol === 'GOOGL'),
      totalCostEur: 0,
      leftoverEur: 1000,
    });
    const user = userEvent.setup();
    renderCalculator();

    await calculate(user);
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Add to Portfolio' })).toBeDisabled();
  });
});
