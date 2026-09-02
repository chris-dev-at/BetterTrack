import { and, asc, count, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../db';
import { problems, type NewProblemRow, type ProblemRow } from '../schema';

/** The one place list and count agree on what a filter means. */
function whereFilter(filter: ProblemFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter.kind) conds.push(eq(problems.kind, filter.kind));
  if (filter.status) conds.push(eq(problems.status, filter.status));
  return conds.length > 0 ? and(...conds) : undefined;
}

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

/** Filter shared by {@link ProblemRepository.list} and its count. */
export interface ProblemFilter {
  kind?: ProblemRow['kind'];
  status?: ProblemRow['status'];
}

export interface ListProblemsFilter extends ProblemFilter {
  limit: number;
  /** Rows to skip in `last_seen_at desc` order — the paging cursor. */
  offset?: number;
}

export interface ProblemRepository {
  /**
   * Fold one (or more) occurrences of a problem into its row, keyed by
   * `fingerprint`. First sighting inserts; a repeat bumps the occurrence count
   * and `last_seen_at`.
   *
   * A repeat that lands AFTER the row was resolved reopens it — a problem an
   * admin cleared and that then happened again is a regression, and leaving it
   * `resolved` hides it from the default view and the open badge no matter how
   * often it recurs. `resolved_at` is deliberately left standing: it is what
   * makes the reopen visible as a regression rather than as a fresh problem,
   * with no column of its own (§13.5 V5-P2 — migration-free by mandate).
   * A manual reopen clears it, so the marker never outlives its resolution.
   */
  upsert(input: UpsertProblemInput): Promise<void>;
  list(filter: ListProblemsFilter): Promise<ProblemRow[]>;
  /** How many rows match `filter`, ignoring limit/offset — the paging total. */
  countMatching(filter: ProblemFilter): Promise<number>;
  /**
   * Delete at most `limit` problems last seen before `cutoff` (the retention
   * sweep's bounded drain). The rate cap bounds the write RATE; only this
   * bounds the table.
   */
  deleteOlderThan(cutoff: Date, limit: number): Promise<number>;
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
            // The regression reopen. Unqualified in an ON CONFLICT DO UPDATE
            // SET, `problems.*` is the EXISTING row, so this compares the stored
            // resolution against the incoming sighting: recurred after it was
            // cleared ⇒ open again, everything else ⇒ status untouched.
            status: sql`case when ${problems.resolvedAt} is not null and ${problems.resolvedAt} < ${input.seenAt} then 'open'::problem_status else ${problems.status} end`,
            // Refresh the human-facing fields to the latest sighting so a
            // problem's headline never goes stale after a code change.
            title: input.title,
            message: input.message,
            context: (input.context ?? null) as NewProblemRow['context'],
          },
        });
    },

    async list(filter: ListProblemsFilter): Promise<ProblemRow[]> {
      return db
        .select()
        .from(problems)
        .where(whereFilter(filter))
        .orderBy(desc(problems.lastSeenAt), desc(problems.id))
        .limit(filter.limit)
        .offset(filter.offset ?? 0);
    },

    async countMatching(filter: ProblemFilter): Promise<number> {
      const [row] = await db.select({ value: count() }).from(problems).where(whereFilter(filter));
      return row?.value ?? 0;
    },

    async deleteOlderThan(cutoff: Date, limit: number): Promise<number> {
      const candidates = db
        .select({ id: problems.id })
        .from(problems)
        .where(lt(problems.lastSeenAt, cutoff))
        .orderBy(asc(problems.lastSeenAt), asc(problems.id))
        .limit(limit);
      const deleted = await db
        .delete(problems)
        .where(inArray(problems.id, candidates))
        .returning({ id: problems.id });
      return deleted.length;
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
