import {
  applyImportResponseSchema,
  importBrokerListResponseSchema,
  importPreviewResponseSchema,
  type ApplyImportRequest,
  type ApplyImportResponse,
  type ImportBrokerListResponse,
  type ImportPreviewResponse,
  type ResolveImportRowRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Broker CSV imports (PROJECTPLAN.md §13.4 V4-P8): upload → staged preview →
 * apply/discard. The upload is the app's one multipart request — the CSV file
 * plus the target portfolio (and an optional manual broker pick) as form fields.
 */

/** Query key for the supported-brokers list (static per deployment). */
export const IMPORT_BROKERS_QUERY_KEY = ['imports', 'brokers'] as const;

/** `GET /imports/brokers` — the supported broker mappers, for the picker. */
export async function listImportBrokers(signal?: AbortSignal): Promise<ImportBrokerListResponse> {
  const data = await apiRequest<unknown>('/imports/brokers', { signal });
  return importBrokerListResponseSchema.parse(data);
}

/** `POST /imports` — upload a CSV into a staged batch and get the preview back. */
export async function uploadImportBatch(input: {
  file: File;
  portfolioId: string;
  brokerId?: string;
}): Promise<ImportPreviewResponse> {
  const form = new FormData();
  form.append('portfolioId', input.portfolioId);
  if (input.brokerId) form.append('brokerId', input.brokerId);
  form.append('file', input.file);
  const data = await apiRequest<unknown>('/imports', { method: 'POST', body: form });
  return importPreviewResponseSchema.parse(data);
}

/** `POST /imports/:batchId/apply` — confirm a staged batch; per-row outcomes. */
export async function applyImportBatch(
  batchId: string,
  body: ApplyImportRequest,
): Promise<ApplyImportResponse> {
  const data = await apiRequest<unknown>(`/imports/${encodeURIComponent(batchId)}/apply`, {
    method: 'POST',
    body,
  });
  return applyImportResponseSchema.parse(data);
}

/**
 * `PATCH /imports/:batchId/rows/:rowId` — the two things a person can decide
 * about ONE staged row, exactly one per call:
 *
 *  - `{ assetId }` pins an unresolved row to an asset the USER picked (#964,
 *    §16 2026-07-31 point 4);
 *  - `{ kind }` confirms what an UNDECIDED row is (§16 2026-08-29 gap (b)) —
 *    one member of the row's own `confirmableKinds`. The body carries the
 *    assertion and NOTHING else: every number the row books is re-derived
 *    server-side from what staging parsed, so this client cannot move an
 *    amount even by accident.
 *
 * Returns the whole refreshed preview rather than the single row: either
 * decision changes the batch counts and can flip the row to `duplicate` against
 * data the client cannot see, so the server's view replaces the local one
 * wholesale — the client never recomputes what staging decided.
 */
export async function resolveImportRow(
  batchId: string,
  rowId: string,
  body: ResolveImportRowRequest,
): Promise<ImportPreviewResponse> {
  const data = await apiRequest<unknown>(
    `/imports/${encodeURIComponent(batchId)}/rows/${encodeURIComponent(rowId)}`,
    { method: 'PATCH', body },
  );
  return importPreviewResponseSchema.parse(data);
}

/** `DELETE /imports/:batchId` — discard a staged batch (staging data only). */
export async function discardImportBatch(batchId: string): Promise<void> {
  await apiRequest<unknown>(`/imports/${encodeURIComponent(batchId)}`, { method: 'DELETE' });
}
