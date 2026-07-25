import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ExpenseCategory } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';

vi.mock('../../lib/expensesApi', () => ({
  EXPENSE_RULES_QUERY_KEY: ['expenses', 'rules'],
  createExpenseRule: vi.fn(),
  updateExpenseRule: vi.fn(),
}));

import * as expensesApi from '../../lib/expensesApi';

import { RuleDialog } from './RuleDialog';

const CATEGORIES: ExpenseCategory[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Subscriptions',
    direction: 'expense',
    color: '#8b5cf6',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RuleDialog categories={CATEGORIES} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RuleDialog', () => {
  test('shows a localized error when the regex engine rejects unsupported syntax', async () => {
    vi.mocked(expensesApi.createExpenseRule).mockRejectedValueOnce(
      new ApiError(
        400,
        'EXPENSE_RULE_REGEX_UNSUPPORTED',
        'This regex pattern uses unsupported syntax.',
      ),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(screen.getByLabelText('Match type'), 'regex');
    await user.type(screen.getByLabelText('Pattern'), '(?=netflix)');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This regex uses unsupported syntax. Try a simpler pattern without lookarounds or backreferences.',
    );
  });
});
