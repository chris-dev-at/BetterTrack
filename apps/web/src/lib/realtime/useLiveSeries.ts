import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  LIVE_RATE_MS,
  REALTIME_SERVER_EVENTS,
  realtimeLiveFrameSchema,
  type LiveRate,
  type LiveWindow,
  type MarketState,
  type QuoteResponse,
  type RealtimeLiveFrame,
} from '@bettertrack/contracts';

import { framesToPoints, mergePoints, type LivePoint } from './liveSeries';
import { useRealtime } from './RealtimeProvider';

export interface LiveSeriesState {
  /**
   * ONE merged, strictly-increasing, deduped series for the current
   * (asset, window, rate): seed history bars ⊕ ring backfill ⊕ live ticks,
   * normalized to `{ time: epochSeconds, value }`. Append-only within a
   * generation — the chart streams these via `series.update()`.
   */
  points: LivePoint[];
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
  const [coverageFrom, setCoverageFrom] = useState<number | null>(null);
  const [marketState, setMarketState] = useState<MarketState | null>(null);
  const visible = useDocumentVisible();
  const active = enabled && assetId !== undefined;
  const rateMs = LIVE_RATE_MS[rate];

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
    void watchLive(assetId, window, rate).then((result) => {
      if (cancelled) return;
      if (result === null) {
        // Socket path unavailable — the poll fallback below takes over.
        setStreaming(false);
        return;
      }
      setStreaming(true);
      modeRef.current = 'stream';
      setGeneration((g) => g + 1);
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
    const incoming = framesToPoints([frame], rateMs);
    if (modeRef.current !== 'fallback') {
      modeRef.current = 'fallback';
      setGeneration((g) => g + 1);
      setPoints(incoming);
    } else {
      setPoints((prev) => mergePoints(prev, incoming));
    }
  }, [active, streaming, assetId, fallbackQuote, rateMs]);

  // Release the watch on unmount / disable / hide / asset change — NOT on a
  // window or rate switch (the shared loop must keep running through those).
  useEffect(() => {
    if (!enabled || assetId === undefined || !visible) return;
    const watched = assetId;
    return () => unwatchLive(watched);
  }, [enabled, assetId, visible, unwatchLive]);

  return { points, generation, streaming, coverageFrom, marketState };
}
