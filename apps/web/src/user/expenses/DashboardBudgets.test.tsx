import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
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
import { I18nProvider } from '../../i18n';

import { DashboardPage } from './DashboardPage';
import { BudgetsPage } from './BudgetsPage';

function renderPage(node: ReactNode, locale = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider initialLocale={locale}>
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
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

  test('keeps a loaded summary visible while the independent trend is pending', async () => {
    const pendingTrend = deferred<ExpenseTrendResponse>();
    vi.mocked(expensesApi.getExpenseSummary).mockResolvedValue({
      month: '2026-07',
      totalExpense: 100,
      totalIncome: 0,
      net: -100,
      categories: [
        { categoryId: 'c1', name: 'Groceries', color: '#22c55e', expense: 100, income: 0 },
      ],
    });
    vi.mocked(expensesApi.getExpenseTrends).mockReturnValue(pendingTrend.promise);

    renderPage(<DashboardPage />);

    expect(await screen.findByText('Groceries')).toBeInTheDocument();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  test('keeps a loaded trend visible while the independent summary is pending', async () => {
    const pendingSummary = deferred<ExpenseMonthlySummaryResponse>();
    vi.mocked(expensesApi.getExpenseSummary).mockReturnValue(pendingSummary.promise);
    vi.mocked(expensesApi.getExpenseTrends).mockResolvedValue({
      points: [{ month: '2026-03', expense: 50, income: 200 }],
    });

    renderPage(<DashboardPage />);

    expect((await screen.findAllByRole('img')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('status')).toHaveLength(3);
  });

  test('retries only a failed summary and preserves the usable trend', async () => {
    vi.mocked(expensesApi.getExpenseSummary)
      .mockRejectedValueOnce(new Error('summary unavailable'))
      .mockResolvedValueOnce({
        month: '2026-07',
        totalExpense: 100,
        totalIncome: 200,
        net: 100,
        categories: [
          {
            categoryId: 'c1',
            name: 'Recovered summary',
            color: '#22c55e',
            expense: 100,
            income: 0,
          },
        ],
      });
    vi.mocked(expensesApi.getExpenseTrends).mockResolvedValue({
      points: [{ month: '2026-03', expense: 50, income: 200 }],
    });

    renderPage(<DashboardPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your dashboard.");
    expect((await screen.findAllByRole('img')).length).toBeGreaterThan(0);
    const requestedMonth = vi.mocked(expensesApi.getExpenseSummary).mock.calls[0]?.[0];

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Recovered summary')).toBeInTheDocument();
    expect(vi.mocked(expensesApi.getExpenseSummary).mock.calls[1]?.[0]).toBe(requestedMonth);
    expect(expensesApi.getExpenseTrends).toHaveBeenCalledTimes(1);
  });

  test('retries only a failed trend and preserves the usable summary', async () => {
    vi.mocked(expensesApi.getExpenseSummary).mockResolvedValue({
      month: '2026-07',
      totalExpense: 100,
      totalIncome: 200,
      net: 100,
      categories: [
        { categoryId: 'c1', name: 'Groceries', color: '#22c55e', expense: 100, income: 0 },
      ],
    });
    vi.mocked(expensesApi.getExpenseTrends)
      .mockRejectedValueOnce(new Error('trend unavailable'))
      .mockResolvedValueOnce({
        points: [{ month: '2026-03', expense: 50, income: 200 }],
      });

    renderPage(<DashboardPage />);

    expect(await screen.findByText('Groceries')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your dashboard.");

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Mar')).toBeInTheDocument();
    expect(expensesApi.getExpenseSummary).toHaveBeenCalledTimes(1);
    expect(expensesApi.getExpenseTrends).toHaveBeenCalledTimes(2);
  });

  test('refetches only the monthly summary when changing the selected month', async () => {
    vi.mocked(expensesApi.getExpenseSummary).mockImplementation(async (month) => ({
      month: month ?? '2026-07',
      totalExpense: 100,
      totalIncome: 0,
      net: -100,
      categories: [
        {
          categoryId: 'c1',
          name: month === '2026-03' ? 'Requested month' : 'Initial month',
          color: '#22c55e',
          expense: 100,
          income: 0,
        },
      ],
    }));

    renderPage(<DashboardPage />);

    expect(await screen.findByText('Initial month')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-03' } });

    expect(await screen.findByText('Requested month')).toBeInTheDocument();
    expect(vi.mocked(expensesApi.getExpenseSummary).mock.calls.at(-1)?.[0]).toBe('2026-03');
    expect(expensesApi.getExpenseTrends).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['en', 'en-GB'],
    ['de', 'de-AT'],
  ])(
    'uses the active %s locale for trend labels and accessible bar text',
    async (locale, intlLocale) => {
      vi.mocked(expensesApi.getExpenseTrends).mockResolvedValue({
        points: [{ month: '2026-03', expense: 50, income: 200 }],
      });
      const expectedMonth = new Intl.DateTimeFormat(intlLocale, {
        month: 'short',
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(2026, 2, 1)));

      renderPage(<DashboardPage />, locale);

      expect(await screen.findByText(expectedMonth)).toBeInTheDocument();
      for (const bar of screen.getAllByRole('img')) {
        expect(bar).toHaveAttribute('title', expect.stringContaining(`${expectedMonth} · `));
        expect(bar).toHaveAttribute('aria-label', bar.getAttribute('title'));
      }
    },
  );
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
