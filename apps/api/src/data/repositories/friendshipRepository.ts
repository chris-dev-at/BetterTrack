import { and, asc, eq, gte, isNull, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { Database } from '../db';
import {
  conglomeratePositions,
  conglomerates,
  friendRequests,
  friendships,
  portfolios,
  users,
  workboardItems,
} from '../schema';
import type { FriendRequestRow } from '../schema';

/**
 * Social-graph SQL (PROJECTPLAN.md §5.5, §6.9). All queries for
 * `friend_requests` + `friendships` live here; the service holds the rules.
 *
 * Two invariants are enforced at the SQL layer so authorization can never be
 * cached or bypassed:
 *  - Acting on a request (accept/decline/cancel) is filtered by both the
 *    `pending` status **and** the acting user's role (recipient for
 *    accept/decline, sender for cancel) in one `UPDATE … WHERE`; a row that
 *    isn't yours or isn't pending simply isn't updated, so the service 404s
 *    without a separate ownership read (no info leak, §6.9).
 *  - Friendships are stored once per pair with the canonical ordering
 *    `user_a < user_b`, so a pair is a single row regardless of who asked.
 */

/** One pending request as seen from a viewer's inbox/outbox — the *other* party embedded. */
export interface PendingRequestRow {
  id: string;
  direction: 'incoming' | 'outgoing';
  otherUserId: string;
  otherUsername: string;
  otherProfileIcon: string | null;
  createdAt: Date;
  respondedAt: Date | null;
}

/** One established friendship as seen from a viewer — the *other* party + when it formed. */
export interface FriendRow {
  id: string;
  username: string;
  profileIcon: string | null;
  createdAt: Date;
}

/** A friend's portfolio exposed via `visibility='friends'` — owner + portfolio identity only. */
export interface SharedPortfolioRow {
  portfolioId: string;
  name: string;
  ownerId: string;
  ownerUsername: string;
  ownerProfileIcon: string | null;
}

/** A friend's conglomerate exposed via `visibility='friends'` (§13.2 V2-P9). */
export interface SharedConglomerateRow {
  conglomerateId: string;
  name: string;
  status: 'draft' | 'active';
  ownerId: string;
  ownerUsername: string;
  ownerProfileIcon: string | null;
  positionCount: number;
}

/** A friend's watchlist exposed via `watchlist_visibility='friends'` (§13.2 V2-P9). */
export interface SharedWatchlistRow {
  ownerId: string;
  ownerUsername: string;
  ownerProfileIcon: string | null;
  itemCount: number;
}

/** Canonical pair ordering (§6.9): a friendship row is always stored `user_a < user_b`. */
function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function createFriendshipRepository(db: Database) {
  return {
    /**
     * Resolve a target by exact username **or** email (both case-insensitive),
     * returning the `id` only — never the row — so the caller can't leak any
     * other field (§6.9 no-enumeration). `undefined` when nothing matches.
     *
     * Admin (`role='admin'`) and disabled (`status='disabled'`) accounts are
     * excluded so they resolve exactly like "no account": an admin/disabled
     * target is unrequestable and never appears in the sender's outbox, closing
     * the enumeration oracle where a guessed admin email would otherwise leak the
     * target's username (and where an admin could never accept a pending row).
     */
    async findUserIdByIdentifier(identifier: string): Promise<string | undefined> {
      const needle = identifier.trim().toLowerCase();
      if (needle.length === 0) return undefined;
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            or(eq(users.email, needle), sql`lower(${users.username}) = ${needle}`),
            ne(users.role, 'admin'),
            eq(users.status, 'active'),
          ),
        )
        .limit(1);
      return row?.id;
    },

    /**
     * Whether `fromUser` has a request to `toUser` that was **declined** at or
     * after `since` — the decline-cooldown probe (§6.9 hardening). A declined
     * request frees the pending-pair index, so without this a rejected sender
     * could re-request (and re-notify) immediately and indefinitely; the service
     * treats a positive result as a silent no-op, indistinguishable from any
     * other no-enumeration branch.
     */
    async hasDeclinedSince(fromUser: string, toUser: string, since: Date): Promise<boolean> {
      const [row] = await db
        .select({ id: friendRequests.id })
        .from(friendRequests)
        .where(
          and(
            eq(friendRequests.fromUser, fromUser),
            eq(friendRequests.toUser, toUser),
            eq(friendRequests.status, 'declined'),
            gte(friendRequests.respondedAt, since),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    /** A `pending` request in the given direction, if one exists. */
    async findPendingRequest(
      fromUser: string,
      toUser: string,
    ): Promise<FriendRequestRow | undefined> {
      const [row] = await db
        .select()
        .from(friendRequests)
        .where(
          and(
            eq(friendRequests.fromUser, fromUser),
            eq(friendRequests.toUser, toUser),
            eq(friendRequests.status, 'pending'),
          ),
        )
        .limit(1);
      return row;
    },

    /**
     * Every portfolio owned by one of the viewer's friends that is currently at
     * `visibility='friends'` — the **Shared With Me** set (§6.9). Authorization
     * *is* the join: a row appears only while both an established friendship and
     * the owner's friends-visibility hold, so there is nothing to cache and
     * revoking either instantly drops it. Ordered by owner then portfolio name.
     */
    async listSharedWithViewer(viewerId: string): Promise<SharedPortfolioRow[]> {
      const rows = await db
        .select({
          portfolioId: portfolios.id,
          name: portfolios.name,
          ownerId: portfolios.userId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
        })
        .from(friendships)
        .innerJoin(
          portfolios,
          or(
            and(eq(friendships.userA, viewerId), eq(portfolios.userId, friendships.userB)),
            and(eq(friendships.userB, viewerId), eq(portfolios.userId, friendships.userA)),
          ),
        )
        // Owner must still be active: an admin-disabled account's shared
        // portfolios drop out of every friend's view immediately (§6.9).
        .innerJoin(users, and(eq(users.id, portfolios.userId), eq(users.status, 'active')))
        // Archiving a shared portfolio must stop sharing it: an archived
        // portfolio is invisible to its own owner's list, so it must not linger
        // in any friend's Shared With Me (§6.9).
        .where(and(eq(portfolios.visibility, 'friends'), isNull(portfolios.archivedAt)))
        .orderBy(asc(users.username), asc(portfolios.name));
      return rows;
    },

    /**
     * The single friend-shared portfolio the viewer is authorized to read, or
     * `undefined`. One query enforces **both** an existing friendship with the
     * owner **and** the owner's `visibility='friends'`, recomputed per call — no
     * cached authorization (§6.9). A non-friend, a private portfolio, an unknown
     * id, and the viewer's own portfolio (no self-friendship) all return
     * `undefined`, so the service 404s uniformly (never 403, no info leak).
     */
    async findSharedPortfolioForViewer(
      viewerId: string,
      portfolioId: string,
    ): Promise<SharedPortfolioRow | undefined> {
      const [row] = await db
        .select({
          portfolioId: portfolios.id,
          name: portfolios.name,
          ownerId: portfolios.userId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
        })
        .from(portfolios)
        // Owner must still be active: a disabled owner's shared portfolio 404s.
        .innerJoin(users, and(eq(users.id, portfolios.userId), eq(users.status, 'active')))
        .innerJoin(
          friendships,
          or(
            and(eq(friendships.userA, viewerId), eq(friendships.userB, portfolios.userId)),
            and(eq(friendships.userB, viewerId), eq(friendships.userA, portfolios.userId)),
          ),
        )
        // Archived ⇒ treated as private for sharing: a friend can no longer open
        // an archived portfolio even with a live share (§6.9).
        .where(
          and(
            eq(portfolios.id, portfolioId),
            eq(portfolios.visibility, 'friends'),
            isNull(portfolios.archivedAt),
          ),
        )
        .limit(1);
      return row;
    },

    /**
     * Every conglomerate owned by one of the viewer's friends currently at
     * `visibility='friends'` — the conglomerate half of **Shared With Me** (§6.9,
     * V2-P9). Same authorization-is-the-join shape as {@link listSharedWithViewer}:
     * a row appears only while both the friendship and the owner's friends-
     * visibility hold, so revoking either instantly drops it. Ordered by owner
     * then basket name.
     */
    async listSharedConglomeratesWithViewer(viewerId: string): Promise<SharedConglomerateRow[]> {
      const rows = await db
        .select({
          conglomerateId: conglomerates.id,
          name: conglomerates.name,
          status: conglomerates.status,
          ownerId: conglomerates.ownerId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
          positionCount: sql<number>`count(${conglomeratePositions.id})`.mapWith(Number),
        })
        .from(friendships)
        .innerJoin(
          conglomerates,
          or(
            and(eq(friendships.userA, viewerId), eq(conglomerates.ownerId, friendships.userB)),
            and(eq(friendships.userB, viewerId), eq(conglomerates.ownerId, friendships.userA)),
          ),
        )
        .innerJoin(users, and(eq(users.id, conglomerates.ownerId), eq(users.status, 'active')))
        .leftJoin(conglomeratePositions, eq(conglomeratePositions.conglomerateId, conglomerates.id))
        .where(eq(conglomerates.visibility, 'friends'))
        .groupBy(conglomerates.id, users.id)
        .orderBy(asc(users.username), asc(conglomerates.name));
      return rows;
    },

    /**
     * Authorize the viewer to read one friend-shared conglomerate, or `undefined`.
     * One query enforces **both** an existing friendship with the owner **and**
     * the owner's `visibility='friends'`, recomputed per call (§6.9). A non-friend,
     * a private basket, an unknown id, the viewer's own basket (no self-friendship)
     * and a disabled owner all return `undefined` → uniform 404 (never 403).
     */
    async findSharedConglomerateForViewer(
      viewerId: string,
      conglomerateId: string,
    ): Promise<
      | {
          conglomerateId: string;
          ownerId: string;
          ownerUsername: string;
          ownerProfileIcon: string | null;
        }
      | undefined
    > {
      const [row] = await db
        .select({
          conglomerateId: conglomerates.id,
          ownerId: conglomerates.ownerId,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
        })
        .from(conglomerates)
        .innerJoin(users, and(eq(users.id, conglomerates.ownerId), eq(users.status, 'active')))
        .innerJoin(
          friendships,
          or(
            and(eq(friendships.userA, viewerId), eq(friendships.userB, conglomerates.ownerId)),
            and(eq(friendships.userB, viewerId), eq(friendships.userA, conglomerates.ownerId)),
          ),
        )
        .where(and(eq(conglomerates.id, conglomerateId), eq(conglomerates.visibility, 'friends')))
        .limit(1);
      return row;
    },

    /**
     * Every friend of the viewer who currently shares their watchlist
     * (`watchlist_visibility='friends'`) — the watchlist half of **Shared With Me**
     * (§6.9, V2-P9), with the count of watched assets. Authorization is the join;
     * unfriending or turning sharing off drops the row immediately. Ordered by
     * owner username.
     */
    async listSharedWatchlistsWithViewer(viewerId: string): Promise<SharedWatchlistRow[]> {
      const rows = await db
        .select({
          ownerId: users.id,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
          itemCount: sql<number>`count(${workboardItems.id})`.mapWith(Number),
        })
        .from(friendships)
        .innerJoin(
          users,
          and(
            or(
              and(eq(friendships.userA, viewerId), eq(users.id, friendships.userB)),
              and(eq(friendships.userB, viewerId), eq(users.id, friendships.userA)),
            ),
            eq(users.status, 'active'),
            eq(users.watchlistVisibility, 'friends'),
          ),
        )
        .leftJoin(workboardItems, eq(workboardItems.userId, users.id))
        .groupBy(users.id)
        .orderBy(asc(users.username));
      return rows;
    },

    /**
     * Authorize the viewer to read one friend's shared watchlist, or `undefined`.
     * Enforces an existing friendship **and** the owner's
     * `watchlist_visibility='friends'` (owner active), recomputed per call (§6.9).
     * A non-friend, a not-sharing owner, an unknown id, the viewer themself and a
     * disabled owner all return `undefined` → uniform 404 (never 403).
     */
    async findSharedWatchlistOwnerForViewer(
      viewerId: string,
      ownerId: string,
    ): Promise<
      { ownerId: string; ownerUsername: string; ownerProfileIcon: string | null } | undefined
    > {
      const [row] = await db
        .select({
          ownerId: users.id,
          ownerUsername: users.username,
          ownerProfileIcon: users.profileIcon,
        })
        .from(users)
        .innerJoin(
          friendships,
          or(
            and(eq(friendships.userA, viewerId), eq(friendships.userB, users.id)),
            and(eq(friendships.userB, viewerId), eq(friendships.userA, users.id)),
          ),
        )
        .where(
          and(
            eq(users.id, ownerId),
            eq(users.status, 'active'),
            eq(users.watchlistVisibility, 'friends'),
          ),
        )
        .limit(1);
      return row;
    },

    /** Whether the two users are already friends (order-independent). */
    async areFriends(a: string, b: string): Promise<boolean> {
      const [lo, hi] = canonicalPair(a, b);
      const [row] = await db
        .select({ userA: friendships.userA })
        .from(friendships)
        .where(and(eq(friendships.userA, lo), eq(friendships.userB, hi)))
        .limit(1);
      return row !== undefined;
    },

    /**
     * Create a `pending` request. Idempotent against the partial unique index
     * on `(from_user, to_user) WHERE status = 'pending'`: a duplicate in the
     * same direction is a no-op, never a duplicate-key crash (§6.9).
     */
    async createRequest(fromUser: string, toUser: string): Promise<string | null> {
      const [row] = await db
        .insert(friendRequests)
        .values({ fromUser, toUser })
        .onConflictDoNothing()
        .returning({ id: friendRequests.id });
      // `null` when the partial unique index made this a no-op (duplicate pending
      // request in the same direction) — the caller must not re-notify on that.
      return row?.id ?? null;
    },

    /** The username for a user id, or `undefined` when unknown. */
    async getUsername(userId: string): Promise<string | undefined> {
      const [row] = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row?.username;
    },

    /** The caller's pending requests, split by direction, with the other party's username. */
    async listPendingForUser(userId: string): Promise<PendingRequestRow[]> {
      const sender = alias(users, 'sender');
      const recipient = alias(users, 'recipient');
      const rows = await db
        .select({
          id: friendRequests.id,
          fromUser: friendRequests.fromUser,
          toUser: friendRequests.toUser,
          createdAt: friendRequests.createdAt,
          respondedAt: friendRequests.respondedAt,
          fromUsername: sender.username,
          toUsername: recipient.username,
          fromProfileIcon: sender.profileIcon,
          toProfileIcon: recipient.profileIcon,
        })
        .from(friendRequests)
        .innerJoin(sender, eq(sender.id, friendRequests.fromUser))
        .innerJoin(recipient, eq(recipient.id, friendRequests.toUser))
        .where(
          and(
            eq(friendRequests.status, 'pending'),
            or(eq(friendRequests.fromUser, userId), eq(friendRequests.toUser, userId)),
          ),
        )
        .orderBy(friendRequests.createdAt);

      return rows.map((r) => {
        const incoming = r.toUser === userId;
        return {
          id: r.id,
          direction: incoming ? 'incoming' : 'outgoing',
          otherUserId: incoming ? r.fromUser : r.toUser,
          otherUsername: incoming ? r.fromUsername : r.toUsername,
          otherProfileIcon: incoming ? r.fromProfileIcon : r.toProfileIcon,
          createdAt: r.createdAt,
          respondedAt: r.respondedAt,
        };
      });
    },

    /**
     * Accept a pending request addressed to `toUserId`. Transitions the request
     * to `accepted` and creates the canonical friendship in one transaction.
     * Returns `null` — so the service 404s — when the request doesn't exist,
     * isn't pending, or isn't addressed to this user (no 403, no info leak). On
     * success returns the original requester (`fromUser`) so the caller can
     * notify them their request was accepted (§6.10).
     */
    async acceptRequest(toUserId: string, requestId: string): Promise<{ fromUser: string } | null> {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(friendRequests)
          .set({ status: 'accepted', respondedAt: new Date() })
          .where(
            and(
              eq(friendRequests.id, requestId),
              eq(friendRequests.toUser, toUserId),
              eq(friendRequests.status, 'pending'),
            ),
          )
          .returning({ fromUser: friendRequests.fromUser, toUser: friendRequests.toUser });
        const req = updated[0];
        if (!req) return null;
        const [lo, hi] = canonicalPair(req.fromUser, req.toUser);
        await tx.insert(friendships).values({ userA: lo, userB: hi }).onConflictDoNothing();
        return { fromUser: req.fromUser };
      });
    },

    /**
     * Decline a pending request addressed to `toUserId` (terminal, no
     * friendship). Returns `false` (→ 404) when not pending/not the recipient.
     */
    async declineRequest(toUserId: string, requestId: string): Promise<boolean> {
      const updated = await db
        .update(friendRequests)
        .set({ status: 'declined', respondedAt: new Date() })
        .where(
          and(
            eq(friendRequests.id, requestId),
            eq(friendRequests.toUser, toUserId),
            eq(friendRequests.status, 'pending'),
          ),
        )
        .returning({ id: friendRequests.id });
      return updated.length > 0;
    },

    /**
     * Cancel a pending request sent by `fromUserId` (terminal, no friendship).
     * Returns `false` (→ 404) when not pending/not the sender.
     */
    async cancelRequest(fromUserId: string, requestId: string): Promise<boolean> {
      const updated = await db
        .update(friendRequests)
        .set({ status: 'cancelled', respondedAt: new Date() })
        .where(
          and(
            eq(friendRequests.id, requestId),
            eq(friendRequests.fromUser, fromUserId),
            eq(friendRequests.status, 'pending'),
          ),
        )
        .returning({ id: friendRequests.id });
      return updated.length > 0;
    },

    /** The caller's friends — the other party of each friendship + when it formed. */
    async listFriends(userId: string): Promise<FriendRow[]> {
      const ua = alias(users, 'ua');
      const ub = alias(users, 'ub');
      const rows = await db
        .select({
          userA: friendships.userA,
          userB: friendships.userB,
          createdAt: friendships.createdAt,
          usernameA: ua.username,
          usernameB: ub.username,
          profileIconA: ua.profileIcon,
          profileIconB: ub.profileIcon,
        })
        .from(friendships)
        .innerJoin(ua, eq(ua.id, friendships.userA))
        .innerJoin(ub, eq(ub.id, friendships.userB))
        .where(or(eq(friendships.userA, userId), eq(friendships.userB, userId)))
        .orderBy(friendships.createdAt);

      return rows.map((r) => {
        const other = r.userA === userId;
        return {
          id: other ? r.userB : r.userA,
          username: other ? r.usernameB : r.usernameA,
          profileIcon: other ? r.profileIconB : r.profileIconA,
          createdAt: r.createdAt,
        };
      });
    },

    /**
     * Delete the friendship between two users (either side may). Returns whether
     * a row was removed, so the service can 404 a non-friend. A removed row frees
     * the pair to send a fresh request afterwards (§6.9).
     */
    async deleteFriendship(a: string, b: string): Promise<boolean> {
      const [lo, hi] = canonicalPair(a, b);
      const deleted = await db
        .delete(friendships)
        .where(and(eq(friendships.userA, lo), eq(friendships.userB, hi)))
        .returning({ userA: friendships.userA });
      return deleted.length > 0;
    },
  };
}

export type FriendshipRepository = ReturnType<typeof createFriendshipRepository>;
