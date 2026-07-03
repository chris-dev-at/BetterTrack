import {
  conglomerateDetailSchema,
  conglomerateListResponseSchema,
  type ConglomerateDetail,
  type ConglomerateListResponse,
  type CreateConglomerateRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the Conglomerate CRUD surface (PROJECTPLAN.md §6.5, §7.2).
 * Every response is parsed through its contract schema, mirroring
 * `portfolioApi.ts` / `workboardApi.ts`.
 */

/** `GET /conglomerates` — the caller's Conglomerates with position counts. */
export async function listConglomerates(signal?: AbortSignal): Promise<ConglomerateListResponse> {
  const data = await apiRequest<unknown>('/conglomerates', { signal });
  return conglomerateListResponseSchema.parse(data);
}

/** `GET /conglomerates/:id` — detail with positions + embedded asset identity. */
export async function getConglomerate(
  id: string,
  signal?: AbortSignal,
): Promise<ConglomerateDetail> {
  const data = await apiRequest<unknown>(`/conglomerates/${encodeURIComponent(id)}`, { signal });
  return conglomerateDetailSchema.parse(data);
}

/** `POST /conglomerates` — create a new `draft` (empty positions). */
export async function createConglomerate(
  body: CreateConglomerateRequest,
): Promise<ConglomerateDetail> {
  const data = await apiRequest<unknown>('/conglomerates', { method: 'POST', body });
  return conglomerateDetailSchema.parse(data);
}

/** `DELETE /conglomerates/:id` — hard-delete (cascades positions). */
export async function deleteConglomerate(id: string): Promise<void> {
  await apiRequest<unknown>(`/conglomerates/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
