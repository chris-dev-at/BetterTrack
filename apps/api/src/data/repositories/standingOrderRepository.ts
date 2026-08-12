import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type {
  StandingOrderCadence,
  StandingOrderKind,
  StandingOrderStatus,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import { newId } from '../ids';
import { lockPortfolioMutationInTransaction } from './cashMovementRepository';
import { assets, portfolios, standingOrderRuns, standingOrders } from '../schema';

/**
 * Standing-order persistence (issue #593). Owns two tables — `standing_orders`
 * (the definitions) and `standing_order_runs` (the per-period exactly-once
 * ledger). Every read is scoped to the caller by `user_id`, so an order id that
 * belongs to another user is indistinguishable from a missing one (no IDOR,
 * §10). `amount` is parsed to `number` here (the DB stores `numeric`); calendar
 * columns (`start_date`, `end_date`, `last_period_key`, run `period_key`) are
 * plain ISO `YYYY-MM-DD` strings.
 *
 * The engine's idempotency primitive is {@link StandingOrderRepository.claimPeriod}:
 * a single-statement `INSERT … ON CONFLICT DO NOTHING` against the
 * UNIQUE(order, period) index, so a double-run of the daily job — or a
 * concurrent worker — claims a given period at most once.
 */

/** A standing order with its money column parsed to `number`. */
export interface StandingOrderRecord {
  id: string;
  userId: string;
  portfolioId: string;
  kind: StandingOrderKind;
  assetId: string | null;
  amount: number;
  currency: string;
  label: string | null;
  cadence: StandingOrderCadence;
  anchorDay: number | null;
  startDate: string;
  endDate: string | null;
  status: StandingOrderStatus;
  lastRunAt: Date | null;
  lastPeriodKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A record plus its (left-joined) asset descriptor — null for the cash kinds. */
export interface StandingOrderWithAsset extends StandingOrderRecord {
  assetSymbol: string | null;
  assetName: string | null;
  assetProviderId: string | null;
  assetProviderRef: string | null;
  assetCurrency: string | null;
  /** Non-null while the owning portfolio is soft-archived. */
  portfolioArchivedAt: Date | null;
}

/** Fields for a create; `amount` arrives as a `number`. */
export interface NewStandingOrderInput {
  userId: string;
  portfolioId: string;
  kind: StandingOrderKind;
  assetId: string | null;
  amount: number;
  currency: string;
  label: string | null;
  cadence: StandingOrderCadence;
  anchorDay: number | null;
  startDate: string;
  endDate: string | null;
}

/** One row of the exactly-once run ledger (`standing_order_runs`). */
export interface StandingOrderRunRecord {
  id: string;
  standingOrderId: string;
  periodKey: string;
  bookedAt: Date;
}

/** The mutable fields a PATCH may touch (`undefined` = leave unchanged). */
export interface StandingOrderPatch {
  amount?: number;
  label?: string | null;
  endDate?: string | null;
}

type OrderRow = typeof standingOrders.$inferSelect;

function toRecord(row: OrderRow): StandingOrderRecord {
  return {
    id: row.id,
    userId: row.userId,
    portfolioId: row.portfolioId,
    kind: row.kind,
    assetId: row.assetId ?? null,
    amount: Number(row.amount),
    currency: row.currency,
    label: row.label ?? null,
    cadence: row.cadence,
    anchorDay: row.anchorDay ?? null,
    startDate: row.startDate,
    endDate: row.endDate ?? null,
    status: row.status,
    lastRunAt: row.lastRunAt ?? null,
    lastPeriodKey: row.lastPeriodKey ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface JoinedRow {
  order: OrderRow;
  asset: {
    symbol: string | null;
    name: string | null;
    providerId: string | null;
    providerRef: string | null;
    currency: string | null;
  } | null;
  portfolio: {
    archivedAt: Date | null;
  };
}

function toWithAsset(row: JoinedRow): StandingOrderWithAsset {
  return {
    ...toRecord(row.order),
    assetSymbol: row.asset?.symbol ?? null,
    assetName: row.asset?.name ?? null,
    assetProviderId: row.asset?.providerId ?? null,
    assetProviderRef: row.asset?.providerRef ?? null,
    assetCurrency: row.asset?.currency ?? null,
    portfolioArchivedAt: row.portfolio.archivedAt ?? null,
  };
}

export function createStandingOrderRepository(db: Database) {
  const joinedSelect = () =>
    db
      .select({
        order: standingOrders,
        asset: {
          symbol: assets.symbol,
          name: assets.name,
          providerId: assets.providerId,
          providerRef: assets.providerRef,
          currency: assets.currency,
        },
        portfolio: {
          archivedAt: portfolios.archivedAt,
        },
      })
      .from(standingOrders)
      .innerJoin(portfolios, eq(portfolios.id, standingOrders.portfolioId))
      .leftJoin(assets, eq(assets.id, standingOrders.assetId));

  return {
    /** Persist a new order and return it joined with its asset descriptor. */
    async create(input: NewStandingOrderInput): Promise<StandingOrderWithAsset> {
      const [row] = await db
        .insert(standingOrders)
        .values({
          userId: input.userId,
          portfolioId: input.portfolioId,
          kind: input.kind,
          assetId: input.assetId,
          amount: input.amount.toString(),
          currency: input.currency,
          label: input.label,
          cadence: input.cadence,
          anchorDay: input.anchorDay,
          startDate: input.startDate,
          endDate: input.endDate,
        })
        .returning();
      if (!row) throw new Error('Standing order insert returned no row');
      const [joined] = await joinedSelect().where(eq(standingOrders.id, row.id));
      return toWithAsset(joined!);
    },

    /** The caller's orders (optionally one portfolio), newest first. */
    async listForUser(
      userId: string,
      opts: { portfolioId?: string } = {},
    ): Promise<StandingOrderWithAsset[]> {
      const rows = await joinedSelect()
        .where(
          opts.portfolioId
            ? and(
                eq(standingOrders.userId, userId),
                eq(standingOrders.portfolioId, opts.portfolioId),
              )
            : eq(standingOrders.userId, userId),
        )
        .orderBy(asc(standingOrders.createdAt));
      return rows.map(toWithAsset);
    },

    /** One of the caller's own orders, or null (unknown/foreign id → null). */
    async findByIdForUser(userId: string, id: string): Promise<StandingOrderWithAsset | null> {
      const [row] = await joinedSelect().where(
        and(eq(standingOrders.id, id), eq(standingOrders.userId, userId)),
      );
      return row ? toWithAsset(row) : null;
    },

    /**
     * Every active order across all users — the daily engine's scan input. Joins
     * the asset so a buy has its provider ref + native currency for the quote.
     */
    async listActive(): Promise<StandingOrderWithAsset[]> {
      const rows = await joinedSelect()
        .where(and(eq(standingOrders.status, 'active'), isNull(portfolios.archivedAt)))
        .orderBy(asc(standingOrders.createdAt));
      return rows.map(toWithAsset);
    },

    /**
     * Active orders for one owned portfolio, including a currently archived
     * portfolio. The restore boundary claims its elapsed period before the
     * portfolio is made visible to the global scanner again.
     */
    async listActiveForPortfolio(
      userId: string,
      portfolioId: string,
    ): Promise<StandingOrderWithAsset[]> {
      const rows = await joinedSelect()
        .where(
          and(
            eq(standingOrders.userId, userId),
            eq(standingOrders.portfolioId, portfolioId),
            eq(standingOrders.status, 'active'),
          ),
        )
        .orderBy(asc(standingOrders.createdAt));
      return rows.map(toWithAsset);
    },

    /**
     * Serialize a standing-order money write with this portfolio's archive
     * transition. The active check belongs *inside* the shared xact lock: a
     * worker may have read an active order before an archive request commits,
     * but cannot claim or write money once that transition won the lock.
     *
     * The order check is deliberately in this critical section too. Restore can
     * advance its watermark while an old worker is awaiting a quote; merely
     * rechecking the portfolio would let that worker claim a period behind the
     * restored watermark after the portfolio becomes active again.
     */
    async withActivePortfolioLock<T>(
      portfolioId: string,
      standingOrderId: string,
      periodKey: string,
      action: (transaction: Database) => Promise<T>,
    ): Promise<T | null> {
      return db.transaction(async (tx) => {
        await lockPortfolioMutationInTransaction(tx, portfolioId);
        const active = await tx
          .select({ id: portfolios.id })
          .from(portfolios)
          .where(and(eq(portfolios.id, portfolioId), isNull(portfolios.archivedAt)))
          .limit(1);
        if (active.length === 0) return null;

        // `FOR UPDATE` serializes this validation with pause/resume and the
        // restore-side watermark update. PostgreSQL rechecks the predicate when
        // it waits on a concurrent updater, so a later acknowledged period can
        // never be claimed by this stale worker.
        const current = await tx
          .select({ id: standingOrders.id })
          .from(standingOrders)
          .where(
            and(
              eq(standingOrders.id, standingOrderId),
              eq(standingOrders.portfolioId, portfolioId),
              eq(standingOrders.status, 'active'),
              or(isNull(standingOrders.lastPeriodKey), lt(standingOrders.lastPeriodKey, periodKey)),
            ),
          )
          .limit(1)
          .for('update');
        if (current.length === 0) return null;

        return action(tx as unknown as Database);
      });
    },

    /** Patch mutable fields; scoped to the owner. Returns the updated record or null. */
    async update(
      userId: string,
      id: string,
      patch: StandingOrderPatch,
    ): Promise<StandingOrderWithAsset | null> {
      const set: Partial<typeof standingOrders.$inferInsert> = { updatedAt: new Date() };
      if (patch.amount !== undefined) set.amount = patch.amount.toString();
      if (patch.label !== undefined) set.label = patch.label;
      if (patch.endDate !== undefined) set.endDate = patch.endDate;
      const [row] = await db
        .update(standingOrders)
        .set(set)
        .where(and(eq(standingOrders.id, id), eq(standingOrders.userId, userId)))
        .returning({ id: standingOrders.id });
      if (!row) return null;
      return this.findByIdForUser(userId, id);
    },

    /** Flip status (pause/resume); scoped to the owner. Returns updated or null. */
    async setStatus(
      userId: string,
      id: string,
      status: StandingOrderStatus,
    ): Promise<StandingOrderWithAsset | null> {
      const [row] = await db
        .update(standingOrders)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(standingOrders.id, id), eq(standingOrders.userId, userId)))
        .returning({ id: standingOrders.id });
      if (!row) return null;
      return this.findByIdForUser(userId, id);
    },

    /** Hard-delete an own order (its runs cascade). Returns whether one was removed. */
    async remove(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(standingOrders)
        .where(and(eq(standingOrders.id, id), eq(standingOrders.userId, userId)))
        .returning({ id: standingOrders.id });
      return rows.length > 0;
    },

    /**
     * Every run-ledger row of the caller's orders, oldest first.
     *
     * The ledger — not the order's `lastPeriodKey` watermark — is the
     * authoritative exactly-once record: {@link claimPeriod} writes a row BEFORE
     * booking, and a booking (or `markBooked`) failure afterwards deliberately
     * leaves that claim behind as an un-retried tombstone. Anything that has to
     * reproduce this account's exactly-once state elsewhere — the paranoid-mode
     * capture — must read these rows, because the watermark cannot express them.
     */
    async listRunsForUser(userId: string): Promise<StandingOrderRunRecord[]> {
      const rows = await db
        .select({
          id: standingOrderRuns.id,
          standingOrderId: standingOrderRuns.standingOrderId,
          periodKey: standingOrderRuns.periodKey,
          bookedAt: standingOrderRuns.bookedAt,
        })
        .from(standingOrderRuns)
        .innerJoin(standingOrders, eq(standingOrders.id, standingOrderRuns.standingOrderId))
        .where(eq(standingOrders.userId, userId))
        .orderBy(asc(standingOrderRuns.bookedAt), asc(standingOrderRuns.id));
      return rows;
    },

    /**
     * Which of the supplied periods already have an exactly-once claim for one
     * order. The execution engine uses this bounded lookup when a stale
     * `lastPeriodKey` watermark would otherwise misclassify a tombstone (or a
     * successfully booked row whose watermark update failed) as dropped.
     */
    async listClaimedPeriodKeys(
      standingOrderId: string,
      periodKeys: readonly string[],
    ): Promise<string[]> {
      if (periodKeys.length === 0) return [];
      const rows = await db
        .select({ periodKey: standingOrderRuns.periodKey })
        .from(standingOrderRuns)
        .where(
          and(
            eq(standingOrderRuns.standingOrderId, standingOrderId),
            inArray(standingOrderRuns.periodKey, [...periodKeys]),
          ),
        )
        .orderBy(asc(standingOrderRuns.periodKey));
      return rows.map((row) => row.periodKey);
    },

    /**
     * Atomically claim one period for an order via the UNIQUE(order, period)
     * index. The CTE locks and rechecks the current scheduler watermark before
     * inserting, so an old worker cannot claim a period that a newer restore or
     * worker has already acknowledged. Returns true iff THIS call created the
     * claim (so it must book); false means the period was already handled or
     * claimed (skip — the double-run guard).
     */
    async claimPeriod(
      standingOrderId: string,
      periodKey: string,
      executor: Database = db,
    ): Promise<boolean> {
      const inserted = await executor.execute(sql`
        WITH eligible_order AS (
          SELECT ${standingOrders.id}
          FROM ${standingOrders}
          WHERE ${standingOrders.id} = ${standingOrderId}::uuid
            AND (
              ${standingOrders.lastPeriodKey} IS NULL
              OR ${standingOrders.lastPeriodKey} < ${periodKey}::date
            )
          FOR UPDATE
        )
        INSERT INTO ${standingOrderRuns} ("id", "standing_order_id", "period_key")
        SELECT ${newId()}::uuid, eligible_order."id", ${periodKey}::date
        FROM eligible_order
        ON CONFLICT ("standing_order_id", "period_key") DO NOTHING
        RETURNING "id"
      `);
      const rows = (inserted as { rows?: unknown[] }).rows ?? (inserted as unknown[]);
      return rows.length > 0;
    },

    /**
     * Atomically record a period that was deliberately skipped while the owning
     * portfolio was archived, and advance its scheduler watermark through that
     * period. Unlike {@link markBooked}, this creates no money row; `lastRunAt`
     * records when the scheduler acknowledged the skipped period so the
     * watermark remains a complete pair for paranoid-vault capture/restore.
     *
     * Returns true only when this call created the durable run claim. A prior
     * claim is still reflected in the watermark, which repairs a legacy
     * claim-only tombstone without creating a duplicate run.
     */
    async claimSkippedPeriod(
      standingOrderId: string,
      periodKey: string,
      skippedAt: Date,
    ): Promise<boolean> {
      return db.transaction(async (tx) => {
        const transaction = tx as unknown as Database;
        const rows = await transaction
          .insert(standingOrderRuns)
          .values({ standingOrderId, periodKey })
          .onConflictDoNothing()
          .returning({ id: standingOrderRuns.id });

        await transaction
          .update(standingOrders)
          .set({ lastPeriodKey: periodKey, lastRunAt: skippedAt, updatedAt: skippedAt })
          .where(
            and(
              eq(standingOrders.id, standingOrderId),
              or(isNull(standingOrders.lastPeriodKey), lt(standingOrders.lastPeriodKey, periodKey)),
            ),
          );
        return rows.length > 0;
      });
    },

    /**
     * Compensate a newly-created archive/restore claim if the portfolio never
     * became active. The conditional watermark reset cannot clobber a later
     * scheduler acknowledgement.
     */
    async rollbackSkippedPeriod(
      standingOrderId: string,
      periodKey: string,
      previous: { lastPeriodKey: string | null; lastRunAt: Date | null },
    ): Promise<void> {
      await db.transaction(async (tx) => {
        const transaction = tx as unknown as Database;
        const removed = await transaction
          .delete(standingOrderRuns)
          .where(
            and(
              eq(standingOrderRuns.standingOrderId, standingOrderId),
              eq(standingOrderRuns.periodKey, periodKey),
            ),
          )
          .returning({ id: standingOrderRuns.id });
        if (removed.length === 0) return;

        await transaction
          .update(standingOrders)
          .set({
            lastPeriodKey: previous.lastPeriodKey,
            lastRunAt: previous.lastRunAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(standingOrders.id, standingOrderId),
              eq(standingOrders.lastPeriodKey, periodKey),
            ),
          );
      });
    },

    /**
     * Record that a period booked: bump the order's display bookkeeping without
     * ever walking its watermark backward. A slow worker may finish after a
     * later restore or scan has already acknowledged a newer period.
     */
    async markBooked(standingOrderId: string, periodKey: string, bookedAt: Date): Promise<void> {
      await db
        .update(standingOrders)
        .set({ lastPeriodKey: periodKey, lastRunAt: bookedAt, updatedAt: new Date() })
        .where(
          and(
            eq(standingOrders.id, standingOrderId),
            or(isNull(standingOrders.lastPeriodKey), lt(standingOrders.lastPeriodKey, periodKey)),
          ),
        );
    },
  };
}

export type StandingOrderRepository = ReturnType<typeof createStandingOrderRepository>;
