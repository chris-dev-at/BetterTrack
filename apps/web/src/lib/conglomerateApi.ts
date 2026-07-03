import {
  allocateResponseSchema,
  conglomerateDetailSchema,
  conglomerateListResponseSchema,
  type AllocateRequest,
  type AllocateResponse,
  type ConglomerateDetail,
  type ConglomerateListResponse,
  type CreateConglomerateRequest,
  type ReplacePositionInput,
  type UpdateConglomerateRequest,
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

/** `PATCH /conglomerates/:id` — rename / edit the description (the Builder autosave). */
export async function updateConglomerate(
  id: string,
  body: UpdateConglomerateRequest,
): Promise<ConglomerateDetail> {
  const data = await apiRequest<unknown>(`/conglomerates/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
  return conglomerateDetailSchema.parse(data);
}

/**
 * `PUT /conglomerates/:id/positions` — bulk-replace all positions (the Builder
 * autosave, §6.5). `sortOrder` is derived server-side from array order. Weights
 * must be `0 < w ≤ 100` (≤ 3 dp), so a caller drops any weight-0 rows.
 */
export async function replaceConglomeratePositions(
  id: string,
  positions: ReplacePositionInput[],
): Promise<ConglomerateDetail> {
  const data = await apiRequest<unknown>(`/conglomerates/${encodeURIComponent(id)}/positions`, {
    method: 'PUT',
    body: { positions },
  });
  return conglomerateDetailSchema.parse(data);
}

/** `POST /conglomerates/:id/activate` — draft → active when Σ weights = 100 ± 0.01. */
export async function activateConglomerate(id: string): Promise<ConglomerateDetail> {
  const data = await apiRequest<unknown>(`/conglomerates/${encodeURIComponent(id)}/activate`, {
    method: 'POST',
  });
  return conglomerateDetailSchema.parse(data);
}

/** `DELETE /conglomerates/:id` — hard-delete (cascades positions). */
export async function deleteConglomerate(id: string): Promise<void> {
  await apiRequest<unknown>(`/conglomerates/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * `POST /conglomerates/:id/allocate` — Invest Calculator: turn a EUR budget
 * into a never-overshoot buy list (§6.7).
 */
export async function allocateConglomerate(
  id: string,
  body: AllocateRequest,
): Promise<AllocateResponse> {
  const data = await apiRequest<unknown>(`/conglomerates/${encodeURIComponent(id)}/allocate`, {
    method: 'POST',
    body,
  });
  return allocateResponseSchema.parse(data);
}
