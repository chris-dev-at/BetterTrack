import type {
  CreateExpenseBudgetRequest,
  ExpenseBudget,
  ExpenseBudgetListResponse,
  ExpenseBudgetProgress,
  ExpenseBudgetResponse,
  ExpenseCategorySummary,
  ExpenseMonthlySummaryResponse,
  ExpenseTrendPoint,
  ExpenseTrendResponse,
  UpdateExpenseBudgetRequest,
} from '@bettertrack/contracts';
import { EXPENSE_TREND_MONTHS_DEFAULT } from '@bettertrack/contracts';

import { badRequest, conflict, notFound } from '../../errors';
import type {
  ExpenseBudgetRecord,
  ExpenseBudgetRepository,
  ExpenseCategoryRepository,
  ExpenseTransactionRepository,
} from '../../data/repositories/expenseRepository';
import type { Logger } from '../../logger';
import type { NotificationCenter } from '../notifications/notificationCenter';

/**
 * Expense dashboards + per-category budgets with matrix-routed alerts
 * (PROJECTPLAN.md §13.5 V5-P9, issue 3/3). This is the insights surface over the
 * strictly-separate expense ledger: monthly spend-by-category, income-vs-spend
 * and trend aggregates, plus a budget the owner sets per category that fires a
 * `budget.exceeded` notification EXACTLY ONCE per month once its spend blows the
 * target.
 *
 * Strict separation (the P9 mandate) holds by construction: this service touches
 * only the expense repositories and the notification center — it imports no
 * portfolio / domain money-math / tax / currency module, so the feature cannot
 * alter any portfolio surface and does no FX (every aggregate is a currency-naive
 * magnitude sum in the recorded amounts; the area is single-currency by design).
 *
 * Exactly-once alerting: {@link ExpenseBudgetService.evaluate} runs after every
 * expense write (transaction create/update/recategorize, import apply) and after
 * a budget upsert. It recomputes the CURRENT month's spend per budgeted category
 * and, for any budget now over target, claims the `expense_budget_fires`
 * (budget, period) marker with `INSERT … ON CONFLICT DO NOTHING` BEFORE emitting
 * — so only the first evaluation of a blown budget in a month notifies. The
 * alert rides the standard notification dispatcher (a `budget.exceeded` matrix
 * type), so instant/digest cadence + quiet hours are honoured automatically.
 */

export interface ExpenseBudgetServiceDeps {
  categories: ExpenseCategoryRepository;
  transactions: ExpenseTransactionRepository;
  budgets: ExpenseBudgetRepository;
  /** The ONE notification entry point (§6.10, #368) — emits `budget.exceeded`. */
  notify: NotificationCenter;
  /** Injectable clock (tests) for the current-period decision. */
  now?: () => Date;
  logger?: Logger;
}

export interface ExpenseBudgetService {
  // Dashboards (read-only aggregates)
  monthlySummary(userId: string, month?: string): Promise<ExpenseMonthlySummaryResponse>;
  trends(userId: string, months?: number): Promise<ExpenseTrendResponse>;
  // Budgets
  listBudgets(userId: string, month?: string): Promise<ExpenseBudgetListResponse>;
  createBudget(userId: string, input: CreateExpenseBudgetRequest): Promise<ExpenseBudgetResponse>;
  updateBudget(
    userId: string,
    budgetId: string,
    patch: UpdateExpenseBudgetRequest,
  ): Promise<ExpenseBudgetResponse>;
  deleteBudget(userId: string, budgetId: string): Promise<void>;
  /**
   * Re-evaluate the caller's budgets for the current month and fire the
   * over-budget alert for any newly-blown one (exactly once per period). Called
   * after expense writes / import apply / budget upsert. Best-effort: never
   * throws (a failure is logged, never fails the write that triggered it).
   */
  evaluate(userId: string): Promise<void>;
}

const CATEGORY_REF_INVALID = () =>
  badRequest('Referenced category not found.', 'EXPENSE_CATEGORY_REF_NOT_FOUND');
const BUDGET_NOT_FOUND = () => notFound('Budget not found.', 'EXPENSE_BUDGET_NOT_FOUND');
const BUDGET_CATEGORY_TAKEN = () =>
  conflict('That category already has a budget.', 'EXPENSE_BUDGET_CATEGORY_TAKEN');

/** A Postgres unique-constraint violation (23505) — both postgres-js and PGlite set `.code`. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}

/** The calendar-month period key (`YYYY-MM`, UTC) for an instant. */
function periodKeyFor(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** The `[from, toExclusive)` ISO-day bounds of a `YYYY-MM` month. */
function monthBounds(period: string): { from: string; toExclusive: string } {
  const parts = period.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const from = `${period}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const toExclusive = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
  return { from, toExclusive };
}

/** The `count` month keys ending at (and including) `endPeriod`, oldest→newest. */
function periodsEndingAt(endPeriod: string, count: number): string[] {
  const parts = endPeriod.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  // Absolute month index (0-based) of the end period.
  const endIndex = year * 12 + (month - 1);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const idx = endIndex - i;
    const yy = Math.floor(idx / 12);
    const mm = (idx % 12) + 1;
    out.push(`${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}`);
  }
  return out;
}

/** Cent-exact "over budget" test — `spent` strictly exceeds `amount` (both 2-dp). */
function isOverBudget(spent: number, amount: number): boolean {
  return Math.round(spent * 100) > Math.round(amount * 100);
}

/** Round a magnitude to whole cents (keeps the response free of float dust). */
function toCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function toBudget(record: ExpenseBudgetRecord): ExpenseBudget {
  return {
    id: record.id,
    categoryId: record.categoryId,
    amount: record.amount,
    currency: record.currency,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function createExpenseBudgetService(deps: ExpenseBudgetServiceDeps): ExpenseBudgetService {
  const { categories, transactions, budgets, notify, logger } = deps;
  const now = deps.now ?? (() => new Date());

  /** A referenced category must be one the caller actually owns (§8). */
  async function assertOwnsCategory(userId: string, categoryId: string): Promise<void> {
    if (!(await categories.ownsCategory(userId, categoryId))) throw CATEGORY_REF_INVALID();
  }

  /** The per-category EXPENSE spend for a month, keyed by categoryId (null bucket dropped). */
  async function expenseByCategory(userId: string, period: string): Promise<Map<string, number>> {
    const { from, toExclusive } = monthBounds(period);
    const rows = await transactions.sumByCategoryDirection(userId, from, toExclusive);
    const map = new Map<string, number>();
    for (const row of rows) {
      if (row.direction !== 'expense' || row.categoryId === null) continue;
      map.set(row.categoryId, (map.get(row.categoryId) ?? 0) + row.total);
    }
    return map;
  }

  return {
    // ── Dashboards ──
    async monthlySummary(userId, month) {
      const period = month ?? periodKeyFor(now());
      const { from, toExclusive } = monthBounds(period);
      const [rows, categoryRecords] = await Promise.all([
        transactions.sumByCategoryDirection(userId, from, toExclusive),
        categories.listForOwner(userId),
      ]);
      const meta = new Map(categoryRecords.map((c) => [c.id, c]));

      // Fold the (category, direction) totals into one row per category.
      interface Acc {
        expense: number;
        income: number;
      }
      const byCategory = new Map<string | null, Acc>();
      let totalExpense = 0;
      let totalIncome = 0;
      for (const row of rows) {
        const acc = byCategory.get(row.categoryId) ?? { expense: 0, income: 0 };
        if (row.direction === 'expense') {
          acc.expense += row.total;
          totalExpense += row.total;
        } else {
          acc.income += row.total;
          totalIncome += row.total;
        }
        byCategory.set(row.categoryId, acc);
      }

      const categorySummaries: ExpenseCategorySummary[] = [];
      for (const [categoryId, acc] of byCategory) {
        if (acc.expense === 0 && acc.income === 0) continue;
        const category = categoryId === null ? undefined : meta.get(categoryId);
        categorySummaries.push({
          categoryId,
          name: category?.name ?? null,
          color: category?.color ?? null,
          expense: toCents(acc.expense),
          income: toCents(acc.income),
        });
      }
      // Expense-heaviest first; the uncategorized bucket (null) always last.
      categorySummaries.sort((a, b) => {
        if (a.categoryId === null) return 1;
        if (b.categoryId === null) return -1;
        return b.expense - a.expense;
      });

      return {
        month: period,
        totalExpense: toCents(totalExpense),
        totalIncome: toCents(totalIncome),
        net: toCents(totalIncome - totalExpense),
        categories: categorySummaries,
      };
    },

    async trends(userId, months) {
      const count = months ?? EXPENSE_TREND_MONTHS_DEFAULT;
      const endPeriod = periodKeyFor(now());
      const periods = periodsEndingAt(endPeriod, count);
      const from = `${periods[0]!}-01`;
      const { toExclusive } = monthBounds(endPeriod);
      const rows = await transactions.sumByMonthDirection(userId, from, toExclusive);

      const byMonth = new Map<string, { expense: number; income: number }>();
      for (const row of rows) {
        const acc = byMonth.get(row.month) ?? { expense: 0, income: 0 };
        if (row.direction === 'expense') acc.expense += row.total;
        else acc.income += row.total;
        byMonth.set(row.month, acc);
      }

      const points: ExpenseTrendPoint[] = periods.map((month) => {
        const acc = byMonth.get(month);
        return {
          month,
          expense: toCents(acc?.expense ?? 0),
          income: toCents(acc?.income ?? 0),
        };
      });
      return { points };
    },

    // ── Budgets ──
    async listBudgets(userId, month) {
      const period = month ?? periodKeyFor(now());
      const [budgetRecords, categoryRecords, spentByCategory] = await Promise.all([
        budgets.listForOwner(userId),
        categories.listForOwner(userId),
        expenseByCategory(userId, period),
      ]);
      const meta = new Map(categoryRecords.map((c) => [c.id, c]));

      const progress: ExpenseBudgetProgress[] = budgetRecords.map((budget) => {
        const category = meta.get(budget.categoryId);
        const spent = toCents(spentByCategory.get(budget.categoryId) ?? 0);
        return {
          id: budget.id,
          categoryId: budget.categoryId,
          categoryName: category?.name ?? '',
          categoryColor: category?.color ?? '#64748b',
          amount: budget.amount,
          currency: budget.currency,
          period,
          spent,
          remaining: toCents(budget.amount - spent),
          exceeded: isOverBudget(spent, budget.amount),
        };
      });
      return { period, budgets: progress };
    },

    async createBudget(userId, input) {
      await assertOwnsCategory(userId, input.categoryId);
      let record: ExpenseBudgetRecord;
      try {
        record = await budgets.create(userId, {
          categoryId: input.categoryId,
          amount: input.amount,
          currency: input.currency,
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw BUDGET_CATEGORY_TAKEN();
        throw err;
      }
      // A budget set below the month's spend-to-date should alert immediately.
      await this.evaluate(userId);
      return { budget: toBudget(record) };
    },

    async updateBudget(userId, budgetId, patch) {
      const record = await budgets.update(userId, budgetId, {
        amount: patch.amount,
        currency: patch.currency,
      });
      if (!record) throw BUDGET_NOT_FOUND();
      // Lowering a target may newly blow it — re-evaluate for the current period.
      await this.evaluate(userId);
      return { budget: toBudget(record) };
    },

    async deleteBudget(userId, budgetId) {
      const deleted = await budgets.delete(userId, budgetId);
      if (!deleted) throw BUDGET_NOT_FOUND();
    },

    async evaluate(userId) {
      try {
        const budgetRecords = await budgets.listForOwner(userId);
        if (budgetRecords.length === 0) return;
        const period = periodKeyFor(now());
        const [spentByCategory, categoryRecords] = await Promise.all([
          expenseByCategory(userId, period),
          categories.listForOwner(userId),
        ]);
        const meta = new Map(categoryRecords.map((c) => [c.id, c]));

        for (const budget of budgetRecords) {
          const spent = spentByCategory.get(budget.categoryId) ?? 0;
          if (!isOverBudget(spent, budget.amount)) continue;
          // Claim the (budget, period) marker BEFORE emitting — the exactly-once
          // gate. A losing claim means this month already alerted; skip.
          let claimed = false;
          try {
            claimed = await budgets.claimFire(budget.id, period);
          } catch (err) {
            logger?.warn({ err, budgetId: budget.id }, 'budget fire-claim failed');
            continue;
          }
          if (!claimed) continue;

          const category = meta.get(budget.categoryId);
          const ok = await notify.emit({
            type: 'budget.exceeded',
            userId,
            budgetId: budget.id,
            categoryId: budget.categoryId,
            categoryName: category?.name ?? '',
            period,
            amount: budget.amount,
            spent: toCents(spent),
            currency: budget.currency,
            occurredAt: now().toISOString(),
          });
          // The emit reached no durable transport — roll the claim back so a
          // later write re-attempts rather than swallowing the one alert.
          if (!ok) {
            try {
              await budgets.releaseFire(budget.id, period);
            } catch (err) {
              logger?.warn({ err, budgetId: budget.id }, 'budget fire-release failed');
            }
          }
        }
      } catch (err) {
        // Evaluation is best-effort — never fail the write that triggered it.
        logger?.warn({ err, userId }, 'budget evaluation failed');
      }
    },
  };
}
