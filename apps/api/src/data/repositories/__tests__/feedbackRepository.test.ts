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

      expect(owned).not.toBeNull();
      expect(rows.map((row) => row.id)).toEqual([owned!.id]);
      expect(rows.every((row) => row.userId === owner.id)).toBe(true);
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
