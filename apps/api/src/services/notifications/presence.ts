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

/** One presence declaration's subject: the surface and the item on it. */
export interface PresenceSubject {
  surface: PresenceSurface;
  id: string;
}

/**
 * Keys per `DEL`. A vanished socket's whole claim set clears in
 * `ceil(n / this)` round trips instead of one awaited round trip per claim,
 * while still bounding the size of any single command.
 */
export const PRESENCE_LEAVE_BATCH = 64;

export interface PresenceStore {
  /** Declare (or refresh — idempotent heartbeat) the user viewing a surface. */
  enter(userId: string, surface: PresenceSurface, id: string): Promise<void>;
  /** Clear the declaration (surface closed / tab blurred). Idempotent. */
  leave(userId: string, surface: PresenceSurface, id: string): Promise<void>;
  /**
   * Clear many declarations of one user at once (a socket disconnecting with
   * every claim it still held). Idempotent, and bounded to
   * `ceil(n / PRESENCE_LEAVE_BATCH)` round trips — cleanup cost must not scale
   * one awaited Redis call per claim.
   */
  leaveMany(userId: string, subjects: readonly PresenceSubject[]): Promise<void>;
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
    async leaveMany(userId, subjects): Promise<void> {
      const keys = subjects.map((subject) => presenceKey(userId, subject.surface, subject.id));
      // A failing slice must not abandon the ones behind it: every batch is
      // attempted, and the first error is re-thrown so the caller still learns
      // the teardown was incomplete.
      let failure: unknown;
      for (let from = 0; from < keys.length; from += PRESENCE_LEAVE_BATCH) {
        try {
          await redis.del(...keys.slice(from, from + PRESENCE_LEAVE_BATCH));
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
    },
    async isPresent(userId, surface, id): Promise<boolean> {
      return (await redis.exists(presenceKey(userId, surface, id))) === 1;
    },
  };
}
