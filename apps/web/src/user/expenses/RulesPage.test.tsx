import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ExpenseCategory, ExpenseRule } from '@bettertrack/contracts';

vi.mock('../../lib/expensesApi', () => ({
  EXPENSE_CATEGORIES_QUERY_KEY: ['expenses', 'categories'],
  EXPENSE_RULES_QUERY_KEY: ['expenses', 'rules'],
  listExpenseCategories: vi.fn(),
  listExpenseRules: vi.fn(),
  deleteExpenseRule: vi.fn(),
  createExpenseRule: vi.fn(),
  updateExpenseRule: vi.fn(),
}));

import * as expensesApi from '../../lib/expensesApi';

import { RulesPage } from './RulesPage';

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
    name: 'Transport',
    direction: 'expense',
    color: '#f59e0b',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
];

function makeRule(overrides: Partial<ExpenseRule> = {}): ExpenseRule {
  return {
    id: 'r1',
    categoryId: 'c1',
    matchType: 'contains',
    pattern: 'spotify',
    priority: 0,
    enabled: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function renderPage(node: ReactNode = <RulesPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(expensesApi.listExpenseCategories).mockResolvedValue({ categories: CATEGORIES });
  vi.mocked(expensesApi.listExpenseRules).mockResolvedValue({ rules: [] });
  vi.mocked(expensesApi.deleteExpenseRule).mockResolvedValue(undefined);
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('RulesPage', () => {
  test('keeps the loading boundary while an initial prerequisite is paused offline', () => {
    onlineManager.setOnline(false);
    renderPage();

    expect(screen.getAllByRole('status', { name: 'Loading' })).not.toHaveLength(0);
    expect(screen.queryByText('No rules yet')).not.toBeInTheDocument();
    expect(expensesApi.listExpenseCategories).not.toHaveBeenCalled();
  });

  test('keeps loading accessibly until categories resolve and never labels a pending category unknown', async () => {
    const categories = deferred<{ categories: ExpenseCategory[] }>();
    vi.mocked(expensesApi.listExpenseCategories).mockImplementation(() => categories.promise);
    vi.mocked(expensesApi.listExpenseRules).mockResolvedValue({ rules: [makeRule()] });
    renderPage();

    expect((await screen.findAllByRole('status', { name: 'Loading' })).length).toBeGreaterThan(0);
    await waitFor(() => expect(expensesApi.listExpenseRules).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Unknown category')).not.toBeInTheDocument();

    categories.resolve({ categories: CATEGORIES });
    expect(await screen.findByText('Groceries')).toBeInTheDocument();
  });

  test('shows the empty state only after both requests succeed and keeps creation disabled without categories', async () => {
    const categories = deferred<{ categories: ExpenseCategory[] }>();
    vi.mocked(expensesApi.listExpenseCategories).mockImplementation(() => categories.promise);
    renderPage();

    expect(screen.queryByText('No rules yet')).not.toBeInTheDocument();
    categories.resolve({ categories: [] });
    expect(await screen.findByText('No rules yet')).toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'New rule' });
    expect(create).toBeDisabled();
    await userEvent.click(create);
    expect(screen.queryByRole('dialog', { name: 'New rule' })).not.toBeInTheDocument();
  });

  test.each(['rules', 'categories'] as const)(
    'shows one localized error and retries a failed %s prerequisite',
    async (failedPrerequisite) => {
      if (failedPrerequisite === 'rules') {
        vi.mocked(expensesApi.listExpenseRules)
          .mockRejectedValueOnce(new Error('rules unavailable'))
          .mockResolvedValue({ rules: [makeRule()] });
      } else {
        vi.mocked(expensesApi.listExpenseRules).mockResolvedValue({ rules: [makeRule()] });
        vi.mocked(expensesApi.listExpenseCategories)
          .mockRejectedValueOnce(new Error('categories unavailable'))
          .mockResolvedValue({ categories: CATEGORIES });
      }
      const user = userEvent.setup();
      renderPage();

      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your rules.");
      await user.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByText('“spotify”')).toBeInTheDocument();
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    },
  );

  test('renders localized match, enabled state, and resolved category', async () => {
    vi.mocked(expensesApi.listExpenseRules).mockResolvedValue({
      rules: [
        makeRule({
          categoryId: 'c2',
          matchType: 'starts_with',
          pattern: 'NETFLIX',
          enabled: false,
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText('“NETFLIX”')).toBeInTheDocument();
    expect(screen.getByText('Starts with')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('Transport')).toBeInTheDocument();
  });

  test('opens edit with the selected rule', async () => {
    vi.mocked(expensesApi.listExpenseRules).mockResolvedValue({
      rules: [
        makeRule({ categoryId: 'c2', matchType: 'regex', pattern: '^NETFLIX$', enabled: false }),
      ],
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('“^NETFLIX$”');
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('dialog', { name: 'Edit rule' })).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toHaveValue('c2');
    expect(screen.getByLabelText('Match type')).toHaveValue('regex');
    expect(screen.getByLabelText('Pattern')).toHaveValue('^NETFLIX$');
    expect(screen.getByLabelText('Enabled')).not.toBeChecked();
  });

  test('supports cancelling deletion without submitting', async () => {
    vi.mocked(expensesApi.listExpenseRules).mockResolvedValue({ rules: [makeRule()] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('“spotify”');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(expensesApi.deleteExpenseRule).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  test('disables a pending delete and invalidates rules after success', async () => {
    const deletion = deferred<void>();
    vi.mocked(expensesApi.listExpenseRules).mockResolvedValue({ rules: [makeRule()] });
    vi.mocked(expensesApi.deleteExpenseRule).mockImplementation(() => deletion.promise);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('“spotify”');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    await user.click(confirm);

    expect(expensesApi.deleteExpenseRule).toHaveBeenCalledWith('r1');
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(expensesApi.deleteExpenseRule).toHaveBeenCalledTimes(1);

    deletion.resolve();
    await waitFor(() => expect(expensesApi.listExpenseRules).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  test('surfaces a localized delete error', async () => {
    vi.mocked(expensesApi.listExpenseRules).mockResolvedValue({ rules: [makeRule()] });
    vi.mocked(expensesApi.deleteExpenseRule).mockRejectedValue(new Error('delete unavailable'));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('“spotify”');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't delete the rule.");
  });
});
