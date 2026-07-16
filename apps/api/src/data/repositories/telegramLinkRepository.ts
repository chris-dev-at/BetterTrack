import { eq } from 'drizzle-orm';

import type { Database } from '../db';
import { telegramLinks } from '../schema';

/**
 * Telegram bot chat-link persistence (§13.4 V4-P10). One row per user (PK on
 * `user_id`) carrying either a pending link code (`chat_id` NULL) or a
 * confirmed chat (`chat_id` set). The bot token is server-side / in env — this
 * table only owns the per-user relationship + code state.
 *
 * The Telegram channel calls {@link listChatIdsForUser} at delivery time and
 * {@link deleteChatId} when Telegram returns 403 for a bot the user blocked
 * (mirrors FCM's UNREGISTERED prune). Handshake is confirmed via
 * {@link findByCode} + {@link confirmLink}, which drops the code atomically.
 */

/** One stored link row as callers consume it. */
export interface TelegramLinkRecord {
  userId: string;
  chatId: string | null;
  botUsername: string | null;
  linkCode: string | null;
  linkCodeExpiresAt: Date | null;
  linkedAt: Date | null;
}

export function createTelegramLinkRepository(db: Database) {
  return {
    /** The row for one user, or null if they have never touched Telegram. */
    async findForUser(userId: string): Promise<TelegramLinkRecord | null> {
      const [row] = await db.select().from(telegramLinks).where(eq(telegramLinks.userId, userId));
      return row ? toRecord(row) : null;
    },

    /**
     * Store a fresh single-use link code for the caller, replacing any prior
     * pending code and blowing away any confirmed chat id — asking for a fresh
     * link is treated as "start over". Idempotent by PK.
     */
    async putPendingCode(
      userId: string,
      params: { code: string; expiresAt: Date; botUsername: string },
    ): Promise<void> {
      await db
        .insert(telegramLinks)
        .values({
          userId,
          chatId: null,
          botUsername: params.botUsername,
          linkCode: params.code,
          linkCodeExpiresAt: params.expiresAt,
          linkedAt: null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: telegramLinks.userId,
          set: {
            chatId: null,
            botUsername: params.botUsername,
            linkCode: params.code,
            linkCodeExpiresAt: params.expiresAt,
            linkedAt: null,
            updatedAt: new Date(),
          },
        });
    },

    /**
     * Locate a pending link by its code (no user context — Telegram's
     * `/start <code>` webhook arrives without one, and the SPA's confirm path
     * also finds "did anyone use this code" without disclosing the user). Only
     * returns rows whose code has not expired.
     */
    async findByCode(code: string, now: Date): Promise<TelegramLinkRecord | null> {
      const rows = await db.select().from(telegramLinks).where(eq(telegramLinks.linkCode, code));
      for (const row of rows) {
        if (row.linkCode !== code) continue;
        if (row.linkCodeExpiresAt && row.linkCodeExpiresAt.getTime() < now.getTime()) continue;
        return toRecord(row);
      }
      return null;
    },

    /**
     * Attach a chat id to the caller's pending row and clear the code + expiry.
     * Idempotent on a repeat call with the same chat id.
     */
    async confirmLink(userId: string, chatId: string, now: Date): Promise<void> {
      await db
        .update(telegramLinks)
        .set({
          chatId,
          linkCode: null,
          linkCodeExpiresAt: null,
          linkedAt: now,
          updatedAt: now,
        })
        .where(eq(telegramLinks.userId, userId));
    },

    /** Remove the caller's row entirely — unlink Telegram for that user. */
    async deleteForUser(userId: string): Promise<void> {
      await db.delete(telegramLinks).where(eq(telegramLinks.userId, userId));
    },

    /**
     * Every chat id that belongs to `userId` (currently at most one, but the
     * shape parallels {@link DeviceTokenRepository.listForUser} to keep the
     * channel loop uniform). An unlinked or pending-only row returns an empty
     * list — the channel then no-ops.
     */
    async listChatIdsForUser(userId: string): Promise<string[]> {
      const rows = await db
        .select({ chatId: telegramLinks.chatId })
        .from(telegramLinks)
        .where(eq(telegramLinks.userId, userId));
      return rows.map((r) => r.chatId).filter((id): id is string => id !== null);
    },

    /**
     * Prune a dead chat id regardless of owner (Telegram said the bot is
     * blocked or the chat is gone). Mirrors {@link DeviceTokenRepository.deleteByToken}.
     */
    async deleteChatId(chatId: string): Promise<void> {
      await db.delete(telegramLinks).where(eq(telegramLinks.chatId, chatId));
    },
  };
}

function toRecord(row: typeof telegramLinks.$inferSelect): TelegramLinkRecord {
  return {
    userId: row.userId,
    chatId: row.chatId,
    botUsername: row.botUsername,
    linkCode: row.linkCode,
    linkCodeExpiresAt: row.linkCodeExpiresAt,
    linkedAt: row.linkedAt,
  };
}

export type TelegramLinkRepository = ReturnType<typeof createTelegramLinkRepository>;
