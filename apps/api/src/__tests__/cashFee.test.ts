import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CASH_SYSTEM_TAGS,
  cashMovementResponseSchema,
  cashMovementsResponseSchema,
  cashPreviewResponseSchema,
  cashMovementKindSchema,
  MIRROR_LEDGER_OP_KINDS,
  portfolioHistoryResponseSchema,
  type CashMovement,
  type CashSource,
} from '@bettertrack/contracts';
import { CASH_MOVEMENT_KINDS, isExternalCashMovement } from '@bettertrack/domain/cashLedger';

import * as schema from '../data/schema';
import { cashMovementKindEnum } from '../data/schema';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * The `fee` cash-movement kind (V5, §16 2026-07-30 — owner-signed deviation).
 *
 * A standing custody / account / platform fee is its own kind rather than a
 * `withdrawal`, because the two mean OPPOSITE things to the return series: a
 * withdrawal is money the owner took out (external, divided back out of the TWR
 * curve), a fee is what the portfolio costs to hold (internal, so it drags).
 * Before this kind existed, the only way to record a recurring custody fee was a
 * withdrawal — which reported a fee-eaten portfolio as if it performed exactly
 * like a fee-free one. That is the gap the return-series audit found.
 *
 * These tests state the intent end-to-end against the real server pipeline:
 *  - a fee DRAGS `performance[]` while an identical withdrawal does NOT;
 *  - the fee still leaves the account (balance + net-worth curve fall);
 *  - the sign is enforced at the domain, the service AND the Postgres CHECK;
 *  - the ledger is solvency-gated exactly like a withdrawal, per source;
 *  - ownership is scoped — a fee cannot be charged to someone else's portfolio;
 *  - the domain kind list, the wire enum and the Postgres enum all agree.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

/** ISO day `offset` days before today (UTC). */
function dayOffset(offset: number): string {
  const ms = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  return new Date(ms + offset * 86_400_000).toISOString().slice(0, 10);
}

/** ISO-8601 timestamp at UTC midnight of a day `offset` days before today. */
function tsOffset(offset: number): string {
  return `${dayOffset(offset)}T00:00:00.000Z`;
}

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

type Agent = ReturnType<typeof request.agent>;

/**
 * Seed a second account and sign it in. `seedUser()` defaults to ONE fixed
 * email/username, so every extra account in a test must name its own.
 */
async function seedAgent(
  h: TestHarness,
  slug: string,
): Promise<{ agent: Agent; portfolioId: string }> {
  const user = await h.seedUser({
    email: `${slug}@bettertrack.test`,
    username: `user-${slug}`,
  });
  const agent = await loginAgent(h.app, user.email, user.password);
  return { agent, portfolioId: await defaultPortfolioId(agent) };
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
  expect(def).toBeTruthy();
  return def.id as string;
}

interface CashEntryOpts {
  sourceId?: string;
  executedAt?: string;
  note?: string | null;
}

/** POST one of the three hand-entered cash actions and return the raw response. */
function postCash(
  agent: Agent,
  pid: string,
  action: 'deposit' | 'withdraw' | 'fee',
  amountEur: number,
  opts: CashEntryOpts = {},
) {
  return agent
    .post(`/api/v1/portfolios/${pid}/cash/${action}`)
    .set(...XRW)
    .send({ amountEur, ...opts });
}

/** POST expecting success, with the response contract validated. */
async function recordCash(
  agent: Agent,
  pid: string,
  action: 'deposit' | 'withdraw' | 'fee',
  amountEur: number,
  opts: CashEntryOpts = {},
) {
  const res = await postCash(agent, pid, action, amountEur, opts);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(cashMovementResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body as { movement: CashMovement; sourceBalanceEur: number; balanceEur: number };
}

async function cashState(agent: Agent, pid: string) {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash?limit=200`);
  expect(res.status).toBe(200);
  expect(cashMovementsResponseSchema.safeParse(res.body).success).toBe(true);
  const state = res.body as {
    balanceEur: number;
    movements: CashMovement[];
    sources: CashSource[];
  };
  // Business assertions below replay the ledger chronologically; wire ordering
  // is pinned separately by the cash pagination API test.
  state.movements.sort(
    (left, right) =>
      left.executedAt.localeCompare(right.executedAt) || left.id.localeCompare(right.id),
  );
  return state;
}

/** The `performance[]` percentages of `GET /history?range=MAX`, steady-state read. */
async function performanceVector(agent: Agent, pid: string): Promise<number[]> {
  // The first read after writes is the dirty-state snapshot-writer fallback; the
  // steady-state persisted path is the second read (mirrors vaultClientTwrParity).
  const warmup = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
  expect(warmup.status).toBe(200);
  const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
  expect(res.status).toBe(200);
  return (res.body.performance as Array<{ pct: number }>).map((p) => p.pct);
}

/** Value curve of `GET /history?range=MAX` — net worth per day (#311). */
async function valueVector(agent: Agent, pid: string): Promise<number[]> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
  expect(res.status).toBe(200);
  expect(portfolioHistoryResponseSchema.safeParse(res.body).success).toBe(true);
  return (res.body.points as Array<{ valueEur: number }>).map((p) => p.valueEur);
}

describe('cash `fee` kind (§16 2026-07-30)', () => {
  let h: TestHarness;
  let agent: Agent;
  let pid: string;

  beforeEach(async () => {
    h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    agent = await loginAgent(h.app, user.email, user.password);
    pid = await defaultPortfolioId(agent);
  });

  // --- Classification agreement --------------------------------------------

  it('the domain kind list, the wire enum and the Postgres enum all carry `fee`', () => {
    // Three copies of one fact, and the audit found a real bug precisely because
    // two copies of a cash predicate had drifted. This is the only place all
    // three are importable, so it is where the agreement is asserted.
    const domain = [...CASH_MOVEMENT_KINDS].sort();
    expect([...cashMovementKindSchema.options].sort()).toEqual(domain);
    expect([...cashMovementKindEnum.enumValues].sort()).toEqual(domain);
    expect(domain).toContain('fee');
  });

  it('is NOT an external flow, unlike a withdrawal', () => {
    expect(isExternalCashMovement('fee')).toBe(false);
    expect(isExternalCashMovement('withdrawal')).toBe(true);
  });

  it('replicates as its own MIRRORCHAIN op rather than as a withdrawal', () => {
    // A fee is TWR-internal but ORIGIN-entered: a member typed it, so it must
    // replicate. Replicating it as `cash.withdraw` would have restored the exact
    // misreport on every copy but the origin.
    expect(MIRROR_LEDGER_OP_KINDS).toContain('cash.fee');
  });

  // --- Booking, reading, and the ledger ------------------------------------

  it('books a negative movement of kind `fee` and lowers the balance', async () => {
    await recordCash(agent, pid, 'deposit', 1000, { executedAt: tsOffset(-5) });
    const charged = await recordCash(agent, pid, 'fee', 12.5, {
      executedAt: tsOffset(-3),
      note: 'Quarterly custody fee',
    });

    expect(charged.movement.kind).toBe('fee');
    // Positive magnitude on the wire, negative amount in the ledger.
    expect(charged.movement.amountEur).toBeCloseTo(-12.5, 6);
    expect(charged.movement.note).toBe('Quarterly custody fee');
    expect(charged.balanceEur).toBeCloseTo(987.5, 6);
    expect(charged.sourceBalanceEur).toBeCloseTo(987.5, 6);
    // A fee is standalone: never linked to a transaction, dividend, transfer or
    // tax year (the trade fee that rides a transaction is a different thing).
    expect(charged.movement.transactionId).toBeNull();
    expect(charged.movement.dividendId).toBeNull();
    expect(charged.movement.transferId).toBeNull();
    expect(charged.movement.taxYear).toBeNull();
  });

  it('reads back through GET /cash like any other movement', async () => {
    await recordCash(agent, pid, 'deposit', 500, { executedAt: tsOffset(-4) });
    await recordCash(agent, pid, 'fee', 5, { executedAt: tsOffset(-2) });
    const state = await cashState(agent, pid);
    expect(state.balanceEur).toBeCloseTo(495, 6);
    expect(state.movements.map((m) => m.kind)).toEqual(['deposit', 'fee']);
  });

  it('is quantized to whole cents like every other cash amount (#322)', async () => {
    await recordCash(agent, pid, 'deposit', 100, { executedAt: tsOffset(-4) });
    // Floors the MAGNITUDE toward zero, so the fee deducted is never more than
    // what was entered: 1.006 → 1.00.
    const charged = await recordCash(agent, pid, 'fee', 1.006, { executedAt: tsOffset(-2) });
    expect(charged.movement.amountEur).toBeCloseTo(-1, 6);
    expect(charged.balanceEur).toBeCloseTo(99, 6);
  });

  // --- Sign enforcement, at all three layers -------------------------------

  it('rejects a negative magnitude at the contract boundary', async () => {
    const res = await postCash(agent, pid, 'fee', -12.5);
    expect(res.status).toBe(400);
  });

  it('rejects a zero fee — the ledger never stores a no-op movement', async () => {
    const res = await postCash(agent, pid, 'fee', 0);
    expect(res.status).toBe(400);
  });

  it('the Postgres CHECK refuses a POSITIVE fee even if the service is bypassed', async () => {
    // Defense in depth: a positive fee would LIFT the return instead of dragging
    // it, so the DB must reject it independently of the service's sign logic.
    await recordCash(agent, pid, 'deposit', 100, { executedAt: tsOffset(-4) });
    const [source] = await h.db
      .select()
      .from(schema.portfolioCashSources)
      .where(eq(schema.portfolioCashSources.portfolioId, pid));
    expect(source).toBeTruthy();

    await expect(
      h.db.insert(schema.portfolioCashMovements).values({
        portfolioId: pid,
        sourceId: source!.id,
        kind: 'fee',
        amountEur: '5',
        executedAt: new Date(tsOffset(-2)),
        note: 'a fee that pays you is not a fee',
      }),
    ).rejects.toThrow(/portfolio_cash_movements_sign/);
  });

  it('the Postgres CHECK refuses a fee linked to a transaction or a dividend', async () => {
    // A per-trade fee already rides the transaction's cost basis, so a `fee` row
    // pointing at a trade would count the same cost twice.
    //
    // The deposit is not decoration: Main is materialised on FIRST CASH TOUCH
    // (V3-P3), so a portfolio that has never seen a movement has no source row to
    // attach the raw insert to.
    await recordCash(agent, pid, 'deposit', 100, { executedAt: tsOffset(-5) });
    const [source] = await h.db
      .select()
      .from(schema.portfolioCashSources)
      .where(eq(schema.portfolioCashSources.portfolioId, pid));
    expect(source).toBeTruthy();
    const [asset] = await h.db
      .insert(schema.assets)
      .values({
        providerId: 'yahoo',
        providerRef: 'FEE.DE',
        type: 'stock',
        symbol: 'FEE.DE',
        name: 'Fee fixture asset',
        currency: 'EUR',
        exchange: 'XETRA',
      })
      .returning();
    const [txn] = await h.db
      .insert(schema.transactions)
      .values({
        portfolioId: pid,
        assetId: asset!.id,
        side: 'buy',
        quantity: '1',
        price: '10',
        fee: '0',
        executedAt: new Date(tsOffset(-4)),
      })
      .returning();

    await expect(
      h.db.insert(schema.portfolioCashMovements).values({
        portfolioId: pid,
        sourceId: source!.id,
        kind: 'fee',
        amountEur: '-1',
        transactionId: txn!.id,
        executedAt: new Date(tsOffset(-2)),
      }),
    ).rejects.toThrow(/portfolio_cash_movements_fee_standalone/);
  });

  // --- Solvency, per source ------------------------------------------------

  it('rejects a fee that would overdraw the source (400 INSUFFICIENT_CASH)', async () => {
    await recordCash(agent, pid, 'deposit', 10, { executedAt: tsOffset(-4) });
    const res = await postCash(agent, pid, 'fee', 25, { executedAt: tsOffset(-2) });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('INSUFFICIENT_CASH');
  });

  it('is gated per source: another source cannot cover it (V3-P3)', async () => {
    const created = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources`)
      .set(...XRW)
      .send({ name: 'Broker', type: 'bank' });
    expect(created.status).toBe(201);
    const brokerId = created.body.source.id as string;
    // Money sits in Main; the fee is charged to Broker, which holds nothing.
    await recordCash(agent, pid, 'deposit', 1000, { executedAt: tsOffset(-4) });
    const res = await postCash(agent, pid, 'fee', 5, {
      sourceId: brokerId,
      executedAt: tsOffset(-2),
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('INSUFFICIENT_CASH');
  });

  it('previews like any other outflow, and the preview matches what gets booked', async () => {
    await recordCash(agent, pid, 'deposit', 100, { executedAt: tsOffset(-4) });
    const preview = await agent
      .post(`/api/v1/portfolios/${pid}/cash/preview`)
      .set(...XRW)
      .send({ kind: 'fee', amountEur: 12.5 });
    expect(preview.status).toBe(200);
    expect(cashPreviewResponseSchema.safeParse(preview.body).success).toBe(true);
    expect(preview.body.availableEur).toBeCloseTo(100, 6);
    expect(preview.body.afterEur).toBeCloseTo(87.5, 6);
    expect(preview.body.sufficient).toBe(true);

    const charged = await recordCash(agent, pid, 'fee', 12.5, { executedAt: tsOffset(-2) });
    expect(charged.sourceBalanceEur).toBeCloseTo(preview.body.afterEur, 6);
  });

  // --- Ownership scoping ---------------------------------------------------

  it('cannot charge a fee to another account’s portfolio', async () => {
    const { agent: otherAgent, portfolioId: otherPid } = await seedAgent(h, 'victim');
    expect(otherPid).not.toBe(pid);

    const res = await postCash(agent, otherPid, 'fee', 5);
    // Ownership is scoped in the repository, and a foreign portfolio is a
    // not-found rather than a forbidden — never a partial write.
    expect(res.status).toBe(404);
    // Nothing landed on the victim's ledger.
    const state = await cashState(otherAgent, otherPid);
    expect(state.movements).toHaveLength(0);
    expect(state.balanceEur).toBeCloseTo(0, 6);
  });

  it('requires an authenticated caller', async () => {
    const anon = request(h.app);
    const res = await anon
      .post(`/api/v1/portfolios/${pid}/cash/fee`)
      .set(...XRW)
      .send({ amountEur: 5 });
    expect(res.status).toBe(401);
  });

  // --- The whole point: a fee DRAGS the return -----------------------------

  it('DRAGS the return series, while an identical withdrawal does not', async () => {
    // Two accounts, identical cash-only ledgers except for the KIND of the 100 €
    // that leaves on the same day. Cash-only keeps the market out of it, so the
    // whole difference in `performance[]` is the classification under test.
    //
    //   deposit 1000 on day −5, then 100 leaves on day −3.
    //
    // As a FEE (internal): the value curve drops 1000 → 900 with no flow, so the
    // day's factor is 900/1000 ⇒ −10 % that persists to the end of the series.
    // As a WITHDRAWAL (external): the −100 flow is divided back out —
    // (900 − (−100))/1000 = 1 ⇒ 0 %, a flat curve. Same money gone, opposite
    // reported performance. That contrast is the reason the kind exists.
    const { agent: feeAgent, portfolioId: feePid } = await seedAgent(h, 'charged');
    await recordCash(feeAgent, feePid, 'deposit', 1000, { executedAt: tsOffset(-5) });
    await recordCash(feeAgent, feePid, 'fee', 100, { executedAt: tsOffset(-3) });

    const { agent: wdAgent, portfolioId: wdPid } = await seedAgent(h, 'withdrawn');
    await recordCash(wdAgent, wdPid, 'deposit', 1000, { executedAt: tsOffset(-5) });
    await recordCash(wdAgent, wdPid, 'withdraw', 100, { executedAt: tsOffset(-3) });

    const feePct = await performanceVector(feeAgent, feePid);
    const wdPct = await performanceVector(wdAgent, wdPid);

    // Same grid, so the vectors are directly comparable.
    expect(feePct).toHaveLength(wdPct.length);
    expect(feePct.length).toBeGreaterThanOrEqual(5);

    // The withdrawal is neutralised out: flat all the way through.
    for (const pct of wdPct) expect(pct).toBeCloseTo(0, 9);

    // The fee is inside the curve: flat until it lands, then −10 % and held.
    expect(feePct[0]).toBeCloseTo(0, 9);
    expect(feePct[1]).toBeCloseTo(0, 9);
    expect(feePct.at(-1)).toBeCloseTo(-10, 9);
    // The headline assertion of the whole change.
    expect(feePct.at(-1)!).toBeLessThan(wdPct.at(-1)!);

    // …and the money really left in BOTH cases: internal-for-TWR does not mean
    // invisible. Net worth ends at 900 either way.
    expect((await valueVector(feeAgent, feePid)).at(-1)).toBeCloseTo(900, 6);
    expect((await valueVector(wdAgent, wdPid)).at(-1)).toBeCloseTo(900, 6);
    expect((await cashState(feeAgent, feePid)).balanceEur).toBeCloseTo(900, 6);
  });

  it('a fee-charged portfolio underperforms an otherwise identical fee-free one', async () => {
    // The user-facing statement of the same fact, without a withdrawal anywhere:
    // charge a fee and the curve is strictly below the untouched one.
    const { agent: cleanAgent, portfolioId: cleanPid } = await seedAgent(h, 'feefree');
    await recordCash(cleanAgent, cleanPid, 'deposit', 1000, { executedAt: tsOffset(-5) });

    await recordCash(agent, pid, 'deposit', 1000, { executedAt: tsOffset(-5) });
    await recordCash(agent, pid, 'fee', 25, { executedAt: tsOffset(-3) });

    const cleanPct = await performanceVector(cleanAgent, cleanPid);
    const feePct = await performanceVector(agent, pid);
    expect(cleanPct.at(-1)).toBeCloseTo(0, 9);
    expect(feePct.at(-1)).toBeCloseTo(-2.5, 9);
    expect(feePct.at(-1)!).toBeLessThan(cleanPct.at(-1)!);
  });

  it('two fees compound within the curve rather than summing linearly', async () => {
    // Chain-linking is the whole reason `performance[]` is a TWR: 1000 → 900 → 810
    // is 0.9 × 0.9 = −19 %, not −20 %. A fee therefore behaves like every other
    // in-curve movement, which is what makes it a genuine cost of holding.
    await recordCash(agent, pid, 'deposit', 1000, { executedAt: tsOffset(-5) });
    await recordCash(agent, pid, 'fee', 100, { executedAt: tsOffset(-4) });
    await recordCash(agent, pid, 'fee', 90, { executedAt: tsOffset(-3) });
    const pct = await performanceVector(agent, pid);
    expect(pct.at(-1)).toBeCloseTo(-19, 9);
    expect((await cashState(agent, pid)).balanceEur).toBeCloseTo(810, 6);
  });

  it('a back-dated fee reshapes the curve from its own day on (§16 rule 4)', async () => {
    // Snapshot invalidation must run from the fee's day, not from today: a fee
    // entered late for last month has to re-derive that month's performance.
    await recordCash(agent, pid, 'deposit', 1000, { executedAt: tsOffset(-6) });
    const before = await performanceVector(agent, pid);
    for (const pct of before) expect(pct).toBeCloseTo(0, 9);

    // Now back-date a fee into the middle of the already-persisted curve.
    await recordCash(agent, pid, 'fee', 100, { executedAt: tsOffset(-4) });
    const after = await performanceVector(agent, pid);
    expect(after).toHaveLength(before.length);
    // Flat before the fee day, −10 % from it on — the persisted rows were redone.
    expect(after[0]).toBeCloseTo(0, 9);
    expect(after[1]).toBeCloseTo(0, 9);
    expect(after.at(-1)).toBeCloseTo(-10, 9);
  });

  // --- Cash-fusion tagging: deferred, and the seed proves it is reachable ----

  it('carries the `fees` system tag — the checkpoint phase 2 was built to flip', async () => {
    // This was pinned as UNLINKED while the fee kind and the tagging engine were
    // two parallel branches: `cash_tags` / `cash_movement_tags` existed as schema
    // only, so a booked fee could not be labelled and saying so was better than
    // half-building the seed. Phase 2 landed the engine, the system-tag seeding
    // for accounts created after migration 0076, and `SYSTEM_TAG_FOR_KIND` — an
    // exhaustive map, so adding `fee` to the kind enum was a COMPILE ERROR until
    // someone wrote the mapping. This is the other half of that tripwire: the
    // label now has to be there, and it has to be the `fees` one specifically.
    const { agent: fresh, portfolioId: freshPid } = await seedAgent(h, 'tagcheck');
    await recordCash(fresh, freshPid, 'deposit', 100, { executedAt: tsOffset(-4) });
    const charged = await recordCash(fresh, freshPid, 'fee', 5, { executedAt: tsOffset(-2) });

    const links = await h.db
      .select({ systemKey: schema.cashTags.systemKey })
      .from(schema.cashMovementTags)
      .innerJoin(schema.cashTags, eq(schema.cashMovementTags.tagId, schema.cashTags.id))
      .where(eq(schema.cashMovementTags.movementId, charged.movement.id));

    expect(links.map((row) => row.systemKey)).toEqual(['fees']);
    expect(CASH_SYSTEM_TAGS.map((t) => t.key)).toContain('fees');
  });
});
