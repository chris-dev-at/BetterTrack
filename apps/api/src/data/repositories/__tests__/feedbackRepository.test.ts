import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import * as schema from '../../schema';
import { createTestApp } from '../../../testing/createTestApp';
import { createFeedbackRepository } from '../feedbackRepository';
import { createUserRepository } from '../userRepository';

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

      expect(owned).not.toBeNull();
      expect(rows.map((row) => row.id)).toEqual([owned!.id]);
      expect(rows.every((row) => row.userId === owner.id)).toBe(true);
    } finally {
      await harness.ctx.redis.quit?.();
    }
  });

  it('excludes tombstoned submissions from the unread reply aggregate', async () => {
    const harness = await createTestApp();
    try {
      const owner = await harness.seedUser({
        email: 'feedback-unread-tombstone-owner@bt.test',
        username: 'feedbackunreadtombowner',
      });
      const staff = await harness.seedAdmin({
        email: 'feedback-unread-tombstone-staff@bt.test',
        username: 'feedbackunreadtombstaff',
      });
      const repo = createFeedbackRepository(harness.db);
      const live = await repo.create(owner.id, {
        category: 'help',
        message: 'Keep this submission visible.',
      });
      const tombstoned = await repo.create(owner.id, {
        category: 'bug',
        message: 'Remove this submission from my list.',
      });
      expect(live).not.toBeNull();
      expect(tombstoned).not.toBeNull();

      await expect(
        repo.createMessageForAdmin(staff.id, live!.id, 'Unread live reply.'),
      ).resolves.not.toBeNull();
      await expect(
        repo.createMessageForAdmin(staff.id, tombstoned!.id, 'Unread tombstoned reply.'),
      ).resolves.not.toBeNull();
      const deletedAt = new Date('2026-08-20T12:00:00.000Z');
      await expect(repo.deleteMine(owner.id, tombstoned!.id, deletedAt)).resolves.toMatchObject({
        deletedByUserAt: deletedAt,
      });

      const rows = await repo.listMine(owner.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: live!.id, unreadReplyCount: 1 });
      expect(rows.some((row) => row.id === tombstoned!.id)).toBe(false);
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
      expect(owned).not.toBeNull();

      await expect(repo.getThreadForSubmitter(other.id, owned!.id, { limit: 40 })).resolves.toEqual(
        {
          status: 'not_found',
        },
      );
      await expect(
        repo.createMessageForSubmitter(other.id, owned!.id, 'Must not be stored.'),
      ).resolves.toBeNull();
      await expect(repo.markReadForSubmitter(other.id, owned!.id)).resolves.toBe(false);

      await expect(
        repo.createMessageForSubmitter(owner.id, owned!.id, 'Owner-authored detail.'),
      ).resolves.toMatchObject({ authorSide: 'submitter', authorUserId: owner.id });
      await expect(
        repo.getThreadForSubmitter(owner.id, owned!.id, { limit: 40 }),
      ).resolves.toMatchObject({
        status: 'ok',
        page: {
          thread: { id: owned!.id, unreadCount: 0 },
          rows: [{ body: 'Owner-authored detail.' }],
        },
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
      const staff = await harness.seedAdmin({
        email: 'feedback-order-staff@bt.test',
        username: 'feedbackorderstaff',
      });
      const repo = createFeedbackRepository(harness.db);
      const owned = await repo.create(owner.id, { category: 'other', message: 'Ordered thread' });
      expect(owned).not.toBeNull();

      // Written in an order that disagrees with their stamps — as a backfill, an
      // import or a fixture can. Insertion order fixes the UUIDv7 ids, so an
      // id-keyed page would return `middle` before the newer `newest`.
      const [newest, oldest, middle] = await harness.db
        .insert(schema.feedbackMessages)
        .values([
          {
            feedbackId: owned!.id,
            authorSide: 'admin' as const,
            authorUserId: staff.id,
            body: 'Newest reply.',
            createdAt: new Date('2026-08-10T08:00:00.000Z'),
          },
          {
            feedbackId: owned!.id,
            authorSide: 'admin' as const,
            authorUserId: staff.id,
            body: 'Oldest reply.',
            createdAt: new Date('2026-08-01T08:00:00.000Z'),
          },
          {
            feedbackId: owned!.id,
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
        .where(eq(schema.feedback.id, owned!.id));

      // Two replies land after the read marker, and they are exactly the two the
      // first page shows — page position can no longer contradict unread state.
      const first = await repo.getThreadForSubmitter(owner.id, owned!.id, { limit: 2 });
      expect(first.status).toBe('ok');
      const firstPage = first.status === 'ok' ? first.page : null;
      expect(firstPage?.thread.unreadCount).toBe(2);
      expect(firstPage?.rows.map((row) => row.id)).toEqual([newest!.id, middle!.id]);
      expect(firstPage?.nextCursor).toBe(middle!.id);

      const second = await repo.getThreadForSubmitter(owner.id, owned!.id, {
        limit: 2,
        cursor: firstPage!.nextCursor!,
      });
      const secondPage = second.status === 'ok' ? second.page : null;
      expect(secondPage?.rows.map((row) => row.id)).toEqual([oldest!.id]);
      expect(secondPage?.nextCursor).toBeNull();

      // A cursor naming no row in this thread is reported, not ignored: the old
      // behaviour re-served page one under a cursor that never advanced.
      await expect(
        repo.getThreadForSubmitter(owner.id, owned!.id, { limit: 2, cursor: owned!.id }),
      ).resolves.toEqual({ status: 'invalid_cursor' });
    } finally {
      await harness.ctx.redis.quit?.();
    }
  });

  it('anonymizes a replying admin’s messages when that admin account is deleted', async () => {
    const harness = await createTestApp();
    try {
      const submitter = await harness.seedUser({
        email: 'feedback-staff-delete-submitter@bt.test',
        username: 'feedbackstaffdeletesub',
      });
      const staff = await harness.seedAdmin({
        email: 'feedback-staff-delete-admin@bt.test',
        username: 'feedbackstaffdeleteadm',
      });
      const repo = createFeedbackRepository(harness.db);
      const owned = await repo.create(submitter.id, {
        category: 'bug',
        message: 'Staff answers this one.',
      });
      expect(owned).not.toBeNull();
      const reply = await repo.createMessageForAdmin(staff.id, owned!.id, 'We can reproduce it.');
      expect(reply).toMatchObject({
        submitterUserId: submitter.id,
        row: { authorSide: 'admin', authorUserId: staff.id },
      });

      // The exact statement both deletion paths rely on (userRepository.remove →
      // accountDeletionService / adminService). An admin's replies live on OTHER
      // users' submissions, so nothing else clears them: under a NO ACTION FK
      // this raised 23503 and left the account half-deleted.
      const userRepo = createUserRepository(harness.db);
      await expect(userRepo.remove(staff.id)).resolves.toBeUndefined();

      // Anonymized, not recalled — the body the submitter received survives and
      // `authorSide` still carries the staff attribution.
      const after = await repo.getThreadForSubmitter(submitter.id, owned!.id, { limit: 40 });
      expect(after).toMatchObject({
        status: 'ok',
        page: {
          rows: [
            {
              id: reply!.row.id,
              authorSide: 'admin',
              authorUserId: null,
              body: reply!.row.body,
            },
          ],
        },
      });
    } finally {
      await harness.ctx.redis.quit?.();
    }
  });

  it('can only tombstone the supplied caller own row and stays idempotent', async () => {
    const harness = await createTestApp();
    try {
      const owner = await harness.seedUser({
        email: 'feedback-delete-owner@bt.test',
        username: 'feedbackdeleteowner',
      });
      const other = await harness.seedUser({
        email: 'feedback-delete-other@bt.test',
        username: 'feedbackdeleteother',
      });
      const repo = createFeedbackRepository(harness.db);
      const owned = await repo.create(owner.id, {
        category: 'help',
        message: 'Please help with my import.',
      });
      const foreign = await repo.create(other.id, {
        category: 'improvement',
        message: 'Make the preview clearer.',
      });
      expect(owned).not.toBeNull();
      expect(foreign).not.toBeNull();

      expect(await repo.deleteMine(owner.id, foreign!.id, new Date())).toBeNull();
      const deletedAt = new Date('2026-08-20T12:00:00.000Z');
      const first = await repo.deleteMine(owner.id, owned!.id, deletedAt);
      const second = await repo.deleteMine(
        owner.id,
        owned!.id,
        new Date('2026-08-20T13:00:00.000Z'),
      );

      expect(first?.deletedByUserAt).toEqual(deletedAt);
      expect(second?.deletedByUserAt).toEqual(deletedAt);
      expect(await repo.listMine(owner.id)).toEqual([]);
      expect((await repo.listMine(other.id)).map((row) => row.id)).toEqual([foreign!.id]);
    } finally {
      await harness.ctx.redis.quit?.();
    }
  });
});
