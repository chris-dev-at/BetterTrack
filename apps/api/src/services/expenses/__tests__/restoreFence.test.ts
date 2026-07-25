import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../data/db';
import {
  createExpenseBudgetRepository,
  createExpenseCategoryRepository,
  createExpenseRuleRepository,
  createExpenseTransactionRepository,
  type CreateExpenseTransactionInput,
} from '../../../data/repositories/expenseRepository';
import { expenseBudgetFires } from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import type { NotificationCenter } from '../../notifications/notificationCenter';
import { createExpenseBudgetService, type ExpenseBudgetRestoreAggregate } from '../budgetService';
import { createExpenseService } from '../expenseService';

const NOW = new Date('2026-07-15T12:00:00.000Z');

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

function notificationRecorder() {
  const emit = vi.fn<NotificationCenter['emit']>().mockResolvedValue(true);
  return { emit, center: { emit } satisfies NotificationCenter };
}

async function setupAccount(suffix: string) {
  const user = await harness.seedUser({
    email: `restore-${suffix}@bt.test`,
    username: `restore-${suffix}`,
  });
  const categories = createExpenseCategoryRepository(harness.db);
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
  return { user, category, budget };
}

function row(categoryId: string, bookedOn: string, amount: number): CreateExpenseTransactionInput {
  return {
    categoryId,
    direction: 'expense',
    amount,
    currency: 'EUR',
    bookedOn,
    description: `restored ${bookedOn}`,
    source: 'manual',
  };
}

describe('expense bulk-restore budget fence', () => {
  it('reconciles closed and current periods without replay, then permits one later breach', async () => {
    const restored = await setupAccount('restored');
    const normal = await setupAccount('normal');
    const restoredNotifications = notificationRecorder();
    const normalNotifications = notificationRecorder();
    const restoredRows = [
      row(restored.category.id, '2026-04-03', 70),
      row(restored.category.id, '2026-04-20', 50),
      row(restored.category.id, '2026-06-10', 80),
      row(restored.category.id, '2026-07-05', 60),
    ];
    const normalRows = restoredRows.map((entry) => ({ ...entry, categoryId: normal.category.id }));
    let restoredAggregates: ExpenseBudgetRestoreAggregate[] = [];

    await harness.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const categories = createExpenseCategoryRepository(tx);
      const transactions = createExpenseTransactionRepository(tx);
      const budgets = createExpenseBudgetRepository(tx);
      const budgetService = createExpenseBudgetService({
        categories,
        transactions,
        budgets,
        notify: restoredNotifications.center,
        now: () => NOW,
      });
      const expenseService = createExpenseService({
        categories,
        transactions,
        rules: createExpenseRuleRepository(tx),
      });

      await expenseService.restoreTransactions(restored.user.id, restoredRows, {
        ownsCategory: (userId, categoryId) => categories.ownsCategory(userId, categoryId),
        async insertTransactions(userId, rows) {
          for (const input of rows) await transactions.create(userId, input);
        },
        async reconcileBudgets(userId, periods) {
          restoredAggregates = await budgetService.reconcileRestore(userId, periods);
        },
      });
    });

    expect(restoredNotifications.emit).not.toHaveBeenCalled();
    expect(restoredAggregates).toEqual([
      {
        period: '2026-04',
        closed: true,
        budgets: [
          {
            budgetId: restored.budget.id,
            categoryId: restored.category.id,
            amount: 100,
            spent: 120,
            exceeded: true,
          },
        ],
      },
      {
        period: '2026-06',
        closed: true,
        budgets: [
          {
            budgetId: restored.budget.id,
            categoryId: restored.category.id,
            amount: 100,
            spent: 80,
            exceeded: false,
          },
        ],
      },
      {
        period: '2026-07',
        closed: false,
        budgets: [
          {
            budgetId: restored.budget.id,
            categoryId: restored.category.id,
            amount: 100,
            spent: 60,
            exceeded: false,
          },
        ],
      },
    ]);

    const normalCategories = createExpenseCategoryRepository(harness.db);
    const normalTransactions = createExpenseTransactionRepository(harness.db);
    const normalBudgets = createExpenseBudgetRepository(harness.db);
    const normalBudgetService = createExpenseBudgetService({
      categories: normalCategories,
      transactions: normalTransactions,
      budgets: normalBudgets,
      notify: normalNotifications.center,
      now: () => NOW,
    });
    const normalExpenseService = createExpenseService({
      categories: normalCategories,
      transactions: normalTransactions,
      rules: createExpenseRuleRepository(harness.db),
      onTransactionWrite: (userId) => normalBudgetService.evaluate(userId),
    });
    for (const input of normalRows) {
      await normalExpenseService.createTransaction(normal.user.id, input);
    }

    for (const aggregate of restoredAggregates) {
      const normalProgress = await normalBudgetService.listBudgets(
        normal.user.id,
        aggregate.period,
      );
      expect(
        aggregate.budgets.map(({ amount, spent, exceeded }) => ({ amount, spent, exceeded })),
      ).toEqual(
        normalProgress.budgets.map(({ amount, spent, exceeded }) => ({
          amount,
          spent,
          exceeded,
        })),
      );
    }
    expect(normalNotifications.emit).not.toHaveBeenCalled();

    const restoredCategories = createExpenseCategoryRepository(harness.db);
    const restoredTransactions = createExpenseTransactionRepository(harness.db);
    const restoredBudgets = createExpenseBudgetRepository(harness.db);
    const restoredBudgetService = createExpenseBudgetService({
      categories: restoredCategories,
      transactions: restoredTransactions,
      budgets: restoredBudgets,
      notify: restoredNotifications.center,
      now: () => NOW,
    });
    const restoredExpenseService = createExpenseService({
      categories: restoredCategories,
      transactions: restoredTransactions,
      rules: createExpenseRuleRepository(harness.db),
      onTransactionWrite: (userId) => restoredBudgetService.evaluate(userId),
    });

    // The restore left July below target and unclaimed. This genuine later
    // crossing emits once; further writes in July cannot emit a second alert.
    await restoredExpenseService.createTransaction(
      restored.user.id,
      row(restored.category.id, '2026-07-18', 50),
    );
    await restoredExpenseService.createTransaction(
      restored.user.id,
      row(restored.category.id, '2026-07-19', 1),
    );

    expect(restoredNotifications.emit).toHaveBeenCalledTimes(1);
    expect(restoredNotifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'budget.exceeded',
        userId: restored.user.id,
        budgetId: restored.budget.id,
        period: '2026-07',
        spent: 110,
      }),
    );
  });

  it('uses the caller transaction so abort rolls back rows and no-replay markers', async () => {
    const restored = await setupAccount('rollback');
    const notifications = notificationRecorder();
    const restoredRows = [
      row(restored.category.id, '2026-05-03', 120),
      row(restored.category.id, '2026-07-05', 60),
    ];

    await expect(
      harness.db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const categories = createExpenseCategoryRepository(tx);
        const transactions = createExpenseTransactionRepository(tx);
        const budgetService = createExpenseBudgetService({
          categories,
          transactions,
          budgets: createExpenseBudgetRepository(tx),
          notify: notifications.center,
          now: () => NOW,
        });
        const expenseService = createExpenseService({
          categories,
          transactions,
          rules: createExpenseRuleRepository(tx),
        });

        await expenseService.restoreTransactions(restored.user.id, restoredRows, {
          ownsCategory: (userId, categoryId) => categories.ownsCategory(userId, categoryId),
          async insertTransactions(userId, rows) {
            for (const input of rows) await transactions.create(userId, input);
          },
          async reconcileBudgets(userId, periods) {
            await budgetService.reconcileRestore(userId, periods);
          },
        });
        throw new Error('abort caller transaction');
      }),
    ).rejects.toThrow('abort caller transaction');

    const transactions = createExpenseTransactionRepository(harness.db);
    expect(
      await transactions.listForOwner(restored.user.id, {
        limit: 100,
      }),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(expenseBudgetFires)
        .where(eq(expenseBudgetFires.budgetId, restored.budget.id)),
    ).toEqual([]);
    expect(notifications.emit).not.toHaveBeenCalled();
  });
});
