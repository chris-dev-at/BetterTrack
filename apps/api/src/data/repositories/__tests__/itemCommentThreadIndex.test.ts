import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import * as schema from '../../schema';
import { createTestApp } from '../../../testing/createTestApp';
import { createItemCommentRepository } from '../itemCommentRepository';

const SUBJECT = '11111111-1111-4111-8111-111111111111';

describe('the comment thread read has an index that can serve it (#1725)', () => {
  it('ships a partial index carrying the thread filter AND its ordering', async () => {
    const harness = await createTestApp();
    try {
      const rows = await harness.db.execute<{ indexdef: string }>(
        sql`select indexdef from pg_indexes
            where tablename = 'item_comments' and indexname = 'item_comments_thread_idx'`,
      );
      // drizzle's execute() shape differs per driver; both carry `rows`.
      const definition = String(
        (rows as unknown as { rows: { indexdef: string }[] }).rows[0]?.indexdef ?? '',
      ).toLowerCase();

      // Filter columns lead, ordering columns follow in the read's own
      // direction, and the tombstone is proven by the index rather than the heap.
      expect(definition).toContain('kind');
      expect(definition).toContain('subject_id');
      expect(definition).toContain('created_at desc');
      expect(definition).toContain('id desc');
      expect(definition).toMatch(/where \(?deleted_at is null\)?/);
    } finally {
      await harness.dispose();
    }
  });

  it('leaves page size, ordering and the lookahead row exactly as they were', async () => {
    const harness = await createTestApp();
    try {
      const author = await harness.seedUser({
        email: 'thread-index-author@bt.test',
        username: 'threadindexauthor',
      });
      const repo = createItemCommentRepository(harness.db);

      const base = Date.parse('2026-08-02T00:00:00.000Z');
      await harness.db.insert(schema.itemComments).values(
        Array.from({ length: 6 }, (_unused, index) => ({
          kind: 'portfolio' as const,
          subjectId: SUBJECT,
          authorId: author.id,
          body: `comment ${index}`,
          createdAt: new Date(base + index * 1000),
          // The middle one is tombstoned: the partial index must not hide it
          // from the filter, it must simply not contain it.
          deletedAt: index === 3 ? new Date(base) : null,
        })),
      );

      // Newest-first out of SQL, one row beyond the page as the lookahead.
      const first = await repo.listForItem('portfolio', SUBJECT, { limit: 3 });
      expect(first.map((row) => row.body)).toEqual(['comment 5', 'comment 4', 'comment 2']);

      const older = await repo.listForItem('portfolio', SUBJECT, {
        limit: 3,
        before: first[1]!.id,
      });
      expect(older.map((row) => row.body)).toEqual(['comment 2', 'comment 1', 'comment 0']);

      // The tombstone is out of every read, and out of the live count.
      await expect(repo.countForItem('portfolio', SUBJECT)).resolves.toBe(5);
    } finally {
      await harness.dispose();
    }
  });
});
