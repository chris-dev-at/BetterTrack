import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ExpenseBudgetListResponse, ExpenseCategory } from '@bettertrack/contracts';

import { I18nProvider } from '../../i18n';

vi.mock('../../lib/expensesApi', () => ({
  EXPENSE_BUDGETS_QUERY_KEY: ['expenses', 'budgets'],
  EXPENSE_CATEGORIES_QUERY_KEY: ['expenses', 'categories'],
  createExpenseBudget: vi.fn(),
  deleteExpenseBudget: vi.fn(),
  listExpenseBudgets: vi.fn(),
  listExpenseCategories: vi.fn(),
  updateExpenseBudget: vi.fn(),
}));

import * as expensesApi from '../../lib/expensesApi';

import { BudgetsPage } from './BudgetsPage';

const CATEGORIES: ExpenseCategory[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Groceries',
    direction: 'expense',
    color: '#22c55e',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const EMPTY_BUDGETS: ExpenseBudgetListResponse = { period: '2026-07', budgets: [] };

const BUDGETS: ExpenseBudgetListResponse = {
  period: '2026-07',
  budgets: [
    {
      id: 'b-under',
      categoryId: CATEGORIES[0]!.id,
      categoryName: 'Under target',
      categoryColor: '#22c55e',
      amount: 100,
      currency: 'EUR',
      period: '2026-07',
      spent: 60,
      remaining: 40,
      exceeded: false,
    },
    {
      id: 'b-close',
      categoryId: '00000000-0000-4000-8000-000000000002',
      categoryName: 'At target threshold',
      categoryColor: '#f59e0b',
      amount: 100,
      currency: 'EUR',
      period: '2026-07',
      spent: 80,
      remaining: 20,
      exceeded: false,
    },
    {
      id: 'b-over',
      categoryId: '00000000-0000-4000-8000-000000000003',
      categoryName: 'Over target',
      categoryColor: '#ef4444',
      amount: 100,
      currency: 'EUR',
      period: '2026-07',
      spent: 120,
      remaining: -20,
      exceeded: true,
    },
  ],
};

function renderPage(node: ReactNode = <BudgetsPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
  return client;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(expensesApi.listExpenseBudgets).mockResolvedValue(EMPTY_BUDGETS);
  vi.mocked(expensesApi.listExpenseCategories).mockResolvedValue({ categories: CATEGORIES });
});

describe('BudgetsPage', () => {
  test('keeps an accessible loading presentation until both prerequisites settle', async () => {
    const categories = deferred<{ categories: ExpenseCategory[] }>();
    vi.mocked(expensesApi.listExpenseCategories).mockReturnValueOnce(categories.promise);
    renderPage();

    expect(await screen.findAllByRole('status')).toHaveLength(2);
    expect(screen.queryByText('No budgets yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New budget' })).toBeDisabled();

    categories.resolve({ categories: CATEGORIES });
    expect(await screen.findByText('No budgets yet')).toBeInTheDocument();
  });

  test.each([
    ['budgets', 'listExpenseBudgets'],
    ['categories', 'listExpenseCategories'],
  ] as const)('renders a retryable load error when %s fail', async (_, method) => {
    const retry = vi.mocked(expensesApi[method]);
    retry.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your budgets.");
    expect(screen.getByRole('button', { name: 'New budget' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No budgets yet')).toBeInTheDocument();
  });

  test('keeps budget controls disabled without usable category data', async () => {
    vi.mocked(expensesApi.listExpenseBudgets).mockResolvedValueOnce({
      period: '2026-07',
      budgets: [BUDGETS.budgets[0]!],
    });
    vi.mocked(expensesApi.listExpenseCategories).mockResolvedValueOnce({ categories: [] });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Under target')).toBeInTheDocument();
    const newBudget = screen.getByRole('button', { name: 'New budget' });
    const edit = screen.getByRole('button', { name: 'Edit' });
    expect(newBudget).toBeDisabled();
    expect(edit).toBeDisabled();

    await user.click(newBudget);
    await user.click(edit);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('renders progress tone, clamped values, and remaining amounts', async () => {
    vi.mocked(expensesApi.listExpenseBudgets).mockResolvedValueOnce(BUDGETS);
    renderPage();

    await screen.findByText('Under target');
    const under = screen.getByRole('progressbar', { name: 'Under target' });
    const close = screen.getByRole('progressbar', { name: 'At target threshold' });
    const over = screen.getByRole('progressbar', { name: 'Over target' });

    expect(under).toHaveAttribute('aria-valuenow', '60');
    expect(under.firstElementChild).toHaveClass('bg-emerald-500');
    expect(close).toHaveAttribute('aria-valuenow', '80');
    expect(close.firstElementChild).toHaveClass('bg-amber-500');
    expect(over).toHaveAttribute('aria-valuenow', '100');
    expect(over.firstElementChild).toHaveClass('bg-red-500');
    expect(screen.getByText('40.00 € left')).toBeInTheDocument();
    expect(screen.getByText('20.00 € over')).toBeInTheDocument();
  });

  test('passes the selected budget into the edit dialog', async () => {
    vi.mocked(expensesApi.listExpenseBudgets).mockResolvedValueOnce({
      period: '2026-07',
      budgets: [BUDGETS.budgets[0]!],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const dialog = screen.getByRole('dialog', { name: 'Edit budget' });
    expect(within(dialog).getByText('Under target')).toBeInTheDocument();
    expect(within(dialog).getByRole('spinbutton')).toHaveValue(100);
  });

  test('cancels a delete confirmation without submitting', async () => {
    vi.mocked(expensesApi.listExpenseBudgets).mockResolvedValueOnce({
      period: '2026-07',
      budgets: [BUDGETS.budgets[0]!],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(expensesApi.deleteExpenseBudget).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  test('prevents duplicate deletion while pending and invalidates budgets after success', async () => {
    vi.mocked(expensesApi.listExpenseBudgets).mockResolvedValue({
      period: '2026-07',
      budgets: [BUDGETS.budgets[0]!],
    });
    const pendingDelete = deferred<void>();
    vi.mocked(expensesApi.deleteExpenseBudget).mockReturnValueOnce(pendingDelete.promise);
    const client = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    await user.click(confirm);
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(expensesApi.deleteExpenseBudget).toHaveBeenCalledTimes(1);

    pendingDelete.resolve();
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: expensesApi.EXPENSE_BUDGETS_QUERY_KEY }),
    );
  });

  test('renders a localized delete error when deletion fails', async () => {
    vi.mocked(expensesApi.listExpenseBudgets).mockResolvedValueOnce({
      period: '2026-07',
      budgets: [BUDGETS.budgets[0]!],
    });
    vi.mocked(expensesApi.deleteExpenseBudget).mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't delete the budget. Please try again.",
    );
  });
});
