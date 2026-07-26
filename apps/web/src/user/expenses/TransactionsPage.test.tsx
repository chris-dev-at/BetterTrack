import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  ExpenseCategory,
  ExpenseTransaction,
  ExpenseTransactionResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/expensesApi', () => ({
  EXPENSE_CATEGORIES_QUERY_KEY: ['expenses', 'categories'],
  EXPENSE_TRANSACTIONS_QUERY_KEY: ['expenses', 'transactions'],
  listExpenseCategories: vi.fn(),
  listExpenseTransactions: vi.fn(),
  createExpenseTransaction: vi.fn(),
  updateExpenseTransaction: vi.fn(),
  recategorizeExpenseTransaction: vi.fn(),
  deleteExpenseTransaction: vi.fn(),
}));

import { I18nProvider } from '../../i18n';
import { formatDate, formatMoney } from '../../lib/format';
import * as expensesApi from '../../lib/expensesApi';

import { TransactionsPage } from './TransactionsPage';

const CATEGORIES: ExpenseCategory[] = [
  {
    id: 'c1',
    name: 'Groceries',
    direction: 'expense',
    color: '#22c55e',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
  {
    id: 'c2',
    name: 'Salary',
    direction: 'income',
    color: '#14b8a6',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
];

function makeTransaction(overrides: Partial<ExpenseTransaction> = {}): ExpenseTransaction {
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
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderPage(node: ReactNode = <TransactionsPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateQueries = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
  return { client, invalidateQueries };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(expensesApi.listExpenseCategories).mockResolvedValue({ categories: CATEGORIES });
  vi.mocked(expensesApi.listExpenseTransactions).mockResolvedValue({ transactions: [] });
  vi.mocked(expensesApi.recategorizeExpenseTransaction).mockResolvedValue({
    transaction: makeTransaction(),
  });
  vi.mocked(expensesApi.deleteExpenseTransaction).mockResolvedValue(undefined);
});

describe('TransactionsPage', () => {
  test('keeps initial transaction loading distinct from the empty state', async () => {
    const loading = deferred<{ transactions: ExpenseTransaction[] }>();
    vi.mocked(expensesApi.listExpenseTransactions).mockImplementationOnce(() => loading.promise);
    renderPage();

    expect(screen.getAllByRole('status', { name: 'Loading' })).toHaveLength(3);
    expect(screen.queryByText('No transactions yet')).not.toBeInTheDocument();

    loading.resolve({ transactions: [] });
    expect(await screen.findByText('No transactions yet')).toBeInTheDocument();
  });

  test('shows a transaction-load failure with retry', async () => {
    vi.mocked(expensesApi.listExpenseTransactions)
      .mockRejectedValueOnce(new Error('transactions unavailable'))
      .mockResolvedValue({ transactions: [] });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your transactions.");
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No transactions yet')).toBeInTheDocument();
  });

  test('keeps empty-state create controls unavailable while categories load', async () => {
    const categories = deferred<{ categories: ExpenseCategory[] }>();
    vi.mocked(expensesApi.listExpenseCategories).mockImplementation(() => categories.promise);
    renderPage();

    expect(await screen.findByText('No transactions yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New transaction' })).toBeDisabled();
    const emptyCreate = screen.getByRole('button', { name: 'Add a transaction' });
    expect(emptyCreate).toBeDisabled();
    await userEvent.click(emptyCreate);
    expect(screen.queryByRole('dialog', { name: 'New transaction' })).not.toBeInTheDocument();
  });

  test('keeps empty-state create controls unavailable after a category failure', async () => {
    vi.mocked(expensesApi.listExpenseCategories).mockRejectedValue(
      new Error('categories unavailable'),
    );
    renderPage();

    expect(await screen.findByText('No transactions yet')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your categories.");
    expect(screen.getByRole('button', { name: 'New transaction' })).toBeDisabled();
    const emptyCreate = screen.getByRole('button', { name: 'Add a transaction' });
    expect(emptyCreate).toBeDisabled();
    await userEvent.click(emptyCreate);
    expect(screen.queryByRole('dialog', { name: 'New transaction' })).not.toBeInTheDocument();
  });

  test('keeps transaction rows visible and category controls unavailable while categories load', async () => {
    const categories = deferred<{ categories: ExpenseCategory[] }>();
    vi.mocked(expensesApi.listExpenseCategories).mockImplementation(() => categories.promise);
    vi.mocked(expensesApi.listExpenseTransactions).mockResolvedValue({
      transactions: [makeTransaction()],
    });
    renderPage();

    expect(await screen.findByText('BILLA groceries')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New transaction' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    const select = screen.getByRole('combobox', { name: 'Change category' });
    expect(select).toBeDisabled();
    expect(select).toHaveTextContent('Loading…');
    expect(screen.queryByRole('option', { name: 'Groceries' })).not.toBeInTheDocument();

    categories.resolve({ categories: CATEGORIES });
    expect(await screen.findByRole('option', { name: 'Groceries' })).toBeInTheDocument();
    expect(select).toBeEnabled();
  });

  test('shows a recoverable category failure without hiding loaded transactions', async () => {
    vi.mocked(expensesApi.listExpenseCategories)
      .mockRejectedValueOnce(new Error('categories unavailable'))
      .mockResolvedValue({ categories: CATEGORIES });
    vi.mocked(expensesApi.listExpenseTransactions).mockResolvedValue({
      transactions: [makeTransaction()],
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('BILLA groceries')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load your categories.");
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Change category' })).toBeDisabled();
    expect(screen.queryByRole('option', { name: 'Groceries' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('option', { name: 'Groceries' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Change category' })).toHaveValue('c1');
  });

  test('renders localized transaction details and passes resolved categories to create and edit', async () => {
    const transaction = makeTransaction({ direction: 'income', amount: 1_234.5, categoryId: 'c2' });
    vi.mocked(expensesApi.listExpenseTransactions).mockResolvedValue({
      transactions: [transaction],
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText(transaction.description)).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent === `${formatDate(transaction.bookedOn)} · Income`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'SPAN' &&
          element.textContent === `+${formatMoney(transaction.amount, transaction.currency)}`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Change category' })).toHaveValue('c2');

    await user.click(screen.getByRole('button', { name: 'New transaction' }));
    const createDialog = screen.getByRole('dialog', { name: 'New transaction' });
    expect(within(createDialog).getByRole('combobox', { name: 'Category' })).toHaveTextContent(
      'Groceries',
    );
    await user.click(within(createDialog).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editDialog = screen.getByRole('dialog', { name: 'Edit transaction' });
    expect(within(editDialog).getByRole('combobox', { name: 'Category' })).toHaveValue('c2');
    expect(within(editDialog).getByRole('combobox', { name: 'Category' })).toHaveTextContent(
      'Salary',
    );
  });

  test('prevents duplicate recategorization and invalidates transactions after success', async () => {
    const recategorization = deferred<ExpenseTransactionResponse>();
    const transaction = makeTransaction();
    vi.mocked(expensesApi.listExpenseTransactions).mockResolvedValue({
      transactions: [transaction],
    });
    vi.mocked(expensesApi.recategorizeExpenseTransaction).mockImplementation(
      () => recategorization.promise,
    );
    const { invalidateQueries } = renderPage();
    const user = userEvent.setup();

    const select = await screen.findByRole('combobox', { name: 'Change category' });
    await user.selectOptions(select, 'c2');
    expect(expensesApi.recategorizeExpenseTransaction).toHaveBeenCalledWith('t1', 'c2');
    expect(select).toBeDisabled();
    await user.selectOptions(select, 'c1');
    expect(expensesApi.recategorizeExpenseTransaction).toHaveBeenCalledTimes(1);

    recategorization.resolve({ transaction: { ...transaction, categoryId: 'c2' } });
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: expensesApi.EXPENSE_TRANSACTIONS_QUERY_KEY,
      }),
    );
  });

  test('surfaces a recategorization failure', async () => {
    vi.mocked(expensesApi.listExpenseTransactions).mockResolvedValue({
      transactions: [makeTransaction()],
    });
    vi.mocked(expensesApi.recategorizeExpenseTransaction).mockRejectedValue(
      new Error('recategorize unavailable'),
    );
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Change category' }),
      'c2',
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't change the transaction category.",
    );
  });

  test('supports cancelling deletion, prevents duplicate submission, and invalidates after success', async () => {
    const deletion = deferred<void>();
    vi.mocked(expensesApi.listExpenseTransactions).mockResolvedValue({
      transactions: [makeTransaction()],
    });
    vi.mocked(expensesApi.deleteExpenseTransaction).mockImplementation(() => deletion.promise);
    const { invalidateQueries } = renderPage();
    const user = userEvent.setup();

    await screen.findByText('BILLA groceries');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(expensesApi.deleteExpenseTransaction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    await user.click(confirm);
    expect(expensesApi.deleteExpenseTransaction).toHaveBeenCalledWith('t1');
    expect(confirm).toBeDisabled();
    expect(screen.getByText('BILLA groceries')).toBeInTheDocument();
    await user.click(confirm);
    expect(expensesApi.deleteExpenseTransaction).toHaveBeenCalledTimes(1);

    deletion.resolve();
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: expensesApi.EXPENSE_TRANSACTIONS_QUERY_KEY,
      }),
    );
  });

  test('shows a delete failure without removing the row', async () => {
    vi.mocked(expensesApi.listExpenseTransactions).mockResolvedValue({
      transactions: [makeTransaction()],
    });
    vi.mocked(expensesApi.deleteExpenseTransaction).mockRejectedValue(
      new Error('delete unavailable'),
    );
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('BILLA groceries');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't delete the transaction.");
    expect(screen.getByText('BILLA groceries')).toBeInTheDocument();
  });
});
