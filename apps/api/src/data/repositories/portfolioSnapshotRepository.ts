import { and, asc, eq, exists, inArray, isNull, min, notExists, sql } from 'drizzle-orm';

import type { Database } from '../db';
import {
  portfolioCashMovements,
  portfolioDailySnapshots,
  portfolioSnapshotState,
  portfolios,
  transactions,
} from '../schema';
import type { PortfolioDailySnapshotRow } from '../schema';

/**
 * Persistence for the V5-P1 per-portfolio daily snapshots (issue #553,
 * §16 2026-07-17): the precomputed series rows the graph/analytics read path
 * serves, plus the per-portfolio state row (recompute watermark + dirty-from
 * invalidation marker) that decides whether those rows may be trusted.
 *
 * Write discipline: rows strictly BEFORE an invalidation's `fromDay` are never
 * touched (the "earlier days untouched" acceptance rule); refills insert with
 * `ON CONFLICT DO NOTHING`, and only the nightly roll's trailing heal window
 * overwrites existing rows (provider close revisions). {@link saveComputation}
 * runs under a state-row lock with a compare-and-set so a computation raced by
 * a concurrent invalidation can never clear the dirty marker it didn't see.
 */

/** One snapshot row with money columns parsed to `number`. */
export interface SnapshotRowRecord {
  portfolioId: string;
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Net worth (holdings + EOD cash), EUR. */
  valueEur: number;
  /** Open cost basis at that day's FX, EUR. */
  costBasisEur: number;
  /** Holdings value − cost basis, EUR. */
  plEur: number;
  /** Net external TWR flow that day, EUR (0 = none). */
  flowEur: number;
  /** Per-source EOD cash split. */
  cashBySource: Record<string, number>;
  /** Per-asset EUR value that day. */
  assetValues: Record<string, number>;
  computedAt: Date;
}

/** A row to persist (portfolio id travels separately). */
export interface NewSnapshotRow {
  date: string;
  valueEur: number;
  costBasisEur: number;
  plEur: number;
  flowEur: number;
  cashBySource: Record<string, number>;
  assetValues: Record<string, number>;
}

export interface SnapshotStateRecord {
  portfolioId: string;
  /** Last day the writer fully computed (ISO `YYYY-MM-DD`). */
  computedThrough: string;
  /** Earliest invalidated day, or null when clean. */
  dirtyFrom: string | null;
  updatedAt: Date;
  /**
   * `updated_at` at the precision the column stores — the compare-and-set
   * fencing token (see {@link stateVersionSql}). Hand it back to
   * {@link createPortfolioSnapshotRepository.saveComputation} as `seenVersion`;
   * never parse it, only compare it.
   */
  version: string;
}

/** A portfolio the backfill job must cover, i.e. one with any history at all. */
export interface SnapshotTarget {
  portfolioId: string;
}

/** A portfolio referencing an asset + the first day that reference affects. */
export interface AssetReference {
  portfolioId: string;
  /** ISO day of the portfolio's earliest transaction on the asset. */
  firstTxnDay: string;
}

/** A portfolio to rebuild + the first day its series exists on. */
export interface SnapshotRepairTarget {
  portfolioId: string;
  /** ISO day of the portfolio's earliest transaction OR cash movement. */
  firstEventDay: string;
}

function toRowRecord(row: PortfolioDailySnapshotRow): SnapshotRowRecord {
  return {
    portfolioId: row.portfolioId,
    date: row.date,
    valueEur: Number(row.valueEur),
    costBasisEur: Number(row.costBasisEur),
    plEur: Number(row.plEur),
    flowEur: Number(row.flowEur),
    cashBySource: (row.cashBySource ?? {}) as Record<string, number>,
    assetValues: (row.assetValues ?? {}) as Record<string, number>,
    computedAt: row.computedAt,
  };
}

/**
 * The state row's `updated_at` rendered at the precision the column actually
 * stores (microseconds) — the compare-and-set fencing token.
 *
 * `timestamptz` keeps microseconds; a JS `Date` keeps milliseconds. Reading the
 * column into a `Date` and comparing `getTime()` therefore reads two DISTINCT
 * state writes landing inside one millisecond as the same write, and a
 * computation that raced the second of them would be accepted and would clear
 * its dirty marker. Both sides of the comparison are this same text, so nothing
 * is rounded on the way in or out.
 */
function stateVersionSql() {
  return sql<string>`to_char(${portfolioSnapshotState.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** The state-row columns every read of {@link SnapshotStateRecord} selects. */
const stateSelection = {
  portfolioId: portfolioSnapshotState.portfolioId,
  computedThrough: portfolioSnapshotState.computedThrough,
  dirtyFrom: portfolioSnapshotState.dirtyFrom,
  updatedAt: portfolioSnapshotState.updatedAt,
  version: stateVersionSql(),
};

/**
 * Thrown INSIDE {@link createPortfolioSnapshotRepository.saveComputation}'s
 * transaction when the guarded state write matches no row — an invalidation
 * created or moved the state row after the compare-and-set read it. Rolling the
 * whole transaction back is the point: the rows this computation had already
 * inserted are as unseen as the marker it did not see.
 */
class SnapshotComputationRaced extends Error {
  constructor() {
    super('snapshot computation raced an invalidation');
    this.name = 'SnapshotComputationRaced';
  }
}

function toInsertValues(portfolioId: string, row: NewSnapshotRow) {
  return {
    portfolioId,
    date: row.date,
    // Full-precision doubles round-trip exactly through String() → numeric →
    // Number() (§5.4) — the golden byte-equality of the read path depends on it.
    valueEur: String(row.valueEur),
    costBasisEur: String(row.costBasisEur),
    plEur: String(row.plEur),
    flowEur: String(row.flowEur),
    cashBySource: row.cashBySource,
    assetValues: row.assetValues,
  };
}

/** Largest batch of rows per insert statement (well under the param cap). */
const INSERT_CHUNK = 200;

export function createPortfolioSnapshotRepository(db: Database) {
  return {
    /** Every snapshot row of a portfolio, ascending by day. */
    async listForPortfolio(portfolioId: string): Promise<SnapshotRowRecord[]> {
      const rows = await db
        .select()
        .from(portfolioDailySnapshots)
        .where(eq(portfolioDailySnapshots.portfolioId, portfolioId))
        .orderBy(asc(portfolioDailySnapshots.date));
      return rows.map(toRowRecord);
    },

    async getState(portfolioId: string): Promise<SnapshotStateRecord | null> {
      const rows = await db
        .select(stateSelection)
        .from(portfolioSnapshotState)
        .where(eq(portfolioSnapshotState.portfolioId, portfolioId))
        .limit(1);
      const row = rows[0];
      return row ? { ...row, dirtyFrom: row.dirtyFrom ?? null } : null;
    },

    /**
     * Record an invalidation: `dirty_from` becomes the EARLIEST of the existing
     * marker and `fromDay` (two writes in flight keep the wider range), and
     * `updated_at` bumps so an in-flight computation's compare-and-set fails.
     * Inserting the state row on first touch keeps the marker durable even for
     * a portfolio that has never been snapshotted.
     */
    async markDirty(portfolioId: string, fromDay: string): Promise<void> {
      await db
        .insert(portfolioSnapshotState)
        .values({ portfolioId, computedThrough: fromDay, dirtyFrom: fromDay })
        .onConflictDoUpdate({
          target: portfolioSnapshotState.portfolioId,
          set: {
            dirtyFrom: sql`least(coalesce(${portfolioSnapshotState.dirtyFrom}, excluded.dirty_from), excluded.dirty_from)`,
            updatedAt: sql`now()`,
          },
        });
    },

    /** Delete the snapshot rows from `fromDay` on; earlier rows stay untouched. */
    async deleteFrom(portfolioId: string, fromDay: string): Promise<void> {
      await db
        .delete(portfolioDailySnapshots)
        .where(
          sql`${portfolioDailySnapshots.portfolioId} = ${portfolioId} and ${portfolioDailySnapshots.date} >= ${fromDay}`,
        );
    },

    /** Drop everything for a portfolio whose history vanished entirely. */
    async clear(portfolioId: string): Promise<void> {
      await db
        .delete(portfolioDailySnapshots)
        .where(eq(portfolioDailySnapshots.portfolioId, portfolioId));
      await db
        .delete(portfolioSnapshotState)
        .where(eq(portfolioSnapshotState.portfolioId, portfolioId));
    },

    /**
     * Persist one computation atomically. Under the state row's lock:
     *
     *  1. Freshness compare-and-set — if the state's version moved since the
     *     computation read it (`seenVersion`), a concurrent invalidation landed
     *     mid-compute and these rows may be stale: nothing is written
     *     (`applied: false`) and the invalidator's own recompute takes over.
     *  2. Rows from `seenDirtyFrom` on are deleted (normally a no-op — the
     *     invalidation already deleted them synchronously).
     *  3. Rows insert with `ON CONFLICT DO NOTHING` — existing (clean, earlier)
     *     days are never rewritten — except rows on/after `healFrom` (the
     *     nightly roll's trailing self-heal window for provider close
     *     revisions), which overwrite.
     *  4. The state row records `computed_through` and clears `dirty_from` —
     *     but only if it STILL matches `seenVersion` at that moment.
     *
     * Step 4's re-check is what makes step 1 safe for a portfolio that has no
     * state row yet: `SELECT … FOR UPDATE` over zero rows locks nothing, so a
     * {@link createPortfolioSnapshotRepository.markDirty} (a plain INSERT for an
     * absent row, blocking on nothing) can land between the two and would then
     * be cleared by an upsert that never saw it. Guarding the upsert closes that
     * window: an unmatched guard rolls the whole computation back.
     */
    async saveComputation(input: {
      portfolioId: string;
      rows: readonly NewSnapshotRow[];
      computedThrough: string;
      /** The state's {@link SnapshotStateRecord.version} when the computation started; null = no row. */
      seenVersion: string | null;
      /** The dirty marker the computation saw; its range is re-deleted. */
      seenDirtyFrom: string | null;
      /** Rows on/after this day overwrite instead of DO NOTHING (nightly heal). */
      healFrom?: string | null;
    }): Promise<{ applied: boolean }> {
      const { portfolioId, rows, computedThrough, seenVersion, seenDirtyFrom } = input;
      const healFrom = input.healFrom ?? null;

      try {
        return await db.transaction(async (tx) => {
          const current = await tx
            .select({ version: stateVersionSql() })
            .from(portfolioSnapshotState)
            .where(eq(portfolioSnapshotState.portfolioId, portfolioId))
            .for('update');
          const currentVersion = current[0]?.version ?? null;
          // Compare-and-set: a state row that appeared, vanished or was bumped
          // since the computation read its inputs means an invalidation raced us.
          if (currentVersion !== seenVersion) {
            return { applied: false };
          }

          if (seenDirtyFrom !== null) {
            await tx
              .delete(portfolioDailySnapshots)
              .where(
                sql`${portfolioDailySnapshots.portfolioId} = ${portfolioId} and ${portfolioDailySnapshots.date} >= ${seenDirtyFrom}`,
              );
          }

          const fill = rows.filter((r) => healFrom === null || r.date < healFrom);
          const heal = healFrom === null ? [] : rows.filter((r) => r.date >= healFrom);
          for (let i = 0; i < fill.length; i += INSERT_CHUNK) {
            await tx
              .insert(portfolioDailySnapshots)
              .values(fill.slice(i, i + INSERT_CHUNK).map((r) => toInsertValues(portfolioId, r)))
              .onConflictDoNothing();
          }
          for (let i = 0; i < heal.length; i += INSERT_CHUNK) {
            await tx
              .insert(portfolioDailySnapshots)
              .values(heal.slice(i, i + INSERT_CHUNK).map((r) => toInsertValues(portfolioId, r)))
              .onConflictDoUpdate({
                target: [portfolioDailySnapshots.portfolioId, portfolioDailySnapshots.date],
                set: {
                  valueEur: sql`excluded.value_eur`,
                  costBasisEur: sql`excluded.cost_basis_eur`,
                  plEur: sql`excluded.pl_eur`,
                  flowEur: sql`excluded.flow_eur`,
                  cashBySource: sql`excluded.cash_by_source`,
                  assetValues: sql`excluded.asset_values`,
                  computedAt: sql`now()`,
                },
              });
          }

          const saved = await tx
            .insert(portfolioSnapshotState)
            .values({ portfolioId, computedThrough, dirtyFrom: null })
            .onConflictDoUpdate({
              target: portfolioSnapshotState.portfolioId,
              set: {
                computedThrough: sql`excluded.computed_through`,
                dirtyFrom: sql`null`,
                updatedAt: sql`now()`,
              },
              // Re-check under the write itself. Having seen NO row, ANY row
              // here was created after the compare-and-set — by an invalidation
              // this computation cannot have accounted for — so the conflict
              // itself is the rejection.
              setWhere:
                seenVersion === null ? sql`false` : sql`${stateVersionSql()} = ${seenVersion}`,
            })
            .returning({ portfolioId: portfolioSnapshotState.portfolioId });
          if (saved.length === 0) throw new SnapshotComputationRaced();
          return { applied: true };
        });
      } catch (err) {
        if (err instanceof SnapshotComputationRaced) return { applied: false };
        throw err;
      }
    },

    /**
     * Every non-vaulted portfolio with any history (a transaction or a cash
     * movement) — the backfill/nightly-roll job's work list. Not user-scoped:
     * the worker operates over the whole system. The explicit vault predicate
     * makes the job skip a locked stub even if a stale/impossible cleartext row
     * survives; this is policy, not an empty-input assumption (E2 §11).
     */
    async listSnapshotTargets(): Promise<SnapshotTarget[]> {
      const [fromTxns, fromCash] = await Promise.all([
        db
          .selectDistinct({ id: transactions.portfolioId })
          .from(transactions)
          .innerJoin(portfolios, eq(portfolios.id, transactions.portfolioId))
          .where(isNull(portfolios.vaultId)),
        db
          .selectDistinct({ id: portfolioCashMovements.portfolioId })
          .from(portfolioCashMovements)
          .innerJoin(portfolios, eq(portfolios.id, portfolioCashMovements.portfolioId))
          .where(isNull(portfolios.vaultId)),
      ]);
      const ids = [...new Set([...fromTxns, ...fromCash].map((r) => r.id))].sort();
      return ids.map((portfolioId) => ({ portfolioId }));
    },

    /**
     * Every portfolio holding transactions on `assetId`, with its earliest
     * transaction day — a custom-asset value-point/smoothing change reshapes
     * each of those portfolios' series from that day at the earliest (§16
     * 2026-07-17 rule 7).
     */
    async portfoliosReferencingAsset(assetId: string): Promise<AssetReference[]> {
      const rows = await db
        .select({
          portfolioId: transactions.portfolioId,
          firstExecutedAt: min(transactions.executedAt),
        })
        .from(transactions)
        .innerJoin(portfolios, eq(portfolios.id, transactions.portfolioId))
        .where(and(eq(transactions.assetId, assetId), isNull(portfolios.vaultId)))
        .groupBy(transactions.portfolioId);
      return rows
        .filter((r) => r.firstExecutedAt !== null)
        .map((r) => ({
          portfolioId: r.portfolioId,
          firstTxnDay: r.firstExecutedAt!.toISOString().slice(0, 10),
        }));
    },

    /**
     * Portfolios whose stored series was corrupted by the taxed-sell flow bug
     * (#125 follow-up), each with the first day of its history.
     *
     * The signature is a SELL that has a linked tax settlement but NO linked
     * `sell_proceeds` leg: its proceeds left the portfolio, yet the pre-fix
     * exclusion set treated *any* linked cash movement as "settled in cash" and
     * dropped the sell's external outflow. The holdings left the value curve
     * with no flow explaining the drop. A sell that DID park its proceeds in
     * cash is unaffected — the `sell_proceeds` leg is a genuine internal
     * settlement — and so is an untaxed sell, which never had a linked movement
     * to be confused by.
     *
     * Whole-system, like {@link listSnapshotTargets}: repairing derived rows is
     * an operator action, so there is no user scope to apply.
     */
    async listTaxedSellFlowRepairTargets(): Promise<SnapshotRepairTarget[]> {
      const affected = await db
        .selectDistinct({ portfolioId: transactions.portfolioId })
        .from(transactions)
        .innerJoin(portfolios, eq(portfolios.id, transactions.portfolioId))
        .where(
          and(
            isNull(portfolios.vaultId),
            eq(transactions.side, 'sell'),
            exists(
              db
                .select({ one: sql`1` })
                .from(portfolioCashMovements)
                .where(
                  and(
                    eq(portfolioCashMovements.transactionId, transactions.id),
                    inArray(portfolioCashMovements.kind, ['tax_withholding', 'tax_refund']),
                  ),
                ),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(portfolioCashMovements)
                .where(
                  and(
                    eq(portfolioCashMovements.transactionId, transactions.id),
                    eq(portfolioCashMovements.kind, 'sell_proceeds'),
                  ),
                ),
            ),
          ),
        );
      const ids = [...new Set(affected.map((r) => r.portfolioId))].sort();
      if (ids.length === 0) return [];

      // Inception = the earliest event of ANY kind, because the rebuild must
      // start before the first snapshot row: a cash deposit can precede the
      // first trade, and the chain is only correct if rebuilt from its head.
      const [firstTxn, firstCash] = await Promise.all([
        db
          .select({ portfolioId: transactions.portfolioId, first: min(transactions.executedAt) })
          .from(transactions)
          .where(inArray(transactions.portfolioId, ids))
          .groupBy(transactions.portfolioId),
        db
          .select({
            portfolioId: portfolioCashMovements.portfolioId,
            first: min(portfolioCashMovements.executedAt),
          })
          .from(portfolioCashMovements)
          .where(inArray(portfolioCashMovements.portfolioId, ids))
          .groupBy(portfolioCashMovements.portfolioId),
      ]);

      const earliest = new Map<string, string>();
      for (const row of [...firstTxn, ...firstCash]) {
        if (row.first === null) continue;
        const day = row.first.toISOString().slice(0, 10);
        const seen = earliest.get(row.portfolioId);
        if (seen === undefined || day < seen) earliest.set(row.portfolioId, day);
      }

      return ids
        .filter((id) => earliest.has(id))
        .map((portfolioId) => ({ portfolioId, firstEventDay: earliest.get(portfolioId)! }));
    },
  };
}

export type PortfolioSnapshotRepository = ReturnType<typeof createPortfolioSnapshotRepository>;
