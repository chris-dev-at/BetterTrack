import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { transactionListResponseSchema } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Source tags (V5-P0c, issue #552). Every transaction / dividend / cash movement
 * carries a `source` recording how it entered the ledger — `manual` for hand
 * entry, `import:<broker>` from the CSV apply path. The tag is **server-assigned
 * only**: a client can never forge a `sync:*` / `import:*` tag on a hand-entered
 * row (the mutation bodies are `.strict()` and carry no `source` field). The
 * list endpoints accept a `?source=` filter that returns exactly the tagged rows.
 * (Import-path tagging per broker is asserted end-to-end in the imports suite.)
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

function tsOffset(offset: number): string {
  const day = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  return `${day}T00:00:00.000Z`;
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
  return res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
}

async function seedAsset(h: TestHarness) {
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

describe('source tags (V5-P0c)', () => {
  it('stamps `manual` on hand-entered transactions, cash movements and dividends', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    const buy = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 50, executedAt: tsOffset(-5) });
    expect(buy.status).toBe(201);
    expect(buy.body.transactions[0].source).toBe('manual');

    const deposit = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 100 });
    expect(deposit.status).toBe(201);
    expect(deposit.body.movement.source).toBe('manual');

    const dividend = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: asset.id, grossAmountEur: 12.5, executedAt: tsOffset(-1) });
    expect(dividend.status).toBe(201);
    expect(dividend.body.dividend.source).toBe('manual');
    // The dividend's linked cash inflow inherits the dividend's tag.
    expect(dividend.body.movements.every((m: { source: string }) => m.source === 'manual')).toBe(
      true,
    );

    // And they read back tagged over the list endpoints too.
    const txns = await agent.get(`/api/v1/portfolios/${pid}/transactions`);
    expect(txns.body.items.every((t: { source: string }) => t.source === 'manual')).toBe(true);
    const cash = await agent.get(`/api/v1/portfolios/${pid}/cash`);
    expect(cash.body.movements.every((m: { source: string }) => m.source === 'manual')).toBe(true);
    const divs = await agent.get(`/api/v1/portfolios/${pid}/dividends`);
    expect(divs.body.dividends.every((d: { source: string }) => d.source === 'manual')).toBe(true);
  });

  it('rejects a client attempt to forge the source on a manual write (never suppliable)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    const forgedTxn = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 10,
        executedAt: tsOffset(-1),
        source: 'sync:parqet',
      });
    // The strict body schema refuses the unknown `source` key outright — a caller
    // cannot pass it, so it can never masquerade as synced data.
    expect(forgedTxn.status).toBe(400);

    const forgedCash = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 50, source: 'import:trade_republic' });
    expect(forgedCash.status).toBe(400);
  });

  it('filters transactions by exact source tag — returns exactly the tagged rows', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    // Two manual buys through the API…
    for (const n of [1, 2]) {
      const res = await agent
        .post(`/api/v1/portfolios/${pid}/transactions`)
        .set(...XRW)
        .send({ assetId: asset.id, side: 'buy', quantity: n, price: 50, executedAt: tsOffset(-n) });
      expect(res.status).toBe(201);
    }
    // …and one row written with an import tag directly (stands in for a prior
    // broker apply — the tag itself is what the filter keys on).
    await harness.db.insert(schema.transactions).values({
      portfolioId: pid,
      assetId: asset.id,
      side: 'buy',
      quantity: '3',
      price: '50',
      fee: '0',
      executedAt: new Date(tsOffset(-10)),
      source: 'import:trade_republic',
    });

    const manual = await agent.get(`/api/v1/portfolios/${pid}/transactions?source=manual`);
    expect(manual.status).toBe(200);
    expect(transactionListResponseSchema.safeParse(manual.body).success).toBe(true);
    expect(manual.body.items).toHaveLength(2);
    expect(manual.body.items.every((t: { source: string }) => t.source === 'manual')).toBe(true);

    const imported = await agent.get(
      `/api/v1/portfolios/${pid}/transactions?source=import:trade_republic`,
    );
    expect(imported.status).toBe(200);
    expect(imported.body.items).toHaveLength(1);
    expect(imported.body.items[0].source).toBe('import:trade_republic');

    // An unused tag matches nothing.
    const none = await agent.get(`/api/v1/portfolios/${pid}/transactions?source=sync:george`);
    expect(none.body.items).toHaveLength(0);

    // A malformed tag is a 400, not a silent all-rows result.
    const bad = await agent.get(`/api/v1/portfolios/${pid}/transactions?source=IMPORT`);
    expect(bad.status).toBe(400);
  });

  it('filters cash movements by source tag while the balance still rolls up the full ledger', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    // A manual deposit materialises Main; grab its source id from the ledger.
    const dep = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 100 });
    expect(dep.status).toBe(201);
    const mainSourceId = dep.body.movement.sourceId as string;

    // An import-tagged deposit written directly against the same source.
    await harness.db.insert(schema.portfolioCashMovements).values({
      portfolioId: pid,
      sourceId: mainSourceId,
      kind: 'deposit',
      amountEur: '250',
      executedAt: new Date(tsOffset(-3)),
      source: 'import:flatex',
    });

    const all = await agent.get(`/api/v1/portfolios/${pid}/cash`);
    expect(all.body.movements).toHaveLength(2);
    expect(all.body.balanceEur).toBeCloseTo(350, 2);

    const imported = await agent.get(`/api/v1/portfolios/${pid}/cash?source=import:flatex`);
    expect(imported.body.movements).toHaveLength(1);
    expect(imported.body.movements[0].source).toBe('import:flatex');
    // The filter is a view — the balance is still the whole ledger, not €250.
    expect(imported.body.balanceEur).toBeCloseTo(350, 2);
  });
});
