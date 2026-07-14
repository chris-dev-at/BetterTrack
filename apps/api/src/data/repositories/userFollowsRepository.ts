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

/** A row in the caller's OWN following list — carries their per-follow prefs (#439). */
export interface FollowingUserRow extends FollowUserRow {
  autoFollowItems: boolean;
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
     * no-op (never a duplicate-key crash) — an existing row keeps its prefs, so a
     * repeat follow can't silently flip `autoFollowItems`. Returns whether a NEW
     * row was created, so the service only emits/side-effects on a genuine new
     * follow. `autoFollowItems` is settable at follow time (#439, default OFF).
     */
    async follow(
      followerId: string,
      followedId: string,
      opts?: { autoFollowItems?: boolean },
    ): Promise<boolean> {
      const rows = await db
        .insert(userFollows)
        .values({ followerId, followedId, autoFollowItems: opts?.autoFollowItems ?? false })
        .onConflictDoNothing()
        .returning({ followerId: userFollows.followerId });
      return rows.length > 0;
    },

    /**
     * Patch the caller's per-follow prefs (#439) — currently `autoFollowItems`.
     * Returns whether a follow row existed (the service 404s a non-follow).
     */
    async updateFollowPrefs(
      followerId: string,
      followedId: string,
      patch: { autoFollowItems?: boolean },
    ): Promise<boolean> {
      if (patch.autoFollowItems === undefined) {
        // Nothing to change — still report whether the follow exists.
        return this.isFollowing(followerId, followedId);
      }
      const rows = await db
        .update(userFollows)
        .set({ autoFollowItems: patch.autoFollowItems })
        .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId)))
        .returning({ followerId: userFollows.followerId });
      return rows.length > 0;
    },

    /** One row of the caller's following list (the other party + prefs), or `undefined`. */
    async getFollowing(
      followerId: string,
      followedId: string,
    ): Promise<FollowingUserRow | undefined> {
      const [row] = await db
        .select({
          id: users.id,
          username: users.username,
          createdAt: userFollows.createdAt,
          autoFollowItems: userFollows.autoFollowItems,
        })
        .from(userFollows)
        .innerJoin(users, eq(users.id, userFollows.followedId))
        .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId)))
        .limit(1);
      return row;
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

    /** The users `followerId` follows — the other party + per-follow prefs, by username. */
    async listFollowing(followerId: string): Promise<FollowingUserRow[]> {
      return db
        .select({
          id: users.id,
          username: users.username,
          createdAt: userFollows.createdAt,
          autoFollowItems: userFollows.autoFollowItems,
        })
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
     * Everyone who follows `followedId` — the `follow.published` fan-out set —
     * with each follower's `autoFollowItems` pref, so the emission can auto-add
     * the item for opted-in followers in the same pass (#439). Ids + prefs only
     * (no user join); the audience layer decides per-follower whether the item
     * is newly visible.
     */
    async listFollowerPrefs(
      followedId: string,
    ): Promise<{ followerId: string; autoFollowItems: boolean }[]> {
      return db
        .select({
          followerId: userFollows.followerId,
          autoFollowItems: userFollows.autoFollowItems,
        })
        .from(userFollows)
        .where(eq(userFollows.followedId, followedId));
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
