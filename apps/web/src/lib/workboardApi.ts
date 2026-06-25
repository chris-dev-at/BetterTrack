import { apiRequest } from './apiClient';

/** `POST /workboard` — add an asset to the user's watchlist (PROJECTPLAN.md §6.4, §8). */
export async function addToWorkboard(assetId: string): Promise<void> {
  await apiRequest<unknown>('/workboard', {
    method: 'POST',
    body: { assetId },
  });
}
