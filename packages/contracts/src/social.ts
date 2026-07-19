import { z } from 'zod';

import { shareAudienceSchema, shareKindSchema } from './common';
import { conglomeratePositionWithAssetSchema, conglomerateStatusSchema } from './conglomerate';
import { currencyCodeSchema } from './market';
import {
  holdingSchema,
  portfolioHistoryPointSchema,
  portfolioHistoryRangeSchema,
  portfolioTotalsSchema,
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

/**
 * Curated set of bundled profile icons (§13.5 V5-P0c). A finite id list — no
 * uploads, no external fetches — so the server can validate against a fixed
 * allow-list and every client resolves the same id to the same SVG. Ids are
 * lower-case identifiers stable across renames; new avatars go at the end of
 * the array so the ordering the picker renders is set here once.
 *
 * A user without a stored choice reads back as `profileIcon: null` on every
 * surface; the SPA renders a deterministic default derived from the user id or
 * username, so no surface goes empty (see the {@link https://github.com/…}
 * Avatar component).
 */
export const PROFILE_ICON_IDS = [
  'astronaut',
  'fox',
  'panda',
  'robot',
  'star',
  'wave',
  'mountain',
  'leaf',
  'flame',
  'bolt',
  'moon',
  'planet',
  'ghost',
  'crown',
  'compass',
  'anchor',
] as const;
export type ProfileIconId = (typeof PROFILE_ICON_IDS)[number];
export const profileIconIdSchema = z.enum(PROFILE_ICON_IDS);

/** Public-safe view of a user in the social graph — never includes email (§6.9). */
export const friendUserSchema = z
  .object({
    id: z.string().uuid(),
    username: z.string(),
    /**
     * The user's chosen curated profile icon id (V5-P0c), or `null` when the
     * user has not picked one. Every surface that already exposes the user
     * carries the icon so the SPA can render the person consistently; the id
     * is public-safe (like id + username), never any bytes. Existing users
     * predating the picker read as `null` — the SPA falls back to a
     * deterministic id-derived default so no surface renders empty.
     *
     * Optional in the schema so pre-V5-P0c test fixtures still parse (server
     * always emits the field; clients are just tolerant when it is missing).
     */
    profileIcon: profileIconIdSchema.nullable().optional(),
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

// --- Follows (person-follow, #438) -------------------------------------------

/**
 * Following a PERSON (#438), distinct from friendship and from per-item sharing:
 * any user may follow any other, one-directional and asymmetric (no accept
 * step). Privacy is enforced purely by the visibility layer — a follow grants no
 * read access; it only opts the follower into `follow.published` news when one of
 * the followed user's portfolios / watchlists / conglomerates becomes newly
 * visible to them (created/switched public, or shared their way).
 */

/**
 * `POST /social/follows` body — the user to follow, by id. Idempotent (a repeat
 * follow never flips existing prefs). `autoFollowItems` (#439, default OFF)
 * opts the follower into auto-bookmarking every item of theirs that becomes
 * newly visible. `notifyOnAlertCreate` / `notifyOnAlertFire` (#455, both default
 * OFF, independent) opt the follower into `follow.alert.created` /
 * `follow.alert.fired` news about the followed person's price alerts — delivered
 * only while the owner shares their alerts with followers (notify-only: nothing
 * is ever copied into the follower's own alert list). All three are also
 * settable later via `PATCH /social/follows/:userId`.
 */
export const followUserRequestSchema = z
  .object({
    userId: z.string().uuid(),
    autoFollowItems: z.boolean().optional(),
    notifyOnAlertCreate: z.boolean().optional(),
    notifyOnAlertFire: z.boolean().optional(),
  })
  .strict();
export type FollowUserRequest = z.infer<typeof followUserRequestSchema>;

/** One entry in a following/followers list — the other party + when the follow formed. */
export const followUserSchema = z
  .object({
    user: friendUserSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type FollowUser = z.infer<typeof followUserSchema>;

/**
 * One entry in the caller's OWN following list — the other party plus the
 * caller's per-followed-person prefs (#439, #455). The prefs never appear on
 * the followers list: they are the follower's private settings.
 *
 * `sharesAlertActivity` (V4-P0b) mirrors the followed person's own
 * "share my alerts with followers" opt-in, so the Friends-tab row expansion can
 * render the alert-follow switches ONLY while the sharer actually exposes their
 * alerts — the switches are notify-only and deliver nothing otherwise.
 */
export const followingEntrySchema = followUserSchema
  .extend({
    autoFollowItems: z.boolean(),
    notifyOnAlertCreate: z.boolean(),
    notifyOnAlertFire: z.boolean(),
    sharesAlertActivity: z.boolean(),
  })
  .strict();
export type FollowingEntry = z.infer<typeof followingEntrySchema>;

/** `GET /social/follows` response — the users the caller follows (with counts). */
export const followingListResponseSchema = z
  .object({
    following: z.array(followingEntrySchema),
    followingCount: z.number().int().nonnegative(),
    followerCount: z.number().int().nonnegative(),
  })
  .strict();
export type FollowingListResponse = z.infer<typeof followingListResponseSchema>;

/**
 * `PATCH /social/follows/:userId` body — update the caller's prefs on one
 * follow (#439, #455): the auto-follow-items toggle and the two independent
 * alert-follow triggers (created-only, fired-only, both, or neither). Fields
 * are optional so future per-follow toggles stay additive; an empty patch is a
 * no-op read. 404s when the caller doesn't follow the user.
 */
export const updateFollowRequestSchema = z
  .object({
    autoFollowItems: z.boolean().optional(),
    notifyOnAlertCreate: z.boolean().optional(),
    notifyOnAlertFire: z.boolean().optional(),
  })
  .strict();
export type UpdateFollowRequest = z.infer<typeof updateFollowRequestSchema>;

/** `GET /social/followers` response — the users who follow the caller. */
export const followersListResponseSchema = z
  .object({ followers: z.array(followUserSchema) })
  .strict();
export type FollowersListResponse = z.infer<typeof followersListResponseSchema>;

// --- Item follows (bookmarks of other people's items, #439) -------------------

/**
 * `POST /social/item-follows` body — bookmark ANOTHER user's visible item.
 * Idempotent. Only an item the caller can currently see (friend-shared to them,
 * or public on a live public profile) is followable — anything else 404s, so
 * the endpoint can't probe private items. Never your own item.
 */
export const itemFollowRequestSchema = z
  .object({ kind: shareKindSchema, subjectId: z.string().uuid() })
  .strict();
export type ItemFollowRequest = z.infer<typeof itemFollowRequestSchema>;

/**
 * How the viewer reaches a followed item — decides the deep link the SPA
 * builds: `friend` → the friend-shared read-only pages, `public` → the owner's
 * public profile.
 */
export const followedItemViaSchema = z.enum(['friend', 'public']);
export type FollowedItemVia = z.infer<typeof followedItemViaSchema>;

/**
 * One followed item in the caller's Following collection (#439). Visibility is
 * re-derived through the audience enforcement layer on EVERY read: an item that
 * was unshared, narrowed away from the caller, or deleted comes back as
 * `viewable: false` with `name`/`owner`/`via` null — the chat-chip precedent —
 * so nothing about it leaks and the row can be unfollowed but not opened.
 */
export const followedItemSchema = z
  .object({
    kind: shareKindSchema,
    subjectId: z.string().uuid(),
    followedAt: z.string().datetime(),
    viewable: z.boolean(),
    name: z.string().nullable(),
    owner: friendUserSchema.nullable(),
    via: followedItemViaSchema.nullable(),
  })
  .strict();
export type FollowedItem = z.infer<typeof followedItemSchema>;

/** `GET /social/item-follows` response — the caller's followed items, newest first. */
export const itemFollowsListResponseSchema = z
  .object({ items: z.array(followedItemSchema) })
  .strict();
export type ItemFollowsListResponse = z.infer<typeof itemFollowsListResponseSchema>;

// --- Shared portfolios (§6.9: "Shared With Me" + "My Shared Items") ----------

/**
 * One friend-shared portfolio as it appears in **Shared With Me** (§6.9): the
 * owner (public-safe — id + username only), the portfolio name, and its current
 * EUR net worth. The summary carries no holdings ledger — the read-only detail
 * view (`GET /social/shared/:portfolioId`) exposes those.
 */
export const sharedPortfolioSummarySchema = z
  .object({
    portfolioId: z.string().uuid(),
    name: z.string(),
    owner: friendUserSchema,
    totalValueEur: z.number(),
    /**
     * Whether the viewer has opted in to activity alerts for this shared item
     * (V3-P6, §14): a per-viewer preference ("notify me when this friend trades
     * here"). Persisted now; the actual friend-activity delivery ships with
     * Notifications-v2 (#368). Defaults to `false`.
     */
    activityAlertsEnabled: z.boolean(),
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
    /** Per-viewer activity-alert opt-in (V3-P6, §14); delivery deferred to #368. */
    activityAlertsEnabled: z.boolean(),
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
    watchlistId: z.string().uuid(),
    name: z.string(),
    owner: friendUserSchema,
    itemCount: z.number().int(),
    /** Per-viewer activity-alert opt-in (V3-P6, §14); delivery deferred to #368. */
    activityAlertsEnabled: z.boolean(),
  })
  .strict();
export type SharedWatchlistSummary = z.infer<typeof sharedWatchlistSummarySchema>;

/**
 * One friend-shared **idea** (a saved Workboard analysis, §13.4 V4-P9) as it
 * appears in **Shared With Me** and the friend-row profile-in-place group. A
 * read-only pointer: the owner (public-safe), the idea's name, and whether it has
 * a thesis note — the state itself is opened (and cloned) via the ideas surface.
 */
export const sharedIdeaSummarySchema = z
  .object({
    ideaId: z.string().uuid(),
    name: z.string(),
    owner: friendUserSchema,
    /** Whether a free-text thesis note is attached (its text is not inlined here). */
    hasThesis: z.boolean(),
    /** Per-viewer activity-alert opt-in (V3-P6, §14); delivery deferred to #368. */
    activityAlertsEnabled: z.boolean(),
  })
  .strict();
export type SharedIdeaSummary = z.infer<typeof sharedIdeaSummarySchema>;

/**
 * `GET /social/shared` response (**Shared With Me**, §6.9 point 4, V2-P9) — every
 * item a friend currently shares with the caller, aggregated across portfolios,
 * conglomerates, watchlists and ideas (V4-P9). Each list is authorization-derived:
 * a row is present only while both an active friendship and the owner's
 * friends-visibility hold at query time, so revoking either instantly drops it.
 */
export const sharedWithMeResponseSchema = z
  .object({
    portfolios: z.array(sharedPortfolioSummarySchema),
    conglomerates: z.array(sharedConglomerateSummarySchema),
    watchlists: z.array(sharedWatchlistSummarySchema),
    ideas: z.array(sharedIdeaSummarySchema),
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
    watchlistId: z.string().uuid(),
    name: z.string(),
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
 * The per-item "who can see this" summary shared by every kind in **My Shared
 * Items** (§6.9, §13.3 V3-P5/P6): the item's current `audience` and, for
 * `specific_friends`, how many friends are named. This is read straight off the
 * single audience model — the same rows the enforcement layer authorizes against
 * — so the summary can never disagree with what is actually shared.
 */
const mySharedAudienceFields = {
  audience: shareAudienceSchema,
  /** Number of named friends — non-zero only for `specific_friends`. */
  friendCount: z.number().int(),
};

/** One of the caller's shared portfolios in **My Shared Items**, with its audience. */
export const mySharedPortfolioSchema = z
  .object({
    portfolioId: z.string().uuid(),
    name: z.string(),
    ...mySharedAudienceFields,
  })
  .strict();
export type MySharedPortfolio = z.infer<typeof mySharedPortfolioSchema>;

/** One of the caller's shared conglomerates in **My Shared Items**, with its audience. */
export const mySharedConglomerateSchema = z
  .object({
    conglomerateId: z.string().uuid(),
    name: z.string(),
    positionCount: z.number().int(),
    ...mySharedAudienceFields,
  })
  .strict();
export type MySharedConglomerate = z.infer<typeof mySharedConglomerateSchema>;

/**
 * The caller's own watchlist sharing state for **My Shared Items** (§6.9, V2-P9):
 * its current audience and how many assets it holds.
 */
export const mySharedWatchlistSchema = z
  .object({
    watchlistId: z.string().uuid(),
    name: z.string(),
    itemCount: z.number().int(),
    ...mySharedAudienceFields,
  })
  .strict();
export type MySharedWatchlist = z.infer<typeof mySharedWatchlistSchema>;

/** One of the caller's saved ideas in **My items** (V4-P9), with its audience. */
export const mySharedIdeaSchema = z
  .object({
    ideaId: z.string().uuid(),
    name: z.string(),
    /** Whether a free-text thesis note is attached. */
    hasThesis: z.boolean(),
    ...mySharedAudienceFields,
  })
  .strict();
export type MySharedIdea = z.infer<typeof mySharedIdeaSchema>;

/**
 * `GET /social/my-shared` response — the caller's unified sharing-management list
 * (the **My items** list, §6.9 point 5, V2-P9/P6; #384). ALL three kinds list in
 * FULL — every portfolio, conglomerate and watchlist the caller owns, shared OR
 * not (#377 did this for portfolios; #384 widened it to conglomerates +
 * watchlists), so each item has a per-item entry point to set its audience; a
 * never-shared item simply reads `audience: 'private'`. Everything is private by
 * default. Each row carries the per-item "who can see this" summary; sharing is
 * changed in place through the reusable AudiencePicker
 * (`PUT /social/audience/:kind/:subjectId`).
 */
export const mySharedResponseSchema = z
  .object({
    portfolios: z.array(mySharedPortfolioSchema),
    conglomerates: z.array(mySharedConglomerateSchema),
    watchlists: z.array(mySharedWatchlistSchema),
    ideas: z.array(mySharedIdeaSchema),
  })
  .strict();
export type MySharedResponse = z.infer<typeof mySharedResponseSchema>;

// --- Audience model (V3-P5): one picker + one enforcement layer --------------

/**
 * Live public-link status for one audience. Storage is **hash-only** (§14), so
 * the raw URL is shown exactly once at creation and can never be re-read — the
 * owner sees only whether a link is currently `active` and when it was minted.
 */
export const shareLinkStateSchema = z
  .object({ active: z.boolean(), createdAt: z.string().datetime().nullable() })
  .strict();
export type ShareLinkState = z.infer<typeof shareLinkStateSchema>;

/**
 * `GET /social/audience/:kind/:subjectId` — the owner's current audience for one
 * shareable item, feeding the reusable AudiencePicker. `friendIds` is populated
 * only for `specific_friends`.
 */
export const audienceStateSchema = z
  .object({
    kind: shareKindSchema,
    subjectId: z.string().uuid(),
    audience: shareAudienceSchema,
    friendIds: z.array(z.string().uuid()),
    link: shareLinkStateSchema,
  })
  .strict();
export type AudienceState = z.infer<typeof audienceStateSchema>;

/**
 * `PUT /social/audience/:kind/:subjectId` body. `friendIds` is honoured only for
 * `specific_friends`. `acknowledgePublic` MUST be `true` to select `public_link`
 * — the §16 explicit-acknowledgment gate, enforced server-side as well as in the
 * picker: the confirm cannot submit ("anyone with the link sees your holdings and
 * net worth") without it.
 */
export const setAudienceRequestSchema = z
  .object({
    audience: shareAudienceSchema,
    friendIds: z.array(z.string().uuid()).max(1000).optional(),
    acknowledgePublic: z.boolean().optional(),
  })
  .strict();
export type SetAudienceRequest = z.infer<typeof setAudienceRequestSchema>;

/**
 * The raw public link, returned EXACTLY ONCE when a `public_link` audience is
 * created (hash-only storage, §14). `url` is the relative resolution path
 * (`/api/v1/social/links/:token`); the SPA composes the shareable absolute URL.
 */
export const shareLinkSecretSchema = z.object({ token: z.string(), url: z.string() }).strict();
export type ShareLinkSecret = z.infer<typeof shareLinkSecretSchema>;

/** `PUT /social/audience/:kind/:subjectId` response — new state, plus the link secret once on mint. */
export const audienceMutationResponseSchema = z
  .object({ state: audienceStateSchema, link: shareLinkSecretSchema.optional() })
  .strict();
export type AudienceMutationResponse = z.infer<typeof audienceMutationResponseSchema>;

/** Route params for the unified audience endpoints. */
export const audienceParamSchema = z
  .object({ kind: shareKindSchema, subjectId: z.string().uuid() })
  .strict();
export type AudienceParam = z.infer<typeof audienceParamSchema>;

/**
 * `GET /social/links/:token` — the UNAUTHENTICATED public-link read view (§14).
 * A live token resolves to the kind-specific read-only shape; a revoked/unknown
 * token — or one whose owner narrowed the audience away from `public_link` — is a
 * plain 404, so nothing about the item's existence leaks.
 */
export const sharedLinkResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('portfolio'), portfolio: sharedPortfolioDetailResponseSchema })
    .strict(),
  z
    .object({
      kind: z.literal('conglomerate'),
      conglomerate: sharedConglomerateDetailResponseSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal('watchlist'), watchlist: sharedWatchlistDetailResponseSchema })
    .strict(),
]);
export type SharedLinkResponse = z.infer<typeof sharedLinkResponseSchema>;

// --- Per-shared-item activity alerts (V3-P6): a viewer-side preference ---------

/**
 * `PUT /social/shared/activity/:kind/:subjectId` body — the viewer's opt-in for
 * activity alerts on one item a friend shares with them ("notify me when this
 * friend trades / adds a watchlist item"). Only the **preference** is stored now;
 * the friend-activity events + delivery are Notifications-v2 (#368). Setting a
 * pref requires the viewer still be authorized to read the item (enforcement
 * layer) — otherwise a plain 404, so it can't be used to probe a private item.
 */
export const setActivityAlertRequestSchema = z.object({ enabled: z.boolean() }).strict();
export type SetActivityAlertRequest = z.infer<typeof setActivityAlertRequestSchema>;

/** `PUT /social/shared/activity/:kind/:subjectId` response — the stored pref. */
export const activityAlertStateSchema = z
  .object({ kind: shareKindSchema, subjectId: z.string().uuid(), enabled: z.boolean() })
  .strict();
export type ActivityAlertState = z.infer<typeof activityAlertStateSchema>;

// --- Public profiles (V3-P6, §14) --------------------------------------------

/**
 * The owner-facing state of one's own public profile (`GET /social/profile`): the
 * opt-in flag, the optional bio line, the username slug the profile lives at, and
 * how many of the caller's items are currently `public_link` (what the profile
 * would show). A disabled profile 404s for logged-out visitors instantly.
 */
export const profileSettingsResponseSchema = z
  .object({
    username: z.string(),
    isPublic: z.boolean(),
    bio: z.string().nullable(),
    publicItemCount: z.number().int(),
    /**
     * The caller's chosen curated profile icon id (V5-P0c) or `null` for a
     * never-picked account. The picker in the profile-settings surface writes
     * this via {@link updateProfileSettingsRequestSchema}. Optional for the same
     * reason as {@link friendUserSchema} — server always emits, schema tolerates
     * omission from older test fixtures.
     */
    profileIcon: profileIconIdSchema.nullable().optional(),
  })
  .strict();
export type ProfileSettingsResponse = z.infer<typeof profileSettingsResponseSchema>;

/** The maximum length of a public-profile bio line. */
export const PROFILE_BIO_MAX = 280;

/**
 * `PUT /social/profile` body. Enabling the profile (`isPublic: true`) requires an
 * explicit `acknowledgePublic: true` — the §16 friction ladder, mirrored
 * server-side: a public profile shows anyone the items you've made public. Turning
 * it off unpublishes the page instantly (the slug 404s). `bio` is trimmed and
 * capped at {@link PROFILE_BIO_MAX}; `null`/empty clears it.
 */
export const updateProfileSettingsRequestSchema = z
  .object({
    isPublic: z.boolean(),
    bio: z.string().max(PROFILE_BIO_MAX).nullable().optional(),
    acknowledgePublic: z.boolean().optional(),
    /**
     * The picked profile icon id (V5-P0c). A valid id from
     * {@link PROFILE_ICON_IDS} sets it; `null` clears it back to the
     * default; omitting the field leaves the current choice untouched. The
     * server rejects any unknown id.
     */
    profileIcon: profileIconIdSchema.nullable().optional(),
  })
  .strict();
export type UpdateProfileSettingsRequest = z.infer<typeof updateProfileSettingsRequestSchema>;

/** One public item as it appears on a profile — kind, id and a headline stat. */
export const publicProfilePortfolioSchema = z
  .object({ portfolioId: z.string().uuid(), name: z.string(), totalValueEur: z.number() })
  .strict();
export type PublicProfilePortfolio = z.infer<typeof publicProfilePortfolioSchema>;

export const publicProfileConglomerateSchema = z
  .object({
    conglomerateId: z.string().uuid(),
    name: z.string(),
    positionCount: z.number().int(),
  })
  .strict();
export type PublicProfileConglomerate = z.infer<typeof publicProfileConglomerateSchema>;

export const publicProfileWatchlistSchema = z
  .object({ watchlistId: z.string().uuid(), name: z.string(), itemCount: z.number().int() })
  .strict();
export type PublicProfileWatchlist = z.infer<typeof publicProfileWatchlistSchema>;

/**
 * `GET /social/profiles/:username` — the UNAUTHENTICATED public-profile view
 * (V3-P6, §14). Composes ONLY the owner's items whose audience is `public_link`
 * (the same rung the enforcement layer treats as public) plus the bio. A profile
 * that is not opted-in, or an unknown/inactive user, is a plain 404 — no leak, and
 * a non-public item can never appear here because the composition filters on the
 * audience model itself.
 */
export const publicProfileResponseSchema = z
  .object({
    /** The owner's id — public-safe (like {@link friendUserSchema}), so a logged-in
     *  visitor can follow the person from their profile (#438). */
    userId: z.string().uuid(),
    username: z.string(),
    bio: z.string().nullable(),
    /**
     * The owner's chosen curated profile icon id (V5-P0c) or `null`. Public-safe
     * (like id + username), never exposes bytes — the SVG lives in the client.
     * Optional in the schema for the same reason as {@link friendUserSchema} —
     * the server always emits it; the field stays parse-tolerant.
     */
    profileIcon: profileIconIdSchema.nullable().optional(),
    /** How many people follow this user (#438) — viewer-independent public info. */
    followerCount: z.number().int().nonnegative(),
    portfolios: z.array(publicProfilePortfolioSchema),
    conglomerates: z.array(publicProfileConglomerateSchema),
    watchlists: z.array(publicProfileWatchlistSchema),
  })
  .strict();
export type PublicProfileResponse = z.infer<typeof publicProfileResponseSchema>;

/** Route params for the public-profile read: a username slug. */
export const profileUsernameParamSchema = z
  .object({ username: z.string().min(1).max(40) })
  .strict();
export type ProfileUsernameParam = z.infer<typeof profileUsernameParamSchema>;

/**
 * Route params for the public-profile item drill-in
 * (`GET /social/profiles/:username/:kind/:subjectId`) — a logged-out visitor
 * opening one public item's read-only detail. Resolved through the SAME
 * `public_link` audience check as the profile listing, so a non-public item 404s.
 */
export const profileItemParamSchema = z
  .object({
    username: z.string().min(1).max(40),
    kind: shareKindSchema,
    subjectId: z.string().uuid(),
  })
  .strict();
export type ProfileItemParam = z.infer<typeof profileItemParamSchema>;

// --- Comments + reactions on shared items (§13.5 V5-P8) ----------------------

/**
 * The curated reaction set (§13.5 V5-P8, planner decision 2026-07-17): a fixed
 * six, no free emoji input. The contract rejects anything outside this set, so
 * the server never persists an arbitrary code point — the same set applies to
 * reactions on an item and on a comment.
 */
export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '🤔', '😂', '🔥'] as const;
export const reactionEmojiSchema = z.enum(REACTION_EMOJIS);
export type ReactionEmoji = z.infer<typeof reactionEmojiSchema>;

/** Max length of one comment body. */
export const COMMENT_BODY_MAX = 2000;

/**
 * One emoji's aggregate on a target (an item or a comment): how many people
 * reacted with it, and whether the viewer is one of them. Only emojis with a
 * non-zero count appear; `reacted` drives the toggle affordance.
 */
export const reactionSummarySchema = z
  .object({
    emoji: reactionEmojiSchema,
    count: z.number().int().nonnegative(),
    reacted: z.boolean(),
  })
  .strict();
export type ReactionSummary = z.infer<typeof reactionSummarySchema>;

/**
 * One comment in a shared item's thread. `author` is the public-safe user shape
 * (never an email). `canDelete` is true when the viewer may remove it — its own
 * author, or the item owner who moderates every comment (§13.5 V5-P8). A
 * soft-deleted comment is never rendered, so it simply never appears here.
 */
export const itemCommentSchema = z
  .object({
    id: z.string().uuid(),
    author: friendUserSchema,
    body: z.string(),
    createdAt: z.string().datetime(),
    canDelete: z.boolean(),
    reactions: z.array(reactionSummarySchema),
  })
  .strict();
export type ItemComment = z.infer<typeof itemCommentSchema>;

/**
 * A shared item's full comment thread plus its item-level reaction aggregate.
 * Returned ONLY to a viewer the item's current audience admits (a friend the
 * owner shares with) or the owner — the exact same audience the read view uses,
 * fail-closed. A public link stays read-only and never reaches this (§16). The
 * SPA keeps the comment list collapsed to `commentCount` until expanded
 * (anti-bloat), while the reaction chips stay compactly visible.
 */
export const commentThreadResponseSchema = z
  .object({
    kind: shareKindSchema,
    subjectId: z.string().uuid(),
    commentCount: z.number().int().nonnegative(),
    comments: z.array(itemCommentSchema),
    reactions: z.array(reactionSummarySchema),
  })
  .strict();
export type CommentThreadResponse = z.infer<typeof commentThreadResponseSchema>;

/** `POST …/comments` body — post one comment. Trimmed, non-empty, length-bounded. */
export const createCommentRequestSchema = z
  .object({ body: z.string().trim().min(1).max(COMMENT_BODY_MAX) })
  .strict();
export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;

/** Response of posting a comment — the created comment (with an empty reaction set). */
export const createCommentResponseSchema = itemCommentSchema;
export type CreateCommentResponse = z.infer<typeof createCommentResponseSchema>;

/** `POST …/reactions` body — toggle one curated emoji on the target. */
export const toggleReactionRequestSchema = z.object({ emoji: reactionEmojiSchema }).strict();
export type ToggleReactionRequest = z.infer<typeof toggleReactionRequestSchema>;

/** Response of a reaction toggle — the target's fresh aggregate. */
export const reactionListResponseSchema = z
  .object({ reactions: z.array(reactionSummarySchema) })
  .strict();
export type ReactionListResponse = z.infer<typeof reactionListResponseSchema>;

/** Route params for a single comment (delete / react on it). */
export const commentIdParamSchema = z.object({ commentId: z.string().uuid() }).strict();
export type CommentIdParam = z.infer<typeof commentIdParamSchema>;
