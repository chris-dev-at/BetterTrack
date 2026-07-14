import { and, asc, eq, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { userFollows, users } from '../schema';

/**
 * Person-follow SQL (#438). All `user_follows` queries live here; the service
 * holds the rules (self-follow rejection, target validity, notification
 * emission). A follow is one-directional and grants no read access — it only
 * decides who receives `follow.published` news, so there is no authorization
 * join here, unlike the friendship/audience repositories.
 */

/** One followed/follower user as seen in a list — the other party + when it formed. */
export interface FollowUserRow {
  id: string;
  username: string;
  createdAt: Date;
}

export function createUserFollowsRepository(db: Database) {
  return {
    /**
     * Whether `userId` is a valid follow target — an active, non-admin account —
     * returning its username, or `undefined`. Admins are outside the social graph
     * (like {@link FriendshipRepository.findUserIdByIdentifier}), so they are
     * unfollowable and resolve exactly like a missing account (the service 404s).
     */
    async findFollowTarget(userId: string): Promise<{ username: string } | undefined> {
      const [row] = await db
        .select({ username: users.username })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.status, 'active'), sql`${users.role} <> 'admin'`))
        .limit(1);
      return row;
    },

    /**
     * Record a follow. Idempotent against the composite PK: a repeat follow is a
     * no-op (never a duplicate-key crash). Returns whether a NEW row was created,
     * so the service only emits/side-effects on a genuine new follow.
     */
    async follow(followerId: string, followedId: string): Promise<boolean> {
      const rows = await db
        .insert(userFollows)
        .values({ followerId, followedId })
        .onConflictDoNothing()
        .returning({ followerId: userFollows.followerId });
      return rows.length > 0;
    },

    /** Remove a follow. Returns whether a row was removed (so the service 404s a non-follow). */
    async unfollow(followerId: string, followedId: string): Promise<boolean> {
      const rows = await db
        .delete(userFollows)
        .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId)))
        .returning({ followerId: userFollows.followerId });
      return rows.length > 0;
    },

    /** Whether `followerId` currently follows `followedId`. */
    async isFollowing(followerId: string, followedId: string): Promise<boolean> {
      const [row] = await db
        .select({ followerId: userFollows.followerId })
        .from(userFollows)
        .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId)))
        .limit(1);
      return row !== undefined;
    },

    /** The users `followerId` follows — the other party + when it formed, by username. */
    async listFollowing(followerId: string): Promise<FollowUserRow[]> {
      return db
        .select({ id: users.id, username: users.username, createdAt: userFollows.createdAt })
        .from(userFollows)
        .innerJoin(users, eq(users.id, userFollows.followedId))
        .where(eq(userFollows.followerId, followerId))
        .orderBy(asc(users.username));
    },

    /** The users who follow `followedId` — the other party + when it formed, by username. */
    async listFollowers(followedId: string): Promise<FollowUserRow[]> {
      return db
        .select({ id: users.id, username: users.username, createdAt: userFollows.createdAt })
        .from(userFollows)
        .innerJoin(users, eq(users.id, userFollows.followerId))
        .where(eq(userFollows.followedId, followedId))
        .orderBy(asc(users.username));
    },

    /**
     * The ids of everyone who follows `followedId` — the `follow.published`
     * fan-out set. Ids only (no user join); the audience layer decides per-follower
     * whether the item is newly visible.
     */
    async listFollowerIds(followedId: string): Promise<string[]> {
      const rows = await db
        .select({ followerId: userFollows.followerId })
        .from(userFollows)
        .where(eq(userFollows.followedId, followedId));
      return rows.map((r) => r.followerId);
    },

    /** How many users follow `userId` (public follower count on the profile). */
    async countFollowers(userId: string): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(userFollows)
        .where(eq(userFollows.followedId, userId));
      return row?.n ?? 0;
    },

    /** How many users `userId` follows. */
    async countFollowing(userId: string): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(userFollows)
        .where(eq(userFollows.followerId, userId));
      return row?.n ?? 0;
    },
  };
}

export type UserFollowsRepository = ReturnType<typeof createUserFollowsRepository>;
