import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import * as schema from '../../schema';
import { createTestApp } from '../../../testing/createTestApp';
import { createItemCommentRepository } from '../itemCommentRepository';
import { createItemReactionRepository } from '../itemReactionRepository';

const SUBJECT = '22222222-2222-4222-8222-222222222222';

/** Rows of a raw `db.execute`, whichever shape the driver returns them in. */
function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows: unknown = (result as { rows?: unknown } | null)?.rows;
  if (Array.isArray(rows)) return rows as T[];
  throw new Error('Unsupported database driver result shape for the pg_indexes read');
}

/**
 * #1829 — the probe that decides whether a thread read pays for participant
 * enumeration and per-participant privacy locks at all. It has to answer NO
 * cheaply (the ordinary case) and YES exactly when the guard would have filtered
 * somebody, otherwise the fast path would disclose a paranoid participant.
 */
describe('the thread’s restricted-participant probe (#1829)', () => {
  it('ships the partial index the probe is built on', async () => {
    const harness = await createTestApp();
    try {
      const rows = await harness.db.execute<{ indexdef: string }>(
        sql`select indexdef from pg_indexes
            where tablename = 'users' and indexname = 'users_privacy_mode_restricted_idx'`,
      );
      const definition = String(
        resultRows<{ indexdef: string }>(rows)[0]?.indexdef ?? '',
      ).toLowerCase();
      // Partial on exactly the probe's predicate, so it holds one entry per
      // paranoid account — none at all on an ordinary deployment.
      expect(definition).toMatch(/where \(?privacy_mode <> 'normal'/);
    } finally {
      await harness.dispose();
    }
  });

  it('answers no for an ordinary thread and yes for each way a paranoid account can appear', async () => {
    const harness = await createTestApp();
    try {
      const comments = createItemCommentRepository(harness.db);
      const reactions = createItemReactionRepository(harness.db);
      const normal = await harness.seedUser({
        email: 'probe-normal@bt.test',
        username: 'probenormal',
      });
      const hidden = await harness.seedUser({
        email: 'probe-hidden@bt.test',
        username: 'probehidden',
      });

      const [live] = await harness.db
        .insert(schema.itemComments)
        .values({
          kind: 'portfolio',
          subjectId: SUBJECT,
          authorId: normal.id,
          body: 'a comment',
        })
        .returning({ id: schema.itemComments.id });
      await harness.db.insert(schema.itemReactions).values([
        {
          userId: normal.id,
          targetType: 'item',
          kind: 'portfolio',
          subjectId: SUBJECT,
          emoji: '🔥',
        },
        { userId: normal.id, targetType: 'comment', commentId: live!.id, emoji: '👍' },
      ]);

      // Everyone normal: nothing to filter, so nothing to enumerate or lock.
      await expect(comments.hasRestrictedParticipant('portfolio', SUBJECT)).resolves.toBe(false);
      await expect(reactions.hasRestrictedThreadActor('portfolio', SUBJECT)).resolves.toBe(false);
      await expect(reactions.hasRestrictedItemActor('portfolio', SUBJECT)).resolves.toBe(false);
      await expect(reactions.hasRestrictedCommentActor(live!.id)).resolves.toBe(false);

      await harness.db
        .update(schema.users)
        .set({ privacyMode: 'paranoid', paranoidMediaSet: ['server'] })
        .where(eq(schema.users.id, hidden.id));

      // A paranoid account that touches nothing here is still not this thread's
      // problem — the probe is per thread, not per server.
      await expect(comments.hasRestrictedParticipant('portfolio', SUBJECT)).resolves.toBe(false);
      await expect(reactions.hasRestrictedThreadActor('portfolio', SUBJECT)).resolves.toBe(false);

      // …one comment by them, and the read has to take the filtered path.
      const [hiddenComment] = await harness.db
        .insert(schema.itemComments)
        .values({
          kind: 'portfolio',
          subjectId: SUBJECT,
          authorId: hidden.id,
          body: 'theirs',
        })
        .returning({ id: schema.itemComments.id });
      await expect(comments.hasRestrictedParticipant('portfolio', SUBJECT)).resolves.toBe(true);

      // A tombstoned comment is out of every read, so it is out of the probe too.
      await harness.db
        .update(schema.itemComments)
        .set({ deletedAt: new Date(), body: '' })
        .where(eq(schema.itemComments.id, hiddenComment!.id));
      await expect(comments.hasRestrictedParticipant('portfolio', SUBJECT)).resolves.toBe(false);

      // Each reaction shape independently forces the filtered path.
      await harness.db.insert(schema.itemReactions).values({
        userId: hidden.id,
        targetType: 'item',
        kind: 'portfolio',
        subjectId: SUBJECT,
        emoji: '❤️',
      });
      await expect(reactions.hasRestrictedItemActor('portfolio', SUBJECT)).resolves.toBe(true);
      await expect(reactions.hasRestrictedThreadActor('portfolio', SUBJECT)).resolves.toBe(true);
      await expect(reactions.hasRestrictedCommentActor(live!.id)).resolves.toBe(false);

      await harness.db
        .insert(schema.itemReactions)
        .values({ userId: hidden.id, targetType: 'comment', commentId: live!.id, emoji: '🎉' });
      await expect(reactions.hasRestrictedCommentActor(live!.id)).resolves.toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('bounds the discovery scans and answers the own-row question exactly', async () => {
    const harness = await createTestApp();
    try {
      const comments = createItemCommentRepository(harness.db);
      const reactions = createItemReactionRepository(harness.db);
      const authors = [];
      for (let index = 0; index < 4; index += 1) {
        authors.push(
          await harness.seedUser({
            email: `probe-bound-${index}@bt.test`,
            username: `probebound${index}`,
          }),
        );
      }
      await harness.db.insert(schema.itemComments).values(
        authors.map((author) => ({
          kind: 'portfolio' as const,
          subjectId: SUBJECT,
          authorId: author.id,
          body: 'hello',
        })),
      );
      await harness.db.insert(schema.itemReactions).values(
        authors.map((author) => ({
          userId: author.id,
          targetType: 'item' as const,
          kind: 'portfolio' as const,
          subjectId: SUBJECT,
          emoji: '🔥',
        })),
      );

      // The ceiling is a hard LIMIT on both halves — the caller turns these ids
      // into a lock set, so an unbounded answer would be an unbounded transaction.
      await expect(comments.listParticipantsForItem('portfolio', SUBJECT, 2)).resolves.toHaveLength(
        2,
      );
      await expect(reactions.listActorIdsForThread('portfolio', SUBJECT, 2)).resolves.toHaveLength(
        2,
      );
      await expect(
        comments.listParticipantsForItem('portfolio', SUBJECT, 10),
      ).resolves.toHaveLength(4);

      // The own-row question the withdrawal path asks before it deletes anything.
      const [me] = authors;
      await expect(reactions.hasOwnItemReaction(me!.id, 'portfolio', SUBJECT, '🔥')).resolves.toBe(
        true,
      );
      await expect(reactions.hasOwnItemReaction(me!.id, 'portfolio', SUBJECT, '🎉')).resolves.toBe(
        false,
      );
      await expect(
        reactions.hasOwnCommentReaction(me!.id, '33333333-3333-4333-8333-333333333333', '🔥'),
      ).resolves.toBe(false);
    } finally {
      await harness.dispose();
    }
  });
});
