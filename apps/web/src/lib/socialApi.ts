import {
  activityAlertStateSchema,
  audienceMutationResponseSchema,
  audienceStateSchema,
  followersListResponseSchema,
  followingEntrySchema,
  commentThreadResponseSchema,
  createCommentResponseSchema,
  followingListResponseSchema,
  friendGroupListResponseSchema,
  friendGroupSchema,
  friendRequestListResponseSchema,
  itemFollowsListResponseSchema,
  friendsListResponseSchema,
  mySharedResponseSchema,
  okResponseSchema,
  reactionListResponseSchema,
  profileSettingsResponseSchema,
  publicProfileResponseSchema,
  sharedConglomerateDetailResponseSchema,
  sharedLinkResponseSchema,
  sharedPortfolioDetailResponseSchema,
  sharedWatchlistDetailResponseSchema,
  sharedWithMeResponseSchema,
  type ActivityAlertState,
  type AudienceMutationResponse,
  type AudienceState,
  type CommentThreadResponse,
  type CreateCommentResponse,
  type CreateFriendRequestRequest,
  type ReactionEmoji,
  type ReactionListResponse,
  type FollowersListResponse,
  type FollowingEntry,
  type FollowingListResponse,
  type FriendGroup,
  type FriendGroupListResponse,
  type FriendRequestListResponse,
  type ItemFollowsListResponse,
  type FriendsListResponse,
  type MySharedResponse,
  type ProfileSettingsResponse,
  type PublicProfileResponse,
  type SetAudienceRequest,
  type ShareKind,
  type SharedConglomerateDetailResponse,
  type SharedLinkResponse,
  type SharedPortfolioDetailResponse,
  type SharedWatchlistDetailResponse,
  type SharedWithMeResponse,
  type UpdateProfileSettingsRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the friend-request + friendship surface (PROJECTPLAN.md
 * §6.9), mirroring `conglomerateApi.ts` / `portfolioApi.ts`.
 */

/**
 * `POST /social/requests` — request a friend by username or email. Always
 * resolves the same way whether or not the target exists (no-enumeration is
 * enforced server-side); this client never surfaces a "user not found" case.
 */
export async function sendFriendRequest(body: CreateFriendRequestRequest): Promise<void> {
  const data = await apiRequest<unknown>('/social/requests', { method: 'POST', body });
  okResponseSchema.parse(data);
}

/** `GET /social/requests` — the caller's pending requests, split by direction. */
export async function listFriendRequests(signal?: AbortSignal): Promise<FriendRequestListResponse> {
  const data = await apiRequest<unknown>('/social/requests', { signal });
  return friendRequestListResponseSchema.parse(data);
}

/** `POST /social/requests/:id/accept` — recipient accepts → forms a friendship. */
export async function acceptFriendRequest(id: string): Promise<void> {
  const data = await apiRequest<unknown>(`/social/requests/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
  });
  okResponseSchema.parse(data);
}

/** `POST /social/requests/:id/decline` — recipient declines (terminal). */
export async function declineFriendRequest(id: string): Promise<void> {
  const data = await apiRequest<unknown>(`/social/requests/${encodeURIComponent(id)}/decline`, {
    method: 'POST',
  });
  okResponseSchema.parse(data);
}

/** `POST /social/requests/:id/cancel` — sender withdraws their pending request. */
export async function cancelFriendRequest(id: string): Promise<void> {
  const data = await apiRequest<unknown>(`/social/requests/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
  okResponseSchema.parse(data);
}

/** `GET /social/friends` — the caller's friends. */
export async function listFriends(signal?: AbortSignal): Promise<FriendsListResponse> {
  const data = await apiRequest<unknown>('/social/friends', { signal });
  return friendsListResponseSchema.parse(data);
}

/** `DELETE /social/friends/:userId` — remove a friendship (either side may). */
export async function removeFriend(userId: string): Promise<void> {
  await apiRequest<unknown>(`/social/friends/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

// ── Friend groups (V5-P8): named circles usable as a sharing audience ─────────

/** `GET /social/groups` — the caller's own friend groups with live rosters. */
export async function listGroups(signal?: AbortSignal): Promise<FriendGroupListResponse> {
  const data = await apiRequest<unknown>('/social/groups', { signal });
  return friendGroupListResponseSchema.parse(data);
}

/** `POST /social/groups` — create an empty named group. */
export async function createGroup(name: string): Promise<FriendGroup> {
  const data = await apiRequest<unknown>('/social/groups', { method: 'POST', body: { name } });
  return friendGroupSchema.parse(data);
}

/** `PATCH /social/groups/:groupId` — rename a group. */
export async function renameGroup(groupId: string, name: string): Promise<FriendGroup> {
  const data = await apiRequest<unknown>(`/social/groups/${encodeURIComponent(groupId)}`, {
    method: 'PATCH',
    body: { name },
  });
  return friendGroupSchema.parse(data);
}

/** `DELETE /social/groups/:groupId` — delete a group (its shares go dark). */
export async function deleteGroup(groupId: string): Promise<void> {
  await apiRequest<unknown>(`/social/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
}

/** `POST /social/groups/:groupId/members` — add an accepted friend to a group. */
export async function addGroupMember(groupId: string, userId: string): Promise<FriendGroup> {
  const data = await apiRequest<unknown>(`/social/groups/${encodeURIComponent(groupId)}/members`, {
    method: 'POST',
    body: { userId },
  });
  return friendGroupSchema.parse(data);
}

/** `DELETE /social/groups/:groupId/members/:userId` — remove a member. */
export async function removeGroupMember(groupId: string, userId: string): Promise<FriendGroup> {
  const data = await apiRequest<unknown>(
    `/social/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
  return friendGroupSchema.parse(data);
}

/**
 * `POST /social/follows` — follow a person (#438). Idempotent server-side.
 * `autoFollowItems` (#439) opts into auto-bookmarking their newly-visible items
 * right at follow time (default OFF; a repeat follow never flips the pref).
 */
export async function followUser(userId: string, autoFollowItems?: boolean): Promise<void> {
  const data = await apiRequest<unknown>('/social/follows', {
    method: 'POST',
    body: autoFollowItems === undefined ? { userId } : { userId, autoFollowItems },
  });
  okResponseSchema.parse(data);
}

/**
 * `PATCH /social/follows/:userId` — update per-follow prefs: auto-follow items
 * (#439) and the two independent alert-follow triggers (#455).
 */
export async function updateFollow(
  userId: string,
  patch: {
    autoFollowItems?: boolean;
    notifyOnAlertCreate?: boolean;
    notifyOnAlertFire?: boolean;
  },
): Promise<FollowingEntry> {
  const data = await apiRequest<unknown>(`/social/follows/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: patch,
  });
  return followingEntrySchema.parse(data);
}

/** `POST /social/item-follows` — bookmark another user's visible item (#439). Idempotent. */
export async function followItem(kind: ShareKind, subjectId: string): Promise<void> {
  const data = await apiRequest<unknown>('/social/item-follows', {
    method: 'POST',
    body: { kind, subjectId },
  });
  okResponseSchema.parse(data);
}

/** `DELETE /social/item-follows/:kind/:subjectId` — remove an item bookmark (#439). */
export async function unfollowItem(kind: ShareKind, subjectId: string): Promise<void> {
  await apiRequest<unknown>(
    `/social/item-follows/${encodeURIComponent(kind)}/${encodeURIComponent(subjectId)}`,
    { method: 'DELETE' },
  );
}

/** `GET /social/item-follows` — the caller's followed items (#439), newest first. */
export async function listItemFollows(signal?: AbortSignal): Promise<ItemFollowsListResponse> {
  const data = await apiRequest<unknown>('/social/item-follows', { signal });
  return itemFollowsListResponseSchema.parse(data);
}

/** `DELETE /social/follows/:userId` — unfollow a person; stops their news (#438). */
export async function unfollowUser(userId: string): Promise<void> {
  await apiRequest<unknown>(`/social/follows/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

/** `GET /social/follows` — the users the caller follows, with counts (#438). */
export async function listFollowing(signal?: AbortSignal): Promise<FollowingListResponse> {
  const data = await apiRequest<unknown>('/social/follows', { signal });
  return followingListResponseSchema.parse(data);
}

/** `GET /social/followers` — the users who follow the caller (#438). */
export async function listFollowers(signal?: AbortSignal): Promise<FollowersListResponse> {
  const data = await apiRequest<unknown>('/social/followers', { signal });
  return followersListResponseSchema.parse(data);
}

/**
 * `GET /social/shared` — everything my friends share with me: portfolios,
 * conglomerates and watchlists (§6.9, V2-P9).
 */
export async function listSharedWithMe(signal?: AbortSignal): Promise<SharedWithMeResponse> {
  const data = await apiRequest<unknown>('/social/shared', { signal });
  return sharedWithMeResponseSchema.parse(data);
}

/**
 * `GET /social/shared/:portfolioId` — read-only overview of one friend-shared
 * portfolio (totals, holdings, performance history). 404s for a non-friend,
 * private, or unknown portfolio.
 */
export async function getSharedPortfolio(
  portfolioId: string,
  signal?: AbortSignal,
): Promise<SharedPortfolioDetailResponse> {
  const data = await apiRequest<unknown>(`/social/shared/${encodeURIComponent(portfolioId)}`, {
    signal,
  });
  return sharedPortfolioDetailResponseSchema.parse(data);
}

/**
 * `GET /social/shared/conglomerates/:id` — read-only view of one friend-shared
 * conglomerate (positions + asset identity). 404s for a non-friend / private /
 * unknown basket (§6.9, V2-P9).
 */
export async function getSharedConglomerate(
  conglomerateId: string,
  signal?: AbortSignal,
): Promise<SharedConglomerateDetailResponse> {
  const data = await apiRequest<unknown>(
    `/social/shared/conglomerates/${encodeURIComponent(conglomerateId)}`,
    { signal },
  );
  return sharedConglomerateDetailResponseSchema.parse(data);
}

/**
 * `GET /social/shared/watchlists/:watchlistId` — read-only view of one friend's
 * shared named watchlist. 404s for a non-friend / not-shared / unknown list (§6.9).
 */
export async function getSharedWatchlist(
  watchlistId: string,
  signal?: AbortSignal,
): Promise<SharedWatchlistDetailResponse> {
  const data = await apiRequest<unknown>(
    `/social/shared/watchlists/${encodeURIComponent(watchlistId)}`,
    { signal },
  );
  return sharedWatchlistDetailResponseSchema.parse(data);
}

// --- Audiences (V3-P5): the reusable AudiencePicker's backend ----------------

/** `GET /social/audience/:kind/:subjectId` — the owner's audience for one subject. */
export async function getAudience(
  kind: ShareKind,
  subjectId: string,
  signal?: AbortSignal,
): Promise<AudienceState> {
  const data = await apiRequest<unknown>(
    `/social/audience/${kind}/${encodeURIComponent(subjectId)}`,
    { signal },
  );
  return audienceStateSchema.parse(data);
}

/**
 * `PUT /social/audience/:kind/:subjectId` — set a subject's audience. Selecting
 * `public_link` requires `acknowledgePublic: true` (§16); minting one returns the
 * raw token EXACTLY ONCE in `link` (hash-only storage server-side).
 */
export async function setAudience(
  kind: ShareKind,
  subjectId: string,
  body: SetAudienceRequest,
): Promise<AudienceMutationResponse> {
  const data = await apiRequest<unknown>(
    `/social/audience/${kind}/${encodeURIComponent(subjectId)}`,
    { method: 'PUT', body },
  );
  return audienceMutationResponseSchema.parse(data);
}

/**
 * `GET /social/links/:token` — resolve a public share link to its live read-only
 * view. UNAUTHENTICATED (works logged-out); a revoked/unknown token 404s.
 */
export async function resolveShareLink(
  token: string,
  signal?: AbortSignal,
): Promise<SharedLinkResponse> {
  const data = await apiRequest<unknown>(`/social/links/${encodeURIComponent(token)}`, { signal });
  return sharedLinkResponseSchema.parse(data);
}

/**
 * `GET /social/my-shared` — everything I currently share with friends:
 * portfolios, conglomerates and my watchlist state (§6.9, V2-P9).
 */
export async function listMyShared(signal?: AbortSignal): Promise<MySharedResponse> {
  const data = await apiRequest<unknown>('/social/my-shared', { signal });
  return mySharedResponseSchema.parse(data);
}

// --- Activity alerts (V3-P6): a per-viewer preference on a shared item --------

/**
 * `PUT /social/shared/activity/:kind/:subjectId` — set my activity-alert opt-in
 * for one item a friend shares with me. Only the preference is stored; the
 * friend-activity delivery ships with Notifications-v2 (#368). 404s if I can no
 * longer read the item.
 */
export async function setActivityAlert(
  kind: ShareKind,
  subjectId: string,
  enabled: boolean,
): Promise<ActivityAlertState> {
  const data = await apiRequest<unknown>(
    `/social/shared/activity/${kind}/${encodeURIComponent(subjectId)}`,
    { method: 'PUT', body: { enabled } },
  );
  return activityAlertStateSchema.parse(data);
}

// --- Public profiles (V3-P6) -------------------------------------------------

/** `GET /social/profile` — my own public-profile settings. */
export async function getProfileSettings(signal?: AbortSignal): Promise<ProfileSettingsResponse> {
  const data = await apiRequest<unknown>('/social/profile', { signal });
  return profileSettingsResponseSchema.parse(data);
}

/**
 * `PUT /social/profile` — update my public-profile opt-in + bio. Enabling requires
 * `acknowledgePublic: true`; disabling unpublishes the slug instantly.
 */
export async function updateProfileSettings(
  body: UpdateProfileSettingsRequest,
): Promise<ProfileSettingsResponse> {
  const data = await apiRequest<unknown>('/social/profile', { method: 'PUT', body });
  return profileSettingsResponseSchema.parse(data);
}

/**
 * `GET /social/profiles/:username` — a user's public profile (UNAUTHENTICATED).
 * A profile that isn't opted-in / unknown user 404s.
 */
export async function getPublicProfile(
  username: string,
  signal?: AbortSignal,
): Promise<PublicProfileResponse> {
  const data = await apiRequest<unknown>(`/social/profiles/${encodeURIComponent(username)}`, {
    signal,
  });
  return publicProfileResponseSchema.parse(data);
}

/**
 * `GET /social/profiles/:username/:kind/:subjectId` — read-only detail of one
 * public item on a profile (UNAUTHENTICATED). A non-public item 404s.
 */
export async function getPublicProfileItem(
  username: string,
  kind: ShareKind,
  subjectId: string,
  signal?: AbortSignal,
): Promise<SharedLinkResponse> {
  const data = await apiRequest<unknown>(
    `/social/profiles/${encodeURIComponent(username)}/${kind}/${encodeURIComponent(subjectId)}`,
    { signal },
  );
  return sharedLinkResponseSchema.parse(data);
}

// --- Comments + reactions on shared items (§13.5 V5-P8) ----------------------

const itemPath = (kind: ShareKind, subjectId: string): string =>
  `/social/items/${encodeURIComponent(kind)}/${encodeURIComponent(subjectId)}`;

/**
 * `GET /social/items/:kind/:subjectId/thread` — the item's comment thread +
 * item-level reactions. Only the item's current audience (a friend the owner
 * shares with) or the owner can read it; anything else 404s. A public link is
 * read-only and never reaches this.
 */
export async function getCommentThread(
  kind: ShareKind,
  subjectId: string,
  signal?: AbortSignal,
): Promise<CommentThreadResponse> {
  const data = await apiRequest<unknown>(`${itemPath(kind, subjectId)}/thread`, { signal });
  return commentThreadResponseSchema.parse(data);
}

/** `POST /social/items/:kind/:subjectId/comments` — post one comment. */
export async function postComment(
  kind: ShareKind,
  subjectId: string,
  body: string,
): Promise<CreateCommentResponse> {
  const data = await apiRequest<unknown>(`${itemPath(kind, subjectId)}/comments`, {
    method: 'POST',
    body: { body },
  });
  return createCommentResponseSchema.parse(data);
}

/** `DELETE /social/comments/:commentId` — author or item owner soft-deletes it. */
export async function deleteComment(commentId: string): Promise<void> {
  await apiRequest<unknown>(`/social/comments/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
  });
}

/** `POST /social/items/:kind/:subjectId/reactions` — toggle one curated emoji on the item. */
export async function toggleItemReaction(
  kind: ShareKind,
  subjectId: string,
  emoji: ReactionEmoji,
): Promise<ReactionListResponse> {
  const data = await apiRequest<unknown>(`${itemPath(kind, subjectId)}/reactions`, {
    method: 'POST',
    body: { emoji },
  });
  return reactionListResponseSchema.parse(data);
}

/** `POST /social/comments/:commentId/reactions` — toggle one curated emoji on a comment. */
export async function toggleCommentReaction(
  commentId: string,
  emoji: ReactionEmoji,
): Promise<ReactionListResponse> {
  const data = await apiRequest<unknown>(
    `/social/comments/${encodeURIComponent(commentId)}/reactions`,
    { method: 'POST', body: { emoji } },
  );
  return reactionListResponseSchema.parse(data);
}
