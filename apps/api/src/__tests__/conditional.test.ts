import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createAssetRepository,
  REFRESHABLE_ASSET_FIELDS,
  type GlobalAssetUpsert,
} from '../data/repositories/assetRepository';
import * as schema from '../data/schema';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Route-level round-trips for the V5-P1b conditional read layer (issue #555):
 * portfolio list, summary, portfolio series and catalog search carry ETag +
 * Last-Modified where a reliable freshness watermark exists and honour
 * If-None-Match / If-Modified-Since, a data-changing write flips the validator,
 * a fresh "today" quote is never masked, and no validator is reused across users.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

/** ISO day `offset` days before today (UTC). */
function dayOffset(offset: number): string {
  const day = new Date().toISOString().slice(0, 10);
  const ms = Date.parse(`${day}T00:00:00.000Z`) + offset * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** ISO-8601 timestamp at UTC midnight `offset` days before today. */
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
  return def.id as string;
}

async function seedAsset(h: TestHarness, symbol: string, ownerId: string | null = null) {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      ownerId,
      type: 'stock',
      symbol,
      name: `${symbol} Corp`,
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  return row!.id;
}

/** A deterministic EUR market-data stub (fixed quote, empty provider history). */
function deterministicMarketData(priceRef: { price: number }) {
  return createStubMarketData({
    quote: () => ({
      value: {
        price: priceRef.price,
        currency: 'EUR',
        prevClose: 100,
        dayChangePct: 0,
        asOf: '2026-07-17T00:00:00.000Z',
      },
      stale: false,
      asOf: 1,
    }),
    history: () => ({ value: [], stale: false, asOf: 1 }),
  });
}

/** Buy a fixed asset so the portfolio has holdings + a series. Returns the txn id. */
async function buyInto(
  agent: ReturnType<typeof request.agent>,
  pid: string,
  assetId: string,
  quantity: number,
): Promise<string> {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send({ assetId, side: 'buy', quantity, price: 100, executedAt: tsOffset(-3) });
  expect(res.status).toBe(201);
  return res.body.transactions[0].id as string;
}

describe('conditional reads — portfolio list (GET /api/v1/portfolios)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  it('carries an ETag and serves a 304 on an unchanged list', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const first = await agent.get('/api/v1/portfolios');
    expect(first.status).toBe(200);
    expect(first.headers.etag).toMatch(/^W\//);
    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect(first.headers.vary).toContain('Cookie');
    expect(first.headers['last-modified']).toBeUndefined();

    const revalidate = await agent
      .get('/api/v1/portfolios')
      .set('If-None-Match', first.headers.etag as string);
    expect(revalidate.status).toBe(304);
    expect(revalidate.text).toBe('');
    expect(revalidate.headers.etag).toBe(first.headers.etag);
  });
});

describe('conditional reads — portfolio summary (GET /api/v1/portfolios/:id)', () => {
  let harness: TestHarness;
  const priceRef = { price: 120 };

  beforeEach(async () => {
    priceRef.price = 120;
    harness = await createTestApp({ marketData: deterministicMarketData(priceRef) });
  });

  it('does not emit validators for non-vault errors', async () => {
    const res = await request(harness.app).get('/api/v1/portfolios');

    expect(res.status).toBe(401);
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['last-modified']).toBeUndefined();
  });

  it('carries an ETag and serves a 304 on an unchanged summary', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset(harness, 'SUMA');
    await buyInto(agent, pid, assetId, 1);

    const first = await agent.get(`/api/v1/portfolios/${pid}`);
    expect(first.status).toBe(200);
    expect(first.headers.etag).toMatch(/^W\/"/);
    // §6.8.6: the portfolio rail emits no Last-Modified. liveToday makes the
    // date validator unreachable, so producing one only cost an ownership-
    // checked snapshot-state round-trip per request (#1762).
    expect(first.headers['last-modified']).toBeUndefined();
    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect(first.headers.vary).toContain('Cookie');

    const revalidate = await agent
      .get(`/api/v1/portfolios/${pid}`)
      .set('If-None-Match', first.headers.etag as string);
    expect(revalidate.status).toBe(304);
    expect(revalidate.text).toBe('');
    expect(revalidate.headers.etag).toBe(first.headers.etag);
  });

  it('flips the validator when a transaction is edited', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset(harness, 'SUMB');
    const txId = await buyInto(agent, pid, assetId, 1);

    const before = await agent.get(`/api/v1/portfolios/${pid}`);
    const etag = before.headers.etag;

    const patch = await agent
      .patch(`/api/v1/portfolios/${pid}/transactions/${txId}`)
      .set(...XRW)
      .send({ quantity: 5 });
    expect(patch.status).toBe(200);

    const after = await agent.get(`/api/v1/portfolios/${pid}`).set('If-None-Match', etag as string);
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(etag);
  });

  it('never masks a fresh "today" quote behind a 304', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset(harness, 'SUMC');
    await buyInto(agent, pid, assetId, 1);

    const first = await agent.get(`/api/v1/portfolios/${pid}`);
    const etag = first.headers.etag;

    // A new live quote arrives (no write, no invalidation).
    priceRef.price = 200;

    const revalidate = await agent
      .get(`/api/v1/portfolios/${pid}`)
      .set('If-None-Match', etag as string)
      // Even an If-Modified-Since in the future must not mask the fresh quote.
      .set('If-Modified-Since', new Date(Date.now() + 86_400_000).toUTCString());
    expect(revalidate.status).toBe(200);
    expect(revalidate.headers.etag).not.toBe(etag);
    expect(revalidate.body.holdings[0].price).toBe(200);
  });

  it('does not reuse a validator across users', async () => {
    const userA = await harness.seedUser();
    const agentA = await loginAgent(harness.app, userA.email, userA.password);
    const pidA = await defaultPortfolioId(agentA);
    const assetA = await seedAsset(harness, 'SUMD');
    await buyInto(agentA, pidA, assetA, 1);
    const resA = await agentA.get(`/api/v1/portfolios/${pidA}`);

    const userB = await harness.seedUser({ email: 'user-b@bettertrack.test', username: 'userb' });
    const agentB = await loginAgent(harness.app, userB.email, userB.password);
    const pidB = await defaultPortfolioId(agentB);
    const assetB = await seedAsset(harness, 'SUME');
    await buyInto(agentB, pidB, assetB, 1);

    // B presents A's ETag against B's own portfolio: must be a 200, never a 304.
    const cross = await agentB
      .get(`/api/v1/portfolios/${pidB}`)
      .set('If-None-Match', resA.headers.etag as string);
    expect(cross.status).toBe(200);
    expect(cross.headers.etag).not.toBe(resA.headers.etag);
  });
});

describe('conditional reads — portfolio series (GET /api/v1/portfolios/:id/history)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp({ marketData: deterministicMarketData({ price: 120 }) });
  });

  it('carries validators and serves a 304 on an unchanged series', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset(harness, 'SERA');
    await buyInto(agent, pid, assetId, 1);

    // Warm-up read: the first series read refills the snapshot rows, so both
    // compared reads below are served from the same (snapshot) path.
    await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);

    const first = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(first.status).toBe(200);
    expect(first.headers.etag).toMatch(/^W\/"/);
    // As with the summary: ETag only on the series read (§6.8.6, #1762).
    expect(first.headers['last-modified']).toBeUndefined();

    const revalidate = await agent
      .get(`/api/v1/portfolios/${pid}/history?range=MAX`)
      .set('If-None-Match', first.headers.etag as string);
    expect(revalidate.status).toBe(304);
    expect(revalidate.text).toBe('');
  });

  it('flips the series validator when the underlying data changes (snapshot invalidation)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset(harness, 'SERB');
    // Stored closes so the series carries real, quantity-scaled values.
    await harness.db.insert(schema.priceHistory).values([
      { assetId, date: dayOffset(-2), close: '100' },
      { assetId, date: dayOffset(-1), close: '110' },
    ]);
    const txId = await buyInto(agent, pid, assetId, 1);

    const before = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    const etag = before.headers.etag;

    const patch = await agent
      .patch(`/api/v1/portfolios/${pid}/transactions/${txId}`)
      .set(...XRW)
      .send({ quantity: 9 });
    expect(patch.status).toBe(200);

    const after = await agent
      .get(`/api/v1/portfolios/${pid}/history?range=MAX`)
      .set('If-None-Match', etag as string);
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(etag);
  });
});

describe('conditional reads — catalog search (GET /api/v1/search)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp({ marketData: createStubMarketData() });
    // ≥3 market matches so `enriching` stays false and the body is stable.
    await seedAsset(harness, 'CONDA');
    await seedAsset(harness, 'CONDB');
    await seedAsset(harness, 'CONDC');
  });

  it('carries validators and serves a 304 via If-None-Match and If-Modified-Since', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const first = await agent.get('/api/v1/search?q=COND');
    expect(first.status).toBe(200);
    expect(first.body.enriching).toBe(false);
    expect(first.headers.etag).toMatch(/^W\/"/);
    expect(first.headers['last-modified']).toBeTruthy();
    expect(first.headers['cache-control']).toBe('private, no-cache');

    const byEtag = await agent
      .get('/api/v1/search?q=COND')
      .set('If-None-Match', first.headers.etag as string);
    expect(byEtag.status).toBe(304);
    expect(byEtag.text).toBe('');

    // No live "today" on search — If-Modified-Since gates a 304 too.
    const byDate = await agent
      .get('/api/v1/search?q=COND')
      .set('If-Modified-Since', first.headers['last-modified'] as string);
    expect(byDate.status).toBe(304);
  });

  it('never answers 304 from a watermark that a deletion moved backwards (#1709)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    // The caller's own custom asset, seeded last, is the NEWEST row in their
    // visible catalog — so it is what the watermark is derived from.
    const customId = await seedAsset(harness, 'CONDX', user.id);

    const first = await agent.get('/api/v1/search?q=COND');
    expect(first.status).toBe(200);
    expect(first.body.results.map((r: { symbol: string }) => r.symbol)).toContain('CONDX');
    const watermark = first.headers['last-modified'] as string;
    expect(watermark).toBeTruthy();

    // Every delete path issues this statement (the owner-scoped custom-asset
    // delete, the paranoid detach, the account cascade); the AFTER DELETE
    // trigger stamps the deletion watermark for all of them.
    await harness.db.delete(schema.assets).where(eq(schema.assets.id, customId));

    // Only the date validator, exactly as a bare API-key/CLI client — or an
    // intermediary that strips ETags — would send it.
    const after = await agent.get('/api/v1/search?q=COND').set('If-Modified-Since', watermark);
    expect(after.status).toBe(200);
    expect(after.body.results.map((r: { symbol: string }) => r.symbol)).not.toContain('CONDX');
    // …and the fresh watermark is strictly later, so the client's next
    // conditional request compares against the post-deletion state.
    expect(Date.parse(after.headers['last-modified'] as string)).toBeGreaterThan(
      Date.parse(watermark),
    );
  });

  it('answers 200 even when a newer asset — anyone’s — was deleted first (#1709)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const other = await harness.seedUser({
      email: 'cond-other@bettertrack.test',
      username: 'condother',
    });

    const customId = await seedAsset(harness, 'CONDX', user.id);
    // Newer than everything I can see, invisible to me, and deleted FIRST. The
    // deletion stamp is instance-wide, so this leaves it already ahead of my
    // rows — which, once any account has tidied up a recent asset, is the
    // instance's ordinary state and not a corner case. A stamp that only
    // refuses to rewind would absorb my deletion below and answer 304.
    const theirCustom = await seedAsset(harness, 'CONDY', other.id);
    await harness.db.delete(schema.assets).where(eq(schema.assets.id, theirCustom));

    const first = await agent.get('/api/v1/search?q=COND');
    expect(first.status).toBe(200);
    expect(first.body.results.map((r: { symbol: string }) => r.symbol)).toContain('CONDX');
    const watermark = first.headers['last-modified'] as string;

    await harness.db.delete(schema.assets).where(eq(schema.assets.id, customId));

    const after = await agent.get('/api/v1/search?q=COND').set('If-Modified-Since', watermark);
    expect(after.status).toBe(200);
    expect(after.body.results.map((r: { symbol: string }) => r.symbol)).not.toContain('CONDX');
  });

  it('answers 200 when the deleted row was not the newest one visible (#1709)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    // Minted (UUIDv7 timestamp bits) well below every other row in the fixture,
    // so the deletion cannot drag the watermark up as a side effect of the two
    // rows being milliseconds apart.
    const older = '018f6f00-0000-7000-8000-0000000000cd';
    await harness.db.insert(schema.assets).values({
      id: older,
      providerId: 'manual',
      providerRef: 'CONDX',
      ownerId: user.id,
      type: 'custom',
      symbol: 'CONDX',
      name: 'CONDX Corp',
      currency: 'EUR',
    });
    await seedAsset(harness, 'CONDZ', user.id);

    const first = await agent.get('/api/v1/search?q=COND');
    const watermark = first.headers['last-modified'] as string;

    // `max(newest visible)` is untouched by removing a row below it, so the
    // body loses CONDX while the naive watermark stands still.
    await harness.db.delete(schema.assets).where(eq(schema.assets.id, older));

    const after = await agent.get('/api/v1/search?q=COND').set('If-Modified-Since', watermark);
    expect(after.status).toBe(200);
    const symbols = after.body.results.map((r: { symbol: string }) => r.symbol);
    expect(symbols).not.toContain('CONDX');
    expect(symbols).toContain('CONDZ');
  });

  it('answers 200 with the new name after a custom-asset rename (#1762)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const [row] = await harness.db
      .insert(schema.assets)
      .values({
        providerId: 'manual',
        providerRef: 'COND-RENAME',
        ownerId: user.id,
        type: 'custom',
        symbol: 'CONDR',
        name: 'ACME Immobilien',
        currency: 'EUR',
      })
      .returning();
    const customId = row!.id;

    const first = await agent.get('/api/v1/search?q=COND');
    expect(first.status).toBe(200);
    expect(first.body.results.map((r: { name: string }) => r.name)).toContain('ACME Immobilien');
    const watermark = first.headers['last-modified'] as string;
    expect(watermark).toBeTruthy();

    // `name` is what the search read returns AND ranks on, and the edit keeps
    // the row's id — so "newest visible id" cannot see it. Only the write stamp
    // can.
    const patch = await agent
      .patch(`/api/v1/custom-assets/${customId}`)
      .set(...XRW)
      .send({ name: 'Zeta Immobilien' });
    expect(patch.status).toBe(200);

    // Only the date validator, exactly as a bare API-key/CLI client — or an
    // intermediary that strips ETags — would send it.
    const after = await agent.get('/api/v1/search?q=COND').set('If-Modified-Since', watermark);
    expect(after.status).toBe(200);
    const names = after.body.results.map((r: { name: string }) => r.name);
    expect(names).toContain('Zeta Immobilien');
    expect(names).not.toContain('ACME Immobilien');
    expect(Date.parse(after.headers['last-modified'] as string)).toBeGreaterThan(
      Date.parse(watermark),
    );
  });

  it('moves the watermark for every column the search read returns or ranks on (#1762)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const assetId = await seedAsset(harness, 'CONDF');

    // The columns `assetRepository.searchCatalog` projects, matches or orders
    // on. `meta` is in the list although it is in none of those three: the
    // trigger is deliberately column-agnostic, so the day a column joins the
    // search projection it is already covered — by construction, not by
    // remembering to extend a WHEN clause. `ownerId` goes last so the earlier
    // edits run against the global-market-asset shape they were seeded as.
    const edits: [string, Record<string, unknown>][] = [
      ['name', { name: 'CONDF Renamed AG' }],
      ['symbol', { symbol: 'CONDF2' }],
      ['exchange', { exchange: 'XNAS' }],
      ['currency', { currency: 'USD' }],
      ['type', { type: 'etf' }],
      ['providerRef', { providerRef: 'COND-FIELDS-2' }],
      ['providerId', { providerId: 'stooq' }],
      ['meta', { meta: { note: 'not in the projection — covered anyway' } }],
      ['ownerId', { ownerId: user.id }],
    ];

    let watermark = (await agent.get('/api/v1/search?q=COND')).headers['last-modified'] as string;
    expect(watermark).toBeTruthy();

    for (const [column, patch] of edits) {
      await harness.db.update(schema.assets).set(patch).where(eq(schema.assets.id, assetId));
      const after = await agent.get('/api/v1/search?q=COND').set('If-Modified-Since', watermark);
      expect(after.status, `an update of "${column}" must not answer 304`).toBe(200);
      const next = after.headers['last-modified'] as string;
      expect(
        Date.parse(next),
        `an update of "${column}" must advance the watermark`,
      ).toBeGreaterThan(Date.parse(watermark));
      watermark = next;
    }
  });

  it('answers 200 with the corrected name after a global catalog refresh (#1810)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const repo = createAssetRepository(harness.db);
    const seeded: GlobalAssetUpsert = {
      providerId: 'yahoo',
      providerRef: 'COND-REFRESH',
      type: 'stock',
      symbol: 'CONDG',
      name: 'CONDG Computer Inc',
      exchange: 'XETRA',
      currency: 'EUR',
    };
    await repo.upsertGlobal(seeded);

    const first = await agent.get('/api/v1/search?q=COND');
    expect(first.status).toBe(200);
    expect(first.body.results.map((r: { name: string }) => r.name)).toContain('CONDG Computer Inc');
    const watermark = first.headers['last-modified'] as string;

    // A global row was write-once before #1810, so this is a new write path on
    // the same rail as the custom-asset rename above: the seed (or a provider
    // re-enrichment) correcting a stale name keeps the row's id, so only the
    // catalog write stamp can carry it to a client holding the old validator.
    const { created, refreshed } = await repo.upsertGlobal(
      { ...seeded, name: 'CONDG Corp' },
      { refresh: REFRESHABLE_ASSET_FIELDS },
    );
    expect({ created, refreshed }).toEqual({ created: false, refreshed: true });

    const after = await agent.get('/api/v1/search?q=COND').set('If-Modified-Since', watermark);
    expect(after.status).toBe(200);
    const names = after.body.results.map((r: { name: string }) => r.name);
    expect(names).toContain('CONDG Corp');
    expect(names).not.toContain('CONDG Computer Inc');
    expect(Date.parse(after.headers['last-modified'] as string)).toBeGreaterThan(
      Date.parse(watermark),
    );
  });

  it('answers 200 for a catalog insert inside the current watermark second (#1762)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    // Two crafted UUIDv7 ids 256 ms apart INSIDE one second (the leading 48 bits
    // are the creation ms, §4.4), and far newer than every seeded row so they
    // are what the "newest visible id" term reads. `Last-Modified` /
    // `If-Modified-Since` are second-granular, so that term alone cannot
    // separate them — the second insert would be delivered as a 304. This is
    // the §6.2 "Searching providers…" refetch loop: background enrichment lands
    // a row in the same second the client last revalidated.
    const earlier = '01b80000-0100-7000-8000-0000000000c1';
    const later = '01b80000-0200-7000-8000-0000000000c2';
    const insert = (id: string, symbol: string) =>
      harness.db.insert(schema.assets).values({
        id,
        providerId: 'yahoo',
        providerRef: symbol,
        ownerId: null,
        type: 'stock',
        symbol,
        name: `${symbol} Corp`,
        currency: 'EUR',
      });

    await insert(earlier, 'CONDS');
    const first = await agent.get('/api/v1/search?q=COND');
    expect(first.status).toBe(200);
    const watermark = first.headers['last-modified'] as string;

    await insert(later, 'CONDT');

    const after = await agent.get('/api/v1/search?q=COND').set('If-Modified-Since', watermark);
    expect(after.status).toBe(200);
    expect(after.body.results.map((r: { symbol: string }) => r.symbol)).toContain('CONDT');
  });

  it('does not leak a catalog validator across the auth boundary', async () => {
    const userA = await harness.seedUser();
    const agentA = await loginAgent(harness.app, userA.email, userA.password);
    const resA = await agentA.get('/api/v1/search?q=COND');

    const userB = await harness.seedUser({ email: 'user-b@bettertrack.test', username: 'userb' });
    const agentB = await loginAgent(harness.app, userB.email, userB.password);
    const resB = await agentB.get('/api/v1/search?q=COND');

    // Identical catalog view, but the identity-salted ETags never collide.
    expect(resA.headers.etag).not.toBe(resB.headers.etag);
    const cross = await agentB
      .get('/api/v1/search?q=COND')
      .set('If-None-Match', resA.headers.etag as string);
    expect(cross.status).toBe(200);
  });
});
