import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { PortfolioSummary, StandingOrder } from '@bettertrack/contracts';

vi.mock('../../lib/standingOrdersApi', () => ({
  STANDING_ORDERS_QUERY_KEY: ['standingOrders'],
  createStandingOrder: vi.fn(),
  updateStandingOrder: vi.fn(),
}));

// AssetSearchBox pulls in a full network + navigation stack; the dialog only
// consumes its picked-asset callback, so a stub button is easier to drive than
// the real search flow.
vi.mock('../components/AssetSearchBox', () => ({
  AssetSearchBox: ({
    onSelect,
  }: {
    onSelect: (item: { id: string; symbol: string; name: string; currency: string }) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onSelect({ id: 'a1', symbol: 'VWCE.DE', name: 'Vanguard FTSE All-World', currency: 'EUR' })
      }
    >
      Pick asset (mock)
    </button>
  ),
}));

import * as standingOrdersApi from '../../lib/standingOrdersApi';

import { StandingOrderDialog } from './StandingOrderDialog';

const PORTFOLIOS: PortfolioSummary[] = [
  {
    id: 'p1',
    name: 'Main',
    visibility: 'private',
    sortOrder: 0,
    isDefault: true,
    defaultPayFromCash: false,
    archivedAt: null,
  },
];

function renderDialog(props: Partial<React.ComponentProps<typeof StandingOrderDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StandingOrderDialog portfolios={PORTFOLIOS} onClose={onClose} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StandingOrderDialog — create', () => {
  test('buy-asset requires an asset before submit', async () => {
    const user = userEvent.setup();
    renderDialog();

    // Kind defaults to buy-asset; no asset picked yet.
    await user.type(screen.getByLabelText('Quantity (shares)'), '5');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Search for the asset you want to buy.')).toBeInTheDocument();
    expect(standingOrdersApi.createStandingOrder).not.toHaveBeenCalled();
  });

  test('cash-add posts label + EUR amount and never sends assetId', async () => {
    vi.mocked(standingOrdersApi.createStandingOrder).mockResolvedValue({} as StandingOrder);
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Add cash' }));
    // Asset picker is gone for cash kinds.
    expect(screen.queryByRole('button', { name: 'Pick asset (mock)' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Amount (€)'), '2500');
    await user.type(screen.getByLabelText('Label (optional)'), 'salary');
    // Cadence stays monthly (the default), anchorDay stays 1.
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(standingOrdersApi.createStandingOrder).toHaveBeenCalled());
    const body = vi.mocked(standingOrdersApi.createStandingOrder).mock.calls[0]![0];
    expect(body).toMatchObject({
      portfolioId: 'p1',
      kind: 'cash-add',
      amount: 2500,
      label: 'salary',
      cadence: 'monthly',
      anchorDay: 1,
    });
    expect(body.assetId).toBeUndefined();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test('buy-asset posts the picked assetId + quantity', async () => {
    vi.mocked(standingOrdersApi.createStandingOrder).mockResolvedValue({} as StandingOrder);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Pick asset (mock)' }));
    // Once picked, the locked chip replaces the picker.
    expect(screen.getByText('VWCE.DE')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Quantity (shares)'), '3');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(standingOrdersApi.createStandingOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          portfolioId: 'p1',
          kind: 'buy-asset',
          assetId: 'a1',
          amount: 3,
          cadence: 'monthly',
        }),
      ),
    );
  });

  test('switching to daily removes the day-of-month field', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Add cash' }));
    expect(screen.getByLabelText('Day of month')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Cadence'), 'daily');
    expect(screen.queryByLabelText('Day of month')).not.toBeInTheDocument();
  });

  test('rejects an amount ≤ 0 before hitting the API', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Add cash' }));
    await user.type(screen.getByLabelText('Amount (€)'), '0');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Enter an amount greater than zero.')).toBeInTheDocument();
    expect(standingOrdersApi.createStandingOrder).not.toHaveBeenCalled();
  });
});

describe('StandingOrderDialog — edit', () => {
  const EXISTING: StandingOrder = {
    id: 'so1',
    portfolioId: 'p1',
    kind: 'cash-add',
    assetId: null,
    assetSymbol: null,
    assetName: null,
    amount: 1000,
    currency: 'EUR',
    label: 'salary',
    cadence: 'monthly',
    anchorDay: 5,
    startDate: '2026-07-01',
    endDate: null,
    status: 'active',
    lastRunAt: null,
    lastPeriodKey: null,
    nextRunDate: '2026-08-05',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };

  test('patches only amount + label + endDate; schedule fields are locked out', async () => {
    vi.mocked(standingOrdersApi.updateStandingOrder).mockResolvedValue(EXISTING);
    const user = userEvent.setup();
    renderDialog({ existing: EXISTING });

    // Schedule immutability note is visible; cadence/day-of-month are hidden.
    expect(
      screen.getByText(
        'Kind, asset and schedule are locked once created. Delete and recreate to change them.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Cadence')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Day of month')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();

    const amountInput = screen.getByLabelText('Amount (€)');
    await user.clear(amountInput);
    await user.type(amountInput, '1500');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(standingOrdersApi.updateStandingOrder).toHaveBeenCalledWith('so1', {
        amount: 1500,
        label: 'salary',
        endDate: null,
      }),
    );
  });
});
