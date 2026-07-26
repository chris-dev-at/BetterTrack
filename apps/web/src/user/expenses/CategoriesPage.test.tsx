import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ExpenseCategory } from '@bettertrack/contracts';

import { I18nProvider } from '../../i18n';

vi.mock('../../lib/expensesApi', () => ({
  EXPENSE_CATEGORIES_QUERY_KEY: ['expenses', 'categories'],
  createExpenseCategory: vi.fn(),
  deleteExpenseCategory: vi.fn(),
  listExpenseCategories: vi.fn(),
  updateExpenseCategory: vi.fn(),
}));

import * as expensesApi from '../../lib/expensesApi';

import { CategoriesPage } from './CategoriesPage';

const CATEGORIES: ExpenseCategory[] = [
  {
    id: 'c-expense',
    name: 'Groceries',
    direction: 'expense',
    color: '#22c55e',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
  {
    id: 'c-income',
    name: 'Salary',
    direction: 'income',
    color: '#3b82f6',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function renderPage(node: ReactNode = <CategoriesPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
  return client;
}

function categoryRow(name: string) {
  const row = screen.getByText(name).closest('li');
  if (!row) throw new Error(`Category row not found: ${name}`);
  return within(row);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(expensesApi.listExpenseCategories).mockResolvedValue({ categories: CATEGORIES });
  vi.mocked(expensesApi.deleteExpenseCategory).mockResolvedValue(undefined);
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('CategoriesPage', () => {
  test('renders an accessible loading state before the initial request starts', () => {
    onlineManager.setOnline(false);
    renderPage();

    expect(screen.getAllByRole('status', { name: 'Loading' })).toHaveLength(2);
    expect(screen.queryByText('No categories yet')).not.toBeInTheDocument();
    expect(expensesApi.listExpenseCategories).not.toHaveBeenCalled();
  });

  test('shows a retryable localized load error and clears it after a successful retry', async () => {
    vi.mocked(expensesApi.listExpenseCategories)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ categories: CATEGORIES });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your categories.");
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Groceries')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('renders a compact empty state with a create action', async () => {
    vi.mocked(expensesApi.listExpenseCategories).mockResolvedValueOnce({ categories: [] });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('No categories yet')).toBeInTheDocument();
    expect(
      screen.getByText('Create a category to organize your spending and income.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create category' }));
    expect(screen.getByRole('dialog', { name: 'New category' })).toBeInTheDocument();
  });

  test('groups categories by direction and renders their names and colors', async () => {
    renderPage();

    const groceries = await screen.findByText('Groceries');
    const salary = screen.getByText('Salary');
    expect(screen.getByRole('heading', { name: 'Expenses' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Income' })).toBeInTheDocument();
    expect(groceries.previousElementSibling).toHaveStyle({ backgroundColor: '#22c55e' });
    expect(salary.previousElementSibling).toHaveStyle({ backgroundColor: '#3b82f6' });
  });

  test('opens create and edit dialogs in the correct mode with the selected category', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New category' }));
    expect(screen.getByRole('dialog', { name: 'New category' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(categoryRow('Groceries').getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit category' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Groceries');
    expect(within(dialog).getByLabelText('Colour')).toHaveValue('#22c55e');
    expect(within(dialog).getByRole('button', { name: 'Expense' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('cancels a delete confirmation without submitting', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Groceries');
    await user.click(categoryRow('Groceries').getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(expensesApi.deleteExpenseCategory).not.toHaveBeenCalled();
    expect(categoryRow('Groceries').getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  test('prevents duplicate deletion while pending and invalidates categories after success', async () => {
    const deletion = deferred<void>();
    vi.mocked(expensesApi.deleteExpenseCategory).mockReturnValueOnce(deletion.promise);
    const client = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const user = userEvent.setup();

    await screen.findByText('Groceries');
    await user.click(categoryRow('Groceries').getByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    await user.click(confirm);

    expect(expensesApi.deleteExpenseCategory).toHaveBeenCalledWith('c-expense');
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(expensesApi.deleteExpenseCategory).toHaveBeenCalledTimes(1);

    deletion.resolve();
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: expensesApi.EXPENSE_CATEGORIES_QUERY_KEY,
      }),
    );
  });

  test('renders the localized delete error when deletion fails', async () => {
    vi.mocked(expensesApi.deleteExpenseCategory).mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Groceries');
    await user.click(categoryRow('Groceries').getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't delete the category. Please try again.",
    );
  });
});
