import { and, eq } from 'drizzle-orm';

import type { DevicePlatform } from '@bettertrack/contracts';

import type { Database } from '../db';
import { deviceTokens } from '../schema';

/**
 * FCM device-token persistence (#368/#351). One row per push token; `token` is
 * globally unique, so registration is an idempotent upsert that also RE-BINDS
 * the token to the registering user — a device that logs into another account
 * takes its pushes along instead of leaking them to the previous owner.
 */

/** One registered device as the push channel consumes it. */
export interface DeviceTokenRecord {
  id: string;
  userId: string;
  token: string;
  platform: DevicePlatform;
}

export function createDeviceTokenRepository(db: Database) {
  return {
    /**
     * Register (or refresh) a token for `userId`. Conflict on the unique token
     * re-binds owner + platform and bumps `last_seen_at` — never a duplicate row.
     */
    async upsert(userId: string, token: string, platform: DevicePlatform): Promise<void> {
      await db
        .insert(deviceTokens)
        .values({ userId, token, platform })
        .onConflictDoUpdate({
          target: deviceTokens.token,
          set: { userId, platform, lastSeenAt: new Date() },
        });
    },

    /**
     * Remove one of the CALLER's tokens. A token owned by someone else (or
     * unknown) deletes nothing — the caller can never unregister another user's
     * device. Idempotent.
     */
    async deleteForUser(userId: string, token: string): Promise<void> {
      await db
        .delete(deviceTokens)
        .where(and(eq(deviceTokens.userId, userId), eq(deviceTokens.token, token)));
    },

    /**
     * Prune a dead token regardless of owner — the push channel calls this when
     * FCM reports 404/UNREGISTERED for it (#368).
     */
    async deleteByToken(token: string): Promise<void> {
      await db.delete(deviceTokens).where(eq(deviceTokens.token, token));
    },

    /** Every registered device of one user — the push channel's fan-out set. */
    async listForUser(userId: string): Promise<DeviceTokenRecord[]> {
      const rows = await db
        .select({
          id: deviceTokens.id,
          userId: deviceTokens.userId,
          token: deviceTokens.token,
          platform: deviceTokens.platform,
        })
        .from(deviceTokens)
        .where(eq(deviceTokens.userId, userId));
      return rows;
    },
  };
}

export type DeviceTokenRepository = ReturnType<typeof createDeviceTokenRepository>;
