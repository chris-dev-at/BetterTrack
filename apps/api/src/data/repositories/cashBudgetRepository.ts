import { and, asc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';

import type { Database } from '../db';
import {
  cashBudgetFires,
  cashBudgets,
  cashMovementTags,
  cashTags,
  portfolioCashMovements,
  portfolios,
  type CashBudgetRow,
} from '../schema';

/**
 * Cash-budget persistence (V5 cash fusion). A budget is a monthly spend target
 * for one tag inside one portfolio — money, so it belongs to the portfolio whose
 * ledger it measures, while the tag it points at is user-scoped.
 *
 * SCOPING (§10). Budgets carry no `user_id`: like every other portfolio-scoped
 * table the owner is `portfolios.user_id`, and every read and write in this file
 * joins through it. A budget id belonging to another account is not found.
 *
 * `period_key` NULL is the RECURRING monthly target (exactly what
 * `expense_budgets` was); `'YYYY-MM'` is a single-month override. Two unique
 * indexes back that, because NULLs are distinct in a Postgres unique index —
 * without the partial one a tag could hold two recurring budgets.
 */

export interface CashBudgetRecord {
  id: string;
  portfolioId: string;
  tagId: string;
  periodKey: string | null;
  /** `numeric(20,2)` text — never parsed to a float in this layer. */
  amount: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCashBudgetInput {
  portfolioId: string;
  tagId: string;
  periodKey: string | null;
  amount: string;
  currency: string;
}

export interface UpdateCashBudgetPatch {
  amount?: string;
  currency?: string;
}

/** A budget joined to the tag it targets — what the budgets surface lists. */
export interface CashBudgetWithTag extends CashBudgetRecord {
  tagName: string;
  tagColor: string;
}

function toBudget(row: CashBudgetRow): CashBudgetRecord {
  return {
    id: row.id,
    portfolioId: row.portfolioId,
    tagId: row.tagId,
    periodKey: row.periodKey ?? null,
    amount: row.amount,
    currency: row.currency,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** First day of the month after `period` — the exclusive upper bound. */
function monthBounds(period: string): { from: Date; toExclusive: Date } {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    toExclusive: new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1)),
  };
}

export function createCashBudgetRepository(db: Database) {
  return {
    /**
     * Every budget in one portfolio, with its tag. Scoped through the portfolio's
     * owner, so a portfolio id the caller does not own yields nothing.
     */
    async listForPortfolio(userId: string, portfolioId: string): Promise<CashBudgetWithTag[]> {
      const rows = await db
        .select({ budget: cashBudgets, tagName: cashTags.name, tagColor: cashTags.color })
        .from(cashBudgets)
        .innerJoin(portfolios, eq(portfolios.id, cashBudgets.portfolioId))
        .innerJoin(cashTags, eq(cashTags.id, cashBudgets.tagId))
        .where(and(eq(cashBudgets.portfolioId, portfolioId), eq(portfolios.userId, userId)))
        .orderBy(asc(cashTags.name), asc(cashBudgets.periodKey));
      return rows.map((row) => ({
        ...toBudget(row.budget),
        tagName: row.tagName,
        tagColor: row.tagColor,
      }));
    },

    /**
     * Every budget of every portfolio this owner has, for the evaluator. Joined
     * through `portfolios.user_id`, so it can never pick up a foreign ledger.
     */
    async listForOwner(userId: string): Promise<CashBudgetWithTag[]> {
      const rows = await db
        .select({ budget: cashBudgets, tagName: cashTags.name, tagColor: cashTags.color })
        .from(cashBudgets)
        .innerJoin(portfolios, eq(portfolios.id, cashBudgets.portfolioId))
        .innerJoin(cashTags, eq(cashTags.id, cashBudgets.tagId))
        .where(eq(portfolios.userId, userId))
        .orderBy(asc(cashBudgets.createdAt), asc(cashBudgets.id));
      return rows.map((row) => ({
        ...toBudget(row.budget),
        tagName: row.tagName,
        tagColor: row.tagColor,
      }));
    },

    async findByIdForOwner(userId: string, budgetId: string): Promise<CashBudgetRecord | null> {
      const rows = await db
        .select({ budget: cashBudgets })
        .from(cashBudgets)
        .innerJoin(portfolios, eq(portfolios.id, cashBudgets.portfolioId))
        .where(and(eq(cashBudgets.id, budgetId), eq(portfolios.userId, userId)))
        .limit(1);
      const row = rows[0];
      return row ? toBudget(row.budget) : null;
    },

    /**
     * Create. The caller has already proved it owns both the portfolio and the
     * tag; a duplicate `(portfolio, tag, period)` raises `23505`, which the
     * service maps to a 409 rather than swallowing.
     */
    async create(input: CreateCashBudgetInput): Promise<CashBudgetRecord> {
      const [row] = await db
        .insert(cashBudgets)
        .values({
          portfolioId: input.portfolioId,
          tagId: input.tagId,
          periodKey: input.periodKey,
          amount: input.amount,
          currency: input.currency,
        })
        .returning();
      return toBudget(row!);
    },

    /**
     * Retarget the amount. Portfolio, tag and period are fixed at creation (move
     * = delete + create), so a budget can never drift onto another ledger or
     * another month. The `WHERE` re-proves ownership at write time.
     */
    async update(
      userId: string,
      budgetId: string,
      patch: UpdateCashBudgetPatch,
    ): Promise<CashBudgetRecord | null> {
      if (patch.amount === undefined && patch.currency === undefined) {
        return this.findByIdForOwner(userId, budgetId);
      }
      const [row] = await db
        .update(cashBudgets)
        .set({
          ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
          ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(cashBudgets.id, budgetId),
            // Drizzle cannot UPDATE ... USING a join, so ownership rides in as a
            // correlated subquery — still one statement, still not a controller.
            sql`EXISTS (
              SELECT 1 FROM ${portfolios}
              WHERE ${portfolios.id} = ${cashBudgets.portfolioId}
                AND ${portfolios.userId} = ${userId}
            )`,
          ),
        )
        .returning();
      return row ? toBudget(row) : null;
    },

    async delete(userId: string, budgetId: string): Promise<boolean> {
      const deleted = await db
        .delete(cashBudgets)
        .where(
          and(
            eq(cashBudgets.id, budgetId),
            sql`EXISTS (
              SELECT 1 FROM ${portfolios}
              WHERE ${portfolios.id} = ${cashBudgets.portfolioId}
                AND ${portfolios.userId} = ${userId}
            )`,
          ),
        )
        .returning({ id: cashBudgets.id });
      return deleted.length > 0;
    },

    /**
     * OUTFLOW MAGNITUDE PER TAG for one portfolio-month — what a budget is
     * measured against.
     *
     * Only negative `amount_eur` rows count, and the magnitude is returned
     * positive, because a budget is a spend ceiling: an inflow carrying `Food`
     * (a refund) must not create budget headroom that was never there.
     *
     * A movement carrying two tags contributes its full magnitude to BOTH tag
     * rows. That is deliberate and it is why these totals do not sum to the
     * portfolio's outflow — "how much went on Food" cannot depend on what else
     * the row was labelled.
     */
    async outflowByTag(portfolioId: string, period: string): Promise<Map<string, number>> {
      const { from, toExclusive } = monthBounds(period);
      const rows = await db
        .select({
          tagId: cashMovementTags.tagId,
          outflow: sql<string>`sum(-${portfolioCashMovements.amountEur})`,
        })
        .from(cashMovementTags)
        .innerJoin(
          portfolioCashMovements,
          eq(portfolioCashMovements.id, cashMovementTags.movementId),
        )
        .where(
          and(
            eq(portfolioCashMovements.portfolioId, portfolioId),
            gte(portfolioCashMovements.executedAt, from),
            lt(portfolioCashMovements.executedAt, toExclusive),
            sql`${portfolioCashMovements.amountEur} < 0`,
          ),
        )
        .groupBy(cashMovementTags.tagId);
      const byTag = new Map<string, number>();
      for (const row of rows) byTag.set(row.tagId, Number(row.outflow));
      return byTag;
    },

    /**
     * The target in force for a tag in a month: the month-specific row if there
     * is one, else the recurring row. Used by the evaluator so a December
     * override is what December is judged against.
     */
    async effectiveTargets(portfolioId: string, period: string): Promise<CashBudgetWithTag[]> {
      const rows = await db
        .select({ budget: cashBudgets, tagName: cashTags.name, tagColor: cashTags.color })
        .from(cashBudgets)
        .innerJoin(cashTags, eq(cashTags.id, cashBudgets.tagId))
        .where(
          and(
            eq(cashBudgets.portfolioId, portfolioId),
            or(isNull(cashBudgets.periodKey), eq(cashBudgets.periodKey, period)),
          ),
        );
      // A month-specific row wins over the recurring one for the same tag.
      const byTag = new Map<string, CashBudgetWithTag>();
      for (const row of rows) {
        const entry = { ...toBudget(row.budget), tagName: row.tagName, tagColor: row.tagColor };
        const held = byTag.get(entry.tagId);
        if (held === undefined || (held.periodKey === null && entry.periodKey !== null)) {
          byTag.set(entry.tagId, entry);
        }
      }
      return [...byTag.values()];
    },

    /**
     * IDEMPOTENCY KEY: `UNIQUE(budget_id, period_key)`.
     *
     * Claim a period BEFORE notifying, so a blown budget fires exactly one alert
     * per month however many times the evaluator runs. Returns false when the
     * period was already claimed — the caller then emits nothing.
     */
    async claimFire(budgetId: string, periodKey: string): Promise<boolean> {
      const inserted = await db
        .insert(cashBudgetFires)
        .values({ budgetId, periodKey })
        .onConflictDoNothing({ target: [cashBudgetFires.budgetId, cashBudgetFires.periodKey] })
        .returning({ id: cashBudgetFires.id });
      return inserted.length > 0;
    },

    /**
     * Give a claim back when the notification was not durably accepted, so the
     * next run may try again. Without this, a transport outage would silently
     * consume the month's single alert.
     */
    async releaseFire(budgetId: string, periodKey: string): Promise<void> {
      await db
        .delete(cashBudgetFires)
        .where(
          and(eq(cashBudgetFires.budgetId, budgetId), eq(cashBudgetFires.periodKey, periodKey)),
        );
    },

    /** Whether a period has already fired, for the progress read. */
    async firedPeriods(portfolioId: string, period: string): Promise<Set<string>> {
      const rows = await db
        .select({ budgetId: cashBudgetFires.budgetId })
        .from(cashBudgetFires)
        .innerJoin(cashBudgets, eq(cashBudgets.id, cashBudgetFires.budgetId))
        .where(
          and(eq(cashBudgets.portfolioId, portfolioId), eq(cashBudgetFires.periodKey, period)),
        );
      return new Set(rows.map((row) => row.budgetId));
    },
  };
}

export type CashBudgetRepository = ReturnType<typeof createCashBudgetRepository>;
