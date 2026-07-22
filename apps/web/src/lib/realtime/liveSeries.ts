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

/**
 * The most points {@link densify} emits per generation. `lightweight-charts`
 * lays points at ~1 point/px at most on any real chart width, so this is already
 * generous; the cap only kicks in for a fast rate on a long window (1 s over 12 h
 * would otherwise be 43 200 points) and coarsens the grid to render identically.
 * Chosen so every window up to 1 h at a 1 s rate keeps native 1 s resolution.
 */
export const MAX_LIVE_CHART_POINTS = 3600;

/**
 * The uniform grid step (whole seconds) {@link densify} resamples onto for a
 * given window + rate: the live rate itself, coarsened only when `window / rate`
 * would exceed {@link MAX_LIVE_CHART_POINTS}. It depends solely on window + rate
 * (both fixed within a generation — changing either forces a rebuild), so the
 * densified series stays a stable-prefix, tail-growing series between rebuilds.
 */
export function liveChartStepSeconds(windowMs: number, rateMs: number): number {
  const rateSec = Math.max(1, Math.floor(rateMs / 1000));
  const windowSec = Math.max(1, Math.floor(windowMs / 1000));
  return Math.max(rateSec, Math.ceil(windowSec / MAX_LIVE_CHART_POINTS));
}

/**
 * Resample a merged series onto a uniform `stepSeconds` grid via step-carry, so
 * every point shares ONE density.
 *
 * WHY THIS EXISTS (issue #690 symptom 3): `lightweight-charts` uses an
 * ordinal/index time axis — it spaces consecutive points at uniform *index*
 * intervals regardless of the wall-clock gap between them (the same reason it
 * collapses weekend gaps), and offers no proportional/linear-time mode. A
 * mixed-density live series — minute-granularity seed bars followed by 1 s live
 * ticks — therefore renders with the seed compressed to its *point-count* share,
 * not its *time* share: dense ticks crush the seeded history against the left
 * edge even with the viewport pinned to `[now − window, now]` (a pinned viewport
 * fixes the *jumping*, not the *compression*). Making every point share one
 * density makes index-spacing ≈ wall-clock-spacing, so the seed keeps its true
 * time-share of the window — the "proportional horizontal space" acceptance.
 *
 * Interior gaps between real points are filled by carrying the previous value
 * forward (a stepped hold — honest: no interpolated value is invented for a
 * sub-bar instant we never observed). The newest real point is never
 * extrapolated past, so the right edge stays honest too (no fabricated "now"
 * padding). Each point is bucketed to `floor(t / step) * step` with the newest
 * value per slot winning (mirrors {@link framesToPoints}); the result is strictly
 * increasing and, for a fixed `stepSeconds`, a stable-prefix / tail-growing
 * series — only the newest slot mutates or extends, so PriceChart keeps streaming
 * via `series.update()` and never falls back to a per-tick redraw.
 */
export function densify(points: readonly LivePoint[], stepSeconds: number): LivePoint[] {
  if (points.length === 0) return [];
  const step = Math.max(1, Math.floor(stepSeconds));
  // Newest value per grid slot wins; sort first so the result is order-independent
  // (the hook feeds an ascending series, but densify never relies on that).
  const bySlot = new Map<number, number>();
  for (const point of [...points].sort((a, b) => a.time - b.time)) {
    bySlot.set(Math.floor(point.time / step) * step, point.value);
  }
  const slots = [...bySlot.keys()].sort((a, b) => a - b);
  const firstSlot = slots[0]!;
  const lastSlot = slots[slots.length - 1]!;
  const out: LivePoint[] = [];
  let carry = bySlot.get(firstSlot)!;
  for (let slot = firstSlot; slot <= lastSlot; slot += step) {
    const value = bySlot.get(slot);
    if (value !== undefined) carry = value;
    out.push({ time: slot, value: carry });
  }
  return out;
}
