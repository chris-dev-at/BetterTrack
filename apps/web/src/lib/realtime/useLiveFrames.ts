import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  LIVE_RATE_MS,
  REALTIME_SERVER_EVENTS,
  realtimeLiveFrameSchema,
  type LiveRate,
  type LiveWindow,
  type RealtimeLiveFrame,
} from '@bettertrack/contracts';

import { useRealtime } from './RealtimeProvider';

export interface LiveFramesState {
  /** Backfill + streamed frames for the asset, oldest first. */
  frames: RealtimeLiveFrame[];
  /** True while a live watch is established — frames are flowing (or imminent). */
  streaming: boolean;
}

/**
 * The rate-sized time bucket a frame falls in. The shared upstream loop polls
 * at the finest ACTIVE viewer's rate (#372), so a coarser viewer receives
 * finer frames than they asked for — they downsample by keeping the first
 * frame of each of THEIR OWN rate buckets. Deterministic (no jitter
 * tolerances) and it doubles as the replay dedupe: an identical timestamp is
 * an identical bucket.
 */
const rateBucket = (at: string, rateMs: number): number => Math.floor(Date.parse(at) / rateMs);

/** Downsample an oldest-first frame list to one frame per rate bucket. */
function downsample(frames: RealtimeLiveFrame[], rateMs: number): RealtimeLiveFrame[] {
  const kept: RealtimeLiveFrame[] = [];
  for (const frame of frames) {
    const last = kept[kept.length - 1];
    if (!last || rateBucket(frame.at, rateMs) > rateBucket(last.at, rateMs)) kept.push(frame);
  }
  return kept;
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
 * Live Mode client lifecycle (§6.3, V3-P7b; overhauled per #372): while
 * `enabled` and the tab is visible, hold one watch on the asset at the user's
 * requested rate, backfill the requested window (history-stitched server-side
 * when the ring falls short) and append streamed `live.frame` pushes,
 * downsampled to the requested rate. Everything degrades silently: no
 * provider, no socket, or a rejected watch just means `streaming: false` —
 * the caller keeps its 60 s quote-poll fallback and the user never sees an
 * error (§4.5).
 *
 * A `window` or `rate` change re-issues the watch, which the server treats as
 * re-backfill + rate re-registration — the shared upstream loop never
 * restarts, it just re-derives its finest-active cadence. A reconnect
 * re-issues it too (`connected` flips), because a new socket holds no
 * watches. Hiding the tab releases the watch (presence gating); showing it
 * re-establishes watch + backfill. Only unmount/disable/hide/asset-change
 * release the watch.
 */
export function useLiveFrames(
  assetId: string | undefined,
  window: LiveWindow,
  rate: LiveRate,
  enabled: boolean,
): LiveFramesState {
  const { connected, on, watchLive, unwatchLive } = useRealtime();
  const [frames, setFrames] = useState<RealtimeLiveFrame[]>([]);
  const [streaming, setStreaming] = useState(false);
  const visible = useDocumentVisible();
  const active = enabled && assetId !== undefined;
  const rateMs = LIVE_RATE_MS[rate];

  // Clean slate whenever the target changes or live mode turns off. A hidden
  // tab deliberately KEEPS its frames — the chart freezes and the re-watch on
  // return replaces them with the authoritative backfill.
  useEffect(() => {
    if (!active) {
      setFrames([]);
      setStreaming(false);
    }
  }, [active, assetId]);

  // Streamed appends. Registered before the watch below so a frame emitted
  // while the watch ack is in flight is not lost.
  useEffect(() => {
    if (!active) return;
    return on(REALTIME_SERVER_EVENTS.liveFrame, (payload) => {
      const parsed = realtimeLiveFrameSchema.safeParse(payload);
      if (!parsed.success || parsed.data.assetId !== assetId) return;
      const frame = parsed.data;
      setFrames((prev) => {
        const last = prev[prev.length - 1];
        // Frames are producer-ordered. Keeping only the first frame of each
        // rate bucket downsamples a finer shared loop to OUR rate (#372) and
        // drops replays (room emit + backfill overlap) in the same stroke.
        if (last && rateBucket(frame.at, rateMs) <= rateBucket(last.at, rateMs)) return prev;
        return [...prev, frame];
      });
    });
  }, [active, assetId, on, rateMs]);

  // Watch lifecycle: (re-)established per connection, window, rate and
  // visibility. Hidden tabs never watch — presence-gated polling (#372).
  useEffect(() => {
    if (!enabled || assetId === undefined || !connected || !visible) {
      setStreaming(false);
      return;
    }
    let cancelled = false;
    void watchLive(assetId, window, rate).then((backfill) => {
      if (cancelled) return;
      if (backfill === null) {
        setStreaming(false);
        return;
      }
      setStreaming(true);
      // Replace with the authoritative backfill (downsampled to our rate),
      // keeping frames that streamed in while the ack was in flight (they are
      // strictly newer).
      setFrames((prev) => {
        const merged = downsample(backfill, rateMs);
        for (const frame of prev) {
          const last = merged[merged.length - 1];
          if (!last || rateBucket(frame.at, rateMs) > rateBucket(last.at, rateMs)) {
            merged.push(frame);
          }
        }
        return merged;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, assetId, window, rate, rateMs, connected, visible, watchLive]);

  // Release the watch on unmount / disable / hide / asset change — NOT on a
  // window or rate switch (the shared loop must keep running through those).
  useEffect(() => {
    if (!enabled || assetId === undefined || !visible) return;
    const watched = assetId;
    return () => unwatchLive(watched);
  }, [enabled, assetId, visible, unwatchLive]);

  return { frames, streaming };
}
