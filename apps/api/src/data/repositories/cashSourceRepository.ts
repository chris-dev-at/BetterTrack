import { and, asc, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm';

import type { Database } from '../db';
import { portfolioCashSources } from '../schema';
import type { CashSourceRow } from '../schema';

/**
 * Cash-source persistence (V3-P3, PROJECTPLAN.md §13.3). A source is a named
 * slice of a portfolio's cash ledger — the auto-provisioned **Main** plus
 * user-created siblings. Balances are never stored here: a source's balance is
 * the sum of its movements' signed amounts (`domain/cashLedger`), so this
 * repository only manages the source rows themselves.
 *
 * Reads are scoped to a `portfolio_id` the caller has already been authorised
 * for by the service (the portfolio ownership check precedes every call).
 */

/** The auto-provisioned default source of every portfolio (V3-P3). */
export const MAIN_CASH_SOURCE_NAME = 'Main';

export type CashSourceType = CashSourceRow['type'];

export interface CashSourceRecord {
  id: string;
  portfolioId: string;
  name: string;
  type: CashSourceType;
  isMain: boolean;
  archivedAt: Date | null;
  createdAt: Date;
}

function toRecord(row: CashSourceRow): CashSourceRecord {
  return {
    id: row.id,
    portfolioId: row.portfolioId,
    name: row.name,
    type: row.type,
    isMain: row.isMain,
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt,
  };
}

export function createCashSourceRepository(db: Database) {
  async function findMain(portfolioId: string): Promise<CashSourceRecord | null> {
    const rows = await db
      .select()
      .from(portfolioCashSources)
      .where(
        and(
          eq(portfolioCashSources.portfolioId, portfolioId),
          eq(portfolioCashSources.isMain, true),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * The portfolio's **Main** source, provisioned on first touch (V3-P3): the
   * 0019 migration created one for every pre-existing portfolio; portfolios
   * created later get theirs here the first time anything cash-shaped happens.
   * Idempotent under concurrency via `portfolio_cash_sources_main_unique`
   * (any-arbiter DO NOTHING, then re-select — mirrors portfolios'
   * getOrCreateMain).
   */
  async function getOrCreateMain(portfolioId: string): Promise<CashSourceRecord> {
    const existing = await findMain(portfolioId);
    if (existing) return existing;
    await db
      .insert(portfolioCashSources)
      .values({ portfolioId, name: MAIN_CASH_SOURCE_NAME, type: 'cash', isMain: true })
      .onConflictDoNothing();
    const created = await findMain(portfolioId);
    if (!created) throw new Error('Main cash source vanished after upsert');
    return created;
  }

  return {
    getOrCreateMain,

    /**
     * Every source of a portfolio — Main first, then by creation — excluding
     * archived rows unless asked (archived sources keep queryable history but
     * stay out of active listings, V3-P3).
     */
    async listForPortfolio(
      portfolioId: string,
      opts: { includeArchived?: boolean } = {},
    ): Promise<CashSourceRecord[]> {
      const where = opts.includeArchived
        ? eq(portfolioCashSources.portfolioId, portfolioId)
        : and(
            eq(portfolioCashSources.portfolioId, portfolioId),
            isNull(portfolioCashSources.archivedAt),
          );
      const rows = await db
        .select()
        .from(portfolioCashSources)
        .where(where)
        .orderBy(
          desc(portfolioCashSources.isMain),
          asc(portfolioCashSources.createdAt),
          asc(portfolioCashSources.id),
        );
      return rows.map(toRecord);
    },

    /** A single source scoped to its portfolio, else null (defense-in-depth). */
    async findByIdForPortfolio(portfolioId: string, id: string): Promise<CashSourceRecord | null> {
      const rows = await db
        .select()
        .from(portfolioCashSources)
        .where(
          and(eq(portfolioCashSources.id, id), eq(portfolioCashSources.portfolioId, portfolioId)),
        )
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    /**
     * Whether the portfolio already has a *different* source with this exact
     * name (the unique index spans archived rows), so create/rename can 409
     * cleanly before hitting the DB constraint. `excludeId` lets a rename keep
     * its own name.
     */
    async nameExists(portfolioId: string, name: string, excludeId?: string): Promise<boolean> {
      const rows = await db
        .select({ id: portfolioCashSources.id })
        .from(portfolioCashSources)
        .where(
          and(
            eq(portfolioCashSources.portfolioId, portfolioId),
            eq(portfolioCashSources.name, name),
            ...(excludeId ? [ne(portfolioCashSources.id, excludeId)] : []),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    /** Create a named (non-Main) source. */
    async createSource(
      portfolioId: string,
      input: { name: string; type: CashSourceType },
    ): Promise<CashSourceRecord> {
      const [row] = await db
        .insert(portfolioCashSources)
        .values({ portfolioId, name: input.name, type: input.type, isMain: false })
        .returning();
      if (!row) throw new Error('Cash source insert returned no row');
      return toRecord(row);
    },

    /** Rename / relabel a source scoped to its portfolio; null when not found. */
    async updateSource(
      portfolioId: string,
      id: string,
      patch: { name?: string; type?: CashSourceType },
    ): Promise<CashSourceRecord | null> {
      const set: Partial<typeof portfolioCashSources.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.type !== undefined) set.type = patch.type;
      // Nothing to change — return the current row (still portfolio-scoped),
      // mirroring portfolioRepository.updatePortfolio's no-op handling.
      if (Object.keys(set).length === 0) {
        const rows = await db
          .select()
          .from(portfolioCashSources)
          .where(
            and(eq(portfolioCashSources.id, id), eq(portfolioCashSources.portfolioId, portfolioId)),
          )
          .limit(1);
        const row = rows[0];
        return row ? toRecord(row) : null;
      }
      const rows = await db
        .update(portfolioCashSources)
        .set(set)
        .where(
          and(eq(portfolioCashSources.id, id), eq(portfolioCashSources.portfolioId, portfolioId)),
        )
        .returning();
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    /**
     * Soft-archive an *active* source (null when missing or already archived —
     * a concurrent archive racing us is reported as already-archived upstream).
     */
    async archiveSource(
      portfolioId: string,
      id: string,
      at: Date,
    ): Promise<CashSourceRecord | null> {
      const rows = await db
        .update(portfolioCashSources)
        .set({ archivedAt: at })
        .where(
          and(
            eq(portfolioCashSources.id, id),
            eq(portfolioCashSources.portfolioId, portfolioId),
            isNull(portfolioCashSources.archivedAt),
          ),
        )
        .returning();
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    /** Restore an archived source (null when missing or not archived). */
    async restoreSource(portfolioId: string, id: string): Promise<CashSourceRecord | null> {
      const rows = await db
        .update(portfolioCashSources)
        .set({ archivedAt: null })
        .where(
          and(
            eq(portfolioCashSources.id, id),
            eq(portfolioCashSources.portfolioId, portfolioId),
            isNotNull(portfolioCashSources.archivedAt),
          ),
        )
        .returning();
      const row = rows[0];
      return row ? toRecord(row) : null;
    },
  };
}

export type CashSourceRepository = ReturnType<typeof createCashSourceRepository>;
