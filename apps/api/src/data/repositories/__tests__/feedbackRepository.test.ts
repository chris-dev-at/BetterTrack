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
});
