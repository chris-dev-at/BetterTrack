import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CASH_SYSTEM_TAGS,
  cashBudgetListResponseSchema,
  cashBudgetRawListResponseSchema,
  cashBudgetResponseSchema,
  cashMonthlySummaryResponseSchema,
  cashMovementTagsResponseSchema,
  cashMovementsResponseSchema,
  cashRuleListResponseSchema,
  cashRuleResponseSchema,
  cashTagListResponseSchema,
  cashTagResponseSchema,
  cashTrendResponseSchema,
  notificationListResponseSchema,
  type CashMovement,
  type CashTag,
} from '@bettertrack/contracts';

import { cashBudgetFires } from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * V5 cash fusion, phase 2 — the `/api/v1/cash` surface.
 *
 * The load-bearing assertions here are the ones phase 1 could not express as a
 * foreign key: a `cash_movement_tags` row is only legal when the tag's owner and
 * the movement's `portfolio.user_id` are the SAME account, and BOTH sides have to
 * be scoped to the caller in the repository (§10) — never in a controller. Every
 * cross-account attempt below must answer not-found and leave NOTHING written.
 *
 * Also pinned: auto-tagging stamps the right app-owned tag when the engine books
 * a movement, a user's own tags survive it, budgets alert exactly once a month,
 * and `/api/v1/expenses` can no longer be written to.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
/** Fixed clock so "the current period" is deterministic. */
const NOW = new Date('2026-07-15T12:00:00.000Z');
const PERIOD = '2026-07';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ budgetNow: () => NOW });
});

type Agent = ReturnType<typeof request.agent>;

async function newUserAgent(email: string, username: string): Promise<Agent> {
  const user = await harness.seedUser({ email, username });
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(res.status).toBe(200);
  return agent;
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
  expect(def).toBeTruthy();
  return def.id as string;
}

async function listTags(agent: Agent): Promise<CashTag[]> {
  const res = await agent.get('/api/v1/cash/tags');
  expect(res.status).toBe(200);
  return cashTagListResponseSchema.parse(res.body).tags;
}

async function createTag(agent: Agent, name: string, color = '#112233'): Promise<CashTag> {
  const res = await agent
    .post('/api/v1/cash/tags')
    .set(...XRW)
    .send({ name, color });
  expect(res.status).toBe(201);
  return cashTagResponseSchema.parse(res.body).tag;
}

async function deposit(agent: Agent, portfolioId: string, amountEur: number, executedAt?: string) {
  const res = await agent
    .post(`/api/v1/portfolios/${portfolioId}/cash/deposit`)
    .set(...XRW)
    .send({ amountEur, ...(executedAt !== undefined ? { executedAt } : {}) });
  expect(res.status).toBe(201);
  return res.body.movement as CashMovement;
}

async function withdraw(agent: Agent, portfolioId: string, amountEur: number, executedAt?: string) {
  const res = await agent
    .post(`/api/v1/portfolios/${portfolioId}/cash/withdraw`)
    .set(...XRW)
    .send({ amountEur, ...(executedAt !== undefined ? { executedAt } : {}) });
  expect(res.status).toBe(201);
  return res.body.movement as CashMovement;
}

async function ledger(agent: Agent, portfolioId: string): Promise<CashMovement[]> {
  const res = await agent.get(`/api/v1/portfolios/${portfolioId}/cash`);
  expect(res.status).toBe(200);
  expect(cashMovementsResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body.movements as CashMovement[];
}

async function setTags(agent: Agent, movementId: string, tagIds: string[]) {
  return agent
    .put(`/api/v1/cash/movements/${movementId}/tags`)
    .set(...XRW)
    .send({ tagIds });
}

async function fee(agent: Agent, portfolioId: string, amountEur: number, executedAt?: string) {
  const res = await agent
    .post(`/api/v1/portfolios/${portfolioId}/cash/fee`)
    .set(...XRW)
    .send({ amountEur, ...(executedAt !== undefined ? { executedAt } : {}) });
  expect(res.status).toBe(201);
  return res.body.movement as CashMovement;
}

/** A second cash source, so the internal-transfer paths have two endpoints. */
async function createSource(agent: Agent, portfolioId: string, name: string): Promise<string> {
  const res = await agent
    .post(`/api/v1/portfolios/${portfolioId}/cash/sources`)
    .set(...XRW)
    .send({ name, type: 'bank' });
  expect(res.status).toBe(201);
  return res.body.source.id as string;
}

async function mainSourceId(agent: Agent, portfolioId: string): Promise<string> {
  const res = await agent.get(`/api/v1/portfolios/${portfolioId}/cash/sources`);
  expect(res.status).toBe(200);
  return res.body.sources[0].id as string;
}

async function createBudget(
  agent: Agent,
  portfolioId: string,
  tagId: string,
  amount: number,
): Promise<string> {
  const res = await agent
    .post('/api/v1/cash/budgets')
    .set(...XRW)
    .send({ portfolioId, tagId, amount });
  expect(res.status).toBe(201);
  return cashBudgetResponseSchema.parse(res.body).budget.id;
}

/** How many `budget.exceeded` alerts this account's inbox holds. */
async function budgetAlerts(agent: Agent): Promise<number> {
  const res = await agent.get('/api/v1/notifications?limit=100');
  expect(res.status).toBe(200);
  return notificationListResponseSchema
    .parse(res.body)
    .items.filter((n) => n.type === 'budget.exceeded').length;
}

/** The tag ids on one movement, straight off the ledger read. */
async function tagsOf(agent: Agent, portfolioId: string, movementId: string): Promise<string[]> {
  const movements = await ledger(agent, portfolioId);
  const movement = movements.find((m) => m.id === movementId);
  expect(movement).toBeTruthy();
  return [...(movement!.tags ?? [])].sort();
}

// ── Tags ─────────────────────────────────────────────────────────────────────

describe('cash tags', () => {
  it('seeds the app-owned set on first read and marks it as system', async () => {
    const agent = await newUserAgent('tags@bettertrack.test', 'tagsuser');
    const tags = await listTags(agent);
    const system = tags.filter((tag) => tag.system);
    expect(system).toHaveLength(CASH_SYSTEM_TAGS.length);
    expect(new Set(system.map((tag) => tag.systemKey))).toEqual(
      new Set(CASH_SYSTEM_TAGS.map((seed) => seed.key)),
    );
    // Idempotent: a second read does not seed a second set.
    expect((await listTags(agent)).filter((tag) => tag.system)).toHaveLength(
      CASH_SYSTEM_TAGS.length,
    );
  });

  it('creates, renames and re-tints a user tag', async () => {
    const agent = await newUserAgent('crud@bettertrack.test', 'cruduser');
    const tag = await createTag(agent, 'Food');
    expect(tag).toMatchObject({ name: 'Food', system: false, systemKey: null });

    const patched = await agent
      .patch(`/api/v1/cash/tags/${tag.id}`)
      .set(...XRW)
      .send({ name: 'Groceries', color: '#aabbcc' });
    expect(patched.status).toBe(200);
    expect(cashTagResponseSchema.parse(patched.body).tag).toMatchObject({
      name: 'Groceries',
      color: '#aabbcc',
    });

    const deleted = await agent.delete(`/api/v1/cash/tags/${tag.id}`).set(...XRW);
    expect(deleted.status).toBe(204);
    expect((await listTags(agent)).some((t) => t.id === tag.id)).toBe(false);
  });

  it('filters cash pages by one tag or by the untagged sentinel', async () => {
    const agent = await newUserAgent('filter@bettertrack.test', 'filteruser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');
    const tagged = await deposit(agent, portfolioId, 25, '2026-07-02T10:00:00.000Z');
    const untagged = await deposit(agent, portfolioId, 10, '2026-07-01T10:00:00.000Z');
    expect((await setTags(agent, tagged.id, [food.id])).status).toBe(200);
    // Deposits are auto-stamped with their system tag; remove it to exercise
    // the explicit untagged view.
    expect((await setTags(agent, untagged.id, [])).status).toBe(200);

    const foodPage = await agent.get(
      `/api/v1/portfolios/${portfolioId}/cash?tag=${food.id}&limit=1`,
    );
    expect(foodPage.status).toBe(200);
    expect(foodPage.body.movements.map((movement: CashMovement) => movement.id)).toEqual([
      tagged.id,
    ]);
    expect(foodPage.body.nextCursor).toBeNull();

    const untaggedPage = await agent.get(
      `/api/v1/portfolios/${portfolioId}/cash?tag=untagged&limit=1`,
    );
    expect(untaggedPage.status).toBe(200);
    expect(untaggedPage.body.movements.map((movement: CashMovement) => movement.id)).toEqual([
      untagged.id,
    ]);
    // Filtering is a view: both pages retain the full portfolio balance.
    expect(untaggedPage.body.balanceEur).toBe(35);
  });

  it('refuses a name that differs only in case', async () => {
    const agent = await newUserAgent('dupe@bettertrack.test', 'dupeuser');
    await createTag(agent, 'Food');
    const res = await agent
      .post('/api/v1/cash/tags')
      .set(...XRW)
      .send({ name: 'FOOD' });
    // Two tags a user cannot tell apart would silently split every budget
    // counting them.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CASH_TAG_NAME_TAKEN');
  });

  it('never deletes an app-owned tag, but does let it be renamed', async () => {
    const agent = await newUserAgent('sys@bettertrack.test', 'sysuser');
    const dividend = (await listTags(agent)).find((tag) => tag.systemKey === 'dividend')!;

    const deleted = await agent.delete(`/api/v1/cash/tags/${dividend.id}`).set(...XRW);
    expect(deleted.status).toBe(409);
    expect(deleted.body.error.code).toBe('CASH_TAG_SYSTEM_PROTECTED');

    // Renaming is fine — the engine resolves system tags by `systemKey`, never
    // by name, so a rename or a translation cannot break auto-tagging.
    const renamed = await agent
      .patch(`/api/v1/cash/tags/${dividend.id}`)
      .set(...XRW)
      .send({ name: 'Ausschüttungen' });
    expect(renamed.status).toBe(200);
    const after = cashTagResponseSchema.parse(renamed.body).tag;
    expect(after).toMatchObject({ name: 'Ausschüttungen', system: true, systemKey: 'dividend' });
  });
});

// ── Ownership scoping (§10) ──────────────────────────────────────────────────

describe('cash tags: ownership scoping', () => {
  it('hides another account s tag behind a not-found on every verb', async () => {
    const owner = await newUserAgent('owner@bettertrack.test', 'owneruser');
    const stranger = await newUserAgent('stranger@bettertrack.test', 'strangeruser');
    const tag = await createTag(owner, 'Private');

    const patched = await stranger
      .patch(`/api/v1/cash/tags/${tag.id}`)
      .set(...XRW)
      .send({ name: 'Stolen' });
    expect(patched.status).toBe(404);
    expect(patched.body.error.code).toBe('CASH_TAG_NOT_FOUND');

    const deleted = await stranger.delete(`/api/v1/cash/tags/${tag.id}`).set(...XRW);
    expect(deleted.status).toBe(404);
    // Same code an id that never existed produces — existence never leaks (§8).
    expect(deleted.body.error.code).toBe('CASH_TAG_NOT_FOUND');

    // And the tag is untouched.
    expect((await listTags(owner)).find((t) => t.id === tag.id)?.name).toBe('Private');
    expect((await listTags(stranger)).some((t) => t.id === tag.id)).toBe(false);
  });

  it('refuses to tag a movement in an account the caller does not own', async () => {
    const owner = await newUserAgent('mv-owner@bettertrack.test', 'mvowner');
    const stranger = await newUserAgent('mv-stranger@bettertrack.test', 'mvstranger');
    const ownerPortfolio = await defaultPortfolioId(owner);
    const movement = await deposit(owner, ownerPortfolio, 100);
    const strangerTag = await createTag(stranger, 'Reach');

    // The movement side of the invariant: the stranger owns the tag but not the
    // portfolio the movement sits in.
    const res = await setTags(stranger, movement.id, [strangerTag.id]);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CASH_MOVEMENT_NOT_FOUND');

    // NOTHING was written — not even a partial set.
    const after = await tagsOf(owner, ownerPortfolio, movement.id);
    expect(after).not.toContain(strangerTag.id);
  });

  it('refuses to attach another account s tag to the caller s own movement', async () => {
    const owner = await newUserAgent('tg-owner@bettertrack.test', 'tgowner');
    const stranger = await newUserAgent('tg-stranger@bettertrack.test', 'tgstranger');
    const portfolioId = await defaultPortfolioId(owner);
    const movement = await deposit(owner, portfolioId, 100);
    const ownTag = await createTag(owner, 'Mine');
    const foreignTag = await createTag(stranger, 'Theirs');

    // The TAG side of the invariant. Sent together with a legal id on purpose:
    // the whole request must fail rather than silently applying the legal half.
    const res = await setTags(owner, movement.id, [ownTag.id, foreignTag.id]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CASH_TAG_REF_NOT_FOUND');

    const after = await tagsOf(owner, portfolioId, movement.id);
    expect(after).not.toContain(foreignTag.id);
    expect(after).not.toContain(ownTag.id);
  });

  it('scopes budgets and rules to their owner', async () => {
    const owner = await newUserAgent('b-owner@bettertrack.test', 'bowner');
    const stranger = await newUserAgent('b-stranger@bettertrack.test', 'bstranger');
    const portfolioId = await defaultPortfolioId(owner);
    const tag = await createTag(owner, 'Rent');

    const created = await owner
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: tag.id, amount: 900 });
    expect(created.status).toBe(201);
    const budget = cashBudgetResponseSchema.parse(created.body).budget;

    // A budget in someone else's portfolio is not found, both to read and to write.
    const listed = await stranger.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`);
    expect(listed.status).toBe(404);
    expect(listed.body.error.code).toBe('PORTFOLIO_NOT_FOUND');

    const patched = await stranger
      .patch(`/api/v1/cash/budgets/${budget.id}`)
      .set(...XRW)
      .send({ amount: 1 });
    expect(patched.status).toBe(404);

    const removed = await stranger.delete(`/api/v1/cash/budgets/${budget.id}`).set(...XRW);
    expect(removed.status).toBe(404);

    // Still exactly as the owner left it.
    const still = await owner.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`);
    expect(cashBudgetListResponseSchema.parse(still.body).budgets[0]!.amount).toBe(900);
  });

  it('refuses to budget a tag the caller does not own', async () => {
    const owner = await newUserAgent('bt-owner@bettertrack.test', 'btowner');
    const stranger = await newUserAgent('bt-stranger@bettertrack.test', 'btstranger');
    const portfolioId = await defaultPortfolioId(owner);
    const foreignTag = await createTag(stranger, 'Foreign');

    const res = await owner
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: foreignTag.id, amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CASH_TAG_REF_NOT_FOUND');
  });

  it('refuses a rule that assigns another account s tag', async () => {
    const owner = await newUserAgent('r-owner@bettertrack.test', 'rowner');
    const stranger = await newUserAgent('r-stranger@bettertrack.test', 'rstranger');
    const foreignTag = await createTag(stranger, 'Foreign');

    const res = await owner
      .post('/api/v1/cash/rules')
      .set(...XRW)
      .send({ tagIds: [foreignTag.id], pattern: 'REWE' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CASH_TAG_REF_NOT_FOUND');
    expect(
      cashRuleListResponseSchema.parse((await owner.get('/api/v1/cash/rules')).body).rules,
    ).toHaveLength(0);
  });

  it('requires a session for every cash endpoint', async () => {
    const anon = request.agent(harness.app);
    for (const [method, path] of [
      ['get', '/api/v1/cash/tags'],
      ['get', '/api/v1/cash/rules'],
      ['get', '/api/v1/cash/budgets?portfolioId=00000000-0000-4000-8000-000000000000'],
    ] as const) {
      const res = await anon[method](path);
      expect(res.status).toBe(401);
    }
  });
});

// ── Movement tagging ─────────────────────────────────────────────────────────

describe('cash movement tagging', () => {
  it('replaces the whole set, carries many tags, and clears with an empty array', async () => {
    const agent = await newUserAgent('mt@bettertrack.test', 'mtuser');
    const portfolioId = await defaultPortfolioId(agent);
    await deposit(agent, portfolioId, 500);
    const movement = await withdraw(agent, portfolioId, 40);
    const food = await createTag(agent, 'Food');
    const groceries = await createTag(agent, 'Groceries');

    const both = await setTags(agent, movement.id, [food.id, groceries.id]);
    expect(both.status).toBe(200);
    const parsed = cashMovementTagsResponseSchema.parse(both.body);
    expect(parsed.movementId).toBe(movement.id);
    // A movement carries MANY tags — that is the whole point of the flat model.
    expect(parsed.tags.map((t) => t.id).sort()).toEqual([food.id, groceries.id].sort());

    // Replacement, not a merge.
    await setTags(agent, movement.id, [food.id]);
    expect(await tagsOf(agent, portfolioId, movement.id)).toContain(food.id);
    expect(await tagsOf(agent, portfolioId, movement.id)).not.toContain(groceries.id);

    // Empty clears — the "uncategorized" state a NULL category used to mean.
    const cleared = await setTags(agent, movement.id, []);
    expect(cleared.status).toBe(200);
    expect(cashMovementTagsResponseSchema.parse(cleared.body).tags).toHaveLength(0);
  });

  it('accepts a repeated id rather than rejecting it', async () => {
    const agent = await newUserAgent('rep@bettertrack.test', 'repuser');
    const portfolioId = await defaultPortfolioId(agent);
    await deposit(agent, portfolioId, 100);
    const movement = await withdraw(agent, portfolioId, 10);
    const tag = await createTag(agent, 'Twice');
    const res = await setTags(agent, movement.id, [tag.id, tag.id]);
    expect(res.status).toBe(200);
    // UNIQUE(movement, tag) makes the repeat a no-op; rejecting it would be
    // pedantry the client cannot act on.
    expect(cashMovementTagsResponseSchema.parse(res.body).tags).toHaveLength(1);
  });

  it('drops a deleted tag off its movements without touching the money', async () => {
    const agent = await newUserAgent('del@bettertrack.test', 'deluser');
    const portfolioId = await defaultPortfolioId(agent);
    await deposit(agent, portfolioId, 100);
    const movement = await withdraw(agent, portfolioId, 25);
    const tag = await createTag(agent, 'Doomed');
    await setTags(agent, movement.id, [tag.id]);

    expect((await agent.delete(`/api/v1/cash/tags/${tag.id}`).set(...XRW)).status).toBe(204);

    const movements = await ledger(agent, portfolioId);
    const still = movements.find((m) => m.id === movement.id)!;
    // The amount, date and source are untouched: a tag holds no money.
    expect(still.amountEur).toBe(-25);
    expect(still.tags ?? []).not.toContain(tag.id);
  });
});

// ── Auto-tagging ─────────────────────────────────────────────────────────────

describe('cash auto-tagging', () => {
  /** The system tag ids, by key. */
  async function systemTags(agent: Agent): Promise<Map<string, string>> {
    const tags = await listTags(agent);
    return new Map(
      tags.filter((tag) => tag.systemKey !== null).map((tag) => [tag.systemKey!, tag.id]),
    );
  }

  it('stamps deposits and withdrawals when the engine books them', async () => {
    const agent = await newUserAgent('auto@bettertrack.test', 'autouser');
    const portfolioId = await defaultPortfolioId(agent);
    const keys = await systemTags(agent);

    const inbound = await deposit(agent, portfolioId, 500);
    const outbound = await withdraw(agent, portfolioId, 20);

    expect(await tagsOf(agent, portfolioId, inbound.id)).toEqual([keys.get('deposit')]);
    expect(await tagsOf(agent, portfolioId, outbound.id)).toEqual([keys.get('withdrawal')]);
  });

  it('stamps both legs of a transfer with the one transfer tag', async () => {
    const agent = await newUserAgent('tr@bettertrack.test', 'truser');
    const portfolioId = await defaultPortfolioId(agent);
    const keys = await systemTags(agent);
    await deposit(agent, portfolioId, 1000);

    const sourcesRes = await agent.get(`/api/v1/portfolios/${portfolioId}/cash/sources`);
    const main = sourcesRes.body.sources.find((s: { isMain: boolean }) => s.isMain);
    const created = await agent
      .post(`/api/v1/portfolios/${portfolioId}/cash/sources`)
      .set(...XRW)
      .send({ name: 'Savings', type: 'bank' });
    expect(created.status).toBe(201);

    const transfer = await agent
      .post(`/api/v1/portfolios/${portfolioId}/cash/transfer`)
      .set(...XRW)
      .send({ fromSourceId: main.id, toSourceId: created.body.source.id, amountEur: 100 });
    expect(transfer.status).toBe(201);

    // Both legs share one tag: they cancel, so splitting them would double-count
    // an internal move.
    for (const leg of [transfer.body.outgoing, transfer.body.incoming]) {
      expect(await tagsOf(agent, portfolioId, leg.id)).toEqual([keys.get('transfer')]);
    }
  });

  it('leaves a manual tag alone and lets a user remove a stamped one for good', async () => {
    const agent = await newUserAgent('man@bettertrack.test', 'manuser');
    const portfolioId = await defaultPortfolioId(agent);
    const keys = await systemTags(agent);
    await deposit(agent, portfolioId, 500);
    const movement = await withdraw(agent, portfolioId, 60);
    const rent = await createTag(agent, 'Rent');

    // Adding a tag beside the stamped one keeps both.
    await setTags(agent, movement.id, [keys.get('withdrawal')!, rent.id]);
    expect(await tagsOf(agent, portfolioId, movement.id)).toEqual(
      [keys.get('withdrawal')!, rent.id].sort(),
    );

    // Removing the system tag STICKS — nothing re-stamps an existing movement,
    // because stamping only ever happens at the moment a row is created.
    await setTags(agent, movement.id, [rent.id]);
    expect(await tagsOf(agent, portfolioId, movement.id)).toEqual([rent.id]);

    // Booking more money elsewhere in the portfolio must not resurrect it.
    await deposit(agent, portfolioId, 5);
    expect(await tagsOf(agent, portfolioId, movement.id)).toEqual([rent.id]);
  });

  it('gives an edited trade a fresh stamp and no user tags, because it is a new row', async () => {
    // The one place a manual tag is genuinely lost. Deleting a movement cascades
    // its links away; the replacement is a different row with a different id, and
    // its amount or date may differ — so there is no correct label to carry over.
    const agent = await newUserAgent('edit@bettertrack.test', 'edituser');
    const portfolioId = await defaultPortfolioId(agent);
    const keys = await systemTags(agent);
    await deposit(agent, portfolioId, 500);
    const original = await withdraw(agent, portfolioId, 30);
    const holiday = await createTag(agent, 'Holiday');
    await setTags(agent, original.id, [holiday.id]);
    expect(await tagsOf(agent, portfolioId, original.id)).toEqual([holiday.id]);

    // Re-book it (the shape an edit takes: the old row goes, a new one arrives).
    const replacement = await withdraw(agent, portfolioId, 35);
    expect(replacement.id).not.toBe(original.id);
    expect(await tagsOf(agent, portfolioId, replacement.id)).toEqual([keys.get('withdrawal')]);
    // The tag belonged to the row that is being replaced, and does not travel.
    expect(await tagsOf(agent, portfolioId, replacement.id)).not.toContain(holiday.id);
  });

  it('stamps an account whose system tags were never seeded', async () => {
    // Migration 0076 seeded `FROM users`, so an account created after it ran has
    // none. The stamp seeds on the fly rather than leaving the row unlabelled.
    const agent = await newUserAgent('fresh@bettertrack.test', 'freshuser');
    const portfolioId = await defaultPortfolioId(agent);
    // Deliberately NOT reading /cash/tags first, so nothing has seeded them.
    const movement = await deposit(agent, portfolioId, 42);

    const tags = await listTags(agent);
    const depositTag = tags.find((tag) => tag.systemKey === 'deposit')!;
    expect(await tagsOf(agent, portfolioId, movement.id)).toEqual([depositTag.id]);
  });
});

// ── Rules ────────────────────────────────────────────────────────────────────

describe('cash rules', () => {
  it('assigns many tags and lists in evaluation order', async () => {
    const agent = await newUserAgent('rules@bettertrack.test', 'rulesuser');
    const food = await createTag(agent, 'Food');
    const groceries = await createTag(agent, 'Groceries');

    const second = await agent
      .post('/api/v1/cash/rules')
      .set(...XRW)
      .send({ tagIds: [food.id], pattern: 'SPAR', priority: 10 });
    expect(second.status).toBe(201);
    const first = await agent
      .post('/api/v1/cash/rules')
      .set(...XRW)
      .send({ tagIds: [food.id, groceries.id], pattern: 'REWE', priority: 0 });
    expect(first.status).toBe(201);

    const rules = cashRuleListResponseSchema.parse(
      (await agent.get('/api/v1/cash/rules')).body,
    ).rules;
    // Ascending priority — the order the engine walks, first match wins.
    expect(rules.map((rule) => rule.pattern)).toEqual(['REWE', 'SPAR']);
    expect(rules[0]!.tagIds.sort()).toEqual([food.id, groceries.id].sort());
  });

  it('replaces a rule s tag set wholesale on patch', async () => {
    const agent = await newUserAgent('rpatch@bettertrack.test', 'rpatchuser');
    const food = await createTag(agent, 'Food');
    const travel = await createTag(agent, 'Travel');
    const created = await agent
      .post('/api/v1/cash/rules')
      .set(...XRW)
      .send({ tagIds: [food.id], pattern: 'OEBB' });
    const ruleId = cashRuleResponseSchema.parse(created.body).rule.id;

    const patched = await agent
      .patch(`/api/v1/cash/rules/${ruleId}`)
      .set(...XRW)
      .send({ tagIds: [travel.id], enabled: false });
    expect(patched.status).toBe(200);
    const rule = cashRuleResponseSchema.parse(patched.body).rule;
    expect(rule.tagIds).toEqual([travel.id]);
    expect(rule.enabled).toBe(false);
  });

  it('refuses a regex the linear-time engine cannot run', async () => {
    const agent = await newUserAgent('re@bettertrack.test', 'reuser');
    const tag = await createTag(agent, 'Any');
    const res = await agent
      .post('/api/v1/cash/rules')
      .set(...XRW)
      .send({ tagIds: [tag.id], matchType: 'regex', pattern: '(?=lookahead)' });
    // Validated at WRITE time so a pattern that would be inert at match time is
    // refused while the user is looking at it.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CASH_RULE_REGEX_UNSUPPORTED');
  });

  it('validates a type-only patch against the pattern already stored', async () => {
    const agent = await newUserAgent('re2@bettertrack.test', 're2user');
    const tag = await createTag(agent, 'Any');
    const created = await agent
      .post('/api/v1/cash/rules')
      .set(...XRW)
      .send({ tagIds: [tag.id], matchType: 'contains', pattern: '(?=nope)' });
    expect(created.status).toBe(201);
    const ruleId = cashRuleResponseSchema.parse(created.body).rule.id;

    const res = await agent
      .patch(`/api/v1/cash/rules/${ruleId}`)
      .set(...XRW)
      .send({ matchType: 'regex' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CASH_RULE_REGEX_UNSUPPORTED');
  });
});

// ── Budgets, summary, trends ─────────────────────────────────────────────────

describe('cash budgets', () => {
  it('reports progress against a tag s outflow and marks it exceeded', async () => {
    const agent = await newUserAgent('bud@bettertrack.test', 'buduser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');
    await deposit(agent, portfolioId, 5000, `${PERIOD}-01T00:00:00.000Z`);

    const spend = await withdraw(agent, portfolioId, 120, `${PERIOD}-05T00:00:00.000Z`);
    await setTags(agent, spend.id, [food.id]);

    const created = await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: food.id, amount: 100 });
    expect(created.status).toBe(201);

    const listed = await agent.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`);
    const parsed = cashBudgetListResponseSchema.parse(listed.body);
    expect(parsed.period).toBe(PERIOD);
    const row = parsed.budgets[0]!;
    expect(row).toMatchObject({ tagId: food.id, amount: 100, spent: 120, exceeded: true });
    // `period: null` on the row means recurring — the shape the old expense
    // budgets migrated into.
    expect(row.recurring).toBe(true);
    expect(row.remaining).toBe(-20);
  });

  it('lists every raw budget across periods for the paranoid enable capture', async () => {
    // The per-month progress list can only surface the budgets that apply to the
    // queried month; `/cash/budgets/all` is the raw enumeration the enable
    // migration reads so a month-specific budget for another month is carried
    // into the vault instead of being purged with no restore path (§1/§7).
    const agent = await newUserAgent('rawbud@bettertrack.test', 'rawbuduser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');

    const recurring = await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: food.id, amount: 100 });
    expect(recurring.status).toBe(201);
    const december = await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: food.id, period: '2026-12', amount: 250 });
    expect(december.status).toBe(201);

    // The current-month progress endpoint cannot see the December row at all.
    const monthList = await agent.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`);
    expect(cashBudgetListResponseSchema.parse(monthList.body).budgets).toHaveLength(1);

    const all = await agent.get('/api/v1/cash/budgets/all');
    expect(all.status).toBe(200);
    const parsed = cashBudgetRawListResponseSchema.parse(all.body);
    expect(parsed.budgets.map((budget) => `${budget.period}:${budget.amount}`).sort()).toEqual(
      ['2026-12:250', 'null:100'].sort(),
    );
  });

  it('scopes the raw budgets list to the owner', async () => {
    const owner = await newUserAgent('rawown@bettertrack.test', 'rawownuser');
    const stranger = await newUserAgent('rawstr@bettertrack.test', 'rawstruser');
    const portfolioId = await defaultPortfolioId(owner);
    const food = await createTag(owner, 'Food');
    await owner
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: food.id, amount: 100 });

    const strangerView = await stranger.get('/api/v1/cash/budgets/all');
    expect(strangerView.status).toBe(200);
    expect(cashBudgetRawListResponseSchema.parse(strangerView.body).budgets).toEqual([]);
  });

  it('counts only outflows, so a refund carrying the tag creates no headroom', async () => {
    const agent = await newUserAgent('ref@bettertrack.test', 'refuser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');
    await deposit(agent, portfolioId, 5000, `${PERIOD}-01T00:00:00.000Z`);

    const spend = await withdraw(agent, portfolioId, 120, `${PERIOD}-05T00:00:00.000Z`);
    await setTags(agent, spend.id, [food.id]);
    const refund = await deposit(agent, portfolioId, 50, `${PERIOD}-06T00:00:00.000Z`);
    await setTags(agent, refund.id, [food.id]);

    await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: food.id, amount: 100 });

    const listed = await agent.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`);
    // A budget is a spend ceiling: the inflow does not net off the spend.
    expect(cashBudgetListResponseSchema.parse(listed.body).budgets[0]!.spent).toBe(120);
  });

  it('lets a month-specific budget override the recurring one', async () => {
    const agent = await newUserAgent('ovr@bettertrack.test', 'ovruser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');

    await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: food.id, amount: 100 });
    const specific = await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: food.id, amount: 400, period: PERIOD });
    expect(specific.status).toBe(201);

    const listed = await agent.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`);
    const rows = cashBudgetListResponseSchema.parse(listed.body).budgets;
    // One effective target for the tag: December-is-different wins for its month.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 400, recurring: false });
  });

  it('refuses a second budget for the same portfolio, tag and period', async () => {
    const agent = await newUserAgent('dup@bettertrack.test', 'dupbuduser');
    const portfolioId = await defaultPortfolioId(agent);
    const tag = await createTag(agent, 'Rent');
    await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: tag.id, amount: 900 });
    const again = await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: tag.id, amount: 950 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CASH_BUDGET_EXISTS');
  });

  it('alerts exactly once per period however often it is evaluated', async () => {
    const agent = await newUserAgent('fire@bettertrack.test', 'fireuser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');
    await deposit(agent, portfolioId, 5000, `${PERIOD}-01T00:00:00.000Z`);

    const spend = await withdraw(agent, portfolioId, 300, `${PERIOD}-05T00:00:00.000Z`);
    await setTags(agent, spend.id, [food.id]);

    await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: food.id, amount: 100 });

    const fires = async () => {
      const res = await agent.get('/api/v1/notifications');
      expect(res.status).toBe(200);
      return notificationListResponseSchema
        .parse(res.body)
        .items.filter((n) => n.type === 'budget.exceeded').length;
    };
    expect(await fires()).toBe(1);

    // IDEMPOTENCY KEY (budget_id, period_key): more spend, more evaluations, and
    // still one alert for the month.
    const more = await withdraw(agent, portfolioId, 90, `${PERIOD}-09T00:00:00.000Z`);
    await setTags(agent, more.id, [food.id]);
    const budgetId = cashBudgetListResponseSchema.parse(
      (await agent.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`)).body,
    ).budgets[0]!.id;
    await agent
      .patch(`/api/v1/cash/budgets/${budgetId}`)
      .set(...XRW)
      .send({ amount: 90 });
    expect(await fires()).toBe(1);
  });

  it('alerts from the SPEND alone — a tagged withdrawal, no budget edit anywhere', async () => {
    const agent = await newUserAgent('spend@bettertrack.test', 'spenduser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');
    await deposit(agent, portfolioId, 5000, `${PERIOD}-01T00:00:00.000Z`);

    // 1 Aug in the failure scenario: the target is set while nothing is spent,
    // so the create-time evaluation finds nothing and claims nothing.
    await createBudget(agent, portfolioId, food.id, 300);
    expect(await budgetAlerts(agent)).toBe(0);

    // Then the month's spending happens. THE BUDGET IS NEVER TOUCHED AGAIN.
    for (const day of ['05', '12', '20']) {
      const spend = await withdraw(agent, portfolioId, 300, `${PERIOD}-${day}T00:00:00.000Z`);
      expect((await setTags(agent, spend.id, [food.id])).status).toBe(200);
    }

    // €900 against a €300 target: the alert is owed to the user off the money
    // writes themselves — which is the whole point of the write-path seam.
    expect(await budgetAlerts(agent)).toBe(1);
    const rows = cashBudgetListResponseSchema.parse(
      (await agent.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`)).body,
    ).budgets;
    expect(rows[0]).toMatchObject({ spent: 900, exceeded: true });
  });

  it('evaluates on EVERY cash write path, so a new write cannot skip the seam', async () => {
    const agent = await newUserAgent('seam@bettertrack.test', 'seamuser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');
    await deposit(agent, portfolioId, 9000, `${PERIOD}-01T00:00:00.000Z`);
    const spend = await withdraw(agent, portfolioId, 300, `${PERIOD}-05T00:00:00.000Z`);
    await setTags(agent, spend.id, [food.id]);
    await createBudget(agent, portfolioId, food.id, 100);
    expect(await budgetAlerts(agent)).toBe(1);

    const main = await mainSourceId(agent, portfolioId);
    const savings = await createSource(agent, portfolioId, 'Savings');
    const spare = await withdraw(agent, portfolioId, 1, `${PERIOD}-06T00:00:00.000Z`);

    // Each case clears the fire claim first. The budget stays blown throughout,
    // so re-claiming — and therefore a second alert — happens if and ONLY if the
    // path under test evaluated. None of these writes touches the budget row.
    const paths: Array<readonly [string, () => Promise<unknown>]> = [
      ['deposit', () => deposit(agent, portfolioId, 5, `${PERIOD}-07T00:00:00.000Z`)],
      ['withdraw', () => withdraw(agent, portfolioId, 5, `${PERIOD}-08T00:00:00.000Z`)],
      ['fee', () => fee(agent, portfolioId, 5, `${PERIOD}-09T00:00:00.000Z`)],
      [
        'transfer',
        () =>
          agent
            .post(`/api/v1/portfolios/${portfolioId}/cash/transfer`)
            .set(...XRW)
            .send({
              fromSourceId: main,
              toSourceId: savings,
              amountEur: 50,
              executedAt: `${PERIOD}-10T00:00:00.000Z`,
            })
            .expect(201),
      ],
      [
        'set-balance',
        () =>
          agent
            .post(`/api/v1/portfolios/${portfolioId}/cash/sources/${savings}/set-balance`)
            .set(...XRW)
            .send({ balanceEur: 20 })
            .expect(200),
      ],
      [
        'movement PATCH',
        () =>
          agent
            .patch(`/api/v1/portfolios/${portfolioId}/cash/movements/${spare.id}`)
            .set(...XRW)
            .send({ amountEur: 2 })
            .expect(200),
      ],
      [
        'movement tags',
        async () => {
          expect((await setTags(agent, spare.id, [])).status).toBe(200);
        },
      ],
      [
        'movement DELETE',
        () =>
          agent
            .delete(`/api/v1/portfolios/${portfolioId}/cash/movements/${spare.id}`)
            .set(...XRW)
            .send({})
            .expect(200),
      ],
    ];

    let expected = 1;
    for (const [name, write] of paths) {
      await harness.db.delete(cashBudgetFires);
      await write();
      expected += 1;
      expect(await budgetAlerts(agent), `${name} must evaluate budgets`).toBe(expected);
    }
  });

  it('never fails the money write when the notifier throws, and keeps the movement', async () => {
    const agent = await newUserAgent('boom@bettertrack.test', 'boomuser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');
    await deposit(agent, portfolioId, 5000, `${PERIOD}-01T00:00:00.000Z`);
    await createBudget(agent, portfolioId, food.id, 100);

    const realEmit = harness.ctx.notify.emit.bind(harness.ctx.notify);
    harness.ctx.notify.emit = async (event) => {
      if (event.type === 'budget.exceeded') throw new Error('notifier down');
      return realEmit(event);
    };

    const spend = await withdraw(agent, portfolioId, 400, `${PERIOD}-05T00:00:00.000Z`);
    const tagged = await setTags(agent, spend.id, [food.id]);
    expect(tagged.status).toBe(200);

    // The write committed and stayed committed — a budget alert is a side
    // effect of moving money and can never roll it back.
    const movements = await ledger(agent, portfolioId);
    expect(movements.some((m) => m.id === spend.id)).toBe(true);
    expect(await budgetAlerts(agent)).toBe(0);

    // The claim was given back, so the very next evaluation alerts for real.
    harness.ctx.notify.emit = realEmit;
    await withdraw(agent, portfolioId, 1, `${PERIOD}-06T00:00:00.000Z`);
    expect(await budgetAlerts(agent)).toBe(1);
  });

  it('re-arms the month once the budget is back under its target', async () => {
    const agent = await newUserAgent('rearm@bettertrack.test', 'rearmuser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');
    await deposit(agent, portfolioId, 5000, `${PERIOD}-01T00:00:00.000Z`);
    await createBudget(agent, portfolioId, food.id, 200);

    const misTagged = await withdraw(agent, portfolioId, 250, `${PERIOD}-05T00:00:00.000Z`);
    await setTags(agent, misTagged.id, [food.id]);
    expect(await budgetAlerts(agent)).toBe(1);

    // The €250 row was mis-tagged: untagging drops the month back under €200.
    expect((await setTags(agent, misTagged.id, [])).status).toBe(200);
    expect(await budgetAlerts(agent)).toBe(1);

    // …and the genuine overrun later the same month is alerted, instead of
    // being swallowed by a claim taken for spend that no longer exists.
    const real = await withdraw(agent, portfolioId, 600, `${PERIOD}-20T00:00:00.000Z`);
    await setTags(agent, real.id, [food.id]);
    expect(await budgetAlerts(agent)).toBe(2);

    // Still exactly once while the condition holds: more spend, no third alert.
    const more = await withdraw(agent, portfolioId, 30, `${PERIOD}-22T00:00:00.000Z`);
    await setTags(agent, more.id, [food.id]);
    expect(await budgetAlerts(agent)).toBe(2);
  });

  it('refuses a budget denominated in anything but EUR, on create and on patch', async () => {
    const agent = await newUserAgent('fx@bettertrack.test', 'fxbuduser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');

    // THE DECISION (#1754): the ledger is EUR, `spent` comes off `amount_eur`
    // and the comparison has no FX step — so a $100 target would be judged as
    // €100 and rendered as "$95.00 / $100.00". Refused at the contract instead.
    const created = await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: food.id, amount: 100, currency: 'USD' });
    expect(created.status).toBe(400);

    const budgetId = await createBudget(agent, portfolioId, food.id, 100);
    const patched = await agent
      .patch(`/api/v1/cash/budgets/${budgetId}`)
      .set(...XRW)
      .send({ currency: 'USD' });
    expect(patched.status).toBe(400);

    // So the €95-against-$100 case cannot arise: the only reachable budget is
    // EUR, and €95 against €100 is correctly NOT over.
    await deposit(agent, portfolioId, 5000, `${PERIOD}-01T00:00:00.000Z`);
    const spend = await withdraw(agent, portfolioId, 95, `${PERIOD}-05T00:00:00.000Z`);
    await setTags(agent, spend.id, [food.id]);
    const rows = cashBudgetListResponseSchema.parse(
      (await agent.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`)).body,
    ).budgets;
    expect(rows[0]).toMatchObject({ currency: 'EUR', spent: 95, exceeded: false });
    expect(await budgetAlerts(agent)).toBe(0);
  });

  it('does not alert a target that is only exactly met', async () => {
    const agent = await newUserAgent('exact@bettertrack.test', 'exactuser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');
    await deposit(agent, portfolioId, 5000, `${PERIOD}-01T00:00:00.000Z`);
    const spend = await withdraw(agent, portfolioId, 100, `${PERIOD}-05T00:00:00.000Z`);
    await setTags(agent, spend.id, [food.id]);

    await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: food.id, amount: 100 });

    const res = await agent.get('/api/v1/notifications');
    expect(
      notificationListResponseSchema
        .parse(res.body)
        .items.filter((n) => n.type === 'budget.exceeded'),
    ).toHaveLength(0);
    const rows = cashBudgetListResponseSchema.parse(
      (await agent.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`)).body,
    ).budgets;
    expect(rows[0]).toMatchObject({ spent: 100, remaining: 0, exceeded: false });
  });

  // ── The budget half of the transfer exclusion (#1792) ──────────────────────
  //
  // #1754 excluded the legs of an internal transfer from the summary and the
  // trends but not from `outflowByTag`, the measure a budget is judged against.
  // Same tag, same month, same portfolio, and the two endpoints were €9,000
  // apart. Both scenarios below assert the AGREEMENT, not just the number.

  it('counts no transfer leg against a budget, so the budgets page and the summary agree', async () => {
    const agent = await newUserAgent('xferbud@bettertrack.test', 'xferbuduser');
    const portfolioId = await defaultPortfolioId(agent);
    const transferTag = (await listTags(agent)).find((tag) => tag.systemKey === 'transfer')!;
    await deposit(agent, portfolioId, 9000, `${PERIOD}-01T00:00:00.000Z`);
    const main = await mainSourceId(agent, portfolioId);
    const savings = await createSource(agent, portfolioId, 'Savings');

    // A budget on the `Transfer` tag is permitted — nothing refuses a system tag
    // — and every transfer leg carries that tag by construction.
    await createBudget(agent, portfolioId, transferTag.id, 500);

    await agent
      .post(`/api/v1/portfolios/${portfolioId}/cash/transfer`)
      .set(...XRW)
      .send({
        fromSourceId: main,
        toSourceId: savings,
        amountEur: 9000,
        executedAt: `${PERIOD}-03T00:00:00.000Z`,
      })
      .expect(201);

    const summary = cashMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/cash/summary?portfolioId=${portfolioId}`)).body,
    );
    const summaryRow = summary.tags.find((row) => row.tagId === transferTag.id);
    const budgetRow = cashBudgetListResponseSchema.parse(
      (await agent.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`)).body,
    ).budgets[0]!;

    // The one figure both surfaces claim to report: the tag's outflow this month.
    expect(budgetRow.spent).toBe(summaryRow?.outflow ?? 0);
    expect(budgetRow).toMatchObject({ spent: 0, remaining: 500, exceeded: false });
    // …and no alert for money that never left the book.
    expect(await budgetAlerts(agent)).toBe(0);
  });

  it('counts no transfer leg a USER tag was put on either', async () => {
    const agent = await newUserAgent('xferuser@bettertrack.test', 'xferusertag');
    const portfolioId = await defaultPortfolioId(agent);
    const savingsTag = await createTag(agent, 'Savings');
    await deposit(agent, portfolioId, 9000, `${PERIOD}-01T00:00:00.000Z`);
    const main = await mainSourceId(agent, portfolioId);
    const savings = await createSource(agent, portfolioId, 'Savings account');
    await createBudget(agent, portfolioId, savingsTag.id, 200);

    const moved = await agent
      .post(`/api/v1/portfolios/${portfolioId}/cash/transfer`)
      .set(...XRW)
      .send({
        fromSourceId: main,
        toSourceId: savings,
        amountEur: 9000,
        executedAt: `${PERIOD}-03T00:00:00.000Z`,
      });
    expect(moved.status).toBe(201);

    // `PUT /cash/movements/:id/tags` has no kind restriction, so a user's own
    // label lands on the outgoing leg — and retagging re-evaluates the budgets.
    const outgoing = moved.body.outgoing as CashMovement;
    await setTags(agent, outgoing.id, [...(outgoing.tags ?? []), savingsTag.id]);

    const summary = cashMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/cash/summary?portfolioId=${portfolioId}`)).body,
    );
    const budgetRow = cashBudgetListResponseSchema.parse(
      (await agent.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`)).body,
    ).budgets[0]!;
    expect(budgetRow.spent).toBe(
      summary.tags.find((row) => row.tagId === savingsTag.id)?.outflow ?? 0,
    );
    expect(budgetRow).toMatchObject({ spent: 0, exceeded: false });
    expect(await budgetAlerts(agent)).toBe(0);
  });

  it('still measures real spend that shares a month with a transfer', async () => {
    // The exclusion must not become "budgets never fire": one genuine €600
    // withdrawal on the same tag, in the same month as an €8,000 internal move.
    const agent = await newUserAgent('xfermix@bettertrack.test', 'xfermixuser');
    const portfolioId = await defaultPortfolioId(agent);
    const savingsTag = await createTag(agent, 'Savings');
    await deposit(agent, portfolioId, 9000, `${PERIOD}-01T00:00:00.000Z`);
    const main = await mainSourceId(agent, portfolioId);
    const savings = await createSource(agent, portfolioId, 'Savings account');
    await createBudget(agent, portfolioId, savingsTag.id, 200);

    const moved = await agent
      .post(`/api/v1/portfolios/${portfolioId}/cash/transfer`)
      .set(...XRW)
      .send({
        fromSourceId: main,
        toSourceId: savings,
        amountEur: 8000,
        executedAt: `${PERIOD}-03T00:00:00.000Z`,
      });
    expect(moved.status).toBe(201);
    await setTags(agent, (moved.body.outgoing as CashMovement).id, [savingsTag.id]);

    const spend = await withdraw(agent, portfolioId, 600, `${PERIOD}-04T00:00:00.000Z`);
    await setTags(agent, spend.id, [savingsTag.id]);

    const budgetRow = cashBudgetListResponseSchema.parse(
      (await agent.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`)).body,
    ).budgets[0]!;
    expect(budgetRow).toMatchObject({ spent: 600, remaining: -400, exceeded: true });
    expect(await budgetAlerts(agent)).toBe(1);
  });
});

/**
 * ── ONE CLOCK FOR A CASH MONTH (#1792) ──
 *
 * The aggregates bucketed in UTC while the ledger displayed Europe/Vienna, so a
 * movement stamped at 23:15 UTC on 30 September — the real instant a Vienna user
 * records at 01:15 on 1 October — was listed as "1 Oct", missing from October's
 * summary, and charged to SEPTEMBER's budget. The clock is now the one the
 * ledger displays in, everywhere.
 */
describe('cash months follow the clock the ledger displays', () => {
  /** 01:15 on 1 October 2026 in Vienna (CEST, UTC+2). */
  const VIENNA_FIRST_HOUR = new Date('2026-09-30T23:15:00.000Z');
  /** How the ledger renders an instant (`apps/web/src/lib/format.ts`, §5.5). */
  const displayed = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Vienna',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso));

  beforeEach(async () => {
    harness = await createTestApp({ budgetNow: () => VIENNA_FIRST_HOUR });
  });

  it('counts a first-hour movement in the month it is displayed in, and budgets it there', async () => {
    const agent = await newUserAgent('tz@bettertrack.test', 'tzuser');
    const portfolioId = await defaultPortfolioId(agent);
    const rent = await createTag(agent, 'Rent');
    await deposit(agent, portfolioId, 5000, '2026-09-02T12:00:00.000Z');
    await createBudget(agent, portfolioId, rent.id, 300);

    // Exactly what the server stamps for a Vienna user recording at 01:15 local.
    const spend = await withdraw(agent, portfolioId, 400, VIENNA_FIRST_HOUR.toISOString());
    await setTags(agent, spend.id, [rent.id]);

    // 1. What the movements list shows.
    const listed = (await ledger(agent, portfolioId)).find((row) => row.id === spend.id)!;
    expect(displayed(listed.executedAt)).toBe('2026-10-01');

    // 2. The summary month — the default period is the displayed month too.
    const october = cashMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/cash/summary?portfolioId=${portfolioId}`)).body,
    );
    expect(october.month).toBe('2026-10');
    expect(october.totalOutflow).toBe(400);
    expect(october.tags.find((row) => row.tagId === rent.id)?.outflow).toBe(400);
    const september = cashMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/cash/summary?portfolioId=${portfolioId}&month=2026-09`)).body,
    );
    expect(september.totalOutflow).toBe(0);

    // 3. The budget period, and the alert it fired.
    const budgets = cashBudgetListResponseSchema.parse(
      (await agent.get(`/api/v1/cash/budgets?portfolioId=${portfolioId}`)).body,
    );
    expect(budgets.period).toBe('2026-10');
    expect(budgets.budgets[0]).toMatchObject({ spent: 400, exceeded: true });
    expect(await budgetAlerts(agent)).toBe(1);

    // …and the trend point the chart draws it on.
    const trend = cashTrendResponseSchema.parse(
      (await agent.get(`/api/v1/cash/trends?portfolioId=${portfolioId}&months=2`)).body,
    );
    expect(trend.points.map((point) => point.month)).toEqual(['2026-09', '2026-10']);
    expect(trend.points[1]).toMatchObject({ month: '2026-10', outflow: 400 });
    expect(trend.points[0]!.outflow).toBe(0);
  });

  it('leaves a day anchored at noon UTC exactly where it was', async () => {
    // Every day the app writes is anchored at 12:00 UTC, which is the same
    // calendar day in Vienna — so the clock change moves nothing the UI records.
    const agent = await newUserAgent('tznoon@bettertrack.test', 'tznoonuser');
    const portfolioId = await defaultPortfolioId(agent);
    await deposit(agent, portfolioId, 5000, '2026-09-02T12:00:00.000Z');
    const spend = await withdraw(agent, portfolioId, 120, '2026-09-30T12:00:00.000Z');
    expect(displayed(spend.executedAt)).toBe('2026-09-30');

    const september = cashMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/cash/summary?portfolioId=${portfolioId}&month=2026-09`)).body,
    );
    expect(september.totalOutflow).toBe(120);
    const october = cashMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/cash/summary?portfolioId=${portfolioId}`)).body,
    );
    expect(october.totalOutflow).toBe(0);
  });
});

describe('cash summary and trends', () => {
  it('reconciles the totals to the ledger while tag rows may over-count', async () => {
    const agent = await newUserAgent('sum@bettertrack.test', 'sumuser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');
    const groceries = await createTag(agent, 'Groceries');

    await deposit(agent, portfolioId, 2000, `${PERIOD}-01T00:00:00.000Z`);
    const doubleTagged = await withdraw(agent, portfolioId, 100, `${PERIOD}-04T00:00:00.000Z`);
    await setTags(agent, doubleTagged.id, [food.id, groceries.id]);
    // Auto-tagging stamps every booked movement, so the untagged bucket is only
    // reachable once a user clears a stamp — which is exactly what this does.
    const bare = await withdraw(agent, portfolioId, 25, `${PERIOD}-06T00:00:00.000Z`);
    await setTags(agent, bare.id, []);

    const res = await agent.get(`/api/v1/cash/summary?portfolioId=${portfolioId}`);
    expect(res.status).toBe(200);
    const summary = cashMonthlySummaryResponseSchema.parse(res.body);
    expect(summary.month).toBe(PERIOD);
    expect(summary.totalInflow).toBe(2000);
    expect(summary.totalOutflow).toBe(125);
    expect(summary.net).toBe(1875);

    const byTag = new Map(summary.tags.map((row) => [row.tagId, row]));
    // A movement carrying two tags counts in BOTH — "how much on Food" cannot
    // depend on what else the row was labelled — so the rows over-count.
    expect(byTag.get(food.id)!.outflow).toBe(100);
    expect(byTag.get(groceries.id)!.outflow).toBe(100);
    const taggedOutflow = summary.tags
      .filter((row) => row.tagId !== null)
      .reduce((total, row) => total + row.outflow, 0);
    expect(taggedOutflow).toBeGreaterThan(summary.totalOutflow);

    // The untagged bucket is the one row disjoint from every tag row, and last.
    const untagged = summary.tags[summary.tags.length - 1]!;
    expect(untagged.tagId).toBeNull();
    expect(untagged.outflow).toBe(25);
  });

  it('returns one point per month with gaps as measured zeros', async () => {
    const agent = await newUserAgent('trend@bettertrack.test', 'trenduser');
    const portfolioId = await defaultPortfolioId(agent);
    await deposit(agent, portfolioId, 300, '2026-05-10T00:00:00.000Z');
    await withdraw(agent, portfolioId, 80, `${PERIOD}-10T00:00:00.000Z`);

    const res = await agent.get(`/api/v1/cash/trends?portfolioId=${portfolioId}&months=3`);
    expect(res.status).toBe(200);
    const trend = cashTrendResponseSchema.parse(res.body);
    expect(trend.portfolioId).toBe(portfolioId);
    expect(trend.points.map((point) => point.month)).toEqual(['2026-05', '2026-06', PERIOD]);
    expect(trend.points[0]).toMatchObject({ inflow: 300, outflow: 0 });
    // June has no movements at all: a zero, not a hole a chart would slope over.
    expect(trend.points[1]).toMatchObject({ inflow: 0, outflow: 0 });
    expect(trend.points[2]).toMatchObject({ inflow: 0, outflow: 80 });
  });

  it('reports an internal transfer as no flow at all — it cancels in every roll-up', async () => {
    const agent = await newUserAgent('xfer@bettertrack.test', 'xferuser');
    const portfolioId = await defaultPortfolioId(agent);
    await deposit(agent, portfolioId, 9000, '2026-06-20T00:00:00.000Z');
    const main = await mainSourceId(agent, portfolioId);
    const savings = await createSource(agent, portfolioId, 'Savings');

    // The month's ONLY activity: €9,000 moved from Main to Savings.
    const moved = await agent
      .post(`/api/v1/portfolios/${portfolioId}/cash/transfer`)
      .set(...XRW)
      .send({
        fromSourceId: main,
        toSourceId: savings,
        amountEur: 9000,
        executedAt: `${PERIOD}-03T00:00:00.000Z`,
      });
    expect(moved.status).toBe(201);

    const summary = cashMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/cash/summary?portfolioId=${portfolioId}`)).body,
    );
    // Both legs live in this portfolio, so bucketing on sign alone used to read
    // "Inflow €9.000 · Outflow €9.000" for money that never left the book.
    expect(summary).toMatchObject({ totalInflow: 0, totalOutflow: 0, net: 0 });
    // The by-tag breakdown inherits the exclusion, so a self-transfer can no
    // longer be the month's dominant "where the money went".
    expect(summary.tags.every((row) => row.inflow === 0 && row.outflow === 0)).toBe(true);

    const trend = cashTrendResponseSchema.parse(
      (await agent.get(`/api/v1/cash/trends?portfolioId=${portfolioId}&months=2`)).body,
    );
    expect(trend.points[1]).toMatchObject({ month: PERIOD, inflow: 0, outflow: 0 });
  });

  it('leaves deposits, withdrawals and fees untouched in a month mixing them with a transfer', async () => {
    const agent = await newUserAgent('mixed@bettertrack.test', 'mixeduser');
    const portfolioId = await defaultPortfolioId(agent);
    const food = await createTag(agent, 'Food');
    await deposit(agent, portfolioId, 2000, `${PERIOD}-01T00:00:00.000Z`);
    const spend = await withdraw(agent, portfolioId, 120, `${PERIOD}-04T00:00:00.000Z`);
    await setTags(agent, spend.id, [food.id]);
    await fee(agent, portfolioId, 5, `${PERIOD}-05T00:00:00.000Z`);

    const main = await mainSourceId(agent, portfolioId);
    const savings = await createSource(agent, portfolioId, 'Savings');
    await agent
      .post(`/api/v1/portfolios/${portfolioId}/cash/transfer`)
      .set(...XRW)
      .send({
        fromSourceId: main,
        toSourceId: savings,
        amountEur: 500,
        executedAt: `${PERIOD}-06T00:00:00.000Z`,
      })
      .expect(201);

    const summary = cashMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/cash/summary?portfolioId=${portfolioId}`)).body,
    );
    // The real flows are exactly what they were before the transfer existed.
    expect(summary).toMatchObject({ totalInflow: 2000, totalOutflow: 125, net: 1875 });
    const byTag = new Map(summary.tags.map((row) => [row.tagId, row]));
    expect(byTag.get(food.id)!.outflow).toBe(120);
    expect([...byTag.values()].some((row) => row.name === 'Transfer' && row.outflow > 0)).toBe(
      false,
    );

    const trend = cashTrendResponseSchema.parse(
      (await agent.get(`/api/v1/cash/trends?portfolioId=${portfolioId}&months=1`)).body,
    );
    expect(trend.points[0]).toMatchObject({ month: PERIOD, inflow: 2000, outflow: 125 });
  });

  it('is portfolio-scoped, so another book s cash never leaks in', async () => {
    const agent = await newUserAgent('scope@bettertrack.test', 'scopeuser');
    const first = await defaultPortfolioId(agent);
    const madeRes = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Second book' });
    expect(madeRes.status).toBe(201);
    const second = madeRes.body.portfolio.id as string;

    await deposit(agent, first, 900, `${PERIOD}-02T00:00:00.000Z`);
    await deposit(agent, second, 40, `${PERIOD}-02T00:00:00.000Z`);

    const firstSummary = cashMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/cash/summary?portfolioId=${first}`)).body,
    );
    const secondSummary = cashMonthlySummaryResponseSchema.parse(
      (await agent.get(`/api/v1/cash/summary?portfolioId=${second}`)).body,
    );
    expect(firstSummary.totalInflow).toBe(900);
    expect(secondSummary.totalInflow).toBe(40);
  });
});

// ── The retired surface ──────────────────────────────────────────────────────

describe('the expense area is no longer writable', () => {
  it('refuses every write with 410 while reads still answer', async () => {
    const agent = await newUserAgent('ret@bettertrack.test', 'retuser');

    for (const [method, path, body] of [
      ['post', '/api/v1/expenses/categories', { name: 'X', direction: 'expense' }],
      [
        'post',
        '/api/v1/expenses/transactions',
        {
          amount: 5,
          direction: 'expense',
          bookedOn: '2026-07-01',
          description: 'X',
        },
      ],
      [
        'post',
        '/api/v1/expenses/budgets',
        {
          categoryId: '00000000-0000-4000-8000-000000000000',
          amount: 5,
        },
      ],
      [
        'post',
        '/api/v1/expenses/rules',
        {
          categoryId: '00000000-0000-4000-8000-000000000000',
          pattern: 'X',
        },
      ],
    ] as const) {
      const res = await agent[method](path)
        .set(...XRW)
        .send(body);
      // Divergence between the old tables and the fused ones cannot resume.
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('EXPENSE_AREA_RETIRED');
    }

    const del = await agent
      .delete('/api/v1/expenses/categories/00000000-0000-4000-8000-000000000000')
      .set(...XRW);
    expect(del.status).toBe(410);

    // Reads keep working for one release: the old tables are the rollback and
    // diagnosis path while the fused surfaces bed in.
    const read = await agent.get('/api/v1/expenses/categories');
    expect(read.status).toBe(200);
  });
});
