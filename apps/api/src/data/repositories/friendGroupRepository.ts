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

/**
 * One of the owner's groups, with its live roster and how many shares currently
 * point at it (`shareCount` — what goes dark if the circle is deleted).
 */
export interface FriendGroupRow {
  id: string;
  name: string;
  members: GroupMemberRow[];
  shareCount: number;
}

export function createFriendGroupRepository(db: Database) {
  /**
   * The active roster of a set of groups, keyed by group id. A member whose
   * account vanished OR was disabled is excluded by the inner join — a disabled
   * account can neither sign in nor be authorized by the enforcement layer, so
   * counting it would let the owner surface claim a reach that does not exist
   * (§6.9). Every roster read in this file goes through here, so `GET
   * /social/groups`, the My-items reach summary and the `*.shared` fan-out can
   * never disagree about who is in a circle.
   */
  async function rostersOf(groupIds: readonly string[]): Promise<Map<string, GroupMemberRow[]>> {
    const byGroup = new Map<string, GroupMemberRow[]>();
    if (groupIds.length === 0) return byGroup;
    const memberRows = await db
      .select({
        groupId: friendGroupMembers.groupId,
        id: users.id,
        username: users.username,
        profileIcon: users.profileIcon,
      })
      .from(friendGroupMembers)
      .innerJoin(users, and(eq(users.id, friendGroupMembers.memberId), eq(users.status, 'active')))
      .where(inArray(friendGroupMembers.groupId, [...groupIds]))
      .orderBy(asc(users.username));
    for (const r of memberRows) {
      const list = byGroup.get(r.groupId) ?? [];
      list.push({ id: r.id, username: r.username, profileIcon: r.profileIcon });
      byGroup.set(r.groupId, list);
    }
    return byGroup;
  }

  /**
   * Count of live shares (across all kinds) that currently point at this group —
   * feeds the delete-warning copy so the owner knows how many shares will go
   * dark. Zero when nothing references it.
   */
  async function countActiveShares(groupId: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(shareAudiences)
      .where(and(eq(shareAudiences.audience, 'group'), eq(shareAudiences.groupId, groupId)));
    return row?.count ?? 0;
  }

  /** How many live `group` shares point at each of `groupIds`, keyed by group id. */
  async function shareCountsOf(groupIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (groupIds.length === 0) return counts;
    const rows = await db
      .select({ groupId: shareAudiences.groupId, count: sql<number>`count(*)`.mapWith(Number) })
      .from(shareAudiences)
      .where(
        and(eq(shareAudiences.audience, 'group'), inArray(shareAudiences.groupId, [...groupIds])),
      )
      .groupBy(shareAudiences.groupId);
    for (const r of rows) if (r.groupId) counts.set(r.groupId, r.count);
    return counts;
  }

  return {
    /**
     * The owner's groups with their current rosters (members are the owner's
     * accepted, still-active friends) and their share counts. Three grouped
     * reads, no N+1. Ordered by group name then member name.
     */
    async listGroups(ownerId: string): Promise<FriendGroupRow[]> {
      const groups = await db
        .select({ id: friendGroups.id, name: friendGroups.name })
        .from(friendGroups)
        .where(eq(friendGroups.ownerId, ownerId))
        .orderBy(asc(friendGroups.name), asc(friendGroups.id));
      if (groups.length === 0) return [];

      const ids = groups.map((g) => g.id);
      const [byGroup, shareCounts] = await Promise.all([rostersOf(ids), shareCountsOf(ids)]);
      return groups.map((g) => ({
        id: g.id,
        name: g.name,
        members: byGroup.get(g.id) ?? [],
        shareCount: shareCounts.get(g.id) ?? 0,
      }));
    },

    /**
     * ONE owned group with its roster + share count, or `undefined` when it is
     * not the caller's (→ 404). The single-group read behind every group
     * mutation's response: re-reading through {@link listGroups} hydrated every
     * group of the caller AND every member of those groups (O(groups × members)
     * rows) just to pick one out (#1710).
     */
    async getGroup(ownerId: string, groupId: string): Promise<FriendGroupRow | undefined> {
      const [group] = await db
        .select({ id: friendGroups.id, name: friendGroups.name })
        .from(friendGroups)
        .where(and(eq(friendGroups.id, groupId), eq(friendGroups.ownerId, ownerId)))
        .limit(1);
      if (!group) return undefined;
      const [byGroup, shareCount] = await Promise.all([
        rostersOf([group.id]),
        countActiveShares(group.id),
      ]);
      return {
        id: group.id,
        name: group.name,
        members: byGroup.get(group.id) ?? [],
        shareCount,
      };
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

    /**
     * The group's current member ids (live roster) — used for share-event
     * fan-out. Disabled accounts are excluded by the same inner join the roster
     * reads use: they cannot sign in, so notifying them would be a `*.shared`
     * row nobody can act on, and it would contradict the reach the owner sees.
     */
    async listMemberIds(groupId: string): Promise<string[]> {
      const rows = await db
        .select({ memberId: friendGroupMembers.memberId })
        .from(friendGroupMembers)
        .innerJoin(
          users,
          and(eq(users.id, friendGroupMembers.memberId), eq(users.status, 'active')),
        )
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
     *
     * `exec` lets the caller run this INSIDE the unfriend transaction (see
     * {@link FriendshipRepository.deleteFriendship}), so the friendship row and
     * the rosters commit together — a half-applied unfriend would leave the
     * ex-friend on the roster, ready to silently regain access the moment the
     * pair re-friend (#1710).
     */
    async removeMutualMemberships(a: string, b: string, exec: Database = db): Promise<void> {
      const aGroups = exec
        .select({ id: friendGroups.id })
        .from(friendGroups)
        .where(eq(friendGroups.ownerId, a));
      const bGroups = exec
        .select({ id: friendGroups.id })
        .from(friendGroups)
        .where(eq(friendGroups.ownerId, b));
      await exec
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

    /** @see countActiveShares — the delete-warning count, also folded into {@link getGroup}. */
    countActiveShares,
  };
}

export type FriendGroupRepository = ReturnType<typeof createFriendGroupRepository>;
