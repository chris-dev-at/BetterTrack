import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  LIVE_RATE_MS,
  LIVE_WINDOW_MS,
  REALTIME_SERVER_EVENTS,
  realtimeLiveFrameSchema,
  type LiveRate,
  type LiveWindow,
  type MarketState,
  type QuoteResponse,
  type RealtimeLiveFrame,
} from '@bettertrack/contracts';

import {
  densify,
  framesToPoints,
  liveChartStepSeconds,
  mergePoints,
  type LivePoint,
} from './liveSeries';
import { useRealtime } from './RealtimeProvider';

export interface LiveSeriesState {
  /**
   * ONE merged, strictly-increasing, deduped series of the REAL observations for
   * the current (asset, window, rate): seed history bars ⊕ ring backfill ⊕ live
   * ticks, normalized to `{ time: epochSeconds, value }`. Kept honest (no
   * fabricated points) — the source {@link coverageFrom} is drawn from. The chart
   * draws {@link chartPoints}, its uniform-density resampling, instead.
   */
  points: LivePoint[];
  /**
   * {@link points} resampled onto ONE uniform time grid via {@link densify} —
   * what the chart actually draws. `lightweight-charts` uses an ordinal/index
   * time axis (no proportional-time mode), so a mixed-density series (minute seed
   * bars + 1 s live ticks) would render with the seed crushed to its point-count
   * share, not its time share (issue #690 symptom 3). One density makes ordinal
   * spacing ≈ wall-clock spacing, so the seed keeps its true share of the pinned
   * `[now − window, now]` window. Append-only within a generation — the chart
   * streams the tail via `series.update()`, never a per-tick redraw.
   */
  chartPoints: LivePoint[];
  /**
   * Bumps ONLY on a clean rebuild: an asset/window/rate change, a reconnect
   * re-backfill, or a stream↔poll-fallback switch. The chart does exactly one
   * `setData` per generation and appends within it — never a per-tick redraw.
   */
  generation: number;
  /** True while the socket stream is the source; false ⇒ the 60 s poll fallback. */
  streaming: boolean;
  /** Earliest instant the backfill honestly covers (epoch ms), or null. */
  coverageFrom: number | null;
  /** Freshest known exchange session — drives the chart's "Market closed" state. */
  marketState: MarketState | null;
}

const subscribeVisibility = (onChange: () => void): (() => void) => {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
};

/**
 * True while the document is visible. Live Mode polling is presence-gated
 * (#372): a hidden tab is not "actively viewing", so its watch is released
 * and the shared upstream loop stops within one interval once nobody watches.
 */
function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

/**
 * Live Mode client hook (§6.3, V3-P7b; overhauled for §13.5 V5-P1 to fix the
 * mixed-density glitch). While `enabled` and the tab is visible it holds one
 * watch on the asset at the requested rate, backfills the full requested window
 * (history-stitched server-side) and appends streamed `live.frame` pushes —
 * everything folded into ONE merged, strictly-increasing series so the chart
 * never re-fits or rebuilds per tick.
 *
 * The watch lifecycle is unchanged from #372 (formally verified): a `window`/
 * `rate` change re-issues the watch (re-backfill + rate re-registration, the
 * shared loop never restarts); a reconnect re-issues it (`connected` flips);
 * hiding the tab releases the watch (presence gating) and showing re-establishes
 * it; only unmount/disable/hide/asset-change release the watch. Each such
 * re-backfill is exactly one `generation` bump — the chart's single rebuild
 * point. Between bumps the series only grows at the tail.
 *
 * Degradation is silent (§4.5): no provider, no socket or a rejected watch just
 * means `streaming: false`, and the caller's `fallbackQuote` (its 60 s poll)
 * feeds the series as a slow tick instead — under its own generation so the
 * switch is one clean rebuild, never a per-tick redraw.
 */
export function useLiveSeries(
  assetId: string | undefined,
  window: LiveWindow,
  rate: LiveRate,
  enabled: boolean,
  fallbackQuote?: QuoteResponse,
): LiveSeriesState {
  const { connected, on, watchLive, unwatchLive } = useRealtime();
  const [points, setPoints] = useState<LivePoint[]>([]);
  const [generation, setGeneration] = useState(0);
  const [streaming, setStreaming] = useState(false);
  // Flips true once the in-flight socket watch concludes without a stream
  // (rejected or timed out). Gates the poll fallback so it does not seed a
  // throwaway generation while a watch is still pending — the entering-live-mode
  // one-point flash. Reset at each watch dispatch (re-armed on reconnect/switch).
  const [streamRejected, setStreamRejected] = useState(false);
  const [coverageFrom, setCoverageFrom] = useState<number | null>(null);
  const [marketState, setMarketState] = useState<MarketState | null>(null);
  const visible = useDocumentVisible();
  const active = enabled && assetId !== undefined;
  const rateMs = LIVE_RATE_MS[rate];

  // The densify grid for the CURRENT window+rate, recomputed each render but read
  // through a ref: the generation-bumping effects commit it into `chartStep`
  // state so the grid changes atomically WITH a rebuild, never mid-stream. Window
  // and rate change on render, but the re-backfill + generation bump is async —
  // resampling the still-old series onto a new grid before the rebuild lands
  // would desync PriceChart's tail-append (a spurious per-tick redraw). Kept in a
  // ref so those effects don't take window/rate as deps (that is the watch
  // effect's job, which bumps generation exactly once per switch).
  const stepRef = useRef(liveChartStepSeconds(LIVE_WINDOW_MS[window], rateMs));
  stepRef.current = liveChartStepSeconds(LIVE_WINDOW_MS[window], rateMs);
  const [chartStep, setChartStep] = useState(() =>
    liveChartStepSeconds(LIVE_WINDOW_MS[window], rateMs),
  );

  // Which source last populated the series, so a stream↔fallback switch is one
  // clean rebuild (generation bump) rather than a silent value swap.
  const modeRef = useRef<'idle' | 'stream' | 'fallback'>('idle');

  // Clean slate whenever the subject changes or live mode turns off. A window/
  // rate change deliberately does NOT reset here — the old series stays visible
  // until the fresh backfill replaces it in one rebuild (no empty flash).
  useEffect(() => {
    setPoints([]);
    setStreaming(false);
    setCoverageFrom(null);
    setMarketState(null);
    modeRef.current = 'idle';
  }, [assetId, active]);

  // Streamed appends. Registered before the watch below so a frame emitted
  // while the watch ack is in flight is not lost. Each frame merges into the
  // current series (append-only) — no generation bump.
  useEffect(() => {
    if (!active) return;
    return on(REALTIME_SERVER_EVENTS.liveFrame, (payload) => {
      const parsed = realtimeLiveFrameSchema.safeParse(payload);
      if (!parsed.success || parsed.data.assetId !== assetId) return;
      const frame = parsed.data;
      if (frame.marketState != null) setMarketState(frame.marketState);
      // A closed-market frame is the last close re-stamped at `now`, not a new
      // observation: it drives the "Market closed" chip (above) but must never
      // append as a fake flat tick filling the pinned viewport — the seeded past
      // window would be crushed to an all-flat line (issue #690 Part A). Real
      // sessions (open/pre/post move prices) merge as normal; the server keeps
      // closed frames out of the ring too, so backfill stays honest.
      if (frame.marketState === 'closed') return;
      setPoints((prev) => mergePoints(prev, framesToPoints([frame], rateMs)));
    });
  }, [active, assetId, on, rateMs]);

  // Watch lifecycle: (re-)established per connection, window, rate and
  // visibility. Each successful ack is ONE generation — the authoritative
  // backfill replaces the series, keeping only live ticks newer than it.
  useEffect(() => {
    if (!enabled || assetId === undefined || !connected || !visible) {
      setStreaming(false);
      return;
    }
    let cancelled = false;
    setStreamRejected(false); // a watch is in flight — hold the fallback below
    void watchLive(assetId, window, rate).then((result) => {
      if (cancelled) return;
      if (result === null) {
        // Socket path unavailable — release the poll fallback below.
        setStreaming(false);
        setStreamRejected(true);
        return;
      }
      setStreaming(true);
      modeRef.current = 'stream';
      setGeneration((g) => g + 1);
      setChartStep(stepRef.current); // commit the grid with this rebuild
      const base = framesToPoints(result.frames, rateMs);
      const cutoff = base.length ? base[base.length - 1]!.time : Number.NEGATIVE_INFINITY;
      // Discard the previous generation; keep only live ticks strictly newer
      // than the backfill (the ones that streamed in during the ack).
      setPoints((prev) =>
        mergePoints(
          base,
          prev.filter((p) => p.time > cutoff),
        ),
      );
      setCoverageFrom(result.coverageFrom ? Date.parse(result.coverageFrom) : null);
      const seedState = [...result.frames]
        .reverse()
        .find((f) => f.marketState != null)?.marketState;
      if (seedState != null) setMarketState((prev) => prev ?? seedState);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, assetId, window, rate, rateMs, connected, visible, watchLive]);

  // Poll fallback (§4.5): while enabled but not streaming, the caller's 60 s
  // cache-served quote feeds the series as a slow tick — its own generation so
  // entering/leaving fallback is one clean rebuild.
  useEffect(() => {
    if (!active || streaming) return;
    // Hold the seed while a socket watch is still in flight, so entering live
    // mode with a working socket paints the backfill directly instead of a
    // throwaway one-point generation ahead of it. Once the watch is known
    // unavailable (rejected/timed out, or no socket at all) the fallback seeds.
    if (connected && visible && !streamRejected) return;
    const quote = fallbackQuote?.quote;
    const at = fallbackQuote?.asOf;
    if (!quote || !at || assetId === undefined) return;
    const frame: RealtimeLiveFrame = {
      assetId,
      price: quote.price,
      currency: quote.currency,
      dayChangePct: quote.dayChangePct ?? null,
      marketState: quote.marketState ?? null,
      at,
    };
    if (quote.marketState != null) setMarketState(quote.marketState);
    // Same rule on the fallback path: a closed-market quote is a stale repeat,
    // so it flips the badge but never seeds/appends a flat tick (issue #690
    // Part A). Fallback has no server backfill, so a closed market simply shows
    // the empty "waiting" state + the chip — honest, never a fabricated line.
    if (quote.marketState === 'closed') return;
    const incoming = framesToPoints([frame], rateMs);
    if (modeRef.current !== 'fallback') {
      modeRef.current = 'fallback';
      setGeneration((g) => g + 1);
      setChartStep(stepRef.current); // commit the grid with this rebuild
      setPoints(incoming);
    } else {
      setPoints((prev) => mergePoints(prev, incoming));
    }
  }, [active, streaming, connected, visible, streamRejected, assetId, fallbackQuote, rateMs]);

  // Release the watch on unmount / disable / hide / asset change — NOT on a
  // window or rate switch (the shared loop must keep running through those).
  useEffect(() => {
    if (!enabled || assetId === undefined || !visible) return;
    const watched = assetId;
    return () => unwatchLive(watched);
  }, [enabled, assetId, visible, unwatchLive]);

  // Uniform-density resampling the chart draws. Recomputes only when the source
  // points grow (a tail append) or the committed grid changes (a rebuild) — both
  // in lock-step with `generation`, so it never re-grids the old series mid-flight.
  const chartPoints = useMemo(() => densify(points, chartStep), [points, chartStep]);

  return { points, chartPoints, generation, streaming, coverageFrom, marketState };
}
