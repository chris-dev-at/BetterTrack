import type { Redis } from 'ioredis';

import { PRESENCE_TTL_SECONDS, type PresenceSurface } from '@bettertrack/contracts';

/**
 * Active-view presence store (#368). The realtime gateway writes what each
 * authed client is currently viewing (v1 surface: a chat conversation) into
 * Redis keys with a short TTL; the notification dispatcher — possibly in a
 * different process — reads them to SUPPRESS notifying a user about the surface
 * they have open.
 *
 * Staleness is bounded by the TTL: clients re-emit `presence.enter` as a
 * heartbeat while the surface stays open + focused, an explicit
 * `presence.leave` clears immediately, and a dropped client silently lapses —
 * the dispatcher can never suppress on presence older than the TTL. Keys are
 * per (user, surface, subject): a second tab keeps its own heartbeat, so one
 * tab leaving under-suppresses for at most one heartbeat interval.
 */

export const presenceKey = (userId: string, surface: PresenceSurface, id: string): string =>
  `bt:presence:${userId}:${surface}:${id}`;

export interface PresenceStore {
  /** Declare (or refresh — idempotent heartbeat) the user viewing a surface. */
  enter(userId: string, surface: PresenceSurface, id: string): Promise<void>;
  /** Clear the declaration (surface closed / tab blurred). Idempotent. */
  leave(userId: string, surface: PresenceSurface, id: string): Promise<void>;
  /** Whether the user is actively viewing the surface right now. */
  isPresent(userId: string, surface: PresenceSurface, id: string): Promise<boolean>;
}

export interface CreatePresenceStoreDeps {
  redis: Redis;
  /** Override for tests; defaults to the contract TTL. */
  ttlSeconds?: number;
}

export function createPresenceStore(deps: CreatePresenceStoreDeps): PresenceStore {
  const { redis } = deps;
  const ttl = deps.ttlSeconds ?? PRESENCE_TTL_SECONDS;
  return {
    async enter(userId, surface, id): Promise<void> {
      await redis.set(presenceKey(userId, surface, id), '1', 'EX', ttl);
    },
    async leave(userId, surface, id): Promise<void> {
      await redis.del(presenceKey(userId, surface, id));
    },
    async isPresent(userId, surface, id): Promise<boolean> {
      return (await redis.exists(presenceKey(userId, surface, id))) === 1;
    },
  };
}
