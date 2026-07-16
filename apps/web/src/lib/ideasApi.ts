import {
  ideaListResponseSchema,
  ideaResponseSchema,
  type CreateIdeaRequest,
  type IdeaListResponse,
  type IdeaResponse,
  type UpdateIdeaRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the Ideas surface (PROJECTPLAN.md §13.4 V4-P9) — saved &
 * shareable Workboard analyses. Every response is parsed through its contract
 * schema, mirroring `conglomerateApi.ts`. Sharing an idea is NOT here: it routes
 * through the shared audience path (`PUT /social/audience/idea/:subjectId`) in
 * `socialApi.ts`, the ONE enforcement layer.
 */

/** `GET /ideas` — the caller's saved ideas, newest first. */
export async function listIdeas(signal?: AbortSignal): Promise<IdeaListResponse> {
  const data = await apiRequest<unknown>('/ideas', { signal });
  return ideaListResponseSchema.parse(data);
}

/** `GET /ideas/:ideaId` — one of the caller's own ideas (exact saved state). */
export async function getIdea(ideaId: string, signal?: AbortSignal): Promise<IdeaResponse> {
  const data = await apiRequest<unknown>(`/ideas/${encodeURIComponent(ideaId)}`, { signal });
  return ideaResponseSchema.parse(data);
}

/** `POST /ideas` — persist a named Workboard state (conglomerate ref | ad-hoc set). */
export async function createIdea(body: CreateIdeaRequest): Promise<IdeaResponse> {
  const data = await apiRequest<unknown>('/ideas', { method: 'POST', body });
  return ideaResponseSchema.parse(data);
}

/** `PATCH /ideas/:ideaId` — rename, re-note, or re-save the Workboard state. */
export async function updateIdea(ideaId: string, body: UpdateIdeaRequest): Promise<IdeaResponse> {
  const data = await apiRequest<unknown>(`/ideas/${encodeURIComponent(ideaId)}`, {
    method: 'PATCH',
    body,
  });
  return ideaResponseSchema.parse(data);
}

/** `DELETE /ideas/:ideaId` — hard-delete an own idea (+ its audience row). */
export async function deleteIdea(ideaId: string): Promise<void> {
  await apiRequest<unknown>(`/ideas/${encodeURIComponent(ideaId)}`, { method: 'DELETE' });
}

/**
 * `POST /ideas/:ideaId/clone` — clone an audience-admitted idea into an own
 * private copy. A viewer the audience doesn't admit gets a 404 (no leak).
 */
export async function cloneIdea(ideaId: string): Promise<IdeaResponse> {
  const data = await apiRequest<unknown>(`/ideas/${encodeURIComponent(ideaId)}/clone`, {
    method: 'POST',
  });
  return ideaResponseSchema.parse(data);
}
