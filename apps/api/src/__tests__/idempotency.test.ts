import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Idempotency keys on portfolio mutation endpoints (§13.4 V4-P2a, #417) — the
 * backbone for the app's offline FIFO queue. Exercises the acceptance matrix: a
 * repeated `Idempotency-Key` runs the mutation exactly once and replays a
 * byte-identical response, across one endpoint of every covered family
 * (transaction create/edit/delete, cash deposit/withdraw, transfer, set-balance,
 * custom-asset value points); the concurrency race collapses to one movement;
 * mismatched bodies and malformed keys are rejected; the key space is per-user;
 * a headerless request is unchanged; retention (≥ 48 h then reusable); and it
 * works identically under cookie-session and bearer auth.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const IK = 'Idempotency-Key';

/** ISO-8601 timestamp at UTC midnight of a day `offset` days before today. */
function tsOffset(offset: number): string {
  const day = new Date(
    Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`) + offset * 86_400_000,
  );
  return `${day.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

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

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  return res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
}

async function mainSourceId(agent: Agent, pid: string): Promise<string> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash/sources`);
  expect(res.status).toBe(200);
  return res.body.sources.find((s: { isMain: boolean }) => s.isMain).id as string;
}

let harness: TestHarness;

async function seedAsset(): Promise<string> {
  const [row] = await harness.db
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
  if (!row) throw new Error('failed to seed asset');
  return row.id;
}

async function txCount(pid: string): Promise<number> {
  const rows = await harness.db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(eq(schema.transactions.portfolioId, pid));
  return rows.length;
}

async function movementCount(pid: string): Promise<number> {
  const rows = await harness.db
    .select({ id: schema.portfolioCashMovements.id })
    .from(schema.portfolioCashMovements)
    .where(eq(schema.portfolioCashMovements.portfolioId, pid));
  return rows.length;
}

beforeEach(async () => {
  harness = await createTestApp();
});

describe('idempotency — one execution + byte-identical replay per family', () => {
  it('POST /transactions: same key twice → one row, byte-identical response', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset();
    const key = randomUUID();
    const body = { assetId, side: 'buy', quantity: 3, price: 50, executedAt: tsOffset(-1) };
    const path = `/api/v1/portfolios/${pid}/transactions`;

    const r1 = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send(body);
    expect(r1.status).toBe(201);
    const r2 = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send(body);

    expect(r2.status).toBe(r1.status);
    expect(r2.body).toEqual(r1.body);
    expect(r2.text).toBe(r1.text); // byte-identical
    expect(await txCount(pid)).toBe(1); // exactly one movement
  });

  it('POST /cash/deposit: same key twice → one movement, byte-identical response', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const key = randomUUID();
    const path = `/api/v1/portfolios/${pid}/cash/deposit`;

    const r1 = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send({ amountEur: 100 });
    expect(r1.status).toBe(201);
    const r2 = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send({ amountEur: 100 });

    expect(r2.status).toBe(201);
    expect(r2.text).toBe(r1.text);
    expect(await movementCount(pid)).toBe(1);
  });

  it('POST /cash/transfer: same key twice → one paired movement, byte-identical', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const mainId = await mainSourceId(agent, pid);
    // A second source + funds so the transfer is valid.
    const src = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources`)
      .set(...XRW)
      .send({ name: 'Bank', type: 'bank' });
    expect(src.status).toBe(201);
    await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 500 });

    const key = randomUUID();
    const path = `/api/v1/portfolios/${pid}/cash/transfer`;
    const body = { fromSourceId: mainId, toSourceId: src.body.source.id, amountEur: 100 };

    const r1 = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send(body);
    expect(r1.status).toBe(201);
    const after1 = await movementCount(pid);
    const r2 = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send(body);

    expect(r2.status).toBe(201);
    expect(r2.text).toBe(r1.text);
    expect(await movementCount(pid)).toBe(after1); // replay recorded no new legs
  });

  it('POST /cash/sources/:id/set-balance: same key twice → one movement, byte-identical', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const mainId = await mainSourceId(agent, pid);
    const key = randomUUID();
    const path = `/api/v1/portfolios/${pid}/cash/sources/${mainId}/set-balance`;

    const r1 = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send({ balanceEur: 500 });
    expect(r1.status).toBe(200);
    const r2 = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send({ balanceEur: 500 });

    expect(r2.status).toBe(200);
    expect(r2.text).toBe(r1.text);
    expect(await movementCount(pid)).toBe(1);
  });

  it('PUT /custom-assets/:id/value-points: same key twice → byte-identical response', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'House', category: 'other', currency: 'EUR' });
    expect(created.status).toBe(201);
    const id = created.body.asset.id as string;
    const key = randomUUID();
    const path = `/api/v1/custom-assets/${id}/value-points`;
    const body = { points: [{ date: '2026-01-01', value: 1000 }] };

    const r1 = await agent
      .put(path)
      .set(...XRW)
      .set(IK, key)
      .send(body);
    expect(r1.status).toBe(200);
    const r2 = await agent
      .put(path)
      .set(...XRW)
      .set(IK, key)
      .send(body);

    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body);
    expect(r2.text).toBe(r1.text);
  });

  it('DELETE /transactions/:txId: same key twice → 204 replay (empty body), not a 404', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset();
    const created = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId, side: 'buy', quantity: 1, price: 10, executedAt: tsOffset(-1) });
    expect(created.status).toBe(201);
    const txId = created.body.transactions[0].id as string;

    const key = randomUUID();
    const path = `/api/v1/portfolios/${pid}/transactions/${txId}`;
    const r1 = await agent
      .delete(path)
      .set(...XRW)
      .set(IK, key);
    expect(r1.status).toBe(204);
    // Without idempotency the row is already gone → 404; the stored 204 replays.
    const r2 = await agent
      .delete(path)
      .set(...XRW)
      .set(IK, key);
    expect(r2.status).toBe(204);
    expect(r2.text).toBe(r1.text); // both empty
    expect(await txCount(pid)).toBe(0);
  });
});

describe('idempotency — concurrency, conflicts, scoping', () => {
  it('two concurrent requests with the same key → exactly one movement', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset();
    const key = randomUUID();
    const body = { assetId, side: 'buy', quantity: 2, price: 10, executedAt: tsOffset(-2) };
    const path = `/api/v1/portfolios/${pid}/transactions`;

    const [a, b] = await Promise.all([
      agent
        .post(path)
        .set(...XRW)
        .set(IK, key)
        .send(body),
      agent
        .post(path)
        .set(...XRW)
        .set(IK, key)
        .send(body),
    ]);

    // One request executes, the other replays the stored response — both 201.
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(a.text).toBe(b.text);
    expect(await txCount(pid)).toBe(1);
  });

  it('same key, different body → 409 IDEMPOTENCY_KEY_MISMATCH (never replayed)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const key = randomUUID();
    const path = `/api/v1/portfolios/${pid}/cash/deposit`;

    const first = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send({ amountEur: 100 });
    expect(first.status).toBe(201);
    const clash = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send({ amountEur: 200 });

    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    expect(await movementCount(pid)).toBe(1); // the second body never executed
  });

  it('keys are per-user: user B reusing user A’s key is unaffected by A’s response', async () => {
    const userA = await harness.seedUser({ email: 'a@bt.test', username: 'usera' });
    const userB = await harness.seedUser({ email: 'b@bt.test', username: 'userb' });
    const agentA = await loginAgent(harness.app, userA.email, userA.password);
    const agentB = await loginAgent(harness.app, userB.email, userB.password);
    const pidA = await defaultPortfolioId(agentA);
    const pidB = await defaultPortfolioId(agentB);
    const key = randomUUID();

    const rA = await agentA
      .post(`/api/v1/portfolios/${pidA}/cash/deposit`)
      .set(...XRW)
      .set(IK, key)
      .send({ amountEur: 100 });
    const rB = await agentB
      .post(`/api/v1/portfolios/${pidB}/cash/deposit`)
      .set(...XRW)
      .set(IK, key)
      .send({ amountEur: 100 });

    expect(rA.status).toBe(201);
    expect(rB.status).toBe(201);
    // B ran its own mutation — not a replay of A's stored response.
    expect(rB.body.movement.id).not.toBe(rA.body.movement.id);
    expect(await movementCount(pidA)).toBe(1);
    expect(await movementCount(pidB)).toBe(1);
  });

  it('malformed (non-UUID) Idempotency-Key → 400 IDEMPOTENCY_KEY_INVALID, nothing recorded', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .set(IK, 'not-a-uuid')
      .send({ amountEur: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(await movementCount(pid)).toBe(0);
  });

  it('no header → unchanged behaviour (two identical posts record two movements)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const path = `/api/v1/portfolios/${pid}/cash/deposit`;

    await agent
      .post(path)
      .set(...XRW)
      .send({ amountEur: 100 });
    await agent
      .post(path)
      .set(...XRW)
      .send({ amountEur: 100 });

    expect(await movementCount(pid)).toBe(2);
  });
});

describe('idempotency — retention window', () => {
  it('replays within the window, then re-executes once the key ages past retention', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const key = randomUUID();
    const path = `/api/v1/portfolios/${pid}/cash/deposit`;

    const r1 = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send({ amountEur: 100 });
    expect(r1.status).toBe(201);
    // Within the retention window → replayed, still one movement.
    const r1b = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send({ amountEur: 100 });
    expect(r1b.text).toBe(r1.text);
    expect(await movementCount(pid)).toBe(1);

    // Age the stored key past the 48 h window; the next write lazily purges it.
    await harness.db
      .update(schema.idempotencyKeys)
      .set({ createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) })
      .where(eq(schema.idempotencyKeys.key, key));

    const r2 = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send({ amountEur: 100 });
    expect(r2.status).toBe(201); // key reusable → mutation ran again
    expect(await movementCount(pid)).toBe(2);
  });
});

describe('idempotency — cookie-session and bearer share one per-user key space', () => {
  it('a cookie request then a bearer request with the same key replays (one movement)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    // Mint a personal API key (portfolio:write implies :read) for the same user.
    const minted = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'offline queue', scopes: ['portfolio:write'] });
    expect(minted.status).toBe(201);
    const token = minted.body.token as string;

    const key = randomUUID();
    const path = `/api/v1/portfolios/${pid}/cash/deposit`;

    // First via the cookie session…
    const viaCookie = await agent
      .post(path)
      .set(...XRW)
      .set(IK, key)
      .send({ amountEur: 100 });
    expect(viaCookie.status).toBe(201);
    // …then the same key via a bearer token (no CSRF header needed) → replay.
    const viaBearer = await request(harness.app)
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .set(IK, key)
      .send({ amountEur: 100 });

    expect(viaBearer.status).toBe(201);
    expect(viaBearer.text).toBe(viaCookie.text);
    expect(await movementCount(pid)).toBe(1);
  });
});
