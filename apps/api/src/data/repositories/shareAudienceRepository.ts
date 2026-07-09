import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import type { ShareAudience, ShareKind } from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  conglomerates,
  friendships,
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
 */

/** Public-safe owner identity returned by every authorization query (§6.9). */
export interface OwnerRef {
  ownerId: string;
  ownerUsername: string;
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

/** The owner-facing audience state for one subject (feeds the AudiencePicker). */
export interface OwnedAudienceState {
  audience: ShareAudience;
  friendIds: string[];
  link: { active: boolean; createdAt: Date | null };
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
   * friends), or `specific_friends` with the viewer in the membership set. It is
   * ALWAYS combined with a friendship join by the caller, so `private` — and any
   * audience the viewer isn't named in — grants nothing.
   */
  function audienceGrants(viewerId: string) {
    return sql`(
      ${shareAudiences.audience} in ('all_friends', 'public_link')
      or (
        ${shareAudiences.audience} = 'specific_friends'
        and exists (
          select 1 from ${shareAudienceMembers}
          where ${shareAudienceMembers.audienceId} = ${shareAudiences.id}
            and ${shareAudienceMembers.friendId} = ${viewerId}
        )
      )
    )`;
  }

  /** Friendship-exists predicate between the viewer and a subject-owner column. */
  function friendshipWith(viewerId: string, ownerCol: AnyPgColumn) {
    return or(
      and(eq(friendships.userA, viewerId), eq(friendships.userB, ownerCol)),
      and(eq(friendships.userB, viewerId), eq(friendships.userA, ownerCol)),
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
        .select({ ownerId: conglomerates.ownerId, ownerUsername: users.username })
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

    // ── Shared With Me listings (same authorization, as a set) ──────────────

    async listFriendPortfolios(viewerId: string): Promise<FriendPortfolioRow[]> {
      return db
        .select({
          portfolioId: portfolios.id,
          name: portfolios.name,
          ownerId: portfolios.userId,
          ownerUsername: users.username,
        })
        .from(portfolios)
        .innerJoin(users, and(eq(users.id, portfolios.userId), eq(users.status, 'active')))
        .innerJoin(
          shareAudiences,
          and(eq(shareAudiences.kind, 'portfolio'), eq(shareAudiences.subjectId, portfolios.id)),
        )
        .innerJoin(friendships, friendshipWith(viewerId, portfolios.userId))
        .where(and(isNull(portfolios.archivedAt), audienceGrants(viewerId)))
        .orderBy(asc(users.username), asc(portfolios.name));
    },

    async listFriendConglomerates(viewerId: string): Promise<FriendConglomerateRow[]> {
      return db
        .select({
          conglomerateId: conglomerates.id,
          name: conglomerates.name,
          status: conglomerates.status,
          ownerId: conglomerates.ownerId,
          ownerUsername: users.username,
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
        .where(audienceGrants(viewerId))
        .orderBy(asc(users.username), asc(conglomerates.name));
    },

    async listFriendWatchlists(viewerId: string): Promise<FriendWatchlistRow[]> {
      return db
        .select({
          watchlistId: watchlists.id,
          name: watchlists.name,
          ownerId: watchlists.userId,
          ownerUsername: users.username,
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
        .where(audienceGrants(viewerId))
        .orderBy(asc(users.username), asc(watchlists.name));
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
        .where(and(eq(portfolios.userId, ownerId), isNull(portfolios.archivedAt)))
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
      if (kind === 'portfolio') {
        const [row] = await db
          .select({ name: portfolios.name })
          .from(portfolios)
          .where(and(eq(portfolios.id, subjectId), isNull(portfolios.archivedAt)))
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

    // ── Owner-facing audience management ────────────────────────────────────

    /**
     * Whether `ownerId` owns the (kind, subjectId) subject. Used to gate every
     * audience mutation so a foreign/unknown subject 404s (no IDOR, §8).
     */
    async ownsSubject(ownerId: string, kind: ShareKind, subjectId: string): Promise<boolean> {
      if (kind === 'portfolio') {
        const [row] = await db
          .select({ id: portfolios.id })
          .from(portfolios)
          .where(and(eq(portfolios.id, subjectId), eq(portfolios.userId, ownerId)))
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
     * Per-subject audience + named-friend count, for a same-kind batch (missing
     * row = `private`, 0 friends) — feeds the "who can see this" summary in **My
     * Shared Items** without an N+1. One grouped query over the audience rows and
     * their membership set.
     */
    async audienceSummariesForSubjects(
      kind: ShareKind,
      subjectIds: readonly string[],
    ): Promise<Map<string, { audience: ShareAudience; friendCount: number }>> {
      const out = new Map<string, { audience: ShareAudience; friendCount: number }>();
      if (subjectIds.length === 0) return out;
      const rows = await db
        .select({
          subjectId: shareAudiences.subjectId,
          audience: shareAudiences.audience,
          friendCount: sql<number>`count(${shareAudienceMembers.friendId})`.mapWith(Number),
        })
        .from(shareAudiences)
        .leftJoin(shareAudienceMembers, eq(shareAudienceMembers.audienceId, shareAudiences.id))
        .where(
          and(eq(shareAudiences.kind, kind), inArray(shareAudiences.subjectId, [...subjectIds])),
        )
        .groupBy(shareAudiences.id, shareAudiences.subjectId, shareAudiences.audience);
      for (const r of rows)
        out.set(r.subjectId, { audience: r.audience, friendCount: r.friendCount });
      return out;
    },

    /** The current owner-facing audience state for one subject (missing row = private). */
    async getOwnedState(kind: ShareKind, subjectId: string): Promise<OwnedAudienceState> {
      const [row] = await db
        .select({ id: shareAudiences.id, audience: shareAudiences.audience })
        .from(shareAudiences)
        .where(and(eq(shareAudiences.kind, kind), eq(shareAudiences.subjectId, subjectId)))
        .limit(1);
      if (!row)
        return { audience: 'private', friendIds: [], link: { active: false, createdAt: null } };

      const members = await db
        .select({ friendId: shareAudienceMembers.friendId })
        .from(shareAudienceMembers)
        .where(eq(shareAudienceMembers.audienceId, row.id));

      const [link] = await db
        .select({ createdAt: shareAudienceLinks.createdAt })
        .from(shareAudienceLinks)
        .where(and(eq(shareAudienceLinks.audienceId, row.id), isNull(shareAudienceLinks.revokedAt)))
        .orderBy(sql`${shareAudienceLinks.createdAt} desc`)
        .limit(1);

      return {
        audience: row.audience,
        friendIds: members.map((m) => m.friendId),
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
    ): Promise<string> {
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
            .set({ audience, updatedAt: new Date() })
            .where(eq(shareAudiences.id, audienceId));
        } else {
          const [inserted] = await tx
            .insert(shareAudiences)
            .values({ ownerId, kind, subjectId, audience })
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
     * Delete the audience row for a subject (cascades members + links) — called
     * when the subject itself is deleted, so no orphan row lingers. Safety net
     * only: the authorization joins already exclude a vanished subject.
     */
    async clearForSubject(kind: ShareKind, subjectId: string): Promise<void> {
      await db
        .delete(shareAudiences)
        .where(and(eq(shareAudiences.kind, kind), eq(shareAudiences.subjectId, subjectId)));
    },
  };
}

export type ShareAudienceRepository = ReturnType<typeof createShareAudienceRepository>;
