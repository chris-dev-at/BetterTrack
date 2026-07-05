import { z } from 'zod';

import {
  conglomeratePositionWithAssetSchema,
  conglomerateStatusSchema,
  conglomerateSummarySchema,
} from './conglomerate';
import { currencyCodeSchema } from './market';
import {
  holdingSchema,
  portfolioHistoryPointSchema,
  portfolioHistoryRangeSchema,
  portfolioSummarySchema,
  portfolioTotalsSchema,
  portfolioVisibilitySchema,
} from './portfolio';
import { workboardItemSchema } from './workboard';

/**
 * Social contracts (PROJECTPLAN.md §6.9). Friend requests + friendships.
 *
 * Privacy: `FriendUser` is the only user shape ever returned by a social
 * endpoint and carries **id + username only** — email is an input identifier
 * (§6.9 "username or email"), never echoed back. Request creation reveals
 * nothing about whether the target exists (no-enumeration is enforced in the
 * service layer, a later P5 package).
 */

/** Lifecycle of a friend request (§5.5). */
export const FRIEND_REQUEST_STATUSES = ['pending', 'accepted', 'declined', 'cancelled'] as const;
export const friendRequestStatusSchema = z.enum(FRIEND_REQUEST_STATUSES);
export type FriendRequestStatus = z.infer<typeof friendRequestStatusSchema>;

/** Whether a pending request was received by (`incoming`) or sent by (`outgoing`) the viewer. */
export const friendRequestDirectionSchema = z.enum(['incoming', 'outgoing']);
export type FriendRequestDirection = z.infer<typeof friendRequestDirectionSchema>;

/** Public-safe view of a user in the social graph — never includes email (§6.9). */
export const friendUserSchema = z
  .object({
    id: z.string().uuid(),
    username: z.string(),
  })
  .strict();
export type FriendUser = z.infer<typeof friendUserSchema>;

/**
 * A friend request as seen by the viewer. `direction` tells the viewer whether
 * they received or sent it; `user` is the *other* party (sender for incoming,
 * recipient for outgoing).
 */
export const friendRequestSchema = z
  .object({
    id: z.string().uuid(),
    direction: friendRequestDirectionSchema,
    status: friendRequestStatusSchema,
    user: friendUserSchema,
    createdAt: z.string().datetime(),
    respondedAt: z.string().datetime().nullable(),
  })
  .strict();
export type FriendRequest = z.infer<typeof friendRequestSchema>;

/** An established friendship as seen by the viewer — the other party + when it formed. */
export const friendshipSchema = z
  .object({
    user: friendUserSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type Friendship = z.infer<typeof friendshipSchema>;

/**
 * `POST /social/requests` body — the target by username or email (§6.9). A
 * single free-form identifier; the service resolves and never enumerates.
 */
export const createFriendRequestRequestSchema = z
  .object({ identifier: z.string().min(1).max(320) })
  .strict();
export type CreateFriendRequestRequest = z.infer<typeof createFriendRequestRequestSchema>;

/** `GET /social/requests` response — pending requests split by direction. */
export const friendRequestListResponseSchema = z
  .object({
    incoming: z.array(friendRequestSchema),
    outgoing: z.array(friendRequestSchema),
  })
  .strict();
export type FriendRequestListResponse = z.infer<typeof friendRequestListResponseSchema>;

/** `GET /social/friends` response. */
export const friendsListResponseSchema = z.object({ friends: z.array(friendshipSchema) }).strict();
export type FriendsListResponse = z.infer<typeof friendsListResponseSchema>;

// --- Shared portfolios (§6.9: "Shared With Me" + "My Shared Items") ----------

/**
 * One friend-shared portfolio as it appears in **Shared With Me** (§6.9): the
 * owner (public-safe — id + username only), the portfolio name, and its current
 * EUR total value. The summary carries no holdings ledger — the read-only detail
 * view (`GET /social/shared/:portfolioId`) exposes those.
 */
export const sharedPortfolioSummarySchema = z
  .object({
    portfolioId: z.string().uuid(),
    name: z.string(),
    owner: friendUserSchema,
    totalValueEur: z.number(),
  })
  .strict();
export type SharedPortfolioSummary = z.infer<typeof sharedPortfolioSummarySchema>;

// --- Shared conglomerates & watchlists (§13.2 V2-P9) -------------------------

/**
 * One friend-shared **conglomerate** as it appears in **Shared With Me** (§6.9,
 * V2-P9): the owner (public-safe), the basket's name, its status and position
 * count. The read-only detail (`GET /social/shared/conglomerates/:id`) exposes
 * the positions themselves.
 */
export const sharedConglomerateSummarySchema = z
  .object({
    conglomerateId: z.string().uuid(),
    name: z.string(),
    owner: friendUserSchema,
    status: conglomerateStatusSchema,
    positionCount: z.number().int(),
  })
  .strict();
export type SharedConglomerateSummary = z.infer<typeof sharedConglomerateSummarySchema>;

/**
 * One friend's shared **watchlist** as it appears in **Shared With Me** (§6.9,
 * V2-P9). A watchlist is shared all-or-nothing per owner, so the summary is just
 * the owner (public-safe) plus how many assets they watch; the read-only detail
 * (`GET /social/shared/watchlists/:userId`) exposes the items.
 */
export const sharedWatchlistSummarySchema = z
  .object({
    owner: friendUserSchema,
    itemCount: z.number().int(),
  })
  .strict();
export type SharedWatchlistSummary = z.infer<typeof sharedWatchlistSummarySchema>;

/**
 * `GET /social/shared` response (**Shared With Me**, §6.9 point 4, V2-P9) — every
 * item a friend currently shares with the caller, aggregated across portfolios,
 * conglomerates and watchlists. Each list is authorization-derived: a row is
 * present only while both an active friendship and the owner's friends-visibility
 * hold at query time, so revoking either instantly drops it.
 */
export const sharedWithMeResponseSchema = z
  .object({
    portfolios: z.array(sharedPortfolioSummarySchema),
    conglomerates: z.array(sharedConglomerateSummarySchema),
    watchlists: z.array(sharedWatchlistSummarySchema),
  })
  .strict();
export type SharedWithMeResponse = z.infer<typeof sharedWithMeResponseSchema>;

/**
 * `GET /social/shared/conglomerates/:conglomerateId` response — a **read-only**
 * mirror of a friend's conglomerate (§6.9, V2-P9): its positions with the embedded
 * asset identity, exactly as the owner sees them, with no edit affordance. A
 * non-friend / private / unknown id 404s (never 403), recomputed per request.
 */
export const sharedConglomerateDetailResponseSchema = z
  .object({
    conglomerateId: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    status: conglomerateStatusSchema,
    owner: friendUserSchema,
    positions: z.array(conglomeratePositionWithAssetSchema),
  })
  .strict();
export type SharedConglomerateDetailResponse = z.infer<
  typeof sharedConglomerateDetailResponseSchema
>;

/**
 * `GET /social/shared/watchlists/:userId` response — a **read-only** mirror of a
 * friend's watchlist (§6.9, V2-P9): the owner plus their watched items (asset
 * identity + note), with no edit affordance. Non-friend / not-sharing / unknown
 * owner 404s (never 403), recomputed per request.
 */
export const sharedWatchlistDetailResponseSchema = z
  .object({
    owner: friendUserSchema,
    items: z.array(workboardItemSchema),
  })
  .strict();
export type SharedWatchlistDetailResponse = z.infer<typeof sharedWatchlistDetailResponseSchema>;

/**
 * `GET /social/shared/:portfolioId` response — a **read-only** mirror of the
 * owner's overview (§6.9): totals, holdings and the performance-chart series,
 * reusing the exact portfolio contract pieces so a friend sees the same blocks
 * the owner does. There is no transaction ledger and no edit affordance in this
 * shape — a friend view is strictly read-only.
 */
export const sharedPortfolioDetailResponseSchema = z
  .object({
    portfolioId: z.string().uuid(),
    name: z.string(),
    owner: friendUserSchema,
    baseCurrency: currencyCodeSchema,
    totals: portfolioTotalsSchema,
    holdings: z.array(holdingSchema),
    history: z
      .object({
        range: portfolioHistoryRangeSchema,
        points: z.array(portfolioHistoryPointSchema),
      })
      .strict(),
  })
  .strict();
export type SharedPortfolioDetailResponse = z.infer<typeof sharedPortfolioDetailResponseSchema>;

/**
 * The caller's own watchlist sharing state for **My Shared Items** (§6.9, V2-P9):
 * whether it is currently shared with friends and how many assets it holds.
 * Toggling it off is done via `PATCH /workboard/sharing` (no mutation on the
 * social surface).
 */
export const mySharedWatchlistSchema = z
  .object({
    visibility: portfolioVisibilitySchema,
    itemCount: z.number().int(),
  })
  .strict();
export type MySharedWatchlist = z.infer<typeof mySharedWatchlistSchema>;

/**
 * `GET /social/my-shared` response — everything the caller is *currently* sharing
 * with friends (the **My Shared Items** toggle-off list, §6.9 point 5, V2-P9):
 * their `visibility=friends` portfolios and conglomerates plus their watchlist
 * sharing state. Each item is toggled off through its own surface's existing PATCH
 * (`/portfolios/:id`, `/conglomerates/:id`, `/workboard/sharing`) — there is no
 * mutation on the social surface.
 */
export const mySharedResponseSchema = z
  .object({
    portfolios: z.array(portfolioSummarySchema),
    conglomerates: z.array(conglomerateSummarySchema),
    watchlist: mySharedWatchlistSchema,
  })
  .strict();
export type MySharedResponse = z.infer<typeof mySharedResponseSchema>;
