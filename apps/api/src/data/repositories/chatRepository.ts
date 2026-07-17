import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { ChatChipKind } from '@bettertrack/contracts';

import type { Database } from '../db';
import { chatConversations, chatMessages, users } from '../schema';

/**
 * Friend-chat persistence (PROJECTPLAN.md §13.3 V3-P8). Owns the
 * `chat_conversations` + `chat_messages` SQL; the chat service holds the rules
 * (friends-only, participant checks, per-viewer chip resolution).
 *
 * Two invariants live at this layer:
 *  - **One conversation per pair.** Rows are stored with the canonical ordering
 *    `user_a < user_b` (like {@link import('./friendshipRepository')}), so
 *    {@link ChatRepository.getOrCreateConversation} maps a pair to a single row
 *    regardless of who opened it; the unique index makes a race a no-op.
 *  - **Unread is derived, never a counter.** Each side's `*_last_read_at` marks
 *    how far they read; a viewer's unread is the messages after their marker not
 *    sent by them, computed per query — so it always survives a reload.
 */

/** The two participants of a conversation — the participant/friend gate reads this.
 * A `null` side is a deleted account (#362): the thread survives, anonymized. */
export interface ConversationParticipants {
  id: string;
  userA: string | null;
  userB: string | null;
}

/** The newest message of a thread, for the conversation-list preview. */
export interface ChatMessagePreviewRow {
  senderId: string | null;
  body: string | null;
  chipKind: ChatChipKind | null;
  createdAt: Date;
}

/** One conversation as seen by a viewer — the other party + derived unread + preview.
 * `otherUserId`/`otherUsername` are `null` when the other account was deleted (#362). */
export interface ChatConversationRow {
  id: string;
  otherUserId: string | null;
  otherUsername: string | null;
  otherProfileIcon: string | null;
  unreadCount: number;
  lastMessage: ChatMessagePreviewRow | null;
  lastMessageAt: Date | null;
}

/** A stored message row (chip is a bare polymorphic reference — resolved per-viewer upstream). */
export interface ChatMessageRow {
  id: string;
  conversationId: string;
  senderId: string | null;
  body: string | null;
  chipKind: ChatChipKind | null;
  chipSubjectId: string | null;
  createdAt: Date;
}

/** Canonical pair ordering (§6.9): a conversation row is always stored `user_a < user_b`. */
function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function createChatRepository(db: Database) {
  return {
    /**
     * The 1:1 conversation for a pair, creating it if absent. Idempotent against
     * the unique pair index — a concurrent create is a no-op, never a crash — so
     * repeat opens always resolve to the same conversation id.
     */
    async getOrCreateConversation(a: string, b: string): Promise<string> {
      const [lo, hi] = canonicalPair(a, b);
      await db.insert(chatConversations).values({ userA: lo, userB: hi }).onConflictDoNothing();
      const [row] = await db
        .select({ id: chatConversations.id })
        .from(chatConversations)
        .where(and(eq(chatConversations.userA, lo), eq(chatConversations.userB, hi)))
        .limit(1);
      return row!.id;
    },

    /**
     * The participants of a conversation, or `undefined` when it doesn't exist.
     * The service uses this for the participant gate (a non-participant 404s,
     * never data) and the friend gate on send (unfriending closes the thread).
     */
    async findParticipants(conversationId: string): Promise<ConversationParticipants | undefined> {
      const [row] = await db
        .select({
          id: chatConversations.id,
          userA: chatConversations.userA,
          userB: chatConversations.userB,
        })
        .from(chatConversations)
        .where(eq(chatConversations.id, conversationId))
        .limit(1);
      return row;
    },

    /**
     * The caller's conversation summaries — the other participant, the caller's
     * derived unread count, and the last-message preview — newest-active first.
     * Pass `conversationId` to build a single conversation's summary (open / send
     * / thread responses) with the exact same derivation, so the two never drift.
     *
     * Unread is a correlated count of messages the OTHER side sent after the
     * caller's `*_last_read_at` marker (all of them when the marker is null), so a
     * reload recomputes the identical number from persisted state.
     */
    async getConversationSummaries(
      userId: string,
      conversationId?: string,
    ): Promise<ChatConversationRow[]> {
      // The other participant, and the caller's own read marker, chosen by side.
      // `otherId` is NULL when that account was deleted (#362) — the LEFT JOIN
      // below keeps the (anonymized) conversation in the list regardless, and
      // IS DISTINCT FROM keeps a deleted sender's messages counted as unread.
      const otherId = sql<
        string | null
      >`case when ${chatConversations.userA} = ${userId} then ${chatConversations.userB} else ${chatConversations.userA} end`;
      const viewerLastRead = sql`case when ${chatConversations.userA} = ${userId} then ${chatConversations.userALastReadAt} else ${chatConversations.userBLastReadAt} end`;
      const unreadCount = sql<number>`(
        select count(*)::int from chat_messages cm
        where cm.conversation_id = ${chatConversations.id}
          and cm.sender_id is distinct from ${userId}
          and (${viewerLastRead} is null or cm.created_at > ${viewerLastRead})
      )`;

      const rows = await db
        .select({
          id: chatConversations.id,
          otherUserId: sql<string | null>`${otherId}`,
          otherUsername: users.username,
          otherProfileIcon: users.profileIcon,
          unreadCount,
          lastMessageAt: chatConversations.lastMessageAt,
        })
        .from(chatConversations)
        .leftJoin(users, sql`${users.id} = ${otherId}`)
        .where(
          and(
            or(eq(chatConversations.userA, userId), eq(chatConversations.userB, userId)),
            conversationId ? eq(chatConversations.id, conversationId) : undefined,
          ),
        )
        .orderBy(
          sql`${chatConversations.lastMessageAt} desc nulls last`,
          desc(chatConversations.id),
        );

      if (rows.length === 0) return [];

      // Newest message per conversation for the preview — one query, no N+1.
      const previews = await db
        .select({
          conversationId: chatMessages.conversationId,
          senderId: chatMessages.senderId,
          body: chatMessages.body,
          chipKind: chatMessages.chipKind,
          createdAt: chatMessages.createdAt,
          id: chatMessages.id,
        })
        .from(chatMessages)
        .where(
          inArray(
            chatMessages.conversationId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(chatMessages.conversationId, desc(chatMessages.id));

      const previewByConversation = new Map<string, ChatMessagePreviewRow>();
      for (const p of previews) {
        // Rows are id-desc within each conversation; the first seen is newest.
        if (previewByConversation.has(p.conversationId)) continue;
        previewByConversation.set(p.conversationId, {
          senderId: p.senderId,
          body: p.body,
          chipKind: p.chipKind,
          createdAt: p.createdAt,
        });
      }

      return rows.map((r) => ({
        id: r.id,
        otherUserId: r.otherUserId,
        otherUsername: r.otherUsername,
        otherProfileIcon: r.otherProfileIcon,
        unreadCount: r.unreadCount,
        lastMessage: previewByConversation.get(r.id) ?? null,
        lastMessageAt: r.lastMessageAt,
      }));
    },

    /**
     * Insert one message and bump the conversation's `last_message_at` in a
     * single transaction, returning the stored row. The chip is stored as a bare
     * `(kind, subjectId)` reference — never the item's identity.
     */
    async insertMessage(input: {
      conversationId: string;
      senderId: string;
      body: string | null;
      chipKind: ChatChipKind | null;
      chipSubjectId: string | null;
    }): Promise<ChatMessageRow> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(chatMessages)
          .values({
            conversationId: input.conversationId,
            senderId: input.senderId,
            body: input.body,
            chipKind: input.chipKind,
            chipSubjectId: input.chipSubjectId,
          })
          .returning();
        await tx
          .update(chatConversations)
          .set({ lastMessageAt: row!.createdAt })
          .where(eq(chatConversations.id, input.conversationId));
        return row!;
      });
    },

    /**
     * Newest-first page of a thread, keyset paginated by UUIDv7 id (§8). Scoped
     * by `conversation_id`; the participant gate is enforced by the service
     * before this is called, so no cross-thread leak by construction.
     */
    async listMessages(
      conversationId: string,
      params: { limit: number; cursor?: string },
    ): Promise<{ rows: ChatMessageRow[]; nextCursor: string | null }> {
      const rows = await db
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.conversationId, conversationId),
            params.cursor ? lt(chatMessages.id, params.cursor) : undefined,
          ),
        )
        .orderBy(desc(chatMessages.id))
        .limit(params.limit + 1);

      const hasMore = rows.length > params.limit;
      const page = hasMore ? rows.slice(0, params.limit) : rows;
      return {
        rows: page,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      };
    },

    /**
     * Advance the caller's read marker to now — clears their unread badge for the
     * thread. A single UPDATE sets only the caller's side (via CASE), scoped to a
     * conversation they participate in, so it can never touch the other party's
     * marker or a conversation that isn't theirs. Idempotent.
     */
    /**
     * Drop conversations whose BOTH participants are gone (#362): once the last
     * account of a pair is deleted (each side having been SET NULL by its FK),
     * nobody can ever read the thread again — messages cascade with the row.
     * Global + idempotent housekeeping, called after each account deletion.
     */
    async purgeOrphanedConversations(): Promise<void> {
      await db
        .delete(chatConversations)
        .where(and(isNull(chatConversations.userA), isNull(chatConversations.userB)));
    },

    async markRead(userId: string, conversationId: string): Promise<void> {
      await db
        .update(chatConversations)
        .set({
          userALastReadAt: sql`case when ${chatConversations.userA} = ${userId} then now() else ${chatConversations.userALastReadAt} end`,
          userBLastReadAt: sql`case when ${chatConversations.userB} = ${userId} then now() else ${chatConversations.userBLastReadAt} end`,
        })
        .where(
          and(
            eq(chatConversations.id, conversationId),
            or(eq(chatConversations.userA, userId), eq(chatConversations.userB, userId)),
          ),
        );
    },
  };
}

export type ChatRepository = ReturnType<typeof createChatRepository>;
