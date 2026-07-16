import {
  applyImportResponseSchema,
  importBrokerListResponseSchema,
  importPreviewResponseSchema,
  type ApplyImportRequest,
  type ApplyImportResponse,
  type ImportBrokerListResponse,
  type ImportPreviewResponse,
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

/** `DELETE /imports/:batchId` — discard a staged batch (staging data only). */
export async function discardImportBatch(batchId: string): Promise<void> {
  await apiRequest<unknown>(`/imports/${encodeURIComponent(batchId)}`, { method: 'DELETE' });
}
