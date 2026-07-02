import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

export interface SessionData {
  userId: string;
  createdAt: number;
  /** Last time the 30-day window was reset — on login (create) or PIN verify (renew). */
  renewedAt: number;
}

export interface SessionService {
  create(userId: string): Promise<string>;
  get(sessionId: string): Promise<SessionData | null>;
  /** Reset the session's 30-day window (login / PIN verify). False if it's already gone. */
  renew(sessionId: string): Promise<boolean>;
  destroy(sessionId: string): Promise<void>;
  destroyAllForUser(userId: string): Promise<void>;
}

const sessionKey = (sessionId: string) => `sess:${sessionId}`;
const userIndexKey = (userId: string) => `user_sessions:${userId}`;

/**
 * Redis-backed sessions (PROJECTPLAN.md §6.1, §10). The session id is an opaque
 * 256-bit CSPRNG token (carried in a signed httpOnly cookie). A per-user index
 * set makes "kill all of this user's sessions" exact — used on password change
 * and account disable.
 *
 * The 30-day window is **fixed, not rolling** (owner directive #79): a session
 * expires 30 days after the last *login or PIN verify*, regardless of ordinary
 * activity in between. So `get` — which runs on every authenticated request —
 * deliberately does NOT extend the TTL; only `create` (login) and `renew` (PIN
 * verify) reset it to the full window. That is what makes "relogin every 30
 * days unless you log in or enter your PIN" hold. `ttlSeconds` is the 30-day
 * window (config.cookie.maxAgeMs / 1000).
 */
export function createSessionService(redis: Redis, ttlSeconds: number): SessionService {
  // Refresh the per-user index to at least the session TTL so destroyAllForUser
  // can always find live sessions. A longer-than-needed index TTL is harmless:
  // dead ids in the set just no-op on del.
  const touchIndex = (userId: string) => redis.expire(userIndexKey(userId), ttlSeconds);

  return {
    async create(userId) {
      const sessionId = randomBytes(32).toString('base64url');
      const now = Date.now();
      const data: SessionData = { userId, createdAt: now, renewedAt: now };
      await redis.set(sessionKey(sessionId), JSON.stringify(data), 'EX', ttlSeconds);
      await redis.sadd(userIndexKey(userId), sessionId);
      await touchIndex(userId);
      return sessionId;
    },

    async get(sessionId) {
      const raw = await redis.get(sessionKey(sessionId));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as SessionData;
      } catch {
        await redis.del(sessionKey(sessionId));
        return null;
      }
    },

    async renew(sessionId) {
      const raw = await redis.get(sessionKey(sessionId));
      if (!raw) return false;
      let data: SessionData;
      try {
        data = JSON.parse(raw) as SessionData;
      } catch {
        await redis.del(sessionKey(sessionId));
        return false;
      }
      data.renewedAt = Date.now();
      // Rewrite the payload AND reset the TTL to a fresh full 30-day window.
      await redis.set(sessionKey(sessionId), JSON.stringify(data), 'EX', ttlSeconds);
      await touchIndex(data.userId);
      return true;
    },

    async destroy(sessionId) {
      const raw = await redis.get(sessionKey(sessionId));
      await redis.del(sessionKey(sessionId));
      if (raw) {
        try {
          const data = JSON.parse(raw) as SessionData;
          await redis.srem(userIndexKey(data.userId), sessionId);
        } catch {
          // Corrupt payload already deleted above.
        }
      }
    },

    async destroyAllForUser(userId) {
      const sessionIds = await redis.smembers(userIndexKey(userId));
      const pipeline = redis.pipeline();
      for (const sessionId of sessionIds) {
        pipeline.del(sessionKey(sessionId));
      }
      pipeline.del(userIndexKey(userId));
      await pipeline.exec();
    },
  };
}
