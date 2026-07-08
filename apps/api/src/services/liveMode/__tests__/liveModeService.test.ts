import type { CachedResult, Quote } from '@bettertrack/contracts';
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

function makeService(
  stub = createStubMarketData({ poll: () => quoteResult(100) }),
  options: { intervalMs?: number; maxIntervalMs?: number; ringCapacity?: number } = {},
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

    const backfilled = await service.backfill(ASSET_ID, '12h');
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
    expect(await service.backfill(ASSET_ID, '12h')).toEqual([]);
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
