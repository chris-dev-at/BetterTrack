import { and, asc, eq, gt } from 'drizzle-orm';

import type { Database } from '../db';
import { discordWebhooks } from '../schema';

/**
 * Discord webhook persistence (§13.4 V4-P10). One row per user (PK on
 * `user_id`) carrying the ENCRYPTED webhook URL (`secretBox` envelope) plus a
 * masked webhook-id slug for the settings UI. The channel decrypts at delivery
 * time. Rows cascade with the owner.
 */

/** One stored webhook row as callers consume it. */
export interface DiscordWebhookRecord {
  userId: string;
  encryptedUrl: string;
  webhookIdMasked: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiscordSecretEnvelope {
  userId: string;
  envelope: string;
}

export function createDiscordWebhookRepository(db: Database) {
  return {
    async findForUser(userId: string): Promise<DiscordWebhookRecord | null> {
      const [row] = await db
        .select()
        .from(discordWebhooks)
        .where(eq(discordWebhooks.userId, userId));
      return row ?? null;
    },

    /** Stable cursor page for the online record-encryption command. */
    async listSecretEnvelopes(
      afterUserId: string | null,
      limit: number,
    ): Promise<DiscordSecretEnvelope[]> {
      return db
        .select({ userId: discordWebhooks.userId, envelope: discordWebhooks.encryptedUrl })
        .from(discordWebhooks)
        .where(afterUserId ? gt(discordWebhooks.userId, afterUserId) : undefined)
        .orderBy(asc(discordWebhooks.userId))
        .limit(limit);
    },

    /**
     * Compare-and-swap a webhook envelope so a concurrent user save is never
     * replaced by a migration that inspected an older value.
     */
    async replaceSecretEnvelope(
      userId: string,
      expectedEnvelope: string,
      replacementEnvelope: string,
    ): Promise<boolean> {
      const replaced = await db
        .update(discordWebhooks)
        .set({ encryptedUrl: replacementEnvelope, updatedAt: new Date() })
        .where(
          and(
            eq(discordWebhooks.userId, userId),
            eq(discordWebhooks.encryptedUrl, expectedEnvelope),
          ),
        )
        .returning({ userId: discordWebhooks.userId });
      return replaced.length === 1;
    },

    /** Save (or refresh) the caller's webhook. Idempotent by PK. */
    async upsert(
      userId: string,
      params: { encryptedUrl: string; webhookIdMasked: string },
    ): Promise<void> {
      const now = new Date();
      await db
        .insert(discordWebhooks)
        .values({
          userId,
          encryptedUrl: params.encryptedUrl,
          webhookIdMasked: params.webhookIdMasked,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: discordWebhooks.userId,
          set: {
            encryptedUrl: params.encryptedUrl,
            webhookIdMasked: params.webhookIdMasked,
            updatedAt: now,
          },
        });
    },

    /** Drop the caller's webhook (idempotent). */
    async deleteForUser(userId: string): Promise<void> {
      await db.delete(discordWebhooks).where(eq(discordWebhooks.userId, userId));
    },
  };
}

export type DiscordWebhookRepository = ReturnType<typeof createDiscordWebhookRepository>;
