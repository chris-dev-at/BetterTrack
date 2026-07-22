import {
  expenseBankListResponseSchema,
  expenseBudgetListResponseSchema,
  expenseBudgetResponseSchema,
  expenseCategoryListResponseSchema,
  expenseCategoryResponseSchema,
  expenseImportApplyResponseSchema,
  expenseImportPreviewResponseSchema,
  expenseMonthlySummaryResponseSchema,
  expenseRuleListResponseSchema,
  expenseRuleResponseSchema,
  expenseTransactionListResponseSchema,
  expenseTransactionResponseSchema,
  expenseTrendResponseSchema,
  type CreateExpenseBudgetRequest,
  type CreateExpenseCategoryRequest,
  type CreateExpenseRuleRequest,
  type CreateExpenseTransactionRequest,
  type ExpenseBankListResponse,
  type ExpenseBudgetListResponse,
  type ExpenseBudgetResponse,
  type ExpenseCategoryListResponse,
  type ExpenseCategoryResponse,
  type ExpenseImportApplyResponse,
  type ExpenseImportOverride,
  type ExpenseImportPreviewResponse,
  type ExpenseMonthlySummaryResponse,
  type ExpenseRuleListResponse,
  type ExpenseRuleResponse,
  type ExpenseTransactionListQuery,
  type ExpenseTransactionListResponse,
  type ExpenseTransactionResponse,
  type ExpenseTrendResponse,
  type UpdateExpenseBudgetRequest,
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
export const EXPENSE_SUMMARY_QUERY_KEY = ['expenses', 'summary'] as const;
export const EXPENSE_TRENDS_QUERY_KEY = ['expenses', 'trends'] as const;
export const EXPENSE_BUDGETS_QUERY_KEY = ['expenses', 'budgets'] as const;

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

// ── Bank-statement CSV import (issue 2/3) ──

/** Query key for the supported-banks list (static per deployment). */
export const EXPENSE_IMPORT_BANKS_QUERY_KEY = ['expenses', 'import', 'banks'] as const;

/** `GET /expenses/import/banks` — the supported bank mappers, for the picker. */
export async function listExpenseImportBanks(
  signal?: AbortSignal,
): Promise<ExpenseBankListResponse> {
  const data = await apiRequest<unknown>('/expenses/import/banks', { signal });
  return expenseBankListResponseSchema.parse(data);
}

/** `POST /expenses/import/preview` — upload a bank CSV; get the staged preview back (persists nothing). */
export async function previewExpenseImport(input: {
  file: File;
  bankId?: string;
}): Promise<ExpenseImportPreviewResponse> {
  const form = new FormData();
  if (input.bankId) form.append('bankId', input.bankId);
  form.append('file', input.file);
  const data = await apiRequest<unknown>('/expenses/import/preview', {
    method: 'POST',
    body: form,
  });
  return expenseImportPreviewResponseSchema.parse(data);
}

/** `POST /expenses/import/apply` — re-upload the same CSV (+ category overrides) and book the rows. */
export async function applyExpenseImport(input: {
  file: File;
  bankId?: string;
  overrides?: ExpenseImportOverride[];
}): Promise<ExpenseImportApplyResponse> {
  const form = new FormData();
  if (input.bankId) form.append('bankId', input.bankId);
  if (input.overrides && input.overrides.length > 0) {
    form.append('overrides', JSON.stringify(input.overrides));
  }
  form.append('file', input.file);
  const data = await apiRequest<unknown>('/expenses/import/apply', { method: 'POST', body: form });
  return expenseImportApplyResponseSchema.parse(data);
}

// ── Dashboards + budgets (issue 3/3) ──

/** `GET /expenses/summary?month=` — spend by category + income-vs-spend for a month. */
export async function getExpenseSummary(
  month?: string,
  signal?: AbortSignal,
): Promise<ExpenseMonthlySummaryResponse> {
  const data = await apiRequest<unknown>('/expenses/summary', {
    query: month ? { month } : undefined,
    signal,
  });
  return expenseMonthlySummaryResponseSchema.parse(data);
}

/** `GET /expenses/trends?months=` — income-vs-spend over the trailing months. */
export async function getExpenseTrends(
  months?: number,
  signal?: AbortSignal,
): Promise<ExpenseTrendResponse> {
  const data = await apiRequest<unknown>('/expenses/trends', {
    query: months ? { months } : undefined,
    signal,
  });
  return expenseTrendResponseSchema.parse(data);
}

/** `GET /expenses/budgets?month=` — the caller's budgets with this period's progress. */
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

export async function createExpenseBudget(
  body: CreateExpenseBudgetRequest,
): Promise<ExpenseBudgetResponse> {
  const data = await apiRequest<unknown>('/expenses/budgets', { method: 'POST', body });
  return expenseBudgetResponseSchema.parse(data);
}

export async function updateExpenseBudget(
  budgetId: string,
  body: UpdateExpenseBudgetRequest,
): Promise<ExpenseBudgetResponse> {
  const data = await apiRequest<unknown>(`/expenses/budgets/${encodeURIComponent(budgetId)}`, {
    method: 'PATCH',
    body,
  });
  return expenseBudgetResponseSchema.parse(data);
}

export async function deleteExpenseBudget(budgetId: string): Promise<void> {
  await apiRequest<unknown>(`/expenses/budgets/${encodeURIComponent(budgetId)}`, {
    method: 'DELETE',
  });
}
