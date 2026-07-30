import { and, desc, eq, gt, isNotNull, lte } from 'drizzle-orm';

import type { Database } from '../db';
import { exportJobs, users, type ExportJobRow } from '../schema';

export type ExportJobReservation =
  | { kind: 'created'; job: ExportJobRow }
  | { kind: 'rate_limited'; latest: ExportJobRow };

/**
 * Account data-export job persistence (§13.4 V4-P6a, #494). Owns the
 * `export_jobs` rows the request flow creates, the build job fills in, the
 * status/download surface reads, and the cleanup job prunes. Only the download
 * token HASH is stored here — the raw token never touches the DB (handed to the
 * requester once). All lookups are user-scoped or token-scoped so one user can
 * never read another's job.
 */
export interface ExportRepository {
  /**
   * Atomically reserve the user's daily export slot and insert a fresh
   * `pending` job. The stable user row is locked so concurrent first-time
   * requests serialize even when there is no export row to lock yet.
   */
  reserveWithinRateLimit(input: {
    userId: string;
    downloadTokenHash: string;
    since: Date;
  }): Promise<ExportJobReservation>;
  /** The user's most recent job (any status), or null. */
  findLatestForUser(userId: string): Promise<ExportJobRow | null>;
  /** A job by id, scoped to its owner (foreign ids resolve to null). */
  findByIdForUser(userId: string, id: string): Promise<ExportJobRow | null>;
  /** A job by id, regardless of owner — for the build job (which trusts its jobId). */
  findById(id: string): Promise<ExportJobRow | null>;
  /**
   * Atomically consume a READY, unexpired job's matching download-token hash.
   * Any mismatch — foreign token, expired, replayed, not yet ready — resolves
   * to null so the download fails closed.
   */
  consumeDownloadable(input: {
    userId: string;
    downloadTokenHash: string;
    now: Date;
  }): Promise<ExportJobRow | null>;
  /** Mark a job ready with its on-disk file + download window. */
  markReady(input: {
    id: string;
    filePath: string;
    fileSize: number;
    expiresAt: Date;
    readyAt: Date;
  }): Promise<void>;
  /** Mark a job failed with a coarse reason (never a stack/secret). */
  markFailed(id: string, error: string): Promise<void>;
  /** Ready jobs whose download window has closed (for the cleanup sweep). */
  findExpired(now: Date): Promise<ExportJobRow[]>;
  /** Delete a job row by id. */
  deleteById(id: string): Promise<void>;
}

export function createExportRepository(db: Database): ExportRepository {
  return {
    async reserveWithinRateLimit({ userId, downloadTokenHash, since }) {
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!owner) throw new Error('Cannot create a data export for a missing user');

        const [latest] = await tx
          .select()
          .from(exportJobs)
          .where(eq(exportJobs.userId, userId))
          .orderBy(desc(exportJobs.createdAt))
          .limit(1);
        if (latest && latest.status !== 'failed' && latest.createdAt.getTime() > since.getTime()) {
          return { kind: 'rate_limited' as const, latest };
        }

        const [job] = await tx.insert(exportJobs).values({ userId, downloadTokenHash }).returning();
        if (!job) throw new Error('Failed to create a data export job');
        return { kind: 'created' as const, job };
      });
    },

    async findLatestForUser(userId) {
      const [row] = await db
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.userId, userId))
        .orderBy(desc(exportJobs.createdAt))
        .limit(1);
      return row ?? null;
    },

    async findByIdForUser(userId, id) {
      const [row] = await db
        .select()
        .from(exportJobs)
        .where(and(eq(exportJobs.id, id), eq(exportJobs.userId, userId)))
        .limit(1);
      return row ?? null;
    },

    async findById(id) {
      const [row] = await db.select().from(exportJobs).where(eq(exportJobs.id, id)).limit(1);
      return row ?? null;
    },

    async consumeDownloadable({ userId, downloadTokenHash, now }) {
      const [row] = await db
        .update(exportJobs)
        .set({ downloadTokenHash: null })
        .where(
          and(
            eq(exportJobs.userId, userId),
            eq(exportJobs.downloadTokenHash, downloadTokenHash),
            eq(exportJobs.status, 'ready'),
            gt(exportJobs.expiresAt, now),
          ),
        )
        .returning();
      return row ?? null;
    },

    async markReady({ id, filePath, fileSize, expiresAt, readyAt }) {
      await db
        .update(exportJobs)
        .set({ status: 'ready', filePath, fileSize, expiresAt, readyAt, error: null })
        .where(eq(exportJobs.id, id));
    },

    async markFailed(id, error) {
      await db.update(exportJobs).set({ status: 'failed', error }).where(eq(exportJobs.id, id));
    },

    async findExpired(now) {
      return db
        .select()
        .from(exportJobs)
        .where(and(isNotNull(exportJobs.expiresAt), lte(exportJobs.expiresAt, now)));
    },

    async deleteById(id) {
      await db.delete(exportJobs).where(eq(exportJobs.id, id));
    },
  };
}
