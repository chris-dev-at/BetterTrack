import request from 'supertest';
import { beforeEach, expect, it } from 'vitest';

import {
  cashRuleApplyResponseSchema,
  cashRulePreviewResponseSchema,
  cashRuleResponseSchema,
  cashTagResponseSchema,
  type CashMovement,
  type CashRuleMatchType,
  type CashTag,
} from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * AUTO-TAGGING BY THE USER'S OWN RULES (owner decision, 2026-07-30).
 *
 * Phase 2 shipped `tagsByRules()` unit-tested and called from nowhere, and
 * `attachTagWithinPortfolio()` documented as "the auto-tagging path" with no
 * caller either — so a saved rule could not affect a single movement while the
 * Rules page promised "Rules tag imports and manual entries automatically".
 *
 * The load-bearing assertion of this file is therefore the plainest one: BOOK A
 * MOVEMENT WHOSE NOTE MATCHES A RULE AND THE TAG IS THERE. Everything else pins
 * the edges around it — that the rule's own semantics (first match wins,
 * disabled rules skipped, case insensitivity) survive the trip through SQL,
 * that the catch-up run is additive and idempotent, and that neither path can
 * reach across accounts.
 *
 * `cashTagging.test.ts` covers the app-owned tag a movement's KIND earns; this
 * covers the tags its NOTE earns. They share one entry point (`stampMovementTags`)
 * and a movement gets both.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
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

async function createTag(agent: Agent, name: string): Promise<CashTag> {
  const res = await agent
    .post('/api/v1/cash/tags')
    .set(...XRW)
    .send({ name, color: '#4477aa' });
  expect(res.status).toBe(201);
  return cashTagResponseSchema.parse(res.body).tag;
}

async function createRule(
  agent: Agent,
  input: {
    tagIds: string[];
    pattern: string;
    matchType?: CashRuleMatchType;
    priority?: number;
    enabled?: boolean;
  },
): Promise<string> {
  const res = await agent
    .post('/api/v1/cash/rules')
    .set(...XRW)
    .send({
      tagIds: input.tagIds,
      pattern: input.pattern,
      matchType: input.matchType ?? 'contains',
      priority: input.priority ?? 0,
      enabled: input.enabled ?? true,
    });
  expect(res.status).toBe(201);
  return cashRuleResponseSchema.parse(res.body).rule.id;
}

async function deposit(agent: Agent, portfolioId: string, amountEur: number, note?: string) {
  const res = await agent
    .post(`/api/v1/portfolios/${portfolioId}/cash/deposit`)
    .set(...XRW)
    .send({ amountEur, ...(note === undefined ? {} : { note }) });
  expect(res.status).toBe(201);
  return res.body.movement as CashMovement;
}

async function withdraw(agent: Agent, portfolioId: string, amountEur: number, note?: string) {
  const res = await agent
    .post(`/api/v1/portfolios/${portfolioId}/cash/withdraw`)
    .set(...XRW)
    .send({ amountEur, ...(note === undefined ? {} : { note }) });
  expect(res.status).toBe(201);
  return res.body.movement as CashMovement;
}

async function bookFee(agent: Agent, portfolioId: string, amountEur: number, note?: string) {
  const res = await agent
    .post(`/api/v1/portfolios/${portfolioId}/cash/fee`)
    .set(...XRW)
    .send({ amountEur, ...(note === undefined ? {} : { note }) });
  expect(res.status).toBe(201);
  return res.body.movement as CashMovement;
}

/** The tag ids on one movement, read back off the ledger. */
async function tagsOf(agent: Agent, portfolioId: string, movementId: string): Promise<string[]> {
  const res = await agent.get(`/api/v1/portfolios/${portfolioId}/cash`);
  expect(res.status).toBe(200);
  const movement = (res.body.movements as CashMovement[]).find((m) => m.id === movementId);
  expect(movement, 'movement is on the ledger').toBeTruthy();
  return [...(movement!.tags ?? [])].sort();
}

async function applyRules(agent: Agent): Promise<number> {
  const res = await agent
    .post('/api/v1/cash/rules/apply')
    .set(...XRW)
    .send();
  expect(res.status).toBe(200);
  return cashRuleApplyResponseSchema.parse(res.body).movementsTagged;
}

/** The system tag with `systemKey`, for asserting a movement carries BOTH labels. */
async function systemTagId(agent: Agent, key: string): Promise<string> {
  const res = await agent.get('/api/v1/cash/tags');
  expect(res.status).toBe(200);
  const tag = (res.body.tags as CashTag[]).find((t) => t.systemKey === key);
  expect(tag, `system tag ${key} is seeded`).toBeTruthy();
  return tag!.id;
}

// ── At book time ─────────────────────────────────────────────────────────────

it('tags a movement whose note matches a rule, ALONGSIDE the tag its kind earns', async () => {
  const agent = await newUserAgent('booktime@bettertrack.test', 'booktimeuser');
  const portfolioId = await defaultPortfolioId(agent);
  const groceries = await createTag(agent, 'Groceries');
  await createRule(agent, { tagIds: [groceries.id], pattern: 'SPAR' });

  await deposit(agent, portfolioId, 1000);
  const spend = await withdraw(agent, portfolioId, 300, 'SPAR MARKT 4021 WIEN');

  // Both halves of auto-tagging, on one movement: `withdrawal` from the kind
  // table, `Groceries` from the user's rule.
  const withdrawalTag = await systemTagId(agent, 'withdrawal');
  expect(await tagsOf(agent, portfolioId, spend.id)).toEqual([groceries.id, withdrawalTag].sort());
});

it('matches case-insensitively and ignores a movement with no note', async () => {
  const agent = await newUserAgent('nocase@bettertrack.test', 'nocaseuser');
  const portfolioId = await defaultPortfolioId(agent);
  const subs = await createTag(agent, 'Subscriptions');
  await createRule(agent, { tagIds: [subs.id], pattern: 'spotify' });

  await deposit(agent, portfolioId, 1000);
  const matched = await withdraw(agent, portfolioId, 11, 'SPOTIFY AB');
  const unnoted = await withdraw(agent, portfolioId, 11);

  expect(await tagsOf(agent, portfolioId, matched.id)).toContain(subs.id);
  expect(await tagsOf(agent, portfolioId, unnoted.id)).not.toContain(subs.id);
});

it('honours priority — the FIRST matching rule wins and evaluation stops', async () => {
  const agent = await newUserAgent('priority@bettertrack.test', 'priorityuser');
  const portfolioId = await defaultPortfolioId(agent);
  const specific = await createTag(agent, 'Coffee');
  const general = await createTag(agent, 'Eating out');
  // Both patterns match the note below; only the lower-priority rule may apply.
  await createRule(agent, { tagIds: [specific.id], pattern: 'CAFE ALT', priority: 0 });
  await createRule(agent, { tagIds: [general.id], pattern: 'CAFE', priority: 10 });

  await deposit(agent, portfolioId, 1000);
  const spend = await withdraw(agent, portfolioId, 4, 'CAFE ALT WIEN');

  const tags = await tagsOf(agent, portfolioId, spend.id);
  expect(tags).toContain(specific.id);
  expect(tags).not.toContain(general.id);
});

it('applies EVERY tag of the winning rule, and skips a disabled rule entirely', async () => {
  const agent = await newUserAgent('multi@bettertrack.test', 'multiuser');
  const portfolioId = await defaultPortfolioId(agent);
  const food = await createTag(agent, 'Food');
  const groceries = await createTag(agent, 'Groceries');
  const dormant = await createTag(agent, 'Dormant');
  await createRule(agent, { tagIds: [food.id, groceries.id], pattern: 'REWE', priority: 0 });
  await createRule(agent, { tagIds: [dormant.id], pattern: 'REWE', priority: 1, enabled: false });

  await deposit(agent, portfolioId, 1000);
  const spend = await withdraw(agent, portfolioId, 42, 'REWE 0815');

  const tags = await tagsOf(agent, portfolioId, spend.id);
  expect(tags).toContain(food.id);
  expect(tags).toContain(groceries.id);
  expect(tags).not.toContain(dormant.id);
});

it('tags a FEE the same way — a rule reaches every booking path, not just withdrawals', async () => {
  const agent = await newUserAgent('feerule@bettertrack.test', 'feeruleuser');
  const portfolioId = await defaultPortfolioId(agent);
  const custody = await createTag(agent, 'Custody');
  await createRule(agent, { tagIds: [custody.id], pattern: 'depotgebühr', matchType: 'contains' });

  await deposit(agent, portfolioId, 1000);
  const fee = await bookFee(agent, portfolioId, 25, 'DEPOTGEBÜHR Q3');

  const feesTag = await systemTagId(agent, 'fees');
  expect(await tagsOf(agent, portfolioId, fee.id)).toEqual([custody.id, feesTag].sort());
});

// ── The catch-up run ─────────────────────────────────────────────────────────

it('applies rules to movements booked BEFORE the rule existed, and is idempotent', async () => {
  const agent = await newUserAgent('catchup@bettertrack.test', 'catchupuser');
  const portfolioId = await defaultPortfolioId(agent);

  // The back catalogue: booked while no rule existed, so untagged by any rule.
  await deposit(agent, portfolioId, 1000);
  const first = await withdraw(agent, portfolioId, 30, 'BILLA DANKT');
  const second = await withdraw(agent, portfolioId, 20, 'billa plus');
  const unrelated = await withdraw(agent, portfolioId, 10, 'OEBB TICKET');

  const groceries = await createTag(agent, 'Groceries');
  await createRule(agent, { tagIds: [groceries.id], pattern: 'BILLA' });

  // Two movements match; the third does not. The count is MOVEMENTS, not labels.
  expect(await applyRules(agent)).toBe(2);
  expect(await tagsOf(agent, portfolioId, first.id)).toContain(groceries.id);
  expect(await tagsOf(agent, portfolioId, second.id)).toContain(groceries.id);
  expect(await tagsOf(agent, portfolioId, unrelated.id)).not.toContain(groceries.id);

  // Idempotent: pressing it again changed nothing, and says so.
  expect(await applyRules(agent)).toBe(0);
  expect(await tagsOf(agent, portfolioId, first.id)).toContain(groceries.id);
});

it('is ADDITIVE — a catch-up run never removes a tag the user set by hand', async () => {
  const agent = await newUserAgent('additive@bettertrack.test', 'additiveuser');
  const portfolioId = await defaultPortfolioId(agent);
  await deposit(agent, portfolioId, 1000);
  const spend = await withdraw(agent, portfolioId, 60, 'HOFER 12');

  const manual = await createTag(agent, 'Reimbursable');
  const auto = await createTag(agent, 'Groceries');
  const setRes = await agent
    .put(`/api/v1/cash/movements/${spend.id}/tags`)
    .set(...XRW)
    .send({ tagIds: [manual.id] });
  expect(setRes.status).toBe(200);

  await createRule(agent, { tagIds: [auto.id], pattern: 'HOFER' });
  expect(await applyRules(agent)).toBe(1);

  // The hand-set tag survived and the rule's tag joined it.
  const tags = await tagsOf(agent, portfolioId, spend.id);
  expect(tags).toContain(manual.id);
  expect(tags).toContain(auto.id);
});

it('covers every portfolio the caller owns, because rules are per user', async () => {
  const agent = await newUserAgent('multiport@bettertrack.test', 'multiportuser');
  const firstId = await defaultPortfolioId(agent);
  const created = await agent
    .post('/api/v1/portfolios')
    .set(...XRW)
    .send({ name: 'Second' });
  expect(created.status).toBe(201);
  const secondId = created.body.portfolio.id as string;

  await deposit(agent, firstId, 500);
  await deposit(agent, secondId, 500);
  const inFirst = await withdraw(agent, firstId, 20, 'LIDL A');
  const inSecond = await withdraw(agent, secondId, 20, 'LIDL B');

  const groceries = await createTag(agent, 'Groceries');
  await createRule(agent, { tagIds: [groceries.id], pattern: 'LIDL' });

  expect(await applyRules(agent)).toBe(2);
  expect(await tagsOf(agent, firstId, inFirst.id)).toContain(groceries.id);
  expect(await tagsOf(agent, secondId, inSecond.id)).toContain(groceries.id);
});

// ── The ownership boundary ───────────────────────────────────────────────────

it('never reaches another account — neither at book time nor on a catch-up run', async () => {
  const mine = await newUserAgent('ruleowner@bettertrack.test', 'ruleowneruser');
  const theirs = await newUserAgent('rulestranger@bettertrack.test', 'rulestranger');
  const myPortfolio = await defaultPortfolioId(mine);
  const theirPortfolio = await defaultPortfolioId(theirs);

  // My rule, and a note in THEIR ledger that my pattern matches perfectly.
  const myTag = await createTag(mine, 'Groceries');
  await createRule(mine, { tagIds: [myTag.id], pattern: 'MERKUR' });

  await deposit(theirs, theirPortfolio, 1000);
  const theirSpend = await withdraw(theirs, theirPortfolio, 50, 'MERKUR MARKT');
  await deposit(mine, myPortfolio, 1000);
  const mySpend = await withdraw(mine, myPortfolio, 50, 'MERKUR MARKT');

  // Book time: their movement did not pick up my tag.
  expect(await tagsOf(theirs, theirPortfolio, theirSpend.id)).not.toContain(myTag.id);
  expect(await tagsOf(mine, myPortfolio, mySpend.id)).toContain(myTag.id);

  // Catch-up: still only mine, and the count proves it stopped at the boundary.
  expect(await applyRules(mine)).toBe(0); // already tagged at book time
  expect(await tagsOf(theirs, theirPortfolio, theirSpend.id)).not.toContain(myTag.id);
});

it('a rule pointing at a tag the caller no longer owns simply assigns nothing', async () => {
  const agent = await newUserAgent('deltag@bettertrack.test', 'deltaguser');
  const portfolioId = await defaultPortfolioId(agent);
  const doomed = await createTag(agent, 'Temporary');
  await createRule(agent, { tagIds: [doomed.id], pattern: 'ANYTHING' });

  const removed = await agent.delete(`/api/v1/cash/tags/${doomed.id}`).set(...XRW);
  expect(removed.status).toBe(204);

  // Deleting the tag cascades the rule's link away, so the rule can no longer
  // assign anything — and booking a movement it would have matched still works.
  await deposit(agent, portfolioId, 1000);
  const spend = await withdraw(agent, portfolioId, 5, 'ANYTHING AT ALL');
  expect(await tagsOf(agent, portfolioId, spend.id)).not.toContain(doomed.id);
  expect(await applyRules(agent)).toBe(0);
});

// ── The live preview the entry form asks while you type ──────────────────────

it('previews what the rules WOULD tag a note as, writing nothing', async () => {
  const agent = await newUserAgent('preview@bettertrack.test', 'previewuser');
  const portfolioId = await defaultPortfolioId(agent);
  const groceries = await createTag(agent, 'Groceries');
  await createRule(agent, { tagIds: [groceries.id], pattern: 'SPAR' });

  const hit = await agent
    .post('/api/v1/cash/rules/preview')
    .set(...XRW)
    .send({ note: 'SPAR MARKT 4021' });
  expect(hit.status).toBe(200);
  expect(cashRulePreviewResponseSchema.parse(hit.body).tagIds).toEqual([groceries.id]);

  const miss = await agent
    .post('/api/v1/cash/rules/preview')
    .set(...XRW)
    .send({ note: 'OEBB TICKET' });
  expect(cashRulePreviewResponseSchema.parse(miss.body).tagIds).toEqual([]);

  // An empty note is the normal state of a form nobody has typed into yet.
  const empty = await agent
    .post('/api/v1/cash/rules/preview')
    .set(...XRW)
    .send({ note: '' });
  expect(empty.status).toBe(200);
  expect(cashRulePreviewResponseSchema.parse(empty.body).tagIds).toEqual([]);

  // READ-ONLY: nothing was booked, so the ledger is still empty.
  const ledger = await agent.get(`/api/v1/portfolios/${portfolioId}/cash`);
  expect(ledger.body.movements).toHaveLength(0);
});

it('previews the SAME answer the booking would apply — first match wins here too', async () => {
  const agent = await newUserAgent('previewpri@bettertrack.test', 'previewpriuser');
  const portfolioId = await defaultPortfolioId(agent);
  const specific = await createTag(agent, 'Coffee');
  const general = await createTag(agent, 'Eating out');
  await createRule(agent, { tagIds: [specific.id], pattern: 'CAFE ALT', priority: 0 });
  await createRule(agent, { tagIds: [general.id], pattern: 'CAFE', priority: 10 });

  const preview = await agent
    .post('/api/v1/cash/rules/preview')
    .set(...XRW)
    .send({ note: 'CAFE ALT WIEN' });
  const predicted = cashRulePreviewResponseSchema.parse(preview.body).tagIds;

  await deposit(agent, portfolioId, 1000);
  const spend = await withdraw(agent, portfolioId, 4, 'CAFE ALT WIEN');

  // The promise the form makes must be the promise the ledger keeps.
  expect(predicted).toEqual([specific.id]);
  expect(await tagsOf(agent, portfolioId, spend.id)).toContain(specific.id);
  expect(await tagsOf(agent, portfolioId, spend.id)).not.toContain(general.id);
});

it("never previews another account's rules", async () => {
  const mine = await newUserAgent('previewmine@bettertrack.test', 'previewmine');
  const theirs = await newUserAgent('previewtheirs@bettertrack.test', 'previewtheirs');
  const myTag = await createTag(mine, 'Groceries');
  await createRule(mine, { tagIds: [myTag.id], pattern: 'MERKUR' });

  const res = await theirs
    .post('/api/v1/cash/rules/preview')
    .set(...XRW)
    .send({ note: 'MERKUR MARKT' });
  expect(res.status).toBe(200);
  expect(cashRulePreviewResponseSchema.parse(res.body).tagIds).toEqual([]);
});

it('requires a session', async () => {
  const res = await request(harness.app)
    .post('/api/v1/cash/rules/apply')
    .set(...XRW)
    .send();
  expect(res.status).toBe(401);

  const preview = await request(harness.app)
    .post('/api/v1/cash/rules/preview')
    .set(...XRW)
    .send({ note: 'anything' });
  expect(preview.status).toBe(401);
});
