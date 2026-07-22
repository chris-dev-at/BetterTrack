import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  expenseCategoryListResponseSchema,
  expenseCategoryResponseSchema,
  expenseRuleListResponseSchema,
  expenseRuleResponseSchema,
  expenseTransactionListResponseSchema,
  expenseTransactionResponseSchema,
} from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';
import { DEFAULT_EXPENSE_CATEGORIES } from '../services/expenses/expenseService';

/**
 * Expense tracking — foundation CRUD (PROJECTPLAN.md §13.5 V5-P9, issue 1/3).
 * Proves: default-category seeding on first read (idempotent), category /
 * transaction / rule CRUD, per-transaction recategorize (set + clear),
 * owner-scoping (a foreign row is a uniform 404, no IDOR), foreign-category
 * reference rejection (400), and unique category-name handling (409).
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-7000-000000000000';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function newUserAgent(email: string, username: string): Promise<Agent> {
  const u = await harness.seedUser({ email, username });
  return loginAgent(harness.app, u.email, u.password);
}

async function firstCategoryId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/expenses/categories');
  expect(res.status).toBe(200);
  const { categories } = expenseCategoryListResponseSchema.parse(res.body);
  const id = categories[0]?.id;
  expect(id).toBeTruthy();
  return id!;
}

describe('GET /expenses/categories — default seeding (AC: sensible defaults)', () => {
  it('seeds the starter set on the first read, once (idempotent)', async () => {
    const agent = await newUserAgent('cat@bt.test', 'catuser');

    const first = await agent.get('/api/v1/expenses/categories');
    expect(first.status).toBe(200);
    const a = expenseCategoryListResponseSchema.parse(first.body);
    expect(a.categories).toHaveLength(DEFAULT_EXPENSE_CATEGORIES.length);
    expect(a.categories.map((c) => c.name)).toContain('Groceries');
    expect(a.categories.some((c) => c.direction === 'income' && c.name === 'Salary')).toBe(true);

    // A second read does NOT re-seed / duplicate.
    const second = await agent.get('/api/v1/expenses/categories');
    const b = expenseCategoryListResponseSchema.parse(second.body);
    expect(b.categories).toHaveLength(DEFAULT_EXPENSE_CATEGORIES.length);
  });
});

describe('Category CRUD', () => {
  it('creates, updates and deletes a category', async () => {
    const agent = await newUserAgent('c2@bt.test', 'c2');

    const created = await agent
      .post('/api/v1/expenses/categories')
      .set(...XRW)
      .send({ name: 'Pets', direction: 'expense', color: '#123456' });
    expect(created.status).toBe(201);
    const { category } = expenseCategoryResponseSchema.parse(created.body);
    expect(category.name).toBe('Pets');
    expect(category.color).toBe('#123456');

    const updated = await agent
      .patch(`/api/v1/expenses/categories/${category.id}`)
      .set(...XRW)
      .send({ name: 'Pet care', direction: 'expense' });
    expect(updated.status).toBe(200);
    expect(expenseCategoryResponseSchema.parse(updated.body).category.name).toBe('Pet care');

    const del = await agent
      .delete(`/api/v1/expenses/categories/${category.id}`)
      .set(...XRW)
      .send();
    expect(del.status).toBe(204);
  });

  it('rejects a duplicate category name with 409', async () => {
    const agent = await newUserAgent('c3@bt.test', 'c3');
    await agent
      .post('/api/v1/expenses/categories')
      .set(...XRW)
      .send({ name: 'Hobbies' });
    const dup = await agent
      .post('/api/v1/expenses/categories')
      .set(...XRW)
      .send({ name: 'Hobbies' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EXPENSE_CATEGORY_NAME_TAKEN');
  });

  it('404s on a foreign category (no IDOR)', async () => {
    const owner = await newUserAgent('own@bt.test', 'own');
    const created = await owner
      .post('/api/v1/expenses/categories')
      .set(...XRW)
      .send({ name: 'Private' });
    const { category } = expenseCategoryResponseSchema.parse(created.body);

    const other = await newUserAgent('oth@bt.test', 'oth');
    const patch = await other
      .patch(`/api/v1/expenses/categories/${category.id}`)
      .set(...XRW)
      .send({ name: 'Hijack' });
    expect(patch.status).toBe(404);
    const del = await other
      .delete(`/api/v1/expenses/categories/${category.id}`)
      .set(...XRW)
      .send();
    expect(del.status).toBe(404);
  });
});

describe('Transaction CRUD + recategorize', () => {
  it('records a transaction under a category and returns it', async () => {
    const agent = await newUserAgent('t1@bt.test', 't1');
    const categoryId = await firstCategoryId(agent);

    const created = await agent
      .post('/api/v1/expenses/transactions')
      .set(...XRW)
      .send({
        categoryId,
        direction: 'expense',
        amount: 42.99,
        bookedOn: '2026-07-01',
        description: 'BILLA groceries',
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { transaction } = expenseTransactionResponseSchema.parse(created.body);
    expect(transaction.amount).toBe(42.99);
    expect(transaction.categoryId).toBe(categoryId);
    expect(transaction.source).toBe('manual');
    expect(transaction.currency).toBe('EUR');
  });

  it('records an uncategorized transaction, lists newest-first, and filters', async () => {
    const agent = await newUserAgent('t2@bt.test', 't2');
    const categoryId = await firstCategoryId(agent);

    await agent
      .post('/api/v1/expenses/transactions')
      .set(...XRW)
      .send({ amount: 10, bookedOn: '2026-06-01', description: 'Older' });
    await agent
      .post('/api/v1/expenses/transactions')
      .set(...XRW)
      .send({ categoryId, amount: 20, bookedOn: '2026-06-15', description: 'Newer' });

    const list = await agent.get('/api/v1/expenses/transactions');
    expect(list.status).toBe(200);
    const { transactions } = expenseTransactionListResponseSchema.parse(list.body);
    expect(transactions).toHaveLength(2);
    expect(transactions[0]!.description).toBe('Newer'); // newest booked-on first
    expect(transactions[1]!.categoryId).toBeNull();

    const filtered = await agent.get(`/api/v1/expenses/transactions?categoryId=${categoryId}`);
    const only = expenseTransactionListResponseSchema.parse(filtered.body);
    expect(only.transactions).toHaveLength(1);
    expect(only.transactions[0]!.description).toBe('Newer');
  });

  it('recategorizes a transaction and clears it back to uncategorized', async () => {
    const agent = await newUserAgent('t3@bt.test', 't3');
    const cats = await agent.get('/api/v1/expenses/categories');
    const { categories } = expenseCategoryListResponseSchema.parse(cats.body);
    const [a, b] = categories;

    const created = await agent
      .post('/api/v1/expenses/transactions')
      .set(...XRW)
      .send({ categoryId: a!.id, amount: 5, bookedOn: '2026-07-10', description: 'Move me' });
    const { transaction } = expenseTransactionResponseSchema.parse(created.body);

    const moved = await agent
      .put(`/api/v1/expenses/transactions/${transaction.id}/category`)
      .set(...XRW)
      .send({ categoryId: b!.id });
    expect(moved.status).toBe(200);
    expect(expenseTransactionResponseSchema.parse(moved.body).transaction.categoryId).toBe(b!.id);

    const cleared = await agent
      .put(`/api/v1/expenses/transactions/${transaction.id}/category`)
      .set(...XRW)
      .send({ categoryId: null });
    expect(cleared.status).toBe(200);
    expect(expenseTransactionResponseSchema.parse(cleared.body).transaction.categoryId).toBeNull();
  });

  it('rejects a non-positive amount (400) and a foreign category reference (400)', async () => {
    const owner = await newUserAgent('t4@bt.test', 't4');
    const created = await owner
      .post('/api/v1/expenses/categories')
      .set(...XRW)
      .send({ name: 'Owned' });
    const foreignCategoryId = expenseCategoryResponseSchema.parse(created.body).category.id;

    const other = await newUserAgent('t5@bt.test', 't5');
    const badAmount = await other
      .post('/api/v1/expenses/transactions')
      .set(...XRW)
      .send({ amount: 0, bookedOn: '2026-07-01', description: 'Zero' });
    expect(badAmount.status).toBe(400);

    const foreignRef = await other
      .post('/api/v1/expenses/transactions')
      .set(...XRW)
      .send({ categoryId: foreignCategoryId, amount: 5, bookedOn: '2026-07-01', description: 'X' });
    expect(foreignRef.status).toBe(400);
    expect(foreignRef.body.error.code).toBe('EXPENSE_CATEGORY_REF_NOT_FOUND');
  });

  it('404s a foreign / missing transaction on delete', async () => {
    const agent = await newUserAgent('t6@bt.test', 't6');
    const del = await agent
      .delete(`/api/v1/expenses/transactions/${MISSING_ID}`)
      .set(...XRW)
      .send();
    expect(del.status).toBe(404);
  });
});

describe('Rule CRUD (shapes only; evaluation is issue 2/3)', () => {
  it('creates rules, lists them in priority order, and edits one', async () => {
    const agent = await newUserAgent('r1@bt.test', 'r1');
    const categoryId = await firstCategoryId(agent);

    await agent
      .post('/api/v1/expenses/rules')
      .set(...XRW)
      .send({ categoryId, matchType: 'contains', pattern: 'SPAR', priority: 5 });
    await agent
      .post('/api/v1/expenses/rules')
      .set(...XRW)
      .send({ categoryId, matchType: 'starts_with', pattern: 'ÖBB', priority: 1 });

    const list = await agent.get('/api/v1/expenses/rules');
    expect(list.status).toBe(200);
    const { rules } = expenseRuleListResponseSchema.parse(list.body);
    expect(rules.map((r) => r.pattern)).toEqual(['ÖBB', 'SPAR']); // ascending priority

    const edited = await agent
      .patch(`/api/v1/expenses/rules/${rules[0]!.id}`)
      .set(...XRW)
      .send({ enabled: false });
    expect(edited.status).toBe(200);
    expect(expenseRuleResponseSchema.parse(edited.body).rule.enabled).toBe(false);
  });

  it('rejects a rule that targets a foreign category (400)', async () => {
    const owner = await newUserAgent('r2@bt.test', 'r2');
    const created = await owner
      .post('/api/v1/expenses/categories')
      .set(...XRW)
      .send({ name: 'Theirs' });
    const foreignCategoryId = expenseCategoryResponseSchema.parse(created.body).category.id;

    const other = await newUserAgent('r3@bt.test', 'r3');
    const res = await other
      .post('/api/v1/expenses/rules')
      .set(...XRW)
      .send({ categoryId: foreignCategoryId, pattern: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EXPENSE_CATEGORY_REF_NOT_FOUND');
  });
});
