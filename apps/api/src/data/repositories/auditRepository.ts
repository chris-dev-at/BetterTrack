import { and, asc, count, countDistinct, desc, eq, gte, inArray, like, lt, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { auditLog, users, type AuditLogRow } from '../schema';

export interface RecordAuditInput {
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  meta?: unknown;
}

/**
 * `meta.via` marking a row written by the shell-only break-glass script
 * (`scripts/adminTwoFactorBreakGlass.ts`). The single highest-privilege event in
 * the product, and the one fact that lets a NULL actor mean something specific.
 */
export const BREAK_GLASS_VIA = 'break_glass_script';

/**
 * The filter set `GET /admin/audit` composes (#1908 §1). Every field is
 * optional and they compose with `and(...)`; absent means "do not filter".
 */
export interface AuditListFilters {
  /** Exact action, or a trailing-dot domain prefix (`user.` ⇒ every `user.*`). */
  action?: string;
  /** A preset's expanded action vocabulary, applied as `IN (…)`. */
  actions?: readonly string[];
  actorId?: string;
  targetId?: string;
  targetType?: string;
  /** Half-open `[from, to)` on `created_at`. */
  from?: Date;
  to?: Date;
  /** `preset=break_glass`: only rows the shell script stamped. */
  breakGlassOnly?: boolean;
}

/** An audit row with its actor resolved by the page's own statement. */
export interface AuditEntryRow extends AuditLogRow {
  actorUsername: string | null;
  actorRole: 'user' | 'admin' | null;
}

export interface AuditPage {
  entries: AuditEntryRow[];
  nextCursor: string | null;
}

/** Aggregate counts over one bounded window (#1908 §5). Counts only. */
export interface AuditSignalCounts {
  loginFailuresByReason: { reason: string | null; count: number }[];
  actionCounts: Record<string, number>;
  distinctAdminActors: number;
  breakGlass: number;
}

/**
 * `LIKE` is only reached by the trailing-dot domain prefix, whose value the
 * contract already restricts to `[a-z0-9_.]`. This escape is the second lock:
 * if that charset is ever widened, a `%` in the filter still cannot become a
 * wildcard (§10 — never a pattern match on unescaped user input).
 */
const escapeLikePattern = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

/**
 * Dot-anchored, by construction rather than by hope.
 *
 * A value with no trailing dot is an EXACT match, which is what the
 * `(action, id DESC)` index serves. A trailing dot is a domain prefix, and the
 * dot is part of the pattern — so `user.` matches `user.disabled` and can never
 * match `users.something`, which a bare `LIKE 'user%'` would.
 *
 * Deliberately NOT expanded into an `IN (…)` over the current `AuditAction`
 * vocabulary, tempting though that is for the index: the audit log keeps rows
 * for 400 days and an action retired from the vocabulary in that time would
 * silently drop out of its own domain's filter. A filter over a security record
 * has to be complete before it is fast.
 */
function actionCondition(action: string) {
  return action.endsWith('.')
    ? like(auditLog.action, `${escapeLikePattern(action)}%`)
    : eq(auditLog.action, action);
}

/** `meta->>'via' = 'break_glass_script'`, as a bound parameter. */
const breakGlassCondition = () => sql`${auditLog.meta}->>'via' = ${BREAK_GLASS_VIA}`;

function filterConditions(filters: AuditListFilters | undefined) {
  if (!filters) return [];
  return [
    filters.action !== undefined ? actionCondition(filters.action) : undefined,
    filters.actions !== undefined
      ? filters.actions.length > 0
        ? inArray(auditLog.action, [...filters.actions])
        : // An empty preset vocabulary means "nothing matches", never "no filter".
          sql`false`
      : undefined,
    filters.actorId !== undefined ? eq(auditLog.actorId, filters.actorId) : undefined,
    filters.targetId !== undefined ? eq(auditLog.targetId, filters.targetId) : undefined,
    filters.targetType !== undefined ? eq(auditLog.targetType, filters.targetType) : undefined,
    filters.from !== undefined ? gte(auditLog.createdAt, filters.from) : undefined,
    // Half-open `[from, to)`: an entry written exactly at `to` belongs to the
    // next window, so two adjacent windows never double-count one row.
    filters.to !== undefined ? lt(auditLog.createdAt, filters.to) : undefined,
    filters.breakGlassOnly === true ? breakGlassCondition() : undefined,
  ].filter(Boolean);
}

export function createAuditRepository(db: Database) {
  /**
   * ONE statement per page, actor included.
   *
   * The actor is resolved by a `LEFT JOIN users` on the rows this page returns
   * — not by a second round trip and not by 50 lookups. LEFT, because an audit
   * row outlives the account that wrote it by design (`actor_id` is
   * `ON DELETE SET NULL`), so a missing account must leave the row in the result
   * with a null actor rather than dropping it from the security record.
   *
   * Username and role ONLY. The e-mail is never selected here: an operator
   * reading the log needs to know who acted, not how to reach them (§6.12).
   */
  async function listPage(params: {
    limit: number;
    cursor?: string;
    filters?: AuditListFilters;
  }): Promise<AuditPage> {
    const conditions = [
      ...filterConditions(params.filters),
      params.cursor ? lt(auditLog.id, params.cursor) : undefined,
    ].filter(Boolean);

    const rows = await db
      .select({
        id: auditLog.id,
        actorId: auditLog.actorId,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        ip: auditLog.ip,
        meta: auditLog.meta,
        createdAt: auditLog.createdAt,
        actorUsername: users.username,
        actorRole: users.role,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(params.limit + 1);

    const hasMore = rows.length > params.limit;
    const entries = hasMore ? rows.slice(0, params.limit) : rows;
    return { entries, nextCursor: hasMore ? (entries.at(-1)?.id ?? null) : null };
  }

  return {
    async record(input: RecordAuditInput): Promise<void> {
      await db.insert(auditLog).values({
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        ip: input.ip ?? null,
        meta: input.meta ?? null,
      });
    },

    /**
     * Newest-first, keyset paginated by UUIDv7 id (time-sortable), optionally
     * filtered. Keyset and NOT offset, and deliberately without a filter-scoped
     * total — see `auditQuerySchema` for why that stays true under filters.
     */
    list: listPage,

    /**
     * Entries whose target is a given id (e.g. one user's history), newest-first.
     *
     * A thin caller of {@link listPage} rather than a second query, so the
     * per-user Activity tab and the global log can never diverge in ordering,
     * paging or actor resolution. Additional filters compose with the target.
     */
    listForTarget(params: {
      targetId: string;
      limit: number;
      cursor?: string;
      filters?: AuditListFilters;
    }): Promise<AuditPage> {
      const { targetId, filters, ...rest } = params;
      // The account scope is the ROUTE's, and it is applied here rather than in
      // the controller (§10). A `targetId` in the query can only ever NARROW
      // this page: naming a different account composes to a condition nothing
      // satisfies, which is answered without a statement rather than by quietly
      // dropping the operator's filter — a silently ignored filter on a security
      // record reads as "this account has no such rows".
      if (filters?.targetId !== undefined && filters.targetId !== targetId) {
        return Promise.resolve({ entries: [], nextCursor: null });
      }
      return listPage({ ...rest, filters: { ...filters, targetId } });
    },

    /**
     * Aggregate authentication signals over a bounded window (#1908 §5).
     *
     * Four bounded statements over rows that already exist — no new capture, no
     * per-account profile, no identifier in the result. Each grouped read
     * carries a `LIMIT` so a vocabulary that grows cannot turn this into an
     * unbounded read.
     */
    async signals(params: {
      from: Date;
      to: Date;
      actions: readonly string[];
      groupLimit: number;
    }): Promise<AuditSignalCounts> {
      const window = [gte(auditLog.createdAt, params.from), lt(auditLog.createdAt, params.to)];

      const reasonColumn = sql<string | null>`${auditLog.meta}->>'reason'`;
      const [byReason, byAction, adminActors, breakGlass] = await Promise.all([
        db
          .select({ reason: reasonColumn, count: count() })
          .from(auditLog)
          .where(and(eq(auditLog.action, 'login.fail'), ...window))
          .groupBy(reasonColumn)
          .limit(params.groupLimit),
        params.actions.length > 0
          ? db
              .select({ action: auditLog.action, count: count() })
              .from(auditLog)
              .where(and(inArray(auditLog.action, [...params.actions]), ...window))
              .groupBy(auditLog.action)
              .limit(params.groupLimit)
          : Promise.resolve([] as { action: string; count: number }[]),
        db
          .select({ actors: countDistinct(auditLog.actorId) })
          .from(auditLog)
          .where(and(eq(auditLog.action, 'admin.login'), ...window)),
        db
          .select({ count: count() })
          .from(auditLog)
          .where(and(breakGlassCondition(), ...window)),
      ]);

      const actionCounts: Record<string, number> = {};
      for (const row of byAction) actionCounts[row.action] = row.count;

      return {
        loginFailuresByReason: byReason,
        actionCounts,
        distinctAdminActors: adminActors[0]?.actors ?? 0,
        breakGlass: breakGlass[0]?.count ?? 0,
      };
    },

    /**
     * Break-glass events across the WHOLE retention window — what the standing
     * banner reports, so the event is visible without anyone thinking to look.
     *
     * Counted through a bounded subquery rather than a bare `COUNT(*)`: the
     * banner only needs "how many, up to a cap", and an unbounded count over a
     * 400-day table is exactly the query this page is not allowed to run. The
     * `(action, id DESC)` index makes the capped scan a short one.
     */
    async breakGlassTotal(cap: number): Promise<{ count: number; capped: boolean }> {
      const bounded = db
        .select({ one: sql<number>`1` })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'admin.two_factor_reset'), breakGlassCondition()))
        .limit(cap + 1)
        .as('bounded');
      const [row] = await db.select({ count: count() }).from(bounded);
      const total = row?.count ?? 0;
      return { count: Math.min(total, cap), capped: total > cap };
    },

    /**
     * Delete at most `limit` oldest rows before `cutoff`. The scheduled
     * retention sweep repeats this bounded statement until it returns fewer
     * than `limit`, avoiding one unbounded full-table delete.
     */
    async deleteOlderThan(cutoff: Date, limit: number): Promise<number> {
      const candidates = db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(lt(auditLog.createdAt, cutoff))
        .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
        .limit(limit);
      const deleted = await db
        .delete(auditLog)
        .where(inArray(auditLog.id, candidates))
        .returning({ id: auditLog.id });
      return deleted.length;
    },
  };
}

export type AuditRepository = ReturnType<typeof createAuditRepository>;
