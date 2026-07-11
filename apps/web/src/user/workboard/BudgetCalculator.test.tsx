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
      nativePrice: 25,
      currency: 'EUR',
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
      // Native-currency price differs from the EUR-converted costEur/qty (163.20 €)
      // to prove the prefill uses nativePrice/currency, not costEur.
      nativePrice: 163.2,
      currency: 'USD',
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
      nativePrice: 152.6,
      currency: 'USD',
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
  baseCurrency: 'EUR',
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
});

describe('BudgetCalculator', () => {
  test('whole-shares mode hides the fractional step-precision selector, and steps by whole euros (#363)', async () => {
    const user = userEvent.setup();
    renderCalculator();

    const budget = screen.getByLabelText('Budget in EUR') as HTMLInputElement;
    expect(budget.value).toBe('1000');
    // Sub-integer precision is meaningless with whole shares — no selector here.
    expect(screen.queryByLabelText('Budget step precision')).not.toBeInTheDocument();
    expect(budget).toHaveAttribute('step', '1');

    await user.click(screen.getByRole('button', { name: 'Increase budget by 1' }));
    expect(budget.value).toBe('1001');
  });

  test('fractional mode exposes the step-precision selector down to 0.00001, stepping in cents (V3-P0 #322, #363)', async () => {
    const user = userEvent.setup();
    renderCalculator();

    await user.click(screen.getByRole('button', { name: 'Fractional' }));

    const budget = screen.getByLabelText('Budget in EUR') as HTMLInputElement;

    // Selecting 0.01 makes the stepper move in cents and rewrites the input
    // `step` so keyboard/native stepping matches — "how far off the comma".
    const precision = screen.getByLabelText('Budget step precision');
    expect(
      within(precision as HTMLElement).getByRole('option', { name: '0.00001' }),
    ).toBeInTheDocument();
    await user.selectOptions(precision, '0.01');
    expect(budget).toHaveAttribute('step', '0.01');

    await user.click(screen.getByRole('button', { name: 'Increase budget by 0.01' }));
    expect(budget.value).toBe('1000.01');
    await user.click(screen.getByRole('button', { name: 'Decrease budget by 0.01' }));
    expect(budget.value).toBe('1000.00');
  });

  test('a BTC-EUR-scale fractional step of 0.0001 accumulates with no floating-point dust (#363)', async () => {
    const user = userEvent.setup();
    renderCalculator();

    await user.click(screen.getByRole('button', { name: 'Fractional' }));

    const budget = screen.getByLabelText('Budget in EUR') as HTMLInputElement;
    await user.clear(budget);
    await user.type(budget, '0');

    await user.selectOptions(screen.getByLabelText('Budget step precision'), '0.0001');
    expect(budget).toHaveAttribute('step', '0.0001');

    // Three 0.0001 steps: naive float addition gives 0.00030000000000000003;
    // the re-quantizing stepper must land on exactly "0.0003".
    const up = screen.getByRole('button', { name: 'Increase budget by 0.0001' });
    await user.click(up);
    await user.click(up);
    await user.click(up);
    expect(budget.value).toBe('0.0003');
  });

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
    expect(within(table).getByText('-10,00 %')).toBeInTheDocument();

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

    const dialog = await screen.findByRole('dialog', { name: /new transaction/i });
    expect(within(dialog).getByText('BAYN.DE')).toBeInTheDocument();
    expect(within(dialog).getByText('NVDA')).toBeInTheDocument();
    expect(within(dialog).queryByText('GOOGL')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Quantity for BAYN.DE')).toHaveValue(12);
    expect(within(dialog).getByLabelText('Price for BAYN.DE')).toHaveValue(25);
    expect(within(dialog).getByLabelText('Quantity for NVDA')).toHaveValue(4);
    // NVDA is USD-quoted: the prefilled price is the native 163.20 USD/share,
    // not the EUR-converted costEur/qty (150) — proves the buy flow records
    // cost basis in the asset's own currency, not a mis-currencied EUR amount.
    // The native currency shows as a "$" field suffix (#378 redesign).
    expect(within(dialog).getAllByText('$').length).toBeGreaterThan(0);
    expect(within(dialog).getByLabelText('Price for NVDA')).toHaveValue(163.2);

    await user.click(within(dialog).getByRole('button', { name: 'Record' }));

    await waitFor(() =>
      expect(createTransactions).toHaveBeenCalledWith(
        'p1',
        expect.arrayContaining([
          expect.objectContaining({ assetId: 'a-bayn', side: 'buy', quantity: 12, price: 25 }),
          expect.objectContaining({ assetId: 'a-nvda', side: 'buy', quantity: 4, price: 163.2 }),
        ]),
      ),
    );
  });

  test('the "at least one share" toggle defaults OFF, and toggling ON re-runs allocation with the flag', async () => {
    vi.mocked(allocateConglomerate)
      .mockResolvedValueOnce(RESPONSE)
      .mockResolvedValueOnce({
        ...RESPONSE,
        positions: RESPONSE.positions.map((p) =>
          p.symbol === 'GOOGL'
            ? {
                ...p,
                qty: 1,
                costEur: 140,
                actualPct: 14,
                deltaPp: 4,
                unbuyable: false,
                note: undefined,
              }
            : p,
        ),
        totalCostEur: 1040,
        leftoverEur: -40,
      });
    const user = userEvent.setup();
    renderCalculator();

    const toggle = screen.getByRole('switch', { name: 'At least one share' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await calculate(user);
    await waitFor(() =>
      expect(allocateConglomerate).toHaveBeenLastCalledWith(CONGLOMERATE_ID, {
        budgetEur: 1000,
        mode: 'whole',
      }),
    );
    expect(await screen.findByText('GOOGL')).toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await waitFor(() =>
      expect(allocateConglomerate).toHaveBeenLastCalledWith(CONGLOMERATE_ID, {
        budgetEur: 1000,
        mode: 'whole',
        atLeastOneShare: true,
      }),
    );
    await waitFor(() => expect(screen.getByText('1.040,00 €')).toBeInTheDocument());
  });

  test('the "at least one share" toggle is hidden in fractional mode', async () => {
    const user = userEvent.setup();
    renderCalculator();

    await user.click(screen.getByRole('button', { name: 'Fractional' }));

    expect(screen.queryByRole('switch', { name: 'At least one share' })).not.toBeInTheDocument();
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
