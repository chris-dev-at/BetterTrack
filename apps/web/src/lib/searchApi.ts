import { searchResponseSchema, type SearchResponse } from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/** `GET /search?q=` — typed wrapper (PROJECTPLAN.md §6.2, §8). */
export async function searchAssets(q: string, signal?: AbortSignal): Promise<SearchResponse> {
  const data = await apiRequest<unknown>('/search', { query: { q }, signal });
  return searchResponseSchema.parse(data);
}
