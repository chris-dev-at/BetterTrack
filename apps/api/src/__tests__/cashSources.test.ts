import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  cashMovementResponseSchema,
  cashMovementsResponseSchema,
  cashPreviewResponseSchema,
  cashSourceListResponseSchema,
  cashSourceResponseSchema,
  cashTransferResponseSchema,
  setCashBalanceResponseSchema,
  type CashMovement,
  type CashSource,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createCashMovementRepository } from '../data/repositories/cashMovementRepository';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * V3-P3 cash sources (issue #326): source CRUD + archive rules, atomic paired
 * transfers, set-balance, source-scoped deposit/withdraw/buy/sell with
 * per-source solvency, and the TWR/net-worth invariants around them.
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

async function defaultPortfolioId(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
  expect(def).toBeTruthy();
  return def.id as string;
}

type Agent = ReturnType<typeof request.agent>;

/** List the sources (archived included) and index them for assertions. */
async function cashSources(agent: Agent, pid: string): Promise<CashSource[]> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash/sources?includeArchived=true`);
  expect(res.status).toBe(200);
  expect(cashSourceListResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body.sources as CashSource[];
}

/** The auto-provisioned Main source of a portfolio. */
async function mainSource(agent: Agent, pid: string): Promise<CashSource> {
  const sources = await cashSources(agent, pid);
  const main = sources.find((s) => s.isMain);
  expect(main).toBeTruthy();
  return main!;
}

/** Create a named source and return it. */
async function createSource(
  agent: Agent,
  pid: string,
  name: string,
  type = 'bank',
): Promise<CashSource> {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/cash/sources`)
    .set(...XRW)
    .send({ name, type });
  expect(res.status).toBe(201);
  expect(cashSourceResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body.source as CashSource;
}

/** GET /cash — the full ledger state (movements + sources + roll-up). */
async function cashState(agent: Agent, pid: string) {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash`);
  expect(res.status).toBe(200);
  expect(cashMovementsResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body as {
    balanceEur: number;
    movements: CashMovement[];
    sources: CashSource[];
  };
}

async function deposit(
  agent: Agent,
  pid: string,
  amountEur: number,
  opts: { sourceId?: string; executedAt?: string } = {},
) {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/cash/deposit`)
    .set(...XRW)
    .send({ amountEur, ...opts });
  expect(res.status).toBe(201);
  expect(cashMovementResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body;
}

async function seedEurAsset(h: TestHarness) {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: 'BAYN.DE',
      type: 'stock',
      symbol: 'BAYN.DE',
      name: 'Bayer AG',
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

// ─── Source CRUD + archive rules ─────────────────────────────────────────────

describe('cash sources — CRUD', () => {
  it('materialises Main on first touch and lists it first with a €0.00 balance', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    const res = await agent.get(`/api/v1/portfolios/${pid}/cash/sources`);
    expect(res.status).toBe(200);
    expect(cashSourceListResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0]).toMatchObject({
      name: 'Main',
      type: 'cash',
      isMain: true,
      archivedAt: null,
      balanceEur: 0,
    });
  });

  it('creates named sources with type labels, Main stays first', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    const bank = await createSource(agent, pid, 'Bank account X', 'bank');
    expect(bank).toMatchObject({ name: 'Bank account X', type: 'bank', isMain: false });
    await createSource(agent, pid, 'Retirement fund Y', 'retirement');

    const sources = await cashSources(agent, pid);
    expect(sources.map((s) => s.name)).toEqual(['Main', 'Bank account X', 'Retirement fund Y']);
    expect(sources[0]?.isMain).toBe(true);
  });

  it('rejects duplicate names with a 409 (including the reserved "Main")', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    await createSource(agent, pid, 'Bank');

    const dup = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources`)
      .set(...XRW)
      .send({ name: 'Bank', type: 'custom' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CASH_SOURCE_NAME_TAKEN');

    const main = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources`)
      .set(...XRW)
      .send({ name: 'Main', type: 'cash' });
    expect(main.status).toBe(409);
  });

  it('renames and relabels a source; rename collisions 409', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const bank = await createSource(agent, pid, 'Bank');
    await createSource(agent, pid, 'Wallet', 'cash');

    const renamed = await agent
      .patch(`/api/v1/portfolios/${pid}/cash/sources/${bank.id}`)
      .set(...XRW)
      .send({ name: 'Sparkasse', type: 'custom' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.source).toMatchObject({ name: 'Sparkasse', type: 'custom' });

    const collision = await agent
      .patch(`/api/v1/portfolios/${pid}/cash/sources/${bank.id}`)
      .set(...XRW)
      .send({ name: 'Wallet' });
    expect(collision.status).toBe(409);

    // A no-op re-save of the current name passes.
    const noop = await agent
      .patch(`/api/v1/portfolios/${pid}/cash/sources/${bank.id}`)
      .set(...XRW)
      .send({ name: 'Sparkasse' });
    expect(noop.status).toBe(200);
  });

  it('scopes sources to the owning user: a foreign source id is a 404', async () => {
    const owner = await harness.seedUser();
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const ownerPid = await defaultPortfolioId(ownerAgent);
    const source = await createSource(ownerAgent, ownerPid, 'Bank');

    const other = await harness.seedUser({ email: 'other@bettertrack.test', username: 'other' });
    const otherAgent = await loginAgent(harness.app, other.email, other.password);
    const otherPid = await defaultPortfolioId(otherAgent);

    // The other user probes the owner's portfolio (404 on the portfolio) and
    // the owner's source id inside their own portfolio (404 on the source).
    const probePortfolio = await otherAgent
      .patch(`/api/v1/portfolios/${ownerPid}/cash/sources/${source.id}`)
      .set(...XRW)
      .send({ name: 'X' });
    expect(probePortfolio.status).toBe(404);

    const probeSource = await otherAgent
      .patch(`/api/v1/portfolios/${otherPid}/cash/sources/${source.id}`)
      .set(...XRW)
      .send({ name: 'X' });
    expect(probeSource.status).toBe(404);
    expect(probeSource.body.error.code).toBe('CASH_SOURCE_NOT_FOUND');
  });
});

describe('cash sources — archive/restore rules (§16 log: Main never; only €0.00)', () => {
  it('archives an empty source out of active listings, keeps history queryable, restores', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const bank = await createSource(agent, pid, 'Bank');

    // Give it history that nets to exactly zero, then archive.
    await deposit(agent, pid, 250.1, { sourceId: bank.id });
    const withdraw = await agent
      .post(`/api/v1/portfolios/${pid}/cash/withdraw`)
      .set(...XRW)
      .send({ amountEur: 250.1, sourceId: bank.id });
    expect(withdraw.status).toBe(201);
    // Withdraw-all on a named source lands at exactly €0.00 (#322 invariant).
    expect(withdraw.body.sourceBalanceEur).toBe(0);

    const archived = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources/${bank.id}/archive`)
      .set(...XRW)
      .send();
    expect(archived.status).toBe(200);
    expect(archived.body.source.archivedAt).not.toBeNull();

    // Out of the active listing…
    const active = await agent.get(`/api/v1/portfolios/${pid}/cash/sources`);
    expect(active.body.sources.map((s: CashSource) => s.name)).toEqual(['Main']);
    // …but still present with includeArchived, and its movements stay in the
    // ledger response (queryable history).
    const all = await cashSources(agent, pid);
    expect(all.map((s) => s.name)).toEqual(['Main', 'Bank']);
    const state = await cashState(agent, pid);
    expect(state.movements.filter((m) => m.sourceId === bank.id)).toHaveLength(2);

    // Archived sources accept no new movements.
    const blocked = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 10, sourceId: bank.id });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('CASH_SOURCE_ARCHIVED');

    // Restore brings it back.
    const restored = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources/${bank.id}/restore`)
      .set(...XRW)
      .send();
    expect(restored.status).toBe(200);
    expect(restored.body.source.archivedAt).toBeNull();
    await deposit(agent, pid, 10, { sourceId: bank.id });
  });

  it('never archives Main, and never a source holding money', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const main = await mainSource(agent, pid);
    const bank = await createSource(agent, pid, 'Bank');
    await deposit(agent, pid, 0.01, { sourceId: bank.id });

    const mainRes = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources/${main.id}/archive`)
      .set(...XRW)
      .send();
    expect(mainRes.status).toBe(400);
    expect(mainRes.body.error.code).toBe('CASH_SOURCE_IS_MAIN');

    const nonEmpty = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources/${bank.id}/archive`)
      .set(...XRW)
      .send();
    expect(nonEmpty.status).toBe(400);
    expect(nonEmpty.body.error.code).toBe('CASH_SOURCE_NOT_EMPTY');
  });
});

// ─── Transfers ───────────────────────────────────────────────────────────────

describe('cash transfers — atomic double-entry pairs', () => {
  it('500 € Main→Bank: paired movements in both histories, net worth unchanged', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const main = await mainSource(agent, pid);
    const bank = await createSource(agent, pid, 'Bank');
    await deposit(agent, pid, 1000);

    // Net worth (the headline totals figure) before the transfer.
    const overviewBefore = await agent.get(`/api/v1/portfolios/${pid}`);
    expect(overviewBefore.body.totals.totalValueEur).toBe(1000);

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/cash/transfer`)
      .set(...XRW)
      .send({ fromSourceId: main.id, toSourceId: bank.id, amountEur: 500 });
    expect(res.status).toBe(201);
    expect(cashTransferResponseSchema.safeParse(res.body).success).toBe(true);

    // Double-entry: two mirrored legs sharing one transferId, each naming the
    // other side, on their respective sources.
    expect(res.body.outgoing).toMatchObject({
      kind: 'transfer_out',
      amountEur: -500,
      sourceId: main.id,
      counterpartSourceId: bank.id,
    });
    expect(res.body.incoming).toMatchObject({
      kind: 'transfer_in',
      amountEur: 500,
      sourceId: bank.id,
      counterpartSourceId: main.id,
    });
    expect(res.body.outgoing.transferId).toBe(res.body.incoming.transferId);
    expect(res.body.outgoing.transferId).not.toBeNull();
    expect(res.body.fromBalanceEur).toBe(500);
    expect(res.body.toBalanceEur).toBe(500);
    // The roll-up is unchanged — money only moved inside the portfolio.
    expect(res.body.balanceEur).toBe(1000);

    // Both source histories carry their leg.
    const state = await cashState(agent, pid);
    expect(state.movements.filter((m) => m.sourceId === main.id).map((m) => m.kind)).toEqual([
      'deposit',
      'transfer_out',
    ]);
    expect(state.movements.filter((m) => m.sourceId === bank.id).map((m) => m.kind)).toEqual([
      'transfer_in',
    ]);
    expect(state.balanceEur).toBe(1000);

    // Net worth is unchanged by the transfer.
    const overviewAfter = await agent.get(`/api/v1/portfolios/${pid}`);
    expect(overviewAfter.body.totals.totalValueEur).toBe(1000);
    expect(overviewAfter.body.totals.cashEur).toBe(1000);
  });

  it('rejects overdraws per source, same-source transfers and archived endpoints', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const main = await mainSource(agent, pid);
    const bank = await createSource(agent, pid, 'Bank');
    const empty = await createSource(agent, pid, 'Empty', 'custom');
    await deposit(agent, pid, 100);

    // More than Main holds — rejected even though the portfolio's roll-up
    // could not go negative (the pair nets to zero).
    const overdraw = await agent
      .post(`/api/v1/portfolios/${pid}/cash/transfer`)
      .set(...XRW)
      .send({ fromSourceId: main.id, toSourceId: bank.id, amountEur: 500 });
    expect(overdraw.status).toBe(400);
    expect(overdraw.body.error.code).toBe('INSUFFICIENT_CASH');

    const same = await agent
      .post(`/api/v1/portfolios/${pid}/cash/transfer`)
      .set(...XRW)
      .send({ fromSourceId: main.id, toSourceId: main.id, amountEur: 10 });
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('CASH_TRANSFER_SAME_SOURCE');

    await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources/${empty.id}/archive`)
      .set(...XRW)
      .send();
    const toArchived = await agent
      .post(`/api/v1/portfolios/${pid}/cash/transfer`)
      .set(...XRW)
      .send({ fromSourceId: main.id, toSourceId: empty.id, amountEur: 10 });
    expect(toArchived.status).toBe(400);
    expect(toArchived.body.error.code).toBe('CASH_SOURCE_ARCHIVED');

    // Nothing was booked by any rejected attempt.
    const state = await cashState(agent, pid);
    expect(state.movements).toHaveLength(1);
    expect(state.balanceEur).toBe(100);
  });

  it('a mid-transfer failure leaves neither movement behind (single-statement pair)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const main = await mainSource(agent, pid);
    const bank = await createSource(agent, pid, 'Bank');
    await deposit(agent, pid, 1000);

    // Drive the repository directly with a pair whose SECOND leg violates the
    // sign CHECK — the one-statement insert must roll back the first leg too.
    const repo = createCashMovementRepository(harness.db);
    const executedAt = new Date();
    await expect(
      repo.insertTransferPair(pid, [
        {
          sourceId: main.id,
          kind: 'transfer_out',
          amountEur: -500,
          executedAt,
          note: null,
          transferId: '11111111-1111-7111-8111-111111111111',
          counterpartSourceId: bank.id,
        },
        {
          sourceId: bank.id,
          kind: 'transfer_in',
          amountEur: -500, // sign contradicts the kind → CHECK violation
          executedAt,
          note: null,
          transferId: '11111111-1111-7111-8111-111111111111',
          counterpartSourceId: main.id,
        },
      ]),
    ).rejects.toThrow();

    const state = await cashState(agent, pid);
    expect(state.movements.map((m) => m.kind)).toEqual(['deposit']);
    expect(state.balanceEur).toBe(1000);
  });
});

// ─── Set balance ─────────────────────────────────────────────────────────────

describe('set balance to X (§16 2026-07-07)', () => {
  it('€123.45 → €200.00 records a single +€76.55 movement; balance reads exactly €200.00', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const bank = await createSource(agent, pid, 'Bank');
    await deposit(agent, pid, 123.45, { sourceId: bank.id });

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources/${bank.id}/set-balance`)
      .set(...XRW)
      .send({ balanceEur: 200.0 });
    expect(res.status).toBe(200);
    expect(setCashBalanceResponseSchema.safeParse(res.body).success).toBe(true);
    // One normal movement carrying the app-computed signed delta.
    expect(res.body.deltaEur).toBe(76.55);
    expect(res.body.movement).toMatchObject({
      kind: 'deposit',
      amountEur: 76.55,
      sourceId: bank.id,
      transferId: null,
    });
    expect(res.body.sourceBalanceEur).toBe(200);

    const state = await cashState(agent, pid);
    expect(state.movements.filter((m) => m.sourceId === bank.id)).toHaveLength(2);
    expect(state.sources.find((s) => s.id === bank.id)?.balanceEur).toBe(200);
  });

  it('negative deltas work symmetrically (€200.00 → €123.45 books −€76.55)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const bank = await createSource(agent, pid, 'Bank');
    await deposit(agent, pid, 200.0, { sourceId: bank.id });

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources/${bank.id}/set-balance`)
      .set(...XRW)
      .send({ balanceEur: 123.45 });
    expect(res.status).toBe(200);
    expect(res.body.deltaEur).toBe(-76.55);
    expect(res.body.movement).toMatchObject({ kind: 'withdrawal', amountEur: -76.55 });
    expect(res.body.sourceBalanceEur).toBe(123.45);
  });

  it('set to €0.00 is a full withdraw-all landing at exactly zero', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const main = await mainSource(agent, pid);
    await deposit(agent, pid, 123.45);

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources/${main.id}/set-balance`)
      .set(...XRW)
      .send({ balanceEur: 0 });
    expect(res.status).toBe(200);
    expect(res.body.movement).toMatchObject({ kind: 'withdrawal', amountEur: -123.45 });
    expect(res.body.sourceBalanceEur).toBe(0);
    expect(Object.is(res.body.sourceBalanceEur, 0)).toBe(true);
    expect(res.body.balanceEur).toBe(0);
  });

  it('a no-op target records nothing', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const main = await mainSource(agent, pid);
    await deposit(agent, pid, 200);

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources/${main.id}/set-balance`)
      .set(...XRW)
      .send({ balanceEur: 200 });
    expect(res.status).toBe(200);
    expect(res.body.movement).toBeNull();
    expect(res.body.deltaEur).toBe(0);

    const state = await cashState(agent, pid);
    expect(state.movements).toHaveLength(1);
  });

  it('rejects a negative target at the contract and archived sources at the service', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const bank = await createSource(agent, pid, 'Bank');

    const negative = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources/${bank.id}/set-balance`)
      .set(...XRW)
      .send({ balanceEur: -5 });
    expect(negative.status).toBe(400);

    await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources/${bank.id}/archive`)
      .set(...XRW)
      .send();
    const archived = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources/${bank.id}/set-balance`)
      .set(...XRW)
      .send({ balanceEur: 100 });
    expect(archived.status).toBe(400);
    expect(archived.body.error.code).toBe('CASH_SOURCE_ARCHIVED');
  });
});

// ─── Source-scoped flows: deposit / withdraw / preview / buy / sell ──────────

describe('source-scoped cash flows', () => {
  it('deposits default to Main; an explicit sourceId lands the movement there', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const main = await mainSource(agent, pid);
    const bank = await createSource(agent, pid, 'Bank');

    const toMain = await deposit(agent, pid, 100);
    expect(toMain.movement.sourceId).toBe(main.id);
    const toBank = await deposit(agent, pid, 200, { sourceId: bank.id });
    expect(toBank.movement.sourceId).toBe(bank.id);
    expect(toBank.sourceBalanceEur).toBe(200);
    expect(toBank.balanceEur).toBe(300);

    // Net worth + liquidity roll up all sources.
    const overview = await agent.get(`/api/v1/portfolios/${pid}`);
    expect(overview.body.totals.cashEur).toBe(300);
    expect(overview.body.totals.totalValueEur).toBe(300);
    const state = await cashState(agent, pid);
    expect(state.sources.map((s) => s.balanceEur)).toEqual([100, 200]);
  });

  it('solvency is per source: a rich Main cannot cover a poor Bank', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const bank = await createSource(agent, pid, 'Bank');
    await deposit(agent, pid, 10_000); // Main is rich
    await deposit(agent, pid, 100, { sourceId: bank.id });

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/cash/withdraw`)
      .set(...XRW)
      .send({ amountEur: 150, sourceId: bank.id });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INSUFFICIENT_CASH');
    expect(res.body.error.details.availableEur).toBe(100);
    expect(res.body.error.details.shortfallEur).toBe(50);

    // The preview mirrors the per-source gate.
    const preview = await agent
      .post(`/api/v1/portfolios/${pid}/cash/preview`)
      .set(...XRW)
      .send({ kind: 'withdrawal', amountEur: 150, sourceId: bank.id });
    expect(preview.status).toBe(200);
    expect(cashPreviewResponseSchema.safeParse(preview.body).success).toBe(true);
    expect(preview.body).toMatchObject({
      availableEur: 100,
      afterEur: -50,
      sufficient: false,
      shortfallEur: 50,
    });
  });

  it('per-source reconciliation holds after a cash-funded buy from a named source', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedEurAsset(h);
    const main = await mainSource(agent, pid);
    const bank = await createSource(agent, pid, 'Bank');
    // Funded BEFORE the buy below — the per-source replay is chronological.
    await deposit(agent, pid, 5000, { executedAt: tsOffset(-2) }); // rich Main must NOT be touched
    await deposit(agent, pid, 1000, { sourceId: bank.id, executedAt: tsOffset(-2) });

    const buy = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'buy',
        quantity: 4,
        price: 100,
        executedAt: tsOffset(-1),
        payFromCash: true,
        cashSourceId: bank.id,
      });
    expect(buy.status).toBe(201);

    const state = await cashState(agent, pid);
    const bankMovements = state.movements.filter((m) => m.sourceId === bank.id);
    expect(bankMovements.map((m) => m.kind)).toEqual(['deposit', 'buy']);
    expect(bankMovements.find((m) => m.kind === 'buy')?.amountEur).toBe(-400);
    // Reconciliation: the source balance equals the sum of ITS movements…
    const bankSum = bankMovements.reduce((sum, m) => sum + m.amountEur, 0);
    const bankBalance = state.sources.find((s) => s.id === bank.id)?.balanceEur;
    expect(bankBalance).toBe(600);
    expect(bankSum).toBe(600);
    // …and Main is untouched.
    expect(state.sources.find((s) => s.id === main.id)?.balanceEur).toBe(5000);
    expect(state.balanceEur).toBe(5600);
  });

  it('a buy overdrafting its named source is rejected even when Main is rich', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedEurAsset(h);
    const bank = await createSource(agent, pid, 'Bank');
    await deposit(agent, pid, 10_000, { executedAt: tsOffset(-2) });
    await deposit(agent, pid, 100, { sourceId: bank.id, executedAt: tsOffset(-2) });

    const buy = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'buy',
        quantity: 4,
        price: 100,
        executedAt: tsOffset(-1),
        payFromCash: true,
        cashSourceId: bank.id,
      });
    expect(buy.status).toBe(400);
    expect(buy.body.error.code).toBe('INSUFFICIENT_CASH');

    // Neither a transaction nor a movement was booked.
    const txns = await agent.get(`/api/v1/portfolios/${pid}/transactions`);
    expect(txns.body.items).toHaveLength(0);
  });

  it('sell proceeds land in the chosen source; cashSourceId without a flag is a 400', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedEurAsset(h);
    const bank = await createSource(agent, pid, 'Bank');

    // Buy settled outside the ledger, then sell INTO the bank source.
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 90, executedAt: tsOffset(-3) });
    const sell = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'sell',
        quantity: 5,
        price: 100,
        executedAt: tsOffset(-1),
        addProceedsToCash: true,
        cashSourceId: bank.id,
      });
    expect(sell.status).toBe(201);

    const state = await cashState(agent, pid);
    expect(state.movements).toHaveLength(1);
    expect(state.movements[0]).toMatchObject({
      kind: 'sell_proceeds',
      amountEur: 500,
      sourceId: bank.id,
    });

    const flagless = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'sell',
        quantity: 1,
        price: 100,
        executedAt: tsOffset(0),
        cashSourceId: bank.id,
      });
    expect(flagless.status).toBe(400);
    expect(flagless.body.error.code).toBe('CASH_FLAG_MISMATCH');
  });
});

// ─── TWR integrity: internal transfers are NEVER external flows ──────────────

describe('performance-% curve vs cash sources (V3-P3 TWR rules)', () => {
  async function setupWithHoldings() {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedEurAsset(h);
    // Flat 100 for two days, then +10 %.
    await h.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-3), close: '100' },
      { assetId: asset.id, date: dayOffset(-2), close: '100' },
      { assetId: asset.id, date: dayOffset(-1), close: '110' },
    ]);
    // Deposit 2000, buy 10 @ 100 from cash → 1000 invested + 1000 cash.
    await deposit(agent, pid, 2000, { executedAt: tsOffset(-3) });
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'buy',
        quantity: 10,
        price: 100,
        executedAt: tsOffset(-3),
        payFromCash: true,
      });
    return { h, agent, pid };
  }

  async function history(agent: Agent, pid: string) {
    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(res.status).toBe(200);
    return res.body as {
      points: Array<{ date: string; valueEur: number }>;
      performance: Array<{ date: string; pct: number }>;
    };
  }

  it('the performance curve is identical before and after an internal transfer', async () => {
    const { agent, pid } = await setupWithHoldings();
    const main = await mainSource(agent, pid);
    const bank = await createSource(agent, pid, 'Bank');
    const before = await history(agent, pid);

    // Back-dated internal transfer inside the charted window.
    const res = await agent
      .post(`/api/v1/portfolios/${pid}/cash/transfer`)
      .set(...XRW)
      .send({
        fromSourceId: main.id,
        toSourceId: bank.id,
        amountEur: 300,
        executedAt: tsOffset(-2),
      });
    expect(res.status).toBe(201);

    const after = await history(agent, pid);
    // The transfer is invisible to BOTH curves: the net-worth points (the pair
    // cancels) and the performance-% series (never an external flow).
    expect(after.points).toEqual(before.points);
    expect(after.performance).toEqual(before.performance);
    // Sanity: the curve actually carries the market's +10 % move.
    expect(after.performance.at(-1)?.pct).toBeCloseTo(5, 9); // +100 € on 2 000 €
  });

  it('deposits/withdrawals on a named source remain external flows exactly like on Main', async () => {
    // Two identical portfolios, one control: user A deposits into MAIN, user B
    // deposits the same amount, same day, into a NAMED source. External-flow
    // treatment is identical iff both value AND performance curves coincide.
    const h = await createTestApp({ marketData: createStubMarketData() });
    const asset = await seedEurAsset(h);
    await h.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-3), close: '100' },
      { assetId: asset.id, date: dayOffset(-2), close: '100' },
      { assetId: asset.id, date: dayOffset(-1), close: '110' },
    ]);

    async function setupUser(email: string, username: string) {
      const user = await h.seedUser({ email, username });
      const agent = await loginAgent(h.app, user.email, user.password);
      const pid = await defaultPortfolioId(agent);
      await deposit(agent, pid, 2000, { executedAt: tsOffset(-3) });
      await agent
        .post(`/api/v1/portfolios/${pid}/transactions`)
        .set(...XRW)
        .send({
          assetId: asset.id,
          side: 'buy',
          quantity: 10,
          price: 100,
          executedAt: tsOffset(-3),
          payFromCash: true,
        });
      return { agent, pid };
    }
    const a = await setupUser('a@bettertrack.test', 'user-a');
    const b = await setupUser('b@bettertrack.test', 'user-b');

    // A → Main; B → a named bank source. Same amount, same (back-dated) day.
    await deposit(a.agent, a.pid, 500, { executedAt: tsOffset(-2) });
    const bank = await createSource(b.agent, b.pid, 'Bank');
    await deposit(b.agent, b.pid, 500, { sourceId: bank.id, executedAt: tsOffset(-2) });

    const ofA = await history(a.agent, a.pid);
    const ofB = await history(b.agent, b.pid);
    expect(ofB.points).toEqual(ofA.points);
    expect(ofB.performance).toEqual(ofA.performance);

    // And the flow is neutralized like any external deposit: the curve jumps
    // by 500 on the deposit day while the performance stays flat there.
    const days = ofB.points.map((p) => p.date);
    const depositIdx = days.indexOf(dayOffset(-2));
    expect(depositIdx).toBeGreaterThan(0);
    expect(
      (ofB.points[depositIdx]?.valueEur ?? 0) - (ofB.points[depositIdx - 1]?.valueEur ?? 0),
    ).toBeCloseTo(500, 9);
    expect(ofB.performance[depositIdx]?.pct).toBeCloseTo(
      ofB.performance[depositIdx - 1]?.pct ?? Number.NaN,
      9,
    );
  });
});
