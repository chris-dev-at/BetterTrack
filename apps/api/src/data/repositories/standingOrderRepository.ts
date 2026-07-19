import { and, asc, eq } from 'drizzle-orm';

import type {
  StandingOrderCadence,
  StandingOrderKind,
  StandingOrderStatus,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import { assets, standingOrderRuns, standingOrders } from '../schema';

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
}

function toWithAsset(row: JoinedRow): StandingOrderWithAsset {
  return {
    ...toRecord(row.order),
    assetSymbol: row.asset?.symbol ?? null,
    assetName: row.asset?.name ?? null,
    assetProviderId: row.asset?.providerId ?? null,
    assetProviderRef: row.asset?.providerRef ?? null,
    assetCurrency: row.asset?.currency ?? null,
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
      })
      .from(standingOrders)
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
        .where(eq(standingOrders.status, 'active'))
        .orderBy(asc(standingOrders.createdAt));
      return rows.map(toWithAsset);
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
     * Atomically claim one period for an order via the UNIQUE(order, period)
     * index. Returns true iff THIS call created the claim (so it must book);
     * false means the period was already claimed (skip — the double-run guard).
     */
    async claimPeriod(standingOrderId: string, periodKey: string): Promise<boolean> {
      const rows = await db
        .insert(standingOrderRuns)
        .values({ standingOrderId, periodKey })
        .onConflictDoNothing()
        .returning({ id: standingOrderRuns.id });
      return rows.length > 0;
    },

    /** Record that a period booked: bump the order's display bookkeeping. */
    async markBooked(standingOrderId: string, periodKey: string, bookedAt: Date): Promise<void> {
      await db
        .update(standingOrders)
        .set({ lastPeriodKey: periodKey, lastRunAt: bookedAt, updatedAt: new Date() })
        .where(eq(standingOrders.id, standingOrderId));
    },
  };
}

export type StandingOrderRepository = ReturnType<typeof createStandingOrderRepository>;
