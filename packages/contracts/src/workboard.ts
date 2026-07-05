import { z } from 'zod';

import { assetTypeSchema, currencyCodeSchema } from './market';

/** Asset metadata embedded in every workboard item row (§6.4). */
export const workboardItemAssetSchema = z
  .object({
    symbol: z.string(),
    name: z.string(),
    exchange: z.string().nullable(),
    currency: currencyCodeSchema,
    type: assetTypeSchema,
  })
  .strict();
export type WorkboardItemAsset = z.infer<typeof workboardItemAssetSchema>;

/** One row in the user's watchlist, enriched with its asset metadata (§6.4, §8). */
export const workboardItemSchema = z
  .object({
    id: z.string().uuid(),
    assetId: z.string().uuid(),
    sortOrder: z.number().int(),
    note: z.string().nullable(),
    asset: workboardItemAssetSchema,
  })
  .strict();
export type WorkboardItem = z.infer<typeof workboardItemSchema>;

/** `GET /workboard` response. */
export const workboardListResponseSchema = z
  .object({ items: z.array(workboardItemSchema) })
  .strict();
export type WorkboardListResponse = z.infer<typeof workboardListResponseSchema>;

/** `POST /workboard` request body. */
export const addToWorkboardRequestSchema = z.object({ assetId: z.string().uuid() }).strict();
export type AddToWorkboardRequest = z.infer<typeof addToWorkboardRequestSchema>;

/** `PATCH /workboard/reorder` request body — ordered list of item UUIDs. */
export const reorderWorkboardRequestSchema = z
  .object({ itemIds: z.array(z.string().uuid()) })
  .strict();
export type ReorderWorkboardRequest = z.infer<typeof reorderWorkboardRequestSchema>;

/** Route param for workboard item operations. */
export const itemIdParamSchema = z.object({ itemId: z.string().uuid() }).strict();

// --- Watchlist sharing (§6.9, §13.2 V2-P9) ---------------------------------

/**
 * Friend-sharing visibility for the caller's whole watchlist (§6.9, V2-P9):
 * `private` (default) keeps it visible only to the owner; `friends` exposes a
 * **read-only** copy to the owner's friends via Shared With Me. All-or-nothing
 * per user — there is no per-item sharing. Mirrors the portfolio model — no
 * tokens, revocable, authorization re-derived per read.
 */
export const watchlistVisibilitySchema = z.enum(['private', 'friends']);
export type WatchlistVisibility = z.infer<typeof watchlistVisibilitySchema>;

/** `GET /workboard/sharing` response — the caller's current watchlist sharing state. */
export const watchlistSharingResponseSchema = z
  .object({ visibility: watchlistVisibilitySchema })
  .strict();
export type WatchlistSharingResponse = z.infer<typeof watchlistSharingResponseSchema>;

/** `PATCH /workboard/sharing` body — turn watchlist friend-sharing on/off. */
export const updateWatchlistSharingRequestSchema = z
  .object({ visibility: watchlistVisibilitySchema })
  .strict();
export type UpdateWatchlistSharingRequest = z.infer<typeof updateWatchlistSharingRequestSchema>;
