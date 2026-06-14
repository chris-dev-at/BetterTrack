import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

export interface SessionData {
  userId: string;
  createdAt: number;
}

export interface SessionService {
  create(userId: string): Promise<string>;
  get(sessionId: string): Promise<SessionData | null>;
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
 */
export function createSessionService(redis: Redis, ttlSeconds: number): SessionService {
  return {
    async create(userId) {
      const sessionId = randomBytes(32).toString('base64url');
      const data: SessionData = { userId, createdAt: Date.now() };
      await redis.set(sessionKey(sessionId), JSON.stringify(data), 'EX', ttlSeconds);
      await redis.sadd(userIndexKey(userId), sessionId);
      await redis.expire(userIndexKey(userId), ttlSeconds);
      return sessionId;
    },

    async get(sessionId) {
      const raw = await redis.get(sessionKey(sessionId));
      if (!raw) return null;
      let data: SessionData;
      try {
        data = JSON.parse(raw) as SessionData;
      } catch {
        await redis.del(sessionKey(sessionId));
        return null;
      }
      // Rolling expiry: touch TTLs on every authenticated access.
      await redis.expire(sessionKey(sessionId), ttlSeconds);
      await redis.expire(userIndexKey(data.userId), ttlSeconds);
      return data;
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
