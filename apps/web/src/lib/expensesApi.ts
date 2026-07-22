import {
  expenseCategoryListResponseSchema,
  expenseCategoryResponseSchema,
  expenseRuleListResponseSchema,
  expenseRuleResponseSchema,
  expenseTransactionListResponseSchema,
  expenseTransactionResponseSchema,
  type CreateExpenseCategoryRequest,
  type CreateExpenseRuleRequest,
  type CreateExpenseTransactionRequest,
  type ExpenseCategoryListResponse,
  type ExpenseCategoryResponse,
  type ExpenseRuleListResponse,
  type ExpenseRuleResponse,
  type ExpenseTransactionListQuery,
  type ExpenseTransactionListResponse,
  type ExpenseTransactionResponse,
  type UpdateExpenseCategoryRequest,
  type UpdateExpenseRuleRequest,
  type UpdateExpenseTransactionRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the Expense-tracking area (PROJECTPLAN.md §13.5 V5-P9,
 * foundation 1/3). A NEW top-level area, strictly separate from portfolio money.
 * Every response is parsed through its contract schema, mirroring `ideasApi.ts`.
 */

export const EXPENSE_CATEGORIES_QUERY_KEY = ['expenses', 'categories'] as const;
export const EXPENSE_TRANSACTIONS_QUERY_KEY = ['expenses', 'transactions'] as const;
export const EXPENSE_RULES_QUERY_KEY = ['expenses', 'rules'] as const;

// ── Categories ──

export async function listExpenseCategories(
  signal?: AbortSignal,
): Promise<ExpenseCategoryListResponse> {
  const data = await apiRequest<unknown>('/expenses/categories', { signal });
  return expenseCategoryListResponseSchema.parse(data);
}

export async function createExpenseCategory(
  body: CreateExpenseCategoryRequest,
): Promise<ExpenseCategoryResponse> {
  const data = await apiRequest<unknown>('/expenses/categories', { method: 'POST', body });
  return expenseCategoryResponseSchema.parse(data);
}

export async function updateExpenseCategory(
  categoryId: string,
  body: UpdateExpenseCategoryRequest,
): Promise<ExpenseCategoryResponse> {
  const data = await apiRequest<unknown>(`/expenses/categories/${encodeURIComponent(categoryId)}`, {
    method: 'PATCH',
    body,
  });
  return expenseCategoryResponseSchema.parse(data);
}

export async function deleteExpenseCategory(categoryId: string): Promise<void> {
  await apiRequest<unknown>(`/expenses/categories/${encodeURIComponent(categoryId)}`, {
    method: 'DELETE',
  });
}

// ── Transactions ──

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

export async function createExpenseTransaction(
  body: CreateExpenseTransactionRequest,
): Promise<ExpenseTransactionResponse> {
  const data = await apiRequest<unknown>('/expenses/transactions', { method: 'POST', body });
  return expenseTransactionResponseSchema.parse(data);
}

export async function updateExpenseTransaction(
  transactionId: string,
  body: UpdateExpenseTransactionRequest,
): Promise<ExpenseTransactionResponse> {
  const data = await apiRequest<unknown>(
    `/expenses/transactions/${encodeURIComponent(transactionId)}`,
    { method: 'PATCH', body },
  );
  return expenseTransactionResponseSchema.parse(data);
}

/** Dedicated per-transaction recategorize; `categoryId: null` clears it. */
export async function recategorizeExpenseTransaction(
  transactionId: string,
  categoryId: string | null,
): Promise<ExpenseTransactionResponse> {
  const data = await apiRequest<unknown>(
    `/expenses/transactions/${encodeURIComponent(transactionId)}/category`,
    { method: 'PUT', body: { categoryId } },
  );
  return expenseTransactionResponseSchema.parse(data);
}

export async function deleteExpenseTransaction(transactionId: string): Promise<void> {
  await apiRequest<unknown>(`/expenses/transactions/${encodeURIComponent(transactionId)}`, {
    method: 'DELETE',
  });
}

// ── Rules (shapes only; evaluation is issue 2/3) ──

export async function listExpenseRules(signal?: AbortSignal): Promise<ExpenseRuleListResponse> {
  const data = await apiRequest<unknown>('/expenses/rules', { signal });
  return expenseRuleListResponseSchema.parse(data);
}

export async function createExpenseRule(
  body: CreateExpenseRuleRequest,
): Promise<ExpenseRuleResponse> {
  const data = await apiRequest<unknown>('/expenses/rules', { method: 'POST', body });
  return expenseRuleResponseSchema.parse(data);
}

export async function updateExpenseRule(
  ruleId: string,
  body: UpdateExpenseRuleRequest,
): Promise<ExpenseRuleResponse> {
  const data = await apiRequest<unknown>(`/expenses/rules/${encodeURIComponent(ruleId)}`, {
    method: 'PATCH',
    body,
  });
  return expenseRuleResponseSchema.parse(data);
}

export async function deleteExpenseRule(ruleId: string): Promise<void> {
  await apiRequest<unknown>(`/expenses/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
}
