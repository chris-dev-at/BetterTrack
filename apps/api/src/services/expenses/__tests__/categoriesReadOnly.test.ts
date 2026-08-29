import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { expenseCategoryListResponseSchema } from '@bettertrack/contracts';

import { createCashFusionCatchUpRepository } from '../../../data/repositories/cashFusionCatchUpRepository';
import { createExpenseCategoryRepository } from '../../../data/repositories/expenseRepository';
import { expenseCategories } from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * `GET /api/v1/expenses/categories` is a PURE READ (#1550).
 *
 * The expense area's writes are retired behind a 410 gate that inspects the HTTP
 * verb only, so the gate is exact just as long as no read handler writes. One
 * did: listing categories seeded a 14-row starter set for any owner who had none
 * — i.e. every account registered after migration 0076, and every account whose
 * rows the cash-fusion catch-up already consumed. That is the divergence the
 * gate exists to close, and it has a live downstream consequence: those rows put
 * the account back into `cashFusionCatchUpRepository.listOwners()`, so a
 * catch-up re-run materialises starter `cash_tags` on `/api/v1/cash` that the
 * user never created.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function newUserAgent(
  email: string,
  username: string,
): Promise<{ agent: Agent; userId: string }> {
  const user = await harness.seedUser({ email, username });
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(res.status).toBe(200);
  return { agent, userId: user.id };
}

async function categoryRowCount(userId: string): Promise<number> {
  const rows = await harness.db
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(eq(expenseCategories.userId, userId));
  return rows.length;
}

async function listCategories(agent: Agent) {
  const res = await agent.get('/api/v1/expenses/categories');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return expenseCategoryListResponseSchema.parse(res.body).categories;
}

describe('GET /expenses/categories — a read handler behind the write-retirement gate', () => {
  it('answers an empty list for an owner with no categories, and writes nothing', async () => {
    const { agent, userId } = await newUserAgent('cats-empty@bt.test', 'catsempty');
    expect(await categoryRowCount(userId)).toBe(0);

    expect(await listCategories(agent)).toEqual([]);
    expect(await categoryRowCount(userId)).toBe(0);

    // Repeated reads stay writes-free too — this was never a "first call only"
    // problem once the rows were consumed by the catch-up.
    expect(await listCategories(agent)).toEqual([]);
    expect(await categoryRowCount(userId)).toBe(0);
  });

  it("returns an existing owner's categories unchanged — only the implicit creation is gone", async () => {
    const { agent, userId } = await newUserAgent('cats-kept@bt.test', 'catskept');
    const repo = createExpenseCategoryRepository(harness.db);
    const groceries = await repo.create(userId, {
      name: 'Groceries',
      direction: 'expense',
      color: '#22c55e',
    });
    const salary = await repo.create(userId, {
      name: 'Salary',
      direction: 'income',
      color: '#10b981',
    });

    const listed = await listCategories(agent);
    expect(listed.map((category) => category.id)).toEqual([groceries.id, salary.id]);
    expect(listed.map((category) => category.name)).toEqual(['Groceries', 'Salary']);
    // Nothing added alongside them.
    expect(await categoryRowCount(userId)).toBe(2);
  });

  it('leaves the account out of the cash-fusion catch-up owner set', async () => {
    const { agent, userId } = await newUserAgent('cats-fusion@bt.test', 'catsfusion');
    const catchUp = createCashFusionCatchUpRepository(harness.db);

    // The catch-up's other population is "an INCOMPLETE app-owned tag set", so
    // seed this account's system tags first — otherwise it would qualify for the
    // backfill regardless and the assertion would prove nothing.
    const tags = await agent.get('/api/v1/cash/tags');
    expect(tags.status).toBe(200);
    expect(await catchUp.listOwners()).not.toContain(userId);

    await listCategories(agent);

    // The read created no `expense_categories` row, so the catch-up still sees
    // no divergence to migrate for this owner — no phantom starter `cash_tags`.
    expect(await catchUp.listOwners()).not.toContain(userId);
  });
});
