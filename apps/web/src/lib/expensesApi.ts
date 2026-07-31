import {
  expenseBudgetListResponseSchema,
  expenseCategoryListResponseSchema,
  expenseRuleListResponseSchema,
  expenseTransactionListResponseSchema,
  type ExpenseBudgetListResponse,
  type ExpenseCategoryListResponse,
  type ExpenseRuleListResponse,
  type ExpenseTransactionListQuery,
  type ExpenseTransactionListResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * READ-ONLY client for the legacy Expense island (`/api/v1/expenses`).
 *
 * V5 cash fusion retired the expenses UI — classification now lives on the
 * portfolio cash ledger (tags/rules/budgets, `cashApi.ts`) — and the full
 * read/write client went with it. What SURVIVES here is exactly the read
 * surface the paranoid-enable migration (PD8a, `vault/ui/migration.ts`) needs
 * to carry a user's historical expense data into the vault document before the
 * server-side purge: the server still serves the island's data, the fused UI
 * just no longer drives it. Do not grow this module back into a UI client.
 */

export async function listExpenseCategories(
  signal?: AbortSignal,
): Promise<ExpenseCategoryListResponse> {
  const data = await apiRequest<unknown>('/expenses/categories', { signal });
  return expenseCategoryListResponseSchema.parse(data);
}

export async function listExpenseTransactions(
  query?: ExpenseTransactionListQuery,
  signal?: AbortSignal,
): Promise<ExpenseTransactionListResponse> {
  const data = await apiRequest<unknown>('/expenses/transactions', {
    query: query
      ? {
          categoryId: query.categoryId,
          direction: query.direction,
          from: query.from,
          to: query.to,
          limit: query.limit,
        }
      : undefined,
    signal,
  });
  return expenseTransactionListResponseSchema.parse(data);
}

export async function listExpenseRules(signal?: AbortSignal): Promise<ExpenseRuleListResponse> {
  const data = await apiRequest<unknown>('/expenses/rules', { signal });
  return expenseRuleListResponseSchema.parse(data);
}

export async function listExpenseBudgets(
  month?: string,
  signal?: AbortSignal,
): Promise<ExpenseBudgetListResponse> {
  const data = await apiRequest<unknown>('/expenses/budgets', {
    query: month ? { month } : undefined,
    signal,
  });
  return expenseBudgetListResponseSchema.parse(data);
}
