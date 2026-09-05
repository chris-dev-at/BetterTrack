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
import {
  createCatalogEnrichment,
  enrichGuardKey,
  ENRICH_GUARD_DONE,
  ENRICH_GUARD_RUNNING,
  ENRICH_GUARD_TTL_SECONDS,
  ENRICH_MAX_HITS,
  ENRICH_RUN_TIMEOUT_MS,
  rankProviderHits,
} from '../catalogEnrichment';

/**
 * Unit tests for the provider-fallback orchestration (§6.2, §5.3): background
 * only, coalesced per query, negative-cached via the Redis guard, and silent on
 * provider failure.
 */

async function makeEnrichment(
  controls: StubMarketDataControls = {},
  timeouts: { runTimeoutMs?: number; settleTimeoutMs?: number } = {},
) {
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
    ...timeouts,
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

  it('caps how many provider hits one enrichment writes into the catalog', async () => {
    const overflow = ENRICH_MAX_HITS + 5;
    const { marketData, assetRepo, backfill, enrichment, h } = await makeEnrichment({
      search: () =>
        Array.from({ length: overflow }, (_, i) =>
          providerHit({ providerRef: `HIT${i}`, symbol: `HIT${i}`, name: `Hit ${i}` }),
        ),
    });

    await enrichment.request('hit');
    await enrichment.settled();

    expect(marketData.calls.search).toBe(1);
    const rows = await h.db.select({ id: schema.assets.id }).from(schema.assets);
    expect(rows).toHaveLength(ENRICH_MAX_HITS);
    expect(backfill.enqueued).toHaveLength(ENRICH_MAX_HITS);
    // The admitted prefix is upserted…
    expect(await assetRepo.findGlobal('yahoo', `HIT${ENRICH_MAX_HITS - 1}`)).not.toBeNull();
    // …and everything past the cap is neither upserted nor enqueued.
    expect(await assetRepo.findGlobal('yahoo', `HIT${ENRICH_MAX_HITS}`)).toBeNull();
    expect(await assetRepo.findGlobal('yahoo', `HIT${overflow - 1}`)).toBeNull();
  });

  it('a request racing the guard write coalesces onto it and still reports enriching', async () => {
    const { marketData, enrichment } = await makeEnrichment({ search: () => [providerHit()] });

    // Both issued before either awaits: the second lands in the gap while the
    // first is still awaiting the Redis NX write. It must share the first
    // call's outcome (true), not lose the NX race and report false.
    const [first, second] = await Promise.all([
      enrichment.request('tesla'),
      enrichment.request('tesla'),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);

    await enrichment.settled();
    expect(marketData.calls.search).toBe(1);
  });

  it('reports enriching while another process holds the guard, and not after it finished', async () => {
    const { marketData, enrichment, redis } = await makeEnrichment();

    // Another API process is mid-enrichment for this query.
    await redis.set(enrichGuardKey('bmw'), ENRICH_GUARD_RUNNING, 'EX', ENRICH_GUARD_TTL_SECONDS);
    await expect(enrichment.request('bmw')).resolves.toBe(true);
    await enrichment.settled();

    // …and now it has finished within the TTL window (negative cache).
    await redis.set(enrichGuardKey('bmw'), ENRICH_GUARD_DONE, 'EX', ENRICH_GUARD_TTL_SECONDS);
    await expect(enrichment.request('bmw')).resolves.toBe(false);
    await enrichment.settled();

    // Neither call may have run a provider search of its own.
    expect(marketData.calls.search).toBe(0);
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

  it('a re-enrichment corrects the row it finds instead of leaving it frozen (#1810)', async () => {
    let name = 'Apple Computer, Inc.';
    let currency = 'USD';
    const { h, assetRepo, backfill, enrichment, redis } = await makeEnrichment({
      search: () => [providerHit({ providerRef: 'AAPL', symbol: 'AAPL', name, currency })],
    });

    await enrichment.request('apple');
    await enrichment.settled();
    const first = await assetRepo.findGlobal('yahoo', 'AAPL');
    expect(first?.name).toBe('Apple Computer, Inc.');

    // The provider corrects the row (a rename, a fixed currency). `name` is
    // what the catalog read returns AND ranks on, and `currency` decides base-
    // currency conversion — neither had a repair path before #1810.
    name = 'Apple Inc.';
    currency = 'EUR';
    await redis.del(enrichGuardKey('apple'));
    await enrichment.request('apple');
    await enrichment.settled();

    const refreshed = await assetRepo.findGlobal('yahoo', 'AAPL');
    expect(refreshed?.name).toBe('Apple Inc.');
    expect(refreshed?.currency).toBe('EUR');
    // In place: same row, same id — every transaction pointing at it survives —
    // and no second backfill, because nothing was created.
    expect(refreshed?.id).toBe(first?.id);
    expect(await h.db.select({ id: schema.assets.id }).from(schema.assets)).toHaveLength(1);
    expect(backfill.enqueued).toHaveLength(1);
  });
});

describe('catalogEnrichment — hits are ranked before the cap (#1794, #1810)', () => {
  it('orders provider hits by the catalog tiers, then similarity, then name', () => {
    const hits = [
      providerHit({ providerRef: 'FUZZ', symbol: 'FUZZ', name: 'Something else' }),
      providerHit({ providerRef: 'GOLDX', symbol: 'GOLDX', name: 'Prefix match' }),
      providerHit({ providerRef: 'BARS', symbol: 'BARS', name: 'Gold Bars plc' }),
      providerHit({ providerRef: 'GOLD', symbol: 'GOLD', name: 'Exact match' }),
      providerHit({ providerRef: 'GOLDY', symbol: 'GOLDY', name: 'Second prefix' }),
    ];

    expect(rankProviderHits('gold', hits).map((hit) => hit.symbol)).toEqual([
      'GOLD', // tier 0 — exact symbol
      'GOLDX', // tier 1 — symbol prefix; equal similarity, so "Prefix match"…
      'GOLDY', // tier 1 — …sorts before "Second prefix" (the read's `order by name`)
      'BARS', // tier 2 — name substring
      'FUZZ', // tier 3 — neither
    ]);
  });

  it('admits an exact-symbol match that a provider returned past the cap', async () => {
    // 40 hits in registration order with the exact match at position 25 — the
    // scenario the raw `slice(0, ENRICH_MAX_HITS)` discarded. The filler names
    // are zero-padded so that the read's last tiebreak (`order by name`, all of
    // them scoring the same zero similarity against "gold") runs in the same
    // order as their index, and the assertions below can name the boundary.
    const hits = Array.from({ length: 40 }, (_, i) =>
      providerHit({
        providerRef: `FUZZ${i}`,
        symbol: `FUZZ${i}`,
        name: `Fuzzy ${String(i).padStart(2, '0')}`,
      }),
    );
    hits[24] = providerHit({ providerRef: 'GOLD', symbol: 'GOLD', name: 'Gold Corp' });
    const { assetRepo, backfill, enrichment } = await makeEnrichment({ search: () => hits });

    await enrichment.request('gold');
    await enrichment.settled();

    // The one row the follow-up catalog read would rank tier 0 is in the catalog…
    expect(await assetRepo.findGlobal('yahoo', 'GOLD')).not.toBeNull();
    // …the cap still holds, and it now sheds the LOWEST-ranked hits.
    expect(backfill.enqueued).toHaveLength(ENRICH_MAX_HITS);
    expect(await assetRepo.findGlobal('yahoo', 'FUZZ18')).not.toBeNull();
    expect(await assetRepo.findGlobal('yahoo', 'FUZZ19')).toBeNull();
  });

  it('admits a WORD match past the cap that String.includes cannot see (#1810)', async () => {
    // `plainto_tsquery('simple', 'ag bayer')` matches "BAYN.DE Bayer AG"
    // order-free — the SQL grades it tier 2 — while
    // `"bayer ag".includes("ag bayer")` is false, so the old mirror graded it
    // tier 3 with everything else and the slice dropped it at position 22.
    const hits = Array.from({ length: 40 }, (_, i) =>
      providerHit({ providerRef: `FUZZ${i}`, symbol: `FUZZ${i}`, name: `Fuzzy ${i}` }),
    );
    hits[21] = providerHit({ providerRef: 'BAYN.DE', symbol: 'BAYN.DE', name: 'Bayer AG' });
    const { assetRepo, backfill, enrichment } = await makeEnrichment({ search: () => hits });

    await enrichment.request('ag bayer');
    await enrichment.settled();

    expect(await assetRepo.findGlobal('yahoo', 'BAYN.DE')).not.toBeNull();
    expect(backfill.enqueued).toHaveLength(ENRICH_MAX_HITS);
  });

  it('admits a MISSPELLED match past the cap, ranked by similarity (#1810)', async () => {
    // The §6.2 flagship path: "etherium" is tier 3 for every hit, so the tiers
    // decide nothing and the ordering is the whole answer. Ordered by provider
    // registration index — the old tiebreak — `ETH-USD` at position 22 was
    // dropped, twenty junk rows were written and backfilled instead, and the
    // follow-up catalog read filtered those out at the similarity floor: no
    // results at all for a query the providers had answered.
    const hits = Array.from({ length: 30 }, (_, i) =>
      providerHit({ providerRef: `QQQ${i}`, symbol: `QQQ${i}`, name: `Quantum Fund ${i}` }),
    );
    hits[21] = providerHit({ providerRef: 'ETH-USD', symbol: 'ETH-USD', name: 'Ethereum USD' });
    const { assetRepo, backfill, enrichment } = await makeEnrichment({ search: () => hits });

    await enrichment.request('etherium');
    await enrichment.settled();

    expect(await assetRepo.findGlobal('yahoo', 'ETH-USD')).not.toBeNull();
    expect(backfill.enqueued).toHaveLength(ENRICH_MAX_HITS);
    // It is not merely admitted, it is admitted FIRST — the fuzzy tier is
    // ordered by trigram similarity, exactly as the catalog read orders it.
    expect(rankProviderHits('etherium', hits)[0]?.symbol).toBe('ETH-USD');
  });
});

describe('catalogEnrichment — the guard is an owned lease (#1794)', () => {
  it('bounds one run below the lease, so the guard cannot expire under its own holder', () => {
    // The invariant behind "exactly one upstream fetch per key" (§5.3): a run
    // that cannot outlive its lease cannot hand a second process the NX win.
    expect(ENRICH_RUN_TIMEOUT_MS).toBeLessThan(ENRICH_GUARD_TTL_SECONDS * 1000);
  });

  it('a finisher whose lease expired cannot clobber the successor’s guard', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { enrichment, redis } = await makeEnrichment({
      search: async () => {
        await gate;
        return [];
      },
    });

    await expect(enrichment.request('bayn')).resolves.toBe(true);
    // The lease expires mid-run and another process wins NX for the same query.
    const successor = `${ENRICH_GUARD_RUNNING}:successor-process`;
    await redis.set(enrichGuardKey('bayn'), successor, 'EX', ENRICH_GUARD_TTL_SECONDS);

    release();
    await enrichment.settled();

    // The first finisher must NOT have flipped a lease it no longer owns…
    expect(await redis.get(enrichGuardKey('bayn'))).toBe(successor);
    // …so a third caller is still correctly told an enrichment is in flight,
    // instead of reading `done` and reporting `enriching: false`.
    await expect(enrichment.request('bayn')).resolves.toBe(true);
  });

  it('completes its own lease normally — the negative-cache window still applies', async () => {
    const { enrichment, redis } = await makeEnrichment({ search: () => [] });

    await expect(enrichment.request('bmw')).resolves.toBe(true);
    await enrichment.settled();
    expect(await redis.get(enrichGuardKey('bmw'))).toBe(ENRICH_GUARD_DONE);
  });

  it('bounds settled(), so one stuck enrichment cannot hang graceful shutdown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { enrichment, marketData } = await makeEnrichment(
      {
        search: async () => {
          await gate;
          return [];
        },
      },
      { settleTimeoutMs: 25, runTimeoutMs: 30_000 },
    );

    await enrichment.request('wedged');
    // The provider never answers; the shutdown wait returns anyway.
    await expect(enrichment.settled()).resolves.toBeUndefined();
    expect(marketData.calls.search).toBe(1);

    release();
    await enrichment.settled();
  });
});
