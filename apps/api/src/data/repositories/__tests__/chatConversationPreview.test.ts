import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { Database } from '../../db';
import * as schema from '../../schema';
import { createTestApp } from '../../../testing/createTestApp';
import { createChatRepository } from '../chatRepository';

/** One awaited statement: the SQL that ran, and how many rows it handed back. */
interface QueryTrace {
  sql: string;
  rows: number;
}

/**
 * A `Database` façade that records what every awaited query ACTUALLY returned.
 *
 * The bug #1725 fixes is invisible in the response: the conversation list looked
 * identical whether the preview was picked in SQL or picked in JS out of the
 * whole message history. Only the row count of the statement itself tells the
 * two apart, and drizzle's builders are thenables — so intercepting `then` is
 * the point where both the SQL and its result set are in hand.
 */
function recordingDb(db: Database, trace: QueryTrace[]): Database {
  const wrap = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const builder = value as { toSQL?: () => { sql: string }; from?: unknown };
    // A select arrives in two stages — `select()` hands back a builder with only
    // `.from()`, `.from()` hands back the runnable statement — so both shapes are
    // followed. `.as()` yields a plain subquery (neither), left untouched so
    // drizzle's own identity checks on it still see the real object.
    if (typeof builder.toSQL !== 'function' && typeof builder.from !== 'function') return value;
    return new Proxy(builder, {
      get(target, prop, receiver) {
        const member = Reflect.get(target, prop, receiver);
        if (typeof member !== 'function') return member;
        if (prop === 'then') {
          return (onFulfilled?: (rows: unknown) => unknown, onRejected?: unknown) =>
            (member as (...args: unknown[]) => unknown).call(
              target,
              (rows: unknown) => {
                if (Array.isArray(rows) && typeof target.toSQL === 'function') {
                  trace.push({ sql: target.toSQL().sql, rows: rows.length });
                }
                return onFulfilled?.(rows);
              },
              onRejected,
            );
        }
        return (...args: unknown[]) =>
          wrap((member as (...args: unknown[]) => unknown).apply(target, args));
      },
    });
  };
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      const member = Reflect.get(target, prop, receiver);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) =>
        wrap((member as (...args: unknown[]) => unknown).apply(target, args));
    },
  }) as Database;
}

describe('chat conversation previews are bounded by the conversations, not the history (#1725)', () => {
  it('reads at most one message row per conversation, for the list and for one thread', async () => {
    const harness = await createTestApp();
    try {
      const alice = await harness.seedUser({
        email: 'chat-preview-alice@bt.test',
        username: 'chatpreviewalice',
      });
      const bob = await harness.seedUser({
        email: 'chat-preview-bob@bt.test',
        username: 'chatpreviewbob',
      });
      const carol = await harness.seedUser({
        email: 'chat-preview-carol@bt.test',
        username: 'chatpreviewcarol',
      });

      const repo = createChatRepository(harness.db);
      const withBob = await repo.getOrCreateConversation(alice.id, bob.id);
      const withCarol = await repo.getOrCreateConversation(alice.id, carol.id);

      // A long thread and a short one. The preview is one line either way.
      const base = Date.parse('2026-08-01T00:00:00.000Z');
      await harness.db.insert(schema.chatMessages).values(
        Array.from({ length: 40 }, (_unused, index) => ({
          conversationId: withBob,
          senderId: bob.id,
          body: `from bob ${index}`,
          createdAt: new Date(base + index * 1000),
        })),
      );
      await harness.db.insert(schema.chatMessages).values(
        Array.from({ length: 5 }, (_unused, index) => ({
          conversationId: withCarol,
          senderId: carol.id,
          body: `from carol ${index}`,
          createdAt: new Date(base + index * 1000),
        })),
      );
      await harness.db
        .update(schema.chatConversations)
        .set({ lastMessageAt: new Date(base + 39 * 1000) })
        .where(eq(schema.chatConversations.id, withBob));
      await harness.db
        .update(schema.chatConversations)
        .set({ lastMessageAt: new Date(base + 4 * 1000) })
        .where(eq(schema.chatConversations.id, withCarol));

      const trace: QueryTrace[] = [];
      const traced = createChatRepository(recordingDb(harness.db, trace));

      const summaries = await traced.getConversationSummaries(alice.id);

      // The preview statement exists, and it returned ONE row per conversation —
      // not the 45 messages those two conversations hold.
      const previewReads = trace.filter((entry) => /distinct on/i.test(entry.sql));
      expect(previewReads).toHaveLength(1);
      expect(previewReads[0]!.rows).toBe(2);
      // Nothing this read issues may return more rows than there are
      // conversations: that is the whole invariant, stated once.
      expect(Math.max(...trace.map((entry) => entry.rows))).toBe(2);

      // …and the preview content is exactly what the JS pick produced before.
      expect(summaries.map((row) => row.id)).toEqual([withBob, withCarol]);
      expect(summaries[0]!.lastMessage).toMatchObject({
        senderId: bob.id,
        body: 'from bob 39',
        chipKind: null,
        createdAt: new Date(base + 39 * 1000),
      });
      expect(summaries[1]!.lastMessage).toMatchObject({ body: 'from carol 4' });
      // Unread stays derived from the marker, untouched by the preview change.
      expect(summaries.map((row) => row.unreadCount)).toEqual([40, 5]);

      // The single-conversation form (open / send / thread) is bounded too.
      trace.length = 0;
      const [one] = await traced.getConversationSummaries(alice.id, withBob);
      expect(Math.max(...trace.map((entry) => entry.rows))).toBe(1);
      expect(one!.lastMessage?.body).toBe('from bob 39');
      expect(one!.unreadCount).toBe(40);
    } finally {
      await harness.dispose();
    }
  });

  it('keeps a conversation with no message at all out of the preview map', async () => {
    const harness = await createTestApp();
    try {
      const alice = await harness.seedUser({
        email: 'chat-preview-empty-alice@bt.test',
        username: 'chatpreviewemptyalice',
      });
      const bob = await harness.seedUser({
        email: 'chat-preview-empty-bob@bt.test',
        username: 'chatpreviewemptybob',
      });
      const repo = createChatRepository(harness.db);
      await repo.getOrCreateConversation(alice.id, bob.id);

      const [only] = await repo.getConversationSummaries(alice.id);

      expect(only!.lastMessage).toBeNull();
      expect(only!.lastMessageAt).toBeNull();
      expect(only!.unreadCount).toBe(0);
    } finally {
      await harness.dispose();
    }
  });
});
