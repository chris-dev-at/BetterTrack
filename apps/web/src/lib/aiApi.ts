import { useQuery } from '@tanstack/react-query';

import {
  aiCapabilityResponseSchema,
  aiConglomerateDraftResponseSchema,
  aiInsightsResponseSchema,
  type AiCapabilityResponse,
  type AiConglomerateDraftRequest,
  type AiConglomerateDraftResponse,
  type AiInsightsRequest,
  type AiInsightsResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * User-facing AI client (PROJECTPLAN.md §13.5 V5-P12, §16 2026-07-22 — LOCAL AI
 * ONLY). The capability read is the SINGLE gate every AI surface keys visibility
 * off: `available: false` (no provider configured, or the `ai` feature flag off)
 * ⇒ nothing AI-related renders. The two generation calls (insights + NL builder)
 * ride the same per-user daily cap; an exhausted cap surfaces as an `ApiError`
 * with code `AI_CAP_EXCEEDED` (429) the callers degrade on gracefully.
 */

/** Query key for the AI capability descriptor. */
export const AI_CAPABILITY_QUERY_KEY = ['ai', 'capability'] as const;

/** `GET /ai/capability` — availability + remaining daily budget for the caller. */
export async function getAiCapability(signal?: AbortSignal): Promise<AiCapabilityResponse> {
  const data = await apiRequest<unknown>('/ai/capability', { signal });
  return aiCapabilityResponseSchema.parse(data);
}

/**
 * The shared AI capability query. Cached briefly so every surface (analytics
 * insights, the NL builder) reads one source of truth without refetching per
 * mount, and so a just-spent completion's remaining count refreshes on refetch.
 */
export function useAiCapability() {
  return useQuery({
    queryKey: AI_CAPABILITY_QUERY_KEY,
    queryFn: ({ signal }) => getAiCapability(signal),
    staleTime: 60_000,
  });
}

/** `POST /ai/insights` — service-computed observations phrased by the local model. */
export async function generateInsights(
  body: AiInsightsRequest,
  signal?: AbortSignal,
): Promise<AiInsightsResponse> {
  const data = await apiRequest<unknown>('/ai/insights', { method: 'POST', body, signal });
  return aiInsightsResponseSchema.parse(data);
}

/** `POST /ai/conglomerate-draft` — a reviewed builder draft from a description. */
export async function draftConglomerate(
  body: AiConglomerateDraftRequest,
  signal?: AbortSignal,
): Promise<AiConglomerateDraftResponse> {
  const data = await apiRequest<unknown>('/ai/conglomerate-draft', {
    method: 'POST',
    body,
    signal,
  });
  return aiConglomerateDraftResponseSchema.parse(data);
}
