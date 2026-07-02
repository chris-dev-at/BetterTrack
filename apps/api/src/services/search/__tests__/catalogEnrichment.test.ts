import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { describe, expect, it } from 'vitest';

import { createAssetRepository } from '../../../data/repositories/assetRepository';
import * as schema from '../../../data/schema';
import { createTestApp } from '../../../testing/createTestApp';
import {
  createRecordingBackfill,
  createStubMarketData,
  providerHit,
  type StubMarketDataControls,
} from '../../../testing/marketDataStubs';
import { createCatalogEnrichment, enrichGuardKey } from '../catalogEnrichment';

/**
 * Unit tests for the provider-fallback orchestration (§6.2, §5.3): background
 * only, coalesced per query, negative-cached via the Redis guard, and silent on
 * provider failure.
 */

async function makeEnrichment(controls: StubMarketDataControls = {}) {
  const h = await createTestApp({ marketData: createStubMarketData() });
  const marketData = createStubMarketData(controls);
  const assetRepo = createAssetRepository(h.db);
  const backfill = createRecordingBackfill();
  const redis = new RedisMock() as unknown as Redis;
  // ioredis-mock shares one store per worker — isolate this test's guards.
  await redis.flushall();
  const enrichment = createCatalogEnrichment({
    marketData,
    assetRepo,
    backfill,
    redis,
    logger: h.ctx.logger,
  });
  return { h, marketData, assetRepo, backfill, redis, enrichment };
}

describe('catalogEnrichment', () => {
  it('runs the provider search in the background and upserts hits with one backfill each', async () => {
    const { marketData, assetRepo, backfill, enrichment } = await makeEnrichment({
      search: () => [
        providerHit({ providerRef: 'BAYN.DE', symbol: 'BAYN.DE', name: 'Bayer AG' }),
        providerHit({ providerRef: 'MSFT', symbol: 'MSFT', name: 'Microsoft' }),
      ],
    });

    await expect(enrichment.request('bayn')).resolves.toBe(true);
    await enrichment.settled();

    expect(marketData.calls.search).toBe(1);
    expect(await assetRepo.findGlobal('yahoo', 'BAYN.DE')).not.toBeNull();
    expect(await assetRepo.findGlobal('yahoo', 'MSFT')).not.toBeNull();
    expect(backfill.enqueued).toHaveLength(2);
  });

  it('coalesces concurrent requests for the same query into one provider search', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { marketData, enrichment } = await makeEnrichment({
      search: async () => {
        await gate;
        return [providerHit()];
      },
    });

    const first = await enrichment.request('tesla');
    const second = await enrichment.request('tesla');
    expect(first).toBe(true);
    expect(second).toBe(true); // already in flight — no new search
    release();
    await enrichment.settled();

    expect(marketData.calls.search).toBe(1);
  });

  it('treats symbol case as one query when coalescing', async () => {
    const { marketData, enrichment } = await makeEnrichment({ search: () => [providerHit()] });

    await enrichment.request('BAYN');
    await enrichment.settled();
    await expect(enrichment.request('bayn')).resolves.toBe(false);
    await enrichment.settled();

    expect(marketData.calls.search).toBe(1);
  });

  it('does not re-fetch a recently enriched query — including a negative result', async () => {
    const { marketData, enrichment, redis } = await makeEnrichment({ search: () => [] });

    await expect(enrichment.request('unknown')).resolves.toBe(true);
    await enrichment.settled();
    // Providers had nothing; the guard still holds so keystrokes don't hammer them.
    await expect(enrichment.request('unknown')).resolves.toBe(false);
    await enrichment.settled();
    expect(marketData.calls.search).toBe(1);

    // Once the guard expires, the fallback may run again.
    await redis.del(enrichGuardKey('unknown'));
    await expect(enrichment.request('unknown')).resolves.toBe(true);
    await enrichment.settled();
    expect(marketData.calls.search).toBe(2);
  });

  it('swallows provider failures — an outage or 404 never propagates', async () => {
    const { marketData, enrichment } = await makeEnrichment({
      search: () => {
        throw new Error('provider 404');
      },
    });

    await expect(enrichment.request('bayr')).resolves.toBe(true);
    await expect(enrichment.settled()).resolves.toBeUndefined();
    expect(marketData.calls.search).toBe(1);
    // The failure is guarded too: no immediate retry storm.
    await expect(enrichment.request('bayr')).resolves.toBe(false);
  });

  it('re-enriching an already cataloged asset neither duplicates the row nor re-enqueues a backfill', async () => {
    const { h, assetRepo, backfill, enrichment, redis } = await makeEnrichment({
      search: () => [providerHit({ providerRef: 'AAPL', symbol: 'AAPL', name: 'Apple Inc.' })],
    });

    await enrichment.request('apple');
    await enrichment.settled();
    expect(backfill.enqueued).toHaveLength(1);

    await redis.del(enrichGuardKey('apple'));
    await enrichment.request('apple');
    await enrichment.settled();

    const rows = await h.db.select({ id: schema.assets.id }).from(schema.assets);
    expect(rows).toHaveLength(1);
    expect(await assetRepo.findGlobal('yahoo', 'AAPL')).not.toBeNull();
    expect(backfill.enqueued).toHaveLength(1);
  });
});
