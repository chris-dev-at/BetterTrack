import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import type { ShareAudience, ShareKind } from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  conglomerates,
  friendGroupMembers,
  friendGroups,
  friendships,
  ideas,
  itemComments,
  itemReactions,
  portfolios,
  shareAudienceLinks,
  shareAudienceMembers,
  shareAudiences,
  users,
  watchlists,
  workboardItems,
} from '../schema';

/**
 * Unified sharing-audience persistence (PROJECTPLAN.md §13.3 V3-P5, §6.9). The
 * ONE storage layer behind the single enforcement service — audiences, the
 * specific-friends membership set, and hash-only public-link tokens.
 *
 * **Authorization IS the join.** Every read-authorization query recomputes,
 * from scratch, an existing friendship (or a live public-link token) AND the
 * owner's current audience AND the subject's own liveness in a single SQL
 * statement. Nothing is cached: unfriending, narrowing the audience, or revoking
 * a link drops the row from the very next query. A non-authorized viewer gets
 * `undefined`, which every caller maps to a uniform 404 — never a 403, no
 * existence leak (§6.9).
 *
 * `subject_id` is polymorphic (a portfolio / conglomerate / watchlist id, no
 * FK), so the authorization queries INNER JOIN the concrete subject table: a
 * deleted or archived subject is unreadable even if a stale audience row lingers.
 * A portfolio locked into a vault is equally unreadable here: every portfolio
 * discovery/authorization query requires `vault_id IS NULL`, so stale grants
 * and public-link tokens remain opaque while E4 performs their durable revoke.
 */

/** Public-safe owner identity returned by every authorization query (§6.9). */
export interface OwnerRef {
  ownerId: string;
  ownerUsername: string;
  /** Owner's curated profile icon id (§13.5 V5-P0 (c)) or `null` when unset. */
  ownerProfileIcon: string | null;
}

/** An authorized portfolio/watchlist read carries the subject's display name too. */
export interface NamedOwnerRef extends OwnerRef {
  name: string;
}

/** One friend-shared portfolio in Shared With Me. */
export interface FriendPortfolioRow extends OwnerRef {
  portfolioId: string;
  name: string;
}
/** One friend-shared conglomerate in Shared With Me. */
export interface FriendConglomerateRow extends OwnerRef {
  conglomerateId: string;
  name: string;
  status: 'draft' | 'active';
  positionCount: number;
}
/** One friend-shared watchlist in Shared With Me. */
export interface FriendWatchlistRow extends OwnerRef {
  watchlistId: string;
  name: string;
  itemCount: number;
}
/** One friend-shared idea in Shared With Me (V4-P9). */
export interface FriendIdeaRow extends OwnerRef {
  ideaId: string;
  name: string;
  hasThesis: boolean;
}

/** The owner-facing audience state for one subject (feeds the AudiencePicker). */
export interface OwnedAudienceState {
  audience: ShareAudience;
  friendIds: string[];
  /** The referenced friend group (V5-P8) — set only for the `group` audience. */
  groupId: string | null;
  link: { active: boolean; createdAt: Date | null };
}

/**
 * One subject's "who can see this" reach, for the owner's My items list
 * (§13.5 V5-P8). `friendCount` is non-zero only for `specific_friends`; `group`
 * names the circle a `group` share reaches, with its LIVE roster size, and is
 * `null` both for every other audience and for a `group` share whose group was
 * deleted — a state that resolves to nobody.
 */
export interface AudienceReachSummary {
  audience: ShareAudience;
  friendCount: number;
  group: { id: string; name: string; memberCount: number } | null;
}

/** A token resolved to its subject (public-link mode, no friendship). */
export interface PublicLinkTarget extends OwnerRef {
  kind: ShareKind;
  subjectId: string;
}

export function createShareAudienceRepository(db: Database) {
  /**
   * The audience-grant predicate — the heart of the enforcement layer, written
   * once and reused by every friend-mode query. A viewer is granted by audience
   * when it is `all_friends`, `public_link` (public is strictly broader than
   * friends), `specific_friends` with the viewer in the membership set, or
   * `group` with the viewer in the referenced circle's CURRENT roster. On the
   * two broad modes a membership row is instead a durable exclusion marker,
   * written by paranoid enable so an implicit inbound share cannot resurrect
   * after disable. A later owner-driven setAudience replaces the set and clears
   * that marker. It is ALWAYS combined with a friendship join by the caller, so
   * `private` — and any audience the viewer isn't named in — grants nothing.
   *
   * The `group` branch reads the live membership, so editing a circle instantly
   * changes who sees existing shares; a `group` share whose group was deleted
   * carries `group_id IS NULL`, the EXISTS finds no member, and it resolves to
   * nobody (fail-closed, §6.9).
   */
  function audienceGrants(viewerId: string) {
    return sql`(
      (
        ${shareAudiences.audience} in ('all_friends', 'public_link')
        and not exists (
          select 1 from ${shareAudienceMembers}
          where ${shareAudienceMembers.audienceId} = ${shareAudiences.id}
            and ${shareAudienceMembers.friendId} = ${viewerId}
        )
      )
      or (
        ${shareAudiences.audience} = 'specific_friends'
        and exists (
          select 1 from ${shareAudienceMembers}
          where ${shareAudienceMembers.audienceId} = ${shareAudiences.id}
            and ${shareAudienceMembers.friendId} = ${viewerId}
        )
      )
      or (
        ${shareAudiences.audience} = 'group'
        and exists (
          select 1 from ${friendGroupMembers}
          where ${friendGroupMembers.groupId} = ${shareAudiences.groupId}
            and ${friendGroupMembers.memberId} = ${viewerId}
        )
      )
    )`;
  }

  /**
   * Friendship-exists predicate between one bound user id and a column holding
   * the other side. The pair is stored once and read order-independently, so it
   * serves both the authorization queries (viewer id × subject-owner column) and
   * the owner-facing membership read (owner id × member column).
   */
  function friendshipWith(userId: string, otherCol: AnyPgColumn) {
    return or(
      and(eq(friendships.userA, userId), eq(friendships.userB, otherCol)),
      and(eq(friendships.userB, userId), eq(friendships.userA, otherCol)),
    );
  }

  return {
    // ── Read authorization — friend mode (authenticated viewer) ─────────────

    /**
     * Authorize the viewer to read one friend-shared portfolio, or `undefined`.
     * Friendship AND the owner's current audience AND the portfolio being live
     * (exists, not archived, owner active) — all in one query, recomputed per
     * call (§6.9). Archived ⇒ treated as private for sharing.
     */
    async authorizePortfolioRead(
      viewerId: string,
      portfolioId: string,
    ): Promise<NamedOwnerRef | undefined> {
      const [row] = await db
        .select({
          ownerId: portfolios.userId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
          name: portfolios.name,
        })
        .from(portfolios)
        .innerJoin(users, and(eq(users.id, portfolios.userId), eq(users.status, 'active')))
        .innerJoin(
          shareAudiences,
          and(eq(shareAudiences.kind, 'portfolio'), eq(shareAudiences.subjectId, portfolios.id)),
        )
        .innerJoin(friendships, friendshipWith(viewerId, portfolios.userId))
        .where(
          and(
            eq(portfolios.id, portfolioId),
            isNull(portfolios.archivedAt),
            isNull(portfolios.vaultId),
            audienceGrants(viewerId),
          ),
        )
        .limit(1);
      return row;
    },

    /**
     * Authorize the viewer to read one friend-shared conglomerate, or
     * `undefined`. Friendship AND audience AND the basket existing + owner
     * active, in one query (§6.9, V2-P9).
     */
    async authorizeConglomerateRead(
      viewerId: string,
      conglomerateId: string,
    ): Promise<OwnerRef | undefined> {
      const [row] = await db
        .select({
          ownerId: conglomerates.ownerId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
        })
        .from(conglomerates)
        .innerJoin(users, and(eq(users.id, conglomerates.ownerId), eq(users.status, 'active')))
        .innerJoin(
          shareAudiences,
          and(
            eq(shareAudiences.kind, 'conglomerate'),
            eq(shareAudiences.subjectId, conglomerates.id),
          ),
        )
        .innerJoin(friendships, friendshipWith(viewerId, conglomerates.ownerId))
        .where(and(eq(conglomerates.id, conglomerateId), audienceGrants(viewerId)))
        .limit(1);
      return row;
    },

    /**
     * Authorize the viewer to read one friend-shared watchlist, or `undefined`.
     * Friendship AND audience AND the list existing + owner active (§6.9, V2-P9).
     */
    async authorizeWatchlistRead(
      viewerId: string,
      watchlistId: string,
    ): Promise<NamedOwnerRef | undefined> {
      const [row] = await db
        .select({
          ownerId: watchlists.userId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
          name: watchlists.name,
        })
        .from(watchlists)
        .innerJoin(users, and(eq(users.id, watchlists.userId), eq(users.status, 'active')))
        .innerJoin(
          shareAudiences,
          and(eq(shareAudiences.kind, 'watchlist'), eq(shareAudiences.subjectId, watchlists.id)),
        )
        .innerJoin(friendships, friendshipWith(viewerId, watchlists.userId))
        .where(and(eq(watchlists.id, watchlistId), audienceGrants(viewerId)))
        .limit(1);
      return row;
    },

    /**
     * Authorize the viewer to read one friend-shared idea, or `undefined` (V4-P9).
     * Friendship AND audience AND the idea existing + owner active, in one query
     * (§6.9) — the identical authorization-is-the-join the other kinds use. The
     * idea's name is resolved AFTER this passes via {@link getSubjectIdentity}, so
     * a denied read discloses nothing.
     */
    async authorizeIdeaRead(viewerId: string, ideaId: string): Promise<OwnerRef | undefined> {
      const [row] = await db
        .select({
          ownerId: ideas.ownerId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
        })
        .from(ideas)
        .innerJoin(users, and(eq(users.id, ideas.ownerId), eq(users.status, 'active')))
        .innerJoin(
          shareAudiences,
          and(eq(shareAudiences.kind, 'idea'), eq(shareAudiences.subjectId, ideas.id)),
        )
        .innerJoin(friendships, friendshipWith(viewerId, ideas.ownerId))
        .where(and(eq(ideas.id, ideaId), audienceGrants(viewerId)))
        .limit(1);
      return row;
    },

    // ── Shared With Me listings (same authorization, as a set) ──────────────

    /**
     * Discover only the account ids that may contribute rows to Shared With Me.
     * This intentionally selects no subject/profile fields: callers use it to
     * acquire the optional owner privacy locks before the enriched list query.
     */
    async listFriendShareOwnerIds(viewerId: string): Promise<string[]> {
      const [portfolioOwners, conglomerateOwners, watchlistOwners, ideaOwners] = await Promise.all([
        db
          .selectDistinct({ ownerId: portfolios.userId })
          .from(portfolios)
          .innerJoin(users, and(eq(users.id, portfolios.userId), eq(users.status, 'active')))
          .innerJoin(
            shareAudiences,
            and(eq(shareAudiences.kind, 'portfolio'), eq(shareAudiences.subjectId, portfolios.id)),
          )
          .innerJoin(friendships, friendshipWith(viewerId, portfolios.userId))
          .where(
            and(
              isNull(portfolios.archivedAt),
              isNull(portfolios.vaultId),
              audienceGrants(viewerId),
            ),
          ),
        db
          .selectDistinct({ ownerId: conglomerates.ownerId })
          .from(conglomerates)
          .innerJoin(users, and(eq(users.id, conglomerates.ownerId), eq(users.status, 'active')))
          .innerJoin(
            shareAudiences,
            and(
              eq(shareAudiences.kind, 'conglomerate'),
              eq(shareAudiences.subjectId, conglomerates.id),
            ),
          )
          .innerJoin(friendships, friendshipWith(viewerId, conglomerates.ownerId))
          .where(audienceGrants(viewerId)),
        db
          .selectDistinct({ ownerId: watchlists.userId })
          .from(watchlists)
          .innerJoin(users, and(eq(users.id, watchlists.userId), eq(users.status, 'active')))
          .innerJoin(
            shareAudiences,
            and(eq(shareAudiences.kind, 'watchlist'), eq(shareAudiences.subjectId, watchlists.id)),
          )
          .innerJoin(friendships, friendshipWith(viewerId, watchlists.userId))
          .where(audienceGrants(viewerId)),
        db
          .selectDistinct({ ownerId: ideas.ownerId })
          .from(ideas)
          .innerJoin(users, and(eq(users.id, ideas.ownerId), eq(users.status, 'active')))
          .innerJoin(
            shareAudiences,
            and(eq(shareAudiences.kind, 'idea'), eq(shareAudiences.subjectId, ideas.id)),
          )
          .innerJoin(friendships, friendshipWith(viewerId, ideas.ownerId))
          .where(audienceGrants(viewerId)),
      ]);
      return [
        ...new Set(
          [...portfolioOwners, ...conglomerateOwners, ...watchlistOwners, ...ideaOwners].map(
            (row) => row.ownerId,
          ),
        ),
      ];
    },

    async listFriendPortfolios(
      viewerId: string,
      ownerIds?: readonly string[],
    ): Promise<FriendPortfolioRow[]> {
      if (ownerIds?.length === 0) return [];
      return db
        .select({
          portfolioId: portfolios.id,
          name: portfolios.name,
          ownerId: portfolios.userId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
        })
        .from(portfolios)
        .innerJoin(users, and(eq(users.id, portfolios.userId), eq(users.status, 'active')))
        .innerJoin(
          shareAudiences,
          and(eq(shareAudiences.kind, 'portfolio'), eq(shareAudiences.subjectId, portfolios.id)),
        )
        .innerJoin(friendships, friendshipWith(viewerId, portfolios.userId))
        .where(
          and(
            isNull(portfolios.archivedAt),
            isNull(portfolios.vaultId),
            audienceGrants(viewerId),
            ownerIds ? inArray(portfolios.userId, [...ownerIds]) : undefined,
          ),
        )
        .orderBy(asc(users.username), asc(portfolios.name));
    },

    async listFriendConglomerates(
      viewerId: string,
      ownerIds?: readonly string[],
    ): Promise<FriendConglomerateRow[]> {
      if (ownerIds?.length === 0) return [];
      return db
        .select({
          conglomerateId: conglomerates.id,
          name: conglomerates.name,
          status: conglomerates.status,
          ownerId: conglomerates.ownerId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
          positionCount: sql<number>`(
            select count(*) from ${sql.identifier('conglomerate_positions')}
            where ${sql.identifier('conglomerate_positions')}.${sql.identifier('conglomerate_id')} = ${conglomerates.id}
          )`.mapWith(Number),
        })
        .from(conglomerates)
        .innerJoin(users, and(eq(users.id, conglomerates.ownerId), eq(users.status, 'active')))
        .innerJoin(
          shareAudiences,
          and(
            eq(shareAudiences.kind, 'conglomerate'),
            eq(shareAudiences.subjectId, conglomerates.id),
          ),
        )
        .innerJoin(friendships, friendshipWith(viewerId, conglomerates.ownerId))
        .where(
          and(
            audienceGrants(viewerId),
            ownerIds ? inArray(conglomerates.ownerId, [...ownerIds]) : undefined,
          ),
        )
        .orderBy(asc(users.username), asc(conglomerates.name));
    },

    async listFriendWatchlists(
      viewerId: string,
      ownerIds?: readonly string[],
    ): Promise<FriendWatchlistRow[]> {
      if (ownerIds?.length === 0) return [];
      return db
        .select({
          watchlistId: watchlists.id,
          name: watchlists.name,
          ownerId: watchlists.userId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
          itemCount: sql<number>`(
            select count(*) from ${workboardItems}
            where ${workboardItems.watchlistId} = ${watchlists.id}
          )`.mapWith(Number),
        })
        .from(watchlists)
        .innerJoin(users, and(eq(users.id, watchlists.userId), eq(users.status, 'active')))
        .innerJoin(
          shareAudiences,
          and(eq(shareAudiences.kind, 'watchlist'), eq(shareAudiences.subjectId, watchlists.id)),
        )
        .innerJoin(friendships, friendshipWith(viewerId, watchlists.userId))
        .where(
          and(
            audienceGrants(viewerId),
            ownerIds ? inArray(watchlists.userId, [...ownerIds]) : undefined,
          ),
        )
        .orderBy(asc(users.username), asc(watchlists.name));
    },

    async listFriendIdeas(
      viewerId: string,
      ownerIds?: readonly string[],
    ): Promise<FriendIdeaRow[]> {
      if (ownerIds?.length === 0) return [];
      return db
        .select({
          ideaId: ideas.id,
          name: ideas.name,
          hasThesis: sql<boolean>`${ideas.thesis} is not null`.mapWith(Boolean),
          ownerId: ideas.ownerId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
        })
        .from(ideas)
        .innerJoin(users, and(eq(users.id, ideas.ownerId), eq(users.status, 'active')))
        .innerJoin(
          shareAudiences,
          and(eq(shareAudiences.kind, 'idea'), eq(shareAudiences.subjectId, ideas.id)),
        )
        .innerJoin(friendships, friendshipWith(viewerId, ideas.ownerId))
        .where(
          and(
            audienceGrants(viewerId),
            ownerIds ? inArray(ideas.ownerId, [...ownerIds]) : undefined,
          ),
        )
        .orderBy(asc(users.username), asc(ideas.name));
    },

    // ── Public-profile listings (owner's own `public_link` items, no viewer) ─

    /**
     * The owner's own items whose audience is `public_link` — the exact set a
     * public profile composes (V3-P6). This reuses the SAME audience model the
     * enforcement layer authorizes against: an item appears here iff its stored
     * audience is `public_link` AND the subject is live, so a non-public item can
     * never be surfaced by the profile. No friendship join — public is public.
     */
    async listPublicPortfolios(ownerId: string): Promise<{ portfolioId: string; name: string }[]> {
      return db
        .select({ portfolioId: portfolios.id, name: portfolios.name })
        .from(portfolios)
        .innerJoin(
          shareAudiences,
          and(
            eq(shareAudiences.kind, 'portfolio'),
            eq(shareAudiences.subjectId, portfolios.id),
            eq(shareAudiences.audience, 'public_link'),
          ),
        )
        .where(
          and(
            eq(portfolios.userId, ownerId),
            isNull(portfolios.archivedAt),
            isNull(portfolios.vaultId),
          ),
        )
        .orderBy(asc(portfolios.name));
    },

    async listPublicConglomerates(
      ownerId: string,
    ): Promise<{ conglomerateId: string; name: string; positionCount: number }[]> {
      return db
        .select({
          conglomerateId: conglomerates.id,
          name: conglomerates.name,
          positionCount: sql<number>`(
            select count(*) from ${sql.identifier('conglomerate_positions')}
            where ${sql.identifier('conglomerate_positions')}.${sql.identifier('conglomerate_id')} = ${conglomerates.id}
          )`.mapWith(Number),
        })
        .from(conglomerates)
        .innerJoin(
          shareAudiences,
          and(
            eq(shareAudiences.kind, 'conglomerate'),
            eq(shareAudiences.subjectId, conglomerates.id),
            eq(shareAudiences.audience, 'public_link'),
          ),
        )
        .where(eq(conglomerates.ownerId, ownerId))
        .orderBy(asc(conglomerates.name));
    },

    async listPublicWatchlists(
      ownerId: string,
    ): Promise<{ watchlistId: string; name: string; itemCount: number }[]> {
      return db
        .select({
          watchlistId: watchlists.id,
          name: watchlists.name,
          itemCount: sql<number>`(
            select count(*) from ${workboardItems}
            where ${workboardItems.watchlistId} = ${watchlists.id}
          )`.mapWith(Number),
        })
        .from(watchlists)
        .innerJoin(
          shareAudiences,
          and(
            eq(shareAudiences.kind, 'watchlist'),
            eq(shareAudiences.subjectId, watchlists.id),
            eq(shareAudiences.audience, 'public_link'),
          ),
        )
        .where(eq(watchlists.userId, ownerId))
        .orderBy(asc(watchlists.name));
    },

    /**
     * Authorize a logged-out drill-in to ONE of the owner's public items — the
     * subject must be owned by `ownerId`, its audience `public_link`, and it must
     * be live. Returns its display name, or `undefined` (→ 404). The same
     * `public_link` gate as the profile listing, so a non-public item 404s.
     */
    async authorizePublicItemRead(
      ownerId: string,
      kind: ShareKind,
      subjectId: string,
    ): Promise<{ name: string } | undefined> {
      // Ideas are not surfaced on the public profile / logged-out drill-in (V4-P9
      // ships them as a friend-shareable + clone kind; a public read-only idea
      // view is a follow-up web surface). A public idea is reachable by friends +
      // followers, never as an anonymous public-profile item — so this 404s.
      if (kind === 'idea') return undefined;
      if (kind === 'portfolio') {
        const [row] = await db
          .select({ name: portfolios.name })
          .from(portfolios)
          .innerJoin(
            shareAudiences,
            and(
              eq(shareAudiences.kind, 'portfolio'),
              eq(shareAudiences.subjectId, portfolios.id),
              eq(shareAudiences.audience, 'public_link'),
            ),
          )
          .where(
            and(
              eq(portfolios.id, subjectId),
              eq(portfolios.userId, ownerId),
              isNull(portfolios.archivedAt),
              isNull(portfolios.vaultId),
            ),
          )
          .limit(1);
        return row;
      }
      if (kind === 'conglomerate') {
        const [row] = await db
          .select({ name: conglomerates.name })
          .from(conglomerates)
          .innerJoin(
            shareAudiences,
            and(
              eq(shareAudiences.kind, 'conglomerate'),
              eq(shareAudiences.subjectId, conglomerates.id),
              eq(shareAudiences.audience, 'public_link'),
            ),
          )
          .where(and(eq(conglomerates.id, subjectId), eq(conglomerates.ownerId, ownerId)))
          .limit(1);
        return row;
      }
      const [row] = await db
        .select({ name: watchlists.name })
        .from(watchlists)
        .innerJoin(
          shareAudiences,
          and(
            eq(shareAudiences.kind, 'watchlist'),
            eq(shareAudiences.subjectId, watchlists.id),
            eq(shareAudiences.audience, 'public_link'),
          ),
        )
        .where(and(eq(watchlists.id, subjectId), eq(watchlists.userId, ownerId)))
        .limit(1);
      return row;
    },

    /**
     * Resolve one subject as a PUBLICLY followable item (#439) — no viewer, so
     * the gate is: subject live, owner active, audience `public_link`, AND the
     * owner's public profile enabled (the only route a non-friend follower has
     * to the item is `/u/:username`, mirroring the #438 reachability gate — a
     * public item without a live profile is link-only and not followable).
     * Returns the owner + display name, or `undefined`.
     */
    async publicFollowTarget(
      kind: ShareKind,
      subjectId: string,
    ): Promise<NamedOwnerRef | undefined> {
      // Ideas are not item-followable (V4-P9 out-of-scope; only follow.published
      // fan-out applies), so there is no public follow target for an idea.
      if (kind === 'idea') return undefined;
      const publicAudience = and(
        eq(shareAudiences.kind, kind),
        eq(shareAudiences.audience, 'public_link'),
      );
      const liveOwner = (ownerCol: AnyPgColumn) =>
        and(eq(users.id, ownerCol), eq(users.status, 'active'), eq(users.profilePublic, true));
      if (kind === 'portfolio') {
        const [row] = await db
          .select({
            ownerId: portfolios.userId,
            ownerUsername: users.username,
            ownerProfileIcon: users.profileIcon,
            name: portfolios.name,
          })
          .from(portfolios)
          .innerJoin(users, liveOwner(portfolios.userId))
          .innerJoin(
            shareAudiences,
            and(eq(shareAudiences.subjectId, portfolios.id), publicAudience),
          )
          .where(
            and(
              eq(portfolios.id, subjectId),
              isNull(portfolios.archivedAt),
              isNull(portfolios.vaultId),
            ),
          )
          .limit(1);
        return row;
      }
      if (kind === 'conglomerate') {
        const [row] = await db
          .select({
            ownerId: conglomerates.ownerId,
            ownerUsername: users.username,
            ownerProfileIcon: users.profileIcon,
            name: conglomerates.name,
          })
          .from(conglomerates)
          .innerJoin(users, liveOwner(conglomerates.ownerId))
          .innerJoin(
            shareAudiences,
            and(eq(shareAudiences.subjectId, conglomerates.id), publicAudience),
          )
          .where(eq(conglomerates.id, subjectId))
          .limit(1);
        return row;
      }
      const [row] = await db
        .select({
          ownerId: watchlists.userId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
          name: watchlists.name,
        })
        .from(watchlists)
        .innerJoin(users, liveOwner(watchlists.userId))
        .innerJoin(shareAudiences, and(eq(shareAudiences.subjectId, watchlists.id), publicAudience))
        .where(eq(watchlists.id, subjectId))
        .limit(1);
      return row;
    },

    // ── Read authorization — public-link mode (token, no friendship) ────────

    /**
     * Resolve a public-link token HASH to its subject, or `undefined`. Requires
     * the link be un-revoked AND the audience still be `public_link` AND the
     * owner active — so revoking the link, or narrowing the audience, kills every
     * outstanding token instantly (§14). Subject liveness is checked afterwards
     * per kind by {@link getSubjectIdentity}, so a deleted subject 404s too.
     */
    async resolvePublicLink(tokenHash: string): Promise<PublicLinkTarget | undefined> {
      const [row] = await db
        .select({
          kind: shareAudiences.kind,
          subjectId: shareAudiences.subjectId,
          ownerId: shareAudiences.ownerId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
        })
        .from(shareAudienceLinks)
        .innerJoin(
          shareAudiences,
          and(
            eq(shareAudiences.id, shareAudienceLinks.audienceId),
            eq(shareAudiences.audience, 'public_link'),
          ),
        )
        .innerJoin(users, and(eq(users.id, shareAudiences.ownerId), eq(users.status, 'active')))
        .where(
          and(eq(shareAudienceLinks.tokenHash, tokenHash), isNull(shareAudienceLinks.revokedAt)),
        )
        .limit(1);
      return row;
    },

    /**
     * The subject's display name iff it is live for sharing — a portfolio that
     * exists and is not archived, or a conglomerate / watchlist that exists.
     * `undefined` otherwise (→ 404). The final liveness gate for public-link
     * reads on top of {@link resolvePublicLink}.
     */
    async getSubjectIdentity(
      kind: ShareKind,
      subjectId: string,
    ): Promise<{ name: string } | undefined> {
      if (kind === 'idea') {
        const [row] = await db
          .select({ name: ideas.name })
          .from(ideas)
          .where(eq(ideas.id, subjectId))
          .limit(1);
        return row;
      }
      if (kind === 'portfolio') {
        const [row] = await db
          .select({ name: portfolios.name })
          .from(portfolios)
          .where(
            and(
              eq(portfolios.id, subjectId),
              isNull(portfolios.archivedAt),
              isNull(portfolios.vaultId),
            ),
          )
          .limit(1);
        return row;
      }
      if (kind === 'conglomerate') {
        const [row] = await db
          .select({ name: conglomerates.name })
          .from(conglomerates)
          .where(eq(conglomerates.id, subjectId))
          .limit(1);
        return row;
      }
      const [row] = await db
        .select({ name: watchlists.name })
        .from(watchlists)
        .where(eq(watchlists.id, subjectId))
        .limit(1);
      return row;
    },

    /** Authoritative owner lookup for multi-principal privacy guards. */
    async getSubjectOwner(kind: ShareKind, subjectId: string): Promise<string | undefined> {
      if (kind === 'idea') {
        const [row] = await db
          .select({ ownerId: ideas.ownerId })
          .from(ideas)
          .where(eq(ideas.id, subjectId))
          .limit(1);
        return row?.ownerId;
      }
      if (kind === 'portfolio') {
        const [row] = await db
          .select({ ownerId: portfolios.userId })
          .from(portfolios)
          .where(eq(portfolios.id, subjectId))
          .limit(1);
        return row?.ownerId;
      }
      if (kind === 'conglomerate') {
        const [row] = await db
          .select({ ownerId: conglomerates.ownerId })
          .from(conglomerates)
          .where(eq(conglomerates.id, subjectId))
          .limit(1);
        return row?.ownerId;
      }
      const [row] = await db
        .select({ ownerId: watchlists.userId })
        .from(watchlists)
        .where(eq(watchlists.id, subjectId))
        .limit(1);
      return row?.ownerId;
    },

    // ── Owner-facing audience management ────────────────────────────────────

    /**
     * Whether `ownerId` owns the (kind, subjectId) subject. Used to gate every
     * audience mutation so a foreign/unknown subject 404s (no IDOR, §8).
     */
    async ownsSubject(ownerId: string, kind: ShareKind, subjectId: string): Promise<boolean> {
      if (kind === 'idea') {
        const [row] = await db
          .select({ id: ideas.id })
          .from(ideas)
          .where(and(eq(ideas.id, subjectId), eq(ideas.ownerId, ownerId)))
          .limit(1);
        return row !== undefined;
      }
      if (kind === 'portfolio') {
        const [row] = await db
          .select({ id: portfolios.id })
          .from(portfolios)
          .where(
            and(
              eq(portfolios.id, subjectId),
              eq(portfolios.userId, ownerId),
              isNull(portfolios.vaultId),
            ),
          )
          .limit(1);
        return row !== undefined;
      }
      if (kind === 'conglomerate') {
        const [row] = await db
          .select({ id: conglomerates.id })
          .from(conglomerates)
          .where(and(eq(conglomerates.id, subjectId), eq(conglomerates.ownerId, ownerId)))
          .limit(1);
        return row !== undefined;
      }
      const [row] = await db
        .select({ id: watchlists.id })
        .from(watchlists)
        .where(and(eq(watchlists.id, subjectId), eq(watchlists.userId, ownerId)))
        .limit(1);
      return row !== undefined;
    },

    /**
     * The current audience per subject, for a batch of same-kind subjects
     * (missing row = `private`) — one query for a list view, no N+1.
     */
    async audiencesForSubjects(
      kind: ShareKind,
      subjectIds: readonly string[],
    ): Promise<Map<string, ShareAudience>> {
      const out = new Map<string, ShareAudience>();
      if (subjectIds.length === 0) return out;
      const rows = await db
        .select({ subjectId: shareAudiences.subjectId, audience: shareAudiences.audience })
        .from(shareAudiences)
        .where(
          and(eq(shareAudiences.kind, kind), inArray(shareAudiences.subjectId, [...subjectIds])),
        );
      for (const r of rows) out.set(r.subjectId, r.audience);
      return out;
    },

    /**
     * Per-subject audience + reach summary, for a same-kind batch (missing row =
     * `private`, 0 friends) — feeds the "who can see this" summary in **My Shared
     * Items** without an N+1. One grouped query over the audience rows, their
     * membership set and, for a `group` audience, the referenced circle.
     *
     * The group's roster size is counted LIVE from `friend_group_members` here,
     * off the same rows {@link audienceGrants} authorizes against — so editing a
     * circle changes the reported reach on the very next read and the owner
     * surface can never claim a reach the enforcement layer doesn't grant.
     *
     * Both counts carry the SAME extra joins enforcement applies, because a
     * count without them is exactly the disagreement this summary exists to
     * prevent (#1710): a named friend is counted only while the friendship still
     * exists (a membership row outliving an unfriend grants nothing, since every
     * read `AND`s an inner join on `friendships`), and a circle member only
     * while their account is active (a disabled account cannot sign in, and
     * every read joins `users.status = 'active'`). `friend_group_members` is
     * joined the same way `friendGroupRepository` joins it, so `GET
     * /social/groups` and this summary can never report different sizes for one
     * circle.
     *
     * `group` is `null` for a non-`group` audience AND for a `group` share whose
     * group was deleted (`group_id` nulls out; the share then resolves to
     * nobody). With the audience beside it, the owner surface distinguishes
     * "not a group share" from "group gone" from a populated / empty circle.
     *
     * Both counts are correlated subqueries rather than joins + `count(distinct
     * …)`: one row per audience row, so neither count can inflate on the other's
     * product and neither needs a GROUP BY.
     */
    async audienceSummariesForSubjects(
      kind: ShareKind,
      subjectIds: readonly string[],
    ): Promise<Map<string, AudienceReachSummary>> {
      const out = new Map<string, AudienceReachSummary>();
      if (subjectIds.length === 0) return out;
      const rows = await db
        .select({
          subjectId: shareAudiences.subjectId,
          audience: shareAudiences.audience,
          groupId: friendGroups.id,
          groupName: friendGroups.name,
          friendCount: sql<number>`(
            select count(*)
            from ${shareAudienceMembers}
            join ${friendships} on (
              (${friendships.userA} = ${shareAudiences.ownerId}
                and ${friendships.userB} = ${shareAudienceMembers.friendId})
              or (${friendships.userB} = ${shareAudiences.ownerId}
                and ${friendships.userA} = ${shareAudienceMembers.friendId})
            )
            where ${shareAudienceMembers.audienceId} = ${shareAudiences.id}
              and ${shareAudiences.audience} = 'specific_friends'
          )`.mapWith(Number),
          groupMemberCount: sql<number>`(
            select count(*)
            from ${friendGroupMembers}
            join ${users} on ${users.id} = ${friendGroupMembers.memberId}
              and ${users.status} = 'active'
            where ${friendGroupMembers.groupId} = ${friendGroups.id}
          )`.mapWith(Number),
        })
        .from(shareAudiences)
        .leftJoin(friendGroups, eq(friendGroups.id, shareAudiences.groupId))
        .where(
          and(eq(shareAudiences.kind, kind), inArray(shareAudiences.subjectId, [...subjectIds])),
        );
      for (const r of rows)
        out.set(r.subjectId, {
          audience: r.audience,
          friendCount: r.friendCount,
          group:
            r.audience === 'group' && r.groupId !== null && r.groupName !== null
              ? { id: r.groupId, name: r.groupName, memberCount: r.groupMemberCount }
              : null,
        });
      return out;
    },

    /**
     * The current owner-facing audience state for one subject (missing row =
     * private).
     *
     * The membership read joins `friendships` exactly like the enforcement layer
     * does (#1710): a `specific_friends` row whose friendship has since
     * dissolved grants nothing, so naming it here would tell the owner — and the
     * picker, which cannot resolve the id against the friends list and silently
     * drops the checkbox — that someone can see the item when they cannot.
     */
    async getOwnedState(kind: ShareKind, subjectId: string): Promise<OwnedAudienceState> {
      const [row] = await db
        .select({
          id: shareAudiences.id,
          ownerId: shareAudiences.ownerId,
          audience: shareAudiences.audience,
          groupId: shareAudiences.groupId,
        })
        .from(shareAudiences)
        .where(and(eq(shareAudiences.kind, kind), eq(shareAudiences.subjectId, subjectId)))
        .limit(1);
      if (!row)
        return {
          audience: 'private',
          friendIds: [],
          groupId: null,
          link: { active: false, createdAt: null },
        };

      const members = await db
        .select({ friendId: shareAudienceMembers.friendId })
        .from(shareAudienceMembers)
        .innerJoin(friendships, friendshipWith(row.ownerId, shareAudienceMembers.friendId))
        .where(eq(shareAudienceMembers.audienceId, row.id));

      const [link] = await db
        .select({ createdAt: shareAudienceLinks.createdAt })
        .from(shareAudienceLinks)
        .where(and(eq(shareAudienceLinks.audienceId, row.id), isNull(shareAudienceLinks.revokedAt)))
        .orderBy(sql`${shareAudienceLinks.createdAt} desc`)
        .limit(1);

      return {
        audience: row.audience,
        // Broad-mode rows are transition exclusions, not owner-selected members.
        friendIds: row.audience === 'specific_friends' ? members.map((m) => m.friendId) : [],
        // A `group` audience carries its live reference; every other rung is null.
        groupId: row.audience === 'group' ? row.groupId : null,
        link: { active: link !== undefined, createdAt: link?.createdAt ?? null },
      };
    },

    /**
     * The subset of `candidateIds` that are actually the owner's current friends
     * — so a `specific_friends` audience can never name a non-friend (defense in
     * depth for the enforcement join, and it keeps the stored set honest).
     */
    async friendIdsOf(ownerId: string, candidateIds: readonly string[]): Promise<string[]> {
      if (candidateIds.length === 0) return [];
      const rows = await db
        .select({ userA: friendships.userA, userB: friendships.userB })
        .from(friendships)
        .where(or(eq(friendships.userA, ownerId), eq(friendships.userB, ownerId)));
      const friendSet = new Set(rows.map((r) => (r.userA === ownerId ? r.userB : r.userA)));
      return candidateIds.filter((id) => friendSet.has(id));
    },

    /**
     * Upsert the audience row + replace its membership, in one transaction.
     * Moving to any audience other than `public_link` REVOKES every active link
     * for the subject (so widening→narrowing kills outstanding tokens instantly).
     * Returns the audience row id so the service can mint a link when needed.
     */
    async setAudience(
      ownerId: string,
      kind: ShareKind,
      subjectId: string,
      audience: ShareAudience,
      memberFriendIds: readonly string[],
      groupId: string | null = null,
    ): Promise<string> {
      // The `group` reference is stored only when the audience is `group`; every
      // other rung clears it, so a later widen/narrow can't leave a stale link.
      const groupRef = audience === 'group' ? groupId : null;
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: shareAudiences.id })
          .from(shareAudiences)
          .where(and(eq(shareAudiences.kind, kind), eq(shareAudiences.subjectId, subjectId)))
          .limit(1);

        let audienceId: string;
        if (existing) {
          audienceId = existing.id;
          await tx
            .update(shareAudiences)
            .set({ audience, groupId: groupRef, updatedAt: new Date() })
            .where(eq(shareAudiences.id, audienceId));
        } else {
          const [inserted] = await tx
            .insert(shareAudiences)
            .values({ ownerId, kind, subjectId, audience, groupId: groupRef })
            .returning({ id: shareAudiences.id });
          audienceId = inserted!.id;
        }

        await tx
          .delete(shareAudienceMembers)
          .where(eq(shareAudienceMembers.audienceId, audienceId));
        if (audience === 'specific_friends' && memberFriendIds.length > 0) {
          await tx
            .insert(shareAudienceMembers)
            .values(memberFriendIds.map((friendId) => ({ audienceId, friendId })));
        }

        if (audience !== 'public_link') {
          await tx
            .update(shareAudienceLinks)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(shareAudienceLinks.audienceId, audienceId),
                isNull(shareAudienceLinks.revokedAt),
              ),
            );
        }

        // Mirror the coarse legacy `visibility` column (private | friends) so the
        // pre-V3-P5 display fields stay coherent. Enforcement never reads this
        // column — the audience row above is the single source of truth — but the
        // portfolio/conglomerate summaries still surface it, and keeping it in
        // lockstep means "shared?" is right everywhere. Watchlists have no such
        // column (the old flag lived on `users`), so nothing to mirror there.
        const legacyVisibility = audience === 'private' ? 'private' : 'friends';
        if (kind === 'portfolio') {
          await tx
            .update(portfolios)
            .set({ visibility: legacyVisibility })
            .where(eq(portfolios.id, subjectId));
        } else if (kind === 'conglomerate') {
          await tx
            .update(conglomerates)
            .set({ visibility: legacyVisibility, updatedAt: new Date() })
            .where(eq(conglomerates.id, subjectId));
        }
        return audienceId;
      });
    },

    /** Whether the audience currently has a live (un-revoked) public link. */
    async hasActiveLink(audienceId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: shareAudienceLinks.id })
        .from(shareAudienceLinks)
        .where(
          and(eq(shareAudienceLinks.audienceId, audienceId), isNull(shareAudienceLinks.revokedAt)),
        )
        .limit(1);
      return row !== undefined;
    },

    /** Mint a new public link (only the hash is stored). Caller holds the raw token. */
    async insertLink(audienceId: string, tokenHash: string): Promise<void> {
      await db.insert(shareAudienceLinks).values({ audienceId, tokenHash });
    },

    /**
     * Delete everything keyed to a deleted subject: its audience row (cascading
     * members + links) AND its social conversation — every `item_comments` row
     * and every `item_reactions` row, item- and comment-targeted alike.
     *
     * The subject columns are polymorphic (no FK, no cascade), so without this
     * purge a comment on a deleted portfolio would outlive its item forever and
     * become undeletable through the API — the owner is gone, so moderation can
     * no longer resolve one (§13.5 V5-P8). Comments are HARD-deleted here: the
     * tombstone exists to make moderation auditable on a live item, and there is
     * no live item left. Comment reactions go first — `item_reactions.comment_id`
     * cascades, but deleting them explicitly keeps the purge independent of that.
     *
     * All four statements run in ONE transaction: a failure between them would
     * otherwise leave a half-purged subject — e.g. comments gone but the audience
     * row still live, or the reverse — with no second caller to finish the job.
     */
    async clearForSubject(kind: ShareKind, subjectId: string): Promise<void> {
      await db.transaction(async (tx) => {
        // A subquery, not a materialized id list: a long thread must not turn its
        // teardown into a 20 000-element IN clause.
        await tx.delete(itemReactions).where(
          inArray(
            itemReactions.commentId,
            tx
              .select({ id: itemComments.id })
              .from(itemComments)
              .where(and(eq(itemComments.kind, kind), eq(itemComments.subjectId, subjectId))),
          ),
        );
        await tx
          .delete(itemComments)
          .where(and(eq(itemComments.kind, kind), eq(itemComments.subjectId, subjectId)));
        await tx
          .delete(itemReactions)
          .where(
            and(
              eq(itemReactions.targetType, 'item'),
              eq(itemReactions.kind, kind),
              eq(itemReactions.subjectId, subjectId),
            ),
          );
        await tx
          .delete(shareAudiences)
          .where(and(eq(shareAudiences.kind, kind), eq(shareAudiences.subjectId, subjectId)));
      });
    },
  };
}

export type ShareAudienceRepository = ReturnType<typeof createShareAudienceRepository>;
