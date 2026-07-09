import {
  audienceMutationResponseSchema,
  audienceStateSchema,
  friendRequestListResponseSchema,
  friendsListResponseSchema,
  mySharedResponseSchema,
  okResponseSchema,
  sharedConglomerateDetailResponseSchema,
  sharedLinkResponseSchema,
  sharedPortfolioDetailResponseSchema,
  sharedWatchlistDetailResponseSchema,
  sharedWithMeResponseSchema,
  type AudienceMutationResponse,
  type AudienceState,
  type CreateFriendRequestRequest,
  type FriendRequestListResponse,
  type FriendsListResponse,
  type MySharedResponse,
  type SetAudienceRequest,
  type ShareKind,
  type SharedConglomerateDetailResponse,
  type SharedLinkResponse,
  type SharedPortfolioDetailResponse,
  type SharedWatchlistDetailResponse,
  type SharedWithMeResponse,
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
