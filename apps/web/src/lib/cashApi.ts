import {
  cashBudgetListResponseSchema,
  cashBudgetResponseSchema,
  cashMonthlySummaryResponseSchema,
  cashMovementTagsResponseSchema,
  cashRuleApplyResponseSchema,
  cashRuleListResponseSchema,
  cashRulePreviewResponseSchema,
  cashRuleResponseSchema,
  cashTagListResponseSchema,
  cashTagResponseSchema,
  cashTrendResponseSchema,
  type CashBudgetListResponse,
  type CashBudgetResponse,
  type CashMonthlySummaryResponse,
  type CashMovementTagsResponse,
  type CashRuleApplyResponse,
  type CashRuleListResponse,
  type CashRulePreviewResponse,
  type CashRuleResponse,
  type CashTagListResponse,
  type CashTagResponse,
  type CashTrendResponse,
  type CreateCashBudgetRequest,
  type CreateCashRuleRequest,
  type CreateCashTagRequest,
  type UpdateCashBudgetRequest,
  type UpdateCashRuleRequest,
  type UpdateCashTagRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the Cash flow area (PROJECTPLAN.md §14, V5 cash fusion
 * phase 2 — `packages/contracts/src/cash.ts`). Mirrors `expensesApi.ts`'s
 * shape: every response is parsed through its contract schema. Unlike the
 * expense island it replaces, cash lives IN a portfolio — tags and rules are
 * per user (flat, reusable across portfolios), but budgets/summary/trends
 * measure one portfolio's ledger, so their query keys carry the portfolio id.
 * The tagged ledger itself is not a new endpoint: read it through
 * `getCashMovements` in `portfolioApi.ts` (`movements[].tags`), joined to
 * `listCashTags` client-side.
 */

export const CASH_TAGS_QUERY_KEY = ['cash', 'tags'] as const;
export const CASH_RULES_QUERY_KEY = ['cash', 'rules'] as const;

/** `['cash','budgets',portfolioId,month]` — `month` omitted ⇒ the current-month key. */
export function cashBudgetsQueryKey(portfolioId: string, month?: string) {
  return ['cash', 'budgets', portfolioId, month] as const;
}

/** `['cash','summary',portfolioId,month]` — `month` omitted ⇒ the current-month key. */
export function cashSummaryQueryKey(portfolioId: string, month?: string) {
  return ['cash', 'summary', portfolioId, month] as const;
}

/** `['cash','trends',portfolioId,months]`. */
export function cashTrendsQueryKey(portfolioId: string, months?: number) {
  return ['cash', 'trends', portfolioId, months] as const;
}

// ── Tags ──

/** `GET /cash/tags` — the caller's tags, system tags included. */
export async function listCashTags(signal?: AbortSignal): Promise<CashTagListResponse> {
  const data = await apiRequest<unknown>('/cash/tags', { signal });
  return cashTagListResponseSchema.parse(data);
}

export async function createCashTag(body: CreateCashTagRequest): Promise<CashTagResponse> {
  const data = await apiRequest<unknown>('/cash/tags', { method: 'POST', body });
  return cashTagResponseSchema.parse(data);
}

/** Rename / re-tint a tag — a system tag may be renamed/re-tinted but never deleted. */
export async function updateCashTag(
  tagId: string,
  body: UpdateCashTagRequest,
): Promise<CashTagResponse> {
  const data = await apiRequest<unknown>(`/cash/tags/${encodeURIComponent(tagId)}`, {
    method: 'PATCH',
    body,
  });
  return cashTagResponseSchema.parse(data);
}

/** Rejected with `CASH_TAG_SYSTEM_PROTECTED` (409) for a system tag — the UI never offers this. */
export async function deleteCashTag(tagId: string): Promise<void> {
  await apiRequest<unknown>(`/cash/tags/${encodeURIComponent(tagId)}`, { method: 'DELETE' });
}

// ── Movement tags ──

/**
 * `PUT /cash/movements/:movementId/tags` — replace one movement's tag set
 * wholesale (an empty array clears every tag). Not portfolio-scoped in the
 * URL: the server resolves the movement's owning portfolio itself.
 */
export async function setCashMovementTags(
  movementId: string,
  tagIds: string[],
): Promise<CashMovementTagsResponse> {
  const data = await apiRequest<unknown>(`/cash/movements/${encodeURIComponent(movementId)}/tags`, {
    method: 'PUT',
    body: { tagIds },
  });
  return cashMovementTagsResponseSchema.parse(data);
}

// ── Budgets ──

/** `GET /cash/budgets?portfolioId=&month=` — this portfolio's budgets with the month's progress. */
export async function listCashBudgets(
  portfolioId: string,
  month?: string,
  signal?: AbortSignal,
): Promise<CashBudgetListResponse> {
  const data = await apiRequest<unknown>('/cash/budgets', {
    query: { portfolioId, month },
    signal,
  });
  return cashBudgetListResponseSchema.parse(data);
}

export async function createCashBudget(body: CreateCashBudgetRequest): Promise<CashBudgetResponse> {
  const data = await apiRequest<unknown>('/cash/budgets', { method: 'POST', body });
  return cashBudgetResponseSchema.parse(data);
}

/** Retarget a budget's amount (portfolio/tag/period are fixed at creation). */
export async function updateCashBudget(
  budgetId: string,
  body: UpdateCashBudgetRequest,
): Promise<CashBudgetResponse> {
  const data = await apiRequest<unknown>(`/cash/budgets/${encodeURIComponent(budgetId)}`, {
    method: 'PATCH',
    body,
  });
  return cashBudgetResponseSchema.parse(data);
}

export async function deleteCashBudget(budgetId: string): Promise<void> {
  await apiRequest<unknown>(`/cash/budgets/${encodeURIComponent(budgetId)}`, { method: 'DELETE' });
}

// ── Rules ──

/** `GET /cash/rules` — by ascending priority then age (first match wins). */
export async function listCashRules(signal?: AbortSignal): Promise<CashRuleListResponse> {
  const data = await apiRequest<unknown>('/cash/rules', { signal });
  return cashRuleListResponseSchema.parse(data);
}

export async function createCashRule(body: CreateCashRuleRequest): Promise<CashRuleResponse> {
  const data = await apiRequest<unknown>('/cash/rules', { method: 'POST', body });
  return cashRuleResponseSchema.parse(data);
}

export async function updateCashRule(
  ruleId: string,
  body: UpdateCashRuleRequest,
): Promise<CashRuleResponse> {
  const data = await apiRequest<unknown>(`/cash/rules/${encodeURIComponent(ruleId)}`, {
    method: 'PATCH',
    body,
  });
  return cashRuleResponseSchema.parse(data);
}

export async function deleteCashRule(ruleId: string): Promise<void> {
  await apiRequest<unknown>(`/cash/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
}

/**
 * `POST /cash/rules/apply` — run the rules over movements that already exist.
 *
 * New rules only tag what arrives after them, and a rule is usually written
 * after the movements it describes, so this is how a back catalogue gets
 * labelled. Additive: it never removes a tag, and a second call reports 0.
 */
export async function applyCashRules(): Promise<CashRuleApplyResponse> {
  const data = await apiRequest<unknown>('/cash/rules/apply', { method: 'POST' });
  return cashRuleApplyResponseSchema.parse(data);
}

/**
 * `POST /cash/rules/preview` — what your rules WOULD tag this note as.
 *
 * Asked while the user types, so the label shows up before they commit instead
 * of surprising them afterwards. Round-trips on purpose: the matcher runs
 * through RE2 server-side, and answering it here would be a second
 * implementation free to disagree with the one that actually books.
 */
export async function previewCashRules(
  note: string,
  signal?: AbortSignal,
): Promise<CashRulePreviewResponse> {
  const data = await apiRequest<unknown>('/cash/rules/preview', {
    method: 'POST',
    body: { note },
    signal,
  });
  return cashRulePreviewResponseSchema.parse(data);
}

// ── Dashboards ──

/** `GET /cash/summary?portfolioId=&month=` — one portfolio's month, tagged breakdown included. */
export async function getCashSummary(
  portfolioId: string,
  month?: string,
  signal?: AbortSignal,
): Promise<CashMonthlySummaryResponse> {
  const data = await apiRequest<unknown>('/cash/summary', {
    query: { portfolioId, month },
    signal,
  });
  return cashMonthlySummaryResponseSchema.parse(data);
}

/** `GET /cash/trends?portfolioId=&months=` — oldest→newest, gaps as zeros. */
export async function getCashTrends(
  portfolioId: string,
  months?: number,
  signal?: AbortSignal,
): Promise<CashTrendResponse> {
  const data = await apiRequest<unknown>('/cash/trends', {
    query: { portfolioId, months },
    signal,
  });
  return cashTrendResponseSchema.parse(data);
}
