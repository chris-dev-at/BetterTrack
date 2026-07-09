import { z } from 'zod';

import { shareAudienceSchema } from './common';
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

/** One row in a watchlist, enriched with its asset metadata (§6.4, §8). */
export const workboardItemSchema = z
  .object({
    id: z.string().uuid(),
    /** The named list this item belongs to (V3-P5 multiple watchlists). */
    watchlistId: z.string().uuid(),
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

/**
 * `POST /workboard` request body. `watchlistId` targets a specific named list
 * (V3-P5); when omitted the asset lands in the caller's default **General** list,
 * so every existing add-to-watchlist call keeps working unchanged.
 */
export const addToWorkboardRequestSchema = z
  .object({ assetId: z.string().uuid(), watchlistId: z.string().uuid().optional() })
  .strict();
export type AddToWorkboardRequest = z.infer<typeof addToWorkboardRequestSchema>;

// --- Named watchlists (V3-P5) ----------------------------------------------

/**
 * One named watchlist in the caller's own list of lists (V3-P5). **General** is
 * the auto-provisioned default (`isDefault`) and can never be renamed away or
 * deleted; `audience` is this list's share setting via the shared audience model.
 */
export const watchlistSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    isDefault: z.boolean(),
    itemCount: z.number().int(),
    audience: shareAudienceSchema,
  })
  .strict();
export type WatchlistSummary = z.infer<typeof watchlistSummarySchema>;

/** `GET /workboard/watchlists` response — the caller's named lists, General first. */
export const watchlistListResponseSchema = z
  .object({ watchlists: z.array(watchlistSummarySchema) })
  .strict();
export type WatchlistListResponse = z.infer<typeof watchlistListResponseSchema>;

/** `POST /workboard/watchlists` body — create a named list. */
export const createWatchlistRequestSchema = z
  .object({ name: z.string().trim().min(1).max(60) })
  .strict();
export type CreateWatchlistRequest = z.infer<typeof createWatchlistRequestSchema>;

/** `PATCH /workboard/watchlists/:watchlistId` body — rename a list (never the default). */
export const updateWatchlistRequestSchema = z
  .object({ name: z.string().trim().min(1).max(60) })
  .strict();
export type UpdateWatchlistRequest = z.infer<typeof updateWatchlistRequestSchema>;

/** Route param for per-list operations. */
export const watchlistIdParamSchema = z.object({ watchlistId: z.string().uuid() }).strict();
export type WatchlistIdParam = z.infer<typeof watchlistIdParamSchema>;

/** `GET /workboard` query — optionally scope the listing to one named list. */
export const workboardListQuerySchema = z
  .object({ watchlistId: z.string().uuid().optional() })
  .strict();
export type WorkboardListQuery = z.infer<typeof workboardListQuerySchema>;

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
