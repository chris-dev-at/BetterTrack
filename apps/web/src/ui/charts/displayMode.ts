import { useCallback, useState } from 'react';

/**
 * Which shape a value-over-time curve takes (owner directive 2026-08-07, mobile
 * board #68 item 4 — both clients implement it):
 *
 * - `value` — the absolute money curve. Today's behaviour and the default on
 *   every surface; a user who never touches the toggle sees exactly what they
 *   saw before.
 * - `perf` — the curve is shaped by the **performance-%** series (0 %-rebased
 *   by the surface's own range semantics), while the scrub/hover tooltip still
 *   answers "how much money was that?" — see `PriceChart`'s `balanceSeries`.
 *
 * The percentages are ALWAYS the server's own series; nothing here recomputes
 * performance client-side.
 */
export type ChartDisplayMode = 'value' | 'perf';

/**
 * A surface that remembers its own display mode. Deliberately per surface and
 * not one global preference: the overview answers "what is it worth?" at a
 * glance while the Analysis deep-dive is where a user goes to read the shape of
 * the return, so the two legitimately want different defaults-in-practice.
 *
 * The value is a **device** preference (`localStorage`), never account state —
 * it says nothing about the portfolio and never leaves the browser.
 */
export type ChartDisplaySurface = 'portfolio-overview' | 'portfolio-analysis';

const STORAGE_PREFIX = 'bettertrack.chartDisplayMode.';

function storageKey(surface: ChartDisplaySurface): string {
  return `${STORAGE_PREFIX}${surface}`;
}

function isDisplayMode(value: unknown): value is ChartDisplayMode {
  return value === 'value' || value === 'perf';
}

/**
 * The remembered mode for `surface`, or `value` when nothing valid is stored.
 * Any storage failure (disabled cookies, private mode, a quota-full origin) and
 * any unrecognised stored string degrade to the default rather than throwing —
 * a display preference must never be able to break a page render.
 */
export function readChartDisplayMode(surface: ChartDisplaySurface): ChartDisplayMode {
  try {
    const raw = window.localStorage.getItem(storageKey(surface));
    return isDisplayMode(raw) ? raw : 'value';
  } catch {
    return 'value';
  }
}

/** Remember `mode` for `surface`. Storage failures are swallowed (see the reader). */
export function writeChartDisplayMode(surface: ChartDisplaySurface, mode: ChartDisplayMode): void {
  try {
    window.localStorage.setItem(storageKey(surface), mode);
  } catch {
    // Non-fatal: the toggle still works for this page life, it just won't stick.
  }
}

/**
 * `useState` for a chart display mode that survives a reload, read once on
 * mount and written on every change. `surface` is a literal at each call site,
 * so the lazy initializer can never go stale.
 */
export function useChartDisplayMode(
  surface: ChartDisplaySurface,
): [ChartDisplayMode, (mode: ChartDisplayMode) => void] {
  const [mode, setMode] = useState<ChartDisplayMode>(() => readChartDisplayMode(surface));
  const selectMode = useCallback(
    (next: ChartDisplayMode) => {
      setMode(next);
      writeChartDisplayMode(surface, next);
    },
    [surface],
  );
  return [mode, selectMode];
}
