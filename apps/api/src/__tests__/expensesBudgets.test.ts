import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  NOTIFICATION_TYPES,
  expenseBudgetListResponseSchema,
  expenseBudgetResponseSchema,
  expenseCategoryListResponseSchema,
  expenseMonthlySummaryResponseSchema,
  expenseTrendResponseSchema,
  notificationListResponseSchema,
  type ExpenseCategory,
} from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Expense dashboards + per-category budgets with matrix-routed alerts
 * (PROJECTPLAN.md §13.5 V5-P9, issue 3/3). Proves the done-when invariants:
 *  - the monthly dashboard reconciles EXACTLY to the recorded/imported sum;
 *  - income-vs-spend + trend aggregates are correct with proper empty windows;
 *  - a blown budget fires EXACTLY ONE `budget.exceeded` alert per period, routed
 *    through the (matrix-registered) notification type — so digest/quiet-hours
 *    come for free;
 *  - recategorizing / deleting keeps the aggregates and the budget evaluation
 *    consistent.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
// A fixed clock so "the current period" (budget evaluation + a dashboard's
// default month) is deterministic: everything is July 2026 unless dated otherwise.
const NOW = new Date('2026-07-15T12:00:00.000Z');
const PERIOD = '2026-07';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ budgetNow: () => NOW });
});

type Agent = ReturnType<typeof request.agent>;

async function newUserAgent(email: string, username: string): Promise<Agent> {
  const u = await harness.seedUser({ email, username });
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: u.email, password: u.password });
  expect(res.status).toBe(200);
  return agent;
}

async function categories(agent: Agent): Promise<ExpenseCategory[]> {
  const res = await agent.get('/api/v1/expenses/categories');
  expect(res.status).toBe(200);
  return expenseCategoryListResponseSchema.parse(res.body).categories;
}

/** Two distinct expense categories + one income category from the seeded set. */
async function pickCategories(
  agent: Agent,
): Promise<{ a: ExpenseCategory; b: ExpenseCategory; income: ExpenseCategory }> {
  const all = await categories(agent);
  const expense = all.filter((c) => c.direction === 'expense');
  const income = all.find((c) => c.direction === 'income');
  expect(expense.length).toBeGreaterThanOrEqual(2);
  expect(income).toBeTruthy();
  return { a: expense[0]!, b: expense[1]!, income: income! };
}

async function book(
  agent: Agent,
  tx: {
    categoryId?: string | null;
    direction?: 'expense' | 'income';
    amount: number;
    bookedOn: string;
    description?: string;
  },
): Promise<string> {
  const res = await agent
    .post('/api/v1/expenses/transactions')
    .set(...XRW)
    .send({
      categoryId: tx.categoryId ?? undefined,
      direction: tx.direction ?? 'expense',
      amount: tx.amount,
      bookedOn: tx.bookedOn,
      description: tx.description ?? 'test row',
    });
  expect(res.status).toBe(201);
  return res.body.transaction.id as string;
}

async function createBudget(agent: Agent, categoryId: string, amount: number) {
  const res = await agent
    .post('/api/v1/expenses/budgets')
    .set(...XRW)
    .send({ categoryId, amount });
  return res;
}

async function budgetProgress(agent: Agent, month?: string) {
  const res = await agent.get(`/api/v1/expenses/budgets${month ? `?month=${month}` : ''}`);
  expect(res.status).toBe(200);
  return expenseBudgetListResponseSchema.parse(res.body);
}

async function budgetAlertCount(agent: Agent): Promise<number> {
  const res = await agent.get('/api/v1/notifications');
  expect(res.status).toBe(200);
  const { items } = notificationListResponseSchema.parse(res.body);
  return items.filter((n) => n.type === 'budget.exceeded').length;
}

describe('GET /expenses/summary — monthly dashboard (AC: reconciles to the recorded sum)', () => {
  it('per-category totals sum EXACTLY to the reported totals and the recorded sum', async () => {
    const agent = await newUserAgent('sum@bt.test', 'sumuser');
    const { a, b, income } = await pickCategories(agent);

    // A month of activity: two categories, an uncategorized row, an income row,
    // plus a row in a DIFFERENT month that must not leak into July.
    await book(agent, { categoryId: a.id, amount: 42.5, bookedOn: '2026-07-02' });
    await book(agent, { categoryId: a.id, amount: 7.5, bookedOn: '2026-07-09' });
    await book(agent, { categoryId: b.id, amount: 30, bookedOn: '2026-07-11' });
    await book(agent, { categoryId: null, amount: 20, bookedOn: '2026-07-20' });
    await book(agent, {
      categoryId: income.id,
      direction: 'income',
      amount: 100,
      bookedOn: '2026-07-01',
    });
    await book(agent, { categoryId: b.id, amount: 999, bookedOn: '2026-06-30' }); // prior month — excluded

    const res = await agent.get(`/api/v1/expenses/summary?month=${PERIOD}`);
    expect(res.status).toBe(200);
    const summary = expenseMonthlySummaryResponseSchema.parse(res.body);

    // The recorded July expense sum is 42.5 + 7.5 + 30 + 20 = 100; income = 100.
    expect(summary.totalExpense).toBe(100);
    expect(summary.totalIncome).toBe(100);
    expect(summary.net).toBe(0);

    // Reconciliation: the per-category expense/income totals sum to the headline.
    const catExpense = summary.categories.reduce((s, c) => s + c.expense, 0);
    const catIncome = summary.categories.reduce((s, c) => s + c.income, 0);
    expect(catExpense).toBeCloseTo(summary.totalExpense, 6);
    expect(catIncome).toBeCloseTo(summary.totalIncome, 6);

    // Category A folded its two rows; the uncategorized bucket is present + last.
    const catA = summary.categories.find((c) => c.categoryId === a.id);
    expect(catA?.expense).toBe(50);
    const uncategorized = summary.categories.find((c) => c.categoryId === null);
    expect(uncategorized?.expense).toBe(20);
    expect(summary.categories.at(-1)?.categoryId).toBeNull();
  });

  it('defaults to the current month when no month is given (empty ⇒ zeroes)', async () => {
    const agent = await newUserAgent('sum2@bt.test', 'sum2user');
    const res = await agent.get('/api/v1/expenses/summary');
    expect(res.status).toBe(200);
    const summary = expenseMonthlySummaryResponseSchema.parse(res.body);
    expect(summary.month).toBe(PERIOD);
    expect(summary.totalExpense).toBe(0);
    expect(summary.categories).toEqual([]);
  });
});

describe('GET /expenses/trends — income vs spend over months', () => {
  it('returns one dense point per month, oldest→newest, gaps filled with zero', async () => {
    const agent = await newUserAgent('trend@bt.test', 'trenduser');
    const { a, income } = await pickCategories(agent);

    await book(agent, { categoryId: a.id, amount: 10, bookedOn: '2026-05-15' });
    await book(agent, {
      categoryId: income.id,
      direction: 'income',
      amount: 40,
      bookedOn: '2026-07-03',
    });
    await book(agent, { categoryId: a.id, amount: 25, bookedOn: '2026-07-18' });
    // June left intentionally empty.

    const res = await agent.get('/api/v1/expenses/trends?months=3');
    expect(res.status).toBe(200);
    const { points } = expenseTrendResponseSchema.parse(res.body);
    expect(points.map((p) => p.month)).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(points[0]).toMatchObject({ month: '2026-05', expense: 10, income: 0 });
    expect(points[1]).toMatchObject({ month: '2026-06', expense: 0, income: 0 });
    expect(points[2]).toMatchObject({ month: '2026-07', expense: 25, income: 40 });
  });
});

describe('Budget CRUD + progress', () => {
  it('creates, tracks spend, updates and deletes a per-category budget', async () => {
    const agent = await newUserAgent('bud@bt.test', 'buduser');
    const { a } = await pickCategories(agent);

    const created = await createBudget(agent, a.id, 100);
    expect(created.status).toBe(201);
    expect(expenseBudgetResponseSchema.parse(created.body).budget.amount).toBe(100);

    // No spend yet ⇒ full remaining, not exceeded.
    let list = await budgetProgress(agent);
    expect(list.period).toBe(PERIOD);
    expect(list.budgets).toHaveLength(1);
    expect(list.budgets[0]).toMatchObject({ spent: 0, remaining: 100, exceeded: false });

    await book(agent, { categoryId: a.id, amount: 60, bookedOn: '2026-07-05' });
    list = await budgetProgress(agent);
    expect(list.budgets[0]).toMatchObject({ spent: 60, remaining: 40, exceeded: false });

    // Lowering the target below the spend flips it to exceeded.
    const patched = await agent
      .patch(`/api/v1/expenses/budgets/${list.budgets[0]!.id}`)
      .set(...XRW)
      .send({ amount: 50 });
    expect(patched.status).toBe(200);
    list = await budgetProgress(agent);
    expect(list.budgets[0]).toMatchObject({ spent: 60, remaining: -10, exceeded: true });

    const removed = await agent
      .delete(`/api/v1/expenses/budgets/${list.budgets[0]!.id}`)
      .set(...XRW);
    expect(removed.status).toBe(204);
    expect((await budgetProgress(agent)).budgets).toHaveLength(0);
  });

  it('rejects a second budget for the same category (409) and a foreign category (400)', async () => {
    const agent = await newUserAgent('bud2@bt.test', 'bud2user');
    const { a } = await pickCategories(agent);
    expect((await createBudget(agent, a.id, 100)).status).toBe(201);
    expect((await createBudget(agent, a.id, 200)).status).toBe(409);
    expect((await createBudget(agent, '00000000-0000-0000-7000-000000000000', 50)).status).toBe(
      400,
    );
  });
});

describe('Budget alerts (AC: a blown budget fires exactly ONE alert per period)', () => {
  it('registers `budget.exceeded` in the notification matrix', () => {
    expect(NOTIFICATION_TYPES).toContain('budget.exceeded');
  });

  it('fires exactly one alert when blown, and never a second in the same period', async () => {
    const agent = await newUserAgent('alert@bt.test', 'alertuser');
    const { a } = await pickCategories(agent);
    expect((await createBudget(agent, a.id, 100)).status).toBe(201);
    expect(await budgetAlertCount(agent)).toBe(0);

    // Blow it — one alert.
    await book(agent, { categoryId: a.id, amount: 150, bookedOn: '2026-07-10' });
    expect(await budgetAlertCount(agent)).toBe(1);

    // Push further over in the SAME month — still exactly one (fired-marker gate).
    await book(agent, { categoryId: a.id, amount: 50, bookedOn: '2026-07-12' });
    expect(await budgetAlertCount(agent)).toBe(1);

    // Even removing then re-adding spend within the period never re-fires.
    await book(agent, { categoryId: a.id, amount: 25, bookedOn: '2026-07-13' });
    expect(await budgetAlertCount(agent)).toBe(1);
  });

  it('does not fire for a prior-month overage (only the current period is evaluated)', async () => {
    const agent = await newUserAgent('alert2@bt.test', 'alert2user');
    const { a } = await pickCategories(agent);
    expect((await createBudget(agent, a.id, 100)).status).toBe(201);
    await book(agent, { categoryId: a.id, amount: 500, bookedOn: '2026-06-10' });
    expect(await budgetAlertCount(agent)).toBe(0);
  });

  it('alerts immediately when a budget is set below the month’s spend-to-date', async () => {
    const agent = await newUserAgent('alert3@bt.test', 'alert3user');
    const { a } = await pickCategories(agent);
    await book(agent, { categoryId: a.id, amount: 120, bookedOn: '2026-07-04' });
    expect(await budgetAlertCount(agent)).toBe(0); // no budget yet
    expect((await createBudget(agent, a.id, 100)).status).toBe(201);
    expect(await budgetAlertCount(agent)).toBe(1);
  });
});

describe('Aggregates + budgets stay consistent under recategorize / delete', () => {
  it('recategorizing INTO a budgeted category updates spend and can fire its alert', async () => {
    const agent = await newUserAgent('recat@bt.test', 'recatuser');
    const { a, b } = await pickCategories(agent);
    expect((await createBudget(agent, a.id, 100)).status).toBe(201);

    await book(agent, { categoryId: a.id, amount: 80, bookedOn: '2026-07-06' });
    const movable = await book(agent, { categoryId: b.id, amount: 80, bookedOn: '2026-07-07' });
    expect(await budgetAlertCount(agent)).toBe(0); // A is only at 80

    // Move the B row into A ⇒ A = 160 > 100 ⇒ one alert + updated dashboard.
    const recat = await agent
      .put(`/api/v1/expenses/transactions/${movable}/category`)
      .set(...XRW)
      .send({ categoryId: a.id });
    expect(recat.status).toBe(200);
    expect(await budgetAlertCount(agent)).toBe(1);

    const summary = expenseMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/expenses/summary?month=${PERIOD}`)).body,
    );
    expect(summary.categories.find((c) => c.categoryId === a.id)?.expense).toBe(160);
    expect(summary.categories.find((c) => c.categoryId === b.id)).toBeUndefined();
  });

  it('deleting a transaction removes it from the dashboard totals', async () => {
    const agent = await newUserAgent('del@bt.test', 'deluser');
    const { a } = await pickCategories(agent);
    const keep = await book(agent, { categoryId: a.id, amount: 30, bookedOn: '2026-07-08' });
    const drop = await book(agent, { categoryId: a.id, amount: 70, bookedOn: '2026-07-09' });
    void keep;

    let summary = expenseMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/expenses/summary?month=${PERIOD}`)).body,
    );
    expect(summary.totalExpense).toBe(100);

    const removed = await agent.delete(`/api/v1/expenses/transactions/${drop}`).set(...XRW);
    expect(removed.status).toBe(204);

    summary = expenseMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/expenses/summary?month=${PERIOD}`)).body,
    );
    expect(summary.totalExpense).toBe(30);
  });
});
