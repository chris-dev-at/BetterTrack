import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

import { sha256Base64Url } from '../crypto/tokens';

export interface SessionData {
  userId: string;
  createdAt: number;
  /** Last time the 30-day window was reset — on login (create) or PIN verify (renew). */
  renewedAt: number;
}

/** Device metadata for the session manager (V3-P11a). Stored beside the session,
 * NOT inside `SessionData`, so writing it never touches the fixed-window TTL. */
export interface SessionMeta {
  /** Raw User-Agent captured on first-seen; null until a request stamps it. */
  userAgent: string | null;
  /** Last request time (throttled — not written on every request). */
  lastSeenAt: number;
}

/** One entry in the caller's active-sessions list (V3-P11a). */
export interface SessionListEntry {
  /** Opaque public handle = SHA-256 of the session id (never the raw token). */
  id: string;
  /** Raw User-Agent (null when unknown); the label is derived by the caller. */
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
  /** True when this is the caller's own session. */
  current: boolean;
}

export interface SessionService {
  /** The fixed 30-day window length in seconds (config.cookie.maxAgeMs / 1000). */
  readonly ttlSeconds: number;
  create(userId: string): Promise<string>;
  get(sessionId: string): Promise<SessionData | null>;
  /** Reset the session's 30-day window (login / PIN verify). False if it's already gone. */
  renew(sessionId: string): Promise<boolean>;
  destroy(sessionId: string): Promise<void>;
  destroyAllForUser(userId: string): Promise<void>;
  /**
   * Stamp the session's last-seen time and capture its User-Agent on first-seen
   * (V3-P11a). Throttled — a write happens at most once per {@link
   * LAST_SEEN_THROTTLE_MS} (plus the one-time UA backfill), never per request.
   * Writes only the SEPARATE metadata key, so the fixed 30-day window (§6.1) is
   * never extended. A no-op for a session that no longer exists.
   */
  touchLastSeen(sessionId: string, userAgent?: string | null): Promise<void>;
  /**
   * List the user's live sessions with device metadata (V3-P11a). Prunes dead
   * ids it encounters (expired sessions drop out). `current` marks the session
   * whose raw id equals `currentSessionId`.
   */
  listForUser(userId: string, currentSessionId: string | null): Promise<SessionListEntry[]>;
  /**
   * Revoke ONE of the user's sessions by its public handle (V3-P11a). Routes
   * through {@link SessionService.destroy} — the single revocation mechanism.
   * Returns false when no live session of this user matches the handle.
   */
  revokeForUser(userId: string, publicId: string): Promise<boolean>;
  /**
   * Revoke every session of the user EXCEPT `keepSessionId` (V3-P11a). Returns
   * the number of sessions revoked. Same destroy mechanism as everything else.
   */
  revokeOthersForUser(userId: string, keepSessionId: string | null): Promise<number>;
}

const sessionKey = (sessionId: string) => `sess:${sessionId}`;
const userIndexKey = (userId: string) => `user_sessions:${userId}`;
const sessionMetaKey = (sessionId: string) => `sess_meta:${sessionId}`;

/** How stale last-seen must be before a request rewrites it (V3-P11a). */
export const LAST_SEEN_THROTTLE_MS = 60_000;

/** Public revocation handle for a session id — never expose the raw token. */
const publicHandle = (sessionId: string) => sha256Base64Url(sessionId);

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

  const service: SessionService = {
    ttlSeconds,
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
      // The single revocation primitive: drop the session key, its device
      // metadata, and the per-user index entry. Everything that "logs a session
      // out" (self-logout, revoke-one, revoke-others, kill-all) funnels here.
      await redis.del(sessionKey(sessionId), sessionMetaKey(sessionId));
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
        pipeline.del(sessionKey(sessionId), sessionMetaKey(sessionId));
      }
      pipeline.del(userIndexKey(userId));
      await pipeline.exec();
    },

    async touchLastSeen(sessionId, userAgent) {
      // Only stamp a live session — never resurrect metadata for a dead one.
      const rawSession = await redis.get(sessionKey(sessionId));
      if (!rawSession) return;

      const now = Date.now();
      let meta: SessionMeta | null = null;
      const rawMeta = await redis.get(sessionMetaKey(sessionId));
      if (rawMeta) {
        try {
          meta = JSON.parse(rawMeta) as SessionMeta;
        } catch {
          meta = null;
        }
      }

      const incomingUa = userAgent && userAgent.trim().length > 0 ? userAgent : null;
      const needsUaBackfill = incomingUa !== null && (meta === null || meta.userAgent === null);
      const stale = meta === null || now - meta.lastSeenAt >= LAST_SEEN_THROTTLE_MS;
      // Skip the write unless last-seen is stale or we're capturing the UA for
      // the first time — keeps this off the per-request hot path.
      if (!stale && !needsUaBackfill) return;

      const next: SessionMeta = {
        userAgent: incomingUa ?? meta?.userAgent ?? null,
        lastSeenAt: now,
      };
      // Rolling TTL on the metadata key only. It may briefly outlive the session
      // it describes, but `listForUser` intersects against live sessions and
      // prunes stragglers, and the fixed-window session key is never touched.
      await redis.set(sessionMetaKey(sessionId), JSON.stringify(next), 'EX', ttlSeconds);
    },

    async listForUser(userId, currentSessionId) {
      const sessionIds = await redis.smembers(userIndexKey(userId));
      const entries: SessionListEntry[] = [];
      for (const sessionId of sessionIds) {
        const rawSession = await redis.get(sessionKey(sessionId));
        if (!rawSession) {
          // Expired/destroyed: prune the index + any lingering metadata.
          await redis.srem(userIndexKey(userId), sessionId);
          await redis.del(sessionMetaKey(sessionId));
          continue;
        }
        let data: SessionData;
        try {
          data = JSON.parse(rawSession) as SessionData;
        } catch {
          await redis.del(sessionKey(sessionId), sessionMetaKey(sessionId));
          await redis.srem(userIndexKey(userId), sessionId);
          continue;
        }
        // Guard against a stray id belonging to another user (should never happen).
        if (data.userId !== userId) continue;

        let meta: SessionMeta | null = null;
        const rawMeta = await redis.get(sessionMetaKey(sessionId));
        if (rawMeta) {
          try {
            meta = JSON.parse(rawMeta) as SessionMeta;
          } catch {
            meta = null;
          }
        }

        entries.push({
          id: publicHandle(sessionId),
          userAgent: meta?.userAgent ?? null,
          createdAt: data.createdAt,
          lastSeenAt: meta?.lastSeenAt ?? data.createdAt,
          current: sessionId === currentSessionId,
        });
      }
      // Current session first, then most-recently-seen; stable for the UI.
      entries.sort((a, b) => {
        if (a.current !== b.current) return a.current ? -1 : 1;
        return b.lastSeenAt - a.lastSeenAt;
      });
      return entries;
    },

    async revokeForUser(userId, publicId) {
      const sessionIds = await redis.smembers(userIndexKey(userId));
      for (const sessionId of sessionIds) {
        if (publicHandle(sessionId) !== publicId) continue;
        // Confirm it's live and really this user's before destroying.
        const rawSession = await redis.get(sessionKey(sessionId));
        if (!rawSession) {
          await redis.srem(userIndexKey(userId), sessionId);
          await redis.del(sessionMetaKey(sessionId));
          return false;
        }
        try {
          const data = JSON.parse(rawSession) as SessionData;
          if (data.userId !== userId) return false;
        } catch {
          // Corrupt: treat as gone but clean it up.
          await service.destroy(sessionId);
          return false;
        }
        await service.destroy(sessionId);
        return true;
      }
      return false;
    },

    async revokeOthersForUser(userId, keepSessionId) {
      const sessionIds = await redis.smembers(userIndexKey(userId));
      let revoked = 0;
      for (const sessionId of sessionIds) {
        if (sessionId === keepSessionId) continue;
        await service.destroy(sessionId);
        revoked += 1;
      }
      return revoked;
    },
  };

  return service;
}
