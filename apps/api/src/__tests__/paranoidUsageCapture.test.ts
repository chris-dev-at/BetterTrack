import request from 'supertest';
import type { Application } from 'express';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createApiKeyResponseSchema, type CachedResult, type Quote } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import { createStubMarketData } from '../testing/marketDataStubs';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

/**
 * Paranoid mode never lets the server learn a holdings ROSTER (§13.5 V5-P13 arc
 * b, `docs/paranoid-design.md` §1).
 *
 * The leak these tests pin: a paranoid client decrypts its vault and values the
 * portfolio locally, so it issues one `GET /assets/:id/quote` PER HOLDING, every
 * day (`portfolioEngine` → `marketDataSource`). `usageCapture` folded exactly
 * those reads into `usage_events` as `(user_id, feature='assets', asset_id, day)`
 * — writing the account's complete holdings roster to the server daily, keyed to
 * its user id. `/assets/:id/quote` is a KEPT path for paranoid accounts (asset
 * market data is deliberately still served), so nothing else stopped it.
 */

const cachedQuote = (): CachedResult<Quote> => ({
  value: {
    price: 187.5,
    currency: 'USD',
    prevClose: 185,
    dayChangePct: 1.35,
    asOf: '2026-06-20T09:59:00.000Z',
  } satisfies Quote,
  stale: false,
  asOf: Date.parse('2026-06-20T10:00:00.000Z'),
});

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function seedGlobalAsset(h: TestHarness, symbol: string) {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      ownerId: null,
      type: 'stock',
      symbol,
      name: `${symbol} Inc.`,
      exchange: 'NASDAQ',
      currency: 'USD',
    })
    .returning();
  if (!row) throw new Error('failed to seed asset');
  return row;
}

/**
 * Flip the mode directly — the capture path reads only `users.privacy_mode`, so
 * these cases need no vault. The media set comes along because the
 * `users_paranoid_media_state` check constraint requires a paranoid row to name
 * one; the full enable transaction is exercised separately, in
 * `paranoidTransitionService.test.ts`.
 */
async function makeParanoid(h: TestHarness, userId: string): Promise<void> {
  await h.db
    .update(schema.users)
    .set({ privacyMode: 'paranoid', paranoidMediaSet: ['server'] })
    .where(eq(schema.users.id, userId));
}

async function usageRowsFor(h: TestHarness, userId: string) {
  return h.db.select().from(schema.usageEvents).where(eq(schema.usageEvents.userId, userId));
}

describe('usage capture never records a paranoid account', () => {
  /**
   * The control. Without it a broken suppression (or a broken route) would look
   * identical to a passing fix, because "no rows" is also what a request that
   * never reached the middleware produces.
   */
  it('DOES record the asset roster for a normal account (the leak, reproduced)', async () => {
    const h = await createTestApp({ marketData: createStubMarketData({ quote: cachedQuote }) });
    const user = await h.seedUser({ email: 'normal@test.dev', username: 'normal_usage' });
    const aapl = await seedGlobalAsset(h, 'AAPL');
    const msft = await seedGlobalAsset(h, 'MSFT');
    const agent = await loginAgent(h.app, user.email, user.password);

    // Exactly what the vault valuation engine does: one quote read per holding.
    expect((await agent.get(`/api/v1/assets/${aapl.id}/quote`)).status).toBe(200);
    expect((await agent.get(`/api/v1/assets/${msft.id}/quote`)).status).toBe(200);
    await h.ctx.usageAnalytics.flush();

    const captured = (await usageRowsFor(h, user.id))
      .filter((r) => r.assetId !== '')
      .map((r) => r.assetId)
      .sort();
    expect(captured).toEqual([aapl.id, msft.id].sort());
  });

  it('records NOTHING for a paranoid account over a cookie session', async () => {
    const h = await createTestApp({ marketData: createStubMarketData({ quote: cachedQuote }) });
    const user = await h.seedUser({ email: 'paranoid@test.dev', username: 'paranoid_usage' });
    const aapl = await seedGlobalAsset(h, 'AAPL');
    const msft = await seedGlobalAsset(h, 'MSFT');
    const agent = await loginAgent(h.app, user.email, user.password);
    await makeParanoid(h, user.id);
    // Drop anything the login itself captured, so the assertion is unambiguous.
    await h.ctx.usageAnalytics.flush();
    await h.db.delete(schema.usageEvents).where(eq(schema.usageEvents.userId, user.id));

    expect((await agent.get(`/api/v1/assets/${aapl.id}/quote`)).status).toBe(200);
    expect((await agent.get(`/api/v1/assets/${msft.id}/quote`)).status).toBe(200);
    // A non-asset read too: the whole signal is suppressed, not just the id.
    expect((await agent.get('/api/v1/notifications')).status).toBe(200);
    await h.ctx.usageAnalytics.flush();

    expect(await usageRowsFor(h, user.id)).toEqual([]);
  });

  /**
   * `privacyMode` reaches `req.authUser` through the SAME `toAuthUser(row)`
   * mapper for all three principals, so the bearer paths must be covered too —
   * a scripted paranoid client is exactly the case that would otherwise slip
   * past a cookie-only guard.
   */
  it('records NOTHING for a paranoid account over a personal API key', async () => {
    const h = await createTestApp({ marketData: createStubMarketData({ quote: cachedQuote }) });
    const user = await h.seedUser({ email: 'key@test.dev', username: 'paranoid_key' });
    const aapl = await seedGlobalAsset(h, 'AAPL');
    const agent = await loginAgent(h.app, user.email, user.password);
    const minted = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'vault client', scopes: ['market:read'] });
    expect(minted.status).toBe(201);
    const token = createApiKeyResponseSchema.parse(minted.body).token;

    await makeParanoid(h, user.id);
    await h.ctx.usageAnalytics.flush();
    await h.db.delete(schema.usageEvents).where(eq(schema.usageEvents.userId, user.id));

    const res = await request(h.app)
      .get(`/api/v1/assets/${aapl.id}/quote`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    await h.ctx.usageAnalytics.flush();

    expect(await usageRowsFor(h, user.id)).toEqual([]);
  });

  /**
   * The enable RACE. Capture buffers in memory and flushes on a timer, so
   * signals taken while the account was still `normal` can land AFTER the enable
   * transaction purged the table — re-creating the roster rows with nothing left
   * to sweep them. The write boundary re-reads the mode to close it.
   */
  it('drops buffered pre-enable signals that flush after the mode flips', async () => {
    const h = await createTestApp();
    const user = await h.seedUser({ email: 'race@test.dev', username: 'race_usage' });

    // Captured while still normal — this is what sits in the buffer.
    h.ctx.usageAnalytics.capture({ userId: user.id, feature: 'assets', assetId: 'held-asset-id' });
    await makeParanoid(h, user.id);
    // …and only now does the timer fire, after the enable already committed.
    await h.ctx.usageAnalytics.flush();

    expect(await usageRowsFor(h, user.id)).toEqual([]);
  });

  it('still records other accounts in a batch that contains a paranoid one', async () => {
    const h = await createTestApp();
    const paranoid = await h.seedUser({ email: 'p2@test.dev', username: 'p2_usage' });
    const normal = await h.seedUser({ email: 'n2@test.dev', username: 'n2_usage' });
    await makeParanoid(h, paranoid.id);

    h.ctx.usageAnalytics.capture({ userId: paranoid.id, feature: 'assets', assetId: 'secret' });
    h.ctx.usageAnalytics.capture({ userId: normal.id, feature: 'assets', assetId: 'public' });
    await h.ctx.usageAnalytics.flush();

    expect(await usageRowsFor(h, paranoid.id)).toEqual([]);
    expect((await usageRowsFor(h, normal.id)).map((r) => r.assetId)).toEqual(['public']);
  });
});
