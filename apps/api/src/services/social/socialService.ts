import type {
  ActivityAlertState,
  AudienceState,
  FollowedItem,
  FollowersListResponse,
  FollowingEntry,
  FollowingListResponse,
  FollowUser,
  ItemFollowsListResponse,
  UpdateFollowRequest,
  FriendRequest,
  FriendRequestListResponse,
  Friendship,
  FriendsListResponse,
  MySharedResponse,
  ProfileSettingsResponse,
  PublicProfileResponse,
  SetAudienceRequest,
  ShareAudience,
  ShareKind,
  SharedConglomerateDetailResponse,
  SharedLinkResponse,
  SharedPortfolioDetailResponse,
  SharedWatchlistDetailResponse,
  SharedWithMeResponse,
  UpdateProfileSettingsRequest,
} from '@bettertrack/contracts';
import { PROFILE_BIO_MAX } from '@bettertrack/contracts';

import type {
  FriendshipRepository,
  FriendRow,
  PendingRequestRow,
} from '../../data/repositories/friendshipRepository';
import type {
  ItemFollowsRepository,
  ItemFollowListRow,
} from '../../data/repositories/itemFollowsRepository';
import type { ProfileRepository } from '../../data/repositories/profileRepository';
import type {
  FollowingUserRow,
  FollowPrefs,
  FollowUserRow,
  UserFollowsRepository,
} from '../../data/repositories/userFollowsRepository';
import { badRequest, notFound } from '../../errors';
import type { Logger } from '../../logger';
import type { ConglomerateService } from '../conglomerate/conglomerateService';
import type { NotificationCenter } from '../notifications/notificationCenter';
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
  /** Person-follow graph (#438) — follow/unfollow + the following/followers lists. */
  follows: UserFollowsRepository;
  /** Item bookmarks (#439) — follow/unfollow/list; visibility is re-derived per read. */
  itemFollows: ItemFollowsRepository;
  /** Public-profile settings + per-viewer activity-alert preferences (V3-P6). */
  profile: ProfileRepository;
  /** The single sharing-enforcement layer — consulted by every read path here. */
  audience: AudienceService;
  /** Owner-scoped source of the read-only portfolio view (money-math is never duplicated). */
  portfolio: PortfolioService;
  /** Owner-scoped source of the read-only conglomerate view. */
  conglomerate: ConglomerateService;
  /** Owner-scoped source of watchlist items + named-list metadata. */
  workboard: WorkboardService;
  /** The central notification pipeline (#368) — friend.request/accepted enter here. */
  notify: NotificationCenter;
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
  /**
   * Follow a person (#438). Idempotent; 404 when the target isn't a valid follow
   * target. All per-follow prefs (#439 auto-follow, #455 alert triggers) are
   * settable at follow time; a repeat follow never flips existing prefs.
   */
  followUser(userId: string, targetId: string, opts?: FollowPrefs): Promise<void>;
  /** Unfollow a person (#438). 404 when the caller wasn't following them. */
  unfollowUser(userId: string, targetId: string): Promise<void>;
  /** Patch the caller's prefs on one follow (#439). 404 when not following. */
  updateFollow(
    userId: string,
    targetId: string,
    patch: UpdateFollowRequest,
  ): Promise<FollowingEntry>;
  /** The users the caller follows, with follower/following counts (#438). */
  listFollowing(userId: string): Promise<FollowingListResponse>;
  /** The users who follow the caller (#438). */
  listFollowers(userId: string): Promise<FollowersListResponse>;
  /**
   * Bookmark another user's item (#439). Idempotent. 404 unless the item is
   * currently visible to the caller (friend-shared or public with a live
   * profile); 400 on the caller's own item.
   */
  followItem(userId: string, kind: ShareKind, subjectId: string): Promise<void>;
  /** Remove an item bookmark (#439). 404 when the caller wasn't following it. */
  unfollowItem(userId: string, kind: ShareKind, subjectId: string): Promise<void>;
  /** The caller's followed items, visibility re-derived per row (#439). */
  listItemFollows(userId: string): Promise<ItemFollowsListResponse>;
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
  /** Set the viewer's activity-alert preference for one shared item — 404 if they can't read it. */
  setActivityAlert(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    enabled: boolean,
  ): Promise<ActivityAlertState>;
  /** The caller's own public-profile settings (V3-P6). */
  getProfileSettings(userId: string): Promise<ProfileSettingsResponse>;
  /** Update the caller's public-profile opt-in + bio; enabling needs the ack (§16). */
  updateProfileSettings(
    userId: string,
    input: UpdateProfileSettingsRequest,
  ): Promise<ProfileSettingsResponse>;
  /** UNAUTHENTICATED public-profile read (V3-P6): compose a user's `public_link` items, or 404. */
  getPublicProfile(username: string): Promise<PublicProfileResponse>;
  /** UNAUTHENTICATED public-profile item drill-in: one `public_link` item's read-only view, or 404. */
  getPublicProfileItem(
    username: string,
    kind: ShareKind,
    subjectId: string,
  ): Promise<SharedLinkResponse>;
}

export const DECLINE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const REQUEST_NOT_FOUND = () => notFound('Friend request not found.', 'FRIEND_REQUEST_NOT_FOUND');
const FRIEND_NOT_FOUND = () => notFound('Friend not found.', 'FRIENDSHIP_NOT_FOUND');
const FOLLOW_TARGET_NOT_FOUND = () => notFound('User not found.', 'USER_NOT_FOUND');
const NOT_FOLLOWING = () => notFound('You are not following this user.', 'FOLLOW_NOT_FOUND');
const CANNOT_FOLLOW_SELF = () => badRequest('You cannot follow yourself.', 'CANNOT_FOLLOW_SELF');
const ITEM_FOLLOW_NOT_FOUND = () =>
  notFound('You are not following this item.', 'ITEM_FOLLOW_NOT_FOUND');
const CANNOT_FOLLOW_OWN_ITEM = () =>
  badRequest('You cannot follow your own item.', 'CANNOT_FOLLOW_OWN_ITEM');
const SHARED_NOT_FOUND = () => notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
const SHARED_CONGLOMERATE_NOT_FOUND = () =>
  notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');
const SHARED_WATCHLIST_NOT_FOUND = () => notFound('Watchlist not found.', 'WATCHLIST_NOT_FOUND');
const SUBJECT_NOT_FOUND = () => notFound('Not found.', 'NOT_FOUND');
const LINK_NOT_FOUND = () => notFound('This shared link is no longer available.', 'LINK_NOT_FOUND');
const PROFILE_NOT_FOUND = () => notFound('This profile is not available.', 'PROFILE_NOT_FOUND');
const PROFILE_ACK_REQUIRED = () =>
  badRequest(
    'A public profile shows anyone the items you have made public; you must acknowledge this to enable it.',
    'PUBLIC_PROFILE_ACK_REQUIRED',
  );

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

function toFollowUser(row: FollowUserRow): FollowUser {
  return {
    user: { id: row.id, username: row.username },
    createdAt: row.createdAt.toISOString(),
  };
}

function toFollowingEntry(row: FollowingUserRow): FollowingEntry {
  return {
    ...toFollowUser(row),
    autoFollowItems: row.autoFollowItems,
    notifyOnAlertCreate: row.notifyOnAlertCreate,
    notifyOnAlertFire: row.notifyOnAlertFire,
    sharesAlertActivity: row.sharesAlertActivity,
  };
}

export function createSocialService(deps: SocialServiceDeps): SocialService {
  const {
    repo,
    follows,
    itemFollows,
    profile,
    audience,
    portfolio,
    conglomerate,
    workboard,
    notify,
  } = deps;

  // Friend events enter the ONE durable notification pipeline (#368) — the
  // center is fire-and-forget: a queue failure logs and never fails the action.
  const emit = notify.emit.bind(notify);

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

  /**
   * Render one already-authorized subject into the kind-tagged read-only shape
   * shared by the public-link resolver and the public-profile drill-in. The
   * caller has ALREADY proven access (a live token, or the `public_link` audience
   * on an opted-in profile); this only builds the view.
   */
  async function buildLinkResponse(
    ownerId: string,
    ownerUsername: string,
    kind: ShareKind,
    subjectId: string,
    name: string,
  ): Promise<SharedLinkResponse> {
    if (kind === 'portfolio') {
      return {
        kind: 'portfolio',
        portfolio: await buildPortfolioView(ownerId, ownerUsername, subjectId, name),
      };
    }
    if (kind === 'conglomerate') {
      return {
        kind: 'conglomerate',
        conglomerate: await buildConglomerateView(ownerId, ownerUsername, subjectId),
      };
    }
    return {
      kind: 'watchlist',
      watchlist: await buildWatchlistView(ownerId, ownerUsername, subjectId, name),
    };
  }

  async function loadProfileSettings(userId: string): Promise<ProfileSettingsResponse> {
    const settings = await profile.getProfileSettings(userId);
    if (!settings) throw PROFILE_NOT_FOUND();
    const items = await audience.listPublicProfileItems(userId);
    const publicItemCount =
      items.portfolios.length + items.conglomerates.length + items.watchlists.length;
    return {
      username: settings.username,
      isPublic: settings.isPublic,
      bio: settings.bio,
      publicItemCount,
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

    async followUser(userId, targetId, opts) {
      if (userId === targetId) throw CANNOT_FOLLOW_SELF();
      // The target must be a real, active, non-admin account. Validating first
      // turns an unknown/admin/disabled id into a uniform 404 (never an FK crash),
      // and keeps admins out of the social graph like friend requests do.
      const target = await follows.findFollowTarget(targetId);
      if (!target) throw FOLLOW_TARGET_NOT_FOUND();
      // Follow eligibility (V4-P0b): a person is followable when they are the
      // caller's FRIEND — the Friends-tab follow path, no public profile needed —
      // OR they expose a public profile (the follow path for non-friends). A
      // non-friend without a public profile has no follow surface and 404s here,
      // with the same opaque "not a follow target" code as an unknown user so the
      // check can't be used to probe friendships or profiles.
      const followable =
        (await repo.areFriends(userId, targetId)) || (await profile.isProfilePublic(targetId));
      if (!followable) throw FOLLOW_TARGET_NOT_FOUND();
      // Idempotent: a repeat follow is a silent no-op — following grants no access
      // and emits nothing on its own, so there is nothing to re-fire. A repeat
      // follow also never flips prefs; changing those is PATCH's job (#439/#455).
      await follows.follow(userId, targetId, {
        autoFollowItems: opts?.autoFollowItems,
        notifyOnAlertCreate: opts?.notifyOnAlertCreate,
        notifyOnAlertFire: opts?.notifyOnAlertFire,
      });
    },

    async unfollowUser(userId, targetId) {
      const removed = await follows.unfollow(userId, targetId);
      if (!removed) throw NOT_FOLLOWING();
    },

    async updateFollow(userId, targetId, patch) {
      const found = await follows.updateFollowPrefs(userId, targetId, {
        autoFollowItems: patch.autoFollowItems,
        notifyOnAlertCreate: patch.notifyOnAlertCreate,
        notifyOnAlertFire: patch.notifyOnAlertFire,
      });
      if (!found) throw NOT_FOLLOWING();
      const row = await follows.getFollowing(userId, targetId);
      if (!row) throw NOT_FOLLOWING(); // unfollowed between the two statements
      return toFollowingEntry(row);
    },

    async listFollowing(userId) {
      const [rows, followerCount] = await Promise.all([
        follows.listFollowing(userId),
        follows.countFollowers(userId),
      ]);
      return { following: rows.map(toFollowingEntry), followingCount: rows.length, followerCount };
    },

    async listFollowers(userId) {
      const rows = await follows.listFollowers(userId);
      return { followers: rows.map(toFollowUser) };
    },

    async followItem(userId, kind, subjectId) {
      // Your own item is never followable — the Following collection is
      // strictly "other people's items" (#439). Owner-checked FIRST so the
      // error is honest for the one caller who already knows the item exists.
      if (await audience.ownsSubject(userId, kind, subjectId)) throw CANNOT_FOLLOW_OWN_ITEM();
      // Only a CURRENTLY visible item is followable — the same enforcement
      // decision every read makes, so this can't probe private items (404,
      // never 403). Idempotent afterwards, like the person-follow.
      const visible = await audience.authorizeItemFollowRead(userId, kind, subjectId);
      if (!visible) throw SUBJECT_NOT_FOUND();
      await itemFollows.follow(userId, kind, subjectId);
    },

    async unfollowItem(userId, kind, subjectId) {
      // No visibility gate here: unfollowing must keep working AFTER the item
      // became invisible (that's how a "gone" row is cleaned up).
      const removed = await itemFollows.unfollow(userId, kind, subjectId);
      if (!removed) throw ITEM_FOLLOW_NOT_FOUND();
    },

    async listItemFollows(userId) {
      // Visibility is re-derived through the enforcement layer PER ROW at read
      // time (§6.9 no-caching): an item that was unshared/narrowed/deleted or
      // whose owner vanished renders as the chat-chip-style `viewable: false`
      // shell — subjectId only, no name/owner — never a stale view.
      const rows = await itemFollows.list(userId);
      const items: FollowedItem[] = await Promise.all(
        rows.map(async (row: ItemFollowListRow): Promise<FollowedItem> => {
          const base = {
            kind: row.kind,
            subjectId: row.subjectId,
            followedAt: row.createdAt.toISOString(),
          };
          const visible = await audience.authorizeItemFollowRead(userId, row.kind, row.subjectId);
          if (!visible) return { ...base, viewable: false, name: null, owner: null, via: null };
          return {
            ...base,
            viewable: true,
            name: visible.name,
            owner: { id: visible.ownerId, username: visible.ownerUsername },
            via: visible.via,
          };
        }),
      );
      return { items };
    },

    async listSharedWithMe(userId, opts) {
      // Every list is authorization-derived by the enforcement layer (friendship
      // AND audience, in the SQL join), so unfriending or narrowing instantly
      // drops the row — nothing to invalidate. The viewer's activity-alert prefs
      // are stamped on top (a pure preference; delivery is #368).
      const [portfolioRows, conglomerateRows, watchlistRows, activityPrefs] = await Promise.all([
        audience.listFriendPortfolios(userId),
        audience.listFriendConglomerates(userId),
        audience.listFriendWatchlists(userId),
        profile.listActivityPrefs(userId),
      ]);
      const alertsOn = (kind: ShareKind, subjectId: string): boolean =>
        activityPrefs.has(`${kind}:${subjectId}`);
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
            activityAlertsEnabled: alertsOn('portfolio', row.portfolioId),
          };
        }),
      );
      const conglomerates = conglomerateRows.map((row) => ({
        conglomerateId: row.conglomerateId,
        name: row.name,
        owner: { id: row.ownerId, username: row.ownerUsername },
        status: row.status,
        positionCount: row.positionCount,
        activityAlertsEnabled: alertsOn('conglomerate', row.conglomerateId),
      }));
      const watchlists = watchlistRows.map((row) => ({
        watchlistId: row.watchlistId,
        name: row.name,
        owner: { id: row.ownerId, username: row.ownerUsername },
        itemCount: row.itemCount,
        activityAlertsEnabled: alertsOn('watchlist', row.watchlistId),
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
      // EVERY shareable item the caller owns is listed here — all portfolios
      // (#377) AND all conglomerates + watchlists, shared or not (#384). A
      // private/never-shared item has no audience row, so it was previously
      // invisible and thus un-shareable from the Social area; surfacing it
      // (dimmed, audience=private) gives every item a single entry point to the
      // AudiencePicker. This is one unified "My items" view; everything is
      // private by default.
      const allPortfolios = portfolioList.portfolios;
      const allConglomerates = conglomerateList.conglomerates;
      const allWatchlists = watchlists;
      // Batch the real audience + named-friend count off the single audience
      // model, so each row's "who can see this" summary is exactly what the
      // enforcement layer authorizes against (never the coarse legacy flag).
      const [pAud, cAud, wAud] = await Promise.all([
        audience.audienceSummariesForSubjects(
          'portfolio',
          allPortfolios.map((p) => p.id),
        ),
        audience.audienceSummariesForSubjects(
          'conglomerate',
          allConglomerates.map((c) => c.id),
        ),
        audience.audienceSummariesForSubjects(
          'watchlist',
          allWatchlists.map((w) => w.id),
        ),
      ]);
      const summary = (
        map: Map<string, { audience: ShareAudience; friendCount: number }>,
        id: string,
        fallback: ShareAudience,
      ): { audience: ShareAudience; friendCount: number } =>
        map.get(id) ?? { audience: fallback, friendCount: 0 };
      return {
        portfolios: allPortfolios.map((p) => {
          // Fall back off the legacy `visibility` column only when no audience
          // row exists yet: a `friends` portfolio predating the audience model
          // reads as `all_friends`, a private one as `private`.
          const s = summary(pAud, p.id, p.visibility === 'friends' ? 'all_friends' : 'private');
          return {
            portfolioId: p.id,
            name: p.name,
            audience: s.audience,
            friendCount: s.friendCount,
          };
        }),
        conglomerates: allConglomerates.map((c) => {
          // Fall back off the legacy `visibility` only when no audience row
          // exists yet: a `friends` basket predating the audience model reads as
          // `all_friends`, a never-shared one as `private`.
          const s = summary(cAud, c.id, c.visibility === 'friends' ? 'all_friends' : 'private');
          return {
            conglomerateId: c.id,
            name: c.name,
            positionCount: c.positionCount,
            audience: s.audience,
            friendCount: s.friendCount,
          };
        }),
        watchlists: allWatchlists.map((w) => {
          const s = summary(wAud, w.id, w.audience);
          return {
            watchlistId: w.id,
            name: w.name,
            itemCount: w.itemCount,
            audience: s.audience,
            friendCount: s.friendCount,
          };
        }),
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
      return buildLinkResponse(
        resolved.ownerId,
        resolved.ownerUsername,
        resolved.kind,
        resolved.subjectId,
        resolved.name,
      );
    },

    async setActivityAlert(viewerId, kind, subjectId, enabled) {
      // A pref is only writable while the viewer is CURRENTLY authorized to read
      // the item — the same enforcement join every read uses. This keeps the
      // toggle from doubling as a probe for a private/unshared item (404, never
      // 403) and prevents stranded prefs on things you can't see.
      const authorized =
        kind === 'portfolio'
          ? await audience.authorizePortfolioRead(viewerId, subjectId)
          : kind === 'conglomerate'
            ? await audience.authorizeConglomerateRead(viewerId, subjectId)
            : await audience.authorizeWatchlistRead(viewerId, subjectId);
      if (!authorized) throw SUBJECT_NOT_FOUND();
      await profile.setActivityPref(viewerId, kind, subjectId, enabled);
      return { kind, subjectId, enabled };
    },

    getProfileSettings: (userId) => loadProfileSettings(userId),

    async updateProfileSettings(userId, input) {
      // §16 friction ladder, mirrored server-side: enabling a public profile needs
      // the explicit acknowledgment, defense-in-depth behind the UI warning.
      if (input.isPublic && input.acknowledgePublic !== true) throw PROFILE_ACK_REQUIRED();
      // `bio: undefined` (omitted) leaves the current bio untouched; `null`/empty
      // clears it. Only touch the column when the caller actually sent a bio.
      let bio: string | null | undefined;
      if (input.bio !== undefined) {
        const trimmed = input.bio?.trim() ?? '';
        bio = trimmed.length > 0 ? trimmed.slice(0, PROFILE_BIO_MAX) : null;
      }
      const current = await profile.getProfileSettings(userId);
      if (!current) throw PROFILE_NOT_FOUND();
      await profile.updateProfileSettings(userId, {
        isPublic: input.isPublic,
        bio: bio === undefined ? current.bio : bio,
      });
      return loadProfileSettings(userId);
    },

    async getPublicProfile(username) {
      const owner = await profile.findPublicProfileOwner(username);
      if (!owner) throw PROFILE_NOT_FOUND();
      const [items, followerCount] = await Promise.all([
        audience.listPublicProfileItems(owner.ownerId),
        follows.countFollowers(owner.ownerId),
      ]);
      const portfolios = await Promise.all(
        items.portfolios.map(async (p) => {
          const overview = await portfolio.getPortfolio(owner.ownerId, p.portfolioId);
          return {
            portfolioId: p.portfolioId,
            name: p.name,
            totalValueEur: overview.totals.totalValueEur,
          };
        }),
      );
      return {
        // The owner id is public-safe and lets a logged-in visitor follow the
        // person straight from their profile (#438).
        userId: owner.ownerId,
        username: owner.username,
        bio: owner.bio,
        followerCount,
        portfolios,
        conglomerates: items.conglomerates,
        watchlists: items.watchlists,
      };
    },

    async getPublicProfileItem(username, kind, subjectId) {
      const owner = await profile.findPublicProfileOwner(username);
      if (!owner) throw PROFILE_NOT_FOUND();
      // The SAME `public_link` gate as the listing — a non-public (or non-owned,
      // or dead) item 404s, so the drill-in can never render a private item.
      const item = await audience.authorizePublicItemRead(owner.ownerId, kind, subjectId);
      if (!item) throw PROFILE_NOT_FOUND();
      return buildLinkResponse(owner.ownerId, owner.username, kind, subjectId, item.name);
    },
  };
}
