import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  ExpenseImportApplyResponse,
  ExpenseImportPreviewResponse,
  ExpenseRule,
} from '@bettertrack/contracts';

vi.mock('../../lib/expensesApi', () => ({
  EXPENSE_CATEGORIES_QUERY_KEY: ['expenses', 'categories'],
  EXPENSE_TRANSACTIONS_QUERY_KEY: ['expenses', 'transactions'],
  EXPENSE_RULES_QUERY_KEY: ['expenses', 'rules'],
  EXPENSE_IMPORT_BANKS_QUERY_KEY: ['expenses', 'import', 'banks'],
  listExpenseCategories: vi.fn(),
  listExpenseImportBanks: vi.fn(),
  previewExpenseImport: vi.fn(),
  applyExpenseImport: vi.fn(),
  listExpenseRules: vi.fn(),
  deleteExpenseRule: vi.fn(),
  createExpenseRule: vi.fn(),
  updateExpenseRule: vi.fn(),
}));

import * as expensesApi from '../../lib/expensesApi';

import { ImportPage } from './ImportPage';
import { RulesPage } from './RulesPage';

const CATEGORIES = [
  {
    id: 'c1',
    name: 'Groceries',
    direction: 'expense' as const,
    color: '#22c55e',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
  {
    id: 'c2',
    name: 'Transport',
    direction: 'expense' as const,
    color: '#f59e0b',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
];

function makeRule(over: Partial<ExpenseRule> = {}): ExpenseRule {
  return {
    id: 'r1',
    categoryId: 'c1',
    matchType: 'contains',
    pattern: 'spotify',
    priority: 0,
    enabled: true,
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
  vi.mocked(expensesApi.listExpenseCategories).mockResolvedValue({ categories: CATEGORIES });
  vi.mocked(expensesApi.listExpenseImportBanks).mockResolvedValue({
    banks: [
      { id: 'erste_george', label: 'Erste / George' },
      { id: 'n26', label: 'N26' },
    ],
  });
  vi.mocked(expensesApi.listExpenseRules).mockResolvedValue({ rules: [] });
});

describe('ImportPage', () => {
  const PREVIEW: ExpenseImportPreviewResponse = {
    bankId: 'n26',
    bankLabel: 'N26',
    filename: 'statement.csv',
    counts: { total: 2, new: 1, duplicate: 1, error: 0 },
    rows: [
      {
        rowIndex: 2,
        raw: '2024-01-05,REWE,...',
        flag: 'new',
        message: null,
        bookedOn: '2024-01-05',
        direction: 'expense',
        amount: 42.5,
        currency: 'EUR',
        description: 'REWE',
        categoryId: 'c1',
        categoryName: 'Groceries',
      },
      {
        rowIndex: 3,
        raw: '2024-01-10,Netflix,...',
        flag: 'duplicate',
        message: null,
        bookedOn: '2024-01-10',
        direction: 'expense',
        amount: 12.99,
        currency: 'EUR',
        description: 'Netflix',
        categoryId: null,
        categoryName: null,
      },
    ],
  };
  const RESULT: ExpenseImportApplyResponse = {
    bankId: 'n26',
    bankLabel: 'N26',
    applied: 1,
    duplicate: 1,
    error: 0,
    rows: [
      { rowIndex: 2, result: 'applied', message: null },
      { rowIndex: 3, result: 'skipped_duplicate', message: 'An identical row already exists.' },
    ],
  };

  test('uploads → previews with per-row flags + category select → applies with overrides', async () => {
    vi.mocked(expensesApi.previewExpenseImport).mockResolvedValue(PREVIEW);
    vi.mocked(expensesApi.applyExpenseImport).mockResolvedValue(RESULT);
    renderPage(<ImportPage />);

    // Preview is disabled until a file is chosen.
    const previewBtn = await screen.findByRole('button', { name: 'Preview' });
    expect(previewBtn).toBeDisabled();

    const file = new File(['Date,Payee\n2024-01-05,REWE'], 'statement.csv', { type: 'text/csv' });
    const input = screen.getByLabelText('Choose a CSV file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    expect(previewBtn).toBeEnabled();

    fireEvent.click(previewBtn);
    expect(await screen.findByText('Detected N26')).toBeInTheDocument();
    expect(screen.getByText('REWE')).toBeInTheDocument();
    expect(screen.getByText('Netflix')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('Dup')).toBeInTheDocument();

    // The importable row exposes a category select defaulted to the rule suggestion.
    const select = screen.getByRole('combobox', { name: 'Category' });
    expect(select).toHaveValue('c1');
    fireEvent.change(select, { target: { value: 'c2' } });

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 transactions' }));
    await waitFor(() => expect(expensesApi.applyExpenseImport).toHaveBeenCalled());
    expect(vi.mocked(expensesApi.applyExpenseImport).mock.calls[0]?.[0]).toMatchObject({
      bankId: 'n26',
      overrides: [{ rowIndex: 2, categoryId: 'c2' }],
    });
    expect(await screen.findByText(/Imported 1/)).toBeInTheDocument();
  });

  test('surfaces an unrecognized-file error from preview', async () => {
    const { ApiError } = await import('../../lib/apiClient');
    vi.mocked(expensesApi.previewExpenseImport).mockRejectedValue(
      new ApiError(
        400,
        'EXPENSE_IMPORT_BANK_UNRECOGNIZED',
        'This file does not match any supported bank export — pick the bank manually.',
      ),
    );
    renderPage(<ImportPage />);

    const file = new File(['junk'], 'x.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Choose a CSV file'), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/does not match any supported bank export/)).toBeInTheDocument();
  });
});

describe('RulesPage', () => {
  test('shows the empty state', async () => {
    renderPage(<RulesPage />);
    expect(await screen.findByText('No rules yet')).toBeInTheDocument();
  });

  test('lists a rule with its match type, pattern and target category', async () => {
    vi.mocked(expensesApi.listExpenseRules).mockResolvedValue({
      rules: [makeRule({ matchType: 'contains', pattern: 'spotify', categoryId: 'c1' })],
    });
    renderPage(<RulesPage />);

    expect(await screen.findByText('“spotify”')).toBeInTheDocument();
    expect(screen.getByText('Contains')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });
});
