import {
  cashMovementResponseSchema,
  cashMovementsResponseSchema,
  cashPreviewResponseSchema,
  cashSourceListResponseSchema,
  cashSourceResponseSchema,
  cashTransferResponseSchema,
  createCustomAssetResponseSchema,
  customAssetSchema,
  portfolioHistoryResponseSchema,
  portfolioListResponseSchema,
  portfolioMutationResponseSchema,
  portfolioResponseSchema,
  portfolioTaxSettingsResponseSchema,
  recategorizationStatusResponseSchema,
  setCashBalanceResponseSchema,
  taxYearListResponseSchema,
  taxYearReportResponseSchema,
  transactionListResponseSchema,
  transactionSchema,
  updatePortfolioResponseSchema,
  valuePointsResponseSchema,
  type CashEntryRequest,
  type CashMovementResponse,
  type CashMovementsResponse,
  type CashPreviewRequest,
  type CashPreviewResponse,
  type CashSource,
  type CashSourceListResponse,
  type CashTransferRequest,
  type CashTransferResponse,
  type CreateCashSourceRequest,
  type CreateCustomAssetRequest,
  type CreateCustomAssetResponse,
  type CustomAsset,
  type PortfolioHistoryRange,
  type PortfolioHistoryResponse,
  type PortfolioListResponse,
  type PortfolioResponse,
  type PortfolioSummary,
  type PortfolioTaxSettingsResponse,
  type RecategorizationStatusResponse,
  type SetCashBalanceRequest,
  type SetCashBalanceResponse,
  type TaxExportLocale,
  type TaxYearListResponse,
  type TaxYearReportResponse,
  type Transaction,
  type TransactionInput,
  type TransactionListResponse,
  type UpdateCashSourceRequest,
  type UpdateCustomAssetRequest,
  type UpdatePortfolioRequest,
  type UpdateTaxSettingsRequest,
  type UpdateTransactionRequest,
  type ValuePoint,
  type ValuePointsResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';
import { apiBaseUrl } from './runtimeConfig';

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

/**
 * `GET /portfolios` — the user's portfolios. Active only by default; pass
 * `includeArchived` to also return soft-archived portfolios (§13.2 V2-P8).
 */
export async function listPortfolios(
  signal?: AbortSignal,
  includeArchived = false,
): Promise<PortfolioListResponse> {
  const data = await apiRequest<unknown>('/portfolios', {
    query: includeArchived ? { includeArchived: 'true' } : {},
    signal,
  });
  return portfolioListResponseSchema.parse(data);
}

/** `POST /portfolios` — create a named portfolio (§13.2 V2-P8). */
export async function createPortfolio(name: string): Promise<PortfolioSummary> {
  const data = await apiRequest<unknown>('/portfolios', { method: 'POST', body: { name } });
  return portfolioMutationResponseSchema.parse(data).portfolio;
}

/** `POST /portfolios/:id/archive` — soft-archive a portfolio (§13.2 V2-P8). */
export async function archivePortfolio(portfolioId: string): Promise<PortfolioSummary> {
  const data = await apiRequest<unknown>(`/portfolios/${encodeURIComponent(portfolioId)}/archive`, {
    method: 'POST',
  });
  return portfolioMutationResponseSchema.parse(data).portfolio;
}

/** `POST /portfolios/:id/restore` — restore an archived portfolio (§13.2 V2-P8). */
export async function restorePortfolio(portfolioId: string): Promise<PortfolioSummary> {
  const data = await apiRequest<unknown>(`/portfolios/${encodeURIComponent(portfolioId)}/restore`, {
    method: 'POST',
  });
  return portfolioMutationResponseSchema.parse(data).portfolio;
}

/**
 * `DELETE /portfolios/:id` — permanently delete a portfolio and everything in it
 * (transactions, cash ledger + sources, dividends, shares + public links). The
 * hard option beside archive; irreversible. 204 on success, 404 if it is already
 * gone, 400 (`LAST_ACTIVE_PORTFOLIO`) when it is the caller's only active one.
 */
export async function deletePortfolio(portfolioId: string): Promise<void> {
  await apiRequest<unknown>(`/portfolios/${encodeURIComponent(portfolioId)}`, {
    method: 'DELETE',
  });
}

/** `PATCH /portfolios/:id` — rename and/or change visibility (e.g. the Shared Items toggle-off). */
export async function updatePortfolio(
  portfolioId: string,
  patch: UpdatePortfolioRequest,
): Promise<PortfolioSummary> {
  const data = await apiRequest<unknown>(`/portfolios/${encodeURIComponent(portfolioId)}`, {
    method: 'PATCH',
    body: patch,
  });
  return updatePortfolioResponseSchema.parse(data).portfolio;
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

/**
 * `GET /portfolios/:id/history?range=&overlay=` — EUR value-over-time series;
 * `overlay=true` additionally returns each held asset's own daily price series
 * so the chart can overlay them on the portfolio curve (#122).
 */
export async function getPortfolioHistory(
  portfolioId: string,
  range: PortfolioHistoryRange,
  overlay = false,
  signal?: AbortSignal,
): Promise<PortfolioHistoryResponse> {
  const data = await apiRequest<unknown>(`/portfolios/${encodeURIComponent(portfolioId)}/history`, {
    query: { range, ...(overlay ? { overlay: 'true' } : {}) },
    signal,
  });
  return portfolioHistoryResponseSchema.parse(data);
}

// --- Transactions ----------------------------------------------------------

/** `GET /portfolios/:id/transactions?cursor=` — newest-first ledger, keyset paginated. */
export async function listTransactions(
  portfolioId: string,
  params: { cursor?: string; limit?: number; source?: string } = {},
  signal?: AbortSignal,
): Promise<TransactionListResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/transactions`,
    {
      // `source` is the V5-P0c source-tag filter (omitted → all rows).
      query: { cursor: params.cursor, limit: params.limit, source: params.source },
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

// --- Per-year tax report (V3-P4) ---------------------------------------------

/**
 * `GET /portfolios/:id/reports/tax-years` — one row per Europe/Vienna calendar
 * year (newest first) with realized P/L, gross dividends, and the tax withheld /
 * refunded / net that year's settlement movements hold (V3-P4d).
 */
export async function getTaxYearReports(
  portfolioId: string,
  signal?: AbortSignal,
): Promise<TaxYearListResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/reports/tax-years`,
    { signal },
  );
  return taxYearListResponseSchema.parse(data);
}

/**
 * `GET /portfolios/:id/reports/tax-years/:year` — one year's per-position
 * drill-down (each asset's realized P/L, dividends, recorded tax, and the
 * underlying sells/dividends). An uncovered sell (#369) shows its proceeds
 * against a basis that never fabricates gain on the uncovered portion.
 */
export async function getTaxYearReport(
  portfolioId: string,
  year: number,
  signal?: AbortSignal,
): Promise<TaxYearReportResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/reports/tax-years/${encodeURIComponent(year)}`,
    { signal },
  );
  return taxYearReportResponseSchema.parse(data);
}

/**
 * The absolute URL that streams one portfolio+year tax report as CSV (V5-P4b,
 * #583). A same-site top-level navigation (an `<a download>`) sends the session
 * cookie and the server returns `text/csv` with a `Content-Disposition`
 * attachment; the endpoint is owner-scoped exactly like the report itself.
 * `locale` picks header language only — the numbers match the on-screen report.
 */
export function taxYearReportCsvUrl(
  portfolioId: string,
  year: number,
  locale: TaxExportLocale,
): string {
  return `${apiBaseUrl()}/portfolios/${encodeURIComponent(portfolioId)}/reports/tax-years/${encodeURIComponent(year)}/export.csv?locale=${encodeURIComponent(locale)}`;
}

// --- Per-portfolio tax treatment (issue #636) ------------------------------

/**
 * `GET /portfolios/:id/settings/tax` — the portfolio's tax treatment resolved
 * through the per-portfolio scoping cascade (`effective = override ?? user
 * default ?? none`): the effective mode/country, this portfolio's own override
 * (or null when inheriting), the user-level default, and which layer won.
 */
export async function getPortfolioTaxSettings(
  portfolioId: string,
  signal?: AbortSignal,
): Promise<PortfolioTaxSettingsResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/settings/tax`,
    { signal },
  );
  return portfolioTaxSettingsResponseSchema.parse(data);
}

/** `PUT /portfolios/:id/settings/tax` — pin this portfolio's tax override (#636). */
export async function setPortfolioTaxOverride(
  portfolioId: string,
  body: UpdateTaxSettingsRequest,
): Promise<PortfolioTaxSettingsResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/settings/tax`,
    { method: 'PUT', body },
  );
  return portfolioTaxSettingsResponseSchema.parse(data);
}

/** `DELETE /portfolios/:id/settings/tax` — reset to the user default (inherit) (#636). */
export async function clearPortfolioTaxOverride(
  portfolioId: string,
): Promise<PortfolioTaxSettingsResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/settings/tax`,
    { method: 'DELETE' },
  );
  return portfolioTaxSettingsResponseSchema.parse(data);
}

// --- Cash ledger ("Bargeld") -------------------------------------------------

/** `GET /portfolios/:id/cash` — cash movements + current balance (§14, #220). */
export async function getCashMovements(
  portfolioId: string,
  signal?: AbortSignal,
): Promise<CashMovementsResponse> {
  const data = await apiRequest<unknown>(`/portfolios/${encodeURIComponent(portfolioId)}/cash`, {
    signal,
  });
  return cashMovementsResponseSchema.parse(data);
}

/** `POST /portfolios/:id/cash/deposit` — record an external deposit. */
export async function depositCash(
  portfolioId: string,
  body: CashEntryRequest,
): Promise<CashMovementResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/cash/deposit`,
    { method: 'POST', body },
  );
  return cashMovementResponseSchema.parse(data);
}

/** `POST /portfolios/:id/cash/withdraw` — record a withdrawal; rejects an overdraw. */
export async function withdrawCash(
  portfolioId: string,
  body: CashEntryRequest,
): Promise<CashMovementResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/cash/withdraw`,
    { method: 'POST', body },
  );
  return cashMovementResponseSchema.parse(data);
}

/**
 * `POST /portfolios/:id/cash/preview` — the live "available → after" preview for
 * a proposed movement; read-only, no movement is persisted (§14).
 */
export async function previewCash(
  portfolioId: string,
  body: CashPreviewRequest,
  signal?: AbortSignal,
): Promise<CashPreviewResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/cash/preview`,
    { method: 'POST', body, signal },
  );
  return cashPreviewResponseSchema.parse(data);
}

// --- Cash sources (V3-P3) ----------------------------------------------------

/**
 * `GET /portfolios/:id/cash/sources?includeArchived=` — the portfolio's cash
 * sources (Main first) with per-source balances (V3-P3). Active only by default.
 */
export async function listCashSources(
  portfolioId: string,
  includeArchived = false,
  signal?: AbortSignal,
): Promise<CashSourceListResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/cash/sources`,
    { query: includeArchived ? { includeArchived: 'true' } : {}, signal },
  );
  return cashSourceListResponseSchema.parse(data);
}

/** `POST /portfolios/:id/cash/sources` — create a named cash source (V3-P3). */
export async function createCashSource(
  portfolioId: string,
  body: CreateCashSourceRequest,
): Promise<CashSource> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/cash/sources`,
    { method: 'POST', body },
  );
  return cashSourceResponseSchema.parse(data).source;
}

/** `PATCH /portfolios/:id/cash/sources/:sourceId` — rename / relabel a source (V3-P3). */
export async function updateCashSource(
  portfolioId: string,
  sourceId: string,
  patch: UpdateCashSourceRequest,
): Promise<CashSource> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/cash/sources/${encodeURIComponent(sourceId)}`,
    { method: 'PATCH', body: patch },
  );
  return cashSourceResponseSchema.parse(data).source;
}

/** `POST /portfolios/:id/cash/sources/:sourceId/archive` — soft-archive a €0.00 source (V3-P3). */
export async function archiveCashSource(
  portfolioId: string,
  sourceId: string,
): Promise<CashSource> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/cash/sources/${encodeURIComponent(
      sourceId,
    )}/archive`,
    { method: 'POST' },
  );
  return cashSourceResponseSchema.parse(data).source;
}

/** `POST /portfolios/:id/cash/sources/:sourceId/restore` — undo an archive (V3-P3). */
export async function restoreCashSource(
  portfolioId: string,
  sourceId: string,
): Promise<CashSource> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/cash/sources/${encodeURIComponent(
      sourceId,
    )}/restore`,
    { method: 'POST' },
  );
  return cashSourceResponseSchema.parse(data).source;
}

/**
 * `POST /portfolios/:id/cash/transfer` — move money between two active sources
 * as an atomic paired movement; never a TWR external flow (V3-P3).
 */
export async function transferCash(
  portfolioId: string,
  body: CashTransferRequest,
): Promise<CashTransferResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/cash/transfer`,
    { method: 'POST', body },
  );
  return cashTransferResponseSchema.parse(data);
}

/**
 * `POST /portfolios/:id/cash/sources/:sourceId/set-balance` — "set balance to X"
 * (V3-P3, §16): the server computes the signed delta and records it as a normal
 * deposit / withdrawal movement, keeping the audit trail intact.
 */
export async function setCashBalance(
  portfolioId: string,
  sourceId: string,
  body: SetCashBalanceRequest,
): Promise<SetCashBalanceResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${encodeURIComponent(portfolioId)}/cash/sources/${encodeURIComponent(
      sourceId,
    )}/set-balance`,
    { method: 'POST', body },
  );
  return setCashBalanceResponseSchema.parse(data);
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

/**
 * `GET /custom-assets/recategorization` — how many of the caller's custom assets
 * still carry the one-time V3-P2 migration flag (`pending`). The overview shows
 * the re-categorize banner while it is `> 0`.
 */
export async function getRecategorizationStatus(
  signal?: AbortSignal,
): Promise<RecategorizationStatusResponse> {
  const data = await apiRequest<unknown>('/custom-assets/recategorization', { signal });
  return recategorizationStatusResponseSchema.parse(data);
}

/** `POST /custom-assets/recategorization/dismiss` — clear the migration flag on all assets (204). */
export async function dismissRecategorization(): Promise<void> {
  await apiRequest<unknown>('/custom-assets/recategorization/dismiss', { method: 'POST' });
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
