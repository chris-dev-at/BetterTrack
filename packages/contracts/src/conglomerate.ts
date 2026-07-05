import { z } from 'zod';

import { assetTypeSchema, currencyCodeSchema } from './market';

/**
 * Conglomerate contracts (PROJECTPLAN.md §6.5, §7.2, §8).
 *
 * A Conglomerate is a user-defined, ETF-style weighted basket of assets. This
 * module defines every wire shape the Conglomerate CRUD surface speaks — once —
 * so the API validates against it and the web client derives its types from the
 * same source. Weights are `numeric(6,3)` end-to-end: `0 < w ≤ 100` with **≤ 3
 * decimals**, never rounded on write (§2.6). Display rounds to 1 dp in the client.
 */

// --- Status ----------------------------------------------------------------

/**
 * A Conglomerate is a `draft` while being edited (autosave persists every
 * change and permits any weight state) or `active` once validated (Σ weights =
 * 100 ± 0.01). "Activate" flips draft → active (§6.5).
 */
export const conglomerateStatusSchema = z.enum(['draft', 'active']);
export type ConglomerateStatus = z.infer<typeof conglomerateStatusSchema>;

/**
 * Friend-sharing visibility (§6.9, §13.2 V2-P9): `private` (default) keeps a
 * conglomerate visible only to its owner; `friends` exposes a **read-only** copy
 * to the owner's friends via Shared With Me. Mirrors the portfolio model — no
 * tokens, revocable, authorization re-derived per read.
 */
export const conglomerateVisibilitySchema = z.enum(['private', 'friends']);
export type ConglomerateVisibility = z.infer<typeof conglomerateVisibilitySchema>;

// --- Positions -------------------------------------------------------------

/**
 * A weight percentage: `0 < w ≤ 100` with at most 3 decimal places, matching
 * the `numeric(6,3)` storage (§2.6). The decimal check keeps precision honest
 * end-to-end — the value is stored exactly as submitted, never rounded on write.
 */
export const weightPctSchema = z
  .number()
  .gt(0, 'Weight must be greater than 0.')
  .lte(100, 'Weight must be at most 100.')
  .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, {
    message: 'Weight may have at most 3 decimal places.',
  });

/** Asset identity embedded in a position for display (§6.5). */
export const conglomerateAssetSchema = z
  .object({
    symbol: z.string(),
    name: z.string(),
    currency: currencyCodeSchema,
    type: assetTypeSchema,
  })
  .strict();
export type ConglomerateAsset = z.infer<typeof conglomerateAssetSchema>;

/** One stored position — asset id, weight, and its `sortOrder` (§6.5). */
export const conglomeratePositionSchema = z
  .object({
    assetId: z.string().uuid(),
    weightPct: weightPctSchema,
    sortOrder: z.number().int(),
  })
  .strict();
export type ConglomeratePosition = z.infer<typeof conglomeratePositionSchema>;

/** A position enriched with its asset identity for the detail response (§6.5). */
export const conglomeratePositionWithAssetSchema = conglomeratePositionSchema
  .extend({ asset: conglomerateAssetSchema })
  .strict();
export type ConglomeratePositionWithAsset = z.infer<typeof conglomeratePositionWithAssetSchema>;

// --- Conglomerates (list + detail) -----------------------------------------

/** One Conglomerate in the list, with its position count (§6.5, §7.2). */
export const conglomerateSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    status: conglomerateStatusSchema,
    /** Friend-sharing visibility (§6.9, V2-P9): `private` (default) or `friends`. */
    visibility: conglomerateVisibilitySchema,
    positionCount: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ConglomerateSummary = z.infer<typeof conglomerateSummarySchema>;

/** A single Conglomerate with its positions (ordered by `sortOrder`) (§6.5). */
export const conglomerateDetailSchema = conglomerateSummarySchema
  .extend({ positions: z.array(conglomeratePositionWithAssetSchema) })
  .strict();
export type ConglomerateDetail = z.infer<typeof conglomerateDetailSchema>;

/** `GET /conglomerates` response — the caller's Conglomerates. */
export const conglomerateListResponseSchema = z
  .object({ conglomerates: z.array(conglomerateSummarySchema) })
  .strict();
export type ConglomerateListResponse = z.infer<typeof conglomerateListResponseSchema>;

// --- Requests --------------------------------------------------------------

/** `POST /conglomerates` body — a new `draft` with a name and optional note. */
export const createConglomerateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullish(),
  })
  .strict();
export type CreateConglomerateRequest = z.infer<typeof createConglomerateRequestSchema>;

/**
 * `PATCH /conglomerates/:id` body — rename, edit the description, and/or toggle
 * friend-sharing (§6.9, V2-P9). Every field is optional; `visibility=friends`
 * shares the basket read-only with the owner's friends, `private` revokes it.
 */
export const updateConglomerateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullish(),
    visibility: conglomerateVisibilitySchema.optional(),
  })
  .strict();
export type UpdateConglomerateRequest = z.infer<typeof updateConglomerateRequestSchema>;

/** One position as submitted by the client — `sortOrder` is derived server-side. */
export const replacePositionInputSchema = z
  .object({
    assetId: z.string().uuid(),
    weightPct: weightPctSchema,
  })
  .strict();
export type ReplacePositionInput = z.infer<typeof replacePositionInputSchema>;

/**
 * `PUT /conglomerates/:id/positions` body — bulk-replace all positions (the
 * Builder autosave, §6.5). 0–50 items; `sortOrder` is assigned from array order.
 */
export const replacePositionsRequestSchema = z
  .object({
    positions: z.array(replacePositionInputSchema).max(50),
  })
  .strict();
export type ReplacePositionsRequest = z.infer<typeof replacePositionsRequestSchema>;

/** Route param for every `/conglomerates/:conglomerateId/…` endpoint. */
export const conglomerateIdParamSchema = z.object({ conglomerateId: z.string().uuid() }).strict();

// --- Allocate (Invest Calculator, §6.7) ------------------------------------

/**
 * `POST /conglomerates/:id/allocate` body — turn a EUR budget into a buy list
 * (§6.7). `budgetEur` is a finite amount ≥ 0; `mode` chooses whole-share vs.
 * fractional buying; `step` is the fractional quantity granularity (e.g. 0.0001)
 * and is ignored in whole mode. `atLeastOneShare` is the opt-in §13.2 V2-P7
 * "at least one share" mode (default OFF / absent; whole mode only, ignored in
 * fractional mode): a position whose weight slice cannot afford one whole share
 * gets exactly one — largest target weight first, never overshooting the
 * budget — and the remainder rebalances across the rest by their weights; a
 * share price above the whole budget stays flagged unbuyable, never forced.
 */
export const allocateRequestSchema = z
  .object({
    budgetEur: z.number().finite().nonnegative(),
    mode: z.enum(['whole', 'fractional']),
    step: z.number().finite().positive().optional(),
    atLeastOneShare: z.boolean().optional(),
  })
  .strict();
export type AllocateRequest = z.infer<typeof allocateRequestSchema>;

/**
 * One buy-list row (§6.7): shares to buy, their EUR cost, and the achieved
 * (`actualPct`) vs. target (`targetPct`) share of the budget with the gap in
 * percentage points (`deltaPp`). `unbuyable`/`note` surface a positive-weight
 * position that cannot be reached within this budget — never silently
 * mis-weighted. Quantities/costs are full precision; the client rounds.
 *
 * `nativePrice`/`currency` carry the asset's own-currency quote (the same
 * price the EUR conversion started from) alongside the EUR-converted
 * `costEur` used for budget accounting — a transaction's `price` is recorded
 * in the asset's native currency (`domain/holdings.ts`), so the bulk buy-flow
 * must prefill from these, not from `costEur`.
 */
export const allocatePositionSchema = z
  .object({
    assetId: z.string().uuid(),
    symbol: z.string(),
    name: z.string(),
    qty: z.number(),
    costEur: z.number(),
    nativePrice: z.number(),
    currency: currencyCodeSchema,
    actualPct: z.number(),
    targetPct: z.number(),
    deltaPp: z.number(),
    unbuyable: z.boolean().optional(),
    note: z.string().optional(),
  })
  .strict();
export type AllocatePosition = z.infer<typeof allocatePositionSchema>;

/**
 * `POST /conglomerates/:id/allocate` response (§6.7). `totalCostEur ≤ budgetEur`
 * always (never overshoot); `leftoverEur` is the un-allocated remainder;
 * `warnings` aggregates the unreachable-weight notes. `stale` flags that at
 * least one quote was served stale (market closed / provider unreachable) with
 * `quoteNotice` carrying the human banner — surfaced, never an error.
 */
export const allocateResponseSchema = z
  .object({
    positions: z.array(allocatePositionSchema),
    totalCostEur: z.number(),
    leftoverEur: z.number(),
    warnings: z.array(z.string()),
    stale: z.boolean(),
    quoteNotice: z.string().nullable(),
  })
  .strict();
export type AllocateResponse = z.infer<typeof allocateResponseSchema>;
