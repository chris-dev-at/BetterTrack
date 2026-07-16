import type {
  AudienceState,
  SetAudienceRequest,
  ShareAudience,
  ShareKind,
  ShareLinkSecret,
} from '@bettertrack/contracts';

import type {
  FriendConglomerateRow,
  FriendIdeaRow,
  FriendPortfolioRow,
  FriendWatchlistRow,
  NamedOwnerRef,
  OwnerRef,
  PublicLinkTarget,
  ShareAudienceRepository,
} from '../../data/repositories/shareAudienceRepository';
import type { FriendshipRepository } from '../../data/repositories/friendshipRepository';
import type { ItemFollowsRepository } from '../../data/repositories/itemFollowsRepository';
import type { ProfileRepository } from '../../data/repositories/profileRepository';
import type { UserFollowsRepository } from '../../data/repositories/userFollowsRepository';
import { badRequest } from '../../errors';
import type { Logger } from '../../logger';
import { generateToken, hashToken } from '../crypto/tokens';
import type { NotificationCenter } from '../notifications/notificationCenter';

/**
 * The ONE server-side sharing-enforcement layer (PROJECTPLAN.md §13.3 V3-P5,
 * §6.9). Every read path in the app — friend-shared portfolio/conglomerate/
 * watchlist views, Shared With Me, the realtime room-join check, and the
 * unauthenticated public-link resolver — routes its authorization decision
 * through this single service, which delegates to the audience repository's
 * authorization-is-the-join queries.
 *
 * **No cached authorization (§6.9).** This layer holds no state and memoises
 * nothing: each call issues a fresh query that re-evaluates friendship + the
 * owner's current audience (+ link liveness) at that instant. Revoking either —
 * unfriending, narrowing the audience, or revoking a link — closes access on the
 * very next call. Non-authorized reads return `undefined`, which callers map to a
 * uniform 404 (never 403).
 *
 * It also owns the owner-facing audience management: the friction-ladder gate
 * (`public_link` requires an explicit acknowledgment, server-side too), the
 * specific-friends validation, and hash-only public-link minting (≥128-bit token
 * via `crypto/tokens`; only the SHA-256 hash is ever stored).
 */

/** A resolved public link: the subject, its owner, and display name. */
export interface ResolvedPublicLink extends OwnerRef {
  kind: ShareKind;
  subjectId: string;
  name: string;
}

/** Result of a `setAudience` mutation — the new state, plus the raw link once on mint. */
export interface AudienceMutationResult {
  state: AudienceState;
  link?: ShareLinkSecret;
}

export interface AudienceServiceDeps {
  repo: ShareAudienceRepository;
  /** Resolves friend recipients + the actor's username for share events (#368). */
  friendship?: Pick<FriendshipRepository, 'getUsername' | 'listFriends'>;
  /** Resolves the owner's followers (+ their auto-follow prefs) for `follow.published` fan-out (#438/#439). */
  follows?: Pick<UserFollowsRepository, 'listFollowerPrefs'>;
  /** Item bookmarks (#439) — auto-added on publish for opted-in followers, purged with the subject. */
  itemFollows?: Pick<ItemFollowsRepository, 'follow' | 'clearForSubject'>;
  /** Reachability gate for `follow.published` — is the owner's public profile live (#438). */
  profile?: Pick<ProfileRepository, 'isProfilePublic'>;
  /** The central notification pipeline (#368) — `*.shared` + `follow.published` enter here. */
  notify?: NotificationCenter;
  logger?: Logger;
}

export interface AudienceService {
  authorizePortfolioRead(viewerId: string, portfolioId: string): Promise<NamedOwnerRef | undefined>;
  authorizeConglomerateRead(
    viewerId: string,
    conglomerateId: string,
  ): Promise<OwnerRef | undefined>;
  authorizeWatchlistRead(viewerId: string, watchlistId: string): Promise<NamedOwnerRef | undefined>;
  /** Authorize a viewer to read one friend-shared idea, or `undefined` (→ 404, V4-P9). */
  authorizeIdeaRead(viewerId: string, ideaId: string): Promise<OwnerRef | undefined>;
  listFriendPortfolios(viewerId: string): Promise<FriendPortfolioRow[]>;
  listFriendConglomerates(viewerId: string): Promise<FriendConglomerateRow[]>;
  listFriendWatchlists(viewerId: string): Promise<FriendWatchlistRow[]>;
  listFriendIdeas(viewerId: string): Promise<FriendIdeaRow[]>;
  /** Resolve a raw public-link token to its live subject, or `undefined` (→ 404). */
  resolvePublicLink(token: string): Promise<ResolvedPublicLink | undefined>;
  /** The owner's audience state for a subject, or `undefined` when not owned (→ 404). */
  getAudience(
    ownerId: string,
    kind: ShareKind,
    subjectId: string,
  ): Promise<AudienceState | undefined>;
  /** Set a subject's audience (owner only). `undefined` when not owned (→ 404). */
  setAudience(
    ownerId: string,
    kind: ShareKind,
    subjectId: string,
    input: SetAudienceRequest,
  ): Promise<AudienceMutationResult | undefined>;
  /**
   * Bridge the legacy `visibility` (private|friends) write into the audience
   * model so the old per-item toggles feed the same single enforcement path:
   * `friends` → `all_friends`, `private` → `private`.
   */
  applyVisibility(
    ownerId: string,
    kind: ShareKind,
    subjectId: string,
    visibility: 'private' | 'friends',
  ): Promise<void>;
  /** Current audience per subject for a same-kind batch (missing = private) — list views. */
  audiencesForSubjects(
    kind: ShareKind,
    subjectIds: readonly string[],
  ): Promise<Map<string, ShareAudience>>;
  /** Audience + named-friend count per subject (missing = private/0) — the "who sees this" summary. */
  audienceSummariesForSubjects(
    kind: ShareKind,
    subjectIds: readonly string[],
  ): Promise<Map<string, { audience: ShareAudience; friendCount: number }>>;
  /**
   * The owner's own `public_link` items — the exact set a public profile composes
   * (V3-P6). Reuses the audience model: a non-public item is structurally absent.
   */
  listPublicProfileItems(ownerId: string): Promise<{
    portfolios: { portfolioId: string; name: string }[];
    conglomerates: { conglomerateId: string; name: string; positionCount: number }[];
    watchlists: { watchlistId: string; name: string; itemCount: number }[];
  }>;
  /** Authorize a logged-out drill-in to one of the owner's public items, or `undefined` (→ 404). */
  authorizePublicItemRead(
    ownerId: string,
    kind: ShareKind,
    subjectId: string,
  ): Promise<{ name: string } | undefined>;
  /**
   * Whether `ownerId` owns the (kind, subjectId) subject. Reused by share-in-chat
   * (§13.3 V3-P8) so a sender can only chip an item they own AND the sender sees
   * their own chip as viewable — never a substitute for the audience check on a
   * non-owner viewer.
   */
  ownsSubject(ownerId: string, kind: ShareKind, subjectId: string): Promise<boolean>;
  /**
   * The subject's display name, or `undefined` when it no longer exists. Only
   * ever called AFTER ownership or an audience authorization has passed (§13.3
   * V3-P8 chip resolution), so it discloses nothing on its own.
   */
  subjectIdentity(kind: ShareKind, subjectId: string): Promise<{ name: string } | undefined>;
  /** Drop a subject's audience row AND its item-follow bookmarks on subject deletion (hygiene; joins already gate). */
  clearForSubject(kind: ShareKind, subjectId: string): Promise<void>;
  /**
   * Whether — and how — a viewer can currently see one subject as an item-follow
   * target (#439): first the friend-mode enforcement join (friendship AND the
   * owner's audience), then the public rung (audience `public_link` AND the
   * owner's public profile live — the only route a non-friend has to the item).
   * Recomputed per call like every other authorization here; `undefined` → 404.
   * `via` tells the SPA which read-only surface the item opens on.
   */
  authorizeItemFollowRead(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
  ): Promise<(NamedOwnerRef & { via: 'friend' | 'public' }) | undefined>;
}

export const PUBLIC_ACK_REQUIRED = () =>
  badRequest(
    'A public link exposes your holdings and net worth to anyone with the link; you must acknowledge this to continue.',
    'PUBLIC_LINK_ACK_REQUIRED',
  );

/** Relative resolution path the SPA turns into a shareable absolute URL. */
function linkPath(token: string): string {
  return `/api/v1/social/links/${token}`;
}

export function createAudienceService(deps: AudienceServiceDeps): AudienceService {
  const { repo, friendship, follows, itemFollows, profile, notify, logger } = deps;

  /**
   * Tell each friend the picker just admitted that the item is shared with them
   * (#368): all-friends → every current friend, specific-friends → the validated
   * member set; private/public-link → nobody (a link is pull, not push). One
   * event per (item, owner) per recipient — the dispatcher's eventKey dedupes
   * repeat transitions, so widening back and forth never re-notifies. Emits
   * ride the durable center and are best-effort for the mutation.
   */
  async function emitShared(
    ownerId: string,
    kind: ShareKind,
    subjectId: string,
    audienceValue: ShareAudience,
    memberIds: readonly string[],
  ): Promise<void> {
    if (!notify || !friendship) return;
    if (audienceValue !== 'all_friends' && audienceValue !== 'specific_friends') return;
    try {
      const recipients =
        audienceValue === 'all_friends'
          ? (await friendship.listFriends(ownerId)).map((f) => f.id)
          : [...memberIds];
      if (recipients.length === 0) return;
      const actorUsername = (await friendship.getUsername(ownerId)) ?? '';
      const occurredAt = new Date().toISOString();
      for (const userId of recipients) {
        if (userId === ownerId) continue;
        const base = { userId, actorId: ownerId, actorUsername, occurredAt };
        if (kind === 'portfolio') {
          await notify.emit({ type: 'portfolio.shared', portfolioId: subjectId, ...base });
        } else if (kind === 'watchlist') {
          await notify.emit({ type: 'watchlist.shared', watchlistId: subjectId, ...base });
        } else if (kind === 'conglomerate') {
          await notify.emit({ type: 'conglomerate.shared', conglomerateId: subjectId, ...base });
        }
        // `idea` (V4-P9) has no direct `*.shared` notice — a shared idea appears in
        // the recipient's Shared-With-Me / friend-row group and, when made public,
        // in the follow.published fan-out; there is no dedicated idea-shared type.
      }
    } catch (err) {
      logger?.error({ err, kind, subjectId }, 'share event emit failed');
    }
  }

  /**
   * Tell the owner's followers an item became newly visible to them (#438).
   *
   * follow.published fires ONLY on a transition INTO `public_link`: that is the
   * one widening that exposes an item to a follower WITHOUT also sending a direct
   * `*.shared` notice. `emitShared` already covers `all_friends`/`specific_friends`
   * — and its recipients are exactly the friends who gain access — so firing follow
   * news there too would double-notify (the anti-noise "no doubles" rule; here it
   * falls out of the guard). A follower who could ALREADY see the item under the
   * prior audience is excluded, so widening friends→public never re-notifies the
   * friends who already saw it, and re-saving public→public notifies nobody. The
   * dispatcher's day-bucketed event key handles same-day public↔private flapping.
   *
   * **Reachability gate.** A follower has no share link, so the ONLY way they can
   * open a newly-public item is the owner's `/u/:username` public profile — the
   * notification's deep link. That page 404s unless the profile is enabled
   * (`users.profile_public`), which is decoupled from making an item public. So
   * we notify ONLY when the profile is live; publishing an item without a public
   * profile shares it link-only and produces no dead-link news (#438, AC#1).
   *
   * Best-effort for the mutation, exactly like {@link emitShared}.
   */
  async function emitFollowPublished(
    ownerId: string,
    kind: ShareKind,
    subjectId: string,
    prior: { audience: ShareAudience; memberIds: readonly string[] },
    nextAudience: ShareAudience,
  ): Promise<void> {
    if (!notify || !follows || !friendship || !profile) return;
    if (nextAudience !== 'public_link') return;
    try {
      // Reachability gate (see doc): no working destination → no news.
      if (!(await profile.isProfilePublic(ownerId))) return;
      const followerPrefs = await follows.listFollowerPrefs(ownerId);
      if (followerPrefs.length === 0) return;
      const friendSet = new Set((await friendship.listFriends(ownerId)).map((f) => f.id));
      const priorMembers = new Set(prior.memberIds);
      const couldSeeBefore = (followerId: string): boolean => {
        switch (prior.audience) {
          case 'public_link':
            return true;
          case 'all_friends':
            return friendSet.has(followerId);
          case 'specific_friends':
            return priorMembers.has(followerId);
          case 'private':
            return false;
        }
      };
      const recipients = followerPrefs.filter(
        (f) => f.followerId !== ownerId && !couldSeeBefore(f.followerId),
      );
      if (recipients.length === 0) return;
      const identity = await repo.getSubjectIdentity(kind, subjectId);
      if (!identity) return; // subject vanished mid-flight — nothing to name
      const actorUsername = (await friendship.getUsername(ownerId)) ?? '';
      const occurredAt = new Date().toISOString();
      for (const { followerId, autoFollowItems } of recipients) {
        // Auto-follow (#439): an opted-in follower gets the item bookmarked in
        // the SAME newly-visible pass that produces their news — insert BEFORE
        // the emit so acting on the bell already finds the bookmark. Idempotent
        // (PK upsert), so a same-day republish never duplicates it. The event
        // matrix is deliberately identical to follow.published's: a follower
        // who could already see the item is neither notified nor auto-added.
        if (autoFollowItems && itemFollows) {
          await itemFollows.follow(followerId, kind, subjectId);
        }
        await notify.emit({
          type: 'follow.published',
          userId: followerId,
          actorId: ownerId,
          actorUsername,
          itemKind: kind,
          itemId: subjectId,
          itemName: identity.name,
          occurredAt,
        });
      }
    } catch (err) {
      logger?.error({ err, kind, subjectId }, 'follow publish emit failed');
    }
  }

  function toState(
    kind: ShareKind,
    subjectId: string,
    owned: {
      audience: ShareAudience;
      friendIds: string[];
      link: { active: boolean; createdAt: Date | null };
    },
  ): AudienceState {
    return {
      kind,
      subjectId,
      audience: owned.audience,
      friendIds: owned.friendIds,
      link: { active: owned.link.active, createdAt: owned.link.createdAt?.toISOString() ?? null },
    };
  }

  return {
    authorizePortfolioRead: (viewerId, portfolioId) =>
      repo.authorizePortfolioRead(viewerId, portfolioId),
    authorizeConglomerateRead: (viewerId, conglomerateId) =>
      repo.authorizeConglomerateRead(viewerId, conglomerateId),
    authorizeWatchlistRead: (viewerId, watchlistId) =>
      repo.authorizeWatchlistRead(viewerId, watchlistId),
    authorizeIdeaRead: (viewerId, ideaId) => repo.authorizeIdeaRead(viewerId, ideaId),
    listFriendPortfolios: (viewerId) => repo.listFriendPortfolios(viewerId),
    listFriendConglomerates: (viewerId) => repo.listFriendConglomerates(viewerId),
    listFriendWatchlists: (viewerId) => repo.listFriendWatchlists(viewerId),
    listFriendIdeas: (viewerId) => repo.listFriendIdeas(viewerId),

    async resolvePublicLink(token) {
      const target: PublicLinkTarget | undefined = await repo.resolvePublicLink(hashToken(token));
      if (!target) return undefined;
      // Final liveness gate: the subject must still exist (and, for a portfolio,
      // not be archived). A vanished subject 404s even if a stale row lingered.
      const identity = await repo.getSubjectIdentity(target.kind, target.subjectId);
      if (!identity) return undefined;
      return { ...target, name: identity.name };
    },

    async getAudience(ownerId, kind, subjectId) {
      if (!(await repo.ownsSubject(ownerId, kind, subjectId))) return undefined;
      const owned = await repo.getOwnedState(kind, subjectId);
      return toState(kind, subjectId, owned);
    },

    async setAudience(ownerId, kind, subjectId, input) {
      if (!(await repo.ownsSubject(ownerId, kind, subjectId))) return undefined;

      // §16 friction ladder — the public rung cannot be selected without the
      // explicit acknowledgment, enforced here as defense in depth behind the UI.
      if (input.audience === 'public_link' && input.acknowledgePublic !== true) {
        throw PUBLIC_ACK_REQUIRED();
      }

      // Snapshot the audience BEFORE mutating: the follow-published delta needs to
      // know who could already see the item, so a follower who already had access
      // isn't re-notified when it widens to public (#438).
      const prior = await repo.getOwnedState(kind, subjectId);

      const memberIds =
        input.audience === 'specific_friends'
          ? await repo.friendIdsOf(ownerId, input.friendIds ?? [])
          : [];

      const audienceId = await repo.setAudience(
        ownerId,
        kind,
        subjectId,
        input.audience,
        memberIds,
      );

      let link: ShareLinkSecret | undefined;
      if (input.audience === 'public_link' && !(await repo.hasActiveLink(audienceId))) {
        // ≥128-bit CSPRNG token (256-bit here); only its hash is persisted (§14).
        const minted = generateToken();
        await repo.insertLink(audienceId, minted.tokenHash);
        link = { token: minted.token, url: linkPath(minted.token) };
      }

      // Notify the newly admitted friends (#368) — after the audience committed,
      // so a recipient acting on the bell is already authorized.
      await emitShared(ownerId, kind, subjectId, input.audience, memberIds);
      // Notify the owner's followers if the item just became public (#438).
      await emitFollowPublished(
        ownerId,
        kind,
        subjectId,
        { audience: prior.audience, memberIds: prior.friendIds },
        input.audience,
      );

      const owned = await repo.getOwnedState(kind, subjectId);
      return { state: toState(kind, subjectId, owned), link };
    },

    async applyVisibility(ownerId, kind, subjectId, visibility) {
      const audience: ShareAudience = visibility === 'friends' ? 'all_friends' : 'private';
      await repo.setAudience(ownerId, kind, subjectId, audience, []);
    },

    audiencesForSubjects: (kind, subjectIds) => repo.audiencesForSubjects(kind, subjectIds),

    audienceSummariesForSubjects: (kind, subjectIds) =>
      repo.audienceSummariesForSubjects(kind, subjectIds),

    async listPublicProfileItems(ownerId) {
      const [portfolios, conglomerates, watchlists] = await Promise.all([
        repo.listPublicPortfolios(ownerId),
        repo.listPublicConglomerates(ownerId),
        repo.listPublicWatchlists(ownerId),
      ]);
      return { portfolios, conglomerates, watchlists };
    },

    authorizePublicItemRead: (ownerId, kind, subjectId) =>
      repo.authorizePublicItemRead(ownerId, kind, subjectId),

    ownsSubject: (ownerId, kind, subjectId) => repo.ownsSubject(ownerId, kind, subjectId),

    subjectIdentity: (kind, subjectId) => repo.getSubjectIdentity(kind, subjectId),

    async clearForSubject(kind, subjectId) {
      // Deleting a subject drops its audience row AND purges every bookmark of
      // it (#439) — reads already degrade gracefully, this is pure hygiene.
      await repo.clearForSubject(kind, subjectId);
      await itemFollows?.clearForSubject(kind, subjectId);
    },

    async authorizeItemFollowRead(viewerId, kind, subjectId) {
      // Friend mode first: the standard enforcement join. When it grants, the
      // friend-shared read-only pages are the natural surface.
      if (kind === 'portfolio') {
        const shared = await repo.authorizePortfolioRead(viewerId, subjectId);
        if (shared) return { ...shared, via: 'friend' };
      } else if (kind === 'conglomerate') {
        const shared = await repo.authorizeConglomerateRead(viewerId, subjectId);
        if (shared) {
          // The conglomerate authorize carries no name; resolve it AFTER the
          // authorization passed (the documented getSubjectIdentity contract).
          const identity = await repo.getSubjectIdentity(kind, subjectId);
          if (identity) return { ...shared, name: identity.name, via: 'friend' };
        }
      } else if (kind === 'watchlist') {
        const shared = await repo.authorizeWatchlistRead(viewerId, subjectId);
        if (shared) return { ...shared, via: 'friend' };
      }
      // `idea` (V4-P9) is not item-followable — it has no friend read-only follow
      // surface — so it falls through to the public rung, which also returns
      // `undefined` for ideas (publicFollowTarget), i.e. a clean 404.
      // Public rung: `public_link` audience + a live public profile (#438's
      // reachability gate) — viewer-independent, so any logged-in user qualifies.
      const pub = await repo.publicFollowTarget(kind, subjectId);
      return pub ? { ...pub, via: 'public' } : undefined;
    },
  };
}
