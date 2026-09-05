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
 * How far past the live window the retained series may run before
 * {@link trimToWindow} cuts it back.
 *
 * A generation lasts as long as the (asset, window, rate) and the connection
 * hold — hours — while the chart only ever renders `[now − window, now]`, so
 * keeping every observation since the generation started is unbounded growth for
 * data nothing draws (§13.5 V5-P2). Trimming on EVERY tick would instead break
 * the append-only contract `PriceChart`'s `series.update()` streaming relies on,
 * so the cut happens in chunks: the series is allowed to overrun by a quarter
 * window and then drops back to exactly one window — one clean rebuild per
 * quarter window instead of a per-tick redraw.
 */
export const LIVE_RETENTION_SLACK = 1.25;

/**
 * The hard ceiling on what {@link densify} materialises, whatever span it is
 * handed: one slack-trimmed window's worth of grid slots. In normal operation
 * {@link trimToWindow} has already bounded the input, so this never bites; it
 * exists so a single over-long input (a backfill reaching past the window, a
 * series that has not been trimmed yet) can never materialise one slot per
 * second since the generation started.
 */
export const MAX_DENSIFIED_POINTS = Math.ceil(MAX_LIVE_CHART_POINTS * LIVE_RETENTION_SLACK);

/**
 * Drop everything older than `windowSeconds` before the newest point — but only
 * once the series has overrun that window by {@link LIVE_RETENTION_SLACK}.
 *
 * Returns `points` BY REFERENCE while inside the slack, so the caller can tell
 * "nothing to do" from "one clean rebuild" by identity alone. The cutoff is
 * anchored on the NEWEST point rather than the wall clock: a lagging series (a
 * closed market, a stalled stream) then keeps at least the rendered window
 * instead of being trimmed into it.
 */
export function trimToWindow(points: readonly LivePoint[], windowSeconds: number): LivePoint[] {
  if (points.length === 0) return points as LivePoint[];
  const window = Math.max(1, Math.floor(windowSeconds));
  const newest = points[points.length - 1]!.time;
  if (newest - points[0]!.time <= window * LIVE_RETENTION_SLACK) return points as LivePoint[];
  const cutoff = newest - window;
  const from = points.findIndex((point) => point.time >= cutoff);
  if (from <= 0) return points as LivePoint[];
  return points.slice(from);
}

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
export function densify(
  points: readonly LivePoint[],
  stepSeconds: number,
  maxPoints: number = MAX_DENSIFIED_POINTS,
): LivePoint[] {
  if (points.length === 0) return [];
  const step = Math.max(1, Math.floor(stepSeconds));
  // Newest value per grid slot wins; sort first so the result is order-independent
  // (the hook feeds an ascending series, but densify never relies on that).
  const bySlot = new Map<number, number>();
  for (const point of [...points].sort((a, b) => a.time - b.time)) {
    bySlot.set(Math.floor(point.time / step) * step, point.value);
  }
  const slots = [...bySlot.keys()].sort((a, b) => a - b);
  const lastSlot = slots[slots.length - 1]!;
  // Never materialise more than the ceiling, however long the input span is: the
  // newest `maxPoints` slots are the ones the pinned viewport can show. Both
  // candidates are step-aligned, so the resulting grid is too.
  const cap = Math.max(1, Math.floor(maxPoints));
  const firstSlot = Math.max(slots[0]!, lastSlot - (cap - 1) * step);
  const out: LivePoint[] = [];
  // The clamp can land mid-gap, where no observation opens the grid — carry the
  // newest one at or before it, exactly like an interior slot would.
  let carry = bySlot.get(slots[0]!)!;
  for (const slot of slots) {
    if (slot > firstSlot) break;
    carry = bySlot.get(slot)!;
  }
  for (let slot = firstSlot; slot <= lastSlot; slot += step) {
    const value = bySlot.get(slot);
    if (value !== undefined) carry = value;
    out.push({ time: slot, value: carry });
  }
  return out;
}
