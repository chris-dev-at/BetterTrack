import { workboardListResponseSchema, type WorkboardListResponse } from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/** `GET /workboard` — user's watchlist in sort_order (PROJECTPLAN.md §6.4, §8). */
export async function listWorkboard(signal?: AbortSignal): Promise<WorkboardListResponse> {
  const data = await apiRequest<unknown>('/workboard', { signal });
  return workboardListResponseSchema.parse(data);
}

/** `POST /workboard` — add an asset to the user's watchlist (PROJECTPLAN.md §6.4, §8). */
export async function addToWorkboard(assetId: string): Promise<void> {
  await apiRequest<unknown>('/workboard', {
    method: 'POST',
    body: { assetId },
  });
}

/** `DELETE /workboard/:itemId` — remove a watched asset (PROJECTPLAN.md §6.4, §8). */
export async function removeFromWorkboard(itemId: string): Promise<void> {
  await apiRequest<unknown>(`/workboard/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
  });
}

/** `PATCH /workboard/reorder` — persist a new sort order (PROJECTPLAN.md §6.4, §8). */
export async function reorderWorkboard(itemIds: string[]): Promise<void> {
  await apiRequest<unknown>('/workboard/reorder', {
    method: 'PATCH',
    body: { itemIds },
  });
}
