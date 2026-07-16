import { and, desc, eq, gte, isNotNull, lte } from 'drizzle-orm';

import type { Database } from '../db';
import { exportJobs, type ExportJobRow } from '../schema';

/**
 * Account data-export job persistence (§13.4 V4-P6a, #494). Owns the
 * `export_jobs` rows the request flow creates, the build job fills in, the
 * status/download surface reads, and the cleanup job prunes. Only the download
 * token HASH is stored here — the raw token never touches the DB (handed to the
 * requester once). All lookups are user-scoped or token-scoped so one user can
 * never read another's job.
 */
export interface ExportRepository {
  /** Insert a fresh `pending` job for the user and return it. */
  create(input: { userId: string; downloadTokenHash: string }): Promise<ExportJobRow>;
  /** The user's most recent job (any status), or null. */
  findLatestForUser(userId: string): Promise<ExportJobRow | null>;
  /** A job by id, scoped to its owner (foreign ids resolve to null). */
  findByIdForUser(userId: string, id: string): Promise<ExportJobRow | null>;
  /** A job by id, regardless of owner — for the build job (which trusts its jobId). */
  findById(id: string): Promise<ExportJobRow | null>;
  /**
   * A READY, unexpired job for the user matching the download-token hash. Any
   * mismatch — foreign token, expired, not yet ready — resolves to null so the
   * download fails closed.
   */
  findDownloadable(input: {
    userId: string;
    downloadTokenHash: string;
    now: Date;
  }): Promise<ExportJobRow | null>;
  /** Whether the user has any job created at/after `since` (the 1/day gate). */
  hasJobSince(userId: string, since: Date): Promise<boolean>;
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
    async create({ userId, downloadTokenHash }) {
      const [row] = await db.insert(exportJobs).values({ userId, downloadTokenHash }).returning();
      return row!;
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

    async findDownloadable({ userId, downloadTokenHash, now }) {
      const [row] = await db
        .select()
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.userId, userId),
            eq(exportJobs.downloadTokenHash, downloadTokenHash),
            eq(exportJobs.status, 'ready'),
          ),
        )
        .limit(1);
      if (!row) return null;
      // Expiry is enforced in code (not the WHERE) so an expired-but-present row
      // still reads as "gone" the same way a missing one does — never a distinct
      // signal to a probing caller.
      if (!row.expiresAt || row.expiresAt.getTime() <= now.getTime()) return null;
      return row;
    },

    async hasJobSince(userId, since) {
      const [row] = await db
        .select({ id: exportJobs.id })
        .from(exportJobs)
        .where(and(eq(exportJobs.userId, userId), gte(exportJobs.createdAt, since)))
        .limit(1);
      return Boolean(row);
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
