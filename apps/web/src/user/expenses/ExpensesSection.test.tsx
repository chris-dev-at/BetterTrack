import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ExpenseCategory, ExpenseTransaction } from '@bettertrack/contracts';

vi.mock('../../lib/expensesApi', () => ({
  EXPENSE_CATEGORIES_QUERY_KEY: ['expenses', 'categories'],
  EXPENSE_TRANSACTIONS_QUERY_KEY: ['expenses', 'transactions'],
  EXPENSE_RULES_QUERY_KEY: ['expenses', 'rules'],
  listExpenseCategories: vi.fn(),
  createExpenseCategory: vi.fn(),
  updateExpenseCategory: vi.fn(),
  deleteExpenseCategory: vi.fn(),
  listExpenseTransactions: vi.fn(),
  createExpenseTransaction: vi.fn(),
  updateExpenseTransaction: vi.fn(),
  recategorizeExpenseTransaction: vi.fn(),
  deleteExpenseTransaction: vi.fn(),
}));

import * as expensesApi from '../../lib/expensesApi';

import { CategoriesPage } from './CategoriesPage';
import { TransactionsPage } from './TransactionsPage';

function makeCategory(over: Partial<ExpenseCategory> = {}): ExpenseCategory {
  return {
    id: 'c1',
    name: 'Groceries',
    direction: 'expense',
    color: '#22c55e',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function makeTransaction(over: Partial<ExpenseTransaction> = {}): ExpenseTransaction {
  return {
    id: 't1',
    categoryId: 'c1',
    direction: 'expense',
    amount: 42.99,
    currency: 'EUR',
    bookedOn: '2026-07-01',
    description: 'BILLA groceries',
    source: 'manual',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function renderPage(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(expensesApi.listExpenseCategories).mockResolvedValue({ categories: [] });
  vi.mocked(expensesApi.listExpenseTransactions).mockResolvedValue({ transactions: [] });
});

describe('CategoriesPage', () => {
  test('renders seeded categories grouped by direction', async () => {
    vi.mocked(expensesApi.listExpenseCategories).mockResolvedValue({
      categories: [
        makeCategory({ id: 'c1', name: 'Groceries', direction: 'expense' }),
        makeCategory({ id: 'c2', name: 'Salary', direction: 'income', color: '#10b981' }),
      ],
    });
    renderPage(<CategoriesPage />);

    expect(await screen.findByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
    // Direction group headers (from the plural i18n keys).
    expect(screen.getByText('Expenses')).toBeInTheDocument();
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New category' })).toBeInTheDocument();
  });
});

describe('TransactionsPage', () => {
  test('shows the empty state and a New-transaction CTA', async () => {
    renderPage(<TransactionsPage />);
    expect(await screen.findByText('No transactions yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New transaction' })).toBeInTheDocument();
  });

  test('lists a transaction with its per-row recategorize control', async () => {
    vi.mocked(expensesApi.listExpenseCategories).mockResolvedValue({
      categories: [makeCategory({ id: 'c1', name: 'Groceries' })],
    });
    vi.mocked(expensesApi.listExpenseTransactions).mockResolvedValue({
      transactions: [makeTransaction({ description: 'BILLA groceries', categoryId: 'c1' })],
    });
    renderPage(<TransactionsPage />);

    expect(await screen.findByText('BILLA groceries')).toBeInTheDocument();
    // The inline recategorize select is present and reflects the current category.
    const select = screen.getByRole('combobox', { name: 'Change category' });
    expect(select).toHaveValue('c1');
  });
});
