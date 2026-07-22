import type { RealtimeLiveFrame } from '@bettertrack/contracts';
import { describe, expect, test } from 'vitest';

import {
  bucketSeconds,
  densify,
  framesToPoints,
  liveChartStepSeconds,
  MAX_LIVE_CHART_POINTS,
  mergePoints,
  type LivePoint,
} from './liveSeries';

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

describe('liveChartStepSeconds — the densify grid', () => {
  test('is the live rate itself for every window up to 1 h at 1 s', () => {
    expect(liveChartStepSeconds(30 * 60_000, 1_000)).toBe(1); // 30 min @ 1 s
    expect(liveChartStepSeconds(60 * 60_000, 1_000)).toBe(1); // 1 h @ 1 s (exactly the cap)
    expect(liveChartStepSeconds(10 * 60_000, 10_000)).toBe(10); // 10 min @ 10 s
    expect(liveChartStepSeconds(12 * 3_600_000, 60_000)).toBe(60); // 12 h @ 60 s
  });

  test('coarsens a fast rate on a long window, always staying under the point cap', () => {
    expect(liveChartStepSeconds(3 * 3_600_000, 1_000)).toBe(3); // 3 h @ 1 s
    expect(liveChartStepSeconds(12 * 3_600_000, 1_000)).toBe(12); // 12 h @ 1 s
    // Every window × rate the UI offers yields a grid ≤ the cap and ≥ the rate.
    const windows = [60_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 43_200_000];
    const rates = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
    for (const windowMs of windows) {
      for (const rateMs of rates) {
        const step = liveChartStepSeconds(windowMs, rateMs);
        expect(step).toBeGreaterThanOrEqual(Math.floor(rateMs / 1000));
        expect(Math.ceil(windowMs / 1000 / step)).toBeLessThanOrEqual(MAX_LIVE_CHART_POINTS);
      }
    }
  });
});

describe('densify — the uniform wall-clock grid (issue #690 symptom 3)', () => {
  test('a minute seed and a 1 s tail occupy PROPORTIONAL horizontal space', () => {
    // The owner's exact repro: a 25-min minute-density seed + a 5-min 1 s tail.
    // On the ordinal axis the RAW series is 26 sparse + 300 dense points, so the
    // 25-min seed renders at ~8% of the width; densified to 1 s every point shares
    // one density, so point-share == time-share and the seed keeps its 25/30.
    const t0 = 1_700_000_000;
    const seed: LivePoint[] = [];
    for (let m = 0; m <= 25; m++) seed.push({ time: t0 + m * 60, value: 100 + m });
    const tail: LivePoint[] = [];
    for (let s = 1; s <= 300; s++) tail.push({ time: t0 + 25 * 60 + s, value: 130 + s / 100 });

    const dense = densify([...seed, ...tail], 1);

    // One point per second across the whole [t0, t0 + 30 min] span — uniform.
    expect(dense[dense.length - 1]!.time - dense[0]!.time).toBe(1800);
    expect(dense).toHaveLength(1801);
    expect(strictlyIncreasing(dense)).toBe(true);
    expect(dense.every((p, i) => i === 0 || p.time - dense[i - 1]!.time === 1)).toBe(true);

    // The seed's 25 minutes now hold ~83% of the points — its true time share,
    // not the ~8% the mixed-density series gives against the ordinal axis.
    const seedPortion = dense.filter((p) => p.time < t0 + 25 * 60).length / dense.length;
    expect(seedPortion).toBeCloseTo(25 / 30, 2);
  });

  test('interior gaps are step-carried — the value holds until the next real point', () => {
    // Two minute bars, no sub-minute data → the 1 s grid between them holds the
    // earlier close (a stepped hold, never an invented interpolation).
    const dense = densify(
      [
        { time: 1_000, value: 100 },
        { time: 1_060, value: 105 },
      ],
      1,
    );
    expect(dense).toHaveLength(61);
    expect(dense[0]).toEqual({ time: 1_000, value: 100 });
    expect(dense[30]).toEqual({ time: 1_030, value: 100 }); // still carrying 100
    expect(dense[59]).toEqual({ time: 1_059, value: 100 });
    expect(dense[60]).toEqual({ time: 1_060, value: 105 }); // the next real point
  });

  test('never extrapolates past the newest real point (the right edge stays honest)', () => {
    const dense = densify(
      [
        { time: 1_000, value: 100 },
        { time: 1_005, value: 101 },
      ],
      1,
    );
    expect(dense[dense.length - 1]).toEqual({ time: 1_005, value: 101 });
  });

  test('a coarser grid downsamples: the newest value in a slot wins', () => {
    // step 10 s: three ticks share the [1000,1010) slot; the newest (102) wins.
    const dense = densify(
      [
        { time: 1_000, value: 100 },
        { time: 1_003, value: 101 },
        { time: 1_007, value: 102 },
        { time: 1_012, value: 200 },
      ],
      10,
    );
    expect(dense).toEqual([
      { time: 1_000, value: 102 },
      { time: 1_010, value: 200 },
    ]);
  });

  test('empty in ⇒ empty out; a single point snaps to its grid slot', () => {
    expect(densify([], 1)).toEqual([]);
    expect(densify([{ time: 42, value: 7 }], 5)).toEqual([{ time: 40, value: 7 }]);
  });

  test('appending a tail point keeps the prefix byte-stable (the chart streams via update())', () => {
    const base: LivePoint[] = [
      { time: 1_000, value: 100 },
      { time: 1_002, value: 101 },
    ];
    const before = densify(base, 1);
    const after = densify([...base, { time: 1_004, value: 102 }], 1);
    // Everything already drawn is identical; only the tail grew — so PriceChart's
    // generation-driven update() appends and never re-runs setData per tick.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
  });

  test('fuzz: any step yields a strictly-increasing, uniform-step, honest-edged grid', () => {
    const rand = lcg(0x51e5);
    const steps = [1, 2, 5, 10, 12, 30];
    for (let iter = 0; iter < 300; iter++) {
      const step = steps[Math.floor(rand() * steps.length)]!;
      const count = 1 + Math.floor(rand() * 40);
      let t = 1_700_000_000 + Math.floor(rand() * 100);
      const points: LivePoint[] = [];
      for (let i = 0; i < count; i++) {
        t += 1 + Math.floor(rand() * 120); // ascending, irregular gaps
        points.push({ time: t, value: rand() * 1000 });
      }
      const dense = densify(points, step);
      expect(strictlyIncreasing(dense)).toBe(true);
      // Uniform: every gap is exactly one grid step, every time is on the grid.
      expect(dense.every((p, i) => i === 0 || p.time - dense[i - 1]!.time === step)).toBe(true);
      expect(dense.every((p) => p.time % step === 0)).toBe(true);
      // Honest edges: neither before the first input slot nor past the last.
      expect(dense[0]!.time).toBe(Math.floor(points[0]!.time / step) * step);
      expect(dense[dense.length - 1]!.time).toBe(
        Math.floor(points[points.length - 1]!.time / step) * step,
      );
    }
  });
});
