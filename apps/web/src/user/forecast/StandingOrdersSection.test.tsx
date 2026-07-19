import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { PortfolioSummary, StandingOrder } from '@bettertrack/contracts';

vi.mock('../../lib/standingOrdersApi', () => ({
  STANDING_ORDERS_QUERY_KEY: ['standingOrders'],
  listStandingOrders: vi.fn(),
  createStandingOrder: vi.fn(),
  updateStandingOrder: vi.fn(),
  pauseStandingOrder: vi.fn(),
  resumeStandingOrder: vi.fn(),
  deleteStandingOrder: vi.fn(),
}));

import * as standingOrdersApi from '../../lib/standingOrdersApi';

import { StandingOrdersSection } from './StandingOrdersSection';

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

function makeOrder(over: Partial<StandingOrder> = {}): StandingOrder {
  return {
    id: 'so1',
    portfolioId: 'p1',
    kind: 'buy-asset',
    assetId: 'a1',
    assetSymbol: 'VWCE.DE',
    assetName: 'Vanguard FTSE All-World',
    amount: 5,
    currency: 'EUR',
    label: null,
    cadence: 'monthly',
    anchorDay: 1,
    startDate: '2026-07-01',
    endDate: null,
    status: 'active',
    lastRunAt: null,
    lastPeriodKey: null,
    nextRunDate: '2026-08-01',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StandingOrdersSection portfolios={PORTFOLIOS} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(standingOrdersApi.listStandingOrders).mockResolvedValue({ orders: [] });
});

describe('StandingOrdersSection', () => {
  test('shows the designed empty state and a New-order CTA', async () => {
    renderSection();
    expect(await screen.findByText('No standing orders yet')).toBeInTheDocument();
    // The header still has the visible primary CTA.
    expect(screen.getByRole('button', { name: 'New standing order' })).toBeInTheDocument();
  });

  test('lists each order with its next run', async () => {
    vi.mocked(standingOrdersApi.listStandingOrders).mockResolvedValue({
      orders: [
        makeOrder({ id: 'so-buy', assetSymbol: 'VWCE.DE', amount: 3, nextRunDate: '2026-08-01' }),
        makeOrder({
          id: 'so-cash',
          kind: 'cash-add',
          assetId: null,
          assetSymbol: null,
          assetName: null,
          amount: 2500,
          label: 'salary',
          nextRunDate: '2026-08-05',
          cadence: 'monthly',
          anchorDay: 5,
        }),
      ],
    });
    renderSection();

    expect(await screen.findByText('VWCE.DE')).toBeInTheDocument();
    // The row's compact description bundles amount + cadence in one line;
    // match on a substring so the ` · ` separator between them is ignored.
    expect(screen.getByText(/Buy 3 × VWCE\.DE/)).toBeInTheDocument();
    // Localized date + label the row exposes.
    expect(screen.getByText(/Next run: 01\.08\.2026/)).toBeInTheDocument();

    expect(screen.getByText('salary')).toBeInTheDocument();
    expect(screen.getByText(/Add 2\.500,00 €/)).toBeInTheDocument();
  });

  test('pauses an active order and reflects the resume affordance after refetch', async () => {
    const active = makeOrder({ status: 'active' });
    const paused = makeOrder({ status: 'paused', nextRunDate: null });
    vi.mocked(standingOrdersApi.listStandingOrders)
      .mockResolvedValueOnce({ orders: [active] })
      .mockResolvedValue({ orders: [paused] });
    vi.mocked(standingOrdersApi.pauseStandingOrder).mockResolvedValue(paused);

    const user = userEvent.setup();
    renderSection();

    await screen.findByText('VWCE.DE');
    await user.click(screen.getByRole('button', { name: 'Pause' }));

    await waitFor(() => expect(standingOrdersApi.pauseStandingOrder).toHaveBeenCalledWith('so1'));
    // After the mutation success the shared query key refetches and the row now
    // exposes Resume + a Paused badge.
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  test('resumes a paused order and swaps back to Pause', async () => {
    const paused = makeOrder({ status: 'paused', nextRunDate: null });
    const active = makeOrder({ status: 'active', nextRunDate: '2026-08-01' });
    vi.mocked(standingOrdersApi.listStandingOrders)
      .mockResolvedValueOnce({ orders: [paused] })
      .mockResolvedValue({ orders: [active] });
    vi.mocked(standingOrdersApi.resumeStandingOrder).mockResolvedValue(active);

    const user = userEvent.setup();
    renderSection();

    await screen.findByRole('button', { name: 'Resume' });
    await user.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() => expect(standingOrdersApi.resumeStandingOrder).toHaveBeenCalledWith('so1'));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  test('confirms before deleting and then round-trips', async () => {
    vi.mocked(standingOrdersApi.listStandingOrders)
      .mockResolvedValueOnce({ orders: [makeOrder()] })
      .mockResolvedValue({ orders: [] });
    vi.mocked(standingOrdersApi.deleteStandingOrder).mockResolvedValue();

    const user = userEvent.setup();
    renderSection();

    await screen.findByText('VWCE.DE');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    // A confirm prompt appears before any API call is made.
    expect(standingOrdersApi.deleteStandingOrder).not.toHaveBeenCalled();
    expect(screen.getByText('Delete?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Yes' }));

    await waitFor(() => expect(standingOrdersApi.deleteStandingOrder).toHaveBeenCalledWith('so1'));
    // After refetch the list is empty again.
    expect(await screen.findByText('No standing orders yet')).toBeInTheDocument();
  });

  test('surfaces the load-error banner when the fetch fails', async () => {
    vi.mocked(standingOrdersApi.listStandingOrders).mockRejectedValue(new Error('boom'));
    renderSection();

    expect(
      await screen.findByText('Could not load your standing orders. Please try again.'),
    ).toBeInTheDocument();
  });

  test('paused orders show "No next run scheduled" instead of a date', async () => {
    vi.mocked(standingOrdersApi.listStandingOrders).mockResolvedValue({
      orders: [makeOrder({ status: 'paused', nextRunDate: null })],
    });
    renderSection();

    await screen.findByText('VWCE.DE');
    expect(screen.getByText('No next run scheduled.')).toBeInTheDocument();
  });

  test('opens the edit dialog for a row', async () => {
    vi.mocked(standingOrdersApi.listStandingOrders).mockResolvedValue({
      orders: [makeOrder()],
    });
    const user = userEvent.setup();
    renderSection();

    await screen.findByText('VWCE.DE');
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit standing order' });
    // Kind is locked in edit mode — every non-current tab is disabled.
    expect(within(dialog).getByRole('button', { name: 'Add cash' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Buy asset' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
