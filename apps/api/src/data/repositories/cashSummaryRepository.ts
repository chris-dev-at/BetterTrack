import { and, eq, gte, lt, sql, type SQL } from 'drizzle-orm';

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
 *
 * ── ONE ROW SET, ONE CLOCK, FOR EVERY CASH AGGREGATE (#1792) ──
 *
 * The exclusion above originally landed here alone, so `outflowByTag` — the
 * measure a BUDGET is judged against — still counted transfer legs and reported
 * €9,000 of "spend" for money that never left the book, against a summary that
 * reported €0 for the same tag, month and portfolio. Both aggregates now build
 * their WHERE through the one exported {@link cashFlowScope}, and
 * `cashFlowScope.test.ts` fails the build if a new cash aggregate is written
 * without it.
 *
 * The clock is shared for the same reason: see {@link CASH_MONTH_TIME_ZONE}.
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
export const EXTERNAL_LEG = sql`${portfolioCashMovements.kind} NOT IN ('transfer_in', 'transfer_out')`;

/**
 * THE ONE PLACE a cash-flow aggregate says which rows it counts (#1792).
 *
 * Portfolio scope, the month window and {@link EXTERNAL_LEG} in a single call,
 * so "which movements is this figure over?" has exactly one answer across the
 * summary, the trend points and the budgets. `extra` carries whatever else a
 * particular aggregate needs (the outflow-only filter, the untagged residual's
 * NOT EXISTS) — it can never drop what this function already applied.
 *
 * A BALANCE is not a flow roll-up and must NOT use this: both legs of a
 * transfer change the balances of the two sources they touch
 * (`cashMovementRepository.balancesForPortfolio`).
 */
export function cashFlowScope(
  portfolioId: string,
  from: Date,
  toExclusive: Date,
  ...extra: SQL[]
): SQL {
  return and(
    eq(portfolioCashMovements.portfolioId, portfolioId),
    gte(portfolioCashMovements.executedAt, from),
    lt(portfolioCashMovements.executedAt, toExclusive),
    EXTERNAL_LEG,
    ...extra,
  )!;
}

/**
 * THE CLOCK A CASH MONTH IS MEASURED ON (#1792): the zone the ledger DISPLAYS
 * in (`apps/web/src/lib/format.ts`, §5.5), which is also the zone the tax engine
 * already buckets its years in (`taxRepository`).
 *
 * It used to be UTC here while the ledger rendered Vienna, so a movement stamped
 * `2026-09-30T23:15Z` — the real instant a Vienna user records at 01:15 on 1
 * October — was listed as "1 Oct", omitted from October's summary and charged to
 * SEPTEMBER's budget. One rule instead of that: **a cash movement belongs to the
 * calendar month it is displayed in.** Every window and every bucket below
 * derives from it, and so does the evaluator's "current month"
 * (`cashBudgetService.periodKeyFor`).
 *
 * Nothing the app writes with a day anchored at noon UTC moves: Vienna is ahead
 * of UTC, so converting can only carry an instant FORWARD, and only the 22:00–
 * 24:00 UTC band — exactly the rows that already displayed as the next day —
 * changes bucket.
 */
export const CASH_MONTH_TIME_ZONE = 'Europe/Vienna';

/** `to_char` bucket for {@link CASH_MONTH_TIME_ZONE} — the trend points' key. */
const MONTH_BUCKET = sql<string>`to_char(${portfolioCashMovements.executedAt} AT TIME ZONE ${sql.raw(
  `'${CASH_MONTH_TIME_ZONE}'`,
)}, 'YYYY-MM')`;

const ZONE_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: CASH_MONTH_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Wall-clock parts of an instant on the cash clock. Rides `Intl`, so no tz data ships. */
function zonedParts(at: Date): { year: number; month: number; day: number; asUtcMs: number } {
  const parts: Record<string, number> = {};
  for (const part of ZONE_PARTS.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const year = parts.year!;
  const month = parts.month!;
  const day = parts.day!;
  return {
    year,
    month,
    day,
    asUtcMs: Date.UTC(year, month - 1, day, parts.hour!, parts.minute!, parts.second!),
  };
}

/** How far the cash clock runs ahead of UTC at `at`, in ms (Vienna: +1h or +2h). */
function zoneOffsetMs(at: Date): number {
  // Compare at second resolution: the formatter has no milliseconds to give back.
  return zonedParts(at).asUtcMs - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant local midnight of `year-month-01` falls on. */
function monthStart(year: number, month: number): Date {
  const wall = Date.UTC(year, month - 1, 1);
  // Read the offset once at the naive instant, then again at the corrected one,
  // so the answer holds even for a zone that shifts across the boundary.
  const candidate = wall - zoneOffsetMs(new Date(wall));
  return new Date(wall - zoneOffsetMs(new Date(candidate)));
}

/** First instant of `period`, and of the month after it, on the cash clock. */
export function cashMonthBounds(period: string): { from: Date; toExclusive: Date } {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return {
    from: monthStart(year, month),
    toExclusive: monthStart(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1),
  };
}

/** `YYYY-MM` of an instant on the cash clock — the period key every surface uses. */
export function cashPeriodKey(at: Date): string {
  const { year, month } = zonedParts(at);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
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
      const { from, toExclusive } = cashMonthBounds(period);
      const rows = await db
        .select({
          inflow: sql<string>`coalesce(sum(${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} > 0), 0)`,
          outflow: sql<string>`coalesce(sum(-${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} < 0), 0)`,
        })
        .from(portfolioCashMovements)
        .where(cashFlowScope(portfolioId, from, toExclusive));
      const row = rows[0];
      return {
        inflowMicros: toMicros(row?.inflow ?? '0'),
        outflowMicros: toMicros(row?.outflow ?? '0'),
      };
    },

    /** Per-tag breakdown for a month. Excludes the untagged bucket (see below). */
    async tagTotals(portfolioId: string, period: string): Promise<CashTagTotals[]> {
      const { from, toExclusive } = cashMonthBounds(period);
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
        .where(cashFlowScope(portfolioId, from, toExclusive))
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
      const { from, toExclusive } = cashMonthBounds(period);
      const rows = await db
        .select({
          inflow: sql<string>`coalesce(sum(${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} > 0), 0)`,
          outflow: sql<string>`coalesce(sum(-${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} < 0), 0)`,
          movements: sql<string>`count(*)`,
        })
        .from(portfolioCashMovements)
        .where(
          cashFlowScope(
            portfolioId,
            from,
            toExclusive,
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
          month: MONTH_BUCKET,
          inflow: sql<string>`coalesce(sum(${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} > 0), 0)`,
          outflow: sql<string>`coalesce(sum(-${portfolioCashMovements.amountEur}) FILTER (WHERE ${portfolioCashMovements.amountEur} < 0), 0)`,
        })
        .from(portfolioCashMovements)
        .where(cashFlowScope(portfolioId, from, toExclusive))
        // Bucketed on the cash clock (see CASH_MONTH_TIME_ZONE), so a trend point
        // holds exactly the movements the ledger dates into that month.
        .groupBy(MONTH_BUCKET);
      return rows.map((row) => ({
        month: row.month,
        inflowMicros: toMicros(row.inflow),
        outflowMicros: toMicros(row.outflow),
      }));
    },
  };
}

export type CashSummaryRepository = ReturnType<typeof createCashSummaryRepository>;
