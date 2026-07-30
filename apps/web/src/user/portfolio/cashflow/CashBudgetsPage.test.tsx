import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  CashBudgetListResponse,
  CashBudgetProgress,
  CashTag,
  PortfolioListResponse,
} from '@bettertrack/contracts';

vi.mock('../../../lib/portfolioApi');
vi.mock('../../../lib/cashApi', () => ({
  CASH_TAGS_QUERY_KEY: ['cash', 'tags'],
  cashBudgetsQueryKey: (portfolioId: string, month?: string) => [
    'cash',
    'budgets',
    portfolioId,
    month,
  ],
  listCashTags: vi.fn(),
  listCashBudgets: vi.fn(),
  createCashBudget: vi.fn(),
  updateCashBudget: vi.fn(),
  deleteCashBudget: vi.fn(),
}));

import { listPortfolios } from '../../../lib/portfolioApi';
import {
  createCashBudget,
  deleteCashBudget,
  listCashBudgets,
  listCashTags,
  updateCashBudget,
} from '../../../lib/cashApi';
import { ApiError } from '../../../lib/apiClient';

import { CashBudgetsPage } from './CashBudgetsPage';

const PORTFOLIOS: PortfolioListResponse = {
  portfolios: [
    {
      id: 'p1',
      name: 'Main',
      visibility: 'private',
      sortOrder: 0,
      isDefault: true,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  ],
};

const FOOD: CashTag = {
  id: 't-food',
  name: 'Food',
  color: '#22c55e',
  system: false,
  systemKey: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const RENT: CashTag = { ...FOOD, id: 't-rent', name: 'Rent', color: '#3987e5' };

function budget(over: Partial<CashBudgetProgress> = {}): CashBudgetProgress {
  return {
    id: 'b1',
    portfolioId: 'p1',
    tagId: FOOD.id,
    tagName: FOOD.name,
    tagColor: FOOD.color,
    amount: 100,
    currency: 'EUR',
    period: '2026-07',
    recurring: true,
    spent: 60,
    remaining: 40,
    exceeded: false,
    ...over,
  };
}

const EMPTY_BUDGETS: CashBudgetListResponse = { period: '2026-07', budgets: [] };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CashBudgetsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPortfolios).mockResolvedValue(PORTFOLIOS);
  vi.mocked(listCashTags).mockResolvedValue({ tags: [FOOD, RENT] });
  vi.mocked(listCashBudgets).mockResolvedValue(EMPTY_BUDGETS);
});

describe('CashBudgetsPage', () => {
  test('renders the exceeded state distinctly from an on-track budget', async () => {
    vi.mocked(listCashBudgets).mockResolvedValue({
      period: '2026-07',
      budgets: [
        budget({
          id: 'b-ok',
          tagName: 'Food',
          spent: 60,
          amount: 100,
          remaining: 40,
          exceeded: false,
        }),
        budget({
          id: 'b-over',
          tagId: RENT.id,
          tagName: 'Rent',
          spent: 120,
          amount: 100,
          remaining: -20,
          exceeded: true,
        }),
      ],
    });
    renderPage();

    await screen.findByText('Food');
    expect(screen.getByText('Over budget')).toBeInTheDocument();
    expect(screen.getByText('20,00 € over')).toBeInTheDocument();
    expect(screen.getByText('40,00 € left')).toBeInTheDocument();
  });

  test('distinguishes a recurring target from a this-month-only override', async () => {
    vi.mocked(listCashBudgets).mockResolvedValue({
      period: '2026-07',
      budgets: [
        budget({ id: 'b-rec', recurring: true, period: '2026-07' }),
        budget({
          id: 'b-once',
          tagId: RENT.id,
          tagName: 'Rent',
          recurring: false,
          period: '2026-07',
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText('Recurring')).toBeInTheDocument();
    expect(screen.getByText('2026-07 only')).toBeInTheDocument();
  });

  test('creates a recurring budget for an unbudgeted tag', async () => {
    vi.mocked(createCashBudget).mockResolvedValue({
      budget: { ...budget(), id: 'b-new' } as never,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New budget' }));
    const dialog = screen.getByRole('dialog', { name: 'New budget' });
    await user.selectOptions(within(dialog).getByLabelText('Tag'), FOOD.id);
    await user.type(within(dialog).getByLabelText('Monthly target'), '150');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(createCashBudget).toHaveBeenCalledWith({
      portfolioId: 'p1',
      tagId: FOOD.id,
      period: null,
      amount: 150,
      currency: 'EUR',
    });
  });

  test('edit retargets the amount only — tag and period are read-only', async () => {
    vi.mocked(listCashBudgets).mockResolvedValue({ period: '2026-07', budgets: [budget()] });
    vi.mocked(updateCashBudget).mockResolvedValue({
      budget: {
        id: 'b1',
        portfolioId: 'p1',
        tagId: FOOD.id,
        period: '2026-07',
        amount: 200,
        currency: 'EUR',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit budget' });
    expect(within(dialog).queryByLabelText('Tag')).not.toBeInTheDocument();
    const amountInput = within(dialog).getByLabelText('Monthly target');
    await user.clear(amountInput);
    await user.type(amountInput, '200');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(updateCashBudget).toHaveBeenCalledWith('b1', { amount: 200 });
  });

  test('surfaces the 409 duplicate-budget error inline', async () => {
    vi.mocked(createCashBudget).mockRejectedValue(
      new ApiError(409, 'CASH_BUDGET_EXISTS', 'exists'),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New budget' }));
    const dialog = screen.getByRole('dialog', { name: 'New budget' });
    await user.type(within(dialog).getByLabelText('Monthly target'), '50');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('That tag already has a budget for this period.'),
    ).toBeInTheDocument();
  });

  test('deletes a budget after confirmation', async () => {
    vi.mocked(listCashBudgets).mockResolvedValue({ period: '2026-07', budgets: [budget()] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(deleteCashBudget).toHaveBeenCalledWith('b1');
  });

  test('renders the empty state with a create CTA when nothing is budgeted', async () => {
    renderPage();

    expect(await screen.findByText('No budgets yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a budget' })).toBeInTheDocument();
  });
});
