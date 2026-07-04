import {
  friendRequestListResponseSchema,
  friendsListResponseSchema,
  mySharedListResponseSchema,
  okResponseSchema,
  sharedPortfolioDetailResponseSchema,
  sharedPortfolioListResponseSchema,
  type CreateFriendRequestRequest,
  type FriendRequestListResponse,
  type FriendsListResponse,
  type MySharedListResponse,
  type SharedPortfolioDetailResponse,
  type SharedPortfolioListResponse,
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

/** `GET /social/shared` — friends' portfolios currently at `visibility=friends`. */
export async function listSharedWithMe(signal?: AbortSignal): Promise<SharedPortfolioListResponse> {
  const data = await apiRequest<unknown>('/social/shared', { signal });
  return sharedPortfolioListResponseSchema.parse(data);
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

/** `GET /social/my-shared` — the caller's own `visibility=friends` portfolios. */
export async function listMyShared(signal?: AbortSignal): Promise<MySharedListResponse> {
  const data = await apiRequest<unknown>('/social/my-shared', { signal });
  return mySharedListResponseSchema.parse(data);
}
