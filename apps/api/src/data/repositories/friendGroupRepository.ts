import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { friendGroupMembers, friendGroups, friendships, shareAudiences, users } from '../schema';

/**
 * Friend-group persistence (§13.5 V5-P8). A group is a named circle owned by one
 * user and usable as a `group` sharing audience between `specific_friends` and
 * `all_friends`. All SQL for `friend_groups` + `friend_group_members` lives here;
 * the service holds the rules (a member must be an accepted friend of the owner;
 * a group is private to its owner). Membership is read live by the enforcement
 * layer, so editing a circle immediately changes who sees existing shares, and a
 * deleted group resolves to nobody (fail-closed, §6.9).
 */

/** One member of a group — public-safe identity only (§6.9). */
export interface GroupMemberRow {
  id: string;
  username: string;
  profileIcon: string | null;
}

/** One of the owner's groups, with its live roster. */
export interface FriendGroupRow {
  id: string;
  name: string;
  members: GroupMemberRow[];
}

export function createFriendGroupRepository(db: Database) {
  return {
    /**
     * The owner's groups with their current rosters (members are the owner's
     * accepted friends; a member whose account vanished is excluded by the inner
     * join). One grouped read, no N+1. Ordered by group name then member name.
     */
    async listGroups(ownerId: string): Promise<FriendGroupRow[]> {
      const groups = await db
        .select({ id: friendGroups.id, name: friendGroups.name })
        .from(friendGroups)
        .where(eq(friendGroups.ownerId, ownerId))
        .orderBy(asc(friendGroups.name), asc(friendGroups.id));
      if (groups.length === 0) return [];

      const memberRows = await db
        .select({
          groupId: friendGroupMembers.groupId,
          id: users.id,
          username: users.username,
          profileIcon: users.profileIcon,
        })
        .from(friendGroupMembers)
        .innerJoin(
          users,
          and(eq(users.id, friendGroupMembers.memberId), eq(users.status, 'active')),
        )
        .where(
          inArray(
            friendGroupMembers.groupId,
            groups.map((g) => g.id),
          ),
        )
        .orderBy(asc(users.username));

      const byGroup = new Map<string, GroupMemberRow[]>();
      for (const r of memberRows) {
        const list = byGroup.get(r.groupId) ?? [];
        list.push({ id: r.id, username: r.username, profileIcon: r.profileIcon });
        byGroup.set(r.groupId, list);
      }
      return groups.map((g) => ({ id: g.id, name: g.name, members: byGroup.get(g.id) ?? [] }));
    },

    /** Whether `ownerId` owns the group — gates every mutation (no IDOR, §8). */
    async ownsGroup(ownerId: string, groupId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: friendGroups.id })
        .from(friendGroups)
        .where(and(eq(friendGroups.id, groupId), eq(friendGroups.ownerId, ownerId)))
        .limit(1);
      return row !== undefined;
    },

    /** The group's current member ids (live roster) — used for share-event fan-out. */
    async listMemberIds(groupId: string): Promise<string[]> {
      const rows = await db
        .select({ memberId: friendGroupMembers.memberId })
        .from(friendGroupMembers)
        .where(eq(friendGroupMembers.groupId, groupId));
      return rows.map((r) => r.memberId);
    },

    /** Create an empty group for the owner. Returns the new group id. */
    async createGroup(ownerId: string, name: string): Promise<string> {
      const [row] = await db
        .insert(friendGroups)
        .values({ ownerId, name })
        .returning({ id: friendGroups.id });
      return row!.id;
    },

    /**
     * Rename a group the owner owns. Returns `false` (→ 404) when it isn't theirs
     * or doesn't exist — the owner scope is in the WHERE, so no separate read.
     */
    async renameGroup(ownerId: string, groupId: string, name: string): Promise<boolean> {
      const updated = await db
        .update(friendGroups)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(friendGroups.id, groupId), eq(friendGroups.ownerId, ownerId)))
        .returning({ id: friendGroups.id });
      return updated.length > 0;
    },

    /**
     * Delete a group the owner owns. Members cascade away and any
     * `share_audiences.group_id` referencing it is SET NULL by the FK, so shares
     * pointing at it go dark rather than widening (§6.9). Returns `false` (→ 404)
     * when it isn't theirs.
     */
    async deleteGroup(ownerId: string, groupId: string): Promise<boolean> {
      const deleted = await db
        .delete(friendGroups)
        .where(and(eq(friendGroups.id, groupId), eq(friendGroups.ownerId, ownerId)))
        .returning({ id: friendGroups.id });
      return deleted.length > 0;
    },

    /**
     * Add a member to a group. Idempotent (PK upsert → a repeat add is a no-op).
     * The caller MUST have verified ownership + friendship first — this is the
     * raw insert.
     */
    async addMember(groupId: string, memberId: string): Promise<void> {
      await db.insert(friendGroupMembers).values({ groupId, memberId }).onConflictDoNothing();
    },

    /** Remove a member from a group. Returns whether a row was removed. */
    async removeMember(groupId: string, memberId: string): Promise<boolean> {
      const deleted = await db
        .delete(friendGroupMembers)
        .where(
          and(eq(friendGroupMembers.groupId, groupId), eq(friendGroupMembers.memberId, memberId)),
        )
        .returning({ memberId: friendGroupMembers.memberId });
      return deleted.length > 0;
    },

    /**
     * On unfriend, drop the pair from each other's groups: any membership where
     * `a`'s group contains `b`, or `b`'s group contains `a`. Keeps the invariant
     * that a group's members are the owner's current friends, so a `group` share
     * can never reach a non-friend (§6.9).
     */
    async removeMutualMemberships(a: string, b: string): Promise<void> {
      const aGroups = db
        .select({ id: friendGroups.id })
        .from(friendGroups)
        .where(eq(friendGroups.ownerId, a));
      const bGroups = db
        .select({ id: friendGroups.id })
        .from(friendGroups)
        .where(eq(friendGroups.ownerId, b));
      await db
        .delete(friendGroupMembers)
        .where(
          or(
            and(eq(friendGroupMembers.memberId, b), inArray(friendGroupMembers.groupId, aGroups)),
            and(eq(friendGroupMembers.memberId, a), inArray(friendGroupMembers.groupId, bGroups)),
          ),
        );
    },

    /** Whether `memberId` is an accepted friend of `ownerId` (order-independent). */
    async isFriend(ownerId: string, memberId: string): Promise<boolean> {
      const [row] = await db
        .select({ userA: friendships.userA })
        .from(friendships)
        .where(
          or(
            and(eq(friendships.userA, ownerId), eq(friendships.userB, memberId)),
            and(eq(friendships.userB, ownerId), eq(friendships.userA, memberId)),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    /**
     * Count of active shares (across all kinds) that currently point at this
     * group — feeds the delete-warning copy so the owner knows how many shares
     * will go dark. Zero when nothing references it.
     */
    async countActiveShares(groupId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(shareAudiences)
        .where(eq(shareAudiences.groupId, groupId));
      return row?.count ?? 0;
    },
  };
}

export type FriendGroupRepository = ReturnType<typeof createFriendGroupRepository>;
