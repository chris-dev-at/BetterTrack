import { and, eq, gte, lt, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { cashMovementTags, cashTags, portfolioCashMovements } from '../schema';

/**
 * Read-only aggregates over one portfolio's cash ledger, grouped by tag and by
 * month — what the Cash flow overview and the Home widget draw.
 *
 * SCOPING. Every query is filtered by `portfolio_id`, which the service has
 * already proved the caller owns (`requireOwnedPortfolio` precedes every call),
 * exactly like `cashMovementRepository`.
 *
 * ── WHY THE TAG ROWS DO NOT ADD UP ──
 *
 * A movement carrying both `Food` and `Groceries` contributes its FULL magnitude
 * to both tag rows, because "how much went on Food" must not depend on what else
 * that row was labelled. So the per-tag rows over-count relative to the portfolio
 * totals whenever any row carries two tags. The totals are therefore computed
 * SEPARATELY, straight off the movements, and are the only figures that reconcile
 * to the ledger. The surface states this; the contract states it too.
 *
 * ── WHY INTERNAL TRANSFERS ARE NOT IN ANY BUCKET (#1754) ──
 *
 * Both legs of `POST /cash/transfer` live in the SAME portfolio (one INSERT, one
 * `portfolioId` — see `cashMovementRepository.insertTransferPair`). Bucketing on
 * the sign of `amount_eur` alone therefore reported a single €9,000 Main →
 * Savings move as €9,000 of inflow AND €9,000 of outflow: `net` stayed right,
 * but the overview read "Inflow €9.000 · Outflow €9.000", the by-tag donut made
 * `transfer` the month's dominant "where the money went", and the Home cashflow
 * widget drew two 9k bars for money that never left.
 *
 * `packages/domain/src/cashLedger.ts` already states the invariant every
 * roll-up owes: the paired legs "cancel to zero in every sum". {@link
 * EXTERNAL_LEG} is that invariant, applied to all four aggregates here — so
 * the totals, the tag rows, the untagged residual and the trend points agree
 * with each other and with the ledger. Deposits, withdrawals, fees and every
 * engine-booked kind are untouched.
 */

export interface CashMonthTotals {
  /** Magnitude (positive) of the month's inflows. */
  inflowMicros: number;
  /** Magnitude (positive) of the month's outflows. */
  outflowMicros: number;
}

export interface CashTagTotals {
  tagId: string;
  name: string;
  color: string;
  system: boolean;
  inflowMicros: number;
  outflowMicros: number;
  movements: number;
}

export interface CashTrendRow {
  /** `YYYY-MM`. */
  month: string;
  inflowMicros: number;
  outflowMicros: number;
}

/**
 * The rows a cash-flow roll-up may count: everything EXCEPT the two legs of an
 * internal transfer, which move money between two sources of the same portfolio
 * and cancel (see the header). Applied by every aggregate in this file.
 */
const EXTERNAL_LEG = sql`${portfolioCashMovements.kind} NOT IN ('transfer_in', 'transfer_out')`;

/** First instant of `period`, and of the month after it. */
function monthBounds(period: string): { from: Date; toExclusive: Date } {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    toExclusive: new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1)),
  };
}

/**
 * `numeric(20,6)` sums arrive as decimal strings; everything here is integer
 * MICROS so no aggregate is routed through a binary float on the way out.
 */
function toMicros(value: string | number | null): number {
  if (value === null) return 0;
  const text = typeof value === 'number' ? value.toFixed(6) : value.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) return 0;
  const [, sign, whole, fraction = ''] = match;
  const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  return sign === '-' ? -micros : micros;
}

export function createCashSummaryRepository(db: Database) {
  return {
    /**
     * The portfolio's own inflow/outflow for a month — over EVERY movement,
     * tagged or not. These are the authoritative figures; see the header.
     */
    async monthTotals(portfolioId: string, period: string): Promise<CashMonthTotals> {
      const { from, toExclusive } = monthBounds(period);
      const rows = await db
        .select({
          inflow: sql<string>`coalesce(sum(${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} > 0), 0)`,
          outflow: sql<string>`coalesce(sum(-${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} < 0), 0)`,
        })
        .from(portfolioCashMovements)
        .where(
          and(
            eq(portfolioCashMovements.portfolioId, portfolioId),
            gte(portfolioCashMovements.executedAt, from),
            lt(portfolioCashMovements.executedAt, toExclusive),
            EXTERNAL_LEG,
          ),
        );
      const row = rows[0];
      return {
        inflowMicros: toMicros(row?.inflow ?? '0'),
        outflowMicros: toMicros(row?.outflow ?? '0'),
      };
    },

    /** Per-tag breakdown for a month. Excludes the untagged bucket (see below). */
    async tagTotals(portfolioId: string, period: string): Promise<CashTagTotals[]> {
      const { from, toExclusive } = monthBounds(period);
      const rows = await db
        .select({
          tagId: cashTags.id,
          name: cashTags.name,
          color: cashTags.color,
          system: cashTags.system,
          inflow: sql<string>`coalesce(sum(${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} > 0), 0)`,
          outflow: sql<string>`coalesce(sum(-${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} < 0), 0)`,
          movements: sql<string>`count(*)`,
        })
        .from(cashMovementTags)
        .innerJoin(
          portfolioCashMovements,
          eq(portfolioCashMovements.id, cashMovementTags.movementId),
        )
        .innerJoin(cashTags, eq(cashTags.id, cashMovementTags.tagId))
        .where(
          and(
            eq(portfolioCashMovements.portfolioId, portfolioId),
            gte(portfolioCashMovements.executedAt, from),
            lt(portfolioCashMovements.executedAt, toExclusive),
            EXTERNAL_LEG,
          ),
        )
        .groupBy(cashTags.id, cashTags.name, cashTags.color, cashTags.system);
      return rows.map((row) => ({
        tagId: row.tagId,
        name: row.name,
        color: row.color,
        system: row.system,
        inflowMicros: toMicros(row.inflow),
        outflowMicros: toMicros(row.outflow),
        movements: Number(row.movements),
      }));
    },

    /**
     * The month's movements carrying NO tag — the "uncategorized" bucket the old
     * dashboards had. It is the one row that is genuinely disjoint from every
     * tag row, so it can be reported beside them without double-counting.
     */
    async untaggedTotals(portfolioId: string, period: string): Promise<CashTagTotals> {
      const { from, toExclusive } = monthBounds(period);
      const rows = await db
        .select({
          inflow: sql<string>`coalesce(sum(${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} > 0), 0)`,
          outflow: sql<string>`coalesce(sum(-${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} < 0), 0)`,
          movements: sql<string>`count(*)`,
        })
        .from(portfolioCashMovements)
        .where(
          and(
            eq(portfolioCashMovements.portfolioId, portfolioId),
            gte(portfolioCashMovements.executedAt, from),
            lt(portfolioCashMovements.executedAt, toExclusive),
            EXTERNAL_LEG,
            sql`NOT EXISTS (
              SELECT 1 FROM ${cashMovementTags}
              WHERE ${cashMovementTags.movementId} = ${portfolioCashMovements.id}
            )`,
          ),
        );
      const row = rows[0];
      return {
        tagId: '',
        name: '',
        color: '',
        system: false,
        inflowMicros: toMicros(row?.inflow ?? '0'),
        outflowMicros: toMicros(row?.outflow ?? '0'),
        movements: Number(row?.movements ?? 0),
      };
    },

    /**
     * Per-month inflow/outflow across a window. Returns only months that HAVE
     * movements; the service fills the gaps with zeros so the caller always gets
     * one point per month and a chart never draws a hole as a slope.
     */
    async trendRows(portfolioId: string, from: Date, toExclusive: Date): Promise<CashTrendRow[]> {
      const rows = await db
        .select({
          month: sql<string>`to_char(${portfolioCashMovements.executedAt} AT TIME ZONE 'UTC', 'YYYY-MM')`,
          inflow: sql<string>`coalesce(sum(${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} > 0), 0)`,
          outflow: sql<string>`coalesce(sum(-${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} < 0), 0)`,
        })
        .from(portfolioCashMovements)
        .where(
          and(
            eq(portfolioCashMovements.portfolioId, portfolioId),
            gte(portfolioCashMovements.executedAt, from),
            lt(portfolioCashMovements.executedAt, toExclusive),
            EXTERNAL_LEG,
          ),
        )
        // Bucketed in UTC, matching how the daily series buckets days and how the
        // migration parked every carried-over row at UTC midnight.
        .groupBy(sql`to_char(${portfolioCashMovements.executedAt} AT TIME ZONE 'UTC', 'YYYY-MM')`);
      return rows.map((row) => ({
        month: row.month,
        inflowMicros: toMicros(row.inflow),
        outflowMicros: toMicros(row.outflow),
      }));
    },
  };
}

export type CashSummaryRepository = ReturnType<typeof createCashSummaryRepository>;
