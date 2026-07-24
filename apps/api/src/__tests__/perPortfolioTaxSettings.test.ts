import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { portfolioTaxSettingsResponseSchema } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Per-portfolio settings scoping (issue #636). The tax slice — the first consumer
 * of the framework — verified end-to-end over the HTTP surface: the resolution
 * cascade `effective = portfolio override ?? user default ?? system('none')`, the
 * per-portfolio override + reset-to-default, isolation between portfolios, and
 * the behavioural proof that a portfolio's EFFECTIVE mode (not the user default)
 * drives how its trades are taxed.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string) {
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

async function createPortfolio(agent: Agent, name: string): Promise<string> {
  const res = await agent
    .post('/api/v1/portfolios')
    .set(...XRW)
    .send({ name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const list = await agent.get('/api/v1/portfolios');
  return list.body.portfolios.find((p: { name: string }) => p.name === name).id as string;
}

async function seedAsset(symbol = 'BAYN.DE') {
  const [row] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      type: 'stock',
      symbol,
      name: `${symbol} Test AG`,
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

const getTaxView = async (agent: Agent, pid: string) => {
  const res = await agent.get(`/api/v1/portfolios/${pid}/settings/tax`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(portfolioTaxSettingsResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body;
};

const setUserDefault = (agent: Agent, body: Record<string, unknown>) =>
  agent
    .patch('/api/v1/settings/taxes')
    .set(...XRW)
    .send(body);

const putOverride = (agent: Agent, pid: string, body: Record<string, unknown>) =>
  agent
    .put(`/api/v1/portfolios/${pid}/settings/tax`)
    .set(...XRW)
    .send(body);

const clearOverride = (agent: Agent, pid: string) =>
  agent.delete(`/api/v1/portfolios/${pid}/settings/tax`).set(...XRW);

describe('Per-portfolio tax settings scoping (#636)', () => {
  it('resolves to the SYSTEM default (none) with no user default and no override', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    expect(await getTaxView(agent, pid)).toEqual({
      effective: { mode: 'none', country: null },
      override: null,
      userDefault: { mode: 'none', country: null },
      source: 'system',
    });
  });

  it('inherits the USER default when set, with no override (source = user)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    expect((await setUserDefault(agent, { mode: 'country_specific', country: 'AT' })).status).toBe(
      200,
    );

    expect(await getTaxView(agent, pid)).toEqual({
      effective: { mode: 'country_specific', country: 'AT' },
      override: null,
      userDefault: { mode: 'country_specific', country: 'AT' },
      source: 'user',
    });
  });

  it('a PORTFOLIO override shadows the user default (source = portfolio) and reset restores inheritance', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    await setUserDefault(agent, { mode: 'country_specific', country: 'AT' });

    const put = await putOverride(agent, pid, { mode: 'country_specific', country: 'DE' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toEqual({
      effective: { mode: 'country_specific', country: 'DE' },
      override: { mode: 'country_specific', country: 'DE' },
      userDefault: { mode: 'country_specific', country: 'AT' },
      source: 'portfolio',
    });

    // The user-level default is untouched by a per-portfolio override.
    expect((await agent.get('/api/v1/settings/taxes')).body).toEqual({
      mode: 'country_specific',
      country: 'AT',
    });

    // Reset-to-default drops the override → inherits the live user default again.
    const del = await clearOverride(agent, pid);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({
      effective: { mode: 'country_specific', country: 'AT' },
      override: null,
      userDefault: { mode: 'country_specific', country: 'AT' },
      source: 'user',
    });
  });

  it('preserves an FI portfolio override when the user default is AT', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    await setUserDefault(agent, { mode: 'country_specific', country: 'AT' });

    const put = await putOverride(agent, pid, { mode: 'country_specific', country: 'FI' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    expect(await getTaxView(agent, pid)).toEqual({
      effective: { mode: 'country_specific', country: 'FI' },
      override: { mode: 'country_specific', country: 'FI' },
      userDefault: { mode: 'country_specific', country: 'AT' },
      source: 'portfolio',
    });
  });

  it('overrides are isolated per portfolio — one portfolio overriding never moves another', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const a = await defaultPortfolioId(agent);
    const b = await createPortfolio(agent, 'Depot B');
    await setUserDefault(agent, { mode: 'country_specific', country: 'AT' });

    await putOverride(agent, a, { mode: 'manual_per_trade' });

    expect((await getTaxView(agent, a)).source).toBe('portfolio');
    expect((await getTaxView(agent, a)).effective).toEqual({
      mode: 'manual_per_trade',
      country: null,
    });
    // B never overrode → still inheriting the AT default.
    expect(await getTaxView(agent, b)).toMatchObject({
      effective: { mode: 'country_specific', country: 'AT' },
      override: null,
      source: 'user',
    });
  });

  it('the EFFECTIVE per-portfolio mode drives tax planning (manual entry allowed on the override, rejected where inherited none)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const a = await defaultPortfolioId(agent); // inherits the user default (none)
    const b = await createPortfolio(agent, 'Depot B');
    const asset = await seedAsset();
    // User default stays `none`; only B overrides to manual.
    await putOverride(agent, b, { mode: 'manual_per_trade' });

    const buy = (pid: string) =>
      agent
        .post(`/api/v1/portfolios/${pid}/transactions`)
        .set(...XRW)
        .send({
          assetId: asset.id,
          side: 'buy',
          quantity: 10,
          price: 100,
          executedAt: '2026-02-01T00:00:00.000Z',
        });
    const sellWithManualTax = (pid: string) =>
      agent
        .post(`/api/v1/portfolios/${pid}/transactions`)
        .set(...XRW)
        .send({
          assetId: asset.id,
          side: 'sell',
          quantity: 5,
          price: 120,
          executedAt: '2026-03-01T00:00:00.000Z',
          // Proceeds fund the source so the manual withholding movement is solvent.
          addProceedsToCash: true,
          taxAmountEur: 30,
        });

    expect((await buy(a)).status).toBe(201);
    expect((await buy(b)).status).toBe(201);

    // B's effective mode is manual → the manual tax entry is accepted + frozen.
    const okSell = await sellWithManualTax(b);
    expect(okSell.status, JSON.stringify(okSell.body)).toBe(201);

    // A inherits `none` → the very same manual entry is refused.
    const badSell = await sellWithManualTax(a);
    expect(badSell.status).toBe(400);
    expect(badSell.body.error.code).toBe('TAX_ENTRY_NOT_ALLOWED');
  });

  it('the override body honours the contract refinement (country iff country_specific)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    // A country on a non-country mode is rejected by the shared contract schema.
    expect(
      (await putOverride(agent, pid, { mode: 'manual_per_trade', country: 'AT' })).status,
    ).toBe(400);
    // country_specific without a country is rejected too.
    expect((await putOverride(agent, pid, { mode: 'country_specific' })).status).toBe(400);
  });

  it("a user cannot read or write another user's portfolio tax settings", async () => {
    const alice = await harness.seedUser();
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const alicePid = await defaultPortfolioId(aliceAgent);

    const bob = await harness.seedUser({ email: 'bob@bettertrack.test', username: 'bob' });
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);

    expect((await bobAgent.get(`/api/v1/portfolios/${alicePid}/settings/tax`)).status).toBe(404);
    expect((await putOverride(bobAgent, alicePid, { mode: 'manual_per_trade' })).status).toBe(404);
    expect((await clearOverride(bobAgent, alicePid)).status).toBe(404);
  });

  it('a per-portfolio override write reconciles the open year immediately (#635)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset('OMV.VI');

    // Recorded with no tax mode anywhere: untaxed at entry (the #635 shape).
    const trade = (body: Record<string, unknown>) =>
      agent
        .post(`/api/v1/portfolios/${pid}/transactions`)
        .set(...XRW)
        .send(body);
    expect(
      (
        await trade({
          assetId: asset.id,
          side: 'buy',
          quantity: 100,
          price: 10,
          executedAt: '2026-01-10T10:00:00.000Z',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await trade({
          assetId: asset.id,
          side: 'sell',
          quantity: 50,
          price: 19,
          executedAt: '2026-02-10T10:00:00.000Z',
          addProceedsToCash: true,
        })
      ).status,
    ).toBe(201);

    // The override WRITE itself heals the open year — no report read needed:
    // 27.5 % × 450 = 123.75 posts as an unattached correction.
    const res = await putOverride(agent, pid, { mode: 'country_specific', country: 'AT' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cash = await agent.get(`/api/v1/portfolios/${pid}/cash`);
    expect(cash.status).toBe(200);
    const taxMoves = (cash.body.movements as { kind: string }[]).filter(
      (m) => m.kind === 'tax_withholding' || m.kind === 'tax_refund',
    );
    expect(taxMoves).toHaveLength(1);
    expect(taxMoves[0]).toMatchObject({
      kind: 'tax_withholding',
      amountEur: -123.75,
      taxYear: 2026,
      transactionId: null,
    });
  });
});
