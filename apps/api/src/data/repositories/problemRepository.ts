import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../db';
import { problems, type NewProblemRow, type ProblemRow } from '../schema';

/** Fields an upsert supplies for a freshly-observed occurrence. */
export interface UpsertProblemInput {
  fingerprint: string;
  kind: ProblemRow['kind'];
  title: string;
  message: string;
  context: unknown;
  /** Time of this occurrence (test seam). */
  seenAt: Date;
  /** How many occurrences this write folds in (≥ 1). */
  occurrences: number;
}

export interface ListProblemsFilter {
  kind?: ProblemRow['kind'];
  status?: ProblemRow['status'];
  limit: number;
}

export interface ProblemRepository {
  /**
   * Fold one (or more) occurrences of a problem into its row, keyed by
   * `fingerprint`. First sighting inserts; a repeat bumps the occurrence count
   * and `last_seen_at` without touching the resolve status — a resolved problem
   * stays resolved until an admin reopens it.
   */
  upsert(input: UpsertProblemInput): Promise<void>;
  list(filter: ListProblemsFilter): Promise<ProblemRow[]>;
  get(id: string): Promise<ProblemRow | null>;
  /** Set a problem's status; returns the updated row, or null if unknown. */
  setStatus(
    id: string,
    status: ProblemRow['status'],
    resolvedBy: string | null,
    at: Date,
  ): Promise<ProblemRow | null>;
  /** Count of problems in a given status (badge source). */
  countByStatus(status: ProblemRow['status']): Promise<number>;
}

export function createProblemRepository(db: Database): ProblemRepository {
  return {
    async upsert(input: UpsertProblemInput): Promise<void> {
      const values: NewProblemRow = {
        fingerprint: input.fingerprint,
        kind: input.kind,
        title: input.title,
        message: input.message,
        context: (input.context ?? null) as NewProblemRow['context'],
        occurrenceCount: input.occurrences,
        firstSeenAt: input.seenAt,
        lastSeenAt: input.seenAt,
      };
      await db
        .insert(problems)
        .values(values)
        .onConflictDoUpdate({
          target: problems.fingerprint,
          set: {
            occurrenceCount: sql`${problems.occurrenceCount} + ${input.occurrences}`,
            lastSeenAt: input.seenAt,
            // Refresh the human-facing fields to the latest sighting so a
            // problem's headline never goes stale after a code change.
            title: input.title,
            message: input.message,
            context: (input.context ?? null) as NewProblemRow['context'],
          },
        });
    },

    async list(filter: ListProblemsFilter): Promise<ProblemRow[]> {
      const conds: SQL[] = [];
      if (filter.kind) conds.push(eq(problems.kind, filter.kind));
      if (filter.status) conds.push(eq(problems.status, filter.status));
      return db
        .select()
        .from(problems)
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(problems.lastSeenAt))
        .limit(filter.limit);
    },

    async get(id: string): Promise<ProblemRow | null> {
      const [row] = await db.select().from(problems).where(eq(problems.id, id)).limit(1);
      return row ?? null;
    },

    async setStatus(
      id: string,
      status: ProblemRow['status'],
      resolvedBy: string | null,
      at: Date,
    ): Promise<ProblemRow | null> {
      const [row] = await db
        .update(problems)
        .set({
          status,
          resolvedAt: status === 'resolved' ? at : null,
          resolvedBy: status === 'resolved' ? resolvedBy : null,
        })
        .where(eq(problems.id, id))
        .returning();
      return row ?? null;
    },

    async countByStatus(status: ProblemRow['status']): Promise<number> {
      const [row] = await db
        .select({ value: count() })
        .from(problems)
        .where(eq(problems.status, status));
      return row?.value ?? 0;
    },
  };
}
