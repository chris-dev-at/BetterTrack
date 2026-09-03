import { and, asc, count, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';

import {
  PROBLEM_CONTEXT_MAX_BYTES,
  PROBLEM_CONTEXT_TRUNCATED_KEY,
  PROBLEM_CONTEXT_VALUE_MAX_BYTES,
  PROBLEM_MESSAGE_MAX_BYTES,
  PROBLEM_TITLE_MAX_BYTES,
  PROBLEM_TRUNCATION_MARKER,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import { problems, type NewProblemRow, type ProblemRow } from '../schema';

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Byte length of a string once encoded — what the `text`/`jsonb` column costs. */
export function utf8ByteLength(value: string): number {
  return utf8.encode(value).length;
}

/**
 * Cut a string to `maxBytes` UTF-8 bytes, marking the cut. Bytes, not chars:
 * the columns are Postgres `text`/`jsonb`, so a message of astral-plane
 * characters costs four times what its `.length` suggests.
 *
 * Scrub BEFORE calling this — cutting first would leave the tail half of an
 * email or a token in place with nothing left to match it. A multi-byte
 * character split by the cut decodes to U+FFFD, which is trimmed off the tail so
 * the stored value never ends in a replacement character.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = utf8.encode(value);
  if (bytes.length <= maxBytes) return value;
  const keep = Math.max(0, maxBytes - utf8ByteLength(PROBLEM_TRUNCATION_MARKER));
  const head = utf8Decoder.decode(bytes.slice(0, keep)).replace(/\uFFFD+$/u, '');
  return `${head}${PROBLEM_TRUNCATION_MARKER}`;
}

/** Depth past which a context subtree is replaced by the marker. */
const MAX_CONTEXT_DEPTH = 6;
/** Entries kept per object/array before the rest is dropped. */
const MAX_CONTEXT_ENTRIES = 40;
/** What a non-string scalar is charged against the total context budget. */
const SCALAR_BUDGET_COST = 8;
/**
 * Held back from the budget for the serialized tree's own punctuation and for
 * the trailing {@link PROBLEM_CONTEXT_TRUNCATED_KEY} flag, so the JSON that is
 * actually written stays inside {@link PROBLEM_CONTEXT_MAX_BYTES} rather than
 * one marker past it.
 */
const CONTEXT_BUDGET_RESERVE = 64;

interface BoundState {
  left: number;
  cut: boolean;
}

function boundValue(value: unknown, state: BoundState, depth: number): unknown {
  if (typeof value === 'string') {
    const bounded = truncateUtf8(value, Math.min(PROBLEM_CONTEXT_VALUE_MAX_BYTES, state.left));
    if (bounded !== value) state.cut = true;
    state.left -= utf8ByteLength(bounded);
    return bounded;
  }
  if (value === null || value === undefined) {
    state.left -= SCALAR_BUDGET_COST;
    return null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    state.left -= SCALAR_BUDGET_COST;
    return value;
  }
  if (depth >= MAX_CONTEXT_DEPTH) {
    state.cut = true;
    return PROBLEM_TRUNCATION_MARKER;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (state.left <= 0 || out.length >= MAX_CONTEXT_ENTRIES) {
        state.cut = true;
        break;
      }
      state.left -= 2; // the separator this element serializes with
      out.push(boundValue(item, state, depth + 1));
    }
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const [key, child] of Object.entries(value)) {
      if (state.left <= 0 || kept >= MAX_CONTEXT_ENTRIES) {
        state.cut = true;
        break;
      }
      // Charge the key AND the punctuation it serializes with, so the budget
      // bounds the SERIALIZED tree rather than only the leaves it carries.
      state.left -= utf8ByteLength(key) + 8;
      out[key] = boundValue(child, state, depth + 1);
      kept += 1;
    }
    return out;
  }
  // Functions/symbols do not survive `jsonb` anyway.
  state.cut = true;
  return null;
}

/**
 * Bound a captured context tree: every value cut to
 * {@link PROBLEM_CONTEXT_VALUE_MAX_BYTES}, the whole tree to
 * {@link PROBLEM_CONTEXT_MAX_BYTES} once serialized, with depth and
 * entry-count ceilings so a nested payload cannot smuggle the bytes back in.
 * Idempotent: re-running it on an already-bounded tree changes nothing, which
 * is what lets the service and the write boundary both apply it.
 */
export function boundProblemContext(context: unknown): unknown {
  if (context === null || context === undefined) return null;
  const state: BoundState = {
    left: PROBLEM_CONTEXT_MAX_BYTES - CONTEXT_BUDGET_RESERVE,
    cut: false,
  };
  const bounded = boundValue(context, state, 0);
  if (!state.cut) return bounded;
  if (bounded !== null && typeof bounded === 'object' && !Array.isArray(bounded)) {
    return { ...(bounded as Record<string, unknown>), [PROBLEM_CONTEXT_TRUNCATED_KEY]: true };
  }
  return bounded;
}

/** Bound the row's headline and body to their documented byte ceilings. */
export function boundProblemTitle(title: string): string {
  return truncateUtf8(title, PROBLEM_TITLE_MAX_BYTES);
}

export function boundProblemMessage(message: string): string {
  return truncateUtf8(message, PROBLEM_MESSAGE_MAX_BYTES);
}

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
      // Defence in depth: the service already bounds these, and this re-applies
      // the same idempotent cut at the WRITE boundary so no future caller (or a
      // capture path that skips the service) can hand the table an unbounded
      // value. Deliberately not a DB CHECK — a constraint violation would drop
      // the capture entirely, which is strictly worse than a truncated one.
      const title = boundProblemTitle(input.title);
      const message = boundProblemMessage(input.message);
      const context = boundProblemContext(input.context) as NewProblemRow['context'];
      const values: NewProblemRow = {
        fingerprint: input.fingerprint,
        kind: input.kind,
        title,
        message,
        context,
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
            title,
            message,
            context,
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
