import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { searchResponseSchema } from '@bettertrack/contracts';

import { eq } from 'drizzle-orm';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import {
  createRecordingBackfill,
  createStubMarketData,
  providerHit,
  type RecordingBackfill,
} from '../testing/marketDataStubs';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/** Insert a global (owner-less) catalog row directly, as the seed/enrichment would. */
async function seedCatalogAsset(
  h: TestHarness,
  input: { symbol: string; name: string; providerRef?: string },
): Promise<string> {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: input.providerRef ?? input.symbol,
      ownerId: null,
      type: 'stock',
      symbol: input.symbol,
      name: input.name,
      exchange: 'XETRA',
      currency: 'EUR',
    })
    .returning();
  return row!.id;
}

/** Count asset rows for a provider ref (global market assets in these tests). */
async function countGlobal(h: TestHarness, providerRef: string): Promise<number> {
  const rows = await h.db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(eq(schema.assets.providerRef, providerRef));
  return rows.length;
}

describe('GET /api/v1/search', () => {
  let backfill: RecordingBackfill;

  beforeEach(() => {
    backfill = createRecordingBackfill();
  });

  it('requires authentication', async () => {
    const h = await createTestApp({ marketData: createStubMarketData(), backfill });
    const res = await request(h.app).get('/api/v1/search?q=apple');
    expect(res.status).toBe(401);
  });

  it('rejects an empty (or whitespace-only) query', async () => {
    const h = await createTestApp({ marketData: createStubMarketData(), backfill });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get('/api/v1/search?q=%20%20');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('answers a single-character query from the catalog with zero synchronous provider calls (owner override, §13.2)', async () => {
    const marketData = createStubMarketData({
      search: () => new Promise<never>(() => undefined),
    });
    const h = await createTestApp({ marketData, backfill });
    await seedCatalogAsset(h, { symbol: 'V', name: 'Visa Inc.' });
    await seedCatalogAsset(h, { symbol: 'AAPL', name: 'Apple Inc.' });

    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get('/api/v1/search?q=V');
    expect(res.status).toBe(200);
    const parsed = searchResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.results[0]?.symbol).toBe('V');
  });

  it.each(['bayer', 'bay', 'bayr', 'BAYN'])(
    'answers %j with BAYN.DE from the catalog with zero synchronous provider calls',
    async (q) => {
      // A provider that never answers: if the response depended on any
      // synchronous provider round-trip, the request would hang and time out.
      const marketData = createStubMarketData({
        search: () => new Promise<never>(() => undefined),
      });
      const h = await createTestApp({ marketData, backfill });
      await seedCatalogAsset(h, { symbol: 'BAYN.DE', name: 'Bayer AG' });
      await seedCatalogAsset(h, { symbol: 'AAPL', name: 'Apple Inc.' });
      await seedCatalogAsset(h, { symbol: 'SAP.DE', name: 'SAP SE' });

      const user = await h.seedUser();
      const agent = await loginAgent(h.app, user.email, user.password);

      const res = await agent.get(`/api/v1/search?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);

      const parsed = searchResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.results[0]?.symbol).toBe('BAYN.DE');
    },
  );

  it('resolves a misspelled query via the trigram index where a provider would 404', async () => {
    // The provider hard-fails on the misspelling — no error may surface (§6.2).
    const marketData = createStubMarketData({
      search: () => {
        throw new Error('provider 404: no symbol BAYR');
      },
    });
    const h = await createTestApp({ marketData, backfill });
    await seedCatalogAsset(h, { symbol: 'BAYN.DE', name: 'Bayer AG' });

    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get('/api/v1/search?q=bayr');
    expect(res.status).toBe(200);
    expect(res.body.results[0]?.symbol).toBe('BAYN.DE');

    // The background fallback failed silently; the API stays healthy.
    await h.ctx.search.enrichmentSettled();
    const again = await agent.get('/api/v1/search?q=bayr');
    expect(again.status).toBe(200);
    expect(again.body.results[0]?.symbol).toBe('BAYN.DE');
  });

  it('on a catalog miss runs exactly one background provider search, upserts, and serves the follow-up from Postgres', async () => {
    const marketData = createStubMarketData({
      search: () => [providerHit({ providerRef: 'BAYN.DE', symbol: 'BAYN.DE', name: 'Bayer AG' })],
    });
    const h = await createTestApp({ marketData, backfill });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);

    // Empty catalog: immediate empty answer, enrichment kicked off in the background.
    const miss = await agent.get('/api/v1/search?q=bayn');
    expect(miss.status).toBe(200);
    expect(miss.body.results).toHaveLength(0);
    expect(miss.body.enriching).toBe(true);

    await h.ctx.search.enrichmentSettled();
    expect(marketData.calls.search).toBe(1);
    expect(await countGlobal(h, 'BAYN.DE')).toBe(1);
    // First touch: exactly one backfill for the newly created row.
    expect(backfill.enqueued).toHaveLength(1);

    // Follow-up query ("Searching providers…" refetch): enriched rows from the
    // catalog, no second provider search, and no further "still enriching" signal.
    const hit = await agent.get('/api/v1/search?q=bayn');
    expect(hit.status).toBe(200);
    expect(hit.body.results.map((r: { symbol: string }) => r.symbol)).toEqual(['BAYN.DE']);
    expect(hit.body.enriching).toBe(false);
    expect(marketData.calls.search).toBe(1);
    expect(backfill.enqueued).toHaveLength(1);
  });

  it('coalesces concurrent catalog misses into one provider search', async () => {
    const marketData = createStubMarketData({
      search: () => [providerHit({ providerRef: 'TSLA', symbol: 'TSLA', name: 'Tesla, Inc.' })],
    });
    const h = await createTestApp({ marketData, backfill });
    const user = await h.seedUser();

    // Independent connections (not one keep-alive agent socket) so the five
    // requests genuinely run concurrently.
    const login = await request(h.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(login.status).toBe(200);
    const cookies = login.get('Set-Cookie') ?? [];

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(h.app).get('/api/v1/search?q=tesla').set('Cookie', cookies),
      ),
    );
    for (const res of responses) expect(res.status).toBe(200);

    await h.ctx.search.enrichmentSettled();
    expect(marketData.calls.search).toBe(1);
    expect(await countGlobal(h, 'TSLA')).toBe(1);
    expect(backfill.enqueued).toHaveLength(1);
  });

  it('merges the caller’s custom assets and keeps them owner-scoped', async () => {
    const marketData = createStubMarketData({ search: () => [] });
    const h = await createTestApp({ marketData, backfill });
    const owner = await h.seedUser({ email: 'owner@s.test', username: 'owner' });
    const other = await h.seedUser({ email: 'other@s.test', username: 'other' });

    await seedCatalogAsset(h, { symbol: 'AAPL', name: 'Apple Inc.' });
    await h.db.insert(schema.assets).values({
      providerId: 'manual',
      providerRef: 'custom-apple-house',
      ownerId: owner.id,
      type: 'custom',
      symbol: 'HOUSE',
      name: 'Apple Street House',
      currency: 'EUR',
    });

    const ownerAgent = await loginAgent(h.app, owner.email, owner.password);
    const ownerRes = await ownerAgent.get('/api/v1/search?q=apple');
    expect(ownerRes.status).toBe(200);
    const ownerSymbols = ownerRes.body.results.map((r: { symbol: string }) => r.symbol);
    expect(ownerSymbols).toEqual(['AAPL', 'HOUSE']);
    const customHit = ownerRes.body.results.find((r: { isCustom: boolean }) => r.isCustom);
    expect(customHit.name).toBe('Apple Street House');

    // The other user sees the global row but never the owner's custom asset (§10).
    const otherAgent = await loginAgent(h.app, other.email, other.password);
    const otherRes = await otherAgent.get('/api/v1/search?q=apple');
    expect(otherRes.status).toBe(200);
    expect(otherRes.body.results.map((r: { symbol: string }) => r.symbol)).toEqual(['AAPL']);
  });

  it('treats LIKE wildcards in the query literally', async () => {
    const marketData = createStubMarketData({ search: () => [] });
    const h = await createTestApp({ marketData, backfill });
    const user = await h.seedUser();
    await seedCatalogAsset(h, { symbol: 'AAPL', name: 'Apple Inc.' });
    await h.db.insert(schema.assets).values({
      providerId: 'manual',
      providerRef: 'house-1',
      ownerId: user.id,
      type: 'custom',
      symbol: 'H',
      name: 'Lake House',
      currency: 'EUR',
    });

    const agent = await loginAgent(h.app, user.email, user.password);
    // '%%' must be treated literally, not as wildcards that match everything.
    const res = await agent.get('/api/v1/search?q=%25%25');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  it('does not re-run enrichment while the catalog answers well', async () => {
    const marketData = createStubMarketData({
      search: () => {
        throw new Error('must not be called');
      },
    });
    const h = await createTestApp({ marketData, backfill });
    await seedCatalogAsset(h, { symbol: 'BAYN.DE', name: 'Bayer AG' });
    await seedCatalogAsset(h, { symbol: 'BAYP', name: 'Bay Properties' });
    await seedCatalogAsset(h, { symbol: 'BAYT', name: 'Bay Technologies' });

    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get('/api/v1/search?q=bay');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.enriching).toBe(false);

    await h.ctx.search.enrichmentSettled();
    expect(marketData.calls.search).toBe(0);
  });
});
