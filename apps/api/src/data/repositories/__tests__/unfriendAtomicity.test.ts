import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createFriendGroupRepository } from '../friendGroupRepository';
import { createFriendshipRepository } from '../friendshipRepository';
import * as schema from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * Unfriending is ONE transaction (#1710): the friendship row, the pair's
 * `specific_friends` grants on each other's items, and their group rosters.
 *
 * Run as two independent statements, a failure after the friendship committed
 * left the ex-friend on the roster — and the moment the pair re-friend (a plain
 * accept: no re-share, no notification, no widen confirmation) they silently
 * regained read on every item ever shared to that circle. These tests pin the
 * all-or-nothing property directly, by failing the roster cleanup on purpose.
 */

/** `share_audiences.subject_id` is polymorphic (no FK), so a bare id suffices. */
const SUBJECT_ID = '00000000-0000-0000-7000-0000000000a1';

async function seedPair(harness: TestHarness) {
  const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
  const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
  const [lo, hi] = alice.id < bob.id ? [alice.id, bob.id] : [bob.id, alice.id];
  await harness.db.insert(schema.friendships).values({ userA: lo, userB: hi });
  return { alice, bob };
}

async function stillFriends(harness: TestHarness, a: string, b: string): Promise<boolean> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const rows = await harness.db
    .select({ userA: schema.friendships.userA })
    .from(schema.friendships)
    .where(and(eq(schema.friendships.userA, lo), eq(schema.friendships.userB, hi)));
  return rows.length > 0;
}

describe('deleteFriendship is atomic with its sharing cleanup', () => {
  it('rolls the friendship back when the roster cleanup fails', async () => {
    const harness = await createTestApp();
    try {
      const { alice, bob } = await seedPair(harness);
      const repo = createFriendshipRepository(harness.db);
      const groups = createFriendGroupRepository(harness.db);
      const groupId = await groups.createGroup(alice.id, 'Family');
      await groups.addMember(groupId, bob.id);

      await expect(
        repo.deleteFriendship(alice.id, bob.id, async () => {
          throw new Error('roster cleanup exploded');
        }),
      ).rejects.toThrow(/roster cleanup exploded/);

      // No partial state: the friendship survives, and so does the roster it
      // owns — the pair are exactly as they were before the failed attempt.
      expect(await stillFriends(harness, alice.id, bob.id)).toBe(true);
      expect(await groups.listMemberIds(groupId)).toEqual([bob.id]);
    } finally {
      await harness.dispose();
    }
  });

  it('commits the friendship, the grants and the rosters together', async () => {
    const harness = await createTestApp();
    try {
      const { alice, bob } = await seedPair(harness);
      const repo = createFriendshipRepository(harness.db);
      const groups = createFriendGroupRepository(harness.db);
      const groupId = await groups.createGroup(alice.id, 'Family');
      await groups.addMember(groupId, bob.id);

      const [audience] = await harness.db
        .insert(schema.shareAudiences)
        .values({
          ownerId: alice.id,
          kind: 'portfolio',
          subjectId: SUBJECT_ID,
          audience: 'specific_friends',
        })
        .returning({ id: schema.shareAudiences.id });
      await harness.db
        .insert(schema.shareAudienceMembers)
        .values({ audienceId: audience!.id, friendId: bob.id });

      expect(
        await repo.deleteFriendship(alice.id, bob.id, (tx) =>
          groups.removeMutualMemberships(alice.id, bob.id, tx),
        ),
      ).toBe(true);

      expect(await stillFriends(harness, alice.id, bob.id)).toBe(false);
      expect(await groups.listMemberIds(groupId)).toEqual([]);
      // The stale grant is gone, so re-friending cannot resurrect the share.
      expect(
        await harness.db
          .select({ friendId: schema.shareAudienceMembers.friendId })
          .from(schema.shareAudienceMembers)
          .where(eq(schema.shareAudienceMembers.audienceId, audience!.id)),
      ).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('keeps a broad-mode exclusion marker, which is not a grant but its opposite', async () => {
    const harness = await createTestApp();
    try {
      const { alice, bob } = await seedPair(harness);
      const repo = createFriendshipRepository(harness.db);

      const [audience] = await harness.db
        .insert(schema.shareAudiences)
        .values({
          ownerId: alice.id,
          kind: 'portfolio',
          subjectId: SUBJECT_ID,
          audience: 'all_friends',
        })
        .returning({ id: schema.shareAudiences.id });
      // On a broad rung this row EXCLUDES bob (paranoid enable writes it). Pruning
      // it on unfriend would WIDEN the share — the pruning stays fail-closed.
      await harness.db
        .insert(schema.shareAudienceMembers)
        .values({ audienceId: audience!.id, friendId: bob.id });

      expect(await repo.deleteFriendship(alice.id, bob.id)).toBe(true);
      expect(
        await harness.db
          .select({ friendId: schema.shareAudienceMembers.friendId })
          .from(schema.shareAudienceMembers)
          .where(eq(schema.shareAudienceMembers.audienceId, audience!.id)),
      ).toEqual([{ friendId: bob.id }]);
    } finally {
      await harness.dispose();
    }
  });

  it('runs no cleanup — and reports false — when the pair were not friends', async () => {
    const harness = await createTestApp();
    try {
      const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
      const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
      const repo = createFriendshipRepository(harness.db);
      let cleanupRan = false;
      expect(
        await repo.deleteFriendship(alice.id, bob.id, async () => {
          cleanupRan = true;
        }),
      ).toBe(false);
      expect(cleanupRan).toBe(false);
    } finally {
      await harness.dispose();
    }
  });
});
