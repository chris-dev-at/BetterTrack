import { and, asc, eq, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { Database } from '../db';
import { friendRequests, friendships, portfolios, users } from '../schema';
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
  createdAt: Date;
  respondedAt: Date | null;
}

/** One established friendship as seen from a viewer — the *other* party + when it formed. */
export interface FriendRow {
  id: string;
  username: string;
  createdAt: Date;
}

/** A friend's portfolio exposed via `visibility='friends'` — owner + portfolio identity only. */
export interface SharedPortfolioRow {
  portfolioId: string;
  name: string;
  ownerId: string;
  ownerUsername: string;
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
     */
    async findUserIdByIdentifier(identifier: string): Promise<string | undefined> {
      const needle = identifier.trim().toLowerCase();
      if (needle.length === 0) return undefined;
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(or(eq(users.email, needle), sql`lower(${users.username}) = ${needle}`))
        .limit(1);
      return row?.id;
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
        })
        .from(friendships)
        .innerJoin(
          portfolios,
          or(
            and(eq(friendships.userA, viewerId), eq(portfolios.userId, friendships.userB)),
            and(eq(friendships.userB, viewerId), eq(portfolios.userId, friendships.userA)),
          ),
        )
        .innerJoin(users, eq(users.id, portfolios.userId))
        .where(eq(portfolios.visibility, 'friends'))
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
        })
        .from(portfolios)
        .innerJoin(users, eq(users.id, portfolios.userId))
        .innerJoin(
          friendships,
          or(
            and(eq(friendships.userA, viewerId), eq(friendships.userB, portfolios.userId)),
            and(eq(friendships.userB, viewerId), eq(friendships.userA, portfolios.userId)),
          ),
        )
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.visibility, 'friends')))
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
    async createRequest(fromUser: string, toUser: string): Promise<void> {
      await db.insert(friendRequests).values({ fromUser, toUser }).onConflictDoNothing();
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
          createdAt: r.createdAt,
          respondedAt: r.respondedAt,
        };
      });
    },

    /**
     * Accept a pending request addressed to `toUserId`. Transitions the request
     * to `accepted` and creates the canonical friendship in one transaction.
     * Returns `false` — so the service 404s — when the request doesn't exist,
     * isn't pending, or isn't addressed to this user (no 403, no info leak).
     */
    async acceptRequest(toUserId: string, requestId: string): Promise<boolean> {
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
        if (!req) return false;
        const [lo, hi] = canonicalPair(req.fromUser, req.toUser);
        await tx.insert(friendships).values({ userA: lo, userB: hi }).onConflictDoNothing();
        return true;
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
