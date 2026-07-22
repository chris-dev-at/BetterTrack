import type { RealtimeLiveFrame } from '@bettertrack/contracts';

/**
 * The pure timeline math behind Live Mode (§6.3, §13.5 V5-P1). The hook keeps
 * ONE merged, strictly-increasing, deduped series per (asset, window, rate):
 * `seed history bars ⊕ ring backfill ⊕ live ticks`, all normalized to
 * `{ time: epochSeconds, value }`. These helpers are side-effect free so the
 * output invariant — `points[i].time < points[i+1].time` — is fuzz-testable in
 * isolation, independent of React.
 */

/** One point on the merged live series. `time` is whole epoch **seconds**. */
export interface LivePoint {
  /** The rate bucket's start second — strictly increasing across buckets. */
  time: number;
  value: number;
}

/**
 * The rate-sized bucket a timestamp falls in, expressed as its **start second**
 * (a whole integer, because every {@link LIVE_RATE_MS} value is a whole-second
 * multiple). Two frames in the same bucket collapse to one point; distinct
 * buckets get distinct, strictly-ascending times — the exact invariant
 * `lightweight-charts` requires (a non-monotonic time throws "Cannot update
 * oldest data"). Mixing minute-granularity seeds with second-granularity live
 * ticks on ONE wall-clock scale therefore never produces a backward time.
 */
export function bucketSeconds(atMs: number, rateMs: number): number {
  return Math.floor(atMs / rateMs) * Math.floor(rateMs / 1000);
}

/**
 * Collapse a frame list to one {@link LivePoint} per rate bucket, ascending.
 * Frames are sorted by observation time (`at`) first, so the **newest** frame
 * in a bucket writes last and wins — a live tick replaces a seed (or an older
 * sample) that shares its bucket at the seed↔live splice (H3), never emitting
 * both. Seeds carry no special weight here: whoever is newest by `at` wins.
 */
export function framesToPoints(frames: readonly RealtimeLiveFrame[], rateMs: number): LivePoint[] {
  const byBucket = new Map<number, number>();
  const ordered = [...frames].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const frame of ordered) {
    const atMs = Date.parse(frame.at);
    if (Number.isNaN(atMs)) continue;
    byBucket.set(bucketSeconds(atMs, rateMs), frame.price);
  }
  return [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
}

/**
 * Merge `incoming` over `base`, keeping the result strictly increasing.
 * `incoming` is the fresher source and wins on any bucket collision (the live
 * frame replaces a seed bucket; a same-bucket value correction replaces the
 * previous value in place). Returns `base` unchanged when there is nothing new,
 * so an idle render produces a referentially-stable series.
 */
export function mergePoints(
  base: readonly LivePoint[],
  incoming: readonly LivePoint[],
): LivePoint[] {
  if (incoming.length === 0) return base as LivePoint[];
  const byTime = new Map<number, number>();
  for (const point of base) byTime.set(point.time, point.value);
  for (const point of incoming) byTime.set(point.time, point.value);
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
}
