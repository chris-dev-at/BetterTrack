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
