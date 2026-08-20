import { describe, expect, it } from 'vitest';

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
});
