import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  watchlistSharingResponseSchema,
  workboardListResponseSchema,
  type WatchlistSharingResponse,
  type WatchlistVisibility,
  type WorkboardListResponse,
} from '@bettertrack/contracts';

import { ApiError, apiRequest } from './apiClient';

/** Shared TanStack Query key for watchlist membership — one source of truth for invalidation. */
export const WORKBOARD_QUERY_KEY = ['workboard'] as const;

/** Query key for the watchlist friend-sharing state (§6.9, V2-P9). */
export const WATCHLIST_SHARING_QUERY_KEY = ['workboard', 'sharing'] as const;

/** `GET /workboard/sharing` — the caller's watchlist friend-sharing state (§6.9, V2-P9). */
export async function getWatchlistSharing(signal?: AbortSignal): Promise<WatchlistSharingResponse> {
  const data = await apiRequest<unknown>('/workboard/sharing', { signal });
  return watchlistSharingResponseSchema.parse(data);
}

/** `PATCH /workboard/sharing` — turn watchlist friend-sharing on/off (§6.9, V2-P9). */
export async function updateWatchlistSharing(
  visibility: WatchlistVisibility,
): Promise<WatchlistSharingResponse> {
  const data = await apiRequest<unknown>('/workboard/sharing', {
    method: 'PATCH',
    body: { visibility },
  });
  return watchlistSharingResponseSchema.parse(data);
}

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

/**
 * Current watchlist membership as a `Set<assetId>` (§13.2) — lets any surface
 * render a state-aware icon from first render, not only after a click in the
 * current session. Shared by the search results (#256) and the asset detail
 * page quick actions.
 */
export function useWatchlistMembership() {
  const query = useQuery({
    queryKey: WORKBOARD_QUERY_KEY,
    queryFn: ({ signal }) => listWorkboard(signal),
    staleTime: 30_000,
  });
  const watchedIds = useMemo(
    () => new Set((query.data?.items ?? []).map((i) => i.assetId)),
    [query.data],
  );
  return { ...query, watchedIds };
}

/**
 * State-aware add-to-watchlist mutation (§13.2, reused from #256): a re-add of
 * an already-watched asset (e.g. a stale membership snapshot, or a double-click
 * race) resolves as a success instead of surfacing `ALREADY_WATCHING`.
 */
export function useAddToWatchlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (assetId: string) => {
      try {
        await addToWorkboard(assetId);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'ALREADY_WATCHING') return;
        throw err;
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WORKBOARD_QUERY_KEY });
    },
  });
}
