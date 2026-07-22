import type { RealtimeLiveFrame } from '@bettertrack/contracts';
import { describe, expect, test } from 'vitest';

import { bucketSeconds, framesToPoints, mergePoints, type LivePoint } from './liveSeries';

const ASSET = '00000000-0000-0000-0000-000000000001';

const frame = (at: string, price: number, seed = false): RealtimeLiveFrame => ({
  assetId: ASSET,
  price,
  currency: 'EUR',
  dayChangePct: null,
  at,
  ...(seed ? { seed: true } : {}),
});

/** A tiny deterministic PRNG so a fuzz failure reproduces from its seed. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const strictlyIncreasing = (points: LivePoint[]): boolean =>
  points.every((p, i) => i === 0 || p.time > points[i - 1]!.time);

describe('bucketSeconds', () => {
  test('buckets to a whole start second for every live rate', () => {
    const at = Date.parse('2026-07-08T10:00:03.400Z');
    // 1 s rate → the exact second (drops the sub-second remainder).
    expect(bucketSeconds(at, 1_000)).toBe(Math.floor(at / 1000));
    // 10 s rate → a multiple of 10 seconds.
    expect(bucketSeconds(at, 10_000) % 10).toBe(0);
    // Two timestamps within the same 60 s bucket share a start second.
    const a = Date.parse('2026-07-08T10:00:05.000Z');
    const b = Date.parse('2026-07-08T10:00:52.000Z');
    expect(bucketSeconds(a, 60_000)).toBe(bucketSeconds(b, 60_000));
    expect(Number.isInteger(bucketSeconds(Date.now(), 2_000))).toBe(true);
  });
});

describe('framesToPoints', () => {
  test('one point per rate bucket; the newest frame in a bucket wins (live over seed)', () => {
    // A minute seed and two 1 s live ticks all land in the same 60 s bucket:
    // the newest tick (103) must win, and only ONE point is emitted.
    const points = framesToPoints(
      [
        frame('2026-07-08T10:00:00.000Z', 100, true),
        frame('2026-07-08T10:00:37.000Z', 102),
        frame('2026-07-08T10:00:52.000Z', 103),
      ],
      60_000,
    );
    expect(points).toEqual([
      { time: bucketSeconds(Date.parse('2026-07-08T10:00:00.000Z'), 60_000), value: 103 },
    ]);
  });

  test('unordered frames still collapse newest-wins and come out ascending', () => {
    const points = framesToPoints(
      [
        frame('2026-07-08T10:00:20.000Z', 102),
        frame('2026-07-08T10:00:00.000Z', 100),
        frame('2026-07-08T10:00:10.000Z', 101),
      ],
      1_000,
    );
    expect(points.map((p) => p.value)).toEqual([100, 101, 102]);
    expect(strictlyIncreasing(points)).toBe(true);
  });
});

describe('mergePoints — the seed ⊕ backfill ⊕ ticks invariant', () => {
  test('incoming (the live frame) wins a bucket collision; output stays strictly increasing', () => {
    const base = framesToPoints([frame('2026-07-08T10:00:00.000Z', 100, true)], 60_000);
    const tick = framesToPoints([frame('2026-07-08T10:00:41.000Z', 105)], 60_000);
    const merged = mergePoints(base, tick);
    // Same 60 s bucket → the live value replaces the seed, never two points.
    expect(merged).toEqual([{ time: base[0]!.time, value: 105 }]);
  });

  test('returns base unchanged (same reference) when there is nothing new', () => {
    const base = framesToPoints([frame('2026-07-08T10:00:00.000Z', 100)], 1_000);
    expect(mergePoints(base, [])).toBe(base);
  });

  test('fuzz: random interleavings of seeds/backfill/ticks are always strictly increasing', () => {
    const rand = lcg(0xbeef);
    const t0 = Date.parse('2026-07-08T10:00:00.000Z');
    const rates = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

    for (let iter = 0; iter < 400; iter++) {
      const rateMs = rates[Math.floor(rand() * rates.length)]!;
      const count = 1 + Math.floor(rand() * 60);
      const frames: RealtimeLiveFrame[] = [];
      for (let i = 0; i < count; i++) {
        // Random offsets within a 30 min span; deliberate duplicates and
        // out-of-order arrivals (seeds land on minute marks, ticks anywhere).
        const isSeed = rand() < 0.4;
        const offsetMs = isSeed
          ? Math.floor(rand() * 30) * 60_000
          : Math.floor(rand() * 30 * 60_000);
        frames.push(frame(new Date(t0 + offsetMs).toISOString(), rand() * 1000, isSeed));
      }

      // Path A: merge the whole batch at once.
      const batch = framesToPoints(frames, rateMs);
      expect(strictlyIncreasing(batch)).toBe(true);

      // Path B: fold frames in one at a time, in their (random) arrival order —
      // exactly how the hook applies a backfill then streamed ticks.
      let acc: LivePoint[] = [];
      for (const f of frames) acc = mergePoints(acc, framesToPoints([f], rateMs));
      expect(strictlyIncreasing(acc)).toBe(true);

      // Both paths converge on the same set of buckets.
      expect(acc.map((p) => p.time)).toEqual(batch.map((p) => p.time));
    }
  });
});
