import type {
  FriendRequest,
  FriendRequestListResponse,
  Friendship,
  FriendsListResponse,
  MySharedListResponse,
  SharedPortfolioDetailResponse,
  SharedPortfolioListResponse,
} from '@bettertrack/contracts';

import type {
  FriendshipRepository,
  FriendRow,
  PendingRequestRow,
} from '../../data/repositories/friendshipRepository';
import { notFound } from '../../errors';
import type { PortfolioService } from '../portfolio/portfolioService';

/**
 * Friend-request / friendship orchestration (PROJECTPLAN.md §6.9). The V1
 * friend system, complete: request by username/email, accept/decline/cancel,
 * list, remove.
 *
 * Two rules dominate:
 *  - **No enumeration.** `sendRequest` returns the *same* result whether the
 *    target exists, doesn't exist, is yourself, is already a friend, or already
 *    has a pending request — an attacker learns nothing about who has an
 *    account. A request to a nonexistent/self address creates no visible row.
 *  - **404, never 403.** Acting on a request that isn't yours (or isn't
 *    pending), or removing a non-friend, is a plain 404 — the same response a
 *    caller gets for an id that never existed, so no membership is leaked.
 *
 * Bell notifications / `friend.request` + `friend.accepted` events are **P6**
 * and deliberately not wired here.
 */

export interface SocialServiceDeps {
  repo: FriendshipRepository;
  /**
   * Reused to build the read-only shared overview from the *owner's* scope, so a
   * friend view mirrors the owner's overview blocks exactly and never
   * re-implements the money-math (§6.9).
   */
  portfolio: PortfolioService;
}

export interface SocialService {
  /** Send a friend request to `identifier` (username or email). No-enumeration. */
  sendRequest(fromUserId: string, identifier: string): Promise<void>;
  /** The caller's pending incoming + outgoing requests (public-safe users). */
  listRequests(userId: string): Promise<FriendRequestListResponse>;
  /** Accept a pending request addressed to the caller → forms a friendship. */
  accept(userId: string, requestId: string): Promise<void>;
  /** Decline a pending request addressed to the caller. */
  decline(userId: string, requestId: string): Promise<void>;
  /** Cancel a pending request the caller sent. */
  cancel(userId: string, requestId: string): Promise<void>;
  /** The caller's friends (public-safe users). */
  listFriends(userId: string): Promise<FriendsListResponse>;
  /** Remove a friendship (either side may). */
  removeFriend(userId: string, otherUserId: string): Promise<void>;
  /** Portfolios of the caller's friends set to `visibility=friends` (Shared With Me). */
  listSharedWithMe(userId: string): Promise<SharedPortfolioListResponse>;
  /**
   * The read-only overview of a friend-shared portfolio. Asserts an existing
   * friendship **and** the owner's `visibility=friends` at call time; a 404
   * (never 403) otherwise, recomputed per request (§6.9).
   */
  getSharedPortfolio(viewerId: string, portfolioId: string): Promise<SharedPortfolioDetailResponse>;
  /** The caller's own portfolios currently at `visibility=friends` (My Shared Items). */
  listMyShared(userId: string): Promise<MySharedListResponse>;
}

const REQUEST_NOT_FOUND = () => notFound('Friend request not found.', 'FRIEND_REQUEST_NOT_FOUND');
const FRIEND_NOT_FOUND = () => notFound('Friend not found.', 'FRIENDSHIP_NOT_FOUND');
const SHARED_NOT_FOUND = () => notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');

function toFriendRequest(row: PendingRequestRow): FriendRequest {
  return {
    id: row.id,
    direction: row.direction,
    status: 'pending',
    user: { id: row.otherUserId, username: row.otherUsername },
    createdAt: row.createdAt.toISOString(),
    respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
  };
}

function toFriendship(row: FriendRow): Friendship {
  return {
    user: { id: row.id, username: row.username },
    createdAt: row.createdAt.toISOString(),
  };
}

export function createSocialService(deps: SocialServiceDeps): SocialService {
  const { repo, portfolio } = deps;

  return {
    async sendRequest(fromUserId, identifier) {
      // Every early return below produces the identical outward result, so none
      // of these branches is observable to the caller (§6.9 no-enumeration).
      const targetId = await repo.findUserIdByIdentifier(identifier);
      // Unknown address, or a request to yourself: nothing to do, no row.
      if (!targetId || targetId === fromUserId) return;
      // Already friends: idempotent no-op — a fresh request adds nothing.
      if (await repo.areFriends(fromUserId, targetId)) return;
      // The target already asked you: leave their pending request for you to
      // accept rather than creating a crossing second request.
      const reverse = await repo.findPendingRequest(targetId, fromUserId);
      if (reverse) return;
      // Otherwise create it; the partial unique index makes a duplicate
      // same-direction request a silent no-op (idempotent).
      await repo.createRequest(fromUserId, targetId);
    },

    async listRequests(userId) {
      const rows = await repo.listPendingForUser(userId);
      const incoming: FriendRequest[] = [];
      const outgoing: FriendRequest[] = [];
      for (const row of rows) {
        (row.direction === 'incoming' ? incoming : outgoing).push(toFriendRequest(row));
      }
      return { incoming, outgoing };
    },

    async accept(userId, requestId) {
      const ok = await repo.acceptRequest(userId, requestId);
      if (!ok) throw REQUEST_NOT_FOUND();
    },

    async decline(userId, requestId) {
      const ok = await repo.declineRequest(userId, requestId);
      if (!ok) throw REQUEST_NOT_FOUND();
    },

    async cancel(userId, requestId) {
      const ok = await repo.cancelRequest(userId, requestId);
      if (!ok) throw REQUEST_NOT_FOUND();
    },

    async listFriends(userId) {
      const rows = await repo.listFriends(userId);
      return { friends: rows.map(toFriendship) };
    },

    async removeFriend(userId, otherUserId) {
      const removed = await repo.deleteFriendship(userId, otherUserId);
      if (!removed) throw FRIEND_NOT_FOUND();
    },

    async listSharedWithMe(userId) {
      const rows = await repo.listSharedWithViewer(userId);
      // The total value is the owner's own overview total — computed through the
      // shared portfolio service (owner scope), so no money-math is duplicated.
      const portfolios = await Promise.all(
        rows.map(async (row) => {
          const overview = await portfolio.getPortfolio(row.ownerId, row.portfolioId);
          return {
            portfolioId: row.portfolioId,
            name: row.name,
            owner: { id: row.ownerId, username: row.ownerUsername },
            totalValueEur: overview.totals.marketValueEur,
          };
        }),
      );
      return { portfolios };
    },

    async getSharedPortfolio(viewerId, portfolioId) {
      // Authorization recomputed here every call — friendship AND owner
      // visibility='friends' in one query; revoking either 404s immediately.
      const shared = await repo.findSharedPortfolioForViewer(viewerId, portfolioId);
      if (!shared) throw SHARED_NOT_FOUND();

      // Build the overview from the *owner's* scope so it mirrors exactly what
      // the owner sees; the viewer never becomes the owner of any derived data.
      const overview = await portfolio.getPortfolio(shared.ownerId, portfolioId);
      const history = await portfolio.getHistory(shared.ownerId, portfolioId, 'MAX');
      return {
        portfolioId,
        name: shared.name,
        owner: { id: shared.ownerId, username: shared.ownerUsername },
        baseCurrency: overview.baseCurrency,
        totals: overview.totals,
        holdings: overview.holdings,
        history: { range: history.range, points: history.points },
      };
    },

    async listMyShared(userId) {
      // Reuse the owner-scoped list (which materialises the default) and keep
      // only the friends-visible rows — the toggle-off list. Turning one off is
      // the existing PATCH /portfolios/:id, so there is no mutation here.
      const { portfolios } = await portfolio.listPortfolios(userId);
      return { portfolios: portfolios.filter((p) => p.visibility === 'friends') };
    },
  };
}
