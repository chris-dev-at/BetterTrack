import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  ExpenseBudgetListResponse,
  ExpenseMonthlySummaryResponse,
  ExpenseTrendResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/expensesApi', () => ({
  EXPENSE_SUMMARY_QUERY_KEY: ['expenses', 'summary'],
  EXPENSE_TRENDS_QUERY_KEY: ['expenses', 'trends'],
  EXPENSE_BUDGETS_QUERY_KEY: ['expenses', 'budgets'],
  EXPENSE_CATEGORIES_QUERY_KEY: ['expenses', 'categories'],
  getExpenseSummary: vi.fn(),
  getExpenseTrends: vi.fn(),
  listExpenseBudgets: vi.fn(),
  listExpenseCategories: vi.fn(),
  createExpenseBudget: vi.fn(),
  updateExpenseBudget: vi.fn(),
  deleteExpenseBudget: vi.fn(),
}));

import * as expensesApi from '../../lib/expensesApi';

import { DashboardPage } from './DashboardPage';
import { BudgetsPage } from './BudgetsPage';

function renderPage(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const emptySummary: ExpenseMonthlySummaryResponse = {
  month: '2026-07',
  totalExpense: 0,
  totalIncome: 0,
  net: 0,
  categories: [],
};
const emptyTrends: ExpenseTrendResponse = { points: [] };
const emptyBudgets: ExpenseBudgetListResponse = { period: '2026-07', budgets: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(expensesApi.getExpenseSummary).mockResolvedValue(emptySummary);
  vi.mocked(expensesApi.getExpenseTrends).mockResolvedValue(emptyTrends);
  vi.mocked(expensesApi.listExpenseBudgets).mockResolvedValue(emptyBudgets);
  vi.mocked(expensesApi.listExpenseCategories).mockResolvedValue({ categories: [] });
});

describe('DashboardPage', () => {
  test('renders income-vs-spend cards and spend-by-category with data', async () => {
    vi.mocked(expensesApi.getExpenseSummary).mockResolvedValue({
      month: '2026-07',
      totalExpense: 100,
      totalIncome: 200,
      net: 100,
      categories: [
        { categoryId: 'c1', name: 'Groceries', color: '#22c55e', expense: 100, income: 0 },
      ],
    });
    vi.mocked(expensesApi.getExpenseTrends).mockResolvedValue({
      points: [
        { month: '2026-06', expense: 50, income: 200 },
        { month: '2026-07', expense: 100, income: 200 },
      ],
    });
    renderPage(<DashboardPage />);

    // The donut's own legend renders the category label as real DOM — its
    // presence proves the summary + spend-by-category card loaded.
    expect(await screen.findByText('Groceries')).toBeInTheDocument();
    // `Net` is unique to the headline cards; `Income`/`Spend` also appear in the
    // trend legend, so assert they are present (≥1) rather than singular.
    expect(screen.getByText('Net')).toBeInTheDocument();
    expect(screen.getAllByText('Income').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Spend').length).toBeGreaterThanOrEqual(1);
    // The trend card heading.
    expect(screen.getByText('Income vs spend')).toBeInTheDocument();
  });

  test('shows a per-month no-spend note when the month is empty', async () => {
    renderPage(<DashboardPage />);
    expect(await screen.findByText('No spending recorded for this month.')).toBeInTheDocument();
    // The trend card falls back to its empty state.
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
  });
});

describe('BudgetsPage', () => {
  test('lists a budget with its progress and an over-budget badge', async () => {
    vi.mocked(expensesApi.listExpenseBudgets).mockResolvedValue({
      period: '2026-07',
      budgets: [
        {
          id: 'b1',
          categoryId: 'c1',
          categoryName: 'Groceries',
          categoryColor: '#22c55e',
          amount: 100,
          currency: 'EUR',
          period: '2026-07',
          spent: 120,
          remaining: -20,
          exceeded: true,
        },
      ],
    });
    renderPage(<BudgetsPage />);

    expect(await screen.findByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Over budget')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New budget' })).toBeInTheDocument();
  });

  test('shows the empty state with a CTA when there are no budgets', async () => {
    renderPage(<BudgetsPage />);
    expect(await screen.findByText('No budgets yet')).toBeInTheDocument();
    expect(screen.getByText('Add a budget')).toBeInTheDocument();
  });
});
