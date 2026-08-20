import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import * as schema from '../../schema';
import { createTestApp } from '../../../testing/createTestApp';
import { createFeedbackRepository } from '../feedbackRepository';

describe('feedback repository ownership boundary', () => {
  it('lists only rows owned by the supplied authenticated user', async () => {
    const harness = await createTestApp();
    try {
      const owner = await harness.seedUser({
        email: 'feedback-repo-owner@bt.test',
        username: 'feedbackrepoowner',
      });
      const other = await harness.seedUser({
        email: 'feedback-repo-other@bt.test',
        username: 'feedbackrepoother',
      });
      const repo = createFeedbackRepository(harness.db);
      const owned = await repo.create(owner.id, {
        category: 'feature',
        message: 'Owned submission',
      });
      await repo.create(other.id, {
        category: 'bug',
        message: 'Another user’s submission',
      });

      const rows = await repo.listMine(owner.id);

      expect(rows.map((row) => row.id)).toEqual([owned.id]);
      expect(rows.every((row) => row.userId === owner.id)).toBe(true);
    } finally {
      await harness.ctx.redis.quit?.();
    }
  });

  it('scopes submitter thread reads, writes, and read markers in repository SQL', async () => {
    const harness = await createTestApp();
    try {
      const owner = await harness.seedUser({
        email: 'feedback-thread-repo-owner@bt.test',
        username: 'feedbackthreadrepoowner',
      });
      const other = await harness.seedUser({
        email: 'feedback-thread-repo-other@bt.test',
        username: 'feedbackthreadrepoother',
      });
      const repo = createFeedbackRepository(harness.db);
      const owned = await repo.create(owner.id, {
        category: 'other',
        message: 'Repository-owned thread',
      });

      await expect(
        repo.getThreadForSubmitter(other.id, owned.id, { limit: 40 }),
      ).resolves.toBeNull();
      await expect(
        repo.createMessageForSubmitter(other.id, owned.id, 'Must not be stored.'),
      ).resolves.toBeNull();
      await expect(repo.markReadForSubmitter(other.id, owned.id)).resolves.toBe(false);

      await expect(
        repo.createMessageForSubmitter(owner.id, owned.id, 'Owner-authored detail.'),
      ).resolves.toMatchObject({ authorSide: 'submitter', authorUserId: owner.id });
      await expect(
        repo.getThreadForSubmitter(owner.id, owned.id, { limit: 40 }),
      ).resolves.toMatchObject({
        thread: { id: owned.id, unreadCount: 0 },
        rows: [{ body: 'Owner-authored detail.' }],
      });
    } finally {
      await harness.ctx.redis.quit?.();
    }
  });

  it('pages a thread on the same key the unread count derives from', async () => {
    const harness = await createTestApp();
    try {
      const owner = await harness.seedUser({
        email: 'feedback-order-owner@bt.test',
        username: 'feedbackorderowner',
      });
      const staff = await harness.seedUser({
        email: 'feedback-order-staff@bt.test',
        username: 'feedbackorderstaff',
      });
      const repo = createFeedbackRepository(harness.db);
      const owned = await repo.create(owner.id, { category: 'other', message: 'Ordered thread' });

      // Written in an order that disagrees with their stamps — as a backfill, an
      // import or a fixture can. Insertion order fixes the UUIDv7 ids, so an
      // id-keyed page would return `middle` before the newer `newest`.
      const [newest, oldest, middle] = await harness.db
        .insert(schema.feedbackMessages)
        .values([
          {
            feedbackId: owned.id,
            authorSide: 'admin' as const,
            authorUserId: staff.id,
            body: 'Newest reply.',
            createdAt: new Date('2026-08-10T08:00:00.000Z'),
          },
          {
            feedbackId: owned.id,
            authorSide: 'admin' as const,
            authorUserId: staff.id,
            body: 'Oldest reply.',
            createdAt: new Date('2026-08-01T08:00:00.000Z'),
          },
          {
            feedbackId: owned.id,
            authorSide: 'admin' as const,
            authorUserId: staff.id,
            body: 'Middle reply.',
            createdAt: new Date('2026-08-05T08:00:00.000Z'),
          },
        ])
        .returning();
      await harness.db
        .update(schema.feedback)
        .set({ submitterLastReadAt: new Date('2026-08-03T08:00:00.000Z') })
        .where(eq(schema.feedback.id, owned.id));

      // Two replies land after the read marker, and they are exactly the two the
      // first page shows — page position can no longer contradict unread state.
      const first = await repo.getThreadForSubmitter(owner.id, owned.id, { limit: 2 });
      expect(first?.thread.unreadCount).toBe(2);
      expect(first?.rows.map((row) => row.id)).toEqual([newest!.id, middle!.id]);
      expect(first?.nextCursor).toBe(middle!.id);

      const second = await repo.getThreadForSubmitter(owner.id, owned.id, {
        limit: 2,
        cursor: first!.nextCursor!,
      });
      expect(second?.rows.map((row) => row.id)).toEqual([oldest!.id]);
      expect(second?.nextCursor).toBeNull();
    } finally {
      await harness.ctx.redis.quit?.();
    }
  });
});
