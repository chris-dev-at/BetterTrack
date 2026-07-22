import type { CachedResult, PricePoint, Quote } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../../logger';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { createLiveModeService, type LiveModeService } from '../liveModeService';
import { createLiveRingBuffer, liveRingKey } from '../ringBuffer';

const ASSET_ID = '018f6f00-0000-7000-8000-00000000000a';
const REF = { providerId: 'yahoo', providerRef: 'BAYN.DE' };

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const quoteResult = (price: number): CachedResult<Quote> => ({
  value: { price, currency: 'EUR', dayChangePct: 1.5, asOf: new Date().toISOString() },
  stale: false,
  asOf: Date.now(),
});

let redis: Redis;
let services: LiveModeService[];

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  services = [];
});

afterEach(() => {
  for (const service of services) service.close();
});

const emptyHistory = (): CachedResult<PricePoint[]> => ({ value: [], stale: false, asOf: 0 });

function makeService(
  stub = createStubMarketData({ poll: () => quoteResult(100), history: emptyHistory }),
  options: {
    intervalMs?: number;
    maxIntervalMs?: number;
    ringCapacity?: number;
    now?: () => number;
  } = {},
) {
  const service = createLiveModeService({
    marketData: stub,
    redis,
    logger: noopLogger,
    options: { intervalMs: 20, maxIntervalMs: 160, ...options },
  });
  services.push(service);
  return { service, stub };
}

describe('liveModeService — one loop per hot asset (§5.3)', () => {
  it('the first watcher starts the loop; further watchers never add upstream calls', async () => {
    let price = 100;
    const stub = createStubMarketData({ poll: () => quoteResult(price++) });
    const { service } = makeService(stub);

    service.watch(ASSET_ID, REF);
    await vi.waitFor(() => expect(stub.calls.poll).toBeGreaterThanOrEqual(2));

    // Two more viewers arrive: same loop, only the counter moves.
    service.watch(ASSET_ID, REF);
    service.watch(ASSET_ID, REF);
    expect(service.watcherCount(ASSET_ID)).toBe(3);

    const before = stub.calls.poll;
    await vi.waitFor(() => expect(stub.calls.poll).toBeGreaterThanOrEqual(before + 3));
    // Three viewers over ≥3 further ticks: calls grew by ticks, not by viewers.
    // (A per-viewer loop would have added ~3× as many.)
    expect(stub.calls.poll).toBeLessThan(before + 3 + 4);
  });

  it('frames fan out to every subscriber and land in the ring buffer', async () => {
    let price = 100;
    const stub = createStubMarketData({ poll: () => quoteResult(price++) });
    const { service } = makeService(stub);

    const seenA: number[] = [];
    const seenB: number[] = [];
    service.onFrame((f) => seenA.push(f.price));
    service.onFrame((f) => seenB.push(f.price));

    service.watch(ASSET_ID, REF);
    await vi.waitFor(() => expect(seenA.length).toBeGreaterThanOrEqual(2));
    expect(seenB).toEqual(seenA); // every subscriber gets every frame

    const backfilled = await service.backfill(ASSET_ID, REF, '12h');
    expect(backfilled.length).toBeGreaterThanOrEqual(2);
    expect(backfilled.map((f) => f.price)).toEqual(
      seenA.slice(0, backfilled.length), // same frames, oldest first
    );
    expect(backfilled[0]).toMatchObject({
      assetId: ASSET_ID,
      currency: 'EUR',
      dayChangePct: 1.5,
      at: expect.any(String),
    });
  });

  it('auto-stops when the last watcher leaves: upstream calls cease (§6.3)', async () => {
    const { service, stub } = makeService();

    service.watch(ASSET_ID, REF);
    service.watch(ASSET_ID, REF);
    await vi.waitFor(() => expect(stub.calls.poll).toBeGreaterThanOrEqual(1));

    service.unwatch(ASSET_ID);
    expect(service.watcherCount(ASSET_ID)).toBe(1); // one viewer left → still hot

    service.unwatch(ASSET_ID);
    expect(service.watcherCount(ASSET_ID)).toBe(0);
    expect(service.pollIntervalMs(ASSET_ID)).toBeNull();

    // Let any in-flight tick drain, then assert the calls are frozen.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = stub.calls.poll;
    await new Promise((resolve) => setTimeout(resolve, 100)); // 5× base interval
    expect(stub.calls.poll).toBe(after);
  });

  it('a returning watcher after idle starts a fresh loop', async () => {
    const { service, stub } = makeService();

    service.watch(ASSET_ID, REF);
    await vi.waitFor(() => expect(stub.calls.poll).toBeGreaterThanOrEqual(1));
    service.unwatch(ASSET_ID);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const cold = stub.calls.poll;

    service.watch(ASSET_ID, REF);
    await vi.waitFor(() => expect(stub.calls.poll).toBeGreaterThan(cold));
    expect(service.watcherCount(ASSET_ID)).toBe(1);
  });
});

describe('liveModeService — provider distress (§5.3 politeness)', () => {
  it('a failing tick stretches the interval ×2 up to the ceiling; success snaps back', async () => {
    let failing = false;
    const stub = createStubMarketData({
      poll: () => {
        if (failing) throw Object.assign(new Error('HTTP 429'), { code: 429 });
        return quoteResult(100);
      },
    });
    const { service } = makeService(stub, { intervalMs: 20, maxIntervalMs: 160 });

    service.watch(ASSET_ID, REF);
    await vi.waitFor(() => expect(stub.calls.poll).toBeGreaterThanOrEqual(1));
    expect(service.pollIntervalMs(ASSET_ID)).toBe(20);

    failing = true;
    await vi.waitFor(() => expect(service.pollIntervalMs(ASSET_ID)).toBe(160), {
      timeout: 2000,
    }); // 20 → 40 → 80 → 160 and holds the ceiling

    failing = false;
    await vi.waitFor(() => expect(service.pollIntervalMs(ASSET_ID)).toBe(20), {
      timeout: 2000,
    }); // first success resets to the base cadence
  });

  it('failed ticks emit no frames — viewers see silence, never an error', async () => {
    const stub = createStubMarketData({
      poll: () => {
        throw Object.assign(new Error('HTTP 429'), { code: 429 });
      },
    });
    const { service } = makeService(stub);
    const frames: unknown[] = [];
    service.onFrame((f) => frames.push(f));

    service.watch(ASSET_ID, REF);
    await vi.waitFor(() => expect(stub.calls.poll).toBeGreaterThanOrEqual(2));
    expect(frames).toEqual([]);
    expect(await service.backfill(ASSET_ID, REF, '12h')).toEqual([]);
  });

  it('a failed ring append is not distress: frames still flow at the base cadence', async () => {
    const { service } = makeService();
    // The quote succeeds; only the Redis write behind the backfill ring dies.
    (redis as unknown as Record<string, unknown>).pipeline = () => {
      throw new Error('redis connection lost');
    };
    const frames: unknown[] = [];
    service.onFrame((f) => frames.push(f));

    service.watch(ASSET_ID, REF);
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2));
    expect(service.pollIntervalMs(ASSET_ID)).toBe(20); // never stretched
  });
});

describe('liveModeService — finest ACTIVE rate (#372)', () => {
  it('the shared loop polls at the minimum requested rate — never a common divisor', async () => {
    const { service } = makeService();

    service.watch(ASSET_ID, REF, 60);
    expect(service.pollIntervalMs(ASSET_ID)).toBe(60);

    // A 40 ms viewer joins the 60 ms loop: cadence = min(60, 40) = 40 — were a
    // GCD used, 60 + 40 would poll every 20 ms, faster than anyone asked for.
    service.watch(ASSET_ID, REF, 40);
    expect(service.pollIntervalMs(ASSET_ID)).toBe(40);
    expect(service.watcherCount(ASSET_ID)).toBe(2);

    // The finest viewer leaves: the loop coarsens back to the survivors' rate.
    service.unwatch(ASSET_ID, 40);
    expect(service.pollIntervalMs(ASSET_ID)).toBe(60);
    expect(service.watcherCount(ASSET_ID)).toBe(1);

    // Releasing a rate nobody holds never steals another watcher's count.
    service.unwatch(ASSET_ID, 40);
    expect(service.watcherCount(ASSET_ID)).toBe(1);

    service.unwatch(ASSET_ID, 60);
    expect(service.watcherCount(ASSET_ID)).toBe(0);
    expect(service.pollIntervalMs(ASSET_ID)).toBeNull();
  });

  it('a finer viewer arriving mid-wait tightens the cadence immediately', async () => {
    const { service, stub } = makeService();

    // A slow viewer alone: after the immediate first tick the next poll sits
    // half a second out.
    service.watch(ASSET_ID, REF, 500);
    await vi.waitFor(() => expect(stub.calls.poll).toBeGreaterThanOrEqual(1));

    // A 20 ms viewer joins — the pending tick must be pulled forward, not sit
    // out the remaining ~480 ms.
    service.watch(ASSET_ID, REF, 20);
    expect(service.pollIntervalMs(ASSET_ID)).toBe(20);
    await vi.waitFor(() => expect(stub.calls.poll).toBeGreaterThanOrEqual(4));
  });

  it('distress stretches from the finest active rate; recovery snaps back to it', async () => {
    let failing = false;
    const stub = createStubMarketData({
      poll: () => {
        if (failing) throw Object.assign(new Error('HTTP 429'), { code: 429 });
        return quoteResult(100);
      },
      history: emptyHistory,
    });
    const { service } = makeService(stub);

    service.watch(ASSET_ID, REF, 20);
    service.watch(ASSET_ID, REF, 80);
    await vi.waitFor(() => expect(stub.calls.poll).toBeGreaterThanOrEqual(1));
    expect(service.pollIntervalMs(ASSET_ID)).toBe(20);

    failing = true;
    await vi.waitFor(() => expect(service.pollIntervalMs(ASSET_ID)).toBe(160), { timeout: 2000 });

    // First success returns to the FINEST active rate, not the coarsest.
    failing = false;
    await vi.waitFor(() => expect(service.pollIntervalMs(ASSET_ID)).toBe(20), { timeout: 2000 });
  });
});

describe('liveModeService — history-stitched backfill (#372)', () => {
  const T = Date.parse('2026-07-09T14:00:00.000Z');
  const MIN = 60_000;

  const ringFrame = (atMs: number, price: number) => ({
    assetId: ASSET_ID,
    price,
    currency: 'EUR',
    dayChangePct: 0.5,
    at: new Date(atMs).toISOString(),
  });
  const bar = (atMs: number, close: number): PricePoint => ({
    time: new Date(atMs).toISOString(),
    close,
  });
  const seedRing = async (...frames: ReturnType<typeof ringFrame>[]) => {
    const ring = createLiveRingBuffer(redis, { capacity: 100, retentionMs: 86_400_000 });
    for (const frame of frames) await ring.append(frame);
  };

  it('seeds the window gap with provider bars, oldest first, marked seed', async () => {
    // Ring covers only the last 2 minutes; provider has 1 m bars far back.
    const bars = Array.from({ length: 20 }, (_, i) => bar(T - (20 - i) * MIN, 200 + i));
    const stub = createStubMarketData({
      poll: () => quoteResult(100),
      history: () => ({ value: bars, stale: false, asOf: T }),
    });
    const { service } = makeService(stub, { now: () => T });
    await seedRing(ringFrame(T - 2 * MIN, 100), ringFrame(T - MIN, 101));

    const frames = await service.backfill(ASSET_ID, REF, '10m');

    const seeds = frames.filter((f) => f.seed);
    const real = frames.filter((f) => !f.seed);
    // Seeds span [window start, first ring frame): T-10m … T-3m inclusive.
    expect(seeds.length).toBe(8);
    expect(seeds[0]!.at).toBe(new Date(T - 10 * MIN).toISOString());
    expect(seeds[seeds.length - 1]!.at).toBe(new Date(T - 3 * MIN).toISOString());
    expect(seeds.every((f) => f.currency === 'EUR' && f.dayChangePct === null)).toBe(true);
    // Real ring frames follow the seed untouched, and ordering is oldest-first.
    expect(real.map((f) => f.price)).toEqual([100, 101]);
    expect(frames.map((f) => f.at)).toEqual([...frames.map((f) => f.at)].sort());
    expect(frames[frames.length - 1]!.seed).toBeUndefined();
  });

  it('an empty ring seeds the whole window, with the currency of the cached quote', async () => {
    const bars = [bar(T - 5 * MIN, 200), bar(T - 3 * MIN, 201)];
    const stub = createStubMarketData({
      quote: () => quoteResult(100),
      poll: () => quoteResult(100),
      history: () => ({ value: bars, stale: false, asOf: T }),
    });
    const { service } = makeService(stub, { now: () => T });

    const frames = await service.backfill(ASSET_ID, REF, '10m');
    expect(frames.map((f) => f.price)).toEqual([200, 201]);
    expect(frames.every((f) => f.seed === true && f.currency === 'EUR')).toBe(true);
    expect(stub.calls.quote).toBe(1); // currency source when the ring is empty
  });

  it('a gap finer than a provider bar is not worth stitching — no history call', async () => {
    const { service, stub } = makeService(undefined, { now: () => T });
    await seedRing(ringFrame(T - 30_000, 100));

    const frames = await service.backfill(ASSET_ID, REF, '1m');
    expect(frames.map((f) => f.price)).toEqual([100]);
    expect(stub.calls.history).toBe(0);
  });

  it('a failing history fetch degrades to ring-only frames — never an error', async () => {
    const stub = createStubMarketData({
      poll: () => quoteResult(100),
      history: () => {
        throw Object.assign(new Error('HTTP 429'), { code: 429 });
      },
    });
    const { service } = makeService(stub, { now: () => T });
    await seedRing(ringFrame(T - MIN, 100));

    const frames = await service.backfill(ASSET_ID, REF, '10m');
    expect(frames.map((f) => f.price)).toEqual([100]);
  });
});

describe('liveModeService — market state on frames (§13.5 V5-P1)', () => {
  const stateQuote = (state: Quote['marketState']): CachedResult<Quote> => ({
    value: {
      price: 100,
      currency: 'EUR',
      dayChangePct: 0,
      marketState: state,
      asOf: '2026-07-09T14:00:00.000Z',
    },
    stale: false,
    asOf: Date.now(),
  });

  it("carries the polled quote's market state onto every streamed frame", async () => {
    const stub = createStubMarketData({
      poll: () => stateQuote('closed'),
      history: emptyHistory,
    });
    const { service } = makeService(stub);
    const frames: string[] = [];
    service.onFrame((f) => frames.push(f.marketState ?? 'none'));

    service.watch(ASSET_ID, REF);
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(frames[0]).toBe('closed');
  });

  it('reports a null market state when the provider does not carry one', async () => {
    const stub = createStubMarketData({ poll: () => quoteResult(100), history: emptyHistory });
    const { service } = makeService(stub);
    const seen: Array<string | null | undefined> = [];
    service.onFrame((f) => seen.push(f.marketState));

    service.watch(ASSET_ID, REF);
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]).toBeNull();
  });
});

describe('liveModeService — backfill window coverage (§13.5 V5-P1 §5)', () => {
  const T = Date.parse('2026-07-09T14:00:00.000Z');
  const MIN = 60_000;
  const bar = (atMs: number, close: number): PricePoint => ({
    time: new Date(atMs).toISOString(),
    close,
  });

  it('a fresh watch with cached bars seeds back to ~now − window (oldest ≤ start + 60 s), strictly increasing, no duplicate buckets', async () => {
    // A full 30 minutes of 1-minute bars, empty ring (fresh watch).
    const bars = Array.from({ length: 40 }, (_, i) => bar(T - (40 - i) * MIN, 300 + i));
    const stub = createStubMarketData({
      quote: () => quoteResult(100),
      poll: () => quoteResult(100),
      history: () => ({ value: bars, stale: false, asOf: T }),
    });
    const { service } = makeService(stub, { now: () => T });

    const frames = await service.backfill(ASSET_ID, REF, '30m');

    const windowStart = T - 30 * MIN;
    expect(frames.length).toBeGreaterThan(0);
    // Oldest seed reaches within one bar of the window start.
    expect(Date.parse(frames[0]!.at)).toBeLessThanOrEqual(windowStart + MIN);
    // Strictly increasing timestamps — no duplicate or backward buckets at the splice.
    const times = frames.map((f) => Date.parse(f.at));
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  });
});

describe('liveRingBuffer', () => {
  const frame = (atMs: number, price: number) => ({
    assetId: ASSET_ID,
    price,
    currency: 'EUR',
    dayChangePct: null,
    at: new Date(atMs).toISOString(),
  });

  it('trims to capacity, keeps the newest frames, filters by window start', async () => {
    const ring = createLiveRingBuffer(redis, { capacity: 3, retentionMs: 60_000 });
    const t0 = Date.parse('2026-07-08T10:00:00.000Z');
    for (let i = 0; i < 5; i++) await ring.append(frame(t0 + i * 1000, 100 + i));

    const all = await ring.readSince(ASSET_ID, 0);
    expect(all.map((f) => f.price)).toEqual([102, 103, 104]); // oldest two trimmed

    const recent = await ring.readSince(ASSET_ID, t0 + 3500);
    expect(recent.map((f) => f.price)).toEqual([104]);
  });

  it('skips corrupt entries instead of failing the backfill', async () => {
    const ring = createLiveRingBuffer(redis, { capacity: 10, retentionMs: 60_000 });
    await ring.append(frame(Date.now(), 100));
    await redis.rpush(liveRingKey(ASSET_ID), 'not-json');
    await ring.append(frame(Date.now(), 101));

    const frames = await ring.readSince(ASSET_ID, 0);
    expect(frames.map((f) => f.price)).toEqual([100, 101]);
  });
});
