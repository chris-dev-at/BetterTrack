import { asc, eq, min, sql } from 'drizzle-orm';

import type { Database } from '../db';
import {
  portfolioCashMovements,
  portfolioDailySnapshots,
  portfolioSnapshotState,
  transactions,
} from '../schema';
import type { PortfolioDailySnapshotRow, PortfolioSnapshotStateRow } from '../schema';

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

function toStateRecord(row: PortfolioSnapshotStateRow): SnapshotStateRecord {
  return {
    portfolioId: row.portfolioId,
    computedThrough: row.computedThrough,
    dirtyFrom: row.dirtyFrom ?? null,
    updatedAt: row.updatedAt,
  };
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
        .select()
        .from(portfolioSnapshotState)
        .where(eq(portfolioSnapshotState.portfolioId, portfolioId))
        .limit(1);
      const row = rows[0];
      return row ? toStateRecord(row) : null;
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
     *  1. Freshness compare-and-set — if the state's `updated_at` moved since
     *     the computation read it (`seenUpdatedAt`), a concurrent invalidation
     *     landed mid-compute and these rows may be stale: nothing is written
     *     (`applied: false`) and the invalidator's own recompute takes over.
     *  2. Rows from `seenDirtyFrom` on are deleted (normally a no-op — the
     *     invalidation already deleted them synchronously).
     *  3. Rows insert with `ON CONFLICT DO NOTHING` — existing (clean, earlier)
     *     days are never rewritten — except rows on/after `healFrom` (the
     *     nightly roll's trailing self-heal window for provider close
     *     revisions), which overwrite.
     *  4. The state row records `computed_through` and clears `dirty_from`.
     */
    async saveComputation(input: {
      portfolioId: string;
      rows: readonly NewSnapshotRow[];
      computedThrough: string;
      /** The state's `updated_at` when the computation started; null = no row. */
      seenUpdatedAt: Date | null;
      /** The dirty marker the computation saw; its range is re-deleted. */
      seenDirtyFrom: string | null;
      /** Rows on/after this day overwrite instead of DO NOTHING (nightly heal). */
      healFrom?: string | null;
    }): Promise<{ applied: boolean }> {
      const { portfolioId, rows, computedThrough, seenUpdatedAt, seenDirtyFrom } = input;
      const healFrom = input.healFrom ?? null;

      return db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(portfolioSnapshotState)
          .where(eq(portfolioSnapshotState.portfolioId, portfolioId))
          .for('update');
        const currentUpdatedAt = current[0]?.updatedAt ?? null;
        // Compare-and-set: a state row that appeared, vanished or was bumped
        // since the computation read its inputs means an invalidation raced us.
        if ((currentUpdatedAt?.getTime() ?? null) !== (seenUpdatedAt?.getTime() ?? null)) {
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

        await tx
          .insert(portfolioSnapshotState)
          .values({ portfolioId, computedThrough, dirtyFrom: null })
          .onConflictDoUpdate({
            target: portfolioSnapshotState.portfolioId,
            set: {
              computedThrough: sql`excluded.computed_through`,
              dirtyFrom: sql`null`,
              updatedAt: sql`now()`,
            },
          });
        return { applied: true };
      });
    },

    /**
     * Every portfolio with any history (a transaction or a cash movement) —
     * the backfill/nightly-roll job's work list. Not user-scoped: the worker
     * operates over the whole system.
     */
    async listSnapshotTargets(): Promise<SnapshotTarget[]> {
      const [fromTxns, fromCash] = await Promise.all([
        db.selectDistinct({ id: transactions.portfolioId }).from(transactions),
        db.selectDistinct({ id: portfolioCashMovements.portfolioId }).from(portfolioCashMovements),
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
        .where(eq(transactions.assetId, assetId))
        .groupBy(transactions.portfolioId);
      return rows
        .filter((r) => r.firstExecutedAt !== null)
        .map((r) => ({
          portfolioId: r.portfolioId,
          firstTxnDay: r.firstExecutedAt!.toISOString().slice(0, 10),
        }));
    },
  };
}

export type PortfolioSnapshotRepository = ReturnType<typeof createPortfolioSnapshotRepository>;
