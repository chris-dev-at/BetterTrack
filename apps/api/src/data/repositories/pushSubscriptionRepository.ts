import { and, eq } from 'drizzle-orm';

import type { Database } from '../db';
import { pushSubscriptions } from '../schema';

/**
 * Web-push (VAPID) subscription persistence (#368/#350). One row per
 * subscription `endpoint` (globally unique); re-subscribing upserts and
 * re-binds to the caller, mirroring `deviceTokenRepository`. The webpush
 * channel prunes rows its push service reports gone (HTTP 404/410).
 */

/** One stored subscription as the webpush channel consumes it. */
export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function createPushSubscriptionRepository(db: Database) {
  return {
    /** Store (or refresh) a subscription for `userId`, keyed by endpoint. */
    async upsert(
      userId: string,
      sub: { endpoint: string; p256dh: string; auth: string },
    ): Promise<void> {
      await db
        .insert(pushSubscriptions)
        .values({ userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: { userId, p256dh: sub.p256dh, auth: sub.auth, lastSeenAt: new Date() },
        });
    },

    /** Remove one of the CALLER's subscriptions (idempotent, never another user's). */
    async deleteForUser(userId: string, endpoint: string): Promise<void> {
      await db
        .delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
    },

    /** Prune a dead subscription regardless of owner (push service said 404/410). */
    async deleteByEndpoint(endpoint: string): Promise<void> {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    },

    /** Every stored subscription of one user — the webpush channel's fan-out set. */
    async listForUser(userId: string): Promise<PushSubscriptionRecord[]> {
      const rows = await db
        .select({
          id: pushSubscriptions.id,
          userId: pushSubscriptions.userId,
          endpoint: pushSubscriptions.endpoint,
          p256dh: pushSubscriptions.p256dh,
          auth: pushSubscriptions.auth,
        })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId));
      return rows;
    },
  };
}

export type PushSubscriptionRepository = ReturnType<typeof createPushSubscriptionRepository>;
