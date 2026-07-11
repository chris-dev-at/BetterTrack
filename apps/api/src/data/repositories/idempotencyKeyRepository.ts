import { and, eq, lt } from 'drizzle-orm';

import type { Database } from '../db';
import { idempotencyKeys } from '../schema';

/**
 * Idempotency-key persistence (PROJECTPLAN.md §13.4 V4-P2a, #417) — the durable
 * side of the reusable idempotency middleware. Every method is `user_id`-scoped,
 * so one user's key space can never touch another's.
 *
 * The correctness core is {@link IdempotencyKeyRepository.claim}: the unique
 * `(user_id, key)` index turns an `INSERT … ON CONFLICT DO NOTHING` into an
 * atomic first-writer-wins claim, so two concurrent requests with the same key
 * collapse to exactly one execution (the loser replays or waits). Retention is
 * lazy: each claim first purges the caller's rows older than the cutoff, so an
 * expired key is reusable without any background job.
 */

/** A stored record as read back for the fingerprint compare + replay. */
export interface IdempotencyRecord {
  id: string;
  method: string;
  path: string;
  requestHash: string;
  /** NULL while the first request is still in flight; set once its response settles. */
  statusCode: number | null;
  responseBody: string | null;
  contentType: string | null;
}

/** The identity + fingerprint of a claim attempt. */
export interface IdempotencyClaimInput {
  userId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
}

/** The response captured from the first request, memoized for byte-identical replay. */
export interface IdempotencyResponse {
  statusCode: number;
  responseBody: string;
  contentType: string | null;
}

/**
 * Outcome of a {@link IdempotencyKeyRepository.claim}:
 *  - `won: true` — we inserted the row and own execution (`id` to complete/release);
 *  - `won: false, record` — a row already held `(user, key)`; the record may be
 *    in flight (`statusCode === null`) or completed;
 *  - `won: false, record: null` — the holding row vanished (purged/released)
 *    between our conflict and the read, so the caller should re-claim.
 */
export type IdempotencyClaimResult =
  | { won: true; id: string }
  | { won: false; record: IdempotencyRecord | null };

function toRecord(row: typeof idempotencyKeys.$inferSelect): IdempotencyRecord {
  return {
    id: row.id,
    method: row.method,
    path: row.path,
    requestHash: row.requestHash,
    statusCode: row.statusCode,
    responseBody: row.responseBody,
    contentType: row.contentType,
  };
}

export function createIdempotencyKeyRepository(db: Database) {
  return {
    /**
     * Atomically claim `(userId, key)`. Purges this user's rows older than
     * `cutoff` first (lazy retention purge — an expired key becomes reusable),
     * then `INSERT … ON CONFLICT (user_id, key) DO NOTHING`. A returned row means
     * we won and own execution; otherwise the existing record is read back so the
     * caller can compare its fingerprint and replay or wait.
     */
    async claim(input: IdempotencyClaimInput, cutoff: Date): Promise<IdempotencyClaimResult> {
      // Lazy purge (write-time, no job): drop this user's expired rows so their
      // keys are reusable. Scoped to the user to bound the delete's cost.
      await db
        .delete(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.userId, input.userId), lt(idempotencyKeys.createdAt, cutoff)),
        );
      const [won] = await db
        .insert(idempotencyKeys)
        .values({
          userId: input.userId,
          key: input.key,
          method: input.method,
          path: input.path,
          requestHash: input.requestHash,
        })
        .onConflictDoNothing({ target: [idempotencyKeys.userId, idempotencyKeys.key] })
        .returning({ id: idempotencyKeys.id });
      if (won) return { won: true, id: won.id };
      const [row] = await db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, input.userId), eq(idempotencyKeys.key, input.key)))
        .limit(1);
      return { won: false, record: row ? toRecord(row) : null };
    },

    /** Read one record by `(userId, key)`, or null. */
    async find(userId: string, key: string): Promise<IdempotencyRecord | null> {
      const [row] = await db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)))
        .limit(1);
      return row ? toRecord(row) : null;
    },

    /** Memoize the first request's response on the claimed row, ready to replay. */
    async complete(id: string, response: IdempotencyResponse): Promise<void> {
      await db
        .update(idempotencyKeys)
        .set({
          statusCode: response.statusCode,
          responseBody: response.responseBody,
          contentType: response.contentType,
          completedAt: new Date(),
        })
        .where(eq(idempotencyKeys.id, id));
    },

    /**
     * Release a claimed row (delete it) so the key is immediately reusable — used
     * when the first request produced a non-2xx response, so a transient failure
     * never poisons the offline queue's key.
     */
    async release(id: string): Promise<void> {
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
    },
  };
}

export type IdempotencyKeyRepository = ReturnType<typeof createIdempotencyKeyRepository>;
