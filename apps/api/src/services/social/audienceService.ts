import type {
  AudienceState,
  SetAudienceRequest,
  ShareAudience,
  ShareKind,
  ShareLinkSecret,
} from '@bettertrack/contracts';

import type {
  FriendConglomerateRow,
  FriendPortfolioRow,
  FriendWatchlistRow,
  NamedOwnerRef,
  OwnerRef,
  PublicLinkTarget,
  ShareAudienceRepository,
} from '../../data/repositories/shareAudienceRepository';
import { badRequest } from '../../errors';
import { generateToken, hashToken } from '../crypto/tokens';

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
}

export interface AudienceService {
  authorizePortfolioRead(viewerId: string, portfolioId: string): Promise<NamedOwnerRef | undefined>;
  authorizeConglomerateRead(
    viewerId: string,
    conglomerateId: string,
  ): Promise<OwnerRef | undefined>;
  authorizeWatchlistRead(viewerId: string, watchlistId: string): Promise<NamedOwnerRef | undefined>;
  listFriendPortfolios(viewerId: string): Promise<FriendPortfolioRow[]>;
  listFriendConglomerates(viewerId: string): Promise<FriendConglomerateRow[]>;
  listFriendWatchlists(viewerId: string): Promise<FriendWatchlistRow[]>;
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
  /** Drop a subject's audience row on subject deletion (hygiene; joins already gate). */
  clearForSubject(kind: ShareKind, subjectId: string): Promise<void>;
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
  const { repo } = deps;

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
    listFriendPortfolios: (viewerId) => repo.listFriendPortfolios(viewerId),
    listFriendConglomerates: (viewerId) => repo.listFriendConglomerates(viewerId),
    listFriendWatchlists: (viewerId) => repo.listFriendWatchlists(viewerId),

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

    clearForSubject: (kind, subjectId) => repo.clearForSubject(kind, subjectId),
  };
}
