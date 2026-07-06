import type {
  FriendRequest,
  FriendRequestListResponse,
  Friendship,
  FriendsListResponse,
  MySharedResponse,
  SharedConglomerateDetailResponse,
  SharedPortfolioDetailResponse,
  SharedWatchlistDetailResponse,
  SharedWithMeResponse,
} from '@bettertrack/contracts';

import type {
  FriendshipRepository,
  FriendRow,
  PendingRequestRow,
} from '../../data/repositories/friendshipRepository';
import { notFound } from '../../errors';
import type { EventBus } from '../../events';
import type { Logger } from '../../logger';
import type { ConglomerateService } from '../conglomerate/conglomerateService';
import type { PortfolioService } from '../portfolio/portfolioService';
import type { WorkboardService } from '../workboard/workboardService';

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
 * `friend.request` + `friend.accepted` domain events are published here (§6.10)
 * so the notification dispatcher — a pure bus subscriber — can turn them into
 * bell notifications without this service knowing about notifications at all.
 */

export interface SocialServiceDeps {
  repo: FriendshipRepository;
  /**
   * Reused to build the read-only shared overview from the *owner's* scope, so a
   * friend view mirrors the owner's overview blocks exactly and never
   * re-implements the money-math (§6.9).
   */
  portfolio: PortfolioService;
  /**
   * Reused to read the *owner's* conglomerate for a read-only friend view (§6.9,
   * V2-P9) and to list the caller's own shared baskets for My Shared Items — so
   * the friend view mirrors the owner's data and never re-implements it.
   */
  conglomerate: ConglomerateService;
  /**
   * Reused to read the *owner's* watchlist for a read-only friend view (§6.9,
   * V2-P9) and to read the caller's own watchlist sharing state + item count.
   */
  workboard: WorkboardService;
  /** Domain event bus — `friend.request` / `friend.accepted` are published here (§6.10). */
  events: EventBus;
  logger?: Logger;
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
  /**
   * Everything the caller's friends share with them — portfolios, conglomerates
   * and watchlists — aggregated (Shared With Me, §6.9, V2-P9).
   */
  listSharedWithMe(userId: string): Promise<SharedWithMeResponse>;
  /**
   * The read-only overview of a friend-shared portfolio. Asserts an existing
   * friendship **and** the owner's `visibility=friends` at call time; a 404
   * (never 403) otherwise, recomputed per request (§6.9).
   */
  getSharedPortfolio(viewerId: string, portfolioId: string): Promise<SharedPortfolioDetailResponse>;
  /**
   * The read-only view of a friend-shared conglomerate — positions with asset
   * identity. Asserts friendship **and** the owner's `visibility=friends` at call
   * time; 404 (never 403) otherwise, recomputed per request (§6.9, V2-P9).
   */
  getSharedConglomerate(
    viewerId: string,
    conglomerateId: string,
  ): Promise<SharedConglomerateDetailResponse>;
  /**
   * The read-only view of a friend's shared watchlist — the watched items.
   * Asserts friendship **and** the owner's `watchlist_visibility=friends` at call
   * time; 404 (never 403) otherwise, recomputed per request (§6.9, V2-P9).
   */
  getSharedWatchlist(viewerId: string, ownerId: string): Promise<SharedWatchlistDetailResponse>;
  /**
   * Everything the caller is currently sharing with friends — portfolios,
   * conglomerates and their watchlist state (My Shared Items, §6.9, V2-P9).
   */
  listMyShared(userId: string): Promise<MySharedResponse>;
}

/**
 * Cooldown after a decline before the same sender may request the same target
 * again (§6.9 hardening). A declined request frees the pending-pair unique index,
 * so without this a rejected sender could immediately re-request — re-notifying
 * the recipient on every attempt. Seven days is long enough to blunt harassment
 * yet short enough that a genuine later reconnect still works.
 */
export const DECLINE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const REQUEST_NOT_FOUND = () => notFound('Friend request not found.', 'FRIEND_REQUEST_NOT_FOUND');
const FRIEND_NOT_FOUND = () => notFound('Friend not found.', 'FRIENDSHIP_NOT_FOUND');
const SHARED_NOT_FOUND = () => notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
const SHARED_CONGLOMERATE_NOT_FOUND = () =>
  notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');
const SHARED_WATCHLIST_NOT_FOUND = () => notFound('Watchlist not found.', 'WATCHLIST_NOT_FOUND');

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
  const { repo, portfolio, conglomerate, workboard, events, logger } = deps;

  /** Publish a domain event best-effort — a bus failure never fails the request. */
  async function emit(event: Parameters<EventBus['publish']>[0]): Promise<void> {
    try {
      await events.publish(event);
    } catch (err) {
      logger?.error({ err, type: event.type }, 'social event publish failed');
    }
  }

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
      // Recently declined by this target: silently no-op until the cooldown
      // elapses, so a rejection can't be re-sent (and re-notified) on repeat.
      const cooldownSince = new Date(Date.now() - DECLINE_COOLDOWN_MS);
      if (await repo.hasDeclinedSince(fromUserId, targetId, cooldownSince)) return;
      // Otherwise create it; the partial unique index makes a duplicate
      // same-direction request a silent no-op (idempotent).
      const requestId = await repo.createRequest(fromUserId, targetId);
      // Only notify on a genuinely new request — a deduped no-op returns null.
      if (requestId) {
        const actorUsername = (await repo.getUsername(fromUserId)) ?? '';
        await emit({
          type: 'friend.request',
          userId: targetId,
          actorId: fromUserId,
          actorUsername,
          requestId,
          occurredAt: new Date().toISOString(),
        });
      }
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
      const accepted = await repo.acceptRequest(userId, requestId);
      if (!accepted) throw REQUEST_NOT_FOUND();
      // Notify the original requester that the user accepted (§6.10). The actor
      // is the accepter; the recipient is whoever sent the request.
      const actorUsername = (await repo.getUsername(userId)) ?? '';
      await emit({
        type: 'friend.accepted',
        userId: accepted.fromUser,
        actorId: userId,
        actorUsername,
        requestId,
        occurredAt: new Date().toISOString(),
      });
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
      // Each list is authorization-derived (friendship AND owner grant, resolved
      // in the repository join), so revoking either instantly drops the row.
      const [portfolioRows, conglomerateRows, watchlistRows] = await Promise.all([
        repo.listSharedWithViewer(userId),
        repo.listSharedConglomeratesWithViewer(userId),
        repo.listSharedWatchlistsWithViewer(userId),
      ]);
      // A portfolio's total value is the owner's own overview total — computed
      // through the portfolio service (owner scope), so no money-math is
      // duplicated. Report net worth (holdings + cash, #311) so the list card
      // agrees with the total shown on the shared-portfolio detail view below.
      const portfolios = await Promise.all(
        portfolioRows.map(async (row) => {
          const overview = await portfolio.getPortfolio(row.ownerId, row.portfolioId);
          return {
            portfolioId: row.portfolioId,
            name: row.name,
            owner: { id: row.ownerId, username: row.ownerUsername },
            totalValueEur: overview.totals.totalValueEur,
          };
        }),
      );
      const conglomerates = conglomerateRows.map((row) => ({
        conglomerateId: row.conglomerateId,
        name: row.name,
        owner: { id: row.ownerId, username: row.ownerUsername },
        status: row.status,
        positionCount: row.positionCount,
      }));
      const watchlists = watchlistRows.map((row) => ({
        owner: { id: row.ownerId, username: row.ownerUsername },
        itemCount: row.itemCount,
      }));
      return { portfolios, conglomerates, watchlists };
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

    async getSharedConglomerate(viewerId, conglomerateId) {
      // Authorization recomputed per call — friendship AND owner
      // visibility='friends' in one query; revoking either 404s immediately.
      const shared = await repo.findSharedConglomerateForViewer(viewerId, conglomerateId);
      if (!shared) throw SHARED_CONGLOMERATE_NOT_FOUND();

      // Build the view from the *owner's* scope (owner-scoped get, which the
      // join above guarantees resolves) so the friend sees exactly the owner's
      // basket; the viewer never becomes owner of any derived data.
      const detail = await conglomerate.get(shared.ownerId, conglomerateId);
      return {
        conglomerateId,
        name: detail.name,
        description: detail.description,
        status: detail.status,
        owner: { id: shared.ownerId, username: shared.ownerUsername },
        positions: detail.positions,
      };
    },

    async getSharedWatchlist(viewerId, ownerId) {
      // Authorization recomputed per call — friendship AND owner
      // watchlist_visibility='friends'; revoking either 404s immediately.
      const shared = await repo.findSharedWatchlistOwnerForViewer(viewerId, ownerId);
      if (!shared) throw SHARED_WATCHLIST_NOT_FOUND();

      const items = await workboard.list(shared.ownerId);
      return {
        owner: { id: shared.ownerId, username: shared.ownerUsername },
        items: items.map((item) => ({
          id: item.id,
          assetId: item.assetId,
          sortOrder: item.sortOrder,
          note: item.note ?? null,
          asset: {
            symbol: item.asset.symbol,
            name: item.asset.name,
            exchange: item.asset.exchange ?? null,
            currency: item.asset.currency,
            type: item.asset.type,
          },
        })),
      };
    },

    async listMyShared(userId) {
      // Reuse each owner-scoped list and keep only the friends-visible rows — the
      // toggle-off lists. Turning one off is the existing PATCH on that surface
      // (`/portfolios/:id`, `/conglomerates/:id`, `/workboard/sharing`), so there
      // is no mutation here.
      const [portfolioList, conglomerateList, sharing, items] = await Promise.all([
        portfolio.listPortfolios(userId),
        conglomerate.list(userId),
        workboard.getSharing(userId),
        workboard.list(userId),
      ]);
      return {
        portfolios: portfolioList.portfolios.filter((p) => p.visibility === 'friends'),
        conglomerates: conglomerateList.conglomerates.filter((c) => c.visibility === 'friends'),
        watchlist: { visibility: sharing.visibility, itemCount: items.length },
      };
    },
  };
}
