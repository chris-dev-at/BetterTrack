import type {
  AudienceState,
  FriendRequest,
  FriendRequestListResponse,
  Friendship,
  FriendsListResponse,
  MySharedResponse,
  SetAudienceRequest,
  ShareKind,
  SharedConglomerateDetailResponse,
  SharedLinkResponse,
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
import type { AudienceMutationResult, AudienceService } from './audienceService';

/**
 * Friend graph + the sharing surface (PROJECTPLAN.md §6.9, §13.3 V3-P5). The V1
 * friend system (request/accept/decline/cancel/list/remove, no-enumeration,
 * 404-never-403) plus the V3 audience surface: every friend-shared read and the
 * unauthenticated public-link read route their authorization through the ONE
 * {@link AudienceService} enforcement layer, and the owner-facing AudiencePicker
 * reads/writes audiences through it too. This service never decides authorization
 * itself — it asks the enforcement layer, which recomputes it per call with no
 * caching (§6.9).
 */

export interface SocialServiceDeps {
  repo: FriendshipRepository;
  /** The single sharing-enforcement layer — consulted by every read path here. */
  audience: AudienceService;
  /** Owner-scoped source of the read-only portfolio view (money-math is never duplicated). */
  portfolio: PortfolioService;
  /** Owner-scoped source of the read-only conglomerate view. */
  conglomerate: ConglomerateService;
  /** Owner-scoped source of watchlist items + named-list metadata. */
  workboard: WorkboardService;
  events: EventBus;
  logger?: Logger;
}

export interface SocialService {
  sendRequest(fromUserId: string, identifier: string): Promise<void>;
  listRequests(userId: string): Promise<FriendRequestListResponse>;
  accept(userId: string, requestId: string): Promise<void>;
  decline(userId: string, requestId: string): Promise<void>;
  cancel(userId: string, requestId: string): Promise<void>;
  listFriends(userId: string): Promise<FriendsListResponse>;
  removeFriend(userId: string, otherUserId: string): Promise<void>;
  listSharedWithMe(userId: string, opts?: { baseCurrency?: string }): Promise<SharedWithMeResponse>;
  getSharedPortfolio(
    viewerId: string,
    portfolioId: string,
    opts?: { baseCurrency?: string },
  ): Promise<SharedPortfolioDetailResponse>;
  getSharedConglomerate(
    viewerId: string,
    conglomerateId: string,
  ): Promise<SharedConglomerateDetailResponse>;
  getSharedWatchlist(viewerId: string, watchlistId: string): Promise<SharedWatchlistDetailResponse>;
  listMyShared(userId: string): Promise<MySharedResponse>;
  /** The owner's audience for one subject, or 404 when not owned. Feeds the AudiencePicker. */
  getAudience(userId: string, kind: ShareKind, subjectId: string): Promise<AudienceState>;
  /** Set a subject's audience (owner only) — the picker's write. 404 when not owned. */
  setAudience(
    userId: string,
    kind: ShareKind,
    subjectId: string,
    input: SetAudienceRequest,
  ): Promise<AudienceMutationResult>;
  /** Bridge a legacy `visibility` toggle into the audience model (owner already verified upstream). */
  applyAudienceVisibility(
    userId: string,
    kind: ShareKind,
    subjectId: string,
    visibility: 'private' | 'friends',
  ): Promise<void>;
  /** UNAUTHENTICATED public-link read (§14): resolve a token to its live read-only view, or 404. */
  getByPublicLink(token: string): Promise<SharedLinkResponse>;
}

export const DECLINE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const REQUEST_NOT_FOUND = () => notFound('Friend request not found.', 'FRIEND_REQUEST_NOT_FOUND');
const FRIEND_NOT_FOUND = () => notFound('Friend not found.', 'FRIENDSHIP_NOT_FOUND');
const SHARED_NOT_FOUND = () => notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
const SHARED_CONGLOMERATE_NOT_FOUND = () =>
  notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');
const SHARED_WATCHLIST_NOT_FOUND = () => notFound('Watchlist not found.', 'WATCHLIST_NOT_FOUND');
const SUBJECT_NOT_FOUND = () => notFound('Not found.', 'NOT_FOUND');
const LINK_NOT_FOUND = () => notFound('This shared link is no longer available.', 'LINK_NOT_FOUND');

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
  const { repo, audience, portfolio, conglomerate, workboard, events, logger } = deps;

  async function emit(event: Parameters<EventBus['publish']>[0]): Promise<void> {
    try {
      await events.publish(event);
    } catch (err) {
      logger?.error({ err, type: event.type }, 'social event publish failed');
    }
  }

  // Owner-scoped read-view builders, reused by both the friend endpoints and the
  // public-link resolver so the two never diverge (authorization differs; the
  // rendered read-only view is identical).

  async function buildPortfolioView(
    ownerId: string,
    ownerUsername: string,
    portfolioId: string,
    name: string,
    opts?: { baseCurrency?: string },
  ): Promise<SharedPortfolioDetailResponse> {
    const base = { baseCurrency: opts?.baseCurrency };
    const overview = await portfolio.getPortfolio(ownerId, portfolioId, base);
    const history = await portfolio.getHistory(ownerId, portfolioId, 'MAX', base);
    return {
      portfolioId,
      name,
      owner: { id: ownerId, username: ownerUsername },
      baseCurrency: overview.baseCurrency,
      totals: overview.totals,
      holdings: overview.holdings,
      history: { range: history.range, points: history.points },
    };
  }

  async function buildConglomerateView(
    ownerId: string,
    ownerUsername: string,
    conglomerateId: string,
  ): Promise<SharedConglomerateDetailResponse> {
    const detail = await conglomerate.get(ownerId, conglomerateId);
    return {
      conglomerateId,
      name: detail.name,
      description: detail.description,
      status: detail.status,
      owner: { id: ownerId, username: ownerUsername },
      positions: detail.positions,
    };
  }

  async function buildWatchlistView(
    ownerId: string,
    ownerUsername: string,
    watchlistId: string,
    name: string,
  ): Promise<SharedWatchlistDetailResponse> {
    const items = await workboard.itemsForSharedView(watchlistId);
    return {
      watchlistId,
      name,
      owner: { id: ownerId, username: ownerUsername },
      items: items.map((item) => ({
        id: item.id,
        watchlistId: item.watchlistId,
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
  }

  return {
    async sendRequest(fromUserId, identifier) {
      const targetId = await repo.findUserIdByIdentifier(identifier);
      if (!targetId || targetId === fromUserId) return;
      if (await repo.areFriends(fromUserId, targetId)) return;
      const reverse = await repo.findPendingRequest(targetId, fromUserId);
      if (reverse) return;
      const cooldownSince = new Date(Date.now() - DECLINE_COOLDOWN_MS);
      if (await repo.hasDeclinedSince(fromUserId, targetId, cooldownSince)) return;
      const requestId = await repo.createRequest(fromUserId, targetId);
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

    async listSharedWithMe(userId, opts) {
      // Every list is authorization-derived by the enforcement layer (friendship
      // AND audience, in the SQL join), so unfriending or narrowing instantly
      // drops the row — nothing to invalidate.
      const [portfolioRows, conglomerateRows, watchlistRows] = await Promise.all([
        audience.listFriendPortfolios(userId),
        audience.listFriendConglomerates(userId),
        audience.listFriendWatchlists(userId),
      ]);
      const portfolios = await Promise.all(
        portfolioRows.map(async (row) => {
          const overview = await portfolio.getPortfolio(row.ownerId, row.portfolioId, {
            baseCurrency: opts?.baseCurrency,
          });
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
        watchlistId: row.watchlistId,
        name: row.name,
        owner: { id: row.ownerId, username: row.ownerUsername },
        itemCount: row.itemCount,
      }));
      return { portfolios, conglomerates, watchlists };
    },

    async getSharedPortfolio(viewerId, portfolioId, opts) {
      const shared = await audience.authorizePortfolioRead(viewerId, portfolioId);
      if (!shared) throw SHARED_NOT_FOUND();
      return buildPortfolioView(
        shared.ownerId,
        shared.ownerUsername,
        portfolioId,
        shared.name,
        opts,
      );
    },

    async getSharedConglomerate(viewerId, conglomerateId) {
      const shared = await audience.authorizeConglomerateRead(viewerId, conglomerateId);
      if (!shared) throw SHARED_CONGLOMERATE_NOT_FOUND();
      return buildConglomerateView(shared.ownerId, shared.ownerUsername, conglomerateId);
    },

    async getSharedWatchlist(viewerId, watchlistId) {
      const shared = await audience.authorizeWatchlistRead(viewerId, watchlistId);
      if (!shared) throw SHARED_WATCHLIST_NOT_FOUND();
      return buildWatchlistView(shared.ownerId, shared.ownerUsername, watchlistId, shared.name);
    },

    async listMyShared(userId) {
      const [portfolioList, conglomerateList, watchlists] = await Promise.all([
        portfolio.listPortfolios(userId),
        conglomerate.list(userId),
        workboard.listWatchlists(userId),
      ]);
      return {
        portfolios: portfolioList.portfolios.filter((p) => p.visibility === 'friends'),
        conglomerates: conglomerateList.conglomerates.filter((c) => c.visibility === 'friends'),
        watchlists: watchlists
          .filter((w) => w.audience !== 'private')
          .map((w) => ({
            watchlistId: w.id,
            name: w.name,
            audience: w.audience,
            itemCount: w.itemCount,
          })),
      };
    },

    async getAudience(userId, kind, subjectId) {
      const state = await audience.getAudience(userId, kind, subjectId);
      if (!state) throw SUBJECT_NOT_FOUND();
      return state;
    },

    async setAudience(userId, kind, subjectId, input) {
      const result = await audience.setAudience(userId, kind, subjectId, input);
      if (!result) throw SUBJECT_NOT_FOUND();
      return result;
    },

    async applyAudienceVisibility(userId, kind, subjectId, visibility) {
      await audience.applyVisibility(userId, kind, subjectId, visibility);
    },

    async getByPublicLink(token) {
      const resolved = await audience.resolvePublicLink(token);
      if (!resolved) throw LINK_NOT_FOUND();
      const owner = resolved.ownerUsername;
      if (resolved.kind === 'portfolio') {
        return {
          kind: 'portfolio',
          portfolio: await buildPortfolioView(
            resolved.ownerId,
            owner,
            resolved.subjectId,
            resolved.name,
          ),
        };
      }
      if (resolved.kind === 'conglomerate') {
        return {
          kind: 'conglomerate',
          conglomerate: await buildConglomerateView(resolved.ownerId, owner, resolved.subjectId),
        };
      }
      return {
        kind: 'watchlist',
        watchlist: await buildWatchlistView(
          resolved.ownerId,
          owner,
          resolved.subjectId,
          resolved.name,
        ),
      };
    },
  };
}
