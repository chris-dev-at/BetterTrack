import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  paranoidDisableRequestSchema,
  cashBudgetRawListResponseSchema,
  cashMovementsResponseSchema,
  cashRuleListResponseSchema,
  cashTagListResponseSchema,
  standingOrderRunListResponseSchema,
  type CashBudget,
  type CashMovement,
  type CashRule,
  type CashSource,
  type CashTag,
  type ParanoidDisableRequest,
  type StandingOrder,
  type StandingOrderRun,
} from '@bettertrack/contracts';

import {
  cashBudgets,
  cashMovementTags,
  cashRuleTags,
  cashRules,
  cashTags,
  portfolioCashMovements,
  standingOrderRuns,
} from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * The user-visible paranoid round trip: seed a real normal account, CAPTURE it
 * through the very endpoints the enable wizard reads, enable (which hard-purges
 * every one of those rows), disable with the captured document, and compare the
 * restored account against what was captured.
 *
 * Why this shape. Enable is one-way: the encrypted document becomes the only
 * copy, and disable restores from it ALONE (`PARANOID_REHYDRATION_POLICY`). A
 * unit assertion on the intermediate document proves the mapping, not the
 * OUTCOME — and the two irreversible-loss defects this file regresses (the V5
 * cash-fusion tables, and the standing-order run ledger) both looked fine at
 * document level and destroyed user data at account level. So each test here
 * walks the whole path and ends on state read back through the product's own
 * endpoints.
 *
 * The client-side half — that `buildNormalVaultDocument` really emits these
 * entities from these DTOs — is pinned in `apps/web/src/user/vault/ui/
 * migration.test.ts`; the field mapping below deliberately mirrors it so a
 * divergence shows up on one side or the other.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const REHYDRATION_ID = '018f0000-0000-7000-8000-0000000009a1';
/** Fixed clock: "the current period" and the standing-order calendar must not drift. */
const NOW = new Date('2026-07-15T12:00:00.000Z');

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ budgetNow: () => NOW });
});

type Agent = ReturnType<typeof request.agent>;

async function seedAgent(): Promise<{ agent: Agent; userId: string }> {
  const user = await harness.seedUser({
    email: 'roundtrip@bettertrack.test',
    username: 'roundtrip',
  });
  const agent = request.agent(harness.app);
  const login = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(login.status).toBe(200);
  return { agent, userId: user.id };
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const portfolio = res.body.portfolios.find((row: { isDefault: boolean }) => row.isDefault);
  expect(portfolio).toBeTruthy();
  return portfolio.id as string;
}

// ── The capture: the exact reads `buildNormalVaultDocument` performs ─────────

interface Captured {
  portfolioId: string;
  sources: CashSource[];
  movements: CashMovement[];
  tags: CashTag[];
  rules: CashRule[];
  budgets: CashBudget[];
  orders: StandingOrder[];
  runs: StandingOrderRun[];
}

async function capture(agent: Agent, portfolioId: string): Promise<Captured> {
  const ledger = await agent.get(`/api/v1/portfolios/${portfolioId}/cash`);
  expect(ledger.status).toBe(200);
  const cash = cashMovementsResponseSchema.parse(ledger.body);

  const tags = await agent.get('/api/v1/cash/tags');
  expect(tags.status).toBe(200);
  const rules = await agent.get('/api/v1/cash/rules');
  expect(rules.status).toBe(200);
  // The RAW budgets read: the per-month progress list cannot enumerate a
  // month-specific budget for any month but the queried one.
  const budgets = await agent.get('/api/v1/cash/budgets/all');
  expect(budgets.status).toBe(200);
  const orders = await agent.get('/api/v1/standing-orders');
  expect(orders.status).toBe(200);
  // The RAW run ledger: an order's watermark cannot express a claimed-but-
  // unbooked period.
  const runs = await agent.get('/api/v1/standing-orders/runs');
  expect(runs.status).toBe(200);

  return {
    portfolioId,
    sources: cash.sources,
    movements: cash.movements,
    tags: cashTagListResponseSchema.parse(tags.body).tags,
    rules: cashRuleListResponseSchema.parse(rules.body).rules,
    budgets: cashBudgetRawListResponseSchema.parse(budgets.body).budgets,
    orders: orders.body.orders as StandingOrder[],
    runs: standingOrderRunListResponseSchema.parse(runs.body).runs,
  };
}

/**
 * The captured account as the restore document the disable endpoint accepts.
 * Field-for-field the mapping `buildNormalVaultDocument` applies; join rows get
 * a synthesized id because their identity is the pair they carry.
 */
function restoreDocument(userId: string, captured: Captured): ParanoidDisableRequest {
  const at = '2026-07-15T12:00:00.000Z';
  let synthesized = 0;
  const joinId = () =>
    `018f0000-0000-7000-8000-b${String(++synthesized).padStart(11, '0')}` as const;
  const entity = (id: string, kind: string, data: Record<string, unknown>) => ({
    id,
    kind,
    rev: 0,
    editedAt: at,
    editedBy: userId,
    deletedAt: null,
    data,
  });
  const dec = (value: number) => String(value);

  const entities = [
    entity(captured.portfolioId, 'portfolio', {
      userId,
      name: 'Main',
      visibility: 'private',
      sortOrder: 0,
      defaultPayFromCash: false,
      archivedAt: null,
    }),
    ...captured.sources.map((source) =>
      entity(source.id, 'cashSource', {
        portfolioId: captured.portfolioId,
        name: source.name,
        type: source.type,
        isMain: source.isMain,
        archivedAt: source.archivedAt,
        createdAt: source.createdAt,
      }),
    ),
    ...captured.movements.map((movement) =>
      entity(movement.id, 'cashMovement', {
        portfolioId: captured.portfolioId,
        sourceId: movement.sourceId,
        kind: movement.kind,
        amountEur: dec(movement.amountEur),
        transactionId: movement.transactionId,
        transferId: movement.transferId,
        counterpartSourceId: movement.counterpartSourceId,
        dividendId: movement.dividendId,
        taxYear: movement.taxYear,
        executedAt: movement.executedAt,
        note: movement.note,
        source: movement.source,
        dedupHash: null,
        originalCurrency: movement.originalCurrency ?? null,
        createdAt: movement.createdAt,
      }),
    ),
    ...captured.movements.flatMap((movement) =>
      (movement.tags ?? []).map((tagId) =>
        entity(joinId(), 'cashMovementTag', {
          movementId: movement.id,
          tagId,
          createdAt: movement.createdAt,
        }),
      ),
    ),
    ...captured.tags.map((tag) =>
      entity(tag.id, 'cashTag', {
        userId,
        name: tag.name,
        color: tag.color,
        system: tag.system,
        systemKey: tag.systemKey,
        createdAt: tag.createdAt,
        updatedAt: tag.updatedAt,
      }),
    ),
    ...captured.rules.flatMap((rule) => [
      entity(rule.id, 'cashRule', {
        userId,
        matchType: rule.matchType,
        pattern: rule.pattern,
        priority: rule.priority,
        enabled: rule.enabled,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      }),
      ...rule.tagIds.map((tagId) =>
        entity(joinId(), 'cashRuleTag', {
          ruleId: rule.id,
          tagId,
          createdAt: rule.createdAt,
        }),
      ),
    ]),
    ...captured.budgets.map((budget) =>
      entity(budget.id, 'cashBudget', {
        portfolioId: budget.portfolioId,
        tagId: budget.tagId,
        periodKey: budget.period,
        amount: dec(budget.amount),
        currency: budget.currency,
        createdAt: budget.createdAt,
        updatedAt: budget.updatedAt,
      }),
    ),
    ...captured.orders.map((order) =>
      entity(order.id, 'standingOrder', {
        userId,
        portfolioId: order.portfolioId,
        kind: order.kind,
        assetId: order.assetId,
        amount: dec(order.amount),
        currency: order.currency,
        label: order.label,
        cadence: order.cadence,
        anchorDay: order.anchorDay,
        startDate: order.startDate,
        endDate: order.endDate,
        status: order.status,
        lastRunAt: order.lastRunAt,
        lastPeriodKey: order.lastPeriodKey,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      }),
    ),
    ...captured.runs.map((run) =>
      entity(run.id, 'standingOrderRun', {
        standingOrderId: run.standingOrderId,
        periodKey: run.periodKey,
        bookedAt: run.bookedAt,
      }),
    ),
  ];

  // Parsed, not cast: the strict per-kind contract validates this mapping, so a
  // field the capture would have shaped differently fails HERE and not as an
  // opaque 400 later.
  return paranoidDisableRequestSchema.parse({
    confirm: true,
    rehydrationId: REHYDRATION_ID,
    document: { schemaVersion: 1, entities, mergeLog: [], mirrorProvenance: [] },
  });
}

/** Drive-only enable evidence with a freshly read capture token. */
async function enable(agent: Agent, userId: string) {
  const { revision } = await harness.ctx.paranoidTransitions.normalDataRevision(userId);
  return agent
    .post('/api/v1/account/paranoid/enable')
    .set(...XRW)
    .send({
      mediaSet: ['drive'],
      vaultVersion: 1,
      driveAttestation: { verifiedRoundTrip: true, vaultVersion: 1 },
      normalDataRevision: revision,
    });
}

describe('paranoid capture round trip', () => {
  it('carries cash tags, movement links, rules and budgets through enable → purge → disable', async () => {
    const { agent, userId } = await seedAgent();
    const portfolioId = await defaultPortfolioId(agent);

    // A real cash ledger: the deposit auto-stamps its app-owned system tag, and
    // the user adds one of their own on top.
    const deposit = await agent
      .post(`/api/v1/portfolios/${portfolioId}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 2_000, executedAt: '2026-07-01T09:00:00.000Z' });
    expect(deposit.status).toBe(201);
    const movementId = deposit.body.movement.id as string;

    const userTag = await agent
      .post('/api/v1/cash/tags')
      .set(...XRW)
      .send({ name: 'Salary', color: '#aabbcc' });
    expect(userTag.status).toBe(201);
    const userTagId = userTag.body.tag.id as string;

    const systemTagIds = (await capture(agent, portfolioId)).movements[0]!.tags ?? [];
    const tagged = await agent
      .put(`/api/v1/cash/movements/${movementId}/tags`)
      .set(...XRW)
      .send({ tagIds: [...systemTagIds, userTagId] });
    expect(tagged.status).toBe(200);

    const rule = await agent
      .post('/api/v1/cash/rules')
      .set(...XRW)
      .send({ tagIds: [userTagId], matchType: 'contains', pattern: 'salary', priority: 3 });
    expect(rule.status).toBe(201);

    const recurring = await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: userTagId, period: null, amount: 500 });
    expect(recurring.status).toBe(201);
    // The killer row: a budget for a month that is NOT the current one. The
    // per-month progress list can never surface it, so a capture built from that
    // list loses it — permanently, because enable hard-deletes it.
    const december = await agent
      .post('/api/v1/cash/budgets')
      .set(...XRW)
      .send({ portfolioId, tagId: userTagId, period: '2026-12', amount: 250 });
    expect(december.status).toBe(201);

    const captured = await capture(agent, portfolioId);
    expect(captured.tags.length).toBeGreaterThan(1);
    expect(captured.budgets.map((budget) => budget.period).sort()).toEqual(
      ['2026-12', null].sort(),
    );

    const enabled = await enable(agent, userId);
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);

    // The purge really happened: every cash-fusion table is empty server-side,
    // which is exactly why the document has to have carried them.
    const tagIds = captured.tags.map((tag) => tag.id);
    expect(await harness.db.select().from(cashTags).where(eq(cashTags.userId, userId))).toEqual([]);
    expect(await harness.db.select().from(cashRules).where(eq(cashRules.userId, userId))).toEqual(
      [],
    );
    expect(
      await harness.db
        .select()
        .from(cashMovementTags)
        .where(inArray(cashMovementTags.tagId, tagIds)),
    ).toEqual([]);
    expect(
      await harness.db.select().from(cashRuleTags).where(inArray(cashRuleTags.tagId, tagIds)),
    ).toEqual([]);
    expect(
      await harness.db.select().from(cashBudgets).where(inArray(cashBudgets.tagId, tagIds)),
    ).toEqual([]);

    const disabled = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send(restoreDocument(userId, captured));
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);

    // The user-visible comparison: the same reads, before and after.
    const restored = await capture(agent, portfolioId);
    expect(restored.tags).toEqual(captured.tags);
    expect(restored.rules).toEqual(captured.rules);
    expect(restored.budgets).toEqual(captured.budgets);
    expect(restored.movements.map((movement) => [...(movement.tags ?? [])].sort())).toEqual(
      captured.movements.map((movement) => [...(movement.tags ?? [])].sort()),
    );
    // Concretely: the movement still carries BOTH its system tag and the user's,
    // the auto-tagging rule still points at the user tag, and the December
    // budget — the row only the raw read could see — is back.
    expect(restored.movements[0]!.tags).toEqual(expect.arrayContaining([userTagId]));
    expect(restored.rules[0]).toMatchObject({ pattern: 'salary', tagIds: [userTagId] });
    expect(restored.budgets.find((budget) => budget.period === '2026-12')).toMatchObject({
      amount: 250,
    });
  });

  it('carries a claimed-but-unbooked standing-order period, so the engine never re-books it', async () => {
    const { agent, userId } = await seedAgent();
    const portfolioId = await defaultPortfolioId(agent);
    const funded = await agent
      .post(`/api/v1/portfolios/${portfolioId}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 1_000, executedAt: '2026-05-01T09:00:00.000Z' });
    expect(funded.status).toBe(201);

    const created = await agent
      .post('/api/v1/standing-orders')
      .set(...XRW)
      .send({
        portfolioId,
        kind: 'cash-add',
        amount: 100,
        cadence: 'monthly',
        anchorDay: 1,
        startDate: '2026-05-01',
        label: 'Salary',
      });
    expect(created.status).toBe(201);
    const orderId = created.body.id as string;

    // June books for real through the engine: claim → book → watermark.
    const june = await harness.ctx.standingOrders.processDueOrders({
      now: Date.parse('2026-06-02T05:00:00.000Z'),
    });
    expect(june).toMatchObject({ booked: 1 });

    // July is the case no watermark can express: `claimPeriod` wrote its row and
    // the booking afterwards failed, so the period is deliberately tombstoned
    // and never retried. This insert IS what `claimPeriod` writes.
    await harness.db
      .insert(standingOrderRuns)
      .values({ standingOrderId: orderId, periodKey: '2026-07-01' });

    const captured = await capture(agent, portfolioId);
    expect(captured.runs.map((run) => run.periodKey)).toEqual(['2026-06-01', '2026-07-01']);
    expect(captured.orders[0]).toMatchObject({ lastPeriodKey: '2026-06-01' });
    const ledgerBefore = captured.movements.length;

    const enabled = await enable(agent, userId);
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(
      await harness.db
        .select()
        .from(standingOrderRuns)
        .where(eq(standingOrderRuns.standingOrderId, orderId)),
    ).toEqual([]);

    const disabled = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send(restoreDocument(userId, captured));
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);

    const restored = await capture(agent, portfolioId);
    expect(restored.runs.map((run) => `${run.id}:${run.periodKey}`)).toEqual(
      captured.runs.map((run) => `${run.id}:${run.periodKey}`),
    );
    expect(restored.movements.length).toBe(ledgerBefore);

    // The payoff: with the claim back, the next scan finds July already claimed
    // and books nothing.
    const july = await harness.ctx.standingOrders.processDueOrders({
      now: Date.parse('2026-07-15T05:00:00.000Z'),
    });
    expect(july).toMatchObject({ booked: 0, skippedDuplicate: 1 });
    expect(
      await harness.db
        .select()
        .from(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, portfolioId)),
    ).toHaveLength(ledgerBefore);

    // …and that claim is the ONLY thing standing between the account and a
    // duplicate booking: drop it (which is what losing it on the round trip
    // does) and the very same scan books July's money a second time.
    await harness.db.delete(standingOrderRuns).where(eq(standingOrderRuns.periodKey, '2026-07-01'));
    const unguarded = await harness.ctx.standingOrders.processDueOrders({
      now: Date.parse('2026-07-15T05:00:00.000Z'),
    });
    expect(unguarded).toMatchObject({ booked: 1 });
    expect(
      await harness.db
        .select()
        .from(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, portfolioId)),
    ).toHaveLength(ledgerBefore + 1);
  });
});
