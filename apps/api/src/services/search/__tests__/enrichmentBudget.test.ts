import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { describe, expect, it } from 'vitest';

import { createAssetRepository } from '../../../data/repositories/assetRepository';
import * as schema from '../../../data/schema';
import { createTestApp } from '../../../testing/createTestApp';
import { createRecordingBackfill, createStubMarketData } from '../../../testing/marketDataStubs';
import { createCatalogEnrichment } from '../catalogEnrichment';
import { createSearchEnrichmentBudget } from '../enrichmentBudget';
import { createSearchService } from '../searchService';

/**
 * The interactive provider-fallback budget (§6.2, #1709).
 *
 * `GET /search` answers from Postgres, but a thin result set also starts a
 * background provider search that upserts into the SHARED global catalog and
 * enqueues a backfill per new row. That fallback coalesces per query, so
 * *distinct* queries never coalesce: one account issuing distinct misses used
 * to buy one provider fan-out per request, all the way up to the request
 * limiter. These tests pin the ceiling — and that spending it costs the caller
 * only the background work, never the catalog read.
 */

async function makeSearch(budget: number) {
  const h = await createTestApp({ marketData: createStubMarketData() });
  const marketData = createStubMarketData();
  const assetRepo = createAssetRepository(h.db);
  const redis = new RedisMock() as unknown as Redis;
  // ioredis-mock shares one store per worker — isolate this test's keys.
  await redis.flushall();
  const enrichment = createCatalogEnrichment({
    marketData,
    assetRepo,
    backfill: createRecordingBackfill(),
    redis,
    logger: h.ctx.logger,
  });
  const service = createSearchService({
    assetRepo,
    enrichment,
    enrichmentBudget: createSearchEnrichmentBudget({
      redis,
      logger: h.ctx.logger,
      budget,
      windowSeconds: 60,
    }),
  });
  const user = await h.seedUser({ email: 'budget@s.test', username: 'budget' });
  // One market asset every query below still matches by symbol prefix, so each
  // request is a genuine catalog MISS (< 3 market matches ⇒ fallback) that
  // nevertheless has something to return.
  await h.db.insert(schema.assets).values({
    providerId: 'yahoo',
    providerRef: 'ZETAFUND',
    ownerId: null,
    type: 'etf',
    symbol: 'ZETAFUND',
    name: 'Zeta Fund',
    currency: 'EUR',
    exchange: 'XETRA',
  });
  return { h, service, marketData, userId: user.id };
}

describe('interactive enrichment budget', () => {
  it('stops the provider fan-out after the budget while the catalog still answers', async () => {
    const { service, marketData, userId } = await makeSearch(3);
    const queries = ['z', 'ze', 'zet', 'zeta', 'zetaf', 'zetafu'];

    const responses = [];
    for (const q of queries) {
      responses.push(await service.search(userId, q));
      await service.enrichmentSettled();
    }

    // Three distinct misses admitted, the rest refused — one provider search
    // each, and no more.
    expect(marketData.calls.search).toBe(3);
    expect(responses.map((r) => r.enriching)).toEqual([true, true, true, false, false, false]);
    // The local-first read is untouched by a spent budget: every request still
    // returned the matching catalog row.
    expect(responses.map((r) => r.results.map((x) => x.symbol))).toEqual(
      queries.map(() => ['ZETAFUND']),
    );
  });

  it('does not charge the client’s "Searching providers…" refetch loop twice', async () => {
    const { service, marketData, userId } = await makeSearch(2);

    // The client polls the SAME query while the server reports `enriching`.
    for (let i = 0; i < 6; i += 1) {
      await service.search(userId, 'zet');
      await service.enrichmentSettled();
    }
    // A second, genuinely distinct miss must still be affordable.
    const other = await service.search(userId, 'zeta');
    await service.enrichmentSettled();

    expect(other.enriching).toBe(true);
    expect(marketData.calls.search).toBe(2);
  });

  it('spends nothing when the catalog already answers (no fallback, no slot)', async () => {
    const { h, service, marketData, userId } = await makeSearch(1);
    for (const symbol of ['ZETAONE', 'ZETATWO']) {
      await h.db.insert(schema.assets).values({
        providerId: 'yahoo',
        providerRef: symbol,
        ownerId: null,
        type: 'etf',
        symbol,
        name: `${symbol} Fund`,
        currency: 'EUR',
        exchange: 'XETRA',
      });
    }

    // Three market matches ⇒ not a thin result set ⇒ no fallback at all, so the
    // one-slot budget survives for the miss that follows.
    const rich = await service.search(userId, 'zeta');
    await service.enrichmentSettled();
    expect(rich.enriching).toBe(false);
    expect(rich.results).toHaveLength(3);

    const miss = await service.search(userId, 'qqqqq');
    await service.enrichmentSettled();
    expect(miss.enriching).toBe(true);
    expect(marketData.calls.search).toBe(1);
  });

  it('does not charge a caller that carries its own ceiling (the import resolver)', async () => {
    const { service, marketData, userId } = await makeSearch(1);

    // The import resolver spends a slot of IMPORT_ENRICHMENT_QUERY_BUDGET per
    // attempt; charging the interactive window as well would let a minute of
    // ordinary searching leave an import's instruments unresolved.
    for (const q of ['zet', 'zeta', 'zetaf']) {
      const res = await service.search(userId, q, { budgetedByCaller: true });
      await service.enrichmentSettled();
      expect(res.enriching).toBe(true);
    }
    expect(marketData.calls.search).toBe(3);

    // …and the untouched interactive budget is still there for the user.
    const interactive = await service.search(userId, 'zetafu');
    await service.enrichmentSettled();
    expect(interactive.enriching).toBe(true);
    expect(marketData.calls.search).toBe(4);
  });

  it('admits exactly the budget when distinct queries arrive concurrently', async () => {
    const { h, userId } = await makeSearch(3);
    const redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    const budget = createSearchEnrichmentBudget({
      redis,
      logger: h.ctx.logger,
      budget: 3,
      windowSeconds: 60,
    });

    // Five distinct misses in flight at once — a debounced prefix burst. The
    // count each decision is made on has to be the count that admission joined,
    // or the answers disagree with the ceiling in both directions: read the set
    // size after everyone has added and all five are over budget (nobody gets
    // the fan-out they are entitled to).
    const admitted = await Promise.all(
      ['z', 'ze', 'zet', 'zeta', 'zetaf'].map((q) => budget.admit(userId, q)),
    );

    expect(admitted.filter(Boolean)).toHaveLength(3);
    // …and the survivors still hold the set, so the window is genuinely spent
    // rather than emptied by mutual refusal.
    await expect(budget.admit(userId, 'zetafu')).resolves.toBe(false);
  });

  it('fails closed when Redis is unavailable — the catalog still answers', async () => {
    const { h, service, marketData, userId } = await makeSearch(5);
    const deadChain = {
      scard: () => deadChain,
      sadd: () => deadChain,
      exec: () => Promise.reject(new Error('redis down')),
    };
    const budget = createSearchEnrichmentBudget({
      redis: {
        multi: () => deadChain,
      } as unknown as Redis,
      logger: h.ctx.logger,
      budget: 5,
      windowSeconds: 60,
    });

    await expect(budget.admit(userId, 'zeta')).resolves.toBe(false);
    // Sanity: the wired service (working Redis) would have admitted it.
    const answered = await service.search(userId, 'zeta');
    await service.enrichmentSettled();
    expect(answered.results.map((r) => r.symbol)).toEqual(['ZETAFUND']);
    expect(marketData.calls.search).toBe(1);
  });
});
