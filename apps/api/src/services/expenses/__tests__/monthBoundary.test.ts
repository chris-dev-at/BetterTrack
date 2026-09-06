import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createExpenseBudgetRepository,
  createExpenseCategoryRepository,
  createExpenseTransactionRepository,
} from '../../../data/repositories/expenseRepository';
import { expenseBudgetFires } from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import type { NotificationCenter } from '../../notifications/notificationCenter';
import { createExpenseBudgetService } from '../budgetService';

/**
 * The retired expense area's aggregates are still live reads, and they bucket
 * "the current month" for `monthlySummary`, `trends`, `listBudgets` and the
 * restore fence. Every row they sum is dated on the deploy's calendar day, so
 * the month must be read on the SAME clock — it used to be UTC, which made the
 * dashboards flip two hours after the ledger's own displayed month did.
 *
 * `GAP` is the instant inside that window: 01:15 on 1 October Vienna, still
 * 30 September in UTC. On the old key every assertion below answered `2025-09`,
 * and a row booked `2025-10-01` was invisible on the default month.
 *
 * These aggregates lost their coverage entirely when `expensesBudgets.test.ts`
 * was deleted in the cash-fusion commit `bb6ed456`; this file restores it.
 */
const GAP = new Date('2025-09-30T23:15:00.000Z');
/** Mid-day, mid-month — where the two clocks agree, as the control. */
const MIDDAY = new Date('2025-09-30T12:00:00.000Z');

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

function serviceAt(now: Date) {
  const emit = vi.fn<NotificationCenter['emit']>().mockResolvedValue(true);
  return {
    emit,
    service: createExpenseBudgetService({
      categories: createExpenseCategoryRepository(harness.db),
      transactions: createExpenseTransactionRepository(harness.db),
      budgets: createExpenseBudgetRepository(harness.db),
      notify: { emit } satisfies NotificationCenter,
      now: () => now,
    }),
  };
}

/** A user with one budgeted category, one September row and one October row. */
async function setupLedger(suffix: string) {
  const user = await harness.seedUser({
    email: `month-${suffix}@bt.test`,
    username: `month-${suffix}`,
  });
  const categories = createExpenseCategoryRepository(harness.db);
  const transactions = createExpenseTransactionRepository(harness.db);
  const budgets = createExpenseBudgetRepository(harness.db);
  const category = await categories.create(user.id, {
    name: 'Household',
    direction: 'expense',
    color: '#123456',
  });
  const budget = await budgets.create(user.id, {
    categoryId: category.id,
    amount: 100,
    currency: 'EUR',
  });
  for (const [bookedOn, amount] of [
    ['2025-09-28', 40],
    ['2025-10-01', 30],
  ] as const) {
    await transactions.create(user.id, {
      categoryId: category.id,
      direction: 'expense',
      amount,
      currency: 'EUR',
      bookedOn,
      description: `booked ${bookedOn}`,
      source: 'manual',
    });
  }
  return { user, category, budget };
}

describe('expense aggregates — the month is the ledger clock, not UTC', () => {
  it('defaults the monthly summary to the Vienna month and counts that day’s row', async () => {
    const { user, category } = await setupLedger('summary');
    const { service } = serviceAt(GAP);

    const summary = await service.monthlySummary(user.id);

    expect(summary.month).toBe('2025-10');
    // The row booked 2025-10-01 is on the ledger at this instant, so the
    // default-month summary has to see it — and only it.
    expect(summary.totalExpense).toBe(30);
    expect(summary.categories).toEqual([
      {
        categoryId: category.id,
        name: 'Household',
        color: '#123456',
        expense: 30,
        income: 0,
      },
    ]);
  });

  it('still answers September twelve hours earlier, where the clocks agree', async () => {
    const { user } = await setupLedger('control');
    const { service } = serviceAt(MIDDAY);

    const summary = await service.monthlySummary(user.id);

    expect(summary.month).toBe('2025-09');
    expect(summary.totalExpense).toBe(40);
  });

  it('an explicit month is untouched by the clock', async () => {
    const { user } = await setupLedger('explicit');
    const { service } = serviceAt(GAP);

    const september = await service.monthlySummary(user.id, '2025-09');

    expect(september.month).toBe('2025-09');
    expect(september.totalExpense).toBe(40);
  });

  it('ends the trend series at the Vienna month', async () => {
    const { user } = await setupLedger('trends');
    const { service } = serviceAt(GAP);

    const trends = await service.trends(user.id, 2);

    expect(trends.points).toEqual([
      { month: '2025-09', expense: 40, income: 0 },
      { month: '2025-10', expense: 30, income: 0 },
    ]);
  });

  it('lists budget progress for the Vienna period', async () => {
    const { user, category, budget } = await setupLedger('budgets');
    const { service } = serviceAt(GAP);

    const listed = await service.listBudgets(user.id);

    expect(listed.period).toBe('2025-10');
    expect(listed.budgets).toHaveLength(1);
    expect(listed.budgets[0]).toMatchObject({
      id: budget.id,
      categoryId: category.id,
      period: '2025-10',
      spent: 30,
      remaining: 70,
      exceeded: false,
    });
  });

  it('treats the just-ended September as closed, so the restore fence claims it', async () => {
    const { user, budget } = await setupLedger('fence');
    const { service, emit } = serviceAt(GAP);

    const aggregates = await service.reconcileRestore(user.id, ['2025-09', '2025-10']);

    expect(aggregates.map(({ period, closed }) => ({ period, closed }))).toEqual([
      { period: '2025-09', closed: true },
      { period: '2025-10', closed: false },
    ]);
    expect(aggregates[0]!.budgets).toEqual([
      {
        budgetId: budget.id,
        categoryId: budget.categoryId,
        amount: 100,
        spent: 40,
        exceeded: false,
      },
    ]);
    // The closed period is claimed (no later replay); the current one is not, so
    // a genuine breach in October can still alert exactly once.
    const claimed = await harness.db
      .select({ periodKey: expenseBudgetFires.periodKey })
      .from(expenseBudgetFires)
      .where(eq(expenseBudgetFires.budgetId, budget.id));
    expect(claimed.map((row) => row.periodKey)).toEqual(['2025-09']);
    expect(emit).not.toHaveBeenCalled();
  });

  it('evaluates the breach against the Vienna month', async () => {
    const { user, category, budget } = await setupLedger('evaluate');
    const transactions = createExpenseTransactionRepository(harness.db);
    // Blows the 100 budget in OCTOBER only (September stands at 40).
    await transactions.create(user.id, {
      categoryId: category.id,
      direction: 'expense',
      amount: 120,
      currency: 'EUR',
      bookedOn: '2025-10-01',
      description: 'october splurge',
      source: 'manual',
    });
    const { service, emit } = serviceAt(GAP);

    await service.evaluate(user.id);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      type: 'budget.exceeded',
      userId: user.id,
      budgetId: budget.id,
      period: '2025-10',
      spent: 150,
    });
    const claimed = await harness.db
      .select({ periodKey: expenseBudgetFires.periodKey })
      .from(expenseBudgetFires)
      .where(
        and(
          eq(expenseBudgetFires.budgetId, budget.id),
          eq(expenseBudgetFires.periodKey, '2025-10'),
        ),
      );
    expect(claimed).toHaveLength(1);
  });
});
