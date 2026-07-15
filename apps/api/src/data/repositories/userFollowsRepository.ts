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

/** A row in the caller's OWN following list — carries their per-follow prefs (#439, #455). */
export interface FollowingUserRow extends FollowUserRow {
  autoFollowItems: boolean;
  notifyOnAlertCreate: boolean;
  notifyOnAlertFire: boolean;
  /** The followed person's OWN "share my alerts with followers" opt-in (V4-P0b). */
  sharesAlertActivity: boolean;
}

/** The caller-settable per-follow prefs (#439 auto-follow, #455 alert triggers). */
export interface FollowPrefs {
  autoFollowItems?: boolean;
  notifyOnAlertCreate?: boolean;
  notifyOnAlertFire?: boolean;
}

/** One follower to notify about a followed person's alert activity (#455). */
export interface AlertFollowRecipient {
  followerId: string;
  /** The followed OWNER's username — the notification's actor. */
  ownerUsername: string;
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
     * repeat follow can't silently flip any of them. Returns whether a NEW row
     * was created, so the service only emits/side-effects on a genuine new
     * follow. All prefs are settable at follow time (#439/#455, default OFF).
     */
    async follow(followerId: string, followedId: string, opts?: FollowPrefs): Promise<boolean> {
      const rows = await db
        .insert(userFollows)
        .values({
          followerId,
          followedId,
          autoFollowItems: opts?.autoFollowItems ?? false,
          notifyOnAlertCreate: opts?.notifyOnAlertCreate ?? false,
          notifyOnAlertFire: opts?.notifyOnAlertFire ?? false,
        })
        .onConflictDoNothing()
        .returning({ followerId: userFollows.followerId });
      return rows.length > 0;
    },

    /**
     * Patch the caller's per-follow prefs (#439/#455): `autoFollowItems` and the
     * two independent alert-follow triggers. Returns whether a follow row
     * existed (the service 404s a non-follow).
     */
    async updateFollowPrefs(
      followerId: string,
      followedId: string,
      patch: FollowPrefs,
    ): Promise<boolean> {
      const set: Partial<{
        autoFollowItems: boolean;
        notifyOnAlertCreate: boolean;
        notifyOnAlertFire: boolean;
      }> = {};
      if (patch.autoFollowItems !== undefined) set.autoFollowItems = patch.autoFollowItems;
      if (patch.notifyOnAlertCreate !== undefined) {
        set.notifyOnAlertCreate = patch.notifyOnAlertCreate;
      }
      if (patch.notifyOnAlertFire !== undefined) set.notifyOnAlertFire = patch.notifyOnAlertFire;
      if (Object.keys(set).length === 0) {
        // Nothing to change — still report whether the follow exists.
        return this.isFollowing(followerId, followedId);
      }
      const rows = await db
        .update(userFollows)
        .set(set)
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
          notifyOnAlertCreate: userFollows.notifyOnAlertCreate,
          notifyOnAlertFire: userFollows.notifyOnAlertFire,
          sharesAlertActivity: users.alertsVisibleToFollowers,
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
          notifyOnAlertCreate: userFollows.notifyOnAlertCreate,
          notifyOnAlertFire: userFollows.notifyOnAlertFire,
          sharesAlertActivity: users.alertsVisibleToFollowers,
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

    /**
     * The followers to notify about the followed user's alert activity (#455):
     * followers whose `notify_on_alert_create` / `notify_on_alert_fire` pref is
     * on, joined against the OWNER's `alerts_visible_to_followers` opt-in — the
     * privacy gate lives in this query, recomputed at every emission, so the
     * owner unsharing (or a follower flipping a trigger off, or unfollowing)
     * stops delivery immediately. The owner can never appear (self-follows are
     * CHECK-rejected), so their own `alert.triggered` delivery is never doubled.
     */
    async listAlertFollowRecipients(
      followedId: string,
      trigger: 'create' | 'fire',
    ): Promise<AlertFollowRecipient[]> {
      const pref =
        trigger === 'create' ? userFollows.notifyOnAlertCreate : userFollows.notifyOnAlertFire;
      return db
        .select({ followerId: userFollows.followerId, ownerUsername: users.username })
        .from(userFollows)
        .innerJoin(
          users,
          and(eq(users.id, userFollows.followedId), eq(users.alertsVisibleToFollowers, true)),
        )
        .where(and(eq(userFollows.followedId, followedId), eq(pref, true)));
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
