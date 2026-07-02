import {
  createCustomAssetResponseSchema,
  customAssetSchema,
  portfolioHistoryResponseSchema,
  portfolioListResponseSchema,
  portfolioResponseSchema,
  transactionListResponseSchema,
  transactionSchema,
  valuePointsResponseSchema,
  type CreateCustomAssetRequest,
  type CreateCustomAssetResponse,
  type CustomAsset,
  type PortfolioHistoryRange,
  type PortfolioHistoryResponse,
  type PortfolioListResponse,
  type PortfolioResponse,
  type Transaction,
  type TransactionInput,
  type TransactionListResponse,
  type UpdateCustomAssetRequest,
  type UpdateTransactionRequest,
  type ValuePoint,
  type ValuePointsResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the portfolio + custom-asset surface (PROJECTPLAN.md §6.8, §8).
 * Every response is parsed through its contract schema so the page works against
 * validated shapes, never raw JSON. Money values arrive at full precision and are
 * rounded only at display time (§5.4).
 *
 * Every portfolio read/write is `portfolio_id`-scoped (§6.8): callers resolve the
 * default id via {@link listPortfolios} and thread it through the scoped paths.
 */

// --- Portfolios (the list) -------------------------------------------------

/** `GET /portfolios` — the user's portfolios (V1: the single auto-created default). */
export async function listPortfolios(signal?: AbortSignal): Promise<PortfolioListResponse> {
  const data = await apiRequest<unknown>('/portfolios', { signal });
  return portfolioListResponseSchema.parse(data);
}

// --- Holdings + totals -----------------------------------------------------

/** `GET /portfolios/:id` — holdings + totals header. */
export async function getPortfolio(
  portfolioId: string,
  signal?: AbortSignal,
): Promise<PortfolioResponse> {
  const data = await apiRequest<unknown>(`/portfolios/${encodeURIComponent(portfolioId)}`, {
    signal,
  });
  return portfolioResponseSchema.parse(data);
}

/** `GET /portfolios/:id/history?range=` — EUR value-over-time series. */
export async function getPortfolioHistory(
  portfolioId: string,
  range: PortfolioHistoryRange,
  signal?: AbortSignal,
): Promise<PortfolioHistoryResponse> {
  const data = await apiRequest<unknown>(`/portfolios/${encodeURIComponent(portfolioId)}/history`, {
    query: { range },
    signal,
  });
  return portfolioHistoryResponseSchema.parse(data);
}

// --- Transactions ----------------------------------------------------------

/** `GET /portfolios/:id/transactions?cursor=` — newest-first ledger, keyset paginated. */
export async function listTransactions(
  portfolioId: string,
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<TransactionListResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/transactions`,
    {
      query: { cursor: params.cursor, limit: params.limit },
      signal,
    },
  );
  return transactionListResponseSchema.parse(data);
}

/**
 * `POST /portfolios/:id/transactions` — single or bulk (the buy flow, §6.8).
 * Always sent in the `{ transactions: [...] }` bulk form; a one-element batch is
 * the single-add case. Each returned row is validated through `transactionSchema`.
 */
export async function createTransactions(
  portfolioId: string,
  inputs: TransactionInput[],
): Promise<Transaction[]> {
  const data = await apiRequest<{ transactions: unknown[] }>(
    `/portfolios/${encodeURIComponent(portfolioId)}/transactions`,
    {
      method: 'POST',
      body: { transactions: inputs },
    },
  );
  return data.transactions.map((t) => transactionSchema.parse(t));
}

/** `PATCH /portfolios/:id/transactions/:txId` — edit a transaction; re-validates oversell. */
export async function updateTransaction(
  portfolioId: string,
  id: string,
  patch: UpdateTransactionRequest,
): Promise<Transaction> {
  const data = await apiRequest<{ transaction: unknown }>(
    `/portfolios/${encodeURIComponent(portfolioId)}/transactions/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: patch },
  );
  return transactionSchema.parse(data.transaction);
}

/** `DELETE /portfolios/:id/transactions/:txId` — remove a transaction; re-validates oversell. */
export async function deleteTransaction(portfolioId: string, id: string): Promise<void> {
  await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/transactions/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    },
  );
}

// --- Custom assets ---------------------------------------------------------

/** `POST /custom-assets` — create a custom investment, optional initial BUY (§6.9). */
export async function createCustomAsset(
  body: CreateCustomAssetRequest,
): Promise<CreateCustomAssetResponse> {
  const data = await apiRequest<unknown>('/custom-assets', { method: 'POST', body });
  return createCustomAssetResponseSchema.parse(data);
}

/** `PATCH /custom-assets/:id` — edit name/category (currency is immutable). */
export async function updateCustomAsset(
  id: string,
  patch: UpdateCustomAssetRequest,
): Promise<CustomAsset> {
  const data = await apiRequest<{ asset: unknown }>(`/custom-assets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
  return customAssetSchema.parse(data.asset);
}

/** `DELETE /custom-assets/:id` — remove a custom asset (cascades txns + value points). */
export async function deleteCustomAsset(id: string): Promise<void> {
  await apiRequest<unknown>(`/custom-assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --- Value points ----------------------------------------------------------

/** `GET /custom-assets/:id/value-points` — list, ascending by date (§6.9). */
export async function getValuePoints(
  id: string,
  signal?: AbortSignal,
): Promise<ValuePointsResponse> {
  const data = await apiRequest<unknown>(`/custom-assets/${encodeURIComponent(id)}/value-points`, {
    signal,
  });
  return valuePointsResponseSchema.parse(data);
}

/** `PUT /custom-assets/:id/value-points` — full replace (add/edit/delete at once). */
export async function putValuePoints(id: string, points: ValuePoint[]): Promise<ValuePoint[]> {
  const data = await apiRequest<unknown>(`/custom-assets/${encodeURIComponent(id)}/value-points`, {
    method: 'PUT',
    body: { points },
  });
  return valuePointsResponseSchema.parse(data).points;
}
